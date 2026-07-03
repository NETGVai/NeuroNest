/**
 * SpecSynthesizer — Synthesizes a structured spec from completed interview state.
 *
 * Takes an InterviewState (with answered turns) and produces a SynthesizedSpec
 * containing: overview, acceptance criteria, implementation plan, files to change,
 * testing strategy, suggested execution mode, and cost estimate.
 *
 * Uses the tier-router's 'fast' tier to generate spec content from the original
 * message and interview Q&A.
 *
 * Requirements: 10.1
 */

import crypto from 'node:crypto';
import type {
  InterviewState,
  SynthesizedSpec,
  AcceptanceCriterion,
  ImplementationStep,
  ExecutionMode,
  CostEstimate,
  SpecSynthesisProvider,
} from './spec-interview-engine.js';
import type { ComplexityTier } from './intent-gate.js';

// ─── Cost Estimation Constants ──────────────────────────────────────────────

/** Estimated token costs per complexity tier */
const COST_ESTIMATES: Record<ComplexityTier, { tokens: number; estimatedCostUsd: number }> = {
  trivial: { tokens: 2_000, estimatedCostUsd: 0.01 },
  medium: { tokens: 15_000, estimatedCostUsd: 0.08 },
  complex: { tokens: 60_000, estimatedCostUsd: 0.30 },
};

/** Maps complexity tier to suggested execution mode */
const COMPLEXITY_TO_MODE: Record<ComplexityTier, ExecutionMode> = {
  trivial: 'flash',
  medium: 'standard',
  complex: 'pro',
};

// ─── LLM Provider Interface ─────────────────────────────────────────────────

/**
 * Minimal interface for making LLM calls via the tier-router.
 * Callers provide the 'fast' tier client.
 */
export interface LLMSynthesisProvider {
  generateCompletion(prompt: string): Promise<string>;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface SpecValidationError {
  field: string;
  message: string;
}

/**
 * Validates that a synthesized spec meets structural requirements.
 * Requirement 10.1: spec must have non-empty overview, ≥1 acceptance criterion,
 * and a non-empty implementation plan.
 */
export function validateSynthesizedSpec(spec: SynthesizedSpec): SpecValidationError[] {
  const errors: SpecValidationError[] = [];

  if (!spec.overview || spec.overview.trim().length === 0) {
    errors.push({ field: 'overview', message: 'Overview must be non-empty' });
  }

  if (!spec.acceptanceCriteria || spec.acceptanceCriteria.length === 0) {
    errors.push({ field: 'acceptanceCriteria', message: 'At least one acceptance criterion is required' });
  }

  if (!spec.implementationPlan || spec.implementationPlan.length === 0) {
    errors.push({ field: 'implementationPlan', message: 'Implementation plan must be non-empty' });
  }

  if (!spec.title || spec.title.trim().length === 0) {
    errors.push({ field: 'title', message: 'Title must be non-empty' });
  }

  return errors;
}

// ─── Prompt Building ────────────────────────────────────────────────────────

/**
 * Builds the LLM prompt for spec synthesis from interview state.
 */
export function buildSynthesisPrompt(state: InterviewState): string {
  const lines: string[] = [
    'You are a spec synthesis engine. Given a user request and optional interview Q&A, produce a structured JSON spec.',
    '',
    '## User Request',
    state.originalMessage,
    '',
  ];

  // Add interview Q&A if present
  const answeredTurns = state.turns.filter(t => t.answer !== null);
  if (answeredTurns.length > 0) {
    lines.push('## Interview Q&A');
    for (const turn of answeredTurns) {
      lines.push(`Q${turn.questionIndex + 1}: ${turn.question}`);
      lines.push(`A${turn.questionIndex + 1}: ${turn.answer}`);
      lines.push('');
    }
  }

  lines.push(`## Complexity: ${state.complexity}`);
  lines.push('');
  lines.push('## Output Format');
  lines.push('Respond with valid JSON matching this structure:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "title": "short descriptive title",');
  lines.push('  "overview": "comprehensive overview of what will be built",');
  lines.push('  "acceptanceCriteria": [{"id": "AC-1", "description": "...", "verifiable": true}],');
  lines.push('  "implementationPlan": [{"order": 1, "description": "...", "files": ["src/..."]}],');
  lines.push('  "filesToChange": ["src/..."],');
  lines.push('  "testingStrategy": "description of testing approach"');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Title should be concise (under 80 chars)');
  lines.push('- Overview should explain the goal and approach');
  lines.push('- Each acceptance criterion must be verifiable');
  lines.push('- Implementation steps should be ordered logically');
  lines.push('- Files to change should be specific paths');
  lines.push('- Testing strategy should describe what to test and how');

  return lines.join('\n');
}

// ─── LLM Response Parsing ───────────────────────────────────────────────────

interface ParsedLLMResponse {
  title: string;
  overview: string;
  acceptanceCriteria: AcceptanceCriterion[];
  implementationPlan: ImplementationStep[];
  filesToChange: string[];
  testingStrategy: string;
}

/**
 * Parses LLM response JSON into structured spec fields.
 * Falls back to defaults on parse failure.
 */
export function parseLLMResponse(response: string): ParsedLLMResponse | null {
  try {
    // Extract JSON from possible markdown code block
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

    const parsed = JSON.parse(jsonStr);

    // Validate and normalize acceptance criteria
    const criteria: AcceptanceCriterion[] = Array.isArray(parsed.acceptanceCriteria)
      ? parsed.acceptanceCriteria.map((ac: any, idx: number) => ({
          id: ac.id || `AC-${idx + 1}`,
          description: String(ac.description || ''),
          verifiable: ac.verifiable !== false,
        }))
      : [];

    // Validate and normalize implementation plan
    const plan: ImplementationStep[] = Array.isArray(parsed.implementationPlan)
      ? parsed.implementationPlan.map((step: any, idx: number) => ({
          order: step.order ?? idx + 1,
          description: String(step.description || ''),
          files: Array.isArray(step.files) ? step.files.map(String) : [],
        }))
      : [];

    // Normalize filesToChange
    const filesToChange: string[] = Array.isArray(parsed.filesToChange)
      ? parsed.filesToChange.map(String)
      : [];

    return {
      title: String(parsed.title || ''),
      overview: String(parsed.overview || ''),
      acceptanceCriteria: criteria,
      implementationPlan: plan,
      filesToChange,
      testingStrategy: String(parsed.testingStrategy || ''),
    };
  } catch {
    return null;
  }
}

// ─── Default Spec Generation ────────────────────────────────────────────────

/**
 * Generates a default spec when LLM synthesis fails or is unavailable.
 * Uses the interview state to produce a minimal but valid spec.
 */
export function generateDefaultSpec(state: InterviewState): ParsedLLMResponse {
  // Extract a title from the first ~60 chars of the original message
  const rawTitle = state.originalMessage.slice(0, 60).trim();
  const title = rawTitle.length < state.originalMessage.length
    ? rawTitle + '…'
    : rawTitle;

  // Build overview from the message + any Q&A
  let overview = state.originalMessage;
  const answeredTurns = state.turns.filter(t => t.answer !== null);
  if (answeredTurns.length > 0) {
    overview += '\n\nClarifications:\n';
    for (const turn of answeredTurns) {
      overview += `- ${turn.question}: ${turn.answer}\n`;
    }
  }

  // Default acceptance criterion
  const acceptanceCriteria: AcceptanceCriterion[] = [
    {
      id: 'AC-1',
      description: `Implementation matches the request: "${state.originalMessage.slice(0, 100)}"`,
      verifiable: true,
    },
  ];

  // Default implementation step
  const implementationPlan: ImplementationStep[] = [
    {
      order: 1,
      description: 'Implement the requested changes',
      files: [],
    },
  ];

  return {
    title,
    overview,
    acceptanceCriteria,
    implementationPlan,
    filesToChange: [],
    testingStrategy: 'Verify implementation matches acceptance criteria with unit tests',
  };
}

// ─── Cost Estimation ────────────────────────────────────────────────────────

/**
 * Estimates token cost based on complexity tier.
 */
export function estimateCost(complexity: ComplexityTier): CostEstimate {
  const estimate = COST_ESTIMATES[complexity];
  return {
    tokens: estimate.tokens,
    estimatedCostUsd: estimate.estimatedCostUsd,
    tier: complexity,
  };
}

/**
 * Maps complexity tier to suggested execution mode.
 */
export function suggestExecutionMode(complexity: ComplexityTier): ExecutionMode {
  return COMPLEXITY_TO_MODE[complexity];
}

// ─── SpecSynthesizer Implementation ─────────────────────────────────────────

export class SpecSynthesizer implements SpecSynthesisProvider {
  private readonly llmProvider: LLMSynthesisProvider | null;

