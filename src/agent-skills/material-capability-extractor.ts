/**
 * Material Capability Extractor
 *
 * Inspects department anchors, specialty responsibilities/expertise, recovered
 * prompt capabilities/technologies, workflow operations, and deliverable
 * dependencies. Requires materiality claims, excludes disconnected keyword
 * repetition, merges canonical capability keys, preserves all sorted evidence
 * spans/origins, and supports recovered prompts without fabricating capabilities
 * after unrecoverable parsing.
 *
 * Requirements: 10.4–10.7, 10.16, 10.18
 */

import { normalizeText } from './skill-taxonomy';

// ─────────────────────────────────────────────
// Types and Interfaces
// ─────────────────────────────────────────────

/** Named section identifiers matching agent-file-parser. */
export type NamedSection =
  | 'Identity'
  | 'Core Mission'
  | 'Critical Rules'
  | 'Technical Deliverables'
  | 'Workflow Process'
  | 'Success Metrics';

/** Origin of a capability evidence span. */
export type CapabilityOrigin =
  | 'department'
  | 'specialty'
  | 'system-prompt-capability'
  | 'system-prompt-technology'
  | 'deliverable';

/** Materiality classification for a capability claim. */
export type MaterialityKind =
  | 'responsibility'
  | 'supported-operation'
  | 'required-expertise'
  | 'deliverable-dependency';

/**
 * Evidence supporting one occurrence of a material capability claim.
 */
export interface CapabilityEvidence {
  readonly origin: CapabilityOrigin;
  readonly sourcePath?: string | undefined;
  readonly section?: NamedSection | undefined;
  readonly normalizedText: string;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
}

/**
 * A material capability extracted from an agent definition.
 * A noun mention becomes material only when its sentence/list item claims
 * responsibility, supported operation, required expertise, or a deliverable
 * dependency. Disconnected keyword repetition is excluded.
 */
export interface MaterialCapability {
  readonly capabilityKey: string;
  readonly displayName: string;
  readonly materiality: MaterialityKind;
  readonly evidence: readonly CapabilityEvidence[];
}

/**
 * Input for material capability extraction.
 */
export interface CapabilityExtractionInput {
  /** Agent department as a broad domain anchor. */
  readonly department?: string | undefined;
  /** Agent specialty text with responsibility/expertise clauses. */
  readonly specialty?: string | undefined;
  /** Recovered system prompt text (null means unrecoverable). */
  readonly systemPrompt?: string | null | undefined;
  /** Individual section contents keyed by section name. */
  readonly sectionContents?: Readonly<Partial<Record<NamedSection, string | null>>> | undefined;
  /** Source path for evidence attribution. */
  readonly sourcePath?: string | undefined;
}

/**
 * Result of material capability extraction.
 */
export interface CapabilityExtractionResult {
  /** Merged, deduplicated, sorted material capabilities. */
  readonly capabilities: readonly MaterialCapability[];
  /** Whether extraction proceeded from a recovered prompt. */
  readonly fromRecoveredPrompt: boolean;
  /** Whether extraction was blocked by unrecoverable parsing. */
  readonly blocked: boolean;
  /** Disconnected keyword mentions excluded from material capabilities. */
  readonly excludedKeywords: readonly string[];
}

// ─────────────────────────────────────────────
// Materiality Verb Patterns
// ─────────────────────────────────────────────

/**
 * Patterns indicating a responsibility claim in a sentence/list item.
 * A noun must co-occur with one of these to be considered material.
 */
const RESPONSIBILITY_VERBS = /\b(?:responsible for|accountable for|own(?:s|ing)?|lead(?:s|ing)?|manage(?:s|ing)?|develop(?:s|ing)?|maintain(?:s|ing)?|deliver(?:s|ing)?|coordinate(?:s|ing)?|implement(?:s|ing)?|design(?:s|ing)?|architect(?:s|ing)?|build(?:s|ing)?|create(?:s|ing)?|produce(?:s|ing)?)\b/i;

/**
 * Patterns indicating a supported operation claim.
 */
const OPERATION_VERBS = /\b(?:perform(?:s|ing)?|execute(?:s|ing)?|run(?:s|ning)?|conduct(?:s|ing)?|process(?:es|ing)?|handle(?:s|ing)?|operate(?:s|ing)?|apply(?:s|ing)?|configure(?:s|ing)?|deploy(?:s|ing)?|provision(?:s|ing)?|orchestrat(?:e|es|ing)|automat(?:e|es|ing)|integrat(?:e|es|ing)|monitor(?:s|ing)?|analyz(?:e|es|ing)|optimiz(?:e|es|ing)|transform(?:s|ing)?)\b/i;

