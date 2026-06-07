/**
 * AgentIdentityManager — Persistent agent identity file management.
 *
 * Generates identity files from templates, loads and applies identities,
 * and stores them in memory (Agent_FS stub).
 *
 * Requirements: 8.1–8.4
 */

import { randomUUID } from 'node:crypto';
import type { AgentTemplate, AgentIdentity, AgentIdentityFiles } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface StoredIdentity {
  agentId: string;
  identity: AgentIdentity;
  updatedAt: Date;
}

// ─── AgentIdentityManager ───────────────────────────────────────

export class AgentIdentityManager {
  private identities = new Map<string, StoredIdentity>();

  /**
   * Generate identity files from a template for a new agent.
   * Requirements: 8.2
   */
  generateFromTemplate(agentId: string, template: AgentTemplate): AgentIdentity {
    const identity: AgentIdentity = {
      soul: template.identityFiles.soulMd || this.defaultSoul(template),
      identity: template.identityFiles.identityMd || this.defaultIdentity(template),
      tools: template.identityFiles.toolsMd || this.defaultTools(template),
      claude: template.identityFiles.claudeMd || this.defaultClaude(template),
    };

    this.identities.set(agentId, {
      agentId,
      identity,
      updatedAt: new Date(),
    });

    return identity;
  }

  /**
   * Load an agent's identity from storage.
   * Requirements: 8.4
   */
  loadIdentity(agentId: string): AgentIdentity | null {
    const stored = this.identities.get(agentId);
    return stored?.identity ?? null;
  }

  /**
   * Save/update an agent's identity.
   */
  saveIdentity(agentId: string, identity: AgentIdentity): void {
    this.identities.set(agentId, {
      agentId,
      identity,
      updatedAt: new Date(),
    });
  }

  /**
   * Update a specific identity file for an agent.
   * Requirements: 8.3
   */
  updateFile(
    agentId: string,
    file: keyof AgentIdentity,
    content: string,
  ): void {
    const stored = this.identities.get(agentId);
    if (!stored) {
      throw new Error(`Identity not found for agent: ${agentId}`);
    }
    stored.identity[file] = content;
    stored.updatedAt = new Date();
  }

  /**
   * Delete an agent's identity.
   */
  deleteIdentity(agentId: string): void {
    this.identities.delete(agentId);
  }

  /**
   * List all stored identities.
   */
  listIdentities(): StoredIdentity[] {
    return Array.from(this.identities.values());
  }

  /**
   * Convert identity to identity files format.
   */
  toIdentityFiles(identity: AgentIdentity): AgentIdentityFiles {
    return {
      soulMd: identity.soul,
      identityMd: identity.identity,
      toolsMd: identity.tools,
      claudeMd: identity.claude,
    };
  }

  // ── Default file generators ─────────────────────────────────

  private defaultSoul(template: AgentTemplate): string {
    return [
      '# Soul',
      '',
      `## Core Purpose`,
      template.role,
      '',
      `## Values`,
      '- Accuracy and correctness',
      '- Efficiency and clarity',
      '- Helpfulness and collaboration',
    ].join('\n');
  }

  private defaultIdentity(template: AgentTemplate): string {
    return [
      '# Identity',
      '',
      `## Name`,
      template.name,
      '',
      `## Role`,
      template.role,
      '',
      `## Communication Style`,
      '- Clear and concise',
      '- Technical when appropriate',
      '- Friendly and professional',
    ].join('\n');
  }

  private defaultTools(template: AgentTemplate): string {
    const tools = template.toolPermissions.length > 0
      ? template.toolPermissions.join(', ')
      : 'All tools available';
    return [
      '# Tools',
      '',
      `## Available Tools`,
      tools,
      '',
      `## Usage Patterns`,
      '- Use read tools before write tools',
      '- Validate changes before applying',
    ].join('\n');
  }

  private defaultClaude(template: AgentTemplate): string {
    return [
      '# Claude',
      '',
      `## Model-Specific Instructions`,
      `Configured for: ${template.modelPreference.providerId}/${template.modelPreference.model}`,
      '',
      `## System Prompt`,
      template.systemPrompt,
    ].join('\n');
  }
}
