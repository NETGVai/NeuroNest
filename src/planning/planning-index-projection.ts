/**
 * PlanningIndexProjection — Builds a read index from Markdown content.
 *
 * - Builds a read index from Markdown content (requirements, design nodes)
 * - Detects source/index discrepancies (content changed in Markdown but index is stale)
 * - Preserves embedded stable IDs across rebuilds
 * - Offers migration preview for missing IDs (shows what would be generated)
 * - Blocks readiness-relevant conflicts (marks affected Tasks as needs_review)
 *
 * Requirements: 11.1, 11.3, 11.8, 11.10
 */

import { randomUUID } from 'node:crypto';
import {
  computeFingerprint,
  isReadinessRelevant,
  parseMarkdownEntities,
} from './planning-authority-service.js';
import type {
  MigrationPreviewEntry,
  ParsedEntity,
  PlanningEntity,
  PlanningEntityKind,
  SourceIndexDiscrepancy,
  TaskStatus,
} from './types.js';

/** Indexed entity in the read projection */
export interface IndexedEntity {
  id: string;
  kind: PlanningEntityKind;
  title: string;
  sourceRange: { startLine: number; endLine: number };
  sourceFingerprint: string;
  embeddedId: string | null;
}

/**
 * PlanningIndexProjection maintains a read index built from Markdown sources.
 *
 * It is NOT the authority — Markdown files are. The projection allows fast
 * querying and discrepancy detection.
 */
export class PlanningIndexProjection {
  private index: Map<string, IndexedEntity> = new Map();
  private sourceHash: string | null = null;

  /**
   * Rebuilds the index deterministically from Markdown content.
   * Preserves embedded stable IDs; generates temporary internal IDs for entities without them.
   */
  rebuild(
    content: string,
    sourceType: 'requirement' | 'design' | 'task_list'
  ): IndexedEntity[] {
    const entities = parseMarkdownEntities(content, sourceType);
    this.index.clear();
    this.sourceHash = computeFingerprint(content);

    const indexed: IndexedEntity[] = [];

    for (const entity of entities) {
      const id = entity.id ?? `__temp_${randomUUID()}`;
      const entry: IndexedEntity = {
        id,
        kind: entity.kind,
        title: entity.title,
        sourceRange: entity.sourceRange,
        sourceFingerprint: entity.sourceFingerprint,
        embeddedId: entity.id,
      };
      this.index.set(id, entry);
      indexed.push(entry);
    }

    return indexed;
  }

  /**
   * Returns the current source hash the index was built from.
   */
  getSourceHash(): string | null {
    return this.sourceHash;
  }

