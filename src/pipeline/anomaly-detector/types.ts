/**
 * Types for the Anomaly Detector module.
 * Defines scorer interfaces, config, and shared data types.
 */

/** Represents a single file change within an agent edit. */
export interface FileChange {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  content: string;
}

/** Represents an agent-generated code edit to be evaluated. */
export interface AgentEdit {
  id: string;
  files: FileChange[];
  totalLinesChanged: number;
  timestamp: number;
}

/** Context about the current task, used by scorers to assess relevance. */
export interface TaskContext {
  taskId: string;
  description: string;
  expectedFiles: string[];      // files the task is expected to touch
  expectedScope: string[];      // directories within the task scope
  estimatedSize: 'small' | 'medium' | 'large';
}

/** Result from a single scorer evaluation. */
export interface AnomalyScore {
  flagged: boolean;
  confidence: number;    // 0.0 - 1.0
  concerns: string[];
}

/** Interface that all anomaly scorers must implement. */
export interface AnomalyScorer {
  name: string;
  score(edit: AgentEdit, context: TaskContext): Promise<AnomalyScore>;
}

/** Configuration for the anomaly detector. */
export interface AnomalyDetectorConfig {
  scorers: AnomalyScorer[];
  quorum: number;         // minimum agreeing scorers to flag (default: 2)
  maxLatencyMs: number;   // budget per scorer (default: 50ms)
}

/** Result from the anomaly detector after evaluating all scorers. */
export interface AnomalyDetectorResult {
  flagged: boolean;
  flaggedCount: number;
  totalScorers: number;
  scores: Array<{ scorerName: string; score: AnomalyScore; timedOut: boolean }>;
  concerns: string[];     // aggregated concerns from agreeing scorers
}