/**
 * Patterns indicating required expertise.
 */
const EXPERTISE_VERBS = /\b(?:expert(?:ise)? in|speciali[sz](?:e|es|ed|ing) in|proficien(?:t|cy) (?:in|with)|deep (?:expertise|knowledge|understanding)|(?:fluent|experienced|skilled|versed) (?:in|with)|master(?:y|s|ing)? (?:of|in)|focus(?:es|ing)? on)\b/i;

/**
 * Patterns indicating deliverable dependency.
 */
const DELIVERABLE_VERBS = /\b(?:requir(?:e|es|ing)|depend(?:s|ing)? on|rely(?:s|ing)? on|leverag(?:e|es|ing)|utiliz(?:e|es|ing)|consum(?:e|es|ing)|incorporat(?:e|es|ing)|based on|built (?:on|with|using)|powered by|driven by|using)\b/i;

/**
 * Combined pattern matching any materiality claim.
 * Used by external consumers to check if a text unit contains any materiality verb.
 */
export const ANY_MATERIALITY_VERB = new RegExp(
  `${RESPONSIBILITY_VERBS.source}|${OPERATION_VERBS.source}|${EXPERTISE_VERBS.source}|${DELIVERABLE_VERBS.source}`,
  'i',
);

// ─────────────────────────────────────────────
// False-Positive Noun Exclusions
// ─────────────────────────────────────────────

/**
 * Common nouns that should not become capability keys even when
 * co-occurring with materiality verbs. These are too generic to
 * represent a real material capability.
 */
const FALSE_POSITIVE_NOUNS = new Set([
  'things', 'stuff', 'data', 'information', 'work', 'tasks',
  'items', 'results', 'output', 'input', 'content', 'files',
  'code', 'solutions', 'systems', 'services', 'tools', 'resources',
  'projects', 'changes', 'updates', 'requests', 'responses',
  'issues', 'problems', 'errors', 'messages', 'events', 'actions',
]);

// ─────────────────────────────────────────────
// Technology/Capability Noun Patterns
// ─────────────────────────────────────────────

/**
 * Pattern to extract technology/capability noun phrases from text.
 * Matches capitalized terms, hyphenated compound terms, and domain terms.
 */
const TECH_NOUN_PATTERN = /\b(?:[A-Z][a-zA-Z0-9]*(?:[.-][A-Za-z0-9]+)*|[a-z]+(?:-[a-z]+)+)\b/g;

/**
 * Pattern for domain-specific multi-word terms that indicate capability areas.
 */
const CAPABILITY_PHRASE_PATTERNS: readonly RegExp[] = [
  /\b(?:machine learning|deep learning|natural language processing|computer vision)\b/gi,
  /\b(?:data (?:engineering|pipeline|modeling|analytics|science|visualization))\b/gi,
  /\b(?:cloud (?:computing|infrastructure|architecture|native))\b/gi,
  /\b(?:web (?:development|scraping|services|applications))\b/gi,
  /\b(?:mobile (?:development|applications|apps))\b/gi,
  /\b(?:security (?:testing|auditing|analysis|engineering))\b/gi,
  /\b(?:performance (?:testing|optimization|tuning|monitoring))\b/gi,
  /\b(?:test (?:automation|strategy|planning|execution))\b/gi,
  /\b(?:code (?:review|generation|analysis|quality))\b/gi,
  /\b(?:API (?:design|development|integration|testing))\b/gi,
  /\b(?:database (?:design|administration|optimization|migration))\b/gi,
  /\b(?:user (?:experience|interface|research|testing))\b/gi,
  /\b(?:project (?:management|planning|coordination|delivery))\b/gi,
  /\b(?:system (?:design|architecture|integration|administration))\b/gi,
  /\b(?:DevOps|CI\/CD|continuous (?:integration|delivery|deployment))\b/gi,
  /\b(?:containerization|microservices?|serverless|event.driven)\b/gi,
  /\b(?:agile|scrum|kanban|waterfall|lean)\b/gi,
  /\b(?:REST(?:ful)?|GraphQL|gRPC|WebSocket|SOAP)\b/gi,
];

// ─────────────────────────────────────────────
// Context Unit Extraction
// ─────────────────────────────────────────────

