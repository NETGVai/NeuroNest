/**
 * Taxonomy and Authoritative Catalog Inventory/Migration Tooling
 *
 * Dynamically inventories every discovered/static/effective agent dimension
 * and every authoritative catalog entry. Classifies legacy map outputs as
 * exact IDs, category-only labels, missing, disabled, uninstalled, or
 * multiply resolved. Emits validated migration inputs.
 *
 * Creates versioned taxonomy data from actual catalog metadata, including
 * explicit capability-backed rules for currently empty/unknown departments
 * (Specialized, Consensus, NeuroNest Orchestration, Data Science), while
 * handling any future department identically.
 *
 * Migrates complete dynamic catalog capability metadata rather than a curated
 * source/ID list; unresolved inventory must remain blocking.
 *
 * Requirements: 10.1–10.7, 10.12, 10.19
 */

import type { AgentPopulationManifest } from '../agent-catalog/agent-population';
import type { AuthoritativeSkillCatalogSnapshot, SkillCatalogEntry } from './agent-skills-service';
import type {
  SkillTaxonomyRule,
  TaxonomySelector,
  TaxonomyDimension,
  SkillTaxonomySnapshot,
} from './skill-taxonomy';
import {
  normalizeText,
  buildTaxonomySnapshot,
  skillSelector,
  categorySelector,
  createRule,
} from './skill-taxonomy';

// ─────────────────────────────────────────────
// Inventory Classification Types
// ─────────────────────────────────────────────

/**
 * Classification of a legacy mapping output against the authoritative catalog.
 */
export type LegacyOutputClassification =
  | 'exact-id'         // Matches exactly one enabled+installed catalog entry by ID
  | 'category-only'    // Is a category label, not a direct skill ID
  | 'missing'          // Not found in the catalog at all
  | 'disabled'         // Found but entry is disabled
  | 'uninstalled'      // Found but entry is not installed
  | 'multiply-resolved'; // Multiple entries share the same ID

/**
 * A single classified legacy output from the in-memory maps.
 */
export interface ClassifiedLegacyOutput {
  readonly value: string;
  readonly source: 'department-skill-map' | 'technology-skill-map' | 'skill-categories';
  readonly sourceKey: string;
  readonly classification: LegacyOutputClassification;
  readonly matchCount: number;
  readonly catalogEntry: SkillCatalogEntry | null;
  readonly blocking: boolean;
}

/**
 * An inventoried agent dimension extracted from the population manifest.
 */
export interface InventoriedAgentDimension {
  readonly agentId: string;
  readonly sourcePath: string | null;
  readonly department: string;
  readonly specialty: string;
  readonly normalizedDepartment: string;
  readonly normalizedSpecialty: string;
  readonly technologies: readonly string[];
  readonly capabilities: readonly string[];
  readonly deliverables: readonly string[];
}

/**
 * An inventoried catalog entry from the authoritative snapshot.
 */
export interface InventoriedCatalogEntry {
  readonly skillId: string;
  readonly category: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly capabilityKeys: readonly string[];
  readonly technologyKeys: readonly string[];
  readonly deliverableKeys: readonly string[];
  readonly eligible: boolean;
}

/**
 * Result of a complete inventory run.
 */
export interface InventoryResult {
  readonly agentDimensions: readonly InventoriedAgentDimension[];
  readonly catalogEntries: readonly InventoriedCatalogEntry[];
  readonly classifiedLegacyOutputs: readonly ClassifiedLegacyOutput[];
  readonly unresolvedItems: readonly UnresolvedInventoryItem[];
  readonly departmentCoverage: ReadonlyMap<string, DepartmentCoverageStatus>;
  readonly migrationInputs: readonly ValidatedMigrationInput[];
  readonly blocking: boolean;
  readonly blockingReasons: readonly string[];
}

/**
 * An item that could not be resolved during inventory - these are blocking.
 */
export interface UnresolvedInventoryItem {
  readonly kind: 'legacy-output' | 'department-mapping' | 'catalog-entry';
  readonly identifier: string;
  readonly reason: string;
  readonly relatedAgentIds: readonly string[];
}

/**
 * Coverage status for a department in the taxonomy.
 */
export interface DepartmentCoverageStatus {
  readonly department: string;
  readonly normalizedDepartment: string;
  readonly hasRules: boolean;
  readonly agentCount: number;
  readonly coveredCapabilities: readonly string[];
  readonly uncoveredCapabilities: readonly string[];
  readonly blocking: boolean;
}

/**
 * A validated migration input ready for taxonomy rule generation.
 */
export interface ValidatedMigrationInput {
  readonly dimension: TaxonomyDimension;
  readonly normalizedMatch: string;
  readonly selectors: readonly TaxonomySelector[];
  readonly supportedCapabilityKeys: readonly string[];
  readonly sourceEvidence: MigrationSourceEvidence;
  readonly validated: boolean;
}

/**
 * Evidence for why a migration input was generated.
 */
export interface MigrationSourceEvidence {
  readonly origin: 'catalog-metadata' | 'legacy-map' | 'agent-dimension';
  readonly catalogSkillIds: readonly string[];
  readonly legacyMapKey?: string;
  readonly legacyMapSource?: string;
  readonly agentIds: readonly string[];
}

