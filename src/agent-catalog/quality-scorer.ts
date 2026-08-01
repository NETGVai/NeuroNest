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

export interface QualityScorer {
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
// Scoring Helpers
// ─────────────────────────────────────────────

/**
 * Gets the combined text from an agent's systemPrompt and specialty fields.
 */
function getAnalysisText(agent: AgentDefinition): string {
  return `${agent.systemPrompt || ''}\n${agent.specialty || ''}`;
}

/**
 * Counts how many patterns from a list match in the given text.
 */
function countPatternMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      count++;
    }
  }
  return count;
}

/**
 * Extracts unique domain-specific words (>= 4 chars, not common English).
 */
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

// ─────────────────────────────────────────────
// Dimension Scorers
// ─────────────────────────────────────────────

/**
 * Evaluates prompt specificity (0-25).
 *
 * Criteria:
 * - Structured output format instructions (+7): presence of patterns indicating
 *   the prompt defines how output should be formatted
 * - Explicit domain terminology count (+6): the number of domain-specific terms
 *   (non-common-word tokens >= 4 chars) normalized to a 0-6 scale
 * - Absence of vague qualifiers (+6): fewer vague words like "very", "really",
 *   "kind of" earn more points
 * - Role-specific constraints (+6): presence of patterns defining the agent's
 *   role boundaries and behavioral constraints
 */
function scorePromptSpecificity(text: string): number {
  let score = 0;

  // Structured output format instructions (0-7)
  const structuredMatches = countPatternMatches(text, STRUCTURED_OUTPUT_PATTERNS);
  score += Math.min(7, Math.round((structuredMatches / 3) * 7));

  // Explicit domain terminology count (0-6)
  const domainTerms = extractDomainTerms(text);
  // Scale: 0 terms = 0, 5+ unique domain terms = 6
  score += Math.min(6, Math.round((domainTerms.size / 8) * 6));

  // Absence of vague qualifiers (0-6)
  const vagueCount = countPatternMatches(text, VAGUE_QUALIFIERS);
  // Fewer vague qualifiers = higher score. 0 vague = 6, 5+ vague = 0
  score += Math.max(0, Math.min(6, 6 - vagueCount));

  // Role-specific constraints (0-6)
  const roleMatches = countPatternMatches(text, ROLE_CONSTRAINT_PATTERNS);
  score += Math.min(6, Math.round((roleMatches / 3) * 6));

  return Math.min(25, score);
}

/**
 * Evaluates deliverable structure (0-25).
 *
 * Criteria:
 * - Numbered deliverable sections (+7): presence of numbered/ordered lists
 *   indicating structured deliverables
 * - Code examples (+6): presence of code blocks, inline code, or implementation patterns
 * - Success metrics (+6): presence of measurable outcomes, KPIs, or performance targets
 * - Output format specification (+6): presence of format definitions for agent output
 */
function scoreDeliverableStructure(text: string): number {
  let score = 0;

  // Numbered deliverable sections (0-7)
  const numberedMatches = countPatternMatches(text, NUMBERED_SECTION_PATTERNS);
  score += Math.min(7, Math.round((numberedMatches / 2) * 7));

  // Code examples (0-6)
  const codeMatches = countPatternMatches(text, CODE_EXAMPLE_PATTERNS);
  score += Math.min(6, Math.round((codeMatches / 2) * 6));

  // Success metrics (0-6)
  const metricMatches = countPatternMatches(text, SUCCESS_METRIC_PATTERNS);
  score += Math.min(6, Math.round((metricMatches / 2) * 6));

  // Output format specification (0-6)
  const outputMatches = countPatternMatches(text, OUTPUT_FORMAT_PATTERNS);
  score += Math.min(6, Math.round((outputMatches / 3) * 6));

  return Math.min(25, score);
}

/**
 * Evaluates workflow completeness (0-25).
 *
 * Criteria:
 * - Multi-step process definition (+7): presence of sequential steps, phases, or stages
 * - Decision points (+6): presence of conditional logic, choices, or evaluation criteria
 * - Error handling instructions (+6): presence of failure modes, fallbacks, or recovery guidance
 * - Iteration guidance (+6): presence of refinement cycles, feedback loops, or improvement processes
 */
