// File: packages/neuronest-cli/src/cli/orchestration-commands.ts
//
// CLI command handlers for orchestration operations: race, fork, and snapshot.
//
// These commands follow the standalone pattern (no HeadlessTransport) similar to
// the `task` command in agent-runner.ts. They interact directly with the
// AgentRacingEngine, SessionForker, and WorktreeCheckpointManager subsystems.
//
// Each command checks the relevant feature gate first and displays a descriptive
// message when the feature is disabled (Req 4.7).
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8

import type { CliExitCode } from './types.js';

// ─── Types ──────────────────────────────────────────────────────

/** Options for the `neuronest race` command */
export interface RaceCommandOptions {
  /** The prompt to send to all race participants */
  prompt: string;
  /** Comma-separated list of provider IDs to use */
  providers?: string | undefined;
}

/** Options for the `neuronest fork` command */
export interface ForkCommandOptions {
  /** The session ID to fork from */
  sessionId: string;
}

/** Options for the `neuronest snapshot create` command */
export interface SnapshotCreateCommandOptions {
  /** Optional label for the snapshot */
  label?: string | undefined;
}

/** Options for the `neuronest snapshot restore` command */
export interface SnapshotRestoreCommandOptions {
  /** The snapshot ID to restore */
  id: string;
}

/** Feature gate check result */
export interface FeatureGateCheck {
  enabled: boolean;
  featureName: string;
}

/**
 * Interface for the feature gate accessor used by CLI commands.
 * Decoupled from the full FeatureGateSystem to keep the CLI package
 * lightweight and testable.
 */
export interface FeatureGateAccessor {
  isEnabled(feature: string): boolean;
}

/**
 * Interface for the Agent Racing Engine as consumed by CLI commands.
 * Matches the IAgentRacingEngine interface from the main package.
 */
export interface RacingEngineAccessor {
  startRace(config: {
    prompt: string;
    participants: Array<{ providerId: string; model: string }>;
  }): Promise<{
    raceId: string;
    status: string;
    winner: { participantId: string; config: { providerId: string; model: string }; qualityScore: number } | null;
    participants: Array<{ participantId: string; config: { providerId: string; model: string }; status: string; qualityScore: number; error?: string }>;
    totalDurationMs: number;
  }>;
}

/**
 * Interface for the Session Forker as consumed by CLI commands.
 * Matches the ISessionForker interface from the main package.
 */
export interface SessionForkerAccessor {
  fork(options: { sourceSessionId: string }): Promise<{
    success: boolean;
    forkedSession?: { id: string };
    forkedWorktreeBranch?: string;
    error?: string;
  }>;
}

/**
 * Interface for the Worktree Checkpoint Manager as consumed by CLI commands.
 * Matches the IWorktreeCheckpointManager interface from the main package.
 */
export interface CheckpointManagerAccessor {
  create(options: { sessionId: string; label?: string }): Promise<{
    id: string;
    sessionId: string;
    label?: string;
    createdAt: string;
    gitRef: string;
    sizeBytes: number;
  }>;
  restore(options: { snapshotId?: string; label?: string }): Promise<void>;
  list(sessionId?: string): Array<{
    id: string;
    sessionId: string;
    label?: string;
    createdAt: string;
    gitRef: string;
    sizeBytes: number;
  }>;
}

/**
 * Dependency container for orchestration CLI commands.
 * Provided at startup time by the CLI bootstrap.
 */
export interface OrchestrationCommandDeps {
  featureGate: FeatureGateAccessor;
  racingEngine?: RacingEngineAccessor;
  sessionForker?: SessionForkerAccessor;
  checkpointManager?: CheckpointManagerAccessor;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Current session ID for snapshot operations (defaults to 'default') */
  currentSessionId?: string;
}

// ─── Feature Gate Messages ──────────────────────────────────────

const FEATURE_DISABLED_MESSAGES: Record<string, string> = {
  agent_racing:
    'The Agent Racing feature is currently disabled. Enable the "agent_racing" feature gate to use race commands.',
  session_forking:
    'The Session Forking feature is currently disabled. Enable the "session_forking" feature gate to use fork commands.',
  worktree_checkpoints:
    'The Worktree Checkpoints feature is currently disabled. Enable the "worktree_checkpoints" feature gate to use snapshot commands.',
};

