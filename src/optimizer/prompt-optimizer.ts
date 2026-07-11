/**
 * PromptOptimizer — Prompt analysis, optimization, profile management.
 *
 * Stub implementation with in-memory state. Applies optimization techniques
 * to user prompts, supports profiles, custom profiles, and prompt pair logging.
 *
 * Requirements: 10.1–10.8, 1.1, 1.2, 1.4, 1.5, 1.6, 1.7
 */

import { randomUUID } from 'node:crypto';
import { DeliverableGuard, DeliverableType } from './deliverable-guard';

// ─── Types ──────────────────────────────────────────────────────

export type OptimizationTechnique = 'add-specificity' | 'structure-output' | 'inject-context' | 'few-shot-examples';

export type BuiltInProfile = 'concise' | 'detailed' | 'step-by-step' | 'code-focused';

export interface OptimizationProfile {
  id: string;
  name: string;
  techniques: OptimizationTechnique[];
  isBuiltIn: boolean;
}

export interface OptimizedPrompt {
  original: string;
  optimized: string;
  techniques: OptimizationTechnique[];
  profile: string;
  deliverableType: DeliverableType;
}

export interface OptimizationContext {
  sessionId?: string;
  agentId?: string;
  profile: BuiltInProfile | string;
  additionalContext?: string;
}

export interface PromptPair {
  id: string;
  original: string;
  optimized: string;
  profile: string;
  techniques: OptimizationTechnique[];
  agentId: string;
  sessionId: string;
  timestamp: Date;
  deliverableType: DeliverableType;
}

// ─── Built-in profiles ──────────────────────────────────────────

const BUILT_IN_PROFILES: OptimizationProfile[] = [
  {
    id: 'concise',
    name: 'Concise',
    techniques: ['add-specificity', 'structure-output'],
    isBuiltIn: true,
  },
  {
    id: 'detailed',
    name: 'Detailed',
    techniques: ['add-specificity', 'structure-output', 'inject-context', 'few-shot-examples'],
    isBuiltIn: true,
  },
  {
    id: 'step-by-step',
    name: 'Step-by-Step',
    techniques: ['add-specificity', 'structure-output', 'inject-context'],
    isBuiltIn: true,
  },
  {
    id: 'code-focused',
    name: 'Code-Focused',
    techniques: ['add-specificity', 'inject-context', 'few-shot-examples'],
    isBuiltIn: true,
  },
];

// ─── PromptOptimizer ────────────────────────────────────────────

export class PromptOptimizer {
  private profiles = new Map<string, OptimizationProfile>();
  private history: PromptPair[] = [];
  private enabledAgents = new Set<string>(); // agents with optimizer enabled
  private guard = new DeliverableGuard();

  constructor() {
    for (const profile of BUILT_IN_PROFILES) {
      this.profiles.set(profile.id, profile);
    }
  }

  /**
   * Optimize a prompt using the specified profile.
   * Requirements: 10.1, 10.2, 10.6, 1.1, 1.2, 1.4, 1.5, 1.6, 1.7
   */
  async optimize(prompt: string, context: OptimizationContext): Promise<OptimizedPrompt> {
    const profile = this.profiles.get(context.profile);
    if (!profile) {
      throw new Error(`Unknown optimization profile: ${context.profile}`);
    }

    // Classify deliverable type before applying any techniques
    const classification = this.guard.classify(prompt);

    let optimized = prompt;
    const appliedTechniques: OptimizationTechnique[] = [];

    for (const technique of profile.techniques) {
      const candidate = this.applyTechnique(optimized, technique, context);

      // Validate that the technique did not corrupt the deliverable type
      if (this.guard.validate(classification, candidate)) {
        optimized = candidate;
        appliedTechniques.push(technique);
      }
      // If validation fails, discard the technique (revert to previous optimized value)
    }

    const result: OptimizedPrompt = {
      original: prompt,
      optimized,
      techniques: appliedTechniques,
      profile: profile.id,
      deliverableType: classification.type,
    };

    // Log prompt pair with deliverableType for auditability
    if (context.sessionId && context.agentId) {
      this.history.push({
        id: randomUUID(),
        original: prompt,
        optimized,
        profile: profile.id,
        techniques: appliedTechniques,
        agentId: context.agentId,
        sessionId: context.sessionId,
        timestamp: new Date(),
        deliverableType: classification.type,
      });
    }

    return result;
  }

  /**
   * Get all available profiles.
   * Requirements: 10.5
   */
  getProfiles(): OptimizationProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Create a custom profile.
   * Requirements: 10.7
   */
  createProfile(profile: Omit<OptimizationProfile, 'isBuiltIn'>): OptimizationProfile {
    const full: OptimizationProfile = { ...profile, isBuiltIn: false };
    this.profiles.set(full.id, full);
    return full;
  }

  /**
   * Delete a custom profile (cannot delete built-in).
   */
  deleteProfile(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    if (profile.isBuiltIn) throw new Error('Cannot delete built-in profile');
    this.profiles.delete(profileId);
  }

  /**
   * Get prompt pair history for a session.
   * Requirements: 10.8
   */
  getHistory(sessionId: string): PromptPair[] {
    return this.history.filter((p) => p.sessionId === sessionId);
  }

  /**
   * Enable optimizer for an agent.
   * Requirements: 10.4
   */
  enableForAgent(agentId: string): void {
    this.enabledAgents.add(agentId);
  }

  /**
   * Disable optimizer for an agent.
   * Requirements: 10.4
   */
  disableForAgent(agentId: string): void {
    this.enabledAgents.delete(agentId);
  }

  /**
   * Check if optimizer is enabled for an agent.
   */
  isEnabledForAgent(agentId: string): boolean {
    return this.enabledAgents.has(agentId);
  }

  // ── Private helpers ─────────────────────────────────────────

  private applyTechnique(
    prompt: string,
    technique: OptimizationTechnique,
    context: OptimizationContext,
  ): string {
    // Stub: apply simple transformations to demonstrate technique application
    switch (technique) {
      case 'add-specificity':
        return prompt.endsWith('.') ? prompt : `${prompt}. Be specific and precise.`;
      case 'structure-output':
        return `${prompt}\n\nPlease structure your response clearly.`;
      case 'inject-context':
        if (context.additionalContext) {
          return `Context: ${context.additionalContext}\n\n${prompt}`;
        }
        return prompt;
      case 'few-shot-examples':
        return `${prompt}\n\nProvide examples where appropriate.`;
      default:
        return prompt;
    }
  }
}