function scoreWorkflowCompleteness(text: string): number {
  let score = 0;

  // Multi-step process definition (0-7)
  const multiStepMatches = countPatternMatches(text, MULTI_STEP_PATTERNS);
  score += Math.min(7, Math.round((multiStepMatches / 3) * 7));

  // Decision points (0-6)
  const decisionMatches = countPatternMatches(text, DECISION_POINT_PATTERNS);
  score += Math.min(6, Math.round((decisionMatches / 2) * 6));

  // Error handling instructions (0-6)
  const errorMatches = countPatternMatches(text, ERROR_HANDLING_PATTERNS);
  score += Math.min(6, Math.round((errorMatches / 2) * 6));

  // Iteration guidance (0-6)
  const iterMatches = countPatternMatches(text, ITERATION_GUIDANCE_PATTERNS);
  score += Math.min(6, Math.round((iterMatches / 2) * 6));

  return Math.min(25, score);
}

/**
 * Evaluates domain depth (0-25).
 *
 * Criteria:
 * - Technology/tool name references (+7): named technologies, libraries, services
 * - Industry framework citations (+6): named frameworks (OWASP, SOLID, DDD, etc.)
 * - Named methodology references (+6): specific methodologies (threat modeling, canary deploys, etc.)
 * - Domain vocabulary specificity (+6): ratio of domain-specific terms to total terms
 */
function scoreDomainDepth(text: string): number {
  let score = 0;

  // Technology/tool name references (0-7)
  const techMatches = countPatternMatches(text, TECHNOLOGY_PATTERNS);
  score += Math.min(7, Math.round((techMatches / 3) * 7));

  // Industry framework citations (0-6)
  const frameworkMatches = countPatternMatches(text, FRAMEWORK_PATTERNS);
  score += Math.min(6, Math.round((frameworkMatches / 2) * 6));

  // Named methodology references (0-6)
  const methodMatches = countPatternMatches(text, METHODOLOGY_PATTERNS);
  score += Math.min(6, Math.round((methodMatches / 2) * 6));

  // Domain vocabulary specificity (0-6)
  // Measured by the density of domain-specific terms relative to text length
  const domainTerms = extractDomainTerms(text);
  const wordCount = (text.match(/\b\w+\b/g) || []).length;
  const domainDensity = wordCount > 0 ? domainTerms.size / wordCount : 0;
  // A density of 0.3+ earns full marks
  score += Math.min(6, Math.round((domainDensity / 0.3) * 6));

  return Math.min(25, score);
}

// ─────────────────────────────────────────────
// Quality Scorer Implementation
// ─────────────────────────────────────────────

/**
 * Scores an agent definition across four quality dimensions.
 * The scoring is deterministic: same input always produces same output.
 */
function scoreAgent(agent: AgentDefinition): QualityBreakdown {
  const text = getAnalysisText(agent);

  const promptSpecificity = scorePromptSpecificity(text);
  const deliverableStructure = scoreDeliverableStructure(text);
  const workflowCompleteness = scoreWorkflowCompleteness(text);
  const domainDepth = scoreDomainDepth(text);

  return {
    promptSpecificity,
    deliverableStructure,
    workflowCompleteness,
    domainDepth,
    total: promptSpecificity + deliverableStructure + workflowCompleteness + domainDepth,
  };
}

/**
 * Compares two agent definitions and returns which is superior.
 * Winner is determined by total score; tie when scores are equal.
 */
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

/**
 * Creates a QualityScorer instance with score() and compare() methods.
 */
export function createQualityScorer(): QualityScorer {
  return {
    score: scoreAgent,
    compare: compareAgents,
  };
}

// Export individual scoring functions for testing
export {
  scorePromptSpecificity,
  scoreDeliverableStructure,
  scoreWorkflowCompleteness,
  scoreDomainDepth,
  scoreAgent,
  compareAgents,
};
