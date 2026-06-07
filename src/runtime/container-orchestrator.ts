import type { ChildProcess } from 'child_process';
import type { ServiceDefinition, StackType } from './types.js';
import { DockerCli } from './docker-cli.js';
import { DEFAULT_CONTAINER_PORTS } from './types.js';

/**
 * Dockerfile template configuration per stack type.
 */
interface StackTemplate {
  baseImage: string;
  buildCommands: string[];
  runCommand: string;
  workdir: string;
}

const STACK_TEMPLATES: Record<StackType, StackTemplate> = {
  'nodejs': {
    baseImage: 'node:20-alpine',
    buildCommands: ['COPY package*.json ./', 'RUN npm install', 'COPY . .'],
    runCommand: 'CMD ["npm", "start"]',
    workdir: '/app',
  },
  'go': {
    baseImage: 'golang:1.22-alpine',
    buildCommands: ['COPY go.* ./', 'RUN go mod download', 'COPY . .', 'RUN go build -o app .'],
    runCommand: 'CMD ["./app"]',
    workdir: '/app',
  },
  'rust': {
    baseImage: 'rust:1.77-alpine',
    buildCommands: ['COPY Cargo.* ./', 'COPY . .', 'RUN cargo build --release'],
    runCommand: '', // set dynamically based on service name
    workdir: '/app',
  },
  'python': {
    baseImage: 'python:3.12-alpine',
    buildCommands: ['COPY requirements.txt ./', 'RUN pip install -r requirements.txt', 'COPY . .'],
    runCommand: 'CMD ["python", "main.py"]',
    workdir: '/app',
  },
  'static-html': {
    baseImage: 'nginx:alpine',
    buildCommands: ['COPY . /usr/share/nginx/html'],
    runCommand: '', // nginx default CMD is fine
    workdir: '/usr/share/nginx/html',
  },
};

/**
 * Generates Dockerfiles, builds images, and manages container lifecycle.
 * All Docker interactions go through the injected DockerCli instance.
 */
export class ContainerOrchestrator {
  private readonly docker: DockerCli;

  constructor(docker: DockerCli) {
    this.docker = docker;
  }

  /**
   * Sanitize a name to lowercase alphanumeric + hyphens.
   * Replaces non-alphanumeric characters with hyphens and collapses
   * consecutive hyphens. Trims leading/trailing hyphens.
   */
  static sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Build a container name following the convention:
   * neuronest-{sanitizedProject}-{sanitizedService}
   */
  static buildContainerName(projectName: string, serviceName: string): string {
    const sanitizedProject = ContainerOrchestrator.sanitizeName(projectName);
    const sanitizedService = ContainerOrchestrator.sanitizeName(serviceName);
    return `neuronest-${sanitizedProject}-${sanitizedService}`;
  }

  /**
   * Generate a Dockerfile string for the given service definition.
   */
  generateDockerfile(service: ServiceDefinition): string {
    const template = STACK_TEMPLATES[service.stackType];
    const lines: string[] = [];

    lines.push(`FROM ${template.baseImage}`);

    if (service.stackType !== 'static-html') {
      lines.push(`WORKDIR ${template.workdir}`);
    }

    for (const cmd of template.buildCommands) {
      lines.push(cmd);
    }

    const containerPort = DEFAULT_CONTAINER_PORTS[service.stackType];
    lines.push(`EXPOSE ${containerPort}`);

    if (service.stackType === 'rust') {
      const binaryName = ContainerOrchestrator.sanitizeName(service.name) || 'app';
      lines.push(`CMD ["./target/release/${binaryName}"]`);
    } else if (template.runCommand) {
      lines.push(template.runCommand);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Build a Docker image for a service. Streams build output via onLog callback.
   * Pipes the Dockerfile via stdin (-f -) to avoid writing temporary files.
   * Returns the image tag on success.
   */
  async buildImage(
    service: ServiceDefinition,
    dockerfile: string,
    onLog: (line: string) => void,
  ): Promise<string> {
    const imageTag = ContainerOrchestrator.buildContainerName(
      service.name,
      service.stackType,
    );

    return new Promise<string>((resolve, reject) => {
      const child: ChildProcess = this.docker.spawn(
        ['build', '-t', imageTag, '-f', '-', service.rootPath],
        onLog,
      );

      // Pipe the Dockerfile content via stdin
      if (child.stdin) {
        child.stdin.write(dockerfile);
        child.stdin.end();
      }

      child.on('close', (code) => {
        if (code === 0) {
          resolve(imageTag);
        } else {
          reject(new Error(`Docker build failed with exit code ${code ?? 'unknown'}`));
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Docker build error: ${err.message}`));
      });
    });
  }

  /**
   * Build the docker run arguments array. Exposed for property testing
   * so tests can inspect args without actually running docker.
   */
  buildRunArgs(
    imageTag: string,
    service: ServiceDefinition,
    hostPort: number,
    containerPort: number,
    projectPath: string,
  ): string[] {
    const containerName = ContainerOrchestrator.buildContainerName(
      service.name,
      service.name,
    );

    return [
      'run', '-d',
      '--name', containerName,
      '--read-only',
      '--no-new-privileges',
      '--network=bridge',
      '--tmpfs', '/tmp',
      '-v', `${projectPath}:/app:ro`,
      '-p', `${hostPort}:${containerPort}`,
      imageTag,
    ];
  }

  /**
   * Start a container from a built image.
   * Returns the container ID.
   */
  async startContainer(
    imageTag: string,
    service: ServiceDefinition,
    hostPort: number,
    containerPort: number,
    projectPath: string,
  ): Promise<string> {
    const args = this.buildRunArgs(imageTag, service, hostPort, containerPort, projectPath);
    const containerId = await this.docker.exec(args);
    return containerId;
  }

  /**
   * Stop and remove a running container.
   */
  async stopContainer(containerId: string): Promise<void> {
    await this.docker.exec(['stop', containerId]);
    await this.docker.exec(['rm', containerId]);
  }

  /**
   * Attach to container stdout/stderr and stream logs via callback.
   */
  streamLogs(containerId: string, onLog: (line: string) => void): void {
    this.docker.spawn(['logs', '-f', containerId], onLog);
  }

  /**
   * Stop and remove all containers matching the neuronest- prefix.
   * Called on app quit as a fallback cleanup.
   */
  async stopAll(): Promise<void> {
    try {
      const output = await this.docker.exec([
        'ps', '-a',
        '--filter', 'name=neuronest-',
        '--format', '{{.Names}}',
      ]);

      if (!output.trim()) {
        return;
      }

      const containerNames = output.trim().split('\n').filter(Boolean);

      for (const name of containerNames) {
        try {
          await this.docker.exec(['stop', name]);
        } catch {
          // Container may already be stopped — ignore
        }
        try {
          await this.docker.exec(['rm', name]);
        } catch {
          // Container may already be removed — ignore
        }
      }
    } catch {
      // If docker ps fails (e.g., daemon not running), nothing to clean up
    }
  }
}