  /**
   * Create a SpecSynthesizer.
   * @param llmProvider Optional LLM provider for generating spec content.
   *   When null, the synthesizer uses default spec generation from interview state.
   */
  constructor(llmProvider: LLMSynthesisProvider | null = null) {
    this.llmProvider = llmProvider;
  }

  /**
   * Synthesize a structured spec from completed (or partially completed) interview state.
   *
   * Flow:
   * 1. Build prompt from interview state
   * 2. Call LLM (if provider available)
   * 3. Parse response (or use defaults on failure)
   * 4. Assemble SynthesizedSpec with cost estimate and suggested mode
   * 5. Validate structural requirements
   *
   * Requirement 10.1: Synthesized spec must contain overview, acceptance criteria,
   * implementation plan, files to change, and testing strategy.
   */
  async synthesize(state: InterviewState): Promise<SynthesizedSpec> {
    let specFields: ParsedLLMResponse;

    if (this.llmProvider) {
      const prompt = buildSynthesisPrompt(state);
      try {
        const response = await this.llmProvider.generateCompletion(prompt);
        const parsed = parseLLMResponse(response);
        specFields = parsed ?? generateDefaultSpec(state);
      } catch {
        // LLM call failed — fall back to defaults
        specFields = generateDefaultSpec(state);
      }
    } else {
      // No LLM provider — use defaults
      specFields = generateDefaultSpec(state);
    }

    // Ensure the spec is valid by falling back to defaults for missing fields
    if (!specFields.overview || specFields.overview.trim().length === 0) {
      specFields.overview = state.originalMessage;
    }
    if (!specFields.title || specFields.title.trim().length === 0) {
      specFields.title = state.originalMessage.slice(0, 60).trim() || 'Untitled Spec';
    }
    if (specFields.acceptanceCriteria.length === 0) {
      specFields.acceptanceCriteria = generateDefaultSpec(state).acceptanceCriteria;
    }
    if (specFields.implementationPlan.length === 0) {
      specFields.implementationPlan = generateDefaultSpec(state).implementationPlan;
    }

    const spec: SynthesizedSpec = {
      id: crypto.randomUUID(),
      title: specFields.title,
      overview: specFields.overview,
      acceptanceCriteria: specFields.acceptanceCriteria,
      implementationPlan: specFields.implementationPlan,
      filesToChange: specFields.filesToChange,
      testingStrategy: specFields.testingStrategy,
      suggestedMode: suggestExecutionMode(state.complexity),
      costEstimate: estimateCost(state.complexity),
      status: 'draft',
      createdAt: Date.now(),
    };

    return spec;
  }
}
