import type {
  DockerStatus,
  RuntimeSession,
  ContainerState,
  ServiceStatus,
  RuntimeError,
} from './types.js';
import { DEFAULT_CONTAINER_PORTS } from './types.js';
import { StackDetector, UnsupportedProjectError } from './stack-detector.js';
import { NativeProcessRunner } from './native-process-runner.js';
import { PortManager } from './port-manager.js';

/**
 * Top-level orchestrator that ties detection, building, and running together.
 * Uses native child processes — no Docker required.
 */
export class RuntimeManager {
  private readonly stackDetector: StackDetector;
  private readonly processRunner: NativeProcessRunner;
  private readonly portManager: PortManager;
  private readonly sessions: Map<string, RuntimeSession> = new Map();

  constructor() {
    this.stackDetector = new StackDetector();
    this.processRunner = new NativeProcessRunner();
    this.portManager = new PortManager();
  }

  /**
   * Detect the tech stack of a project without starting a runtime.
   */
  async detectStack(projectPath: string): Promise<import('./types.js').DetectionResult> {
    return this.stackDetector.detect(projectPath);
  }

  /**
   * Check runtime readiness. Always available since we use native processes.
   */
  async checkDocker(): Promise<DockerStatus> {
    return { available: true };
  }

  /**
   * Start a runtime for a project. Detects stack, installs deps,
   * spawns native processes, and streams logs.
   */
  async startRuntime(
    projectId: string,
    projectPath: string,
    onLog: (serviceId: string, line: string) => void,
    onStatusChange: (serviceId: string, status: ServiceStatus) => void,
  ): Promise<RuntimeSession> {
    // Detect project stack
    let detectionResult;
    try {
      detectionResult = await this.stackDetector.detect(projectPath);
    } catch (err) {
      if (err instanceof UnsupportedProjectError) {
        throw this.createRuntimeError('UNSUPPORTED_PROJECT', err.message);
      }
      throw this.createRuntimeError('UNKNOWN', (err as Error).message);
    }

    // Create session and register it immediately so status queries work during startup
    const session: RuntimeSession = {
      projectId,
      projectPath,
      services: new Map(),
      detectionResult,
      createdAt: Date.now(),
    };
    this.sessions.set(projectId, session);

    // For each detected service: allocate port → install deps → start process
    for (const service of detectionResult.services) {
      const serviceId = service.name;
      const containerPort = DEFAULT_CONTAINER_PORTS[service.stackType];

      const state: ContainerState = {
        serviceId,
        serviceName: service.name,
        containerId: null,
        imageTag: null,
        status: 'starting',
        hostPort: null,
        containerPort,
      };
      session.services.set(serviceId, state);
      onStatusChange(serviceId, 'starting');

      try {
        // Allocate host port
        const hostPort = await this.portManager.allocate();
        state.hostPort = hostPort;

        // Prepare isolated runtime environment (copy files)
        onLog(serviceId, '[env] Preparing isolated runtime environment...');
        const runtimeDir = await this.processRunner.prepareEnvironment(
          serviceId,
          service,
          (line: string) => onLog(serviceId, line),
        );

        // Install dependencies in the isolated environment
        onLog(serviceId, '[install] Installing dependencies...');
        await this.processRunner.installDeps(
          service,
          runtimeDir,
          (line: string) => onLog(serviceId, line),
        );

        // Start the service process in the isolated environment
        await this.processRunner.startService(
          serviceId,
          service,
          runtimeDir,
          hostPort,
          (line: string) => onLog(serviceId, line),
          (exitCode: number | null) => {
            // Handle unexpected exit
            if (state.status === 'running' || state.status === 'starting') {
              state.status = 'failed';
              state.exitCode = exitCode ?? 1;
              state.error = `Process exited with code ${exitCode}`;
              onStatusChange(serviceId, 'failed');
              onLog(serviceId, `[exit] Process exited with code ${exitCode}`);
            }
          },
        );

        state.status = 'running';
        state.startedAt = Date.now();
        onStatusChange(serviceId, 'running');
      } catch (err) {
        state.status = 'failed';
        state.error = (err as Error).message;
        onStatusChange(serviceId, 'failed');
        onLog(serviceId, `Error: ${(err as Error).message}`);
      }
    }

    // Auto-detect and start a frontend static server if no frontend service was detected
    // but the project has static HTML files (public/index.html, index.html, etc.)
    const hasFrontendService = [...session.services.keys()].some(
      id => id === 'frontend' || id === 'client' || id === 'web' || id === 'ui' || id === 'static-html'
    );
    if (!hasFrontendService) {
      const fs = await import('fs/promises');
      const path = await import('path');
      // Check common frontend file locations
      const frontendPaths = [
        path.join(projectPath, 'public', 'index.html'),
        path.join(projectPath, 'static', 'index.html'),
        path.join(projectPath, 'dist', 'index.html'),
        path.join(projectPath, 'index.html'),
        path.join(projectPath, 'src', 'index.html'),
      ];
      let frontendDir: string | null = null;
      for (const fp of frontendPaths) {
        try {
          await fs.access(fp);
          frontendDir = path.dirname(fp);
          break;
        } catch {}
      }
      if (frontendDir) {
        // Start a static file server for the frontend
        const frontendServiceId = 'frontend';
        const frontendPort = await this.portManager.allocate();
        const frontendState: ContainerState = {
          serviceId: frontendServiceId,
          serviceName: 'Frontend (auto-detected)',
          containerId: null,
          imageTag: null,
          status: 'starting',
          hostPort: frontendPort,
          containerPort: frontendPort,
        };
        session.services.set(frontendServiceId, frontendState);
        onStatusChange(frontendServiceId, 'starting');
        onLog(frontendServiceId, '[auto] Detected static frontend files, starting file server...');

        try {
          const frontendService = { name: 'frontend', stackType: 'static-html' as const, rootPath: frontendDir };
          const runtimeDir = await this.processRunner.prepareEnvironment(
            frontendServiceId,
            frontendService,
            (line: string) => onLog(frontendServiceId, line),
          );
          await this.processRunner.startService(
            frontendServiceId,
            frontendService,
            runtimeDir,
            frontendPort,
            (line: string) => onLog(frontendServiceId, line),
            (exitCode: number | null) => {
              if (frontendState.status === 'running' || frontendState.status === 'starting') {
                frontendState.status = 'failed';
                frontendState.exitCode = exitCode ?? 1;
                frontendState.error = `Frontend server exited with code ${exitCode}`;
                onStatusChange(frontendServiceId, 'failed');
              }
            },
          );
          frontendState.status = 'running';
          frontendState.startedAt = Date.now();
          onStatusChange(frontendServiceId, 'running');
          onLog(frontendServiceId, `[auto] Frontend serving on port ${frontendPort}`);
        } catch (err) {
          frontendState.status = 'failed';
          frontendState.error = (err as Error).message;
          onStatusChange(frontendServiceId, 'failed');
          onLog(frontendServiceId, `[auto] Failed to start frontend: ${(err as Error).message}`);
        }
      }
    }

    return session;
  }

