import { createHash } from 'node:crypto';

import {
  REQUIRED_AGENT_SECTION_NAMES,
  type AgentFileParseResult,
} from './agent-file-parser';
import type { ImportCatalogOutcome } from './agent-population';

export type CatalogDuplicateKind = 'identity' | 'full-content' | 'objective-signature';
export type CatalogDuplicateClassification = 'blocking' | 'informational';

export interface CatalogDuplicateSource {
  readonly sourcePath: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly parseResult: AgentFileParseResult;
  readonly catalogOutcome?: ImportCatalogOutcome | 'unresolved';
  readonly resolutionReason?: string;
  readonly duplicateGroupId?: string | null;
}

export interface CatalogDuplicateRelationship {
  readonly relationshipId: string;
  readonly duplicateGroupId: string;
  readonly kind: CatalogDuplicateKind;
  readonly code:
    | 'DUPLICATE_IDENTITY'
    | 'FULL_CONTENT_DUPLICATE'
    | 'COPIED_OBJECTIVE_BOILERPLATE';
  readonly classification: CatalogDuplicateClassification;
  readonly sourcePath: string;
  readonly relatedSourcePath: string;
  readonly catalogOutcome: ImportCatalogOutcome | 'unresolved';
  readonly relatedCatalogOutcome: ImportCatalogOutcome | 'unresolved';
  readonly resolutionReason: string;
  readonly objectiveSignature: readonly string[] | null;
}

export interface CatalogDuplicateAnalysis {
  readonly relationships: readonly CatalogDuplicateRelationship[];
  readonly relationshipsBySource: Readonly<Record<string, readonly CatalogDuplicateRelationship[]>>;
  readonly blockingSourcePaths: readonly string[];
  readonly informationalSourcePaths: readonly string[];
}

interface ObjectiveEvidence {
  readonly objectives: readonly string[];
  readonly properNameTokens: ReadonlySet<string>;
}

const STANDARD_SECTION_HEADINGS = new Set(
  REQUIRED_AGENT_SECTION_NAMES.map((name) => name.toLocaleLowerCase('en-US')),
);

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function stableId(kind: CatalogDuplicateKind, leftPath: string, rightPath: string): string {
  const pair = [leftPath, rightPath].sort(compareText).join('\u0000');
  return `duplicate:${kind}:${createHash('sha256').update(pair).digest('hex').slice(0, 16)}`;
}

function defaultOutcome(source: CatalogDuplicateSource): ImportCatalogOutcome | 'unresolved' {
  return source.catalogOutcome ?? 'unresolved';
}

function defaultResolutionReason(source: CatalogDuplicateSource): string {
  if (source.resolutionReason?.trim()) return source.resolutionReason.trim();
  if (source.catalogOutcome === 'retained') return 'Source definition was retained in the effective catalog';
  if (source.catalogOutcome === 'skipped-duplicate-id') {
    return 'Source definition was skipped from the effective catalog because its agent ID was already retained';
  }
  return 'No effective-catalog resolution outcome was supplied';
}

function duplicateGroupId(
  kind: CatalogDuplicateKind,
  left: CatalogDuplicateSource,
  right: CatalogDuplicateSource,
): string {
  if (kind === 'identity' && left.duplicateGroupId && left.duplicateGroupId === right.duplicateGroupId) {
    return left.duplicateGroupId;
  }
  return stableId(kind, left.sourcePath, right.sourcePath);
}

