/**
 * Delegation Envelope & Result Envelope
 *
 * Minimal-context packages for context-scoped delegation in swarm execution.
 * DelegationEnvelopes are sent from the SwarmCoordinator to worker agents,
 * containing only the objective, constraints, relevant context, and budget.
 * Workers return compact ResultEnvelopes — full transcripts remain in the
 * event log only and never enter another agent's prompt.
 *
 * Gated behind the `context_scoped_delegation` feature flag.
 * GCF compression gated behind `gcf_expanded_handoffs` + `GCF_WIRE_FORMAT`.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { isGcfExpandedActive } from './gcf-gate.js';
import { encodeGeneric, GCF_PRIMER } from '../serializers/gcf-encoder.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ── MetricsSink ─────────────────────────────────────────────────

/**
 * Structural Metrics_Sink type — kept local so this module does not import
 * `SessionTelemetryService` directly. Any object exposing
 * `recordMetric(sessionId, key, value)` satisfies it.
 */
export interface MetricsSink {
  recordMetric(sessionId: string | null, key: string, value: number): void;
}

// ── Interfaces ──────────────────────────────────────────────────

/**
 * A minimal-context package sent from the SwarmCoordinator to worker agents.
 * Contains only what the worker needs to execute its objective — never full transcripts.
 */
export interface DelegationEnvelope {
  /** The task objective for the worker agent */
  objective: string;
  /** Constraints the worker must respect (e.g., style, budget, scope limits) */
  constraints: string[];
  /** File paths relevant to the objective */
  relevantFiles: string[];
  /** Decisions already made by prior phases that inform the worker's task */
  relevantDecisions: string[];
  /** Token budget cap for this delegation (default 2000) */
  tokenBudget: number;
}

/**
 * A compact outcome package returned from worker agents.
 * Contains only outcome summary, artifacts, decisions, and open issues.
 * Full transcripts stay in the event log for audit purposes only.
 */
export interface ResultEnvelope {
  /** Outcome status of the worker's execution */
  outcome: 'success' | 'partial' | 'failed' | 'stuck';
  /** File paths created or modified by the worker */
  artifacts: string[];
  /** Key decisions made by the worker during execution */
  decisions: string[];
  /** Unresolved issues the worker was unable to address */
  openIssues: string[];
  /** Token budget cap for this result (default 1000) */
  tokenBudget: number;
}

// ── Constants ───────────────────────────────────────────────────

/** Default token budget cap for DelegationEnvelopes (Requirement 21.1) */
export const DEFAULT_DELEGATION_TOKEN_BUDGET = 2000;

/** Default token budget cap for ResultEnvelopes (Requirement 21.2) */
export const DEFAULT_RESULT_TOKEN_BUDGET = 1000;

// ── Factory Functions ───────────────────────────────────────────

/**
 * Create a DelegationEnvelope with defaults applied.
 * Ensures the token budget does not exceed the 2000 cap.
 */
export function createDelegationEnvelope(params: {
  objective: string;
  constraints?: string[];
  relevantFiles?: string[];
  relevantDecisions?: string[];
  tokenBudget?: number;
}): DelegationEnvelope {
  return {
    objective: params.objective,
    constraints: params.constraints ?? [],
    relevantFiles: params.relevantFiles ?? [],
    relevantDecisions: params.relevantDecisions ?? [],
    tokenBudget: Math.min(params.tokenBudget ?? DEFAULT_DELEGATION_TOKEN_BUDGET, DEFAULT_DELEGATION_TOKEN_BUDGET),
  };
}

/**
 * Create a ResultEnvelope with defaults applied.
 * Ensures the token budget does not exceed the 1000 cap.
 */
export function createResultEnvelope(params: {
  outcome: ResultEnvelope['outcome'];
  artifacts?: string[];
  decisions?: string[];
  openIssues?: string[];
  tokenBudget?: number;
}): ResultEnvelope {
  return {
    outcome: params.outcome,
    artifacts: params.artifacts ?? [],
    decisions: params.decisions ?? [],
    openIssues: params.openIssues ?? [],
    tokenBudget: Math.min(params.tokenBudget ?? DEFAULT_RESULT_TOKEN_BUDGET, DEFAULT_RESULT_TOKEN_BUDGET),
  };
}

