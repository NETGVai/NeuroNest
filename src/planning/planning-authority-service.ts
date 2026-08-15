/**
 * PlanningAuthorityService — Establishes Markdown and SQLite planning authorities.
 *
 * - Markdown is authoritative for requirements and design node prose
 * - SQLite (migration 074) is authoritative for Tasks and Agent_Runs
 * - Parses Markdown files to extract stable IDs, headings, source ranges
 * - Provides clear separation: Markdown = prose authority, SQLite = execution authority
 *
 * Requirements: 11.1, 11.3, 11.8, 11.10
 */

import { createHash } from 'node:crypto';
import type {
  AuthoritySource,
  EmbeddedId,
  ParsedEntity,
  PlanningEntityKind,
  PlanningTask,
  TaskStatus,
} from './types.js';

/** Pattern to match embedded stable IDs: <!-- id: SOME-ID --> */
const EMBEDDED_ID_PATTERN = /<!--\s*id:\s*([^\s]+)\s*-->/;

/** Pattern to match Markdown headings */
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;

/**
 * Determines which source is authoritative for a given entity kind.
 */
export function getAuthority(entityKind: PlanningEntityKind | 'task' | 'agent_run'): AuthoritySource {
  switch (entityKind) {
    case 'requirement':
    case 'design_node':
    case 'acceptance_criterion':
    case 'section':
      return 'markdown';
    case 'task':
    case 'agent_run':
      return 'sqlite';
  }
}

/**
 * Computes a fingerprint (SHA-256 hex prefix) for content.
 */
export function computeFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Extracts embedded stable IDs from Markdown content.
 */
export function extractEmbeddedIds(content: string): EmbeddedId[] {
  const lines = content.split('\n');
  const ids: EmbeddedId[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(EMBEDDED_ID_PATTERN);
    if (match) {
      ids.push({ id: match[1], line: i + 1 });
    }
  }

  return ids;
}

/**
 * Parses Markdown content to extract entities with headings, ranges, and IDs.
 *
 * Each heading defines an entity. If an embedded ID comment (<!-- id: ... -->)
 * immediately precedes or is on the same line as the heading, it becomes the
 * entity's stable ID.
 */
export function parseMarkdownEntities(
  content: string,
  sourceType: 'requirement' | 'design' | 'task_list'
): ParsedEntity[] {
  const lines = content.split('\n');
  const entities: ParsedEntity[] = [];
  const embeddedIds = extractEmbeddedIds(content);
  const idByLine = new Map(embeddedIds.map((e) => [e.line, e.id]));

  let currentEntity: {
    title: string;
    headingLevel: number;
    startLine: number;
    id: string | null;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const headingMatch = lines[i].match(HEADING_PATTERN);

    if (headingMatch) {
      // Close previous entity
      if (currentEntity) {
        const endLine = lineNum - 1;
        const sectionContent = lines.slice(currentEntity.startLine - 1, endLine).join('\n');
        entities.push({
          id: currentEntity.id,
          kind: inferEntityKind(currentEntity.headingLevel, currentEntity.title, sourceType),
          title: currentEntity.title,
          sourceRange: { startLine: currentEntity.startLine, endLine },
          sourceFingerprint: computeFingerprint(sectionContent),
          headingLevel: currentEntity.headingLevel,
        });
      }

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Check for embedded ID on previous line or same line
      const embeddedId = idByLine.get(lineNum - 1) ?? idByLine.get(lineNum) ?? null;

      currentEntity = {
        title,
        headingLevel: level,
        startLine: lineNum,
        id: embeddedId,
      };
    }
  }

  // Close the last entity
  if (currentEntity) {
    const sectionContent = lines.slice(currentEntity.startLine - 1).join('\n');
    entities.push({
      id: currentEntity.id,
      kind: inferEntityKind(currentEntity.headingLevel, currentEntity.title, sourceType),
      title: currentEntity.title,
      sourceRange: { startLine: currentEntity.startLine, endLine: lines.length },
      sourceFingerprint: computeFingerprint(sectionContent),
      headingLevel: currentEntity.headingLevel,
    });
  }

  return entities;
}

/**
 * Infers entity kind from heading level, title, and source type.
 */
function inferEntityKind(
  headingLevel: number,
  title: string,
  sourceType: 'requirement' | 'design' | 'task_list'
): PlanningEntityKind {
  if (sourceType === 'requirement') {
    if (title.toLowerCase().startsWith('requirement') || headingLevel === 3) {
      return 'requirement';
    }
    if (title.toLowerCase().startsWith('acceptance criteria') || headingLevel >= 4) {
      return 'acceptance_criterion';
    }
    return 'section';
  }

  if (sourceType === 'design') {
    if (headingLevel >= 3) {
      return 'design_node';
    }
    return 'section';
  }

  return 'section';
}

/**
 * Resolves the authoritative status for a task.
 * Task status always comes from SQLite, never from Markdown.
 */
export function resolveTaskStatus(sqliteTask: PlanningTask | null): TaskStatus | null {
  if (!sqliteTask) return null;
  return sqliteTask.status;
}

/**
 * Determines if a discrepancy between Markdown and its index affects readiness.
 *
 * Readiness-relevant conflicts mark Tasks as needs_review and block dispatch.
 */
export function isReadinessRelevant(
  discrepancyKind: 'content_changed' | 'entity_missing' | 'entity_added' | 'id_missing'
): boolean {
  // Content changes and missing entities are readiness-relevant
  return discrepancyKind === 'content_changed' || discrepancyKind === 'entity_missing';
}
