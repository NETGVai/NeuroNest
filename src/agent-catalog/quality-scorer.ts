/**
 * Quality Scorer
 *
 * Deterministic scoring algorithm evaluating agent definitions across four dimensions
 * (0-25 each, total 0-100). Used by the Duplicate Detector to decide which version of
 * an agent to retain when duplicates are found.
 *
 * Dimensions:
 * - Prompt Specificity (0-25): structured output format, domain terminology, absence of
 *   vague qualifiers, role-specific constraints
 * - Deliverable Structure (0-25): numbered sections, code examples, success metrics,
 *   output format specification
 * - Workflow Completeness (0-25): multi-step process, decision points, error handling,
 *   iteration guidance
 * - Domain Depth (0-25): technology/tool references, framework citations, methodology
 *   references, domain vocabulary specificity
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.6
 */

import type { AgentDefinition } from '../agents/agent-registry';
import type { QualityBreakdown } from './types';

// ─────────────────────────────────────────────
// QualityScorer interface
// ─────────────────────────────────────────────

export type QualityDimensionId =
  | 'promptSpecificity'
  | 'deliverableStructure'
  | 'workflowCompleteness'
  | 'domainDepth';

export const QUALITY_RULE_IDS = Object.freeze({
  structuredOutput: 'prompt-specificity.structured-output',
  domainTerms: 'prompt-specificity.domain-terms',
  vagueQualifiers: 'prompt-specificity.vague-qualifiers',
  roleConstraints: 'prompt-specificity.role-constraints',
  numberedDeliverables: 'deliverable-structure.numbered-deliverables',
  codeExamples: 'deliverable-structure.code-examples',
  successMetrics: 'deliverable-structure.success-metrics',
  outputFormats: 'deliverable-structure.output-formats',
  sequentialProcess: 'workflow-completeness.sequential-process',
  decisions: 'workflow-completeness.decisions',
  errorHandling: 'workflow-completeness.error-handling',
  iteration: 'workflow-completeness.iteration',
  technologies: 'domain-depth.technologies',
  frameworks: 'domain-depth.frameworks',
  methodologies: 'domain-depth.methodologies',
  vocabularyDensity: 'domain-depth.vocabulary-density',
} as const);

export type QualityRuleId = (typeof QUALITY_RULE_IDS)[keyof typeof QUALITY_RULE_IDS];

export type QualityMatchingSemantics =
  | 'distinct-pattern-presence'
  | 'unique-domain-terms'
  | 'absence-of-distinct-patterns'
  | 'unique-domain-term-density';

export interface QualityRuleDefinition {
  readonly ruleId: QualityRuleId;
  readonly dimension: QualityDimensionId;
  readonly allocation: number;
  readonly matchingSemantics: QualityMatchingSemantics;
  readonly fullScoreThreshold: number;
}

export interface QualityDimensionDefinition {
  readonly dimension: QualityDimensionId;
  readonly maximumScore: 25;
  readonly rules: readonly QualityRuleDefinition[];
}

export interface QualityRuleMatch {
  /** Stable within a rule. Pattern-backed matches use a fixed ordinal identifier. */
  readonly matchId: string;
  /** The first matched text for a pattern, or the normalized unique domain term. */
  readonly value: string;
}

export interface QualityRuleEvidence {
  readonly ruleId: QualityRuleId;
  readonly dimension: QualityDimensionId;
  readonly allocation: number;
  readonly matchingSemantics: QualityMatchingSemantics;
  readonly count: number;
  readonly distinctMatches: readonly QualityRuleMatch[];
  readonly density: number | null;
  readonly score: number;
}

export interface QualityVocabularyEvidence {
  readonly terms: readonly string[];
  readonly wordCount: number;
  readonly density: number;
}

export interface QualityAnalysis {
  readonly rules: Readonly<Record<QualityRuleId, QualityRuleEvidence>>;
  readonly counts: Readonly<Record<QualityRuleId, number>>;
  readonly distinctMatches: Readonly<Record<QualityRuleId, readonly QualityRuleMatch[]>>;
  readonly vocabulary: QualityVocabularyEvidence;
  readonly breakdown: QualityBreakdown;
}