  /**
   * Stop all services in a project's runtime session.
   */
  async stopRuntime(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) return;

    for (const [, state] of session.services) {
      this.processRunner.stopService(state.serviceId);
      if (state.hostPort !== null) {
        this.portManager.release(state.hostPort);
      }
      state.status = 'stopped';
      state.containerId = null;
    }

    this.sessions.delete(projectId);
  }

  /**
   * Restart a specific service or all services.
   */
  async restartRuntime(projectId: string, serviceId?: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (!session) return;

    if (serviceId) {
      const state = session.services.get(serviceId);
      if (!state) return;

      this.processRunner.stopService(serviceId);

      const serviceDef = session.detectionResult.services.find(
        (s) => s.name === serviceId,
      );
      if (!serviceDef) return;

      state.status = 'starting';
      try {
        const runtimeDir = this.processRunner.getRuntimeDir(serviceId) || serviceDef.rootPath;
        await this.processRunner.startService(
          serviceId,
          serviceDef,
          runtimeDir,
          state.hostPort!,
          () => {},
          (exitCode) => {
            if (state.status === 'running' || state.status === 'starting') {
              state.status = 'failed';
              state.exitCode = exitCode ?? 1;
            }
          },
        );
        state.status = 'running';
        state.startedAt = Date.now();
      } catch (err) {
        state.status = 'failed';
        state.error = (err as Error).message;
      }
    } else {
      for (const [sid] of session.services) {
        await this.restartRuntime(projectId, sid);
      }
    }
  }

  getStatus(projectId: string): RuntimeSession | undefined {
    return this.sessions.get(projectId);
  }

  async shutdownAll(): Promise<void> {
    const projectIds = Array.from(this.sessions.keys());
    for (const projectId of projectIds) {
      try { await this.stopRuntime(projectId); } catch {}
    }
    this.processRunner.stopAll();
  }

  handleContainerExit(projectId: string, serviceId: string, exitCode: number): void {
    const session = this.sessions.get(projectId);
    if (!session) return;
    const state = session.services.get(serviceId);
    if (!state) return;
    state.status = 'failed';
    state.exitCode = exitCode;
    state.error = `Container exited with code ${exitCode}. Check logs for details.`;
  }

  /**
   * Create a structured RuntimeError object.
   */
  private createRuntimeError(
    code: RuntimeError['code'],
    message: string,
    details?: string,
  ): RuntimeError & Error {
    const error = new Error(message) as RuntimeError & Error;
    error.code = code;
    error.message = message;
    if (details) error.details = details;
    return error;
  }
}
