/**
 * LearningLoop — Override-based learning for the Intent Gate.
 *
 * Records every user override (original classification, corrected intent,
 * message text, timestamp) to the `intent_decisions` telemetry table.
 * When the same correction pattern occurs ≥3 times, generates a new pattern
 * entry in `informational-patterns.json` under the 'learned' array.
 *
 * Key constraints:
 * - Learned pattern weights are capped at 0.6 (prevents overfit)
 * - Per-project patterns stored in ProjectMemoryStore
 * - PatternClassifier picks up learned patterns via hot-reload (no restart)
 * - Gated behind `learning_loop` feature flag
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IntentLabel, PatternClassifier } from '../intent-gate.js';
import type { FeatureGateSystem } from '../../feature-gate/feature-gate-system.js';
import type { PatternsConfig, PatternEntry } from './pattern-classifier.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OverrideRecord {
  messageHash: string;
  originalIntent: IntentLabel;
  correctedIntent: IntentLabel;
  messageText: string;
  normalizedTokens: string[];
  timestamp: number;
  projectId: string;
}

export interface GeneratedPattern {
  regex: string;
  intent: IntentLabel;
  weight: number; // capped at 0.6
  source: 'learned';
}

export interface LearningLoopInterface {
  recordOverride(record: OverrideRecord): void;
  checkForNewPatterns(): GeneratedPattern[];
  getOverrideCount(normalizedPattern: string): number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum number of identical correction patterns required to generate a new pattern */
const PATTERN_GENERATION_THRESHOLD = 3;

/** Maximum weight for learned patterns (prevents overfit) */
const MAX_LEARNED_WEIGHT = 0.6;

/** Default path to the informational-patterns.json file */
const DEFAULT_PATTERNS_PATH = path.resolve(__dirname, 'informational-patterns.json');

// ─── Project Memory Interface (subset used by LearningLoop) ─────────────────

