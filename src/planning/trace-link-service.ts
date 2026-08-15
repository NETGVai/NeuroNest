/**
 * TraceLinkService — Typed trace link management with validation.
 *
 * - Creates typed trace links with validated source/target entity types
 * - Validates workspace ownership (both entities must be in the same workspace)
 * - Validates relationship cardinality (prevents invalid link patterns)
 * - Validates stable IDs exist for both source and target
 * - Supports relationships: satisfies, implements, depends_on, produced_by, verified_by, traces_to, derived_from
 *
 * Requirements: 11.2, 11.6, 11.9
 */

import { createHash, randomUUID } from 'node:crypto';
import type { PlanningEntityKind } from './types.js';

/** Supported trace link relationship types */
export type TraceLinkRelationship =
  | 'satisfies'
  | 'implements'
  | 'depends_on'
  | 'produced_by'
  | 'verified_by'
  | 'traces_to'
  | 'derived_from';

/** Cardinality constraint for a relationship */
export type Cardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

/** Entity types that can participate in trace links */
export type TraceLinkEntityType =
  | PlanningEntityKind
  | 'task'
  | 'agent_run'
  | 'change_set'
  | 'evidence';

/** A trace link record */
export interface TraceLink {
  id: string;
  workspaceId: string;
  sourceEntityId: string;
  sourceEntityType: TraceLinkEntityType;
  targetEntityId: string;
  targetEntityType: TraceLinkEntityType;
  relationship: TraceLinkRelationship;
  cardinality: Cardinality;
  fingerprint: string;
  optimisticVersion: number;
  isTombstone: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** Input for creating a trace link */
export interface CreateTraceLinkInput {
  workspaceId: string;
  sourceEntityId: string;
  sourceEntityType: TraceLinkEntityType;
  targetEntityId: string;
  targetEntityType: TraceLinkEntityType;
  relationship: TraceLinkRelationship;
  actor: string;
}

/** Validation error from trace link operations */
export interface TraceLinkValidationError {
  code:
    | 'INVALID_SOURCE_TYPE'
    | 'INVALID_TARGET_TYPE'
    | 'CROSS_WORKSPACE'
    | 'CARDINALITY_VIOLATION'
    | 'MISSING_SOURCE_ID'
    | 'MISSING_TARGET_ID'
    | 'SELF_REFERENCE'
    | 'DUPLICATE_LINK';
  message: string;
}

/** Result of a trace link operation */
export type TraceLinkResult =
  | { ok: true; link: TraceLink }
  | { ok: false; error: TraceLinkValidationError };

/** Defines the allowed source/target type pairs and cardinality for each relationship */
const RELATIONSHIP_RULES: Record<
  TraceLinkRelationship,
  {
    allowedSourceTypes: TraceLinkEntityType[];
    allowedTargetTypes: TraceLinkEntityType[];
    cardinality: Cardinality;
  }
> = {
  satisfies: {
    allowedSourceTypes: ['task', 'design_node'],
    allowedTargetTypes: ['requirement', 'acceptance_criterion'],
    cardinality: 'many_to_many',
  },
  implements: {
    allowedSourceTypes: ['task', 'change_set', 'agent_run'],
    allowedTargetTypes: ['requirement', 'design_node', 'task'],
    cardinality: 'many_to_many',
  },
  depends_on: {
    allowedSourceTypes: ['task'],
    allowedTargetTypes: ['task'],
    cardinality: 'many_to_many',
  },
  produced_by: {
    allowedSourceTypes: ['change_set', 'evidence'],
    allowedTargetTypes: ['agent_run', 'task'],
    cardinality: 'many_to_one',
  },
  verified_by: {
    allowedSourceTypes: ['requirement', 'acceptance_criterion', 'task'],
    allowedTargetTypes: ['evidence'],
    cardinality: 'many_to_many',
  },
  traces_to: {
    allowedSourceTypes: ['requirement', 'design_node', 'task', 'acceptance_criterion', 'section'],
    allowedTargetTypes: ['requirement', 'design_node', 'task', 'acceptance_criterion', 'section'],
    cardinality: 'many_to_many',
  },
  derived_from: {
    allowedSourceTypes: ['design_node', 'task', 'requirement'],
    allowedTargetTypes: ['requirement', 'design_node'],
    cardinality: 'many_to_many',
  },
};

/** Entity resolver interface — used to validate entity existence and workspace ownership */
export interface EntityResolver {
  exists(entityId: string): boolean;
  getWorkspaceId(entityId: string): string | null;
}

/**
 * TraceLinkService manages typed trace link creation, validation, and querying.
 *
 * It enforces:
 * - Source and target entity types match the relationship rules
 * - Both entities belong to the same workspace
 * - Cardinality constraints are not violated
 * - Both source and target IDs must be stable (exist in the resolver)
 */
export class TraceLinkService {
  private links: Map<string, TraceLink> = new Map();
  private entityResolver: EntityResolver;