// ── Serialization ───────────────────────────────────────────────

/**
 * Estimate token count of a DelegationEnvelope.
 * Uses a conservative ~4 chars per token heuristic.
 */
export function estimateDelegationTokens(envelope: DelegationEnvelope): number {
  const text = [
    envelope.objective,
    ...envelope.constraints,
    ...envelope.relevantFiles,
    ...envelope.relevantDecisions,
  ].join(' ');
  return Math.ceil(text.length / 4);
}

/**
 * Estimate token count of a ResultEnvelope.
 * Uses a conservative ~4 chars per token heuristic.
 */
export function estimateResultTokens(envelope: ResultEnvelope): number {
  const text = [
    envelope.outcome,
    ...envelope.artifacts,
    ...envelope.decisions,
    ...envelope.openIssues,
  ].join(' ');
  return Math.ceil(text.length / 4);
}

/**
 * Serialize a DelegationEnvelope to plain-text markdown format.
 * Truncates content to stay within token budget.
 */
export function serializeDelegationEnvelopePlain(envelope: DelegationEnvelope): string {
  const budgetChars = envelope.tokenBudget * 4; // ~4 chars per token

  const parts: string[] = [
    `## Objective\n${envelope.objective}`,
  ];

  if (envelope.constraints.length > 0) {
    parts.push(`## Constraints\n${envelope.constraints.map(c => `- ${c}`).join('\n')}`);
  }

  if (envelope.relevantFiles.length > 0) {
    parts.push(`## Relevant Files\n${envelope.relevantFiles.map(f => `- ${f}`).join('\n')}`);
  }

  if (envelope.relevantDecisions.length > 0) {
    parts.push(`## Relevant Decisions\n${envelope.relevantDecisions.map(d => `- ${d}`).join('\n')}`);
  }

  let result = parts.join('\n\n');

  // Truncate to stay within token budget
  if (result.length > budgetChars) {
    result = result.slice(0, budgetChars - 15) + '\n[truncated]';
  }

  return result;
}

/**
 * Serialize a DelegationEnvelope to a compact string for injection into
 * the worker agent's context. Applies GCF compression when
 * `gcf_expanded_handoffs` + `GCF_WIRE_FORMAT` are active.
 * Falls back to plain-text if encoding fails or exceeds the token budget.
 *
 * Requirements: 6.1, 6.3, 6.4, 6.5, 6.6
 */
export function serializeDelegationEnvelope(
  envelope: DelegationEnvelope,
  featureGate?: FeatureGateSystem | null,
  metricsSink?: MetricsSink | null,
): string {
  const plainText = serializeDelegationEnvelopePlain(envelope);

  if (!isGcfExpandedActive(featureGate ?? null)) {
    return plainText;
  }

  const encoded = encodeGeneric(plainText);
  if (encoded === null) {
    console.warn('[DelegationEnvelope] GCF encoding failed, using plain text');
    return plainText;
  }

  // Verify token budget is still respected after encoding
  const encodedTokens = Math.ceil(encoded.length / 4);
  if (encodedTokens > envelope.tokenBudget) {
    return plainText;
  }

  const ratio = 1 - (encoded.length / plainText.length);
  metricsSink?.recordMetric(null, 'gcf.delegation.savings_ratio', ratio);

  return GCF_PRIMER + '\n' + encoded;
}

/**
 * Serialize a ResultEnvelope to plain-text markdown format.
 * Truncates content to stay within token budget.
 */