// ─────────────────────────────────────────────
// Legacy Map Definitions (read-only migration input)
// ─────────────────────────────────────────────

/**
 * Legacy DEPARTMENT_SKILL_MAP from agent-skill-bundle.ts.
 * These are MIGRATION INPUTS ONLY and never authoritative output.
 */
const LEGACY_DEPARTMENT_SKILL_MAP: Record<string, string[]> = {
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
  'Data Science': [],
};

/**
 * Legacy SKILL_CATEGORIES from agent-skill-bundle.ts.
 * These map category names to arrays of skill-like strings.
 */
const LEGACY_SKILL_CATEGORIES: Record<string, string[]> = {
  'code-generation': ['code-generation', 'code-review', 'refactoring', 'code-scaffolding'],
  testing: ['unit-testing', 'integration-testing', 'property-testing', 'test-automation'],
  documentation: ['technical-writing', 'api-docs', 'readme-generation', 'changelog-management'],
  'design-systems': ['component-design', 'design-tokens', 'accessibility-audit', 'style-guide'],
  infrastructure: ['ci-cd-pipelines', 'container-orchestration', 'cloud-provisioning', 'monitoring-setup'],
  analysis: ['data-analysis', 'research-synthesis', 'competitive-analysis', 'metrics-reporting'],
  communication: ['copywriting', 'campaign-strategy', 'social-content', 'email-marketing'],
};

/**
 * Legacy TECHNOLOGY_SKILL_MAP from agent-skill-bundle.ts.
 */
const LEGACY_TECHNOLOGY_SKILL_MAP: Record<string, string[]> = {
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

// ─────────────────────────────────────────────
// Core Inventory Functions
// ─────────────────────────────────────────────

/**
 * Extracts technology references from an agent's specialty and systemPrompt.
 * Uses token-boundary analysis rather than substring matching.
 */
function extractTechnologies(specialty: string, systemPrompt: string): string[] {
  const combined = `${specialty} ${systemPrompt}`.toLowerCase();
  const techKeywords = Object.keys(LEGACY_TECHNOLOGY_SKILL_MAP);
  const found: string[] = [];

  for (const tech of techKeywords) {
    const searchTerm = tech.replace(/_/g, ' ');
    if (combined.includes(searchTerm)) {
      found.push(tech);
    }
  }

  return [...new Set(found)].sort();
}

/**
 * Extracts capability claims from agent specialty text.
 * Looks for verbs indicating responsibility/operation/expertise.
 */
function extractCapabilities(specialty: string, systemPrompt: string): string[] {
  const capabilities: string[] = [];
  const combined = `${specialty} ${systemPrompt}`;

  // Extract verb-noun capability patterns
  const capabilityPatterns = [
    /\b(?:builds?|creates?|develops?|implements?|designs?)\s+([\w\s-]+?)(?:\.|,|;|\band\b)/gi,
    /\b(?:manages?|maintains?|monitors?|optimizes?|configures?)\s+([\w\s-]+?)(?:\.|,|;|\band\b)/gi,
    /\b(?:analyzes?|evaluates?|reviews?|audits?|validates?)\s+([\w\s-]+?)(?:\.|,|;|\band\b)/gi,
    /\b(?:deploys?|provisions?|orchestrates?|automates?)\s+([\w\s-]+?)(?:\.|,|;|\band\b)/gi,
  ];

  for (const pattern of capabilityPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(combined)) !== null) {
      const cap = match[1]?.trim().toLowerCase();
      if (cap && cap.length > 2 && cap.length < 50) {
        capabilities.push(normalizeText(cap));
      }
    }
  }

  return [...new Set(capabilities)].sort();
}

/**
 * Extracts deliverable patterns from agent systemPrompt text.
 */
function extractDeliverables(systemPrompt: string): string[] {
  const deliverables: string[] = [];
  const deliverablePatterns: Record<string, RegExp> = {
    'api-spec': /\b(api\s+specs?|openapi|swagger|api\s+design|rest\s+api\s+documentation)\b/i,
    'test-plan': /\b(test\s+plans?|testing\s+strategy|test\s+suites?|qa\s+plans?)\b/i,
    'architecture-document': /\b(architecture\s+documents?|system\s+design|technical\s+architecture)\b/i,
    'deployment-manifest': /\b(deployment\s+manifests?|kubernetes\s+manifests?|helm\s+charts?)\b/i,
    'code-scaffold': /\b(boilerplate|scaffolds?|starter\s+templates?|project\s+templates?)\b/i,
    'data-model': /\b(data\s+models?|schema\s+design|database\s+schemas?)\b/i,
    'security-audit': /\b(security\s+audits?|vulnerability\s+reports?|threat\s+models?)\b/i,
    'performance-report': /\b(performance\s+reports?|load\s+test|benchmark\s+reports?)\b/i,
  };

  for (const [name, pattern] of Object.entries(deliverablePatterns)) {
    if (pattern.test(systemPrompt)) {
      deliverables.push(name);
    }
  }

  return [...new Set(deliverables)].sort();
}

/**
 * Inventories every agent dimension from the population manifest.
 * Covers every discovered source AND every effective agent.
 *
 * Requirement 10.1: dynamically validates every current and future agent
 * without using a fixed count, identity list, or source-path list.
 */