  constructor(entityResolver: EntityResolver) {
    this.entityResolver = entityResolver;
  }

  /**
   * Creates a typed trace link after validation.
   */
  createLink(input: CreateTraceLinkInput): TraceLinkResult {
    const validationError = this.validate(input);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    const rules = RELATIONSHIP_RULES[input.relationship];
    const now = new Date().toISOString();
    const link: TraceLink = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sourceEntityId: input.sourceEntityId,
      sourceEntityType: input.sourceEntityType,
      targetEntityId: input.targetEntityId,
      targetEntityType: input.targetEntityType,
      relationship: input.relationship,
      cardinality: rules.cardinality,
      fingerprint: computeTraceLinkFingerprint(input),
      optimisticVersion: 1,
      isTombstone: false,
      createdAt: now,
      updatedAt: now,
      createdBy: input.actor,
      updatedBy: input.actor,
    };

    this.links.set(link.id, link);
    return { ok: true, link };
  }

  /**
   * Soft-deletes a trace link by marking it as a tombstone.
   */
  deleteLink(linkId: string, actor: string): boolean {
    const link = this.links.get(linkId);
    if (!link || link.isTombstone) return false;

    link.isTombstone = true;
    link.updatedAt = new Date().toISOString();
    link.updatedBy = actor;
    link.optimisticVersion += 1;
    return true;
  }

  /**
   * Gets all active (non-tombstone) links for a given entity.
   */
  getLinksForEntity(entityId: string): TraceLink[] {
    return [...this.links.values()].filter(
      (l) =>
        !l.isTombstone &&
        (l.sourceEntityId === entityId || l.targetEntityId === entityId)
    );
  }

  /**
   * Gets all active links from a source entity with a specific relationship.
   */
  getLinksFrom(sourceEntityId: string, relationship?: TraceLinkRelationship): TraceLink[] {
    return [...this.links.values()].filter(
      (l) =>
        !l.isTombstone &&
        l.sourceEntityId === sourceEntityId &&
        (relationship === undefined || l.relationship === relationship)
    );
  }

  /**
   * Gets all active links to a target entity with a specific relationship.
   */
  getLinksTo(targetEntityId: string, relationship?: TraceLinkRelationship): TraceLink[] {
    return [...this.links.values()].filter(
      (l) =>
        !l.isTombstone &&
        l.targetEntityId === targetEntityId &&
        (relationship === undefined || l.relationship === relationship)
    );
  }

  /**
   * Returns all active links in the service.
   */
  getAllLinks(): TraceLink[] {
    return [...this.links.values()].filter((l) => !l.isTombstone);
  }

  /**
   * Returns the relationship rules metadata.
   */
  static getRelationshipRules(): typeof RELATIONSHIP_RULES {
    return RELATIONSHIP_RULES;
  }