export function serializeResultEnvelopePlain(envelope: ResultEnvelope): string {
  const budgetChars = envelope.tokenBudget * 4; // ~4 chars per token

  const parts: string[] = [
    `## Outcome: ${envelope.outcome}`,
  ];

  if (envelope.artifacts.length > 0) {
    parts.push(`## Artifacts\n${envelope.artifacts.map(a => `- ${a}`).join('\n')}`);
  }

  if (envelope.decisions.length > 0) {
    parts.push(`## Decisions\n${envelope.decisions.map(d => `- ${d}`).join('\n')}`);
  }

  if (envelope.openIssues.length > 0) {
    parts.push(`## Open Issues\n${envelope.openIssues.map(i => `- ${i}`).join('\n')}`);
  }

  let result = parts.join('\n\n');

  // Truncate to stay within token budget
  if (result.length > budgetChars) {
    result = result.slice(0, budgetChars - 15) + '\n[truncated]';
  }

  return result;
}

/**
 * Serialize a ResultEnvelope to a compact string for the coordinator to consume.
 * Applies GCF compression when `gcf_expanded_handoffs` + `GCF_WIRE_FORMAT`
 * are active. Falls back to plain-text if encoding fails or exceeds the token budget.
 *
 * Requirements: 6.2, 6.3, 6.4, 6.5, 6.6
 */
export function serializeResultEnvelope(
  envelope: ResultEnvelope,
  featureGate?: FeatureGateSystem | null,
  metricsSink?: MetricsSink | null,
): string {
  const plainText = serializeResultEnvelopePlain(envelope);

  if (!isGcfExpandedActive(featureGate ?? null)) {
    return plainText;
  }

  const encoded = encodeGeneric(plainText);
  if (encoded === null) {
    console.warn('[ResultEnvelope] GCF encoding failed, using plain text');
    return plainText;
  }

  // Verify token budget is still respected after encoding
  const encodedTokens = Math.ceil(encoded.length / 4);
  if (encodedTokens > envelope.tokenBudget) {
    return plainText;
  }

  const ratio = 1 - (encoded.length / plainText.length);
  metricsSink?.recordMetric(null, 'gcf.delegation.savings_ratio', ratio);

  return GCF_PRIMER + '\n' + encoded;
}

/**
 * Parse a worker's raw output into a ResultEnvelope.
 * Extracts structured information from the worker's response.
 * Falls back to a generic partial result if parsing fails.
 */
export function parseResultFromWorkerOutput(output: string): ResultEnvelope {
  // Attempt to detect outcome from the output
  let outcome: ResultEnvelope['outcome'] = 'partial';
  const lowerOutput = output.toLowerCase();

  if (lowerOutput.includes('error') || lowerOutput.includes('failed') || lowerOutput.includes('❌')) {
    outcome = 'failed';
  } else if (lowerOutput.includes('stuck') || lowerOutput.includes('blocked')) {
    outcome = 'stuck';
  } else if (lowerOutput.includes('complete') || lowerOutput.includes('success') || lowerOutput.includes('done')) {
    outcome = 'success';
  }

  // Extract file paths (common patterns)
  const filePathPattern = /(?:^|\s)((?:src|lib|test|tests|spec)\/[\w\-./]+\.\w+)/gm;
  const artifacts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = filePathPattern.exec(output)) !== null) {
    if (!artifacts.includes(match[1])) {
      artifacts.push(match[1]);
    }
  }

  // Extract decisions — lines starting with "Decision:" or "Decided:" patterns
  const decisions: string[] = [];
  const decisionPattern = /(?:^|\n)\s*(?:decision|decided|chose|selected):\s*(.+)/gi;
  while ((match = decisionPattern.exec(output)) !== null) {
    decisions.push(match[1].trim());
  }

  // Extract open issues — lines starting with "TODO:", "Issue:", "Blocked:"
  const openIssues: string[] = [];
  const issuePattern = /(?:^|\n)\s*(?:todo|issue|blocked|unresolved|open):\s*(.+)/gi;
  while ((match = issuePattern.exec(output)) !== null) {
    openIssues.push(match[1].trim());
  }

  return createResultEnvelope({
    outcome,
    artifacts,
    decisions,
    openIssues,
  });
}