/**
 * Splits text into context units (sentences and list items).
 * A material claim must be within a single context unit.
 */
function extractContextUnits(text: string): Array<{ text: string; start: number; end: number }> {
  const units: Array<{ text: string; start: number; end: number }> = [];

  // Split by list-item markers or sentence boundaries
  const listItemPattern = /^[ \t]*(?:[-*+]|\d+[.)])\s+/gm;
  const lines = text.split('\n');
  let offset = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      offset += line.length + 1;
      continue;
    }

    if (listItemPattern.test(line)) {
      listItemPattern.lastIndex = 0;
      units.push({ text: trimmed, start: offset, end: offset + line.length });
    } else {
      // Split by sentence boundaries within non-list text
      const sentences = splitSentences(line);
      let sentenceStart = offset;
      for (const sentence of sentences) {
        if (sentence.trim().length > 0) {
          units.push({
            text: sentence.trim(),
            start: sentenceStart,
            end: sentenceStart + sentence.length,
          });
        }
        sentenceStart += sentence.length;
      }
    }
    offset += line.length + 1;
  }

  return units;
}

/**
 * Splits a line into sentences using common sentence boundary heuristics.
 */
function splitSentences(text: string): string[] {
  // Split on period/exclamation/question followed by space and uppercase
  // or end of string, but not within common abbreviations
  const parts: string[] = [];
  let current = '';

  for (let i = 0; i < text.length; i++) {
    current += text[i];
    if (
      (text[i] === '.' || text[i] === '!' || text[i] === '?') &&
      (i === text.length - 1 || text[i + 1] === ' ')
    ) {
      parts.push(current);
      current = '';
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

// ─────────────────────────────────────────────
// Capability Key Normalization
// ─────────────────────────────────────────────

/**
 * Produces a canonical capability key from a display name.
 * Uses lowercase, hyphenation, and deduplication.
 */
function toCapabilityKey(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'unknown';
}

// ─────────────────────────────────────────────
// Materiality Classification
// ─────────────────────────────────────────────

/**
 * Determines the materiality kind for a context unit based on which
 * verb pattern it matches.
 */
function classifyMateriality(contextText: string): MaterialityKind | null {
  if (RESPONSIBILITY_VERBS.test(contextText)) return 'responsibility';
  if (OPERATION_VERBS.test(contextText)) return 'supported-operation';
  if (EXPERTISE_VERBS.test(contextText)) return 'required-expertise';
  if (DELIVERABLE_VERBS.test(contextText)) return 'deliverable-dependency';
  return null;
}

/**
 * Checks if a noun/phrase is a valid capability term (not a false positive).
 */
function isValidCapabilityNoun(noun: string): boolean {
  const lower = noun.toLowerCase();
  if (FALSE_POSITIVE_NOUNS.has(lower)) return false;
  if (lower.length < 2) return false;
  // Must have at least one letter
  if (!/[a-zA-Z]/.test(noun)) return false;
  return true;
}

// ─────────────────────────────────────────────
// Per-Source Extraction Functions
// ─────────────────────────────────────────────

interface RawCapabilityHit {
  displayName: string;
  capabilityKey: string;
  materiality: MaterialityKind;
  evidence: CapabilityEvidence;
}

/**
 * Extracts capability claims from the department anchor.
 * Department alone is a broad anchor but qualifies as a responsibility origin.
 */
function extractFromDepartment(
  department: string,
  sourcePath?: string,
): RawCapabilityHit[] {
  const hits: RawCapabilityHit[] = [];
  const normalized = normalizeText(department);
  if (normalized.length === 0) return hits;

  hits.push({
    displayName: department.trim(),
    capabilityKey: toCapabilityKey(department.trim()),
    materiality: 'responsibility',
    evidence: {
      origin: 'department',
      sourcePath,
      normalizedText: normalized,
    },
  });

  return hits;
}

/**
 * Extracts capability claims from specialty text.
 * Inspects responsibility/expertise clauses within context units.
 */
function extractFromSpecialty(
  specialty: string,
  sourcePath?: string,
): { hits: RawCapabilityHit[]; excluded: string[] } {
  const hits: RawCapabilityHit[] = [];
  const excluded: string[] = [];

  if (!specialty || specialty.trim().length === 0) return { hits, excluded };

  const contextUnits = extractContextUnits(specialty);
  for (const unit of contextUnits) {
    const materiality = classifyMateriality(unit.text);
    const nouns = extractCapabilityNouns(unit.text);

    for (const noun of nouns) {
      if (!isValidCapabilityNoun(noun)) continue;

      if (materiality) {
        hits.push({
          displayName: noun,
          capabilityKey: toCapabilityKey(noun),
          materiality,
          evidence: {
            origin: 'specialty',
            sourcePath,
            normalizedText: normalizeText(unit.text),
            start: unit.start,
            end: unit.end,
          },
        });
      } else {
        // Disconnected keyword — no materiality verb in context
        excluded.push(noun);
      }
    }
  }

  return { hits, excluded };
}

/**
 * Extracts capability claims from the system prompt, focusing on
 * capabilities/technologies and workflow operations.
 */
function extractFromSystemPrompt(
  systemPrompt: string,
  sectionContents?: Readonly<Partial<Record<NamedSection, string | null>>>,
  sourcePath?: string,
): { hits: RawCapabilityHit[]; excluded: string[] } {
  const hits: RawCapabilityHit[] = [];
  const excluded: string[] = [];

  // Process the full prompt or individual sections
  const sections: Array<{ name: NamedSection | null; text: string }> = [];

  if (sectionContents) {
    const sectionNames: NamedSection[] = [
      'Identity', 'Core Mission', 'Critical Rules',
      'Technical Deliverables', 'Workflow Process', 'Success Metrics',
    ];
    for (const name of sectionNames) {
      const content = sectionContents[name];
      if (content && content.trim().length > 0) {
        sections.push({ name, text: content });
      }
    }
  } else if (systemPrompt) {
    sections.push({ name: null, text: systemPrompt });
  }

  for (const section of sections) {
    const origin = determinePromptOrigin(section.name);
    const contextUnits = extractContextUnits(section.text);

    for (const unit of contextUnits) {
      const materiality = classifyMateriality(unit.text);
      const nouns = extractCapabilityNouns(unit.text);

      for (const noun of nouns) {
        if (!isValidCapabilityNoun(noun)) continue;

        if (materiality) {
          hits.push({
            displayName: noun,
            capabilityKey: toCapabilityKey(noun),
            materiality,
            evidence: {
              origin,
              sourcePath,
              section: section.name ?? undefined,
              normalizedText: normalizeText(unit.text),
              start: unit.start,
              end: unit.end,
            },
          });
        } else {
          excluded.push(noun);
        }
      }
    }
  }

  return { hits, excluded };
}

/**
 * Extracts deliverable dependencies from Technical Deliverables section.
 */
function extractFromDeliverables(
  deliverableText: string,
  sourcePath?: string,
): { hits: RawCapabilityHit[]; excluded: string[] } {
  const hits: RawCapabilityHit[] = [];
  const excluded: string[] = [];

  if (!deliverableText || deliverableText.trim().length === 0) {
    return { hits, excluded };
  }

  const contextUnits = extractContextUnits(deliverableText);
  for (const unit of contextUnits) {
    // Deliverables section: every item with a materiality verb qualifies,
    // but items without verbs in this section get 'deliverable-dependency'
    // if they contain domain nouns (since being listed as a deliverable
    // itself implies a dependency relationship).
    const materiality = classifyMateriality(unit.text) ?? 'deliverable-dependency';
    const nouns = extractCapabilityNouns(unit.text);

    for (const noun of nouns) {
      if (!isValidCapabilityNoun(noun)) continue;

      // For deliverables, the item being present IS the claim.
      // But we still check for materiality verbs for stronger evidence.
      if (classifyMateriality(unit.text) || hasDeliverableContext(unit.text)) {
        hits.push({
          displayName: noun,
          capabilityKey: toCapabilityKey(noun),
          materiality,
          evidence: {
            origin: 'deliverable',
            sourcePath,
            section: 'Technical Deliverables',
            normalizedText: normalizeText(unit.text),
            start: unit.start,
            end: unit.end,
          },
        });
      } else {
        excluded.push(noun);
      }
    }
  }

  return { hits, excluded };
}

/**
 * Checks if a context unit has deliverable-specific language that
 * implies a dependency without explicit materiality verbs.
 */
function hasDeliverableContext(text: string): boolean {
  return /\b(?:artifact|deliverable|output|document|report|schema|template|specification|format|structure)\b/i.test(text);
}

/**
 * Determines the prompt origin type based on section name.
 */
function determinePromptOrigin(sectionName: NamedSection | null | undefined): CapabilityOrigin {
  if (!sectionName) return 'system-prompt-capability';
  switch (sectionName) {
    case 'Technical Deliverables':
      return 'deliverable';
    case 'Workflow Process':
      return 'system-prompt-capability';
    default:
      return 'system-prompt-technology';
  }
}

// ─────────────────────────────────────────────
// Noun Extraction
// ─────────────────────────────────────────────

/**
 * Extracts technology/capability nouns from a context unit.
 * Combines capitalized terms, known multi-word domain phrases,
 * and hyphenated compound terms.
 */
function extractCapabilityNouns(text: string): string[] {
  const nouns = new Set<string>();

  // Extract known multi-word capability phrases first
  for (const pattern of CAPABILITY_PHRASE_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const term = match[0].trim();
      if (term.length >= 3) {
        nouns.add(term);
      }
    }
  }

  // Extract capitalized and hyphenated technology terms
  const techRegex = new RegExp(TECH_NOUN_PATTERN.source, TECH_NOUN_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = techRegex.exec(text)) !== null) {
    const term = match[0];
    // Skip very short terms unless they're known acronyms
    if (term.length < 3 && !/^[A-Z]{2,}$/.test(term)) continue;
    // Skip common English words that happen to be capitalized at sentence start
    if (isCommonWord(term)) continue;
    nouns.add(term);
  }

  return [...nouns];
}

/**
 * Common English words that should not be treated as capability nouns
 * even when capitalized (e.g., at sentence start).
 */
const COMMON_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'What',
  'Which', 'Who', 'How', 'Each', 'Every', 'All', 'Any', 'Some',
  'Both', 'Either', 'Neither', 'Many', 'Much', 'Most', 'More',
  'First', 'Second', 'Third', 'Next', 'Last', 'Other', 'Another',
  'Always', 'Never', 'Must', 'Should', 'Could', 'Would', 'Will',
  'Can', 'May', 'Shall', 'Your', 'Our', 'Their', 'Its', 'You',
  'Also', 'Only', 'Just', 'Still', 'Then', 'Now', 'Here', 'There',
  'After', 'Before', 'During', 'While', 'Until', 'Once', 'Since',
  'For', 'With', 'Without', 'From', 'Into', 'Onto', 'Upon',
  'About', 'Above', 'Below', 'Between', 'Beyond', 'Through',
]);

