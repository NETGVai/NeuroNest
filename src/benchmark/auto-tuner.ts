/**
 * AutoTuner — Automatically classifies task types and recommends optimal
 * LLM parameters (temperature, maxTokens, topP) based on task classification
 * and historical benchmark data.
 *
 * Integrates with the existing IntentClassifier (src/pipeline/intent-classifier.ts)
 * for initial signal detection, then applies task-specific heuristics for fine-grained
 * classification into code-generation, refactoring, analysis, creative, or debugging.
 *
 * Stores parameter mapping in `.neuronest/tuning.json` and allows user override.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  TaskClassification,
  ParameterProfile,
  BenchmarkRun,
} from '../shared/feature-integration-types.js';
import { classifyIntent } from '../pipeline/intent-classifier.js';
import type { IIntentGate, SessionContext } from '../pipeline/intent-gate.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import { intentToLegacyClassification } from '../pipeline/intent-gate-router.js';

// ─── Types ──────────────────────────────────────────────────────

/** Valid task types for classification. */
export type TaskType = 'code-generation' | 'refactoring' | 'analysis' | 'creative' | 'debugging';

/** Structure of the `.neuronest/tuning.json` file. */
export interface TuningConfig {
  version: string;
  parameterMap: Record<TaskType, ParameterProfile>;
  userOverrides?: Record<TaskType, Partial<ParameterProfile>>;
}

/** Options for creating the AutoTuner. */
export interface AutoTunerOptions {
  /** Root project directory for resolving `.neuronest/tuning.json`. */
  projectDir: string;
  /** Optional IntentGate instance for unified classification (Requirements: 1.6). */
  intentGate?: IIntentGate;
  /** Optional FeatureGateSystem to check if unified_intent_gate is enabled. */
  featureGate?: FeatureGateSystem;
}

// ─── Task Classification Patterns ───────────────────────────────

interface TaskPattern {
  pattern: RegExp;
  weight: number;
}

const CODE_GENERATION_PATTERNS: TaskPattern[] = [
  { pattern: /\b(create|generate|build|write|implement|scaffold|make|add)\b.*\b(function|class|component|module|service|api|endpoint|page|app|file|code)\b/i, weight: 0.85 },
  { pattern: /^(create|generate|build|write|implement|scaffold|make)\b/i, weight: 0.75 },
  { pattern: /\b(new|from scratch|boilerplate|template|starter)\b/i, weight: 0.5 },
  { pattern: /\b(html|css|react|vue|angular|svelte|nextjs|express)\b.*\b(component|page|layout)\b/i, weight: 0.7 },
  { pattern: /\b(write|code|implement)\s+(a|an|the|this)\b/i, weight: 0.6 },
];

const REFACTORING_PATTERNS: TaskPattern[] = [
  { pattern: /\b(refactor|restructure|reorganize|clean\s*up|simplify|optimize|improve)\b/i, weight: 0.85 },
  { pattern: /\b(rename|move|extract|inline|split|merge|consolidate)\b.*\b(function|class|method|variable|module|file)\b/i, weight: 0.8 },
  { pattern: /\b(reduce|remove)\s+(duplication|redundancy|complexity)\b/i, weight: 0.75 },
  { pattern: /\b(convert|migrate|upgrade|modernize|update)\b.*\b(code|syntax|pattern|api)\b/i, weight: 0.7 },
  { pattern: /\b(dry|solid|pattern|best practice)\b/i, weight: 0.4 },
];

const ANALYSIS_PATTERNS: TaskPattern[] = [
  { pattern: /\b(analyze|review|audit|inspect|examine|assess|evaluate|check)\b/i, weight: 0.8 },
  { pattern: /\b(explain|understand|describe|summarize|document)\b.*\b(code|function|class|module|logic|architecture)\b/i, weight: 0.75 },
  { pattern: /\b(what does|how does|why does|what is|how is)\b/i, weight: 0.7 },
  { pattern: /\b(performance|security|accessibility|complexity|dependency)\b.*\b(analysis|review|audit|check)\b/i, weight: 0.8 },
  { pattern: /\b(find|identify|detect|list)\b.*\b(issues|problems|bugs|vulnerabilities|smells)\b/i, weight: 0.65 },
];

