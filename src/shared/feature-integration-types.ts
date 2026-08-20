/**
 * Shared TypeScript interfaces and types for the Feature Integration modules.
 *
 * These types define the core data structures used across Artifacts, Automation Pipelines,
 * Vision Analyzer, WebContainer Sandbox, Plugin Registry, Benchmark Framework, and
 * Supporting Infrastructure modules.
 */

// ─── Artifact System ────────────────────────────────────────────

export type ArtifactType = 'code-bundle' | 'document' | 'spreadsheet-data' | 'diagram' | 'generated-app';

export interface Artifact {
  id: string;
  sessionId: string;
  title: string;
  type: ArtifactType;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface ArtifactCheckpoint {
  id: string;
  artifactId: string;
  version: number;
  content: Buffer | string;
  createdAt: string;
  diff?: string;
}

export interface CreateArtifactParams {
  sessionId: string;
  projectDir: string;
  title: string;
  type: ArtifactType;
  content: Buffer | string;
  metadata?: Record<string, unknown>;
}

// ─── Automation Pipelines ───────────────────────────────────────

export interface PipelineDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  steps: PipelineStep[];
  triggers: PipelineTrigger[];
  parameters: PipelineParameter[];
  createdAt: string;
  updatedAt: string;
}

export interface PipelineStep {
  id: string;
  name: string;
  toolId?: string;
  agentId?: string;
  inputMapping: Record<string, StepInputSource>;
  outputType: string;
  timeout?: number;
  retryPolicy?: RetryPolicy;
}

export type StepInputSource =
  | { kind: 'parameter'; paramName: string }
  | { kind: 'previousStep'; stepId: string; path: string }
  | { kind: 'literal'; value: unknown };

export interface PipelineTrigger {
  type: 'manual' | 'on-file-change' | 'on-git-commit' | 'on-schedule';
  config: FileChangeTriggerConfig | ScheduleTriggerConfig | Record<string, never>;
}

export interface FileChangeTriggerConfig {
  globPatterns: string[];
}

export interface ScheduleTriggerConfig {
  cron: string;
}

export interface PipelineParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

export interface PipelineExecution {
  id: string;
  pipelineId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  steps: StepExecution[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface StepExecution {
  stepId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ─── Vision Analyzer ────────────────────────────────────────────

export interface DetectedComponent {
  type: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  confidence: number;
  label?: string;
}

export interface VisualAnalysisResult {
  components: DetectedComponent[];
  imageSize: { width: number; height: number };
  processingTimeMs: number;
}

export interface VisualDiffResult {
  similarityPercent: number;
  diffRegions: { x: number; y: number; width: number; height: number; area: number }[];
  isVisuallyDifferent: boolean;
  diffImageBuffer?: Buffer;
}

export interface DiagramRecognitionResult {
  nodes: { id: string; label: string; bounds: BoundingBox }[];
  edges: { from: string; to: string; label?: string }[];
  confidence: number;
  mermaidSource?: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── WebContainer Sandbox ───────────────────────────────────────

export interface WebContainerInstance {
  id: string;
  status: 'booting' | 'ready' | 'running' | 'stopped' | 'error';
  previewUrl?: string;
  memoryUsageMB: number;
  files: string[];
}

export interface NetworkPolicy {
  allowLocalhost: boolean;
  allowedExternalHosts: string[];
}

// ─── Plugin Registry ────────────────────────────────────────────

export interface PluginManifestV2 {
  name: string;
  version: string;
  description: string;
  author: string;
  pluginType: 'tool-plugin' | 'agent-plugin' | 'panel-plugin';
  entryPoint: string;
  permissions: PluginPermission[];
  minNeuroNestVersion: string;
  dependencies?: Record<string, string>;
  processingNodes?: ProcessingNodeDeclaration[];
}

export type PluginPermission =
  | 'file-read'
  | 'file-write'
  | 'network-access'
  | 'tool-invoke'
  | 'shell-execute'
  | 'database-access';

export interface ProcessingNodeDeclaration {
  id: string;
  name: string;
  inputSchema: object;
  outputSchema: object;
}

// ─── Benchmark Framework ────────────────────────────────────────

export interface BenchmarkProfile {
  id: string;
  name: string;
  prompt: string;
  configurations: ModelConfiguration[];
  evaluationCriteria: EvaluationCriterion[];
}

export interface ModelConfiguration {
  id: string;
  label: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
}

export interface EvaluationCriterion {
  name: string;
  weight: number;
  description?: string;
}

export interface BenchmarkRun {
  id: string;
  profileId: string;
  results: BenchmarkResult[];
  startedAt: string;
  completedAt?: string;
}

export interface BenchmarkResult {
  configurationId: string;
  tokensConsumed: number;
  durationMs: number;
  toolCallIterations: number;
  qualityScore?: number;
  output: string;
}

// ─── Supporting Infrastructure ──────────────────────────────────

export interface TraceEntry {
  id: string;
  traceId: string;
  sequence: number;
  timestamp: string;
  type: 'tool-call' | 'llm-request' | 'decision' | 'result' | 'error';
  toolName?: string;
  parameters?: Record<string, unknown>;
  tokenCount?: number;
  durationMs?: number;
  result?: unknown;
  error?: string;
  /** Correlation ID linking all entries across execution graph (null when drift inactive) */
  correlationId?: string | null;
  /** Parent entry that caused this action (null for root) */
  parentEntryId?: string | null;
  /** Task purpose from IntentAnchor (null when drift inactive) */
  intentPurpose?: string | null;
  /** Confidence at the time this entry was recorded (null when drift inactive) */
  confidenceAtDecision?: number | null;
}

export interface ExecutionTrace {
  id: string;
  sessionId: string;
  messageId: string;
  entries: TraceEntry[];
  startedAt: string;
  completedAt?: string;
  totalDurationMs: number;
  totalTokens: number;
}

export interface TaskClassification {
  type: 'code-generation' | 'refactoring' | 'analysis' | 'creative' | 'debugging';
  confidence: number;
}

export interface ParameterProfile {
  temperature: number;
  maxTokens: number;
  topP: number;
  recommendedModel?: string;
}

export interface WorkspaceLayer {
  name: string;
  patterns: string[];
}

export interface OptionalDependency {
  id: string;
  name: string;
  status: 'available' | 'unavailable' | 'outdated';
  requiredVersion: string;
  currentVersion?: string;
  downloadUrl?: string;
  features: string[];
}

// ─── Validation ─────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

// ─── Quick Actions ──────────────────────────────────────────────

export interface QuickAction {
  id: string;
  label: string;
  icon?: string;
  pipelineId: string;
  prefilledParams: Record<string, unknown>;
  position: number;
}

// ─── Drift Management ───────────────────────────────────────────

export type { DriftSignal, DriftCategory, DriftSeverity } from '../drift/drift-signal.js';

import type { DriftSignal } from '../drift/drift-signal.js';

export interface DriftDashboardState {
  active: boolean;
  confidence: number;
  /** Resolved thresholds for the current monitor configuration. */
  thresholds?: {
    warning: number;
    critical: number;
  };
  signals: DriftSignal[];
  scope: {
    toolsUsed: number;
    toolsAllowed: number;
    pathsModified: number;
    pathsAllowed: number;
  };
  staleCountdownMs: number;
  anchor: {
    purpose: string;
    statement: string;
    createdAt: string;
  } | null;
}
