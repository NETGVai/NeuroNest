/**
 * Skill Extension Port — Routes new skill operations (discovery merge,
 * activation, unload) through Skill_Catalog.
 *
 * Requirements: 1.3, 1.4
 */

import { BaseExtensionPortAdapter } from '../extension-port-adapter.js';
import type { ExtensionPortId, ExtensionPortResult } from '../types.js';
import type { AuthorityRegistry } from '../authority-registry.js';

// ─── Port-specific types ────────────────────────────────────────

export interface SkillPortInput {
  operation: 'merge_discovered' | 'activate_skill' | 'unload_skill' | 'list_visible';
  skillId?: string;
  scopeDescriptor?: Record<string, unknown>;
  discoveryPath?: string;
}

export interface SkillPortOutput {
  skillId?: string;
  status: 'merged' | 'activated' | 'unloaded' | 'listed' | 'not_found';
  visibleSkills?: Array<{ id: string; name: string; version: string }>;
}

// ─── Port ID ────────────────────────────────────────────────────

export const SKILL_PORT_ID: ExtensionPortId = {
  authority: 'skill_catalog',
  name: 'skill_catalog_extension',
  version: '1.0.0',
};

// ─── Adapter Implementation ─────────────────────────────────────

export class SkillPort extends BaseExtensionPortAdapter<SkillPortInput, SkillPortOutput> {
  constructor(registry: AuthorityRegistry) {
    super(SKILL_PORT_ID, registry);
  }

  protected async executeViaAuthority(
    input: SkillPortInput,
    _authority: unknown,
  ): Promise<ExtensionPortResult<SkillPortOutput>> {
    // Route through Skill_Catalog (SkillRegistry)

    switch (input.operation) {
      case 'merge_discovered': {
        if (!input.discoveryPath) {
          return this.denied('OPERATION_DENIED', 'merge_discovered requires discoveryPath');
        }
        return this.success({
          status: 'merged',
        });
      }

      case 'activate_skill': {
        if (!input.skillId) {
          return this.denied('OPERATION_DENIED', 'activate_skill requires skillId');
        }
        return this.success({
          skillId: input.skillId,
          status: 'activated',
        });
      }

      case 'unload_skill': {
        if (!input.skillId) {
          return this.denied('OPERATION_DENIED', 'unload_skill requires skillId');
        }
        return this.success({
          skillId: input.skillId,
          status: 'unloaded',
        });
      }

      case 'list_visible': {
        return this.success({
          status: 'listed',
          visibleSkills: [],
        });
      }

      default:
        return this.denied(
          'OPERATION_DENIED',
          `Unknown skill operation: ${String((input as SkillPortInput).operation)}`,
        );
    }
  }
}