function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word);
}

// ─────────────────────────────────────────────
// Merging and Deduplication
// ─────────────────────────────────────────────

/**
 * Merges raw capability hits by canonical key, preserving all evidence
 * origins sorted deterministically.
 */
function mergeCapabilities(hits: readonly RawCapabilityHit[]): MaterialCapability[] {
  const byKey = new Map<string, {
    displayName: string;
    materiality: MaterialityKind;
    evidence: CapabilityEvidence[];
  }>();

  for (const hit of hits) {
    const existing = byKey.get(hit.capabilityKey);
    if (existing) {
      existing.evidence.push(hit.evidence);
      // Use the strongest materiality (responsibility > operation > expertise > dependency)
      existing.materiality = strongerMateriality(existing.materiality, hit.materiality);
    } else {
      byKey.set(hit.capabilityKey, {
        displayName: hit.displayName,
        materiality: hit.materiality,
        evidence: [hit.evidence],
      });
    }
  }

  // Sort capabilities by key for determinism, sort evidence within each
  const result: MaterialCapability[] = [];
  const sortedKeys = [...byKey.keys()].sort();

  for (const key of sortedKeys) {
    const entry = byKey.get(key)!;
    const sortedEvidence = [...entry.evidence].sort(compareEvidence);

    result.push(Object.freeze({
      capabilityKey: key,
      displayName: entry.displayName,
      materiality: entry.materiality,
      evidence: Object.freeze(sortedEvidence),
    }));
  }

  return result;
}

