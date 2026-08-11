import type {
  AgentFileParseResult,
  AgentSectionName,
  ExtractedAgentSection,
  SourceRange,
} from './agent-file-parser';

export type AuthenticityCriterionName =
  | 'identitySentenceRange'
  | 'identityRoleAndSpecialty'
  | 'identityResponsibilities'
  | 'identityBehavioralBoundaries'
  | 'coreMissionObjectiveRange'
  | 'coreMissionNumbering'
  | 'coreMissionSpecialtyObjectives'
  | 'criticalRuleRange'
  | 'criticalRuleConstraints'
  | 'technicalDeliverableRange'
  | 'technicalDeliverableCompleteness'
  | 'workflowStepRange'
  | 'workflowSequentialOrder'
  | 'workflowPipelineCompleteness'
  | 'workflowDecisionGates'
  | 'workflowErrorBranch'
  | 'workflowBoundedLoop'
  | 'successMetricRange'
  | 'successMetricCompleteness'
  | 'officialReferences'
  | 'contextualAssociations';

export type ReferenceCategory =
  | 'technology'
  | 'framework'
  | 'methodology'
  | 'domain'
  | 'external';

export interface AuthenticityCriterionResult {
  readonly criterion: AuthenticityCriterionName;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface AuthenticityItemEvidence {
  readonly section: AgentSectionName;
  readonly itemNumber: number;
  readonly marker: string | null;
  readonly text: string;
  readonly sourceRange: SourceRange;
  readonly specialtySpecific: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
}

export interface ReferenceOccurrence {
  readonly canonicalName: string;
  readonly matchedText: string;
  readonly categories: readonly ReferenceCategory[];
  readonly origin: AgentSectionName | 'specialty';
  readonly sourceRange: SourceRange | null;
  readonly contextUnit: string;
  readonly contextKind: 'sentence' | 'list-item' | 'specialty';
  readonly contextuallyAssociated: boolean;
  readonly url: string | null;
  readonly official: boolean | null;
  readonly officialReason: string | null;
}

export interface KeywordStuffingFinding {
  readonly code: 'IRRELEVANT_KEYWORD_STUFFING';
  readonly sourcePath: string;
  readonly reference: string;
  readonly origin: AgentSectionName | 'specialty';
  readonly sourceRange: SourceRange | null;
  readonly contextUnit: string;
  readonly message: string;
}

export interface AuthenticityFinding {
  readonly code: string;
  readonly sourcePath: string;
  readonly criterion: AuthenticityCriterionName;
  readonly section: AgentSectionName | null;
  readonly itemNumber: number | null;
  readonly classification: 'blocking';
  readonly message: string;
}

export interface ReferenceClassification {
  readonly referenceFree: boolean;
  readonly domainPatternMinimaApplicable: boolean;
  readonly contextualAssociationApplicable: boolean;
  readonly occurrences: readonly ReferenceOccurrence[];
  readonly disconnectedReferences: readonly KeywordStuffingFinding[];
}

export interface AuthenticityValidation {
  readonly sourcePath: string;
  readonly valid: boolean;
  readonly criteria: Readonly<Record<AuthenticityCriterionName, AuthenticityCriterionResult>>;
  readonly sectionItems: Readonly<Record<AgentSectionName, readonly AuthenticityItemEvidence[]>>;
  readonly references: ReferenceClassification;
  readonly findings: readonly AuthenticityFinding[];
}

export interface AdditionalReferenceDefinition {
  readonly canonicalName: string;
  readonly category: Exclude<ReferenceCategory, 'external'>;
  readonly aliases: readonly string[];
  readonly officialHosts?: readonly string[];
}

export interface AuthenticityValidationInput {
  readonly sourcePath: string;
  readonly specialty: string;
  readonly parseResult: AgentFileParseResult;
  readonly specialtyAnchors?: readonly string[];
  readonly additionalReferences?: readonly AdditionalReferenceDefinition[];
  /** Additional exact or parent domains accepted as authoritative publishers. */
  readonly additionalOfficialHosts?: readonly string[];
}

interface MutableItem {
  section: AgentSectionName;
  itemNumber: number;
  marker: string | null;
  ordinal: number | null;
  text: string;
  start: number;
  end: number;
}

interface ReferenceDefinition {
  canonicalName: string;
  categories: readonly Exclude<ReferenceCategory, 'external'>[];
  aliases: readonly string[];
  officialHosts: readonly string[];
}

interface TextOrigin {
  origin: AgentSectionName | 'specialty';
  text: string;
  absoluteStart: number | null;
  items: readonly MutableItem[];
}

const SECTION_ORDER: readonly AgentSectionName[] = [
  'Identity',
  'Core Mission',
  'Critical Rules',
  'Technical Deliverables',
  'Workflow Process',
  'Success Metrics',
];

const STOP_WORDS = new Set([
  'agent', 'and', 'with', 'from', 'that', 'this', 'into', 'using', 'specialist', 'expert',
  'support', 'services', 'system', 'process', 'technical', 'professional', 'management',
]);

const ROLE_PATTERN = /\b(?:you are|your role|act as|serves? as|speciali[sz](?:e|es|ed|ing)|expert(?:ise)? in)\b/i;
const RESPONSIBILITY_PATTERN = /\b(?:responsible for|accountable for|own(?:s|ing)?|analy[sz](?:e|es|ing)|assess(?:es|ing)?|design(?:s|ing)?|implement(?:s|ing)?|produce(?:s|ing)?|create(?:s|ing)?|validate(?:s|ing)?|review(?:s|ing)?|facilitat(?:e|es|ing)|mediat(?:e|es|ing)|optimi[sz](?:e|es|ing)|monitor(?:s|ing)?|investigat(?:e|es|ing)|manage(?:s|ing)?|develop(?:s|ing)?|coordinate(?:s|ing)?|deliver(?:s|ing)?)\b/i;
const CONSTRAINT_PATTERN = /\b(?:must|shall|required to|never|do not|don't|may not|only|prohibit(?:s|ed)?|forbid(?:s|den)?|cannot|can't|without|unless)\b/i;
const OBJECTIVE_PATTERN = /\b(?:analy[sz]e|assess|design|implement|produce|create|validate|review|facilitate|mediate|optimi[sz]e|monitor|investigate|manage|develop|coordinate|deliver|establish|reduce|increase|document|recommend|prioriti[sz]e|verify|synthesize|resolve)\b/i;
const OUTPUT_FORMAT_PATTERN = /\b(?:format\s*:|output\s+format|deliver(?:ed)?\s+as|as\s+(?:a|an)\s+(?:json|yaml|xml|csv|markdown|table|report|document|checklist|diagram|schema|patch|runbook|matrix|plan|dashboard)|json|yaml|xml|csv|markdown|table|report|document|checklist|diagram|schema|patch|runbook|matrix|dashboard)\b/i;
const COMPONENT_PATTERN = /\b(?:components?|fields?|columns?|sections?|includes?|including|contains?|containing|required contents?|with\s+(?:a|an|the|each|all|at least|exactly))\b/i;
const COMPLETION_PATTERN = /\b(?:complete when|completion criterion|accepted when|acceptance criterion|passes? when|pass condition|verified by|validated by|observable when|done when|evidence(?:d)? by|recorded result|must (?:contain|include|show|produce|equal|remain)|at least|at most|no (?:more|less) than|exactly)\b|(?:<=|>=|<|>)\s*\d/i;
const DECISION_PATTERN = /\b(?:decision gate|gate\s*:|if\b.+\bthen|when\b.+\b(?:choose|select|proceed|route|escalate|reject|approve)|choose between|based on\b.+\b(?:select|choose|route|proceed))\b/i;
const ERROR_TRIGGER_PATTERN = /\b(?:on|if|when)\s+(?:an?\s+)?(?:[\w-]+\s+){0,5}(?:error|failure|invalid|missing|unavailable|timeout|conflict|exception)\b|\b(?:error|failure|exception)\s+branch\b/i;
const ERROR_ACTION_PATTERN = /\b(?:fallback|retry|stop|abort|rollback|recover|escalate|return|record|quarantine|reject|request)\b/i;
const ITERATION_PATTERN = /\b(?:iterat(?:e|ion)|loop|repeat|retry|refine|revise)\b/i;
const MAX_ITERATION_PATTERN = /\b(?:maximum|max(?:imum)?\.?|up to|no more than|at most)\s+(?:of\s+)?\d+\s*(?:iterations?|cycles?|attempts?|retries?|times?|rounds?)\b|\b\d+\s*(?:iterations?|cycles?|attempts?|retries?|rounds?)\s+(?:maximum|max|limit)\b/i;
const EARLY_EXIT_PATTERN = /\b(?:exit|stop|break|terminate|finish|end)\s+(?:early\s+)?(?:when|if|once)|\bearly exit\b|\buntil\s+(?:the\s+)?(?:target|criterion|criteria|condition|threshold|quality)\b/i;
const INPUT_PATTERN = /\b(?:receive|intake|accept|collect|ingest|input|request|brief|requirements?)\b/i;
const ANALYSIS_PATTERN = /\b(?:analy[sz]e|assess|inspect|evaluate|review|diagnose|triage|research)\b/i;
const PROCESSING_PATTERN = /\b(?:process|transform|implement|execute|construct|generate|synthesize|resolve|calculate|draft|build)\b/i;
const OUTPUT_PATTERN = /\b(?:deliver|return|publish|present|emit|output|handoff|final report|final artifact)\b/i;
const NUMERIC_TARGET_PATTERN = /(?:^|\s)(?:<=|>=|<|>|=)?\s*\d+(?:\.\d+)?\s*(?:%|percent|ms|milliseconds?|s|seconds?|minutes?|hours?|days?|items?|cases?|requests?|records?|points?|errors?|incidents?|defects?|words?|pages?|runs?|samples?|users?|teams?|stakeholders?|\/\s*\w+)?\b/i;
const UNIT_OR_BASIS_PATTERN = /%|\b(?:percent|milliseconds?|seconds?|minutes?|hours?|days?|count|ratio|rate|average|mean|median|p\d{2}|score|points?|formula|calculated as|divided by|per\s+\w+|items?|cases?|requests?|records?|errors?|incidents?|defects?|words?|pages?)\b/i;
const INTERVAL_OR_POPULATION_PATTERN = /\b(?:per|each|every|daily|weekly|monthly|quarterly|annually|during|across|over|within|for all|all\s+\w+|evaluated population|sample(?:d)?|requests?|runs?|releases?|cases?|records?|users?|teams?|stakeholders?)\b/i;
const PASS_CONDITION_PATTERN = /\b(?:pass(?:es)? when|pass condition|target(?: is|:)|accepted when|acceptable when|met when|must be|must remain|at least|at most|no more than|no less than|exactly|below|above|under|within)\b|(?:<=|>=|<|>)\s*\d/i;

const DEFAULT_REFERENCE_DEFINITIONS: readonly ReferenceDefinition[] = [
  { canonicalName: 'React', categories: ['technology'], aliases: ['react'], officialHosts: ['react.dev'] },
  { canonicalName: 'Vue', categories: ['technology'], aliases: ['vue', 'vue.js'], officialHosts: ['vuejs.org'] },
  { canonicalName: 'Angular', categories: ['technology'], aliases: ['angular'], officialHosts: ['angular.dev', 'angular.io'] },
  { canonicalName: 'Svelte', categories: ['technology'], aliases: ['svelte', 'sveltekit'], officialHosts: ['svelte.dev'] },
  { canonicalName: 'Next.js', categories: ['technology'], aliases: ['next.js', 'nextjs'], officialHosts: ['nextjs.org'] },
  { canonicalName: 'Node.js', categories: ['technology'], aliases: ['node.js', 'nodejs'], officialHosts: ['nodejs.org'] },
  { canonicalName: 'TypeScript', categories: ['technology'], aliases: ['typescript'], officialHosts: ['typescriptlang.org'] },
  { canonicalName: 'JavaScript', categories: ['technology'], aliases: ['javascript'], officialHosts: ['developer.mozilla.org', 'ecma-international.org'] },
  { canonicalName: 'Python', categories: ['technology'], aliases: ['python'], officialHosts: ['python.org', 'docs.python.org'] },
  { canonicalName: 'Rust', categories: ['technology'], aliases: ['rust'], officialHosts: ['rust-lang.org', 'doc.rust-lang.org'] },
  { canonicalName: 'Go', categories: ['technology'], aliases: ['golang'], officialHosts: ['go.dev'] },
  { canonicalName: 'PostgreSQL', categories: ['technology'], aliases: ['postgresql', 'postgres'], officialHosts: ['postgresql.org'] },
  { canonicalName: 'MongoDB', categories: ['technology'], aliases: ['mongodb'], officialHosts: ['mongodb.com'] },
  { canonicalName: 'Redis', categories: ['technology'], aliases: ['redis'], officialHosts: ['redis.io'] },
  { canonicalName: 'SQLite', categories: ['technology'], aliases: ['sqlite'], officialHosts: ['sqlite.org'] },
  { canonicalName: 'Docker', categories: ['technology'], aliases: ['docker'], officialHosts: ['docker.com', 'docs.docker.com'] },
  { canonicalName: 'Kubernetes', categories: ['technology'], aliases: ['kubernetes', 'k8s'], officialHosts: ['kubernetes.io'] },
  { canonicalName: 'Terraform', categories: ['technology'], aliases: ['terraform'], officialHosts: ['terraform.io', 'developer.hashicorp.com'] },
  { canonicalName: 'AWS', categories: ['technology'], aliases: ['aws', 'amazon web services'], officialHosts: ['aws.amazon.com', 'docs.aws.amazon.com'] },
  { canonicalName: 'Google Cloud', categories: ['technology'], aliases: ['gcp', 'google cloud'], officialHosts: ['cloud.google.com'] },
  { canonicalName: 'Azure', categories: ['technology'], aliases: ['azure'], officialHosts: ['azure.microsoft.com', 'learn.microsoft.com'] },
  { canonicalName: 'Cloudflare', categories: ['technology'], aliases: ['cloudflare'], officialHosts: ['cloudflare.com', 'developers.cloudflare.com'] },
  { canonicalName: 'GitHub', categories: ['technology'], aliases: ['github'], officialHosts: ['github.com', 'docs.github.com'] },
  { canonicalName: 'GraphQL', categories: ['technology', 'framework'], aliases: ['graphql'], officialHosts: ['graphql.org'] },
  { canonicalName: 'gRPC', categories: ['technology'], aliases: ['grpc'], officialHosts: ['grpc.io'] },
  { canonicalName: 'WebSocket', categories: ['technology'], aliases: ['websocket', 'websockets'], officialHosts: ['websockets.spec.whatwg.org'] },
  { canonicalName: 'Vitest', categories: ['technology'], aliases: ['vitest'], officialHosts: ['vitest.dev'] },
  { canonicalName: 'Playwright', categories: ['technology'], aliases: ['playwright'], officialHosts: ['playwright.dev'] },
  { canonicalName: 'OpenAI', categories: ['technology'], aliases: ['openai', 'gpt'], officialHosts: ['openai.com', 'platform.openai.com'] },
  { canonicalName: 'Anthropic', categories: ['technology'], aliases: ['anthropic', 'claude'], officialHosts: ['anthropic.com', 'docs.anthropic.com'] },
  { canonicalName: 'Kafka', categories: ['technology'], aliases: ['apache kafka', 'kafka'], officialHosts: ['kafka.apache.org'] },
  { canonicalName: 'OAuth', categories: ['technology'], aliases: ['oauth', 'oauth2'], officialHosts: ['oauth.net', 'ietf.org', 'rfc-editor.org'] },
  { canonicalName: 'OpenID Connect', categories: ['technology'], aliases: ['openid connect', 'oidc'], officialHosts: ['openid.net'] },
  { canonicalName: 'OWASP', categories: ['framework'], aliases: ['owasp'], officialHosts: ['owasp.org'] },
  { canonicalName: 'SOLID', categories: ['framework'], aliases: ['solid principles', 'solid'], officialHosts: [] },
  { canonicalName: 'Domain-Driven Design', categories: ['framework'], aliases: ['domain-driven design', 'ddd'], officialHosts: ['domainlanguage.com'] },
  { canonicalName: 'Microservices', categories: ['framework'], aliases: ['microservices', 'microservice'], officialHosts: [] },
  { canonicalName: 'Event-Driven Architecture', categories: ['framework'], aliases: ['event-driven architecture', 'event driven architecture'], officialHosts: [] },
  { canonicalName: 'CQRS', categories: ['framework'], aliases: ['cqrs'], officialHosts: [] },
  { canonicalName: 'REST', categories: ['framework'], aliases: ['restful', 'rest api'], officialHosts: ['ietf.org', 'rfc-editor.org'] },
  { canonicalName: 'Test-Driven Development', categories: ['framework'], aliases: ['test-driven development', 'tdd'], officialHosts: [] },
  { canonicalName: 'Behavior-Driven Development', categories: ['framework'], aliases: ['behavior-driven development', 'behaviour-driven development', 'bdd'], officialHosts: [] },
  { canonicalName: 'Agile', categories: ['framework'], aliases: ['agile'], officialHosts: ['agilemanifesto.org'] },
  { canonicalName: 'Scrum', categories: ['framework'], aliases: ['scrum'], officialHosts: ['scrumguides.org'] },
  { canonicalName: 'Kanban', categories: ['framework'], aliases: ['kanban'], officialHosts: ['kanban.university'] },
  { canonicalName: 'Site Reliability Engineering', categories: ['framework'], aliases: ['site reliability engineering', 'sre'], officialHosts: ['sre.google'] },
  { canonicalName: 'Zero Trust', categories: ['framework'], aliases: ['zero trust', 'zero-trust'], officialHosts: ['nist.gov'] },
  { canonicalName: 'GitOps', categories: ['framework'], aliases: ['gitops'], officialHosts: ['opengitops.dev'] },
  { canonicalName: 'Threat Modeling', categories: ['methodology'], aliases: ['threat modeling', 'threat modelling'], officialHosts: ['owasp.org', 'nist.gov'] },
  { canonicalName: 'Risk Assessment', categories: ['methodology'], aliases: ['risk assessment'], officialHosts: ['nist.gov', 'iso.org'] },
  { canonicalName: 'Penetration Testing', categories: ['methodology'], aliases: ['penetration testing', 'penetration test'], officialHosts: ['owasp.org'] },
  { canonicalName: 'Code Review', categories: ['methodology'], aliases: ['code review'], officialHosts: [] },
  { canonicalName: 'Root Cause Analysis', categories: ['methodology'], aliases: ['root cause analysis', 'five whys'], officialHosts: ['asq.org'] },
  { canonicalName: 'User Stories', categories: ['methodology'], aliases: ['user story', 'user stories'], officialHosts: [] },
  { canonicalName: 'A/B Testing', categories: ['methodology'], aliases: ['a/b testing', 'a/b test'], officialHosts: [] },
  { canonicalName: 'Canary Release', categories: ['methodology'], aliases: ['canary release', 'canary deployment'], officialHosts: [] },
  { canonicalName: 'Blue-Green Deployment', categories: ['methodology'], aliases: ['blue-green deployment', 'blue green deployment'], officialHosts: [] },
  { canonicalName: 'Feature Flags', categories: ['methodology'], aliases: ['feature flag', 'feature flags'], officialHosts: [] },
  { canonicalName: 'Chaos Engineering', categories: ['methodology'], aliases: ['chaos engineering'], officialHosts: ['principlesofchaos.org'] },
  { canonicalName: 'Trunk-Based Development', categories: ['methodology'], aliases: ['trunk-based development'], officialHosts: ['trunkbaseddevelopment.com'] },
];

const GENERIC_OFFICIAL_HOSTS = [
  'nist.gov', 'w3.org', 'ietf.org', 'rfc-editor.org', 'iso.org', 'ecma-international.org',
  'whatwg.org', 'asq.org',
] as const;

function freezeArray<T>(values: T[]): readonly T[] {
  return Object.freeze(values);
}

function sourceRange(parseResult: AgentFileParseResult, start: number, end: number): SourceRange {
  return Object.freeze({
    start,
    end,
    startByte: Buffer.byteLength(parseResult.sourceText.slice(0, start), 'utf8'),
    endByte: Buffer.byteLength(parseResult.sourceText.slice(0, end), 'utf8'),
  });
}

function sectionTextStart(section: ExtractedAgentSection): number {
  const contentIndex = section.rawContent.indexOf(section.content);
  return section.bodyRange.start + Math.max(0, contentIndex);
}

function extractListItems(section: ExtractedAgentSection, parseResult: AgentFileParseResult): MutableItem[] {
  const text = section.rawContent;
  const lines: { start: number; end: number; text: string; indent: number; marker: string; ordinal: number | null }[] = [];
  let lineStart = 0;
  for (const lineWithBreak of text.split(/(?<=\n)/)) {
    const line = lineWithBreak.replace(/[\r\n]+$/, '');
    const markerMatch = /^(\s*)(?:(\d+)[.)]|([-*+])|(?:step\s+(\d+)\s*[:.)-]))\s+(.*)$/i.exec(line);
    if (markerMatch) {
      const ordinalText = markerMatch[2] ?? markerMatch[4] ?? null;
      lines.push({
        start: lineStart,
        end: lineStart + line.length,
        text: markerMatch[5] ?? '',
        indent: (markerMatch[1] ?? '').replace(/\t/g, '    ').length,
        marker: markerMatch[2] ? `${markerMatch[2]}.` : markerMatch[3] ?? `Step ${markerMatch[4]}`,
        ordinal: ordinalText === null ? null : Number(ordinalText),
      });
    }
    lineStart += lineWithBreak.length;
  }

  if (lines.length === 0) return [];
  const minimumIndent = Math.min(...lines.map((line) => line.indent));
  const topLevel = lines.filter((line) => line.indent === minimumIndent);
  const base = section.bodyRange.start;
  return topLevel.map((line, index) => {
    const next = topLevel[index + 1];
    const naturalEnd = next?.start ?? text.length;
    const trailingBlock = text.slice(line.end, naturalEnd);
    const detachedParagraph = /\r?\n\s*\r?\n(?=\S)/.exec(trailingBlock);
    const relativeEnd = detachedParagraph
      ? line.end + detachedParagraph.index
      : naturalEnd;
    const rawItem = text.slice(line.start, relativeEnd).trim();
    const itemText = rawItem
      .replace(/^\s*(?:(?:\d+)[.)]|[-*+]|step\s+\d+\s*[:.)-])\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      section: section.name,
      itemNumber: index + 1,
      marker: line.marker,
      ordinal: line.ordinal,
      text: itemText,
      start: base + line.start,
      end: base + relativeEnd,
    };
  });
}

