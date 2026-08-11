/**
 * Agent Skill Bundle Service (NON-AUTHORITATIVE COMPATIBILITY)
 *
 * WARNING: This module's in-memory mappings are NON-AUTHORITATIVE during
 * the transition to persisted reconciled bundles. The authoritative read
 * path is `authoritative-skill-reader.ts` which reads from the
 * `AgentSkillsService` persisted Assignment_Store.
 *
 * This module is retained ONLY for:
 *  - Backward-compatible import side-effects during `importAgents()`
 *  - Template path lookups (getTemplatePath)
 *  - Legacy UI compatibility during the transition period
 *
 * This module is PROHIBITED from:
 *  - Completion gate decisions (Requirements 10.20–10.22)
 *  - Authoritative skill resolution (Requirement 10.3)
 *  - Bundle persistence planning (Requirements 10.13–10.15)
 *  - Skill coverage equality verification (Requirement 10.11)
 *
 * Use `readAuthoritativeSkillBundle()` from `authoritative-skill-reader.ts`
 * for any runtime decision that depends on correct skill assignments.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8, 22.9, 22.10, 22.11
 *
 * @deprecated In-memory authority retired per spec task 9.4.
 * Retained as non-authoritative compatibility only.
 */

import { AgentDefinition } from '../agents/agent-registry';

// ─────────────────────────────────────────────
// Skill Category Definitions
// ─────────────────────────────────────────────

/**
 * Skill categories assignable based on agent capabilities.
 * Requirement 22.8: Auto-assign skills from categories based on capabilities.
 */
export const SKILL_CATEGORIES: Record<string, string[]> = {
  'code-generation': [
    'code-generation',
    'code-review',
    'refactoring',
    'code-scaffolding',
  ],
  testing: [
    'unit-testing',
    'integration-testing',
    'property-testing',
    'test-automation',
  ],
  documentation: [
    'technical-writing',
    'api-docs',
    'readme-generation',
    'changelog-management',
  ],
  'design-systems': [
    'component-design',
    'design-tokens',
    'accessibility-audit',
    'style-guide',
  ],
  infrastructure: [
    'ci-cd-pipelines',
    'container-orchestration',
    'cloud-provisioning',
    'monitoring-setup',
  ],
  analysis: [
    'data-analysis',
    'research-synthesis',
    'competitive-analysis',
    'metrics-reporting',
  ],
  communication: [
    'copywriting',
    'campaign-strategy',
    'social-content',
    'email-marketing',
  ],
};

/**
 * Department → skill category mapping.
 * Determines which categories are auto-assigned based on department.
 */
const DEPARTMENT_SKILL_MAP: Record<string, string[]> = {
  Engineering: ['code-generation', 'testing'],
  Design: ['design-systems'],
  Marketing: ['communication'],
  Product: ['documentation', 'analysis'],
  'Project Management': ['documentation'],
  Testing: ['testing'],
  Support: ['communication', 'documentation'],
  Specialized: [],
  Consensus: [],
  Infrastructure: ['infrastructure'],
  Optimization: ['code-generation', 'analysis'],
  Research: ['analysis'],
  'Software Delivery': ['code-generation', 'infrastructure'],
  'NeuroNest Orchestration': [],
  DevOps: ['infrastructure', 'code-generation'],
  Security: ['testing', 'code-generation'],
  Sales: ['communication'],
  'Paid Media': ['communication', 'analysis'],
  'Spatial Computing': ['code-generation'],
  Finance: ['analysis'],
  'Game Development': ['code-generation', 'testing'],
  Academic: ['analysis', 'documentation'],
  GIS: ['code-generation', 'analysis'],
  Healthcare: ['analysis', 'documentation'],
};

/**
 * Technology/framework → skill ID mappings.
 * Used for Requirement 22.9: match and assign skills based on systemPrompt tool references.
 */
const TECHNOLOGY_SKILL_MAP: Record<string, string[]> = {
  terraform: ['infrastructure', 'cloud-provisioning'],
  kubernetes: ['infrastructure', 'container-orchestration'],
  docker: ['infrastructure', 'container-orchestration'],
  figma: ['design-systems', 'component-design'],
  jest: ['testing', 'unit-testing'],
  vitest: ['testing', 'unit-testing'],
  mocha: ['testing', 'unit-testing'],
  cypress: ['testing', 'integration-testing'],
  playwright: ['testing', 'integration-testing'],
  react: ['code-generation', 'code-scaffolding'],
  vue: ['code-generation', 'code-scaffolding'],
  svelte: ['code-generation', 'code-scaffolding'],
  angular: ['code-generation', 'code-scaffolding'],
  nextjs: ['code-generation', 'code-scaffolding'],
  graphql: ['code-generation', 'api-docs'],
  rest: ['code-generation', 'api-docs'],
  postgresql: ['code-generation', 'infrastructure'],
  mongodb: ['code-generation', 'infrastructure'],
  redis: ['code-generation', 'infrastructure'],
  aws: ['infrastructure', 'cloud-provisioning'],
  gcp: ['infrastructure', 'cloud-provisioning'],
  azure: ['infrastructure', 'cloud-provisioning'],
  jenkins: ['infrastructure', 'ci-cd-pipelines'],
  github_actions: ['infrastructure', 'ci-cd-pipelines'],
  prometheus: ['infrastructure', 'monitoring-setup'],
  grafana: ['infrastructure', 'monitoring-setup'],
  webpack: ['code-generation', 'code-scaffolding'],
  vite: ['code-generation', 'code-scaffolding'],
  python: ['code-generation'],
  typescript: ['code-generation'],
  rust: ['code-generation'],
  go: ['code-generation'],
};

