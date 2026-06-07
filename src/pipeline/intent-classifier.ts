/**
 * Enhanced Intent Classifier - Distinguishes informational from execution requests
 *
 * Solves the problem where "Can you build an app?" triggers app-building
 * instead of describing capabilities. Informational qualifiers at the start
 * of a message override action verbs.
 *
 * Requirement Coverage: Req 1 (AC 1–6)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface IntentSignal {
  type: 'informational_qualifier' | 'action_verb' | 'anti_build' | 'conversational';
  pattern: string;
  weight: number; // 0.0 - 1.0
}

export interface ClassificationResult {
  intent: 'informational' | 'execution' | 'ambiguous' | 'self_knowledge';
  confidence: number;
  signals: IntentSignal[];
}

export interface QualifierPattern {
  pattern: RegExp;
  weight: number; // 0.0 - 1.0
}

/**
 * JSON pattern entry as stored in informational-patterns.json
 */
interface PatternEntry {
  pattern: string;
  flags: string;
  weight: number;
}

interface PatternsConfig {
  version: string;
  patterns: PatternEntry[];
}

/**
 * Runtime pattern loader — reads informational-patterns.json and caches
 * the result. Re-reads the file when its mtime changes, so pattern updates
 * take effect without restarting the application.
 *
 * Validates: Requirements 1.5, 1.6
 */
const PATTERNS_FILE_PATH = path.resolve(__dirname, '..', 'data', 'informational-patterns.json');

let cachedPatterns: QualifierPattern[] | null = null;
let cachedMtime: number = 0;

function loadPatternsFromFile(): QualifierPattern[] | null {
  try {
    const stat = fs.statSync(PATTERNS_FILE_PATH);
    const mtime = stat.mtimeMs;

    if (cachedPatterns && mtime === cachedMtime) {
      return cachedPatterns;
    }

    const raw = fs.readFileSync(PATTERNS_FILE_PATH, 'utf-8');
    const config: PatternsConfig = JSON.parse(raw);

    const patterns: QualifierPattern[] = config.patterns.map((entry) => ({
      pattern: new RegExp(entry.pattern, entry.flags),
      weight: entry.weight,
    }));

    cachedPatterns = patterns;
    cachedMtime = mtime;
    return patterns;
  } catch {
    // File missing, unreadable, or malformed — fall back to hardcoded defaults
    return null;
  }
}

/**
 * Default hardcoded informational qualifiers — used as fallback when the
 * JSON configuration file is unavailable or malformed.
 *
 * Validates: Requirements 1.1, 1.3, 1.5
 */
const DEFAULT_INFORMATIONAL_QUALIFIERS: QualifierPattern[] = [
  { pattern: /^can you\b/i, weight: 0.7 },
  { pattern: /^are you able to\b/i, weight: 0.8 },
  { pattern: /^do you support\b/i, weight: 0.8 },
  { pattern: /^is it possible to\b/i, weight: 0.7 },
  { pattern: /^what can you\b/i, weight: 0.9 },
  { pattern: /^could you\b/i, weight: 0.5 },  // lower — often used as polite imperative
  { pattern: /^would you be able to\b/i, weight: 0.8 },
  { pattern: /^does neuronest\b/i, weight: 0.9 },
  { pattern: /^how does.*work/i, weight: 0.85 },
  { pattern: /^what happens when/i, weight: 0.85 },
  { pattern: /^tell me about\b/i, weight: 0.9 },
  { pattern: /^explain\b/i, weight: 0.8 },
];

/**
 * Get the current informational qualifiers — loads from JSON config file
 * if available (with mtime-based caching), otherwise falls back to hardcoded defaults.
 *
 * Validates: Requirements 1.5, 1.6
 */
export function getInformationalQualifiers(): QualifierPattern[] {
  return loadPatternsFromFile() ?? DEFAULT_INFORMATIONAL_QUALIFIERS;
}

/**
 * Exported constant for backward compatibility — consumers that reference
 * INFORMATIONAL_QUALIFIERS directly will still get the default patterns.
 * For runtime-configurable patterns, use getInformationalQualifiers() instead.
 */
export const INFORMATIONAL_QUALIFIERS: QualifierPattern[] = DEFAULT_INFORMATIONAL_QUALIFIERS;

/**
 * Self-knowledge detection patterns — identifies queries about NeuroNest itself.
 * These are checked FIRST, before informational/execution scoring.
 * Explicit mentions (neuronest, neuronest.cc) get 0.95 confidence.
 * Implicit self-references (this app, your features) get 0.8 confidence.
 *
 * Validates: Requirements 8 (AC 2)
 */
export const SELF_KNOWLEDGE_PATTERNS: { pattern: RegExp; weight: number; explicit: boolean }[] = [
  { pattern: /\bneuronest\b/i, weight: 0.95, explicit: true },
  { pattern: /\bneuronest\.cc\b/i, weight: 0.95, explicit: true },
  { pattern: /\bthis app\b/i, weight: 0.8, explicit: false },
  { pattern: /\bthis tool\b/i, weight: 0.8, explicit: false },
  { pattern: /\byour feature/i, weight: 0.8, explicit: false },
  { pattern: /\byour pricing\b/i, weight: 0.8, explicit: false },
  { pattern: /\byour agent/i, weight: 0.8, explicit: false },
  { pattern: /\babout yourself\b/i, weight: 0.8, explicit: false },
  { pattern: /\bwho are you\b/i, weight: 0.8, explicit: false },
  { pattern: /\bwhat are you\b/i, weight: 0.8, explicit: false },
];