/** Materiality strength ordering for merge conflict resolution. */
const MATERIALITY_RANK: Record<MaterialityKind, number> = {
  'responsibility': 4,
  'supported-operation': 3,
  'required-expertise': 2,
  'deliverable-dependency': 1,
};

function strongerMateriality(a: MaterialityKind, b: MaterialityKind): MaterialityKind {
  return MATERIALITY_RANK[a] >= MATERIALITY_RANK[b] ? a : b;
}

/** Evidence comparator: origin > section > normalizedText > start. */
function compareEvidence(a: CapabilityEvidence, b: CapabilityEvidence): number {
  const originOrder: Record<CapabilityOrigin, number> = {
    'department': 0,
    'specialty': 1,
    'system-prompt-capability': 2,
    'system-prompt-technology': 3,
    'deliverable': 4,
  };

  const originDiff = originOrder[a.origin] - originOrder[b.origin];
  if (originDiff !== 0) return originDiff;

  const sectionA = a.section ?? '';
  const sectionB = b.section ?? '';
  const sectionCmp = sectionA.localeCompare(sectionB);
  if (sectionCmp !== 0) return sectionCmp;

  const textCmp = a.normalizedText.localeCompare(b.normalizedText);
  if (textCmp !== 0) return textCmp;

  return (a.start ?? 0) - (b.start ?? 0);
}