/**
 * Deliverable type patterns matched in systemPrompt for design template generation.
 * Requirement 22.5: Generate design template stubs from systemPrompt deliverable type references.
 */
const DELIVERABLE_PATTERNS: Record<string, RegExp> = {
  'api-spec': /\b(api\s+specs?|openapi|swagger|api\s+design|rest\s+api\s+documentation)\b/i,
  'test-plan': /\b(test\s+plans?|testing\s+strategy|test\s+suites?|qa\s+plans?)\b/i,
  'architecture-document': /\b(architecture\s+documents?|system\s+design|technical\s+architecture|design\s+documents?)\b/i,
  'marketing-brief': /\b(marketing\s+briefs?|campaign\s+briefs?|creative\s+briefs?|brand\s+briefs?)\b/i,
  'deployment-manifest': /\b(deployment\s+manifests?|kubernetes\s+manifests?|helm\s+charts?|docker-compose|infrastructure\s+specs?)\b/i,
  'user-research': /\b(user\s+research|usability\s+reports?|personas?|user\s+journeys?)\b/i,
  'code-scaffold': /\b(boilerplate|scaffolds?|starter\s+templates?|project\s+templates?)\b/i,
  'data-model': /\b(data\s+models?|schema\s+design|erd|database\s+schemas?|entity\s+relationship)\b/i,
  'security-audit': /\b(security\s+audits?|vulnerability\s+reports?|threat\s+models?|pen\s+test\s+reports?)\b/i,
  'performance-report': /\b(performance\s+reports?|load\s+test\s+results|benchmark\s+reports?|optimization\s+plans?)\b/i,
};

// ─────────────────────────────────────────────
// In-Memory Mapping Table
// ─────────────────────────────────────────────

/**
 * NON-AUTHORITATIVE in-memory mapping: agent ID → skill IDs.
 *
 * This map is populated during `importAgents()` as a backward-compatible
 * side-effect. It is NOT the authoritative source of truth for skill
 * assignments. The authoritative persisted Assignment_Store is accessed
 * through `AgentSkillsService.getAgentSkills()`.
 *
 * @deprecated Non-authoritative. Use the persisted service path.
 * Requirement 22.2: Maintain skill-to-agent mapping table.
 */
const skillToAgentMap: Map<string, string[]> = new Map();

/**
 * In-memory mapping: agent ID → design template file names.
 */
const templateToAgentMap: Map<string, string[]> = new Map();

/**
 * Cache of all known agent definitions for re-evaluation.
 */
const agentDefinitionCache: Map<string, AgentDefinition> = new Map();

// ─────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────

/**
 * Returns the skill IDs mapped to a given agent from the IN-MEMORY cache.
 *
 * WARNING: NON-AUTHORITATIVE. This function reads from the in-memory
 * `skillToAgentMap` which is NOT the authoritative source of truth.
 * It is retained for backward compatibility only.
 *
 * For authoritative skill reads, use:
 *   `readAuthoritativeSkillBundle(agentId)` from `authoritative-skill-reader.ts`
 *
 * This function MUST NOT be used for:
 *  - Completion gate decisions
 *  - Skill coverage equality verification
 *  - Bundle persistence planning or reconciliation
 *
 * Requirement 22.10: Expose getAgentSkills(agentId) API for orchestrator.
 *
 * @deprecated Non-authoritative. Use readAuthoritativeSkillBundle() instead.
 * @param agentId - The agent's unique identifier
 * @returns Object with skillIds and designTemplates for the agent
 */
export function getAgentSkills(agentId: string): {
  skillIds: string[];
  designTemplates: string[];
  templatePath: string;
  /** Always false — this path is non-authoritative compatibility only. */
  authoritative: false;
} {
  const skillIds = skillToAgentMap.get(agentId) || [];
  const designTemplates = templateToAgentMap.get(agentId) || [];
  const templatePath = getTemplatePath(agentId);

  return {
    skillIds,
    designTemplates,
    templatePath,
    authoritative: false,
  };
}

/**
 * Analyzes an agent's department, specialty, and systemPrompt to determine
 * which skill IDs should be assigned to the IN-MEMORY mapping.
 *
 * WARNING: NON-AUTHORITATIVE. This function populates the in-memory
 * `skillToAgentMap` which is NOT the authoritative assignment store.
 * It is retained as a compatibility side-effect during `importAgents()`.
 *
 * The authoritative assignment path is the complete-bundle reconciliation
 * through `AgentSkillsService.reconcileAgentSkillBundle()`.
 *
 * This function's output MUST NOT be used for:
 *  - Completion gate decisions (Requirements 10.20–10.22)
 *  - Skill coverage equality verification
 *  - Authoritative bundle validation
 *
 * Requirement 22.1: Assign skill bundle derived from department, specialty, and systemPrompt.
 *
 * @deprecated Non-authoritative. Retained for import compatibility only.
 * @param agent - The AgentDefinition to analyze
 * @returns Array of skill IDs assigned to this agent (non-authoritative)
 */