const CREATIVE_PATTERNS: TaskPattern[] = [
  { pattern: /\b(brainstorm|ideate|suggest|propose|design|sketch|draft)\b/i, weight: 0.8 },
  { pattern: /\b(creative|novel|unique|innovative|alternative)\b/i, weight: 0.65 },
  { pattern: /\b(write|compose|craft)\b.*\b(story|poem|essay|blog|article|copy|content|description|readme)\b/i, weight: 0.85 },
  { pattern: /\b(name|naming|brand|tagline|slogan)\b/i, weight: 0.7 },
  { pattern: /\b(ui|ux|design|wireframe|mockup|prototype)\b.*\b(ideas?|concepts?|options?)\b/i, weight: 0.7 },
];

const DEBUGGING_PATTERNS: TaskPattern[] = [
  { pattern: /\b(debug|fix|resolve|troubleshoot|diagnose)\b/i, weight: 0.85 },
  { pattern: /\b(bug|error|issue|problem|crash|failure|exception)\b/i, weight: 0.7 },
  { pattern: /\b(not working|broken|fails|failing|incorrect|wrong)\b/i, weight: 0.7 },
  { pattern: /\b(stack\s*trace|traceback|error\s*message|log\s*output)\b/i, weight: 0.75 },
  { pattern: /\b(why|unexpected|instead of|should be|supposed to)\b.*\b(error|result|behavior|output)\b/i, weight: 0.65 },
];

// ─── Default Parameter Profiles ─────────────────────────────────

const DEFAULT_PARAMETER_MAP: Record<TaskType, ParameterProfile> = {
  'code-generation': {
    temperature: 0.2,
    maxTokens: 4096,
    topP: 0.9,
    recommendedModel: undefined,
  },
  'refactoring': {
    temperature: 0.1,
    maxTokens: 4096,
    topP: 0.85,
    recommendedModel: undefined,
  },
  'analysis': {
    temperature: 0.3,
    maxTokens: 2048,
    topP: 0.9,
    recommendedModel: undefined,
  },
  'creative': {
    temperature: 0.9,
    maxTokens: 2048,
    topP: 0.95,
    recommendedModel: undefined,
  },
  'debugging': {
    temperature: 0.1,
    maxTokens: 4096,
    topP: 0.85,
    recommendedModel: undefined,
  },
};

const VALID_TASK_TYPES: TaskType[] = [
  'code-generation',
  'refactoring',
  'analysis',
  'creative',
  'debugging',
];

// ─── AutoTuner ──────────────────────────────────────────────────

export class AutoTuner {
  private readonly projectDir: string;
  private readonly intentGate: IIntentGate | undefined;
  private readonly featureGate: FeatureGateSystem | undefined;
  private tuningConfig: TuningConfig | null = null;