export interface QualityScorer {
  analyze(agent: AgentDefinition): QualityAnalysis;
  score(agent: AgentDefinition): QualityBreakdown;
  compare(a: AgentDefinition, b: AgentDefinition): {
    winner: 'a' | 'b' | 'tie';
    scoreA: QualityBreakdown;
    scoreB: QualityBreakdown;
    margin: number;
  };
}

// ─────────────────────────────────────────────
// Pattern Definitions
// ─────────────────────────────────────────────

/** Patterns indicating structured output format instructions. */
const STRUCTURED_OUTPUT_PATTERNS = [
  /\bformat\b.*\boutput\b/i,
  /\boutput\b.*\bformat\b/i,
  /\bstructure\b.*\bresponse\b/i,
  /\bdeliver\b.*\bas\b/i,
  /\brespond\b.*\bwith\b.*\b(json|yaml|xml|markdown|table)\b/i,
  /\breturn\b.*\b(json|object|array|list)\b/i,
  /\b\d+\)\s/m,  // Numbered list pattern like "1) ... 2) ..."
  /\bstep\s+\d+/i,
  /\bsection\s+\d+/i,
  /\bformat\s*:/i,
  /\btemplate\s*:/i,
  /\bschema\s*:/i,
];

/** Vague qualifiers whose absence improves quality. */
const VAGUE_QUALIFIERS = [
  /\bvery\b/i,
  /\breally\b/i,
  /\bkind of\b/i,
  /\bsort of\b/i,
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bsomewhat\b/i,
  /\bbasically\b/i,
  /\bjust\b/i,
  /\bstuff\b/i,
  /\bthings\b/i,
  /\betc\.?\b/i,
  /\band so on\b/i,
  /\bwhatever\b/i,
  /\bprobably\b/i,
];

/** Patterns indicating role-specific constraints. */
const ROLE_CONSTRAINT_PATTERNS = [
  /\byou are\b/i,
  /\byour role\b/i,
  /\byou must\b/i,
  /\byou shall\b/i,
  /\byou should\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\brequired to\b/i,
  /\bresponsible for\b/i,
  /\bexpertise\b/i,
  /\bspecialize\b/i,
];

/** Patterns indicating numbered deliverable sections. */
const NUMBERED_SECTION_PATTERNS = [
  /^\s*\d+[\.\)]\s+/m,
  /\b\d+\)\s+\w/,
  /\bphase\s+\d+/i,
  /\bstep\s+\d+/i,
  /\bpart\s+\d+/i,
  /^#+\s+\d+/m,
  /\bfirst\b.*\bsecond\b/i,
  /\bsection\s+\d+/i,
];

