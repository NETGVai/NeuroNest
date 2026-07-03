/**
 * PatternClassifier — Stage A of the Intent Gate classification cascade.
 *
 * Deterministic regex-based classification using hot-reloadable patterns
 * from `informational-patterns.json`. Designed to complete within 5ms for
 * all message lengths by using bounded regex patterns (no unbounded quantifiers
 * on user input) and early-exit on high-confidence matches.
 *
 * Supports two pattern sources:
 * - `builtin`: shipped with the application in informational-patterns.json
 * - `learned`: added by the LearningLoop from user override corrections
 *
 * Requirements: 2.1, 15.1, 12.5
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IntentLabel, PatternMatch, PatternClassifier as IPatternClassifier } from '../intent-gate.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PatternEntry {
  id: string;
  intent: IntentLabel;
  pattern: string;
  flags: string;
  weight: number;
}

export interface PatternsConfig {
  version: string;
  description?: string;
  builtin: PatternEntry[];
  learned: PatternEntry[];
}

interface CompiledPattern {
  id: string;
  intent: IntentLabel;
  regex: RegExp;
  weight: number;
  source: 'builtin' | 'learned';
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PATTERNS_PATH = path.resolve(__dirname, 'informational-patterns.json');

/** No-match sentinel returned when no pattern matches the input */
const NO_MATCH: PatternMatch = {
  intent: 'conversation',
  confidence: 0,
  pattern: 'none',
  source: 'builtin',
};

// ─── Implementation ─────────────────────────────────────────────────────────

export class PatternClassifierImpl implements IPatternClassifier {
  private compiledPatterns: CompiledPattern[] = [];
  private readonly patternsPath: string;
  private lastMtime: number = 0;

  constructor(patternsPath?: string) {
    this.patternsPath = patternsPath ?? DEFAULT_PATTERNS_PATH;
    this.loadPatterns();
  }

  /**
   * Classify a message using deterministic regex patterns.
   *
   * Strategy:
   * 1. Run all patterns against the message (bounded regex only)
   * 2. Group matches by intent and sum weights
   * 3. Return the intent with the highest total weight, normalized to [0, 1]
   *
   * The confidence is calculated as:
   *   confidence = min(1.0, totalWeight / normalizationFactor)
   *
   * Performance: Completes within 5ms for any message length because:
   * - All patterns use bounded quantifiers (no .* on user input)
   * - Pattern count is bounded (typically < 50)
   * - Early classification on the first N characters for start-anchored patterns
   *
   * Requirements: 2.1, 15.1
   */
  classify(message: string): PatternMatch {
    if (!message || message.trim().length === 0) {
      return { ...NO_MATCH };
    }

    // For performance, limit the portion of the message we test against.
    // Start-anchored patterns only need the first 200 chars.
    // Non-anchored patterns use up to 500 chars to avoid catastrophic backtracking.
    const trimmedMessage = message.trim();
    const shortMessage = trimmedMessage.slice(0, 500);

    const intentScores: Record<IntentLabel, { totalWeight: number; bestPattern: CompiledPattern | null }> = {
      conversation: { totalWeight: 0, bestPattern: null },
      quick_action: { totalWeight: 0, bestPattern: null },
      build: { totalWeight: 0, bestPattern: null },
      ambiguous: { totalWeight: 0, bestPattern: null },
    };

    for (const compiled of this.compiledPatterns) {
      // Use short message for matching to ensure bounded execution time
      const testStr = compiled.regex.source.startsWith('^')
        ? trimmedMessage.slice(0, 200)
        : shortMessage;

      if (compiled.regex.test(testStr)) {
        const entry = intentScores[compiled.intent];
        entry.totalWeight += compiled.weight;
        if (!entry.bestPattern || compiled.weight > entry.bestPattern.weight) {
          entry.bestPattern = compiled;
        }
      }
    }

    // Find the intent with the highest accumulated weight
    let bestIntent: IntentLabel = 'conversation';
    let bestScore = 0;
    let bestPattern: CompiledPattern | null = null;

    for (const intent of ['conversation', 'quick_action', 'build'] as IntentLabel[]) {
      const entry = intentScores[intent];
      if (entry.totalWeight > bestScore) {
        bestScore = entry.totalWeight;
        bestIntent = intent;
        bestPattern = entry.bestPattern;
      }
    }

    if (!bestPattern || bestScore === 0) {
      return { ...NO_MATCH };
    }

    // Normalize confidence to [0, 1] range.
    // A single high-weight match (0.85+) should yield confidence >= 0.85.
    // Multiple lower-weight matches accumulate.
    // Normalization factor: 1.0 means a single match with weight 1.0 = confidence 1.0
    const confidence = Math.min(1.0, bestScore);

    return {
      intent: bestIntent,
      confidence,
      pattern: bestPattern.id,
      source: bestPattern.source,
    };
  }

  /**
   * Hot-reload patterns from the JSON file without application restart.
   * Called by the LearningLoop when new patterns are added, or periodically.
   *
   * Requirements: 12.5
   */
  reloadPatterns(): void {
    this.loadPatterns();
  }

  /**
   * Get the total number of loaded patterns (builtin + learned).
   */
  getPatternCount(): number {
    return this.compiledPatterns.length;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /**
   * Load and compile patterns from the JSON configuration file.
   * Falls back to an empty pattern set if the file is unavailable.
   */
  private loadPatterns(): void {
    try {
      const stat = fs.statSync(this.patternsPath);
      const mtime = stat.mtimeMs;

      // Skip reload if file hasn't changed (mtime-based caching)
      if (this.compiledPatterns.length > 0 && mtime === this.lastMtime) {
        return;
      }

      const raw = fs.readFileSync(this.patternsPath, 'utf-8');
      const config: PatternsConfig = JSON.parse(raw);

      const compiled: CompiledPattern[] = [];

      // Compile builtin patterns
      for (const entry of config.builtin) {
        const regex = this.safeCompileRegex(entry.pattern, entry.flags);
        if (regex) {
          compiled.push({
            id: entry.id,
            intent: entry.intent as IntentLabel,
            regex,
            weight: entry.weight,
            source: 'builtin',
          });
        }
      }

      // Compile learned patterns
      for (const entry of config.learned) {
        const regex = this.safeCompileRegex(entry.pattern, entry.flags);
        if (regex) {
          compiled.push({
            id: entry.id,
            intent: entry.intent as IntentLabel,
            regex,
            weight: Math.min(entry.weight, 0.6), // Cap learned weights at 0.6
            source: 'learned',
          });
        }
      }

      this.compiledPatterns = compiled;
      this.lastMtime = mtime;
    } catch {
      // If file is missing or malformed, keep existing patterns (or empty set on first load)
      if (this.compiledPatterns.length === 0) {
        this.compiledPatterns = [];
      }
    }
  }

  /**
   * Safely compile a regex pattern, returning null if the pattern is invalid.
   * This prevents a single malformed pattern from breaking the entire classifier.
   */
  private safeCompileRegex(pattern: string, flags: string): RegExp | null {
    try {
      return new RegExp(pattern, flags);
    } catch {
      return null;
    }
  }
}

/**
 * Factory function to create a PatternClassifier instance.
 * Accepts an optional custom path for the patterns JSON file (useful for testing).
 */
export function createPatternClassifier(patternsPath?: string): IPatternClassifier {
  return new PatternClassifierImpl(patternsPath);
}