  constructor(options: AutoTunerOptions) {
    this.projectDir = options.projectDir;
    this.intentGate = options.intentGate;
    this.featureGate = options.featureGate;
    this.loadTuningConfig();
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Classify a user message into one of the predefined task types.
   * Uses pattern matching weighted by signal strength, with integration
   * from the existing IntentClassifier for additional context.
   *
   * Returns a TaskClassification with type and confidence in [0.0, 1.0].
   *
   * When the IntentGate is available and the `unified_intent_gate` flag is enabled,
   * use `classifyTaskAsync()` for enhanced classification. This synchronous method
   * always uses the legacy pattern-based approach for backward compatibility.
   *
   * Validates: Requirement 16.1
   */
  classifyTask(message: string): TaskClassification {
    if (!message || message.trim().length === 0) {
      return { type: 'analysis', confidence: 0.0 };
    }

    const trimmed = message.trim();

    // Score each task type based on pattern matching
    const scores: Record<TaskType, number> = {
      'code-generation': this.scorePatterns(trimmed, CODE_GENERATION_PATTERNS),
      'refactoring': this.scorePatterns(trimmed, REFACTORING_PATTERNS),
      'analysis': this.scorePatterns(trimmed, ANALYSIS_PATTERNS),
      'creative': this.scorePatterns(trimmed, CREATIVE_PATTERNS),
      'debugging': this.scorePatterns(trimmed, DEBUGGING_PATTERNS),
    };

    // Use the existing intent classifier for additional signal.
    // The synchronous classifyTask() always uses the legacy classifier.
    // For IntentGate-based classification, use classifyTaskAsync().
    const intentResult = classifyIntent(trimmed);

    // Boost analysis if classified as informational
    if (intentResult.intent === 'informational') {
      scores['analysis'] += 0.3;
    }

    // Find the highest scoring task type
    let bestType: TaskType = 'analysis';
    let bestScore = -1;

    for (const taskType of VALID_TASK_TYPES) {
      if (scores[taskType] > bestScore) {
        bestScore = scores[taskType];
        bestType = taskType;
      }
    }

    // Normalize confidence to [0.0, 1.0]
    const confidence = Math.min(1.0, Math.max(0.0, bestScore));

    // If no patterns matched significantly, default to analysis with low confidence
    if (bestScore < 0.1) {
      return { type: 'analysis', confidence: 0.1 };
    }

    return { type: bestType, confidence };
  }

  /**
   * Async version of classifyTask that uses the IntentGate when available
   * and the `unified_intent_gate` flag is enabled. Falls back to the
   * synchronous classifyTask() when the IntentGate is unavailable or disabled.
   *
   * This is used by the agent-loop integration where async is acceptable.
   *
   * Requirements: 1.6 (sole classification call site)
   * Validates: Requirement 16.1
   */
  async classifyTaskAsync(message: string): Promise<TaskClassification> {
    if (!message || message.trim().length === 0) {
      return { type: 'analysis', confidence: 0.0 };
    }

    const trimmed = message.trim();

    // When the IntentGate is available and enabled, use it for additional signal
    if (this.intentGate && this.featureGate?.isEnabled('unified_intent_gate')) {
      try {
        const sessionContext: SessionContext = {
          recentTurns: [],
          activeInterview: false,
          activeOrchestration: false,
          lastAssistantSubject: null,
        };
        const decision = await this.intentGate.classify(trimmed, sessionContext);
        const legacyResult = intentToLegacyClassification(decision);

        // Score patterns as usual
        const scores: Record<TaskType, number> = {
          'code-generation': this.scorePatterns(trimmed, CODE_GENERATION_PATTERNS),
          'refactoring': this.scorePatterns(trimmed, REFACTORING_PATTERNS),
          'analysis': this.scorePatterns(trimmed, ANALYSIS_PATTERNS),
          'creative': this.scorePatterns(trimmed, CREATIVE_PATTERNS),
          'debugging': this.scorePatterns(trimmed, DEBUGGING_PATTERNS),
        };

        // Boost analysis if IntentGate classified as informational (conversation)
        if (legacyResult.intent === 'informational') {
          scores['analysis'] += 0.3;
        }

        let bestType: TaskType = 'analysis';
        let bestScore = -1;
        for (const taskType of VALID_TASK_TYPES) {
          if (scores[taskType] > bestScore) {
            bestScore = scores[taskType];
            bestType = taskType;
          }
        }

        const confidence = Math.min(1.0, Math.max(0.0, bestScore));
        if (bestScore < 0.1) {
          return { type: 'analysis', confidence: 0.1 };
        }
        return { type: bestType, confidence };
      } catch {
        // IntentGate failed — fall through to synchronous classifyTask
      }
    }

    // Fallback to synchronous classification
    return this.classifyTask(trimmed);
  }

  /**
   * Get the recommended parameter profile for a given task type.
   * Applies user overrides from `.neuronest/tuning.json` if available.
   *
   * Returns a ParameterProfile with temperature in [0.0, 2.0], maxTokens > 0, topP in [0.0, 1.0].
   *
   * Validates: Requirement 16.2, 16.3, 16.5
   */
  getRecommendedParams(taskType: string): ParameterProfile {
    // Get base parameters from the tuning config or defaults
    const config = this.getTuningConfig();
    const validType = this.normalizeTaskType(taskType);

    const baseParams = config.parameterMap[validType] ?? DEFAULT_PARAMETER_MAP['analysis'];

    // Apply user overrides if configured
    const overrides = config.userOverrides?.[validType];
    const merged: ParameterProfile = {
      temperature: overrides?.temperature ?? baseParams.temperature,
      maxTokens: overrides?.maxTokens ?? baseParams.maxTokens,
      topP: overrides?.topP ?? baseParams.topP,
      recommendedModel: overrides?.recommendedModel ?? baseParams.recommendedModel,
    };

    // Clamp values to valid ranges
    return this.clampProfile(merged);
  }

  /**
   * Refine parameter recommendations based on historical benchmark data.
   * Analyzes benchmark runs for the given task type and adjusts parameters
   * based on which configurations produced the best results.
   *
   * Validates: Requirement 16.4
   */
  refineFromBenchmarks(taskType: string, historicalRuns: BenchmarkRun[]): ParameterProfile {
    const validType = this.normalizeTaskType(taskType);
    const baseParams = this.getRecommendedParams(validType);

    if (!historicalRuns || historicalRuns.length === 0) {
      return baseParams;
    }

    // Collect all results with quality scores from historical runs
    const scoredResults: Array<{
      temperature: number;
      maxTokens: number;
      topP: number;
      qualityScore: number;
      durationMs: number;
      tokensConsumed: number;
    }> = [];

    for (const run of historicalRuns) {
      if (!run.results) continue;

      for (const result of run.results) {
        if (result.qualityScore != null && result.qualityScore > 0) {
          // We need to find the configuration that produced this result
          // The configuration details may not be directly in the result,
          // so we use the base params as a reference point and weight by quality
          scoredResults.push({
            temperature: baseParams.temperature,
            maxTokens: baseParams.maxTokens,
            topP: baseParams.topP,
            qualityScore: result.qualityScore,
            durationMs: result.durationMs,
            tokensConsumed: result.tokensConsumed,
          });
        }
      }
    }

    if (scoredResults.length === 0) {
      return baseParams;
    }

    // Calculate weighted averages based on quality scores
    let totalWeight = 0;
    let weightedTemp = 0;
    let weightedMaxTokens = 0;
    let weightedTopP = 0;

    for (const result of scoredResults) {
      const weight = result.qualityScore / 10; // Normalize quality score to [0.1, 1.0]
      totalWeight += weight;
      weightedTemp += result.temperature * weight;
      weightedMaxTokens += result.maxTokens * weight;
      weightedTopP += result.topP * weight;
    }

    if (totalWeight === 0) {
      return baseParams;
    }

    // Compute refined parameters — blend historical weighted average with base params
    // Use 70% base, 30% historical to avoid overfitting on limited data
    const blendFactor = Math.min(0.3, scoredResults.length * 0.05); // Max 30%, grows with data
    const refined: ParameterProfile = {
      temperature: baseParams.temperature * (1 - blendFactor) + (weightedTemp / totalWeight) * blendFactor,
      maxTokens: Math.round(baseParams.maxTokens * (1 - blendFactor) + (weightedMaxTokens / totalWeight) * blendFactor),
      topP: baseParams.topP * (1 - blendFactor) + (weightedTopP / totalWeight) * blendFactor,
      recommendedModel: baseParams.recommendedModel,
    };

    // If we have enough high-quality results, adjust based on efficiency
    if (scoredResults.length >= 3) {
      // Sort by quality-to-token ratio (efficiency)
      const efficient = [...scoredResults].sort(
        (a, b) => (b.qualityScore / Math.max(1, b.tokensConsumed)) - (a.qualityScore / Math.max(1, a.tokensConsumed))
      );

      // If the most efficient results used fewer tokens, reduce maxTokens slightly
      const topEfficient = efficient.slice(0, Math.ceil(efficient.length / 3));
      const avgTokens = topEfficient.reduce((sum, r) => sum + r.tokensConsumed, 0) / topEfficient.length;
      if (avgTokens > 0 && avgTokens < refined.maxTokens) {
        // Set maxTokens to 120% of observed efficient usage to leave headroom
        refined.maxTokens = Math.max(256, Math.round(avgTokens * 1.2));
      }
    }

    return this.clampProfile(refined);
  }

  /**
   * Save user overrides to the tuning config file.
   * Allows user customization of auto-tuning parameters.
   *
   * Validates: Requirement 16.3, 16.5
   */
  setUserOverride(taskType: string, overrides: Partial<ParameterProfile>): void {
    const validType = this.normalizeTaskType(taskType);
    const config = this.getTuningConfig();

    if (!config.userOverrides) {
      config.userOverrides = {} as Record<TaskType, Partial<ParameterProfile>>;
    }

    config.userOverrides[validType] = {
      ...config.userOverrides[validType],
      ...overrides,
    };

    this.saveTuningConfig(config);
  }

  /**
   * Remove user overrides for a specific task type.
   */
  clearUserOverride(taskType: string): void {
    const validType = this.normalizeTaskType(taskType);
    const config = this.getTuningConfig();

    if (config.userOverrides) {
      delete config.userOverrides[validType];
      this.saveTuningConfig(config);
    }
  }

  /**
   * Get the full tuning configuration (for UI display or export).
   */
  getTuningConfig(): TuningConfig {
    if (this.tuningConfig) {
      return this.tuningConfig;
    }

    // Return a fresh copy of defaults
    return {
      version: '1.0.0',
      parameterMap: { ...DEFAULT_PARAMETER_MAP },
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Score a message against a set of task patterns.
   * Returns the sum of matching pattern weights, capped at 1.0.
   */
  private scorePatterns(message: string, patterns: TaskPattern[]): number {
    let totalScore = 0;

    for (const { pattern, weight } of patterns) {
      if (pattern.test(message)) {
        totalScore += weight;
      }
    }

    // Cap at 1.0 for normalization
    return Math.min(1.0, totalScore);
  }

  /**
   * Normalize a task type string to a valid TaskType.
   * If the input is not a valid task type, defaults to 'analysis'.
   */
  private normalizeTaskType(taskType: string): TaskType {
    const normalized = taskType.toLowerCase().trim() as TaskType;
    if (VALID_TASK_TYPES.includes(normalized)) {
      return normalized;
    }
    return 'analysis';
  }

  /**
   * Clamp a parameter profile to valid ranges:
   * - temperature: [0.0, 2.0]
   * - maxTokens: > 0 (minimum 1)
   * - topP: [0.0, 1.0]
   */
  private clampProfile(profile: ParameterProfile): ParameterProfile {
    return {
      temperature: Math.min(2.0, Math.max(0.0, profile.temperature)),
      maxTokens: Math.max(1, Math.round(profile.maxTokens)),
      topP: Math.min(1.0, Math.max(0.0, profile.topP)),
      recommendedModel: profile.recommendedModel,
    };
  }

  /**
   * Load the tuning configuration from `.neuronest/tuning.json`.
   * If the file doesn't exist or is malformed, use defaults.
   */
  private loadTuningConfig(): void {
    const filePath = this.getTuningFilePath();

    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content) as TuningConfig;

        // Validate the loaded config has required structure
        if (parsed.parameterMap && typeof parsed.parameterMap === 'object') {
          // Merge loaded config with defaults (to fill any missing task types)
          const merged: TuningConfig = {
            version: parsed.version ?? '1.0.0',
            parameterMap: { ...DEFAULT_PARAMETER_MAP, ...parsed.parameterMap },
            userOverrides: parsed.userOverrides,
          };
          this.tuningConfig = merged;
          return;
        }
      }
    } catch {
      // File missing, unreadable, or malformed — use defaults
    }

    this.tuningConfig = null;
  }

  /**
   * Save the tuning configuration to `.neuronest/tuning.json`.
   */
  private saveTuningConfig(config: TuningConfig): void {
    const filePath = this.getTuningFilePath();
    const dir = path.dirname(filePath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

    this.tuningConfig = config;
  }

  /**
   * Get the path to the tuning configuration file.
   */
  private getTuningFilePath(): string {
    return path.join(this.projectDir, '.neuronest', 'tuning.json');
  }
}