/** Patterns indicating code examples. */
const CODE_EXAMPLE_PATTERNS = [
  /```[\s\S]*?```/,
  /`[^`]+`/,
  /\bcode\s+example/i,
  /\bsample\s+code/i,
  /\bcode\s+snippet/i,
  /\bimplementation\b/i,
  /\bfunction\b.*\(/,
  /\bclass\b.*\{/,
  /\b(const|let|var)\b.*=/,
];

/** Patterns indicating success metrics. */
const SUCCESS_METRIC_PATTERNS = [
  /\bsuccess\s+(metrics?|criteria)\b/i,
  /\bkpi\b/i,
  /\bmeasur(e|able|ement)\b/i,
  /\bperformance\b.*\b(metric|indicator|target)\b/i,
  /\blatency\b/i,
  /\bthroughput\b/i,
  /\berror\s+rate\b/i,
  /\bavailability\b/i,
  /\buptime\b/i,
  /\baccuracy\b/i,
  /\bsla\b/i,
  /\bcoverage\b/i,
];

/** Patterns indicating output format specification. */
const OUTPUT_FORMAT_PATTERNS = [
  /\boutput\b/i,
  /\bdeliver(able|y)?\b/i,
  /\bformat\b/i,
  /\btemplate\b/i,
  /\bstructur(e|ed)\b/i,
  /\bjson\b/i,
  /\byaml\b/i,
  /\bmarkdown\b/i,
  /\breport\b/i,
  /\bdocument(ation)?\b/i,
];

/** Patterns indicating multi-step process definition. */
const MULTI_STEP_PATTERNS = [
  /\bstep\s+\d+/i,
  /\bphase\s+\d+/i,
  /\bfirst\b.*\bthen\b/i,
  /\bworkflow\b/i,
  /\bprocess\b/i,
  /\bpipeline\b/i,
  /\bsequence\b/i,
  /\bprocedure\b/i,
  /^\s*[-*]\s+/m,  // Bullet points
  /^\s*\d+\.\s+/m, // Numbered list
  /\bnext\b/i,
  /\bfinally\b/i,
];

/** Patterns indicating decision points. */
const DECISION_POINT_PATTERNS = [
  /\bif\b.*\bthen\b/i,
  /\bwhen\b.*\b(do|use|apply|choose)\b/i,
  /\bdecision\b/i,
  /\bchoose\b/i,
  /\bselect\b/i,
  /\bevaluate\b/i,
  /\bdepending on\b/i,
  /\bbased on\b/i,
  /\bcriteria\b/i,
  /\btrade-?off\b/i,
  /\balternative\b/i,
];

/** Patterns indicating error handling instructions. */
const ERROR_HANDLING_PATTERNS = [
  /\berror\b/i,
  /\bexception\b/i,
  /\bfailure\b/i,
  /\bfallback\b/i,
  /\bretry\b/i,
  /\brecover\b/i,
  /\bhandle\b/i,
  /\bedge\s+case\b/i,
  /\bcorner\s+case\b/i,
  /\bgraceful\b/i,
  /\brollback\b/i,
  /\btimeout\b/i,
];

/** Patterns indicating iteration guidance. */
const ITERATION_GUIDANCE_PATTERNS = [
  /\biterat(e|ion)\b/i,
  /\brefine\b/i,
  /\bimprove\b/i,
  /\breview\b/i,
  /\bfeedback\b/i,
  /\brevise\b/i,
  /\bupdate\b/i,
  /\bversion\b/i,
  /\bincrement(al)?\b/i,
  /\bcontinuous\b/i,
  /\bcycle\b/i,
];

/** Technology/tool name references (a representative set). */
const TECHNOLOGY_PATTERNS = [
  /\b(react|vue|svelte|angular|next\.?js|nuxt)\b/i,
  /\b(node\.?js|deno|bun|express|fastify|koa)\b/i,
  /\b(typescript|javascript|python|rust|go|java|kotlin|swift)\b/i,
  /\b(postgres(ql)?|mysql|mongodb|redis|sqlite|dynamo(db)?)\b/i,
  /\b(docker|kubernetes|k8s|terraform|ansible|pulumi)\b/i,
  /\b(aws|gcp|azure|cloudflare|vercel|netlify)\b/i,
  /\b(git(hub)?|gitlab|bitbucket|ci\/cd|jenkins)\b/i,
  /\b(graphql|rest|grpc|websocket|http)\b/i,
  /\b(webpack|vite|esbuild|rollup|babel)\b/i,
  /\b(jest|vitest|mocha|cypress|playwright)\b/i,
  /\b(figma|sketch|tailwind|css|sass|scss)\b/i,
  /\b(openai|anthropic|llm|gpt|claude|llama)\b/i,
  /\b(kafka|rabbitmq|sqs|nats|pubsub)\b/i,
  /\b(oauth|jwt|saml|oidc|tls|ssl)\b/i,
  /\b(linux|macos|windows|ubuntu|debian)\b/i,
];

/** Industry framework and methodology citations. */
const FRAMEWORK_PATTERNS = [
  /\bowasp\b/i,
  /\bsolid\b/,
  /\bddd\b/i,
  /\bmicroservice/i,
  /\bevent[\s-]?driv(en|ing)\b/i,
  /\bcqrs\b/i,
  /\bsaga\b/i,
  /\brest(ful)?\b/i,
  /\bgraphql\b/i,
  /\btdd\b/i,
  /\bbdd\b/i,
  /\bagile\b/i,
  /\bscrum\b/i,
  /\bkanban\b/i,
  /\bsafe\b/i,
  /\blean\b/i,
  /\bdevops\b/i,
  /\bsre\b/i,
  /\b12[\s-]?factor\b/i,
  /\bclean\s+(code|architecture)\b/i,
  /\bdesign\s+pattern/i,
  /\bzero[\s-]?trust\b/i,
  /\bshift[\s-]?left\b/i,
  /\bgitops\b/i,
  /\binfrastructure[\s-]?as[\s-]?code\b/i,
];

/** Named methodology references. */
const METHODOLOGY_PATTERNS = [
  /\bthreat\s+model/i,
  /\brisk\s+assess/i,
  /\bpenetration\s+test/i,
  /\bcode\s+review/i,
  /\bpair\s+program/i,
  /\bmob\s+program/i,
  /\broot\s+cause\s+analysis/i,
  /\bpost[\s-]?mortem\b/i,
  /\bfive\s+whys\b/i,
  /\buser\s+story\b/i,
  /\bjob[\s-]?to[\s-]?be[\s-]?done\b/i,
  /\bimpact\s+mapping\b/i,
  /\bstory\s+mapping\b/i,
  /\ba\/b\s+test/i,
  /\bcanary\s+(deploy|release)/i,
  /\bblue[\s-]?green\b/i,
  /\bfeature\s+flag/i,
  /\bchaos\s+engineer/i,
  /\bci[\s\/]cd\b/i,
  /\btrunk[\s-]?based\b/i,
];

// ─────────────────────────────────────────────
// Stable Rule Definitions
// ─────────────────────────────────────────────

function defineRule(
  ruleId: QualityRuleId,
  dimension: QualityDimensionId,
  allocation: number,
  matchingSemantics: QualityMatchingSemantics,
  fullScoreThreshold: number,
): QualityRuleDefinition {
  return Object.freeze({ ruleId, dimension, allocation, matchingSemantics, fullScoreThreshold });
}

const RULE_DEFINITIONS = Object.freeze({
  [QUALITY_RULE_IDS.structuredOutput]: defineRule(
    QUALITY_RULE_IDS.structuredOutput,
    'promptSpecificity',
    7,
    'distinct-pattern-presence',
    3,
  ),
  [QUALITY_RULE_IDS.domainTerms]: defineRule(
    QUALITY_RULE_IDS.domainTerms,
    'promptSpecificity',
    6,
    'unique-domain-terms',
    8,
  ),
  [QUALITY_RULE_IDS.vagueQualifiers]: defineRule(
    QUALITY_RULE_IDS.vagueQualifiers,
    'promptSpecificity',
    6,
    'absence-of-distinct-patterns',
    0,
  ),
  [QUALITY_RULE_IDS.roleConstraints]: defineRule(
    QUALITY_RULE_IDS.roleConstraints,
    'promptSpecificity',
    6,
    'distinct-pattern-presence',
    3,
  ),
  [QUALITY_RULE_IDS.numberedDeliverables]: defineRule(
    QUALITY_RULE_IDS.numberedDeliverables,
    'deliverableStructure',
    7,
    'distinct-pattern-presence',
    2,
  ),
  [QUALITY_RULE_IDS.codeExamples]: defineRule(
    QUALITY_RULE_IDS.codeExamples,
    'deliverableStructure',
    6,
    'distinct-pattern-presence',
    2,
  ),
  [QUALITY_RULE_IDS.successMetrics]: defineRule(
    QUALITY_RULE_IDS.successMetrics,
    'deliverableStructure',
    6,
    'distinct-pattern-presence',
    2,
  ),
  [QUALITY_RULE_IDS.outputFormats]: defineRule(
    QUALITY_RULE_IDS.outputFormats,
    'deliverableStructure',
    6,
    'distinct-pattern-presence',
    3,
  ),
  [QUALITY_RULE_IDS.sequentialProcess]: defineRule(
    QUALITY_RULE_IDS.sequentialProcess,
    'workflowCompleteness',
    7,
    'distinct-pattern-presence',
    3,
  ),
  [QUALITY_RULE_IDS.decisions]: defineRule(
    QUALITY_RULE_IDS.decisions,
    'workflowCompleteness',
    6,
    'distinct-pattern-presence',
    2,
  ),
  [QUALITY_RULE_IDS.errorHandling]: defineRule(
    QUALITY_RULE_IDS.errorHandling,
    'workflowCompleteness',
    6,
    'distinct-pattern-presence',
    2,
  ),
  [QUALITY_RULE_IDS.iteration]: defineRule(
    QUALITY_RULE_IDS.iteration,
    'workflowCompleteness',
    6,
    'distinct-pattern-presence',
    2,
  ),
  [QUALITY_RULE_IDS.technologies]: defineRule(
    QUALITY_RULE_IDS.technologies,
    'domainDepth',
    7,
    'distinct-pattern-presence',
    3,
  ),
  [QUALITY_RULE_IDS.frameworks]: defineRule(
    QUALITY_RULE_IDS.frameworks,
    'domainDepth',
    6,
    'distinct-pattern-presence',
    2,
  ),
  [QUALITY_RULE_IDS.methodologies]: defineRule(
    QUALITY_RULE_IDS.methodologies,
    'domainDepth',
    6,
    'distinct-pattern-presence',
    2,
  ),
  [QUALITY_RULE_IDS.vocabularyDensity]: defineRule(
    QUALITY_RULE_IDS.vocabularyDensity,
    'domainDepth',
    6,
    'unique-domain-term-density',
    0.3,
  ),
}) as Readonly<Record<QualityRuleId, QualityRuleDefinition>>;

const promptRules = Object.freeze([
  RULE_DEFINITIONS[QUALITY_RULE_IDS.structuredOutput],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.domainTerms],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.vagueQualifiers],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.roleConstraints],
]);
const deliverableRules = Object.freeze([
  RULE_DEFINITIONS[QUALITY_RULE_IDS.numberedDeliverables],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.codeExamples],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.successMetrics],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.outputFormats],
]);
const workflowRules = Object.freeze([
  RULE_DEFINITIONS[QUALITY_RULE_IDS.sequentialProcess],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.decisions],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.errorHandling],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.iteration],
]);
const domainRules = Object.freeze([
  RULE_DEFINITIONS[QUALITY_RULE_IDS.technologies],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.frameworks],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.methodologies],
  RULE_DEFINITIONS[QUALITY_RULE_IDS.vocabularyDensity],
]);

/** Immutable public contract for dimensions, allocations, maxima, and matching semantics. */
export const QUALITY_SCORER_DEFINITION = Object.freeze({
  maximumTotalScore: 100 as const,
  dimensions: Object.freeze([
    Object.freeze({ dimension: 'promptSpecificity' as const, maximumScore: 25 as const, rules: promptRules }),
    Object.freeze({
      dimension: 'deliverableStructure' as const,
      maximumScore: 25 as const,
      rules: deliverableRules,
    }),
    Object.freeze({
      dimension: 'workflowCompleteness' as const,
      maximumScore: 25 as const,
      rules: workflowRules,
    }),
    Object.freeze({ dimension: 'domainDepth' as const, maximumScore: 25 as const, rules: domainRules }),
  ]) as readonly QualityDimensionDefinition[],
});

// ─────────────────────────────────────────────
// Analysis Helpers
// ─────────────────────────────────────────────

function getAnalysisText(agent: AgentDefinition): string {
  return `${agent.systemPrompt || ''}\n${agent.specialty || ''}`;
}

function extractDomainTerms(text: string): Set<string> {
  const commonWords = new Set([
    'that', 'this', 'with', 'from', 'your', 'have', 'will', 'been', 'they',
    'their', 'which', 'when', 'what', 'where', 'would', 'could', 'should',
    'about', 'there', 'other', 'than', 'then', 'them', 'each', 'make',
    'like', 'just', 'over', 'such', 'take', 'also', 'into', 'some', 'only',
    'more', 'very', 'most', 'well', 'being', 'these', 'does', 'good',
    'first', 'need', 'back', 'much', 'after', 'before', 'even', 'many',
    'must', 'always', 'never', 'every', 'code', 'data', 'file', 'work',
  ]);

  const words = text.toLowerCase().match(/\b[a-z][a-z0-9-]{3,}\b/g) || [];
  const terms = new Set<string>();
  for (const word of words) {
    if (!commonWords.has(word)) {
      terms.add(word);
    }
  }
  return terms;
}

function findDistinctPatternMatches(
  text: string,
  ruleId: QualityRuleId,
  patterns: readonly RegExp[],
): readonly QualityRuleMatch[] {
  return Object.freeze(
    patterns.flatMap((pattern, index) => {
      const match = pattern.exec(text);
      return match
        ? [
            Object.freeze({
              matchId: `${ruleId}.pattern-${String(index + 1).padStart(2, '0')}`,
              value: match[0],
            }),
          ]
        : [];
    }),
  );
}

function findDomainTermMatches(
  ruleId: QualityRuleId,
  domainTerms: readonly string[],
): readonly QualityRuleMatch[] {
  return Object.freeze(
    domainTerms.map((term) => Object.freeze({ matchId: `${ruleId}.term:${term}`, value: term })),
  );
}

function scaledPatternScore(count: number, threshold: number, allocation: number): number {
  return Math.min(allocation, Math.round((count / threshold) * allocation));
}

function createRuleEvidence(
  ruleId: QualityRuleId,
  distinctMatches: readonly QualityRuleMatch[],
  score: number,
  density: number | null = null,
): QualityRuleEvidence {
  const definition = RULE_DEFINITIONS[ruleId];
  return Object.freeze({
    ruleId,
    dimension: definition.dimension,
    allocation: definition.allocation,
    matchingSemantics: definition.matchingSemantics,
    count: distinctMatches.length,
    distinctMatches,
    density,
    score,
  });
}

function analyzeText(text: string): QualityAnalysis {
  const domainTerms = Object.freeze([...extractDomainTerms(text)].sort());
  const wordCount = (text.match(/\b\w+\b/g) || []).length;
  const domainDensity = wordCount > 0 ? domainTerms.length / wordCount : 0;

  const patternInputs: readonly [QualityRuleId, readonly RegExp[]][] = [
    [QUALITY_RULE_IDS.structuredOutput, STRUCTURED_OUTPUT_PATTERNS],
    [QUALITY_RULE_IDS.vagueQualifiers, VAGUE_QUALIFIERS],
    [QUALITY_RULE_IDS.roleConstraints, ROLE_CONSTRAINT_PATTERNS],
    [QUALITY_RULE_IDS.numberedDeliverables, NUMBERED_SECTION_PATTERNS],
    [QUALITY_RULE_IDS.codeExamples, CODE_EXAMPLE_PATTERNS],
    [QUALITY_RULE_IDS.successMetrics, SUCCESS_METRIC_PATTERNS],
    [QUALITY_RULE_IDS.outputFormats, OUTPUT_FORMAT_PATTERNS],
    [QUALITY_RULE_IDS.sequentialProcess, MULTI_STEP_PATTERNS],
    [QUALITY_RULE_IDS.decisions, DECISION_POINT_PATTERNS],
    [QUALITY_RULE_IDS.errorHandling, ERROR_HANDLING_PATTERNS],
    [QUALITY_RULE_IDS.iteration, ITERATION_GUIDANCE_PATTERNS],
    [QUALITY_RULE_IDS.technologies, TECHNOLOGY_PATTERNS],
    [QUALITY_RULE_IDS.frameworks, FRAMEWORK_PATTERNS],
    [QUALITY_RULE_IDS.methodologies, METHODOLOGY_PATTERNS],
  ];
  const matches = new Map<QualityRuleId, readonly QualityRuleMatch[]>(
    patternInputs.map(([ruleId, patterns]) => [ruleId, findDistinctPatternMatches(text, ruleId, patterns)]),
  );
  const domainTermMatches = findDomainTermMatches(QUALITY_RULE_IDS.domainTerms, domainTerms);
  const densityTermMatches = findDomainTermMatches(QUALITY_RULE_IDS.vocabularyDensity, domainTerms);
  matches.set(QUALITY_RULE_IDS.domainTerms, domainTermMatches);
  matches.set(QUALITY_RULE_IDS.vocabularyDensity, densityTermMatches);

  const getMatches = (ruleId: QualityRuleId): readonly QualityRuleMatch[] => matches.get(ruleId) ?? [];
  const scaledEvidence = (ruleId: QualityRuleId): QualityRuleEvidence => {
    const definition = RULE_DEFINITIONS[ruleId];
    const ruleMatches = getMatches(ruleId);
    return createRuleEvidence(
      ruleId,
      ruleMatches,
      scaledPatternScore(ruleMatches.length, definition.fullScoreThreshold, definition.allocation),
    );
  };

  const structuredOutput = scaledEvidence(QUALITY_RULE_IDS.structuredOutput);
  const promptDomainTerms = scaledEvidence(QUALITY_RULE_IDS.domainTerms);
  const vagueMatches = getMatches(QUALITY_RULE_IDS.vagueQualifiers);
  const vagueQualifiers = createRuleEvidence(
    QUALITY_RULE_IDS.vagueQualifiers,
    vagueMatches,
    Math.max(0, Math.min(6, 6 - vagueMatches.length)),
  );
  const roleConstraints = scaledEvidence(QUALITY_RULE_IDS.roleConstraints);
  const numberedDeliverables = scaledEvidence(QUALITY_RULE_IDS.numberedDeliverables);
  const codeExamples = scaledEvidence(QUALITY_RULE_IDS.codeExamples);
  const successMetrics = scaledEvidence(QUALITY_RULE_IDS.successMetrics);
  const outputFormats = scaledEvidence(QUALITY_RULE_IDS.outputFormats);
  const sequentialProcess = scaledEvidence(QUALITY_RULE_IDS.sequentialProcess);
  const decisions = scaledEvidence(QUALITY_RULE_IDS.decisions);
  const errorHandling = scaledEvidence(QUALITY_RULE_IDS.errorHandling);
  const iteration = scaledEvidence(QUALITY_RULE_IDS.iteration);
  const technologies = scaledEvidence(QUALITY_RULE_IDS.technologies);
  const frameworks = scaledEvidence(QUALITY_RULE_IDS.frameworks);
  const methodologies = scaledEvidence(QUALITY_RULE_IDS.methodologies);
  const vocabularyDensity = createRuleEvidence(
    QUALITY_RULE_IDS.vocabularyDensity,
    densityTermMatches,
    Math.min(6, Math.round((domainDensity / 0.3) * 6)),
    domainDensity,
  );

  const rules = Object.freeze({
    [QUALITY_RULE_IDS.structuredOutput]: structuredOutput,
    [QUALITY_RULE_IDS.domainTerms]: promptDomainTerms,
    [QUALITY_RULE_IDS.vagueQualifiers]: vagueQualifiers,
    [QUALITY_RULE_IDS.roleConstraints]: roleConstraints,
    [QUALITY_RULE_IDS.numberedDeliverables]: numberedDeliverables,
    [QUALITY_RULE_IDS.codeExamples]: codeExamples,
    [QUALITY_RULE_IDS.successMetrics]: successMetrics,
    [QUALITY_RULE_IDS.outputFormats]: outputFormats,
    [QUALITY_RULE_IDS.sequentialProcess]: sequentialProcess,
    [QUALITY_RULE_IDS.decisions]: decisions,
    [QUALITY_RULE_IDS.errorHandling]: errorHandling,
    [QUALITY_RULE_IDS.iteration]: iteration,
    [QUALITY_RULE_IDS.technologies]: technologies,
    [QUALITY_RULE_IDS.frameworks]: frameworks,
    [QUALITY_RULE_IDS.methodologies]: methodologies,
    [QUALITY_RULE_IDS.vocabularyDensity]: vocabularyDensity,
  }) as Readonly<Record<QualityRuleId, QualityRuleEvidence>>;

  const promptSpecificity = Math.min(
    25,
    structuredOutput.score + promptDomainTerms.score + vagueQualifiers.score + roleConstraints.score,
  );
  const deliverableStructure = Math.min(
    25,
    numberedDeliverables.score + codeExamples.score + successMetrics.score + outputFormats.score,
  );
  const workflowCompleteness = Math.min(
    25,
    sequentialProcess.score + decisions.score + errorHandling.score + iteration.score,
  );
  const domainDepth = Math.min(
    25,
    technologies.score + frameworks.score + methodologies.score + vocabularyDensity.score,
  );
  const breakdown: QualityBreakdown = {
    promptSpecificity,
    deliverableStructure,
    workflowCompleteness,
    domainDepth,
    total: promptSpecificity + deliverableStructure + workflowCompleteness + domainDepth,
  };

  const entries = Object.entries(rules) as [QualityRuleId, QualityRuleEvidence][];
  const counts = Object.freeze(
    Object.fromEntries(entries.map(([ruleId, evidence]) => [ruleId, evidence.count])),
  ) as Readonly<Record<QualityRuleId, number>>;
  const distinctMatches = Object.freeze(
    Object.fromEntries(entries.map(([ruleId, evidence]) => [ruleId, evidence.distinctMatches])),
  ) as Readonly<Record<QualityRuleId, readonly QualityRuleMatch[]>>;

  return Object.freeze({
    rules,
    counts,
    distinctMatches,
    vocabulary: Object.freeze({ terms: domainTerms, wordCount, density: domainDensity }),
    breakdown,
  });
}

// ─────────────────────────────────────────────
// Dimension Scorers and Public API
// ─────────────────────────────────────────────

function scorePromptSpecificity(text: string): number {
  return analyzeText(text).breakdown.promptSpecificity;
}

function scoreDeliverableStructure(text: string): number {
  return analyzeText(text).breakdown.deliverableStructure;
}

function scoreWorkflowCompleteness(text: string): number {
  return analyzeText(text).breakdown.workflowCompleteness;
}

function scoreDomainDepth(text: string): number {
  return analyzeText(text).breakdown.domainDepth;
}

/** Returns stable rule evidence and the authoritative score breakdown for an agent. */
function analyzeAgent(agent: AgentDefinition): QualityAnalysis {
  return analyzeText(getAnalysisText(agent));
}

/** Scores through the same analysis result used to expose evidence. */
function scoreAgent(agent: AgentDefinition): QualityBreakdown {
  return analyzeAgent(agent).breakdown;
}

function compareAgents(
  a: AgentDefinition,
  b: AgentDefinition,
): { winner: 'a' | 'b' | 'tie'; scoreA: QualityBreakdown; scoreB: QualityBreakdown; margin: number } {
  const scoreA = scoreAgent(a);
  const scoreB = scoreAgent(b);
  const margin = Math.abs(scoreA.total - scoreB.total);

  let winner: 'a' | 'b' | 'tie';
  if (scoreA.total > scoreB.total) {
    winner = 'a';
  } else if (scoreB.total > scoreA.total) {
    winner = 'b';
  } else {
    winner = 'tie';
  }

  return { winner, scoreA, scoreB, margin };
}

export function createQualityScorer(): QualityScorer {
  return {
    analyze: analyzeAgent,
    score: scoreAgent,
    compare: compareAgents,
  };
}

export {
  analyzeAgent,
  scorePromptSpecificity,
  scoreDeliverableStructure,
  scoreWorkflowCompleteness,
  scoreDomainDepth,
  scoreAgent,
  compareAgents,
};