/**
 * Check if a feature is enabled and return descriptive message if disabled.
 */
function checkFeatureGate(
  featureGate: FeatureGateAccessor,
  feature: string,
): FeatureGateCheck {
  return {
    enabled: featureGate.isEnabled(feature),
    featureName: feature,
  };
}

// ─── Command Handlers ───────────────────────────────────────────

/**
 * Handle `neuronest race <prompt>` command.
 *
 * Initiates an Agent Racing Engine execution with the provided prompt
 * and configured providers. Displays race progress and final results.
 *
 * Validates: Requirements 4.1, 4.2, 4.7
 */
export async function handleRaceCommand(
  options: RaceCommandOptions,
  deps: OrchestrationCommandDeps,
): Promise<CliExitCode> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  // Feature gate check (Req 4.7)
  const gateCheck = checkFeatureGate(deps.featureGate, 'agent_racing');
  if (!gateCheck.enabled) {
    stderr.write(`${FEATURE_DISABLED_MESSAGES['agent_racing']}\n`);
    return 1;
  }

  if (!deps.racingEngine) {
    stderr.write('error: race: Agent Racing Engine is not available\n');
    return 1;
  }

  // Parse providers from comma-separated flag (Req 4.2)
  const providerIds = options.providers
    ? options.providers.split(',').map((p) => p.trim()).filter(Boolean)
    : ['default'];

  const participants = providerIds.map((providerId) => ({
    providerId,
    model: 'default',
  }));

  stdout.write(`Starting race with ${participants.length} participant(s)...\n`);
  stdout.write(`Prompt: ${options.prompt}\n\n`);

  try {
    const result = await deps.racingEngine.startRace({
      prompt: options.prompt,
      participants,
    });

    // Display results
    stdout.write(`Race ${result.raceId} ${result.status}\n`);
    stdout.write(`Duration: ${result.totalDurationMs}ms\n\n`);

    if (result.winner) {
      stdout.write(`Winner: ${result.winner.config.providerId} (score: ${result.winner.qualityScore.toFixed(2)})\n`);
    } else {
      stdout.write('No winner — all participants failed.\n');
    }

    stdout.write('\nParticipants:\n');
    for (const p of result.participants) {
      const status = p.status.padEnd(10);
      const score = p.qualityScore.toFixed(2);
      const errorSuffix = p.error ? ` — ${p.error}` : '';
      stdout.write(`  ${p.config.providerId.padEnd(20)} ${status} score: ${score}${errorSuffix}\n`);
    }

    return result.status === 'all-failed' ? 1 : 0;
  } catch (err) {
    stderr.write(`error: race: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * Handle `neuronest fork <sessionId>` command.
 *
 * Creates a forked session from the specified source session and
 * displays the new session ID.
 *
 * Validates: Requirements 4.3, 4.7
 */
export async function handleForkCommand(
  options: ForkCommandOptions,
  deps: OrchestrationCommandDeps,
): Promise<CliExitCode> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  // Feature gate check (Req 4.7)
  const gateCheck = checkFeatureGate(deps.featureGate, 'session_forking');
  if (!gateCheck.enabled) {
    stderr.write(`${FEATURE_DISABLED_MESSAGES['session_forking']}\n`);
    return 1;
  }

  if (!deps.sessionForker) {
    stderr.write('error: fork: Session Forker is not available\n');
    return 1;
  }

  stdout.write(`Forking session ${options.sessionId}...\n`);

  try {
    const result = await deps.sessionForker.fork({
      sourceSessionId: options.sessionId,
    });

    if (!result.success) {
      stderr.write(`error: fork: ${result.error ?? 'unknown error'}\n`);
      return 1;
    }

    const sessionId = result.forkedSession?.id ?? 'unknown';
    stdout.write(`Forked session created: ${sessionId}\n`);
    if (result.forkedWorktreeBranch) {
      stdout.write(`Worktree branch: ${result.forkedWorktreeBranch}\n`);
    }

    return 0;
  } catch (err) {
    stderr.write(`error: fork: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * Handle `neuronest snapshot create` command.
 *
 * Creates a worktree snapshot with an optional label.
 *
 * Validates: Requirements 4.4, 4.7
 */
export async function handleSnapshotCreateCommand(
  options: SnapshotCreateCommandOptions,
  deps: OrchestrationCommandDeps,
): Promise<CliExitCode> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  // Feature gate check (Req 4.7)
  const gateCheck = checkFeatureGate(deps.featureGate, 'worktree_checkpoints');
  if (!gateCheck.enabled) {
    stderr.write(`${FEATURE_DISABLED_MESSAGES['worktree_checkpoints']}\n`);
    return 1;
  }

  if (!deps.checkpointManager) {
    stderr.write('error: snapshot: Worktree Checkpoint Manager is not available\n');
    return 1;
  }

  const sessionId = deps.currentSessionId ?? 'default';

  try {
    const snapshot = await deps.checkpointManager.create({
      sessionId,
      ...(options.label != null ? { label: options.label } : {}),
    });

    stdout.write(`Snapshot created: ${snapshot.id}\n`);
    if (snapshot.label) {
      stdout.write(`Label: ${snapshot.label}\n`);
    }
    stdout.write(`Git ref: ${snapshot.gitRef}\n`);
    stdout.write(`Size: ${formatBytes(snapshot.sizeBytes)}\n`);
    stdout.write(`Created at: ${snapshot.createdAt}\n`);

    return 0;
  } catch (err) {
    stderr.write(`error: snapshot create: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * Handle `neuronest snapshot restore <id>` command.
 *
 * Restores the worktree to the specified snapshot state.
 *
 * Validates: Requirements 4.5, 4.7
 */
export async function handleSnapshotRestoreCommand(
  options: SnapshotRestoreCommandOptions,
  deps: OrchestrationCommandDeps,
): Promise<CliExitCode> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  // Feature gate check (Req 4.7)
  const gateCheck = checkFeatureGate(deps.featureGate, 'worktree_checkpoints');
  if (!gateCheck.enabled) {
    stderr.write(`${FEATURE_DISABLED_MESSAGES['worktree_checkpoints']}\n`);
    return 1;
  }

  if (!deps.checkpointManager) {
    stderr.write('error: snapshot: Worktree Checkpoint Manager is not available\n');
    return 1;
  }

  stdout.write(`Restoring snapshot ${options.id}...\n`);

  try {
    await deps.checkpointManager.restore({ snapshotId: options.id });
    stdout.write(`Snapshot ${options.id} restored successfully.\n`);
    return 0;
  } catch (err) {
    stderr.write(`error: snapshot restore: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * Handle `neuronest snapshot list` command.
 *
 * Displays all available snapshots with labels, timestamps, and sessions.
 *
 * Validates: Requirements 4.6, 4.7
 */
export async function handleSnapshotListCommand(
  deps: OrchestrationCommandDeps,
): Promise<CliExitCode> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  // Feature gate check (Req 4.7)
  const gateCheck = checkFeatureGate(deps.featureGate, 'worktree_checkpoints');
  if (!gateCheck.enabled) {
    stderr.write(`${FEATURE_DISABLED_MESSAGES['worktree_checkpoints']}\n`);
    return 1;
  }

  if (!deps.checkpointManager) {
    stderr.write('error: snapshot: Worktree Checkpoint Manager is not available\n');
    return 1;
  }

  try {
    const snapshots = deps.checkpointManager.list();

    if (snapshots.length === 0) {
      stdout.write('No snapshots found.\n');
      return 0;
    }

    stdout.write(`${'ID'.padEnd(38)}${'Label'.padEnd(20)}${'Session'.padEnd(20)}${'Created At'.padEnd(26)}${'Size'}\n`);
    stdout.write(`${'─'.repeat(38)}${'─'.repeat(20)}${'─'.repeat(20)}${'─'.repeat(26)}${'─'.repeat(10)}\n`);

    for (const s of snapshots) {
      const id = s.id.padEnd(38);
      const label = (s.label ?? '—').padEnd(20);
      const session = s.sessionId.padEnd(20);
      const createdAt = s.createdAt.padEnd(26);
      const size = formatBytes(s.sizeBytes);
      stdout.write(`${id}${label}${session}${createdAt}${size}\n`);
    }

    stdout.write(`\nTotal: ${snapshots.length} snapshot(s)\n`);
    return 0;
  } catch (err) {
    stderr.write(`error: snapshot list: ${(err as Error).message}\n`);
    return 1;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