  /**
   * Detects discrepancies between the current Markdown source and a prior index state.
   */
  detectDiscrepancies(
    currentContent: string,
    sourceType: 'requirement' | 'design' | 'task_list',
    priorEntities: PlanningEntity[]
  ): SourceIndexDiscrepancy[] {
    const discrepancies: SourceIndexDiscrepancy[] = [];
    const currentEntities = parseMarkdownEntities(currentContent, sourceType);

    // Build lookup from prior entities by ID
    const priorById = new Map(priorEntities.map((e) => [e.id, e]));

    // Build lookup from current entities by embedded ID
    const currentById = new Map<string, ParsedEntity>();
    for (const entity of currentEntities) {
      if (entity.id) {
        currentById.set(entity.id, entity);
      }
    }

    // Check for content changes and missing entities
    for (const [priorId, priorEntity] of priorById) {
      if (priorEntity.isTombstone) continue;

      const current = currentById.get(priorId);
      if (!current) {
        // Entity existed in prior index but not in current Markdown
        const kind = 'entity_missing' as const;
        discrepancies.push({
          entityId: priorId,
          kind,
          sourceFingerprint: '',
          indexFingerprint: priorEntity.sourceFingerprint,
          description: `Entity "${priorEntity.title ?? priorId}" exists in index but not in current Markdown`,
          affectsReadiness: isReadinessRelevant(kind),
        });
      } else if (current.sourceFingerprint !== priorEntity.sourceFingerprint) {
        // Content changed
        const kind = 'content_changed' as const;
        discrepancies.push({
          entityId: priorId,
          kind,
          sourceFingerprint: current.sourceFingerprint,
          indexFingerprint: priorEntity.sourceFingerprint,
          description: `Content of "${priorEntity.title ?? priorId}" changed since last index`,
          affectsReadiness: isReadinessRelevant(kind),
        });
      }
    }

    // Check for entities added in current but not in prior
    for (const entity of currentEntities) {
      if (entity.id && !priorById.has(entity.id)) {
        const kind = 'entity_added' as const;
        discrepancies.push({
          entityId: entity.id,
          kind,
          sourceFingerprint: entity.sourceFingerprint,
          indexFingerprint: null,
          description: `Entity "${entity.title}" added in Markdown but not in index`,
          affectsReadiness: isReadinessRelevant(kind),
        });
      }
    }

    // Check for entities without embedded IDs
    for (const entity of currentEntities) {
      if (!entity.id) {
        const kind = 'id_missing' as const;
        discrepancies.push({
          entityId: `__no_id_line_${entity.sourceRange.startLine}`,
          kind,
          sourceFingerprint: entity.sourceFingerprint,
          indexFingerprint: null,
          description: `Entity "${entity.title}" at line ${entity.sourceRange.startLine} has no embedded stable ID`,
          affectsReadiness: isReadinessRelevant(kind),
        });
      }
    }

    return discrepancies;
  }

  /**
   * Generates a migration preview showing what IDs would be generated for
   * entities that lack embedded stable IDs.
   *
   * This is a preview only — it does NOT mutate Markdown or any store.
   */
  generateMigrationPreview(
    content: string,
    sourceType: 'requirement' | 'design' | 'task_list'
  ): MigrationPreviewEntry[] {
    const entities = parseMarkdownEntities(content, sourceType);
    const preview: MigrationPreviewEntry[] = [];

    for (const entity of entities) {
      if (!entity.id) {
        const prefix = kindPrefix(entity.kind);
        const slug = entity.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 30);
        const suggestedId = `${prefix}-${slug}-${randomUUID().slice(0, 8)}`;

        preview.push({
          title: entity.title,
          kind: entity.kind,
          sourceRange: entity.sourceRange,
          suggestedId,
          reason: 'Entity has no embedded stable ID; one would be generated on migration',
        });
      }
    }

    return preview;
  }

  /**
   * Evaluates which tasks should be blocked due to readiness-relevant discrepancies.
   *
   * Returns task IDs that should be marked needs_review.
   */
  getBlockedTasks(
    discrepancies: SourceIndexDiscrepancy[],
    taskEntityLinks: Map<string, string[]> // entityId -> taskIds
  ): { taskId: string; reason: string; status: TaskStatus }[] {
    const blocked: { taskId: string; reason: string; status: TaskStatus }[] = [];

    for (const discrepancy of discrepancies) {
      if (!discrepancy.affectsReadiness) continue;

      const linkedTasks = taskEntityLinks.get(discrepancy.entityId) ?? [];
      for (const taskId of linkedTasks) {
        blocked.push({
          taskId,
          reason: discrepancy.description,
          status: 'needs_review',
        });
      }
    }

    return blocked;
  }

  /**
   * Returns all currently indexed entities.
   */
  getAll(): IndexedEntity[] {
    return [...this.index.values()];
  }

  /**
   * Returns an indexed entity by ID.
   */
  get(id: string): IndexedEntity | undefined {
    return this.index.get(id);
  }
}

function kindPrefix(kind: PlanningEntityKind): string {
  switch (kind) {
    case 'requirement':
      return 'REQ';
    case 'design_node':
      return 'DES';
    case 'acceptance_criterion':
      return 'AC';
    case 'section':
      return 'SEC';
  }
}
