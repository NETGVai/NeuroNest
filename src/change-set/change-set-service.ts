/**
 * ChangeSetService — the authority for creating, transitioning, and validating Change_Sets.
 *
 * Every agent-originated file mutation must belong to a Change_Set before acceptance.
 * Operations are immutable once the Change_Set leaves the 'streaming' state.
 * Base hashes are validated before the Change_Set can be accepted.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  ChangeSet,
  ChangeSetState,
  CreateChangeSetParams,
  FileOperation,
  FileOperationSummary,
  ChangeSetProvenance,
  RiskLevel,
  ValidationStatus,
} from './types';
import { TERMINAL_STATES, VALID_STATE_TRANSITIONS } from './types';

/**
 * Computes a SHA-256 fingerprint from the serialized operations.
 */
function computeFingerprint(operations: readonly FileOperation[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(operations));
  return hash.digest('hex');
}

/** Patterns indicating security-sensitive files. */
const SENSITIVE_PATTERNS = [
  /\.env/i,
  /secret/i,
  /credential/i,
  /auth/i,
  /\.pem$/i,
  /\.key$/i,
  /password/i,
];

/** Patterns indicating dependency manifests. */
const MANIFEST_PATTERNS = [
  /package\.json$/i,
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /Gemfile\.lock$/i,
  /Cargo\.lock$/i,
  /go\.sum$/i,
  /requirements\.txt$/i,
  /poetry\.lock$/i,
];

/** Patterns indicating binary files. */
const BINARY_PATTERNS = [
  /\.(png|jpg|jpeg|gif|webp|ico|bmp|tiff?)$/i,
  /\.(woff2?|ttf|otf|eot)$/i,
  /\.(pdf|doc|docx|xls|xlsx)$/i,
  /\.(zip|tar|gz|bz2|7z|rar)$/i,
  /\.(exe|dll|so|dylib|o|a)$/i,
  /\.(wasm|onnx|bin|dat)$/i,
];

/**
 * Determines risk flags for a file operation based on its URI.
 */
function computeRiskFlags(uri: string): string[] {
  const flags: string[] = [];
  if (SENSITIVE_PATTERNS.some((p) => p.test(uri))) flags.push('security-sensitive');
  if (MANIFEST_PATTERNS.some((p) => p.test(uri))) flags.push('dependency-manifest');
  if (BINARY_PATTERNS.some((p) => p.test(uri))) flags.push('binary-file');
  return flags;
}

/**
 * Checks if a URI looks like a binary file based on extension.
 */
function isBinaryUri(uri: string): boolean {
  return BINARY_PATTERNS.some((p) => p.test(uri));
}

/**
 * Counts lines in content (number of newlines + 1 for non-empty).
 */
function countLines(content: string): number {
  if (content === '') return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') count++;
  }
  return count;
}

/**
 * Derives file operation summaries from the operations list.
 */
function computeSummaries(operations: readonly FileOperation[]): FileOperationSummary[] {
  return operations.map((op) => {
    const targetUri = op.kind === 'rename' || op.kind === 'move' ? op.targetUri : op.targetUri;
    const binary = isBinaryUri(targetUri);
    const riskFlags = computeRiskFlags(targetUri);

    let additions = 0;
    let removals = 0;

    if (op.kind === 'create' && !binary) {
      additions = countLines(op.proposedBlob);
    } else if (op.kind === 'modify' && !binary) {
      additions = countLines(op.proposedBlob);
      // Without base content in summary context, we estimate removals as the delta
      // The canonical diff computer provides exact values — this is a summary.
      removals = 0; // Accurate removals require base content comparison
    } else if (op.kind === 'delete') {
      removals = 0; // Accurate removals require base content
    }

    return {
      targetUri,
      kind: op.kind,
      additions,
      removals,
      hunkCount: op.kind === 'modify' ? 1 : (op.kind === 'create' || op.kind === 'delete' ? 1 : 0),
      isBinary: binary,
      riskFlags: Object.freeze(riskFlags),
    };
  });
}

/**
 * Derives the aggregate risk level from operation summaries.
 */
function computeAggregateRisk(summaries: readonly FileOperationSummary[]): RiskLevel {
  let maxRisk: RiskLevel = 'low';
  for (const summary of summaries) {
    if (summary.riskFlags.includes('security-sensitive')) {
      return 'critical';
    }
    if (summary.riskFlags.includes('dependency-manifest')) {
      maxRisk = maxRisk === 'low' ? 'high' : maxRisk;
    }
    if (summary.riskFlags.includes('binary-file') && maxRisk === 'low') {
      maxRisk = 'medium';
    }
  }
  return maxRisk;
}