function fullContentKey(source: CatalogDuplicateSource): string | null {
  if (!source.parseResult.extractionComplete) return null;
  const contents = REQUIRED_AGENT_SECTION_NAMES.map(
    (sectionName) => source.parseResult.sectionContents[sectionName],
  );
  if (contents.some((content) => content === null)) return null;
  return JSON.stringify(contents);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`*_~]/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function extractObjectiveItems(parseResult: AgentFileParseResult): readonly string[] {
  const section = parseResult.sections['Core Mission'];
  if (!section?.content.trim()) return Object.freeze([]);

  const objectives: string[] = [];
  let current = '';
  for (const rawLine of section.content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) continue;
    const marker = /^(?:\d+[.)]|[-*+]|step\s+\d+\s*[:.)-])\s+(.+)$/i.exec(line);
    if (marker) {
      if (current) objectives.push(current);
      current = marker[1]!.trim();
    } else if (current) {
      current = `${current} ${line}`;
    } else {
      objectives.push(line);
    }
  }
  if (current) objectives.push(current);
  return Object.freeze(objectives);
}

function properNameTokens(objectives: readonly string[], agentName: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const objective of objectives) {
    const words = objective.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
    words.slice(1).forEach((word) => {
      if (/^\p{Lu}/u.test(word) || (/^[A-Z0-9-]+$/.test(word) && word.length > 1)) {
        tokens.add(word.toLocaleLowerCase('en-US').normalize('NFKC'));
      }
    });
  }
  for (const word of agentName.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []) {
    if (/^\p{Lu}/u.test(word) || (/^[A-Z0-9-]+$/.test(word) && word.length > 1)) {
      tokens.add(word.toLocaleLowerCase('en-US').normalize('NFKC'));
    }
  }
  return tokens;
}

function objectiveEvidence(source: CatalogDuplicateSource): ObjectiveEvidence {
  const objectives = extractObjectiveItems(source.parseResult);
  return Object.freeze({
    objectives,
    properNameTokens: properNameTokens(objectives, source.agentName),
  });
}

function normalizeObjective(value: string, excludedTokens: ReadonlySet<string>): string {
  const withoutHeading = stripMarkdown(value)
    .normalize('NFKC')
    .replace(/^#{1,6}\s+/, '')
    .trim();
  if (STANDARD_SECTION_HEADINGS.has(withoutHeading.toLocaleLowerCase('en-US'))) return '';

  return (withoutHeading.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => !excludedTokens.has(token))
    .join(' ')
    .trim();
}

function pairObjectiveSignature(
  left: ObjectiveEvidence,
  right: ObjectiveEvidence,
): { left: readonly string[]; right: readonly string[] } {
  const sharedProperNames = new Set(
    [...left.properNameTokens].filter((token) => right.properNameTokens.has(token)),
  );
  const normalize = (objectives: readonly string[]): readonly string[] => Object.freeze(
    [...new Set(objectives
      .map((objective) => normalizeObjective(objective, sharedProperNames))
      .filter(Boolean))]
      .sort(compareText),
  );
  return Object.freeze({ left: normalize(left.objectives), right: normalize(right.objectives) });
}

function relationship(
  kind: CatalogDuplicateKind,
  source: CatalogDuplicateSource,
  related: CatalogDuplicateSource,
  signature: readonly string[] | null,
): CatalogDuplicateRelationship {
  const code = kind === 'identity'
    ? 'DUPLICATE_IDENTITY' as const
    : kind === 'full-content'
      ? 'FULL_CONTENT_DUPLICATE' as const
      : 'COPIED_OBJECTIVE_BOILERPLATE' as const;
  const classification = kind === 'full-content' ? 'blocking' as const : 'informational' as const;
  const reason = kind === 'identity'
    ? `Agent ID ${source.agentId} is shared; ${defaultResolutionReason(source)}`
    : kind === 'full-content'
      ? `All six extracted section contents are identical; ${defaultResolutionReason(source)}`
      : `Normalized Core Mission objective sets are identical after excluding headings and shared proper-name tokens; ${defaultResolutionReason(source)}`;

  return Object.freeze({
    relationshipId: stableId(kind, source.sourcePath, related.sourcePath),
    duplicateGroupId: duplicateGroupId(kind, source, related),
    kind,
    code,
    classification,
    sourcePath: source.sourcePath,
    relatedSourcePath: related.sourcePath,
    catalogOutcome: defaultOutcome(source),
    relatedCatalogOutcome: defaultOutcome(related),
    resolutionReason: reason,
    objectiveSignature: signature,
  });
}

/**
 * Compares every source pair without removing duplicate identities or definitions.
 * Each detected relationship is emitted in both directions so the per-source report
 * retains its own catalog outcome and resolution reason.
 */
export function analyzeCatalogDuplicates(
  inputSources: readonly CatalogDuplicateSource[],
): CatalogDuplicateAnalysis {
  const sources = [...inputSources].sort((left, right) => compareText(left.sourcePath, right.sourcePath));
  const objectiveEvidenceByPath = new Map(
    sources.map((source) => [source.sourcePath, objectiveEvidence(source)]),
  );
  const relationships: CatalogDuplicateRelationship[] = [];

  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    const left = sources[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      const right = sources[rightIndex]!;
      const kinds: { kind: CatalogDuplicateKind; signature: readonly string[] | null }[] = [];

      if (left.agentId.length > 0 && left.agentId === right.agentId) {
        kinds.push({ kind: 'identity', signature: null });
      }
      const leftContent = fullContentKey(left);
      const rightContent = fullContentKey(right);
      if (leftContent !== null && leftContent === rightContent) {
        kinds.push({ kind: 'full-content', signature: null });
      }

      const signatures = pairObjectiveSignature(
        objectiveEvidenceByPath.get(left.sourcePath)!,
        objectiveEvidenceByPath.get(right.sourcePath)!,
      );
      if (
        signatures.left.length > 0
        && signatures.left.length === signatures.right.length
        && signatures.left.every((objective, index) => objective === signatures.right[index])
      ) {
        kinds.push({ kind: 'objective-signature', signature: signatures.left });
      }

      for (const { kind, signature } of kinds) {
        relationships.push(relationship(kind, left, right, signature));
        relationships.push(relationship(kind, right, left, signature));
      }
    }
  }

  relationships.sort((left, right) => compareText(left.sourcePath, right.sourcePath)
    || compareText(left.relatedSourcePath, right.relatedSourcePath)
    || compareText(left.kind, right.kind));

  const relationshipsBySource: Record<string, readonly CatalogDuplicateRelationship[]> = {};
  for (const source of sources) {
    relationshipsBySource[source.sourcePath] = Object.freeze(
      relationships.filter((candidate) => candidate.sourcePath === source.sourcePath),
    );
  }
  const blockingSourcePaths = [...new Set(relationships
    .filter((candidate) => candidate.classification === 'blocking')
    .map((candidate) => candidate.sourcePath))].sort(compareText);
  const informationalSourcePaths = [...new Set(relationships
    .filter((candidate) => candidate.classification === 'informational')
    .map((candidate) => candidate.sourcePath))].sort(compareText);

  return Object.freeze({
    relationships: Object.freeze(relationships),
    relationshipsBySource: Object.freeze(relationshipsBySource),
    blockingSourcePaths: Object.freeze(blockingSourcePaths),
    informationalSourcePaths: Object.freeze(informationalSourcePaths),
  });
}