  private validate(input: CreateTraceLinkInput): TraceLinkValidationError | null {
    // Self-reference check
    if (input.sourceEntityId === input.targetEntityId) {
      return {
        code: 'SELF_REFERENCE',
        message: 'Source and target entity cannot be the same',
      };
    }

    // Validate source entity exists
    if (!this.entityResolver.exists(input.sourceEntityId)) {
      return {
        code: 'MISSING_SOURCE_ID',
        message: `Source entity "${input.sourceEntityId}" does not exist`,
      };
    }

    // Validate target entity exists
    if (!this.entityResolver.exists(input.targetEntityId)) {
      return {
        code: 'MISSING_TARGET_ID',
        message: `Target entity "${input.targetEntityId}" does not exist`,
      };
    }

    // Validate workspace ownership
    const sourceWorkspace = this.entityResolver.getWorkspaceId(input.sourceEntityId);
    const targetWorkspace = this.entityResolver.getWorkspaceId(input.targetEntityId);
    if (sourceWorkspace !== targetWorkspace || sourceWorkspace !== input.workspaceId) {
      return {
        code: 'CROSS_WORKSPACE',
        message: `Source and target entities must belong to workspace "${input.workspaceId}"`,
      };
    }

    // Validate relationship rules
    const rules = RELATIONSHIP_RULES[input.relationship];

    if (!rules.allowedSourceTypes.includes(input.sourceEntityType)) {
      return {
        code: 'INVALID_SOURCE_TYPE',
        message: `Source type "${input.sourceEntityType}" is not allowed for relationship "${input.relationship}". Allowed: ${rules.allowedSourceTypes.join(', ')}`,
      };
    }

    if (!rules.allowedTargetTypes.includes(input.targetEntityType)) {
      return {
        code: 'INVALID_TARGET_TYPE',
        message: `Target type "${input.targetEntityType}" is not allowed for relationship "${input.relationship}". Allowed: ${rules.allowedTargetTypes.join(', ')}`,
      };
    }

    // Validate cardinality
    const cardinalityError = this.checkCardinality(input, rules.cardinality);
    if (cardinalityError) return cardinalityError;

    // Duplicate check
    const duplicate = [...this.links.values()].find(
      (l) =>
        !l.isTombstone &&
        l.sourceEntityId === input.sourceEntityId &&
        l.targetEntityId === input.targetEntityId &&
        l.relationship === input.relationship
    );
    if (duplicate) {
      return {
        code: 'DUPLICATE_LINK',
        message: `A "${input.relationship}" link already exists between "${input.sourceEntityId}" and "${input.targetEntityId}"`,
      };
    }

    return null;
  }

  private checkCardinality(
    input: CreateTraceLinkInput,
    cardinality: Cardinality
  ): TraceLinkValidationError | null {
    const existingFromSource = [...this.links.values()].filter(
      (l) =>
        !l.isTombstone &&
        l.sourceEntityId === input.sourceEntityId &&
        l.relationship === input.relationship
    );

    const existingToTarget = [...this.links.values()].filter(
      (l) =>
        !l.isTombstone &&
        l.targetEntityId === input.targetEntityId &&
        l.relationship === input.relationship
    );

    switch (cardinality) {
      case 'one_to_one':
        if (existingFromSource.length > 0) {
          return {
            code: 'CARDINALITY_VIOLATION',
            message: `Source "${input.sourceEntityId}" already has a "${input.relationship}" link (one-to-one)`,
          };
        }
        if (existingToTarget.length > 0) {
          return {
            code: 'CARDINALITY_VIOLATION',
            message: `Target "${input.targetEntityId}" already has an incoming "${input.relationship}" link (one-to-one)`,
          };
        }
        break;

      case 'one_to_many':
        // Source can link to many targets, but target can only be linked from one source
        if (existingToTarget.length > 0) {
          return {
            code: 'CARDINALITY_VIOLATION',
            message: `Target "${input.targetEntityId}" already has an incoming "${input.relationship}" link (one-to-many)`,
          };
        }
        break;

      case 'many_to_one':
        // Many sources can link to target, but source can only link to one target
        if (existingFromSource.length > 0) {
          return {
            code: 'CARDINALITY_VIOLATION',
            message: `Source "${input.sourceEntityId}" already has a "${input.relationship}" link (many-to-one)`,
          };
        }
        break;

      case 'many_to_many':
        // No cardinality restriction
        break;
    }

    return null;
  }
}

/**
 * Computes a deterministic fingerprint for a trace link input.
 */
function computeTraceLinkFingerprint(input: CreateTraceLinkInput): string {
  const content = `${input.sourceEntityId}:${input.targetEntityId}:${input.relationship}:${input.workspaceId}`;
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}