/**
 * Creates the default empty provenance record.
 */
function createDefaultProvenance(toolEventIds?: string[]): ChangeSetProvenance {
  return Object.freeze({
    toolEventIds: Object.freeze(toolEventIds ?? []),
    preApplyCheckpointId: null,
    postApplyCheckpointId: null,
    evidenceIds: Object.freeze([]),
    chatTurnIds: Object.freeze([]),
  });
}

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly changeSetId: string,
    public readonly currentState: ChangeSetState,
    public readonly targetState: ChangeSetState
  ) {
    super(
      `Invalid state transition for Change_Set ${changeSetId}: ` +
        `cannot transition from '${currentState}' to '${targetState}'`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Error thrown when operations are mutated after the Change_Set is frozen.
 */
export class ImmutableOperationError extends Error {
  constructor(
    public readonly changeSetId: string,
    public readonly currentState: ChangeSetState
  ) {
    super(
      `Cannot modify operations of Change_Set ${changeSetId}: ` +
        `operations are immutable in state '${currentState}'`
    );
    this.name = 'ImmutableOperationError';
  }
}

/**
 * Error thrown when base hash validation fails.
 */
export class BaseHashValidationError extends Error {
  constructor(
    public readonly changeSetId: string,
    public readonly targetUri: string,
    public readonly expectedHash: string,
    public readonly actualHash: string
  ) {
    super(
      `Base hash mismatch for Change_Set ${changeSetId} on file '${targetUri}': ` +
        `expected '${expectedHash}', got '${actualHash}'`
    );
    this.name = 'BaseHashValidationError';
  }
}

/**
 * Function type for resolving the current content hash of a file.
 */
export type HashResolver = (uri: string) => string | null;

/**
 * In-memory store for Change_Sets. In production this would be backed by SQLite.
 */
export class ChangeSetService {
  private readonly changeSets = new Map<string, ChangeSet>();

  /**
   * Creates a new Change_Set with a unique stable ID.
   * Starts in 'streaming' state if no operations are provided,
   * or 'ready' if operations are provided.
   */
  create(params: CreateChangeSetParams): ChangeSet {
    const id = randomUUID();
    const now = new Date().toISOString();
    const operations = Object.freeze(params.operations ?? []);
    const initialState: ChangeSetState = operations.length > 0 ? 'ready' : 'streaming';
    const summaries = Object.freeze(computeSummaries(operations));
    const risk = computeAggregateRisk(summaries);

    const changeSet: ChangeSet = Object.freeze({
      id,
      workspaceId: params.workspaceId,
      taskId: params.taskId,
      runId: params.runId,
      chatEventId: params.chatEventId,
      baseRevision: params.baseRevision,
      state: initialState,
      operations: Object.freeze([...operations]),
      fingerprint: computeFingerprint(operations),
      createdAt: now,
      updatedAt: now,
      summaries,
      risk: params.risk ?? risk,
      dependencyOrder: params.dependencyOrder ?? 0,
      validationStatus: 'pending' as ValidationStatus,
      provenance: createDefaultProvenance(params.toolEventIds),
    });

    this.changeSets.set(id, changeSet);
    return changeSet;
  }

  /**
   * Retrieves a Change_Set by ID.
   */
  get(id: string): ChangeSet | undefined {
    return this.changeSets.get(id);
  }

  /**
   * Returns all Change_Sets for a given workspace.
   */
  listByWorkspace(workspaceId: string): ChangeSet[] {
    return Array.from(this.changeSets.values()).filter(
      (cs) => cs.workspaceId === workspaceId
    );
  }

  /**
   * Returns all Change_Sets for a given run.
   */
  listByRun(runId: string): ChangeSet[] {
    return Array.from(this.changeSets.values()).filter(
      (cs) => cs.runId === runId
    );
  }

  /**
   * Adds an operation to a Change_Set that is in 'streaming' state.
   * Operations cannot be added once the Change_Set transitions past streaming.
   */
  addOperation(changeSetId: string, operation: FileOperation): ChangeSet {
    const current = this.changeSets.get(changeSetId);
    if (!current) {
      throw new Error(`Change_Set ${changeSetId} not found`);
    }
    if (current.state !== 'streaming') {
      throw new ImmutableOperationError(changeSetId, current.state);
    }

    const newOperations = Object.freeze([...current.operations, operation]);
    const now = new Date().toISOString();
    const summaries = Object.freeze(computeSummaries(newOperations));
    const risk = computeAggregateRisk(summaries);

    const updated: ChangeSet = Object.freeze({
      ...current,
      operations: newOperations,
      fingerprint: computeFingerprint(newOperations),
      summaries,
      risk,
      updatedAt: now,
    });

    this.changeSets.set(changeSetId, updated);
    return updated;
  }

  /**
   * Transitions a Change_Set to a new state, enforcing the state machine.
   */
  transition(changeSetId: string, targetState: ChangeSetState): ChangeSet {
    const current = this.changeSets.get(changeSetId);
    if (!current) {
      throw new Error(`Change_Set ${changeSetId} not found`);
    }

    const allowedTransitions = VALID_STATE_TRANSITIONS[current.state];
    if (!allowedTransitions.includes(targetState)) {
      throw new InvalidStateTransitionError(changeSetId, current.state, targetState);
    }

    const now = new Date().toISOString();
    const updated: ChangeSet = Object.freeze({
      ...current,
      state: targetState,
      updatedAt: now,
    });

    this.changeSets.set(changeSetId, updated);
    return updated;
  }

  /**
   * Validates base hashes of all modify/delete/rename/move operations
   * against the current workspace state before acceptance.
   *
   * @param changeSetId The Change_Set to validate
   * @param hashResolver Function that returns the current content hash for a URI
   * @returns Array of validation errors (empty means valid)
   */
  validateBaseHashes(
    changeSetId: string,
    hashResolver: HashResolver
  ): BaseHashValidationError[] {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) {
      throw new Error(`Change_Set ${changeSetId} not found`);
    }

    const errors: BaseHashValidationError[] = [];

    for (const op of changeSet.operations) {
      if (op.kind === 'create') continue; // create has no base hash

      const baseHash = op.baseHash;
      const uri = op.kind === 'rename' || op.kind === 'move' ? op.sourceUri : op.targetUri;
      const currentHash = hashResolver(uri);

      if (currentHash === null) {
        // File doesn't exist but operation expects it
        errors.push(
          new BaseHashValidationError(changeSetId, uri, baseHash, '<file-not-found>')
        );
      } else if (currentHash !== baseHash) {
        errors.push(
          new BaseHashValidationError(changeSetId, uri, baseHash, currentHash)
        );
      }
    }

    return errors;
  }

  /**
   * Checks if a Change_Set is in a terminal state.
   */
  isTerminal(changeSetId: string): boolean {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) {
      throw new Error(`Change_Set ${changeSetId} not found`);
    }
    return TERMINAL_STATES.includes(changeSet.state);
  }

  /**
   * Updates the validation status of a Change_Set.
   */
  updateValidationStatus(changeSetId: string, status: ValidationStatus): ChangeSet {
    const current = this.changeSets.get(changeSetId);
    if (!current) {
      throw new Error(`Change_Set ${changeSetId} not found`);
    }

    const updated: ChangeSet = Object.freeze({
      ...current,
      validationStatus: status,
      updatedAt: new Date().toISOString(),
    });

    this.changeSets.set(changeSetId, updated);
    return updated;
  }

  /**
   * Links a provenance record to a Change_Set (checkpoint, evidence, tool event, or chat turn).
   */
  linkProvenance(
    changeSetId: string,
    link: {
      toolEventId?: string;
      preApplyCheckpointId?: string;
      postApplyCheckpointId?: string;
      evidenceId?: string;
      chatTurnId?: string;
    }
  ): ChangeSet {
    const current = this.changeSets.get(changeSetId);
    if (!current) {
      throw new Error(`Change_Set ${changeSetId} not found`);
    }

    const provenance: ChangeSetProvenance = {
      toolEventIds: Object.freeze(
        link.toolEventId
          ? [...current.provenance.toolEventIds, link.toolEventId]
          : [...current.provenance.toolEventIds]
      ),
      preApplyCheckpointId:
        link.preApplyCheckpointId ?? current.provenance.preApplyCheckpointId,
      postApplyCheckpointId:
        link.postApplyCheckpointId ?? current.provenance.postApplyCheckpointId,
      evidenceIds: Object.freeze(
        link.evidenceId
          ? [...current.provenance.evidenceIds, link.evidenceId]
          : [...current.provenance.evidenceIds]
      ),
      chatTurnIds: Object.freeze(
        link.chatTurnId
          ? [...current.provenance.chatTurnIds, link.chatTurnId]
          : [...current.provenance.chatTurnIds]
      ),
    };

    const updated: ChangeSet = Object.freeze({
      ...current,
      provenance: Object.freeze(provenance),
      updatedAt: new Date().toISOString(),
    });

    this.changeSets.set(changeSetId, updated);
    return updated;
  }

  /**
   * Returns the number of Change_Sets stored.
   */
  get size(): number {
    return this.changeSets.size;
  }
}
