/**
 * Teacher_Escalation_Loop (Feature 7)
 *
 * When a self-hosted "student" model fails a turn, escalate the failed turn to
 * a stronger, explicitly-configured "teacher" endpoint. If the teacher's reply
 * itself clears the failure detector, persist the recovery as a reusable skill
 * so the local model improves on the same task next time.
 *
 * This module is intentionally side-effect free at import time and exposes three
 * units:
 *   - `isSelfHosted`  — gate that keeps escalation latency away from users who
 *                       are already on a paid SOTA API.
 *   - `evaluateTurn`  — a cheap, pure, regex-based failure detector.
 *   - `maybeEscalate` — orchestration that wires the two together with the
 *                       Skill_Learner.
 *
 * Flag gating (`TEACHER_ESCALATION_ENABLED`), "agent mode active", and the
 * "teacherModel configured" precondition from Requirement 40.2 are enforced by
 * the pipeline integration call site, not here — `maybeEscalate` only owns the
 * two preconditions it can observe from its arguments (failure detected AND the
 * student endpoint is self-hosted).
 *
 * Requirements: 38, 39, 40
 */

/**
 * Hostnames of the major hosted "SOTA" LLM APIs. A student endpoint pointing at
 * any of these is, by definition, NOT self-hosted, so escalation is skipped.
 */
export const SOTA_HOSTS = new Set<string>([
  'api.openai.com',
  'api.anthropic.com',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.cohere.com',
  'api.together.xyz',
  'api.fireworks.ai',
  'api.perplexity.ai',
  'api.x.ai',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'openrouter.ai',
  'ollama.com',
]);

/**
 * Regex patterns that indicate a tool reported an error in its `error`/`output`.
 * Mirrors the Failure Patterns table in the design document.
 */
const TOOL_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /^Unknown action\b/i,
  /^Failed to\b/i,
  /\bnot found\b/i,
  /^Invalid\b/i,
  /\berror:\s/i,
];

/**
 * Regex patterns that indicate the agent gave up in its natural-language reply.
 * Mirrors the Failure Patterns table in the design document.
 */