/**
 * Execution confirmers — these confirm execution intent.
 * Patterns that indicate the user is requesting the system to perform an action.
 *
 * Validates: Requirements 1.1, 1.3
 */
export const EXECUTION_CONFIRMERS: QualifierPattern[] = [
  { pattern: /\bfor me\b/i, weight: 0.3 },
  { pattern: /\bright now\b/i, weight: 0.4 },
  { pattern: /\bplease (build|create|make|write|implement)\b/i, weight: 0.5 },
  { pattern: /\bgo ahead\b/i, weight: 0.6 },
  { pattern: /\bstart (building|creating|coding)\b/i, weight: 0.7 },
  { pattern: /^(build|rebuild|create|make|write|implement|deploy|fix|refactor|redesign|restructure|setup|develop|configure|migrate|convert|upgrade)\b/i, weight: 0.8 },
  // Project-specific action patterns — "can you [verb] [thing] from/in/to the project"
  // These indicate a polite imperative, not a capability question
  { pattern: /\b(delete|remove|rename|move|copy|add|update|modify|edit|change|clean|clear|reset)\b.*\b(file|folder|directory|project|code|module|component)\b/i, weight: 0.6 },
  { pattern: /\b(from|in|to|into|within)\s+(the|my|this)\s+(project|repo|repository|codebase)\b/i, weight: 0.5 },
];

/**
 * Classify user message intent by scoring informational vs execution signals.
 *
 * Scoring rules:
 * 0. Check self-knowledge patterns FIRST — if matched, return immediately
 * 1. Check message against INFORMATIONAL_QUALIFIERS — sum matching weights
 * 2. Apply 1.5x multiplier for qualifiers anchored to start of message (patterns starting with ^)
 * 3. Check message against EXECUTION_CONFIRMERS — sum matching weights
 * 4. If any informational qualifier matched, discount execution score by ×0.4
 * 5. Whichever signal set has higher total score wins
 * 6. If difference < 0.3 → ambiguous
 *
 * Validates: Requirements 1.1, 1.3, 8 (AC 2)
 */
export function classifyIntent(message: string): ClassificationResult {
  // 0. Self-knowledge detection — takes priority over all other classification
  for (const skPattern of SELF_KNOWLEDGE_PATTERNS) {
    if (skPattern.pattern.test(message)) {
      // File-path/code-reference exclusion (Req 9, AC 5)
      // When "neuronest" appears inside a path pattern AND the message contains
      // build/fix/refactor action verbs, do NOT classify as self-knowledge
      const pathPatterns = /(?:src\/|\.\/|\.neuronest\/|neuronest-)[^\s]*/i;
      const actionVerbs = /\b(build|fix|refactor|create|implement|deploy|update|debug|test)\b/i;
      if (pathPatterns.test(message) && actionVerbs.test(message)) {
        // "neuronest" appears in a code context with action verbs — NOT a self-knowledge query
        // Fall through to normal informational/execution classification
        break;
      }

      return {
        intent: 'self_knowledge',
        confidence: skPattern.weight,
        signals: [{
          type: 'informational_qualifier',
          pattern: skPattern.pattern.source,
          weight: skPattern.weight,
        }],
      };
    }
  }

  const signals: IntentSignal[] = [];
  let informationalScore = 0;
  let executionScore = 0;
  let hasInformationalQualifier = false;

  // 1. Score informational signals (loaded from JSON config at runtime)
  const qualifiers = getInformationalQualifiers();
  for (const qualifier of qualifiers) {
    if (qualifier.pattern.test(message)) {
      hasInformationalQualifier = true;

      // Apply 1.5x weight for start-of-message qualifiers (patterns anchored with ^)
      const isStartAnchored = qualifier.pattern.source.startsWith('^');
      const effectiveWeight = isStartAnchored ? qualifier.weight * 1.5 : qualifier.weight;

      informationalScore += effectiveWeight;
      signals.push({
        type: 'informational_qualifier',
        pattern: qualifier.pattern.source,
        weight: effectiveWeight,
      });
    }
  }

  // 2. Score execution signals
  for (const confirmer of EXECUTION_CONFIRMERS) {
    if (confirmer.pattern.test(message)) {
      executionScore += confirmer.weight;
      signals.push({
        type: 'action_verb',
        pattern: confirmer.pattern.source,
        weight: confirmer.weight,
      });
    }
  }

  // 3. Discount execution score when informational qualifier is present
  //    UNLESS the execution signals include project-specific action patterns,
  //    which indicate a polite imperative ("can you delete files from the project")
  //    rather than a capability question ("can you build an app?")
  if (hasInformationalQualifier) {
    const hasProjectActionSignal = signals.some(
      s => s.type === 'action_verb' && s.weight >= 0.5 &&
        (s.pattern.includes('delete|remove|rename|move|copy') || s.pattern.includes('from|in|to|into|within'))
    );
    if (hasProjectActionSignal) {
      // Weaker discount for project-specific actions — user is likely making a polite request
      executionScore *= 0.85;
    } else {
      executionScore *= 0.4;
    }
  }

  // 4. Determine classification based on scores
  const scoreDifference = Math.abs(informationalScore - executionScore);
  let intent: 'informational' | 'execution' | 'ambiguous' | 'self_knowledge';
  let confidence: number;

  if (scoreDifference < 0.3) {
    intent = 'ambiguous';
    confidence = Math.max(informationalScore, executionScore);
  } else if (informationalScore > executionScore) {
    intent = 'informational';
    confidence = informationalScore;
  } else {
    intent = 'execution';
    confidence = executionScore;
  }

  return { intent, confidence, signals };
}