function splitSentences(section: ExtractedAgentSection): MutableItem[] {
  const results: MutableItem[] = [];
  const text = section.content;
  const base = sectionTextStart(section);
  const pattern = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const leading = match[0].search(/\S/);
    if (leading < 0) continue;
    const trimmed = match[0].trim();
    results.push({
      section: section.name,
      itemNumber: results.length + 1,
      marker: null,
      ordinal: null,
      text: trimmed,
      start: base + match.index + leading,
      end: base + match.index + match[0].trimEnd().length,
    });
  }
  return results;
}

function normalizeToken(token: string): string {
  const normalized = token.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, '');
  if (normalized.length > 5 && normalized.endsWith('ies')) return `${normalized.slice(0, -3)}y`;
  if (normalized.length > 5 && normalized.endsWith('ing')) return normalized.slice(0, -3);
  if (normalized.length > 4 && normalized.endsWith('es')) return normalized.slice(0, -2);
  if (normalized.length > 4 && normalized.endsWith('s')) return normalized.slice(0, -1);
  return normalized;
}

function buildSpecialtyAnchors(specialty: string, explicit: readonly string[] = []): readonly string[] {
  const candidates = `${specialty} ${explicit.join(' ')}`.match(/[\p{L}\p{N}][\p{L}\p{N}+-]{2,}/gu) ?? [];
  return freezeArray([...new Set(candidates
    .map(normalizeToken)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)))].sort());
}