const AGENT_GIVE_UP_PATTERNS: ReadonlyArray<RegExp> = [
  /\bI don't have (?:a )?tool\b/i,
  /\bI can(?:'t|not) (?:do|find|figure)\b/i,
  /\bI'?m not sure (?:which|how|what)\b/i,
  /\bunable to (?:open|find|switch|complete)\b/i,
];

/**
 * The full context of a failed student turn, handed to the teacher endpoint so
 * it has everything it needs to produce a recovery.
 */
export interface FailedTurnContext {
  /** The student endpoint URL that produced the failed turn. */
  studentEndpoint: string;
  /** The tool results observed during the failed turn. */
  toolResults: Array<{ error?: string; output?: string }>;
  /** The student agent's natural-language reply for the failed turn. */
  agentReply: string;
  /** Human-readable reason the turn was classified as a failure, if known. */
  failureReason?: string;
}

/**
 * Collaborators `maybeEscalate` depends on. Injected so the module stays free of
 * any concrete LLM-client or database wiring (and so tests need no mocks of
 * those subsystems).
 */
export interface TeacherEscalationDeps {
  /** Calls the configured teacher endpoint with the failed turn's context. */
  callTeacher: (context: FailedTurnContext) => Promise<string>;
  /** Persists a recovered procedure as a reusable learned skill. */
  skillLearner: {
    recordRecovery(name: string, body: string, meta: object): Promise<void>;
  };
}

/**
 * Returns whether `endpointUrl` points at a self-hosted model.
 *
 * The endpoint is considered self-hosted unless its hostname is one of the
 * known hosted SOTA APIs (`SOTA_HOSTS`). Parsing is robust: a bare `host:port`
 * or `host/path` form (no scheme) is still understood. An empty or genuinely
 * unparseable URL is treated conservatively as self-hosted — we would rather
 * occasionally escalate than silently suppress a recoverable failure.
 *
 * @param endpointUrl - The student endpoint URL.
 * @returns `false` iff the URL's hostname is in `SOTA_HOSTS`; otherwise `true`.
 *
 * Validates: Requirement 38
 */
export function isSelfHosted(endpointUrl: string): boolean {
  if (typeof endpointUrl !== 'string') return true;
  const trimmed = endpointUrl.trim();
  if (trimmed === '') return true;

  const hostname = parseHostname(trimmed);
  if (hostname === null) return true; // unparseable → conservative

  return !SOTA_HOSTS.has(hostname.toLowerCase());
}

/**
 * Best-effort hostname extraction. Tries a direct parse first, then retries with
 * an `https://` scheme to accommodate bare `host`/`host:port` forms. Returns
 * `null` when no usable hostname can be derived.
 */
function parseHostname(url: string): string | null {
  const direct = tryHostname(url);
  if (direct !== null) return direct;
  // Bare host (e.g. "localhost:11434" or "api.openai.com/v1") lacks a scheme;
  // the WHATWG URL parser needs one.
  return tryHostname(`https://${url}`);
}

function tryHostname(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * Cheap, pure failure detector for a single agent turn.
 *
 * Scans every tool result's `error` and `output` strings for known tool-error
 * patterns, then the agent's reply for known give-up patterns. The first match
 * wins and is reported in `reason`. When nothing matches, the turn is `ok`.
 *
 * This function is deterministic and pure: identical arguments always yield an
 * identical result, with no reliance on clocks, randomness, or shared state.
 *
 * @param toolResults - Tool results observed during the turn.
 * @param agentReply - The agent's natural-language reply for the turn.
 * @returns `{ status: 'failure', reason }` on the first recognized failure
 *   signal, otherwise `{ status: 'ok' }`.
 *
 * Validates: Requirement 39
 */
export function evaluateTurn(
  toolResults: Array<{ error?: string; output?: string }>,
  agentReply: string,
): { status: 'ok' | 'failure'; reason?: string } {
  const results = Array.isArray(toolResults) ? toolResults : [];

  for (const result of results) {
    if (result == null) continue;
    const fields: Array<string | undefined> = [result.error, result.output];
    for (const field of fields) {
      if (typeof field !== 'string' || field === '') continue;
      const match = firstMatch(field, TOOL_ERROR_PATTERNS);
      if (match) {
        return { status: 'failure', reason: `tool error: ${match.source}` };
      }
    }
  }

  if (typeof agentReply === 'string' && agentReply !== '') {
    const match = firstMatch(agentReply, AGENT_GIVE_UP_PATTERNS);
    if (match) {
      return { status: 'failure', reason: `agent gave up: ${match.source}` };
    }
  }

  return { status: 'ok' };
}

function firstMatch(text: string, patterns: ReadonlyArray<RegExp>): RegExp | null {
  for (const pattern of patterns) {
    if (pattern.test(text)) return pattern;
  }
  return null;
}

/**
 * Orchestrates the teacher escalation for a completed student turn.
 *
 * Escalation proceeds only when BOTH preconditions this function can observe are
 * met: the turn is classified as a failure by `evaluateTurn`, AND the student
 * endpoint is self-hosted. When either is unmet, returns `{ escalated: false }`
 * without calling the teacher.
 *
 * When escalation proceeds, the teacher endpoint is called with the failed
 * turn's full context. The teacher's reply is then run back through
 * `evaluateTurn`; only if it clears the detector (`status: 'ok'`) is the
 * recovery persisted via `skillLearner.recordRecovery`. A teacher reply that
 * itself reads as a failure is returned to the caller but not persisted.
 *
 * @returns `{ escalated, teacherReply? }` — `escalated` is `true` once the
 *   teacher endpoint has been invoked.
 *
 * Validates: Requirement 40
 */
export async function maybeEscalate(
  studentEndpoint: string,
  toolResults: Array<{ error?: string; output?: string }>,
  agentReply: string,
  deps: TeacherEscalationDeps,
): Promise<{ escalated: boolean; teacherReply?: string }> {
  const studentEval = evaluateTurn(toolResults, agentReply);
  if (studentEval.status !== 'failure') return { escalated: false };
  if (!isSelfHosted(studentEndpoint)) return { escalated: false };

  const context: FailedTurnContext = {
    studentEndpoint,
    toolResults,
    agentReply,
    failureReason: studentEval.reason,
  };

  const teacherReply = await deps.callTeacher(context);

  // Only persist a recovery the teacher itself was confident about.
  const teacherEval = evaluateTurn([], teacherReply);
  if (teacherEval.status === 'ok') {
    await deps.skillLearner.recordRecovery(
      recoveryName(studentEval.reason),
      teacherReply,
      {
        source: 'teacher-escalation',
        studentEndpoint,
        failureReason: studentEval.reason,
      },
    );
  }

  return { escalated: true, teacherReply };
}

/** Builds a concise, deterministic skill name from the detected failure reason. */
function recoveryName(reason: string | undefined): string {
  const base = (reason ?? 'failed turn').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `Teacher recovery: ${base}`;
}