export interface ProjectMemoryStoreInterface {
  learn(projectId: string, category: string, content: string, source?: string): unknown;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export class LearningLoopImpl implements LearningLoopInterface {
  /** In-memory store of override records, grouped by normalized token key */
  private overridesByPattern: Map<string, OverrideRecord[]> = new Map();

  /** Set of pattern keys that have already been generated (avoid duplicates within session) */
  private generatedPatternKeys: Set<string> = new Set();

  private readonly patternsPath: string;
  private readonly featureGate: FeatureGateSystem;
  private readonly patternClassifier: PatternClassifier;
  private readonly projectMemory: ProjectMemoryStoreInterface | null;

  constructor(options: {
    featureGate: FeatureGateSystem;
    patternClassifier: PatternClassifier;
    projectMemory?: ProjectMemoryStoreInterface | null;
    patternsPath?: string;
  }) {
    this.featureGate = options.featureGate;
    this.patternClassifier = options.patternClassifier;
    this.projectMemory = options.projectMemory ?? null;
    this.patternsPath = options.patternsPath ?? DEFAULT_PATTERNS_PATH;
  }

  /**
   * Record a user override. Normalizes the message text and stores the record
   * grouped by the normalized token pattern + corrected intent.
   *
   * If the feature gate `learning_loop` is disabled, this is a no-op.
   *
   * Requirements: 12.1
   */
  recordOverride(record: OverrideRecord): void {
    if (!this.featureGate.isEnabled('learning_loop')) {
      return;
    }

    const patternKey = this.buildPatternKey(record.normalizedTokens, record.correctedIntent);
    const existing = this.overridesByPattern.get(patternKey) ?? [];
    existing.push(record);
    this.overridesByPattern.set(patternKey, existing);

    // Store in project memory for per-project persistence
    if (this.projectMemory && record.projectId) {
      const memoryContent = `Intent override: "${record.messageText.slice(0, 100)}" corrected from ${record.originalIntent} to ${record.correctedIntent}`;
      try {
        this.projectMemory.learn(record.projectId, 'pattern', memoryContent, 'learning-loop');
      } catch {
        // Non-fatal: project memory storage failure should not block override recording
      }
    }
  }

  /**
   * Check all recorded overrides for patterns that have reached the generation
   * threshold (≥3 occurrences). For each qualifying pattern, generate a new
   * regex pattern entry and add it to informational-patterns.json.
   *
   * Returns the array of newly generated patterns.
   *
   * Requirements: 12.2, 12.3, 12.5
   */
  checkForNewPatterns(): GeneratedPattern[] {
    if (!this.featureGate.isEnabled('learning_loop')) {
      return [];
    }

    const newPatterns: GeneratedPattern[] = [];

    for (const [patternKey, records] of this.overridesByPattern.entries()) {
      // Only generate if threshold met and not already generated
      if (records.length < PATTERN_GENERATION_THRESHOLD) {
        continue;
      }

      if (this.generatedPatternKeys.has(patternKey)) {
        continue;
      }

      const generated = this.generatePattern(records);
      if (generated) {
        newPatterns.push(generated);
        this.generatedPatternKeys.add(patternKey);

        // Write to informational-patterns.json
        this.persistLearnedPattern(generated);

        // Store in project memory for all associated projects
        const projectIds = new Set(records.map(r => r.projectId));
        for (const projectId of projectIds) {
          if (this.projectMemory && projectId) {
            try {
              this.projectMemory.learn(
                projectId,
                'pattern',
                `Learned intent pattern: /${generated.regex}/ → ${generated.intent} (weight: ${generated.weight})`,
                'learning-loop',
              );
            } catch {
              // Non-fatal
            }
          }
        }
      }
    }

    // Trigger hot-reload if new patterns were generated
    if (newPatterns.length > 0) {
      this.patternClassifier.reloadPatterns();
    }

    return newPatterns;
  }

  /**
   * Get the number of override occurrences for a given normalized pattern key.
   *
   * The pattern key is the sorted, joined normalized tokens + corrected intent.
   */
  getOverrideCount(normalizedPattern: string): number {
    const records = this.overridesByPattern.get(normalizedPattern);
    return records?.length ?? 0;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Build a consistent key from normalized tokens and the corrected intent.
   * Tokens are sorted to make the key order-independent for similar messages.
   */
  private buildPatternKey(normalizedTokens: string[], correctedIntent: IntentLabel): string {
    const sortedTokens = [...normalizedTokens].sort().join('|');
    return `${sortedTokens}::${correctedIntent}`;
  }

  /**
   * Generate a regex pattern from a set of override records that share the
   * same correction pattern.
   *
   * Strategy:
   * 1. Find the common tokens across all message records
   * 2. Build a regex that matches messages containing those common tokens
   * 3. Cap the weight at MAX_LEARNED_WEIGHT (0.6)
   */
  private generatePattern(records: OverrideRecord[]): GeneratedPattern | null {
    if (records.length === 0) return null;

    // Extract common tokens across all records
    const tokenSets = records.map(r => new Set(r.normalizedTokens));
    const commonTokens = this.findCommonTokens(tokenSets);

    if (commonTokens.length === 0) return null;

    // Build a regex that matches messages containing the common tokens
    // Use word boundary matching for each common token
    const regexParts = commonTokens
      .filter(token => token.length >= 2) // Skip very short tokens
      .map(token => escapeRegex(token));

    if (regexParts.length === 0) return null;

    // Create a regex that requires all common tokens to be present
    // Uses lookahead assertions for order-independent matching
    let regex: string;
    if (regexParts.length === 1) {
      regex = `\\b${regexParts[0]}\\b`;
    } else {
      // For multiple tokens, use lookaheads for each token
      regex = regexParts.map(part => `(?=.*\\b${part}\\b)`).join('');
    }

    // Calculate weight based on occurrence count, capped at MAX_LEARNED_WEIGHT
    const rawWeight = Math.min(0.4 + (records.length - PATTERN_GENERATION_THRESHOLD) * 0.05, MAX_LEARNED_WEIGHT);
    const weight = Math.round(rawWeight * 100) / 100;

    return {
      regex,
      intent: records[0].correctedIntent,
      weight: Math.min(weight, MAX_LEARNED_WEIGHT),
      source: 'learned',
    };
  }

  /**
   * Find tokens that appear in all provided token sets.
   * Returns the intersection of all sets, sorted by token length descending
   * (longer tokens are more specific).
   */
  private findCommonTokens(tokenSets: Set<string>[]): string[] {
    if (tokenSets.length === 0) return [];

    let intersection = new Set(tokenSets[0]);
    for (let i = 1; i < tokenSets.length; i++) {
      const nextSet = tokenSets[i];
      intersection = new Set([...intersection].filter(token => nextSet.has(token)));
    }

    // Sort by length descending — longer tokens are more discriminative
    return [...intersection]
      .filter(token => token.length >= 2)
      .sort((a, b) => b.length - a.length)
      .slice(0, 5); // Limit to 5 most distinctive tokens
  }

  /**
   * Persist a newly generated pattern to the informational-patterns.json file
   * under the 'learned' array. Triggers hot-reload of the PatternClassifier.
   *
   * Requirements: 12.2, 12.3
   */
  private persistLearnedPattern(pattern: GeneratedPattern): void {
    try {
      const raw = fs.readFileSync(this.patternsPath, 'utf-8');
      const config: PatternsConfig = JSON.parse(raw);

      // Generate a unique ID for the learned pattern
      const id = `learned-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      const entry: PatternEntry = {
        id,
        intent: pattern.intent,
        pattern: pattern.regex,
        flags: 'i',
        weight: Math.min(pattern.weight, MAX_LEARNED_WEIGHT),
      };

      // Initialize learned array if it doesn't exist
      if (!Array.isArray(config.learned)) {
        config.learned = [];
      }

      config.learned.push(entry);

      // Write back atomically (write to temp, then rename)
      const tmpPath = this.patternsPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.patternsPath);
    } catch (err) {
      // Non-fatal: failure to persist should not crash the system
      console.warn('[LearningLoop] Failed to persist learned pattern:', err);
    }
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Normalize a user message into tokens for pattern comparison.
 * - Lowercases the message
 * - Removes punctuation
 * - Splits on whitespace
 * - Filters out stop words and very short tokens
 */
export function normalizeMessageToTokens(message: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
    'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'only', 'same', 'than',
    'too', 'very', 'just', 'it', 'its', 'this', 'that', 'these', 'those',
    'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him',
    'his', 'she', 'her', 'they', 'them', 'their',
  ]);

  return message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Remove punctuation
    .split(/\s+/)
    .filter(token => token.length >= 2 && !stopWords.has(token));
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Factory function to create a LearningLoop instance.
 */
export function createLearningLoop(options: {
  featureGate: FeatureGateSystem;
  patternClassifier: PatternClassifier;
  projectMemory?: ProjectMemoryStoreInterface | null;
  patternsPath?: string;
}): LearningLoopInterface {
  return new LearningLoopImpl(options);
}
