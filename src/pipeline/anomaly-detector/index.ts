/**
 * Anomaly Detector module barrel export.
 *
 * Provides anomaly detection for agent-generated edits using a quorum of
 * independent scorers (FileAccess, ChangeSize, DangerPattern).
 */
export type {
  AnomalyScorer,
  AnomalyScore,
  AnomalyDetectorConfig,
  AnomalyDetectorResult,
  AgentEdit,
  TaskContext,
  FileChange,
} from './types';

export { FileAccessScorer } from './file-access-scorer';
export { ChangeSizeScorer } from './change-size-scorer';
export { DangerPatternScorer } from './danger-pattern-scorer';
export { AnomalyDetector, evaluateQuorum, createDefaultDetector } from './detector';