function isSpecialtySpecific(text: string, anchors: readonly string[]): boolean {
  const tokens = new Set((text.match(/[\p{L}\p{N}][\p{L}\p{N}+-]{2,}/gu) ?? []).map(normalizeToken));
  return anchors.some((anchor) => tokens.has(anchor));
}

function makeCriterion(
  criterion: AuthenticityCriterionName,
  passed: boolean,
  expected: string,
  actual: string,
): AuthenticityCriterionResult {
  return Object.freeze({ criterion, passed, expected, actual });
}

function makeItemEvidence(
  item: MutableItem,
  parseResult: AgentFileParseResult,
  specialtySpecific: boolean,
  checks: Record<string, boolean>,
): AuthenticityItemEvidence {
  return Object.freeze({
    section: item.section,
    itemNumber: item.itemNumber,
    marker: item.marker,
    text: item.text,
    sourceRange: sourceRange(parseResult, item.start, item.end),
    specialtySpecific,
    checks: Object.freeze({ ...checks }),
  });
}

function hostMatches(hostname: string, expected: string): boolean {
  const actual = hostname.toLowerCase().replace(/^www\./, '');
  const normalizedExpected = expected.toLowerCase().replace(/^www\./, '');
  return actual === normalizedExpected || actual.endsWith(`.${normalizedExpected}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasPattern(alias: string): RegExp {
  const body = escapeRegExp(alias).replace(/\\[\s-]+/g, '[\\s-]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

function mergeDefinitions(additional: readonly AdditionalReferenceDefinition[]): readonly ReferenceDefinition[] {
  const byName = new Map<string, ReferenceDefinition>();
  for (const definition of DEFAULT_REFERENCE_DEFINITIONS) {
    byName.set(definition.canonicalName.toLowerCase(), definition);
  }
  for (const definition of additional) {
    const key = definition.canonicalName.toLowerCase();
    const prior = byName.get(key);
    byName.set(key, {
      canonicalName: definition.canonicalName,
      categories: freezeArray([...new Set([...(prior?.categories ?? []), definition.category])].sort()),
      aliases: freezeArray([...new Set([...(prior?.aliases ?? []), ...definition.aliases])].sort()),
      officialHosts: freezeArray([...new Set([
        ...(prior?.officialHosts ?? []),
        ...(definition.officialHosts ?? []),
      ])].sort()),
    });
  }
  return freezeArray([...byName.values()].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)));
}

function contextForOffset(origin: TextOrigin, relativeOffset: number): {
  text: string;
  kind: 'sentence' | 'list-item' | 'specialty';
} {
  if (origin.origin === 'specialty') {
    return { text: origin.text.trim(), kind: 'specialty' };
  }
  const absoluteOffset = (origin.absoluteStart ?? 0) + relativeOffset;
  const containingItem = origin.items.find((item) => absoluteOffset >= item.start && absoluteOffset < item.end);
  if (containingItem) return { text: containingItem.text, kind: 'list-item' };

  let start = relativeOffset;
  while (start > 0 && !/[.!?\n]/.test(origin.text[start - 1] ?? '')) start -= 1;
  let end = relativeOffset;
  while (end < origin.text.length && !/[.!?\n]/.test(origin.text[end] ?? '')) end += 1;
  if (end < origin.text.length) end += 1;
  return { text: origin.text.slice(start, end).trim(), kind: 'sentence' };
}

function contextHasAssociation(
  context: string,
  origin: AgentSectionName | 'specialty',
  anchors: readonly string[],
): boolean {
  if (!isSpecialtySpecific(context, anchors)) return false;
  if (origin === 'Core Mission') return OBJECTIVE_PATTERN.test(context);
  if (origin === 'Critical Rules') return CONSTRAINT_PATTERN.test(context);
  if (origin === 'Technical Deliverables') {
    return OUTPUT_FORMAT_PATTERN.test(context) || COMPLETION_PATTERN.test(context);
  }
  if (origin === 'Workflow Process') {
    return OBJECTIVE_PATTERN.test(context) || DECISION_PATTERN.test(context) || ERROR_ACTION_PATTERN.test(context);
  }
  if (origin === 'Success Metrics') return NUMERIC_TARGET_PATTERN.test(context) && PASS_CONDITION_PATTERN.test(context);
  return RESPONSIBILITY_PATTERN.test(context) || CONSTRAINT_PATTERN.test(context);
}

function externalLinkMatches(text: string): {
  label: string;
  url: string;
  start: number;
  end: number;
  urlStart: number;
  urlEnd: number;
  named: boolean;
}[] {
  const matches: {
    label: string;
    url: string;
    start: number;
    end: number;
    urlStart: number;
    urlEnd: number;
    named: boolean;
  }[] = [];
  const occupied: [number, number][] = [];
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = markdown.exec(text)) !== null) {
    const urlStart = match.index + match[0].indexOf(match[2]!);
    matches.push({
      label: match[1]!.trim(),
      url: match[2]!,
      start: match.index,
      end: markdown.lastIndex,
      urlStart,
      urlEnd: urlStart + match[2]!.length,
      named: true,
    });
    occupied.push([match.index, markdown.lastIndex]);
  }
  const urlPattern = /<?(https?:\/\/[^\s)>]+)>?/gi;
  while ((match = urlPattern.exec(text)) !== null) {
    if (occupied.some(([start, end]) => match!.index >= start && match!.index < end)) continue;
    const urlStart = match.index + match[0].indexOf(match[1]!);
    matches.push({
      label: match[1]!,
      url: match[1]!,
      start: match.index,
      end: urlPattern.lastIndex,
      urlStart,
      urlEnd: urlStart + match[1]!.length,
      named: false,
    });
  }
  return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

function officialReferenceResult(
  label: string,
  url: string,
  named: boolean,
  definitions: readonly ReferenceDefinition[],
  additionalOfficialHosts: readonly string[],
): { official: boolean; reason: string; canonicalName: string } {
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return { official: false, reason: 'Official references must use a resolvable HTTPS URL', canonicalName: label };
    }
    hostname = parsed.hostname;
  } catch {
    return { official: false, reason: 'Reference URL is not resolvable', canonicalName: label };
  }
  if (!named) {
    return { official: false, reason: 'Official references require a named citation, not a bare URL', canonicalName: label };
  }

  const normalizedLabel = label.toLowerCase();
  const definition = definitions.find((candidate) =>
    candidate.aliases.some((alias) => normalizedLabel.includes(alias.toLowerCase()))
    || normalizedLabel.includes(candidate.canonicalName.toLowerCase()));
  const acceptedHosts = [
    ...(definition?.officialHosts ?? []),
    ...GENERIC_OFFICIAL_HOSTS,
    ...additionalOfficialHosts,
  ];
  if (acceptedHosts.some((host) => hostMatches(hostname, host))) {
    return {
      official: true,
      reason: `${hostname} is an authority domain for ${definition?.canonicalName ?? label}`,
      canonicalName: definition?.canonicalName ?? label,
    };
  }

  const brandTokens = normalizedLabel.match(/[a-z0-9]{3,}/g) ?? [];
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]/g, '');
  if (brandTokens.some((token) => normalizedHost.includes(token))) {
    return { official: true, reason: `${hostname} matches the named publisher`, canonicalName: definition?.canonicalName ?? label };
  }
  return {
    official: false,
    reason: `${hostname} is not an authority domain for ${definition?.canonicalName ?? label}`,
    canonicalName: definition?.canonicalName ?? label,
  };
}

function extractReferences(
  input: AuthenticityValidationInput,
  anchors: readonly string[],
  origins: readonly TextOrigin[],
  definitions: readonly ReferenceDefinition[],
): ReferenceClassification {
  const occurrences: ReferenceOccurrence[] = [];

  for (const origin of origins) {
    const links = externalLinkMatches(origin.text);
    const candidates: { definition: ReferenceDefinition; alias: string; start: number; end: number; text: string }[] = [];
    for (const definition of definitions) {
      for (const alias of definition.aliases) {
        const pattern = aliasPattern(alias);
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(origin.text)) !== null) {
          const insideUrl = links.some((link) => match!.index >= link.urlStart && pattern.lastIndex <= link.urlEnd);
          if (!insideUrl) {
            candidates.push({ definition, alias, start: match.index, end: pattern.lastIndex, text: match[0] });
          }
        }
      }
    }
    candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.alias.localeCompare(b.alias));
    const accepted: typeof candidates = [];
    for (const candidate of candidates) {
      const overlap = accepted.find((prior) => candidate.start < prior.end && candidate.end > prior.start);
      if (!overlap) {
        accepted.push(candidate);
      } else if (overlap.start === candidate.start && overlap.end === candidate.end
        && overlap.definition.canonicalName === candidate.definition.canonicalName) {
        continue;
      }
    }

    for (const candidate of accepted) {
      const context = contextForOffset(origin, candidate.start);
      const associated = contextHasAssociation(context.text, origin.origin, anchors);
      const absoluteStart = origin.absoluteStart === null ? null : origin.absoluteStart + candidate.start;
      occurrences.push(Object.freeze({
        canonicalName: candidate.definition.canonicalName,
        matchedText: candidate.text,
        categories: freezeArray([...candidate.definition.categories]),
        origin: origin.origin,
        sourceRange: absoluteStart === null
          ? null
          : sourceRange(input.parseResult, absoluteStart, absoluteStart + candidate.text.length),
        contextUnit: context.text,
        contextKind: context.kind,
        contextuallyAssociated: associated,
        url: null,
        official: null,
        officialReason: null,
      }));
    }

    for (const link of links) {
      const official = officialReferenceResult(
        link.label,
        link.url,
        link.named,
        definitions,
        input.additionalOfficialHosts ?? [],
      );
      const context = contextForOffset(origin, link.start);
      const associated = contextHasAssociation(context.text, origin.origin, anchors);
      const absoluteStart = origin.absoluteStart === null ? null : origin.absoluteStart + link.start;
      occurrences.push(Object.freeze({
        canonicalName: official.canonicalName,
        matchedText: link.label,
        categories: Object.freeze(['external'] as const),
        origin: origin.origin,
        sourceRange: absoluteStart === null ? null : sourceRange(input.parseResult, absoluteStart, absoluteStart + (link.end - link.start)),
        contextUnit: context.text,
        contextKind: context.kind,
        contextuallyAssociated: associated,
        url: link.url,
        official: official.official,
        officialReason: official.reason,
      }));
    }
  }

  occurrences.sort((a, b) => {
    const originOrder = (value: AgentSectionName | 'specialty'): number =>
      value === 'specialty' ? -1 : SECTION_ORDER.indexOf(value);
    return originOrder(a.origin) - originOrder(b.origin)
      || (a.sourceRange?.start ?? -1) - (b.sourceRange?.start ?? -1)
      || a.canonicalName.localeCompare(b.canonicalName)
      || a.categories.join(',').localeCompare(b.categories.join(','));
  });

  const disconnectedReferences = occurrences
    .filter((occurrence) => !occurrence.contextuallyAssociated && occurrence.origin !== 'specialty')
    .map((occurrence) => Object.freeze({
      code: 'IRRELEVANT_KEYWORD_STUFFING' as const,
      sourcePath: input.sourcePath,
      reference: occurrence.canonicalName,
      origin: occurrence.origin,
      sourceRange: occurrence.sourceRange,
      contextUnit: occurrence.contextUnit,
      message: `Reference ${occurrence.canonicalName} in ${occurrence.origin} lacks a same-sentence or list-item association with specialty ${input.specialty}`,
    }));
  const domainReferences = occurrences.filter((occurrence) =>
    occurrence.categories.some((category) => category === 'technology' || category === 'framework' || category === 'methodology'));

  return Object.freeze({
    referenceFree: domainReferences.length === 0,
    domainPatternMinimaApplicable: domainReferences.length > 0,
    contextualAssociationApplicable: occurrences.length > 0,
    occurrences: freezeArray(occurrences),
    disconnectedReferences: freezeArray(disconnectedReferences),
  });
}

function itemCountActual(items: readonly MutableItem[]): string {
  return `${items.length} item${items.length === 1 ? '' : 's'}`;
}

/**
 * Validates all measurable section-authenticity and reference-association rules.
 * The result is exhaustive: one failed criterion or item never suppresses another.
 */
export function validateAgentAuthenticity(input: AuthenticityValidationInput): AuthenticityValidation {
  const { parseResult } = input;
  const anchors = buildSpecialtyAnchors(input.specialty, input.specialtyAnchors);
  const criteria = {} as Record<AuthenticityCriterionName, AuthenticityCriterionResult>;
  const findings: AuthenticityFinding[] = [];
  const sectionItems = {} as Record<AgentSectionName, readonly AuthenticityItemEvidence[]>;

  const addFinding = (
    code: string,
    criterion: AuthenticityCriterionName,
    message: string,
    section: AgentSectionName | null,
    itemNumber: number | null = null,
  ): void => {
    findings.push(Object.freeze({
      code,
      sourcePath: input.sourcePath,
      criterion,
      section,
      itemNumber,
      classification: 'blocking',
      message,
    }));
  };

  const sectionOrNull = (name: AgentSectionName): ExtractedAgentSection | null => parseResult.sections[name];
  const identitySection = sectionOrNull('Identity');
  const identitySentences = identitySection ? splitSentences(identitySection) : [];
  const identityEvidence = identitySentences.map((item) => {
    const specialtySpecific = isSpecialtySpecific(item.text, anchors);
    return makeItemEvidence(item, parseResult, specialtySpecific, {
      role: ROLE_PATTERN.test(item.text),
      responsibility: RESPONSIBILITY_PATTERN.test(item.text),
      behavioralBoundary: CONSTRAINT_PATTERN.test(item.text),
    });
  });
  sectionItems.Identity = freezeArray(identityEvidence);
  criteria.identitySentenceRange = makeCriterion('identitySentenceRange', identitySentences.length >= 2 && identitySentences.length <= 4, '2-4 sentences', `${identitySentences.length} sentences`);
  criteria.identityRoleAndSpecialty = makeCriterion('identityRoleAndSpecialty', identityEvidence.some((item) => item.checks.role) && identityEvidence.some((item) => item.specialtySpecific), 'an explicit role and declared-specialty anchor', `role=${identityEvidence.some((item) => item.checks.role)}, specialty=${identityEvidence.some((item) => item.specialtySpecific)}`);
  const responsibilityCount = identityEvidence.filter((item) => item.specialtySpecific && item.checks.responsibility).length;
  criteria.identityResponsibilities = makeCriterion('identityResponsibilities', responsibilityCount >= 2, 'at least 2 specialty-specific responsibilities', `${responsibilityCount} specialty-specific responsibilities`);
  criteria.identityBehavioralBoundaries = makeCriterion('identityBehavioralBoundaries', identityEvidence.some((item) => item.checks.behavioralBoundary), 'explicit constraint language defining a behavioral boundary', `${identityEvidence.filter((item) => item.checks.behavioralBoundary).length} boundaries`);

  const coreSection = sectionOrNull('Core Mission');
  const coreItems = coreSection ? extractListItems(coreSection, parseResult) : [];
  const coreEvidence = coreItems.map((item) => {
    const specialtySpecific = isSpecialtySpecific(item.text, anchors);
    return makeItemEvidence(item, parseResult, specialtySpecific, {
      numbered: item.ordinal !== null,
      objective: OBJECTIVE_PATTERN.test(item.text),
    });
  });
  sectionItems['Core Mission'] = freezeArray(coreEvidence);
  criteria.coreMissionObjectiveRange = makeCriterion('coreMissionObjectiveRange', coreItems.length >= 3 && coreItems.length <= 5, '3-5 objectives', itemCountActual(coreItems));
  criteria.coreMissionNumbering = makeCriterion('coreMissionNumbering', coreItems.length > 0 && coreItems.every((item) => item.ordinal !== null), 'every objective uses a numbered marker', `${coreItems.filter((item) => item.ordinal !== null).length}/${coreItems.length} numbered`);
  criteria.coreMissionSpecialtyObjectives = makeCriterion('coreMissionSpecialtyObjectives', coreEvidence.length > 0 && coreEvidence.every((item) => item.specialtySpecific && item.checks.objective), 'every objective is action-oriented and specialty-specific', `${coreEvidence.filter((item) => item.specialtySpecific && item.checks.objective).length}/${coreEvidence.length} complete`);

  const rulesSection = sectionOrNull('Critical Rules');
  const ruleItems = rulesSection ? extractListItems(rulesSection, parseResult) : [];
  const ruleEvidence = ruleItems.map((item) => makeItemEvidence(item, parseResult, isSpecialtySpecific(item.text, anchors), {
    explicitConstraint: CONSTRAINT_PATTERN.test(item.text),
  }));
  sectionItems['Critical Rules'] = freezeArray(ruleEvidence);
  criteria.criticalRuleRange = makeCriterion('criticalRuleRange', ruleItems.length >= 5 && ruleItems.length <= 8, '5-8 operational constraints', itemCountActual(ruleItems));
  criteria.criticalRuleConstraints = makeCriterion('criticalRuleConstraints', ruleEvidence.length > 0 && ruleEvidence.every((item) => item.checks.explicitConstraint), 'every rule contains explicit constraint language', `${ruleEvidence.filter((item) => item.checks.explicitConstraint).length}/${ruleEvidence.length} explicit`);

  const deliverableSection = sectionOrNull('Technical Deliverables');
  const deliverableItems = deliverableSection ? extractListItems(deliverableSection, parseResult) : [];
  const deliverableEvidence = deliverableItems.map((item) => makeItemEvidence(item, parseResult, isSpecialtySpecific(item.text, anchors), {
    outputFormat: OUTPUT_FORMAT_PATTERN.test(item.text),
    requiredComponents: COMPONENT_PATTERN.test(item.text),
    observableCompletion: COMPLETION_PATTERN.test(item.text),
  }));
  sectionItems['Technical Deliverables'] = freezeArray(deliverableEvidence);
  criteria.technicalDeliverableRange = makeCriterion('technicalDeliverableRange', deliverableItems.length >= 4 && deliverableItems.length <= 6, '4-6 concrete artifacts', itemCountActual(deliverableItems));
  criteria.technicalDeliverableCompleteness = makeCriterion('technicalDeliverableCompleteness', deliverableEvidence.length > 0 && deliverableEvidence.every((item) => item.specialtySpecific && Object.values(item.checks).every(Boolean)), 'every specialty-specific artifact has an output format, required components, and observable completion criterion', `${deliverableEvidence.filter((item) => item.specialtySpecific && Object.values(item.checks).every(Boolean)).length}/${deliverableEvidence.length} complete`);

  const workflowSection = sectionOrNull('Workflow Process');
  const workflowItems = workflowSection ? extractListItems(workflowSection, parseResult) : [];
  const workflowEvidence = workflowItems.map((item) => makeItemEvidence(item, parseResult, isSpecialtySpecific(item.text, anchors), {
    decisionGate: DECISION_PATTERN.test(item.text),
    errorBranch: ERROR_TRIGGER_PATTERN.test(item.text) && ERROR_ACTION_PATTERN.test(item.text),
    boundedLoop: ITERATION_PATTERN.test(item.text) && MAX_ITERATION_PATTERN.test(item.text) && EARLY_EXIT_PATTERN.test(item.text),
    receivesInput: INPUT_PATTERN.test(item.text),
    analyzes: ANALYSIS_PATTERN.test(item.text),
    processes: PROCESSING_PATTERN.test(item.text),
    deliversOutput: OUTPUT_PATTERN.test(item.text),
  }));
  sectionItems['Workflow Process'] = freezeArray(workflowEvidence);
  const sequential = workflowItems.length > 0 && workflowItems.every((item, index) => item.ordinal === index + 1);
  criteria.workflowStepRange = makeCriterion('workflowStepRange', workflowItems.length >= 5 && workflowItems.length <= 7, '5-7 workflow steps', itemCountActual(workflowItems));
  criteria.workflowSequentialOrder = makeCriterion('workflowSequentialOrder', sequential, 'ordered steps numbered consecutively from 1', workflowItems.map((item) => item.ordinal ?? item.marker ?? 'unmarked').join(', '));
  const pipelineChecks = ['receivesInput', 'analyzes', 'processes', 'deliversOutput'] as const;
  criteria.workflowPipelineCompleteness = makeCriterion('workflowPipelineCompleteness', pipelineChecks.every((check) => workflowEvidence.some((item) => item.checks[check])), 'input receipt, analysis, processing, and output delivery', pipelineChecks.filter((check) => workflowEvidence.some((item) => item.checks[check])).join(', ') || 'none');
  const gateCount = workflowEvidence.filter((item) => item.checks.decisionGate).length;
  criteria.workflowDecisionGates = makeCriterion('workflowDecisionGates', gateCount >= 2, 'at least 2 decision gates', `${gateCount} decision gates`);
  const errorCount = workflowEvidence.filter((item) => item.checks.errorBranch).length;
  criteria.workflowErrorBranch = makeCriterion('workflowErrorBranch', errorCount >= 1, 'at least 1 error branch with a response action', `${errorCount} error branches`);
  const boundedLoopCount = workflowEvidence.filter((item) => item.checks.boundedLoop).length;
  criteria.workflowBoundedLoop = makeCriterion('workflowBoundedLoop', boundedLoopCount >= 1, 'a loop with an explicit maximum iteration count and early exit condition', `${boundedLoopCount} complete bounded loops`);

  const metricsSection = sectionOrNull('Success Metrics');
  const metricItems = metricsSection ? extractListItems(metricsSection, parseResult) : [];
  const metricEvidence = metricItems.map((item) => makeItemEvidence(item, parseResult, isSpecialtySpecific(item.text, anchors), {
    numericTarget: NUMERIC_TARGET_PATTERN.test(item.text),
    unitOrCalculationBasis: UNIT_OR_BASIS_PATTERN.test(item.text),
    intervalOrPopulation: INTERVAL_OR_POPULATION_PATTERN.test(item.text),
    explicitPassCondition: PASS_CONDITION_PATTERN.test(item.text),
  }));
  sectionItems['Success Metrics'] = freezeArray(metricEvidence);
  criteria.successMetricRange = makeCriterion('successMetricRange', metricItems.length >= 4 && metricItems.length <= 6, '4-6 metrics', itemCountActual(metricItems));
  criteria.successMetricCompleteness = makeCriterion('successMetricCompleteness', metricEvidence.length > 0 && metricEvidence.every((item) => item.specialtySpecific && Object.values(item.checks).every(Boolean)), 'every specialty metric has a numeric target, unit or calculation basis, interval or population, and explicit pass condition', `${metricEvidence.filter((item) => item.specialtySpecific && Object.values(item.checks).every(Boolean)).length}/${metricEvidence.length} complete`);

  const origins: TextOrigin[] = [{ origin: 'specialty', text: input.specialty, absoluteStart: null, items: [] }];
  for (const name of SECTION_ORDER) {
    const section = sectionOrNull(name);
    if (!section) continue;
    origins.push({
      origin: name,
      text: section.rawContent,
      absoluteStart: section.bodyRange.start,
      items: name === 'Identity' ? identitySentences : name === 'Core Mission' ? coreItems
        : name === 'Critical Rules' ? ruleItems : name === 'Technical Deliverables' ? deliverableItems
          : name === 'Workflow Process' ? workflowItems : metricItems,
    });
  }
  const definitions = mergeDefinitions(input.additionalReferences ?? []);
  const references = extractReferences(input, anchors, origins, definitions);
  const externalReferences = references.occurrences.filter((reference) => reference.categories.includes('external'));
  const officialCount = externalReferences.filter((reference) => reference.official).length;
  criteria.officialReferences = makeCriterion('officialReferences', externalReferences.every((reference) => reference.official === true), 'every external reference is a named HTTPS citation from its owner, standards body, or steward', `${officialCount}/${externalReferences.length} official`);
  criteria.contextualAssociations = makeCriterion('contextualAssociations', references.disconnectedReferences.length === 0, references.contextualAssociationApplicable ? 'every reference has a same-sentence or list-item specialty association' : 'not applicable and satisfied when no references are present', references.contextualAssociationApplicable ? `${references.disconnectedReferences.length} disconnected references` : 'not applicable');

  const criterionDetails: readonly [AuthenticityCriterionName, string, AgentSectionName | null][] = [
    ['identitySentenceRange', 'IDENTITY_SENTENCE_RANGE', 'Identity'],
    ['identityRoleAndSpecialty', 'IDENTITY_ROLE_SPECIALTY', 'Identity'],
    ['identityResponsibilities', 'IDENTITY_RESPONSIBILITIES', 'Identity'],
    ['identityBehavioralBoundaries', 'IDENTITY_BOUNDARIES', 'Identity'],
    ['coreMissionObjectiveRange', 'CORE_MISSION_OBJECTIVE_RANGE', 'Core Mission'],
    ['coreMissionNumbering', 'CORE_MISSION_NUMBERING', 'Core Mission'],
    ['coreMissionSpecialtyObjectives', 'CORE_MISSION_SPECIALTY_OBJECTIVES', 'Core Mission'],
    ['criticalRuleRange', 'CRITICAL_RULE_RANGE', 'Critical Rules'],
    ['criticalRuleConstraints', 'CRITICAL_RULE_CONSTRAINTS', 'Critical Rules'],
    ['technicalDeliverableRange', 'TECHNICAL_DELIVERABLE_RANGE', 'Technical Deliverables'],
    ['technicalDeliverableCompleteness', 'TECHNICAL_DELIVERABLE_INCOMPLETE', 'Technical Deliverables'],
    ['workflowStepRange', 'WORKFLOW_STEP_RANGE', 'Workflow Process'],
    ['workflowSequentialOrder', 'WORKFLOW_SEQUENCE', 'Workflow Process'],
    ['workflowPipelineCompleteness', 'WORKFLOW_PIPELINE_INCOMPLETE', 'Workflow Process'],
    ['workflowDecisionGates', 'WORKFLOW_DECISION_GATES', 'Workflow Process'],
    ['workflowErrorBranch', 'WORKFLOW_ERROR_BRANCH', 'Workflow Process'],
    ['workflowBoundedLoop', 'WORKFLOW_BOUNDED_LOOP', 'Workflow Process'],
    ['successMetricRange', 'SUCCESS_METRIC_RANGE', 'Success Metrics'],
    ['successMetricCompleteness', 'SUCCESS_METRIC_INCOMPLETE', 'Success Metrics'],
    ['officialReferences', 'UNOFFICIAL_EXTERNAL_REFERENCE', null],
    ['contextualAssociations', 'REFERENCE_CONTEXT_MISSING', null],
  ];
  for (const [criterionName, code, section] of criterionDetails) {
    const result = criteria[criterionName];
    if (!result.passed) addFinding(code, criterionName, `Expected ${result.expected}; found ${result.actual}`, section);
  }

  const addIncompleteItemFindings = (
    criterionName: AuthenticityCriterionName,
    code: string,
    items: readonly AuthenticityItemEvidence[],
    complete: (item: AuthenticityItemEvidence) => boolean,
  ): void => {
    for (const item of items.filter((candidate) => !complete(candidate))) {
      addFinding(code, criterionName, `Item ${item.itemNumber} is incomplete: ${item.text}`, item.section, item.itemNumber);
    }
  };
  addIncompleteItemFindings('coreMissionSpecialtyObjectives', 'CORE_MISSION_OBJECTIVE_INCOMPLETE', coreEvidence, (item) => item.specialtySpecific && item.checks.objective);
  addIncompleteItemFindings('criticalRuleConstraints', 'CRITICAL_RULE_ITEM_NOT_CONSTRAINT', ruleEvidence, (item) => item.checks.explicitConstraint);
  addIncompleteItemFindings('technicalDeliverableCompleteness', 'TECHNICAL_DELIVERABLE_ITEM_INCOMPLETE', deliverableEvidence, (item) => item.specialtySpecific && Object.values(item.checks).every(Boolean));
  addIncompleteItemFindings('successMetricCompleteness', 'SUCCESS_METRIC_ITEM_INCOMPLETE', metricEvidence, (item) => item.specialtySpecific && Object.values(item.checks).every(Boolean));

  for (const occurrence of externalReferences.filter((reference) => reference.official !== true)) {
    addFinding('UNOFFICIAL_REFERENCE_OCCURRENCE', 'officialReferences', `${occurrence.matchedText}: ${occurrence.officialReason}`, occurrence.origin === 'specialty' ? null : occurrence.origin);
  }
  for (const disconnected of references.disconnectedReferences) {
    addFinding('IRRELEVANT_KEYWORD_STUFFING', 'contextualAssociations', disconnected.message, disconnected.origin === 'specialty' ? null : disconnected.origin);
  }

  findings.sort((a, b) => (a.section === null ? SECTION_ORDER.length : SECTION_ORDER.indexOf(a.section))
    - (b.section === null ? SECTION_ORDER.length : SECTION_ORDER.indexOf(b.section))
    || (a.itemNumber ?? 0) - (b.itemNumber ?? 0)
    || a.code.localeCompare(b.code));

  return Object.freeze({
    sourcePath: input.sourcePath,
    valid: Object.values(criteria).every((result) => result.passed),
    criteria: Object.freeze(criteria),
    sectionItems: Object.freeze(sectionItems),
    references,
    findings: freezeArray(findings),
  });
}

export const AUTHENTICITY_REFERENCE_DEFINITIONS = Object.freeze(
  DEFAULT_REFERENCE_DEFINITIONS.map((definition) => Object.freeze({
    canonicalName: definition.canonicalName,
    categories: freezeArray([...definition.categories]),
    aliases: freezeArray([...definition.aliases]),
    officialHosts: freezeArray([...definition.officialHosts]),
  })),
);
