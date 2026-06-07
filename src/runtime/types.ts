/** Supported project stack types */
export type StackType = 'nodejs' | 'go' | 'rust' | 'python' | 'static-html';

/** Service lifecycle status */
export type ServiceStatus = 'starting' | 'running' | 'failed' | 'stopped';

/** Docker availability check result */
export interface DockerStatus {
  available: boolean;
  error?: string;
}

/** Definition of a single service within a project */
export interface ServiceDefinition {
  name: string;
  stackType: StackType;
  rootPath: string;
  entryFile?: string;
}

/** Result of stack detection */
export interface DetectionResult {
  services: ServiceDefinition[];
  isMultiService: boolean;
}

/** Runtime state of a single container/service */
export interface ContainerState {
  serviceId: string;
  serviceName: string;
  containerId: string | null;
  imageTag: string | null;
  status: ServiceStatus;
  hostPort: number | null;
  containerPort: number;
  exitCode?: number;
  error?: string;
  startedAt?: number;
}

/** A complete runtime session for one project */
export interface RuntimeSession {
  projectId: string;
  projectPath: string;
  services: Map<string, ContainerState>;
  detectionResult: DetectionResult;
  createdAt: number;
}

/** Configuration for generating a Dockerfile */
export interface DockerfileConfig {
  baseImage: string;
  buildCommands: string[];
  runCommand: string;
  exposedPort: number;
  workdir: string;
}

/** Structured error returned over IPC */
export interface RuntimeError {
  code: 'DOCKER_NOT_INSTALLED' | 'DOCKER_NOT_RUNNING' | 'UNSUPPORTED_PROJECT'
      | 'BUILD_FAILED' | 'CONTAINER_FAILED' | 'PORT_UNAVAILABLE' | 'UNKNOWN';
  message: string;
  details?: string;
}

/** Default container ports per stack type */
export const DEFAULT_CONTAINER_PORTS: Record<StackType, number> = {
  'nodejs': 3000,
  'go': 8080,
  'rust': 8080,
  'python': 8000,
  'static-html': 80,
};