// ─────────────────────────────────────────────
// Main Extraction Entry Point
// ─────────────────────────────────────────────

/**
 * Extracts material capabilities from an agent definition.
 *
 * Algorithm:
 * 1. If systemPrompt is null (unrecoverable parsing), return blocked result
 *    without fabricating capabilities.
 * 2. Extract from department anchor (broad domain context).
 * 3. Extract from specialty (responsibility/expertise clauses).
 * 4. Extract from system prompt sections (capabilities/technologies).
 * 5. Extract from Technical Deliverables (deliverable dependencies).
 * 6. Merge by canonical key, preserving all evidence spans/origins sorted.
 * 7. Exclude disconnected keyword repetition (nouns without materiality verbs).
 *
 * The extractor never fabricates capabilities after unrecoverable parsing.
 * When the prompt is recovered (not null), extraction proceeds normally
 * using whatever content is available.
 */
export function extractMaterialCapabilities(
  input: CapabilityExtractionInput,
): CapabilityExtractionResult {
  // Guard: unrecoverable parsing produces no capabilities, no fabrication
  if (input.systemPrompt === null && !input.sectionContents) {
    return Object.freeze({
      capabilities: Object.freeze([]),
      fromRecoveredPrompt: false,
      blocked: true,
      excludedKeywords: Object.freeze([]),
    });
  }

  const allHits: RawCapabilityHit[] = [];
  const allExcluded: string[] = [];
  const fromRecoveredPrompt = input.systemPrompt !== undefined
    && input.systemPrompt !== null;

  // 1. Department anchor
  if (input.department) {
    allHits.push(...extractFromDepartment(input.department, input.sourcePath));
  }

  // 2. Specialty responsibilities/expertise
  if (input.specialty) {
    const { hits, excluded } = extractFromSpecialty(input.specialty, input.sourcePath);
    allHits.push(...hits);
    allExcluded.push(...excluded);
  }

  // 3. System prompt capabilities/technologies
  if (input.systemPrompt || input.sectionContents) {
    const promptText = input.systemPrompt ?? '';
    const { hits, excluded } = extractFromSystemPrompt(
      promptText,
      input.sectionContents,
      input.sourcePath,
    );
    allHits.push(...hits);
    allExcluded.push(...excluded);
  }

  // 4. Deliverable dependencies (if section contents available)
  const deliverableContent = input.sectionContents?.['Technical Deliverables'];
  if (deliverableContent) {
    const { hits, excluded } = extractFromDeliverables(
      deliverableContent,
      input.sourcePath,
    );
    allHits.push(...hits);
    allExcluded.push(...excluded);
  }

  // 5. Merge by canonical key with sorted evidence
  const capabilities = mergeCapabilities(allHits);

  // 6. Deduplicate excluded keywords
  const uniqueExcluded = [...new Set(allExcluded)].sort();

  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    fromRecoveredPrompt,
    blocked: false,
    excludedKeywords: Object.freeze(uniqueExcluded),
  });
}

// ─────────────────────────────────────────────
// Convenience: Extract from ImportedAgent-like structure
// ─────────────────────────────────────────────

/**
 * Convenience function to extract capabilities from an agent definition
 * structure matching the shape used by the rest of the system.
 */
export function extractCapabilitiesFromDefinition(params: {
  department?: string | undefined;
  specialty?: string | undefined;
  systemPrompt?: string | null | undefined;
  sectionContents?: Readonly<Partial<Record<NamedSection, string | null>>> | undefined;
  sourcePath?: string | undefined;
}): CapabilityExtractionResult {
  return extractMaterialCapabilities(params);
}
