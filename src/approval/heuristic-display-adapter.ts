/**
 * Heuristic display-only adapter (FUT-PKG-04-SECURITY/T-006).
 *
 * NN-APPROVAL-006 / CD-010: detecting natural-language prose such as "yes/no",
 * "confirm", "proceed", or numbered choices MAY create a compatibility/display
 * candidate, but SHALL NOT itself authorize work. This adapter is that
 * detector — and NOTHING more. It produces {@link DisplayCandidate}s the shared
 * card can render as compatibility prompts; it has NO access to the Approval
 * Service and cannot mint an `ApprovalDecision`. High-risk work always requires
 * a typed decision produced by an explicit user action (routed through
 * {@link ../approval/approval-service}.decideApproval).
 *
 * The migration posture of the task is enforced here structurally: the adapter
 * is retained (display), but heuristic AUTHORIZATION is impossible because this
 * module never returns anything the authority accepts as a decision. The single
 * authorizing path is a typed `ApprovalDecision@1` (NN-APPROVAL-002).
 *
 * Design anchors: D-11 (fail-closed tool sequence), D-16 (approvals).
 * Requirements: NN-APPROVAL-006/007, NN-COMPAT-005. Canonical claim: CD-010.
 */

// ─── Detection result ────────────────────────────────────────────────────────

/** The prose pattern class a detection matched. */
export const PROSE_PATTERNS = Object.freeze([
  'affirmative', // "yes", "sure", "go ahead"
  'negative', // "no", "cancel", "stop"
  'confirm', // "confirm", "proceed", "continue"
  'numbered-choice', // "1) ...", "2. ..."
] as const);
export type ProsePattern = (typeof PROSE_PATTERNS)[number];

/**
 * A display-only compatibility candidate produced from detected prose. It is
 * explicitly NOT a decision: it carries no bound action digest, no authorizing
 * outcome, and the fixed marker {@link DISPLAY_ONLY}. The renderer MAY show it
 * as a compatibility prompt whose controls route a subsequent explicit click
 * through the normal typed decision pipeline (NN-APPROVAL-007).
 */
export interface DisplayCandidate {
  /** Discriminant that makes this un-mistakable for a decision. */
  readonly kind: typeof DISPLAY_ONLY;
  readonly pattern: ProsePattern;
  /** The matched prose span (safe, secret-free echo of the user's own text). */
  readonly matchedText: string;
  /** For numbered choices, the parsed option indices (1-based). */
  readonly choiceIndices?: readonly number[];
  /**
   * A stable, explicit statement that this candidate authorizes NOTHING. Present
   * so any code that inspects a candidate cannot misread it as an approval.
   */
  readonly authorizes: false;
}

/** The fixed discriminant marking a value as display-only (never a decision). */
export const DISPLAY_ONLY = 'display-only-candidate' as const;

// ─── Detectors (pure) ────────────────────────────────────────────────────────

const AFFIRMATIVE = /\b(yes|yeah|yep|sure|ok(ay)?|go ahead|do it)\b/i;
const NEGATIVE = /\b(no|nope|cancel|stop|abort|don'?t)\b/i;
const CONFIRM = /\b(confirm|proceed|continue|approve|accept)\b/i;
const NUMBERED = /(?:^|\n)\s*(\d{1,2})[.)]\s+\S/g;

/**
 * Detect natural-language prose in `text` and return display candidates. The
 * result is ALWAYS display-only: every candidate carries `authorizes: false`.
 * Detecting nothing returns an empty array. This function performs NO side
 * effect and touches no store — it cannot authorize (NN-APPROVAL-006).
 *
 * Precedence: numbered choices, then confirm, then negative, then affirmative —
 * so an explicit "cancel" is never misclassified as an affirmative and a
 * numbered menu is surfaced as a choice prompt rather than a single button.
 */
export function detectProseCandidates(text: string): DisplayCandidate[] {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const candidates: DisplayCandidate[] = [];

  const choiceIndices: number[] = [];
  let m: RegExpExecArray | null;
  NUMBERED.lastIndex = 0;
  while ((m = NUMBERED.exec(text)) !== null) {
    choiceIndices.push(Number(m[1]));
  }
  if (choiceIndices.length >= 2) {
    candidates.push({
      kind: DISPLAY_ONLY,
      pattern: 'numbered-choice',
      matchedText: text.slice(0, 256),
      choiceIndices,
      authorizes: false,
    });
  }

  const confirm = CONFIRM.exec(text);
  if (confirm) {
    candidates.push(makeCandidate('confirm', confirm[0]));
  }
  const negative = NEGATIVE.exec(text);
  if (negative) {
    candidates.push(makeCandidate('negative', negative[0]));
  }
  // Only report a bare affirmative if it is not already covered by confirm.
  const affirmative = AFFIRMATIVE.exec(text);
  if (affirmative && !confirm) {
    candidates.push(makeCandidate('affirmative', affirmative[0]));
  }

  return candidates;
}

function makeCandidate(pattern: ProsePattern, matchedText: string): DisplayCandidate {
  return { kind: DISPLAY_ONLY, pattern, matchedText, authorizes: false };
}

/**
 * A total, type-level guarantee used by the authority boundary: a
 * {@link DisplayCandidate} can NEVER be an authorization. This helper returns
 * `false` for every possible candidate; it exists so a reviewer (and the type
 * checker) can see the invariant asserted in code (CD-010).
 */
export function candidateAuthorizes(_candidate: DisplayCandidate): false {
  return false;
}