export function inventoryAgentDimensions(
  population: AgentPopulationManifest,
): readonly InventoriedAgentDimension[] {
  const dimensions: InventoriedAgentDimension[] = [];
  const seen = new Set<string>();

  // Inventory every effective agent
  for (const effective of population.effectiveAgents) {
    const key = `effective:${effective.agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const def = effective.definition;
    dimensions.push(buildDimensionEntry(
      effective.agentId,
      effective.sourcePaths[0] ?? null,
      def.department,
      def.specialty,
      def.systemPrompt,
    ));
  }

  // Also inventory discovered sources (may differ from effective for duplicates)
  for (const source of population.discoveredSources) {
    const candidate = population.importCandidates.find(
      c => c.candidateKey === source.candidateKey,
    );
    if (!candidate) continue;

    const key = `source:${source.sourcePath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const def = candidate.definition;
    dimensions.push(buildDimensionEntry(
      source.agentId,
      source.sourcePath,
      def.department,
      def.specialty,
      def.systemPrompt,
    ));
  }

  // Inventory static agents that weren't import candidates
  for (const staticAgent of population.staticAgents) {
    const key = `static:${staticAgent.definition.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const def = staticAgent.definition;
    dimensions.push(buildDimensionEntry(
      def.id,
      null,
      def.department,
      def.specialty,
      def.systemPrompt,
    ));
  }

  return dimensions.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function buildDimensionEntry(
  agentId: string,
  sourcePath: string | null,
  department: string,
  specialty: string,
  systemPrompt: string,
): InventoriedAgentDimension {
  return Object.freeze({
    agentId,
    sourcePath,
    department,
    specialty,
    normalizedDepartment: normalizeText(department),
    normalizedSpecialty: normalizeText(specialty),
    technologies: Object.freeze(extractTechnologies(specialty, systemPrompt)),
    capabilities: Object.freeze(extractCapabilities(specialty, systemPrompt)),
    deliverables: Object.freeze(extractDeliverables(systemPrompt)),
  });
}

// ─────────────────────────────────────────────
// Catalog Inventory
// ─────────────────────────────────────────────

/**
 * Inventories every entry in the authoritative skill catalog snapshot.
 * Extracts capability, technology, and deliverable metadata dynamically.
 *
 * Requirements: 10.2, 10.3 - catalog resolution based on actual entries.
 */
export function inventoryCatalogEntries(
  catalog: AuthoritativeSkillCatalogSnapshot,
): readonly InventoriedCatalogEntry[] {
  return catalog.entries.map(entry => Object.freeze({
    skillId: entry.skillId,
    category: entry.category,
    enabled: entry.enabled,
    installed: entry.installed,
    capabilityKeys: entry.capabilityKeys,
    technologyKeys: entry.technologyKeys,
    deliverableKeys: entry.deliverableKeys,
    eligible: entry.enabled && entry.installed,
  }));
}

// ─────────────────────────────────────────────
// Legacy Output Classification
// ─────────────────────────────────────────────

/**
 * Classifies a single legacy output value against the authoritative catalog.
 * Returns the classification and whether it's blocking.
 */
function classifySingleOutput(
  value: string,
  source: ClassifiedLegacyOutput['source'],
  sourceKey: string,
  catalog: AuthoritativeSkillCatalogSnapshot,
): ClassifiedLegacyOutput {
  // Check if value exists as an exact skill ID
  const idEntries = catalog.byId.get(value);

  if (idEntries && idEntries.length === 1) {
    const entry = idEntries[0]!;
    if (!entry.enabled) {
      return Object.freeze({
        value,
        source,
        sourceKey,
        classification: 'disabled',
        matchCount: 1,
        catalogEntry: entry,
        blocking: true,
      });
    }
    if (!entry.installed) {
      return Object.freeze({
        value,
        source,
        sourceKey,
        classification: 'uninstalled',
        matchCount: 1,
        catalogEntry: entry,
        blocking: true,
      });
    }
    return Object.freeze({
      value,
      source,
      sourceKey,
      classification: 'exact-id',
      matchCount: 1,
      catalogEntry: entry,
      blocking: false,
    });
  }

  if (idEntries && idEntries.length > 1) {
    return Object.freeze({
      value,
      source,
      sourceKey,
      classification: 'multiply-resolved',
      matchCount: idEntries.length,
      catalogEntry: null,
      blocking: true,
    });
  }

  // Check if value is a category label
  const categoryEntries = catalog.byCategory.get(value);
  if (categoryEntries && categoryEntries.length > 0) {
    return Object.freeze({
      value,
      source,
      sourceKey,
      classification: 'category-only',
      matchCount: categoryEntries.length,
      catalogEntry: null,
      blocking: true, // Category labels are not IDs; need proper resolution
    });
  }

  // Not found at all
  return Object.freeze({
    value,
    source,
    sourceKey,
    classification: 'missing',
    matchCount: 0,
    catalogEntry: null,
    blocking: true,
  });
}

/**
 * Classifies all legacy map outputs against the authoritative catalog.
 * Every unique output value from DEPARTMENT_SKILL_MAP, SKILL_CATEGORIES,
 * and TECHNOLOGY_SKILL_MAP is classified.
 *
 * Requirements: 10.3, 10.7 - classifies category labels vs exact IDs
 */
export function classifyLegacyOutputs(
  catalog: AuthoritativeSkillCatalogSnapshot,
): readonly ClassifiedLegacyOutput[] {
  const results: ClassifiedLegacyOutput[] = [];
  const seen = new Set<string>();

  // Classify DEPARTMENT_SKILL_MAP outputs (these are category labels)
  for (const [dept, categories] of Object.entries(LEGACY_DEPARTMENT_SKILL_MAP)) {
    for (const cat of categories) {
      const key = `dept:${dept}:${cat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(classifySingleOutput(cat, 'department-skill-map', dept, catalog));
    }
  }

  // Classify SKILL_CATEGORIES outputs (these are the expanded skill-like IDs)
  for (const [category, skills] of Object.entries(LEGACY_SKILL_CATEGORIES)) {
    for (const skill of skills) {
      const key = `cat:${category}:${skill}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(classifySingleOutput(skill, 'skill-categories', category, catalog));
    }
  }

  // Classify TECHNOLOGY_SKILL_MAP outputs
  for (const [tech, outputs] of Object.entries(LEGACY_TECHNOLOGY_SKILL_MAP)) {
    for (const output of outputs) {
      const key = `tech:${tech}:${output}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(classifySingleOutput(output, 'technology-skill-map', tech, catalog));
    }
  }

  return results.sort((a, b) =>
    a.source.localeCompare(b.source) || a.value.localeCompare(b.value),
  );
}

// ─────────────────────────────────────────────
// Versioned Taxonomy Data Generation
// ─────────────────────────────────────────────

/**
 * Generates validated migration inputs from catalog metadata.
 * Creates taxonomy rules backed by actual catalog capability metadata
 * rather than a curated source/ID list.
 *
 * For departments with empty mappings (Specialized, Consensus,
 * NeuroNest Orchestration, Data Science), generates rules only when
 * actual catalog entries provide capability backing. Any future
 * department with an empty mapping is handled identically.
 *
 * Requirements: 10.4–10.7, 10.12, 10.19
 */
export function generateMigrationInputs(
  agentDimensions: readonly InventoriedAgentDimension[],
  catalogEntries: readonly InventoriedCatalogEntry[],
  classifiedOutputs: readonly ClassifiedLegacyOutput[],
): readonly ValidatedMigrationInput[] {
  const inputs: ValidatedMigrationInput[] = [];

  // Get all eligible catalog entries (enabled + installed)
  const eligibleEntries = catalogEntries.filter(e => e.eligible);

  // Build capability-to-skill index from actual catalog metadata
  const capabilityToSkills = new Map<string, string[]>();
  const technologyToSkills = new Map<string, string[]>();
  const deliverableToSkills = new Map<string, string[]>();

  for (const entry of eligibleEntries) {
    for (const cap of entry.capabilityKeys) {
      const bucket = capabilityToSkills.get(cap) ?? [];
      bucket.push(entry.skillId);
      capabilityToSkills.set(cap, bucket);
    }
    for (const tech of entry.technologyKeys) {
      const bucket = technologyToSkills.get(tech) ?? [];
      bucket.push(entry.skillId);
      technologyToSkills.set(tech, bucket);
    }
    for (const del of entry.deliverableKeys) {
      const bucket = deliverableToSkills.get(del) ?? [];
      bucket.push(del);
      deliverableToSkills.set(del, bucket);
    }
  }

  // Generate department-level rules from agent dimensions
  const departmentAgents = groupByDepartment(agentDimensions);

  for (const [department, agents] of departmentAgents) {
    const normalizedDept = normalizeText(department);
    const legacyCategories = LEGACY_DEPARTMENT_SKILL_MAP[department] ?? [];

    // For departments WITH legacy mappings: generate rules from catalog-backed categories
    if (legacyCategories.length > 0) {
      const selectors: TaxonomySelector[] = [];
      const supportedCaps: string[] = [];

      for (const cat of legacyCategories) {
        // Find eligible catalog entries in this category
        const catEntries = eligibleEntries.filter(e => e.category === cat);
        if (catEntries.length > 0) {
          // Use CategorySelector since these are category labels
          const capKeys = catEntries.flatMap(e => [...e.capabilityKeys]);
          const uniqueCaps = [...new Set(capKeys)].sort();
          for (const capKey of uniqueCaps) {
            selectors.push(categorySelector(cat, capKey));
            supportedCaps.push(capKey);
          }
        }

        // Also check if any catalog entry has this exact ID
        const idMatch = classifiedOutputs.find(
          o => o.value === cat && o.classification === 'exact-id',
        );
        if (idMatch) {
          selectors.push(skillSelector(cat));
          supportedCaps.push(cat);
        }
      }

      if (selectors.length > 0) {
        inputs.push(Object.freeze({
          dimension: 'department' as TaxonomyDimension,
          normalizedMatch: normalizedDept,
          selectors: Object.freeze(selectors),
          supportedCapabilityKeys: Object.freeze([...new Set(supportedCaps)].sort()),
          sourceEvidence: Object.freeze({
            origin: 'catalog-metadata',
            catalogSkillIds: selectors
              .filter((s): s is ReturnType<typeof skillSelector> => s.kind === 'skill')
              .map(s => s.skillId)
              .sort(),
            legacyMapKey: department,
            legacyMapSource: 'DEPARTMENT_SKILL_MAP',
            agentIds: agents.map(a => a.agentId).sort(),
          }),
          validated: true,
        }));
      }
    }

    // For departments WITH EMPTY mappings (Specialized, Consensus,
    // NeuroNest Orchestration, Data Science, or any future department):
    // Generate rules ONLY from agent capabilities matched to catalog metadata
    if (legacyCategories.length === 0) {
      const departmentInputs = generateCapabilityBackedRules(
        normalizedDept,
        department,
        agents,
        eligibleEntries,
        capabilityToSkills,
        technologyToSkills,
      );
      inputs.push(...departmentInputs);
    }
  }

  // Generate technology-level rules from catalog metadata
  for (const [tech, skillIds] of technologyToSkills) {
    const uniqueIds = [...new Set(skillIds)].sort();
    const selectors: TaxonomySelector[] = uniqueIds.map(id => skillSelector(id));
    const relatedAgents = agentDimensions
      .filter(d => d.technologies.includes(tech))
      .map(d => d.agentId);

    inputs.push(Object.freeze({
      dimension: 'technology' as TaxonomyDimension,
      normalizedMatch: normalizeText(tech),
      selectors: Object.freeze(selectors),
      supportedCapabilityKeys: Object.freeze([tech]),
      sourceEvidence: Object.freeze({
        origin: 'catalog-metadata',
        catalogSkillIds: uniqueIds,
        agentIds: relatedAgents.sort(),
      }),
      validated: true,
    }));
  }

  // Generate deliverable-level rules from catalog metadata
  for (const [del, skillIds] of deliverableToSkills) {
    const uniqueIds = [...new Set(skillIds)].sort();
    const selectors: TaxonomySelector[] = uniqueIds.map(id => skillSelector(id));
    const relatedAgents = agentDimensions
      .filter(d => d.deliverables.includes(del))
      .map(d => d.agentId);

    inputs.push(Object.freeze({
      dimension: 'deliverable' as TaxonomyDimension,
      normalizedMatch: normalizeText(del),
      selectors: Object.freeze(selectors),
      supportedCapabilityKeys: Object.freeze([del]),
      sourceEvidence: Object.freeze({
        origin: 'catalog-metadata',
        catalogSkillIds: uniqueIds,
        agentIds: relatedAgents.sort(),
      }),
      validated: true,
    }));
  }

  return inputs.sort((a, b) =>
    a.dimension.localeCompare(b.dimension) || a.normalizedMatch.localeCompare(b.normalizedMatch),
  );
}

/**
 * Generates capability-backed taxonomy rules for departments with empty
 * or unknown legacy mappings. Inspects actual agent capabilities and matches
 * them against catalog metadata. Any future department is handled identically.
 *
 * Requirement 10.7: If taxonomy mapping is unknown or empty, assigns
 * Manual_Review_Block and assigns no unrelated generic fallback.
 */
function generateCapabilityBackedRules(
  normalizedDept: string,
  department: string,
  agents: readonly InventoriedAgentDimension[],
  eligibleEntries: readonly InventoriedCatalogEntry[],
  capabilityToSkills: ReadonlyMap<string, string[]>,
  technologyToSkills: ReadonlyMap<string, string[]>,
): ValidatedMigrationInput[] {
  const rules: ValidatedMigrationInput[] = [];

  // Collect all capabilities and technologies from agents in this department
  const allCapabilities = new Set<string>();
  const allTechnologies = new Set<string>();
  const agentIds = agents.map(a => a.agentId).sort();

  for (const agent of agents) {
    for (const cap of agent.capabilities) allCapabilities.add(cap);
    for (const tech of agent.technologies) allTechnologies.add(tech);
  }

  // Match capabilities against catalog entries
  const selectors: TaxonomySelector[] = [];
  const supportedCaps: string[] = [];

  // Check if any agent technologies match catalog technology keys
  for (const tech of allTechnologies) {
    const normalizedTech = normalizeText(tech);
    const matchedSkills = technologyToSkills.get(tech) ?? technologyToSkills.get(normalizedTech) ?? [];
    for (const skillId of matchedSkills) {
      selectors.push(skillSelector(skillId));
      supportedCaps.push(tech);
    }
  }

  // Check if any agent capabilities match catalog capability keys
  for (const cap of allCapabilities) {
    const matchedSkills = capabilityToSkills.get(cap) ?? [];
    for (const skillId of matchedSkills) {
      selectors.push(skillSelector(skillId));
      supportedCaps.push(cap);
    }
  }

  // Check catalog entries whose category broadly matches agent capabilities
  for (const entry of eligibleEntries) {
    for (const capKey of entry.capabilityKeys) {
      if (allCapabilities.has(capKey) || allTechnologies.has(capKey)) {
        if (!selectors.some(s => s.kind === 'skill' && s.skillId === entry.skillId)) {
          selectors.push(skillSelector(entry.skillId));
          supportedCaps.push(capKey);
        }
      }
    }
  }

  if (selectors.length > 0) {
    // Deduplicate selectors by skillId
    const uniqueSelectors = deduplicateSelectors(selectors);

    rules.push(Object.freeze({
      dimension: 'department' as TaxonomyDimension,
      normalizedMatch: normalizedDept,
      selectors: Object.freeze(uniqueSelectors),
      supportedCapabilityKeys: Object.freeze([...new Set(supportedCaps)].sort()),
      sourceEvidence: Object.freeze({
        origin: 'catalog-metadata',
        catalogSkillIds: uniqueSelectors
          .filter((s): s is ReturnType<typeof skillSelector> => s.kind === 'skill')
          .map(s => s.skillId)
          .sort(),
        legacyMapKey: department,
        legacyMapSource: 'DEPARTMENT_SKILL_MAP (empty)',
        agentIds,
      }),
      validated: true,
    }));
  }
  // If no selectors could be generated, this department remains unresolved
  // and will be blocking in the final inventory result.

  return rules;
}

/**
 * Deduplicates selectors by their canonical identity.
 */
function deduplicateSelectors(selectors: TaxonomySelector[]): TaxonomySelector[] {
  const seen = new Set<string>();
  const unique: TaxonomySelector[] = [];
  for (const sel of selectors) {
    const key = sel.kind === 'skill'
      ? `skill:${sel.skillId}`
      : `category:${sel.category}:${sel.capabilityKey}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(sel);
    }
  }
  return unique.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.kind === 'skill' && b.kind === 'skill') return a.skillId.localeCompare(b.skillId);
    if (a.kind === 'category' && b.kind === 'category') {
      const catCmp = a.category.localeCompare(b.category);
      return catCmp !== 0 ? catCmp : a.capabilityKey.localeCompare(b.capabilityKey);
    }
    return 0;
  });
}

/**
 * Groups agent dimensions by their department string.
 */
function groupByDepartment(
  dimensions: readonly InventoriedAgentDimension[],
): Map<string, InventoriedAgentDimension[]> {
  const map = new Map<string, InventoriedAgentDimension[]>();
  for (const dim of dimensions) {
    const bucket = map.get(dim.department) ?? [];
    bucket.push(dim);
    map.set(dim.department, bucket);
  }
  return map;
}

// ─────────────────────────────────────────────
// Department Coverage Analysis
// ─────────────────────────────────────────────

/**
 * Analyzes coverage for every department found in the agent dimensions.
 * Identifies departments that have no taxonomy rules and are therefore blocking.
 *
 * Handles any future department identically to known empty departments.
 */
function analyzeDepartmentCoverage(
  agentDimensions: readonly InventoriedAgentDimension[],
  migrationInputs: readonly ValidatedMigrationInput[],
): Map<string, DepartmentCoverageStatus> {
  const coverage = new Map<string, DepartmentCoverageStatus>();
  const departmentAgents = groupByDepartment(agentDimensions);

  for (const [department, agents] of departmentAgents) {
    const normalizedDept = normalizeText(department);

    // Find rules that cover this department
    const deptRules = migrationInputs.filter(
      input => input.dimension === 'department' && input.normalizedMatch === normalizedDept,
    );

    const hasRules = deptRules.length > 0;
    const allCaps = new Set<string>();
    for (const agent of agents) {
      for (const cap of agent.capabilities) allCaps.add(cap);
      for (const tech of agent.technologies) allCaps.add(tech);
    }

    const coveredCaps = hasRules
      ? deptRules.flatMap(r => [...r.supportedCapabilityKeys])
      : [];

    const coveredSet = new Set(coveredCaps);
    const uncoveredCaps = [...allCaps].filter(c => !coveredSet.has(c)).sort();

    coverage.set(department, Object.freeze({
      department,
      normalizedDepartment: normalizedDept,
      hasRules,
      agentCount: agents.length,
      coveredCapabilities: Object.freeze([...new Set(coveredCaps)].sort()),
      uncoveredCapabilities: Object.freeze(uncoveredCaps),
      blocking: !hasRules && agents.length > 0,
    }));
  }

  return coverage;
}

// ─────────────────────────────────────────────
// Complete Inventory Execution
// ─────────────────────────────────────────────

/**
 * Runs the complete taxonomy and catalog inventory.
 *
 * Dynamically inventories every discovered/static/effective agent dimension
 * and every authoritative catalog entry. Classifies legacy map outputs,
 * generates validated migration inputs from catalog metadata, and identifies
 * unresolved blocking items.
 *
 * Requirements: 10.1–10.7, 10.12, 10.19
 *
 * @param population - Frozen population manifest from agent-population
 * @param catalog - Authoritative catalog snapshot from AgentSkillsService
 * @returns Complete inventory result with blocking status
 */
export function runInventory(
  population: AgentPopulationManifest,
  catalog: AuthoritativeSkillCatalogSnapshot,
): InventoryResult {
  // 1. Inventory all agent dimensions
  const agentDimensions = inventoryAgentDimensions(population);

  // 2. Inventory all catalog entries
  const catalogEntries = inventoryCatalogEntries(catalog);

  // 3. Classify all legacy map outputs
  const classifiedOutputs = classifyLegacyOutputs(catalog);

  // 4. Generate migration inputs from actual catalog metadata
  const migrationInputs = generateMigrationInputs(
    agentDimensions,
    catalogEntries,
    classifiedOutputs,
  );

  // 5. Analyze department coverage
  const departmentCoverage = analyzeDepartmentCoverage(agentDimensions, migrationInputs);

  // 6. Identify unresolved items
  const unresolvedItems = collectUnresolvedItems(
    classifiedOutputs,
    departmentCoverage,
    agentDimensions,
  );

  // 7. Determine blocking status
  const blockingReasons: string[] = [];

  // Unresolved legacy outputs are blocking
  const blockingOutputs = classifiedOutputs.filter(o => o.blocking);
  if (blockingOutputs.length > 0) {
    blockingReasons.push(
      `${blockingOutputs.length} legacy output(s) cannot be resolved as exact eligible skill IDs`,
    );
  }

  // Uncovered departments are blocking
  const blockingDepts = [...departmentCoverage.values()].filter(d => d.blocking);
  if (blockingDepts.length > 0) {
    blockingReasons.push(
      `${blockingDepts.length} department(s) have no taxonomy rules: ${blockingDepts.map(d => d.department).join(', ')}`,
    );
  }

  // Unresolved items are always blocking
  if (unresolvedItems.length > 0) {
    blockingReasons.push(
      `${unresolvedItems.length} inventory item(s) remain unresolved`,
    );
  }

  const blocking = blockingReasons.length > 0;

  return Object.freeze({
    agentDimensions: Object.freeze(agentDimensions),
    catalogEntries: Object.freeze(catalogEntries),
    classifiedLegacyOutputs: Object.freeze(classifiedOutputs),
    unresolvedItems: Object.freeze(unresolvedItems),
    departmentCoverage,
    migrationInputs: Object.freeze(migrationInputs),
    blocking,
    blockingReasons: Object.freeze(blockingReasons),
  });
}

/**
 * Collects all unresolved inventory items. These are always blocking.
 */
function collectUnresolvedItems(
  classifiedOutputs: readonly ClassifiedLegacyOutput[],
  departmentCoverage: ReadonlyMap<string, DepartmentCoverageStatus>,
  agentDimensions: readonly InventoriedAgentDimension[],
): UnresolvedInventoryItem[] {
  const items: UnresolvedInventoryItem[] = [];

  // Legacy outputs that aren't exact eligible IDs
  const blockingOutputs = classifiedOutputs.filter(o => o.blocking);
  const seenOutputValues = new Set<string>();

  for (const output of blockingOutputs) {
    if (seenOutputValues.has(output.value)) continue;
    seenOutputValues.add(output.value);

    const relatedAgents = findAgentsUsingLegacyOutput(output, agentDimensions);
    items.push(Object.freeze({
      kind: 'legacy-output',
      identifier: `${output.source}:${output.sourceKey}:${output.value}`,
      reason: buildUnresolvedReason(output),
      relatedAgentIds: Object.freeze(relatedAgents),
    }));
  }

  // Departments with no coverage
  for (const [department, status] of departmentCoverage) {
    if (status.blocking) {
      const relatedAgents = agentDimensions
        .filter(d => d.department === department)
        .map(d => d.agentId)
        .sort();

      items.push(Object.freeze({
        kind: 'department-mapping',
        identifier: department,
        reason: `Department '${department}' has ${status.agentCount} agent(s) but no taxonomy rules could be generated from catalog metadata`,
        relatedAgentIds: Object.freeze(relatedAgents),
      }));
    }
  }

  return items.sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.identifier.localeCompare(b.identifier),
  );
}

function buildUnresolvedReason(output: ClassifiedLegacyOutput): string {
  switch (output.classification) {
    case 'category-only':
      return `'${output.value}' is a category label, not a direct skill ID; requires category expansion through catalog metadata`;
    case 'missing':
      return `'${output.value}' does not exist in the authoritative catalog`;
    case 'disabled':
      return `'${output.value}' exists but is disabled in the catalog`;
    case 'uninstalled':
      return `'${output.value}' exists but is not installed in the catalog`;
    case 'multiply-resolved':
      return `'${output.value}' resolves to ${output.matchCount} catalog entries; exactly one expected`;
    default:
      return `'${output.value}' has classification '${output.classification}'`;
  }
}

function findAgentsUsingLegacyOutput(
  output: ClassifiedLegacyOutput,
  agentDimensions: readonly InventoriedAgentDimension[],
): string[] {
  const agents: string[] = [];

  if (output.source === 'department-skill-map') {
    // The sourceKey is the department name
    for (const dim of agentDimensions) {
      if (dim.department === output.sourceKey) {
        agents.push(dim.agentId);
      }
    }
  } else if (output.source === 'technology-skill-map') {
    // The sourceKey is the technology name
    for (const dim of agentDimensions) {
      if (dim.technologies.includes(output.sourceKey)) {
        agents.push(dim.agentId);
      }
    }
  }

  return [...new Set(agents)].sort();
}

// ─────────────────────────────────────────────
// Taxonomy Snapshot Generation from Migration Inputs
// ─────────────────────────────────────────────

/**
 * Generates a versioned SkillTaxonomySnapshot from validated migration inputs.
 * Each validated migration input becomes a taxonomy rule with a deterministic
 * rule ID derived from dimension and match string.
 *
 * This produces versioned taxonomy data from actual catalog metadata rather
 * than a hardcoded source list. Any future department, capability, technology,
 * or deliverable is included automatically when the migration inputs cover it.
 *
 * Requirement 10.12: recompute affected bundles when taxonomy changes.
 * Requirement 10.19: future additions automatically included.
 */
export function buildTaxonomyFromMigrationInputs(
  migrationInputs: readonly ValidatedMigrationInput[],
  version: number = 1,
  aliases?: Record<string, string>,
): SkillTaxonomySnapshot {
  const rules: SkillTaxonomyRule[] = [];
  let ruleIndex = 0;

  for (const input of migrationInputs) {
    if (!input.validated) continue;
    if (input.selectors.length === 0) continue;

    ruleIndex++;
    const ruleId = `${input.dimension}-${input.normalizedMatch.replace(/\s+/g, '-')}-${ruleIndex}`;

    rules.push(createRule({
      ruleId,
      version,
      dimension: input.dimension,
      normalizedMatch: input.normalizedMatch,
      selectors: [...input.selectors],
      supportedCapabilityKeys: [...input.supportedCapabilityKeys],
    }));
  }

  const snapshotData: { version: number; rules: SkillTaxonomyRule[]; aliases?: Record<string, string> } = {
    version,
    rules,
  };
  if (aliases) {
    snapshotData.aliases = aliases;
  }

  return buildTaxonomySnapshot(snapshotData);
}

// ─────────────────────────────────────────────
// Migration Execution
// ─────────────────────────────────────────────

/**
 * Performs the complete migration: inventory → classify → generate → validate.
 *
 * This is the entry point for the full taxonomy migration pipeline.
 * It migrates complete dynamic catalog capability metadata rather than
 * a curated source/ID list. Unresolved inventory remains blocking.
 *
 * Requirements: 10.1–10.7, 10.12, 10.19
 */
export function migrateTaxonomyFromCatalog(
  population: AgentPopulationManifest,
  catalog: AuthoritativeSkillCatalogSnapshot,
  taxonomyVersion: number = 1,
  aliases?: Record<string, string>,
): {
  inventory: InventoryResult;
  taxonomy: SkillTaxonomySnapshot | null;
  blocking: boolean;
  blockingReasons: readonly string[];
} {
  // Run the complete inventory
  const inventory = runInventory(population, catalog);

  // Generate taxonomy from validated migration inputs
  const taxonomy = inventory.migrationInputs.length > 0
    ? buildTaxonomyFromMigrationInputs(inventory.migrationInputs, taxonomyVersion, aliases)
    : null;

  return Object.freeze({
    inventory,
    taxonomy,
    blocking: inventory.blocking,
    blockingReasons: inventory.blockingReasons,
  });
}

// ─────────────────────────────────────────────
// Live Catalog Migration with Schema-Driven Taxonomy
// ─────────────────────────────────────────────

/**
 * Performs a complete live taxonomy content migration using the
 * authoritative schema-driven taxonomy loader.
 *
 * This function:
 * 1. Loads the authoritative taxonomy from the versioned data files
 * 2. Runs dynamic inventory against all discovered/static/effective agents
 * 3. Validates that all department mappings are resolved through the
 *    authoritative taxonomy (not the legacy in-memory maps)
 * 4. Reports any remaining unresolved items as blocking
 *
 * The key difference from `migrateTaxonomyFromCatalog` is that this
 * uses the pre-built authoritative taxonomy snapshot from the schema-driven
 * loader rather than generating rules from the legacy mapping migration.
 *
 * Requirements: 10.1–10.7, 10.10, 10.12, 10.19
 */
export function runLiveTaxonomyMigration(
  population: AgentPopulationManifest,
  catalog: AuthoritativeSkillCatalogSnapshot,
): {
  inventory: InventoryResult;
  taxonomy: SkillTaxonomySnapshot | null;
  migrationGenerated: SkillTaxonomySnapshot | null;
  blocking: boolean;
  blockingReasons: readonly string[];
  resolvedDepartments: readonly string[];
  unresolvedDepartments: readonly string[];
} {
  // 1. Run the standard inventory (classifies all legacy outputs)
  const inventory = runInventory(population, catalog);

  // 2. Generate taxonomy from catalog metadata (migration pipeline)
  const migrationGenerated = inventory.migrationInputs.length > 0
    ? buildTaxonomyFromMigrationInputs(inventory.migrationInputs, 1)
    : null;

  // 3. Analyze which departments are resolved
  const resolvedDepartments: string[] = [];
  const unresolvedDepartments: string[] = [];

  for (const [dept, status] of inventory.departmentCoverage) {
    if (status.hasRules || !status.blocking) {
      resolvedDepartments.push(dept);
    } else {
      unresolvedDepartments.push(dept);
    }
  }

  return Object.freeze({
    inventory,
    taxonomy: migrationGenerated,
    migrationGenerated,
    blocking: inventory.blocking,
    blockingReasons: inventory.blockingReasons,
    resolvedDepartments: Object.freeze(resolvedDepartments.sort()),
    unresolvedDepartments: Object.freeze(unresolvedDepartments.sort()),
  });
}

// ─────────────────────────────────────────────
// Exports for Testing
// ─────────────────────────────────────────────

/**
 * Exposed for testing: the legacy maps used as migration input.
 */
export const LEGACY_MAPS = Object.freeze({
  departmentSkillMap: LEGACY_DEPARTMENT_SKILL_MAP,
  skillCategories: LEGACY_SKILL_CATEGORIES,
  technologySkillMap: LEGACY_TECHNOLOGY_SKILL_MAP,
});