export function assignSkillBundle(agent: AgentDefinition): string[] {
  const skillIds = new Set<string>();

  // 1. Assign skills based on department
  const departmentSkills = DEPARTMENT_SKILL_MAP[agent.department] || [];
  for (const category of departmentSkills) {
    const categorySkills = SKILL_CATEGORIES[category] || [];
    for (const skill of categorySkills) {
      skillIds.add(skill);
    }
  }

  // 2. Analyze specialty keywords for additional skill matching
  const specialtyLower = agent.specialty.toLowerCase();
  for (const [tech, skills] of Object.entries(TECHNOLOGY_SKILL_MAP)) {
    if (specialtyLower.includes(tech.replace(/_/g, ' '))) {
      for (const skill of skills) {
        skillIds.add(skill);
      }
    }
  }

  // 3. Analyze systemPrompt for technology/framework references
  // Requirement 22.9: Match and assign existing skills covering referenced technologies
  const promptLower = agent.systemPrompt.toLowerCase();
  for (const [tech, skills] of Object.entries(TECHNOLOGY_SKILL_MAP)) {
    const searchTerm = tech.replace(/_/g, ' ');
    if (promptLower.includes(searchTerm)) {
      for (const skill of skills) {
        skillIds.add(skill);
      }
    }
  }

  // 4. Detect deliverable types for design template generation
  // Requirement 22.5: Generate design template stubs from systemPrompt deliverable references
  const detectedTemplates: string[] = [];
  for (const [templateName, pattern] of Object.entries(DELIVERABLE_PATTERNS)) {
    if (pattern.test(agent.systemPrompt)) {
      detectedTemplates.push(templateName);
    }
  }

  // 5. Store mappings
  const finalSkillIds = Array.from(skillIds).sort();
  skillToAgentMap.set(agent.id, finalSkillIds);
  templateToAgentMap.set(agent.id, detectedTemplates);
  agentDefinitionCache.set(agent.id, agent);

  return finalSkillIds;
}

/**
 * Returns the template directory path for a given agent.
 * Requirement 22.6: Templates stored at src/agent-skills/templates/{agent-id}/
 *
 * @param agentId - The agent's unique identifier
 * @returns The file path for the agent's design templates
 */
export function getTemplatePath(agentId: string): string {
  return `src/agent-skills/templates/${agentId}/`;
}

/**
 * Re-evaluates all skill-to-agent mappings in the IN-MEMORY map.
 * Called when skills are updated or new skills are added.
 *
 * WARNING: NON-AUTHORITATIVE. This updates only the in-memory compatibility
 * map. Authoritative re-evaluation requires reconciliation through
 * `AgentSkillsService.reconcileAgentSkillBundle()`.
 *
 * @deprecated Non-authoritative. Retained for backward compatibility.
 * Requirement 22.11: Re-evaluate mappings when skills updated or added.
 */
export function reEvaluateMappings(): void {
  for (const [, agent] of agentDefinitionCache.entries()) {
    assignSkillBundle(agent);
  }
}

/**
 * Returns the full in-memory mapping table.
 * Useful for debugging and for the orchestrator to batch-load skill information.
 *
 * WARNING: NON-AUTHORITATIVE. Use the persisted service path for decisions.
 * @deprecated Non-authoritative compatibility.
 */
export function getSkillMappingTable(): ReadonlyMap<string, string[]> {
  return skillToAgentMap;
}

/**
 * Returns the design template mapping table.
 */
export function getTemplateMappingTable(): ReadonlyMap<string, string[]> {
  return templateToAgentMap;
}

/**
 * Clears all mappings (useful for testing and re-initialization).
 */
export function clearMappings(): void {
  skillToAgentMap.clear();
  templateToAgentMap.clear();
  agentDefinitionCache.clear();
}

/**
 * Checks whether a given agent has been assigned any skills.
 */
export function hasSkillsAssigned(agentId: string): boolean {
  const skills = skillToAgentMap.get(agentId);
  return skills !== undefined && skills.length > 0;
}

/**
 * Gets all agent IDs that have a specific skill assigned (IN-MEMORY ONLY).
 * Useful for reverse lookups when determining which agents can handle a task.
 *
 * WARNING: NON-AUTHORITATIVE. Reads from the in-memory map, not the
 * persisted Assignment_Store. Results may not reflect reconciled bundles.
 *
 * @deprecated Non-authoritative. Query the persisted service for authoritative data.
 */
export function getAgentsBySkill(skillId: string): string[] {
  const agents: string[] = [];
  for (const [agentId, skills] of skillToAgentMap.entries()) {
    if (skills.includes(skillId)) {
      agents.push(agentId);
    }
  }
  return agents;
}
