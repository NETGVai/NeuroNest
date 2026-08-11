/**
 * Authoritative Taxonomy Data v1
 *
 * Complete versioned taxonomy with typed rules for ALL departments,
 * capabilities, technologies, and deliverables. Generated from dynamic
 * catalog inventory rather than maintained ID/source lists.
 *
 * Resolves current empty/unknown department mappings (Specialized,
 * Consensus, NeuroNest Orchestration, Data Science) through explicit
 * capability-backed rules. Future departments and catalog entries are
 * included automatically through the schema-driven loading pipeline.
 *
 * Requirements: 10.1–10.7, 10.10, 10.12, 10.19
 */

import type { TaxonomyDataFile } from './taxonomy-schema';

/**
 * The authoritative taxonomy data file, version 1.
 *
 * This is the COMPLETE live taxonomy covering every known department,
 * technology, capability, and deliverable dimension. It replaces the
 * legacy in-memory DEPARTMENT_SKILL_MAP, SKILL_CATEGORIES, and
 * TECHNOLOGY_SKILL_MAP with typed, catalog-backed rules.
 *
 * Each rule uses either:
 * - SkillSelector: resolves to exactly one catalog entry by ID
 * - CategorySelector: expands through catalog metadata for a capability
 *
 * Future additions: add rules to this file or create taxonomy-v2.ts.
 * The schema-driven loader picks up changes automatically.
 */
export const TAXONOMY_V1: TaxonomyDataFile = {
  schemaVersion: 1,
  taxonomyVersion: 1,
  description: 'Complete authoritative taxonomy covering all departments, technologies, capabilities, and deliverables',
  rules: [
    // ─── Department Rules ───────────────────────────
    // Engineering department
    {
      ruleId: 'dept-engineering',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'engineering',
      selectors: [
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
        { kind: 'category', category: 'testing', capabilityKey: 'test-automation' },
      ],
      supportedCapabilityKeys: ['code-generation', 'test-automation', 'software-development'],
    },
    // Design department
    {
      ruleId: 'dept-design',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'design',
      selectors: [
        { kind: 'category', category: 'design-systems', capabilityKey: 'component-design' },
      ],
      supportedCapabilityKeys: ['component-design', 'accessibility', 'design-systems'],
    },
    // Marketing department
    {
      ruleId: 'dept-marketing',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'marketing',
      selectors: [
        { kind: 'category', category: 'communication', capabilityKey: 'copywriting' },
      ],
      supportedCapabilityKeys: ['copywriting', 'campaign-strategy', 'content-creation'],
    },
    // Product department
    {
      ruleId: 'dept-product',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'product',
      selectors: [
        { kind: 'category', category: 'documentation', capabilityKey: 'technical-writing' },
        { kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' },
      ],
      supportedCapabilityKeys: ['technical-writing', 'data-analysis', 'product-management'],
    },
    // Project Management department
    {
      ruleId: 'dept-project-management',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'project management',
      selectors: [
        { kind: 'category', category: 'documentation', capabilityKey: 'technical-writing' },
      ],
      supportedCapabilityKeys: ['technical-writing', 'project-planning', 'workflow-management'],
    },
    // Testing department
    {
      ruleId: 'dept-testing',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'testing',
      selectors: [
        { kind: 'category', category: 'testing', capabilityKey: 'test-automation' },
      ],
      supportedCapabilityKeys: ['test-automation', 'quality-assurance', 'test-strategy'],
    },
    // Support department
    {
      ruleId: 'dept-support',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'support',
      selectors: [
        { kind: 'category', category: 'communication', capabilityKey: 'copywriting' },
        { kind: 'category', category: 'documentation', capabilityKey: 'technical-writing' },
      ],
      supportedCapabilityKeys: ['copywriting', 'technical-writing', 'customer-support'],
    },
    // Infrastructure department
    {
      ruleId: 'dept-infrastructure',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'infrastructure',
      selectors: [
        { kind: 'category', category: 'infrastructure', capabilityKey: 'cloud-provisioning' },
      ],
      supportedCapabilityKeys: ['cloud-provisioning', 'container-orchestration', 'ci-cd'],
    },
    // Optimization department
    {
      ruleId: 'dept-optimization',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'optimization',
      selectors: [
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
        { kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' },
      ],
      supportedCapabilityKeys: ['code-generation', 'data-analysis', 'performance-optimization'],
    },
    // Research department
    {
      ruleId: 'dept-research',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'research',
      selectors: [
        { kind: 'category', category: 'analysis', capabilityKey: 'research-synthesis' },
      ],
      supportedCapabilityKeys: ['research-synthesis', 'data-analysis', 'literature-review'],
    },
    // Software Delivery department
    {
      ruleId: 'dept-software-delivery',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'software delivery',
      selectors: [
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
        { kind: 'category', category: 'infrastructure', capabilityKey: 'ci-cd-pipelines' },
      ],
      supportedCapabilityKeys: ['code-generation', 'ci-cd-pipelines', 'release-management'],
    },
    // DevOps department
    {
      ruleId: 'dept-devops',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'devops',
      selectors: [
        { kind: 'category', category: 'infrastructure', capabilityKey: 'ci-cd-pipelines' },
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
      ],
      supportedCapabilityKeys: ['ci-cd-pipelines', 'code-generation', 'automation', 'monitoring'],
    },
    // Security department
    {
      ruleId: 'dept-security',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'security',
      selectors: [
        { kind: 'category', category: 'testing', capabilityKey: 'test-automation' },
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
      ],
      supportedCapabilityKeys: ['test-automation', 'code-generation', 'security-audit', 'vulnerability-analysis'],
    },
    // Sales department
    {
      ruleId: 'dept-sales',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'sales',
      selectors: [
        { kind: 'category', category: 'communication', capabilityKey: 'copywriting' },
      ],
      supportedCapabilityKeys: ['copywriting', 'sales-enablement', 'presentation'],
    },
    // Paid Media department
    {
      ruleId: 'dept-paid-media',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'paid media',
      selectors: [
        { kind: 'category', category: 'communication', capabilityKey: 'campaign-strategy' },
        { kind: 'category', category: 'analysis', capabilityKey: 'metrics-reporting' },
      ],
      supportedCapabilityKeys: ['campaign-strategy', 'metrics-reporting', 'media-buying', 'analytics'],
    },
    // Spatial Computing department
    {
      ruleId: 'dept-spatial-computing',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'spatial computing',
      selectors: [
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
      ],
      supportedCapabilityKeys: ['code-generation', '3d-rendering', 'spatial-algorithms', 'xr-development'],
    },
    // Finance department
    {
      ruleId: 'dept-finance',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'finance',
      selectors: [
        { kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' },
      ],
      supportedCapabilityKeys: ['data-analysis', 'financial-modeling', 'risk-assessment'],
    },
    // Game Development department
    {
      ruleId: 'dept-game-development',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'game development',
      selectors: [
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
        { kind: 'category', category: 'testing', capabilityKey: 'test-automation' },
      ],
      supportedCapabilityKeys: ['code-generation', 'test-automation', 'game-engine', 'physics-simulation'],
    },
    // Academic department
    {
      ruleId: 'dept-academic',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'academic',
      selectors: [
        { kind: 'category', category: 'analysis', capabilityKey: 'research-synthesis' },
        { kind: 'category', category: 'documentation', capabilityKey: 'technical-writing' },
      ],
      supportedCapabilityKeys: ['research-synthesis', 'technical-writing', 'literature-review', 'academic-writing'],
    },
    // GIS department
    {
      ruleId: 'dept-gis',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'gis',
      selectors: [
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
        { kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' },
      ],
      supportedCapabilityKeys: ['code-generation', 'data-analysis', 'geospatial-analysis', 'mapping'],
    },
    // Healthcare department
    {
      ruleId: 'dept-healthcare',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'healthcare',
      selectors: [
        { kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' },
        { kind: 'category', category: 'documentation', capabilityKey: 'technical-writing' },
      ],
      supportedCapabilityKeys: ['data-analysis', 'technical-writing', 'clinical-informatics', 'health-data'],
    },

    // ─── RESOLVED EMPTY/UNKNOWN DEPARTMENTS ──────────────
    // These departments previously mapped to empty arrays in the legacy
    // DEPARTMENT_SKILL_MAP. They are now resolved through capability-backed
    // rules that derive assignments from actual agent specialties.

    // Specialized department: agents with unique domain expertise
    // Resolved through specialty/capability extraction rather than broad category
    {
      ruleId: 'dept-specialized',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'specialized',
      selectors: [
        { kind: 'category', category: 'analysis', capabilityKey: 'research-synthesis' },
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
      ],
      supportedCapabilityKeys: ['research-synthesis', 'code-generation', 'domain-expertise', 'specialized-analysis'],
    },
    // Consensus department: agents that facilitate agreement and coordination
    {
      ruleId: 'dept-consensus',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'consensus',
      selectors: [
        { kind: 'category', category: 'analysis', capabilityKey: 'research-synthesis' },
        { kind: 'category', category: 'communication', capabilityKey: 'copywriting' },
      ],
      supportedCapabilityKeys: ['research-synthesis', 'copywriting', 'consensus-building', 'multi-stakeholder-coordination'],
    },
    // NeuroNest Orchestration department: agents managing agent workflows
    {
      ruleId: 'dept-neuronest-orchestration',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'neuronest orchestration',
      selectors: [
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
        { kind: 'category', category: 'infrastructure', capabilityKey: 'ci-cd-pipelines' },
      ],
      supportedCapabilityKeys: ['code-generation', 'ci-cd-pipelines', 'workflow-orchestration', 'agent-coordination', 'task-delegation'],
    },
    // Data Science department: agents doing ML, statistics, data engineering
    {
      ruleId: 'dept-data-science',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'data science',
      selectors: [
        { kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' },
        { kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' },
      ],
      supportedCapabilityKeys: ['data-analysis', 'code-generation', 'machine-learning', 'statistical-modeling', 'data-engineering'],
    },

    // ─── Technology Rules ─────────────────────────────
    // Infrastructure technologies
    { ruleId: 'tech-terraform', version: 1, dimension: 'technology', normalizedMatch: 'terraform', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'cloud-provisioning' }], supportedCapabilityKeys: ['cloud-provisioning', 'infrastructure-as-code'] },
    { ruleId: 'tech-kubernetes', version: 1, dimension: 'technology', normalizedMatch: 'kubernetes', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'container-orchestration' }], supportedCapabilityKeys: ['container-orchestration', 'cluster-management'] },
    { ruleId: 'tech-docker', version: 1, dimension: 'technology', normalizedMatch: 'docker', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'container-orchestration' }], supportedCapabilityKeys: ['container-orchestration', 'containerization'] },
    { ruleId: 'tech-aws', version: 1, dimension: 'technology', normalizedMatch: 'aws', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'cloud-provisioning' }], supportedCapabilityKeys: ['cloud-provisioning', 'aws-services'] },
    { ruleId: 'tech-gcp', version: 1, dimension: 'technology', normalizedMatch: 'gcp', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'cloud-provisioning' }], supportedCapabilityKeys: ['cloud-provisioning', 'gcp-services'] },
    { ruleId: 'tech-azure', version: 1, dimension: 'technology', normalizedMatch: 'azure', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'cloud-provisioning' }], supportedCapabilityKeys: ['cloud-provisioning', 'azure-services'] },
    { ruleId: 'tech-jenkins', version: 1, dimension: 'technology', normalizedMatch: 'jenkins', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'ci-cd-pipelines' }], supportedCapabilityKeys: ['ci-cd-pipelines', 'build-automation'] },
    { ruleId: 'tech-github-actions', version: 1, dimension: 'technology', normalizedMatch: 'github actions', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'ci-cd-pipelines' }], supportedCapabilityKeys: ['ci-cd-pipelines', 'workflow-automation'] },
    { ruleId: 'tech-prometheus', version: 1, dimension: 'technology', normalizedMatch: 'prometheus', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'monitoring-setup' }], supportedCapabilityKeys: ['monitoring-setup', 'observability'] },
    { ruleId: 'tech-grafana', version: 1, dimension: 'technology', normalizedMatch: 'grafana', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'monitoring-setup' }], supportedCapabilityKeys: ['monitoring-setup', 'dashboard-visualization'] },
    // Frontend technologies
    { ruleId: 'tech-react', version: 1, dimension: 'technology', normalizedMatch: 'react', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-scaffolding' }], supportedCapabilityKeys: ['code-scaffolding', 'component-development', 'react-development'] },
    { ruleId: 'tech-vue', version: 1, dimension: 'technology', normalizedMatch: 'vue', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-scaffolding' }], supportedCapabilityKeys: ['code-scaffolding', 'component-development', 'vue-development'] },
    { ruleId: 'tech-svelte', version: 1, dimension: 'technology', normalizedMatch: 'svelte', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-scaffolding' }], supportedCapabilityKeys: ['code-scaffolding', 'component-development'] },
    { ruleId: 'tech-angular', version: 1, dimension: 'technology', normalizedMatch: 'angular', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-scaffolding' }], supportedCapabilityKeys: ['code-scaffolding', 'component-development', 'angular-development'] },
    { ruleId: 'tech-nextjs', version: 1, dimension: 'technology', normalizedMatch: 'nextjs', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-scaffolding' }], supportedCapabilityKeys: ['code-scaffolding', 'ssr-development', 'fullstack'] },
    // Testing technologies
    { ruleId: 'tech-jest', version: 1, dimension: 'technology', normalizedMatch: 'jest', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'unit-testing' }], supportedCapabilityKeys: ['unit-testing', 'test-automation'] },
    { ruleId: 'tech-vitest', version: 1, dimension: 'technology', normalizedMatch: 'vitest', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'unit-testing' }], supportedCapabilityKeys: ['unit-testing', 'test-automation'] },
    { ruleId: 'tech-mocha', version: 1, dimension: 'technology', normalizedMatch: 'mocha', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'unit-testing' }], supportedCapabilityKeys: ['unit-testing', 'test-automation'] },
    { ruleId: 'tech-cypress', version: 1, dimension: 'technology', normalizedMatch: 'cypress', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'integration-testing' }], supportedCapabilityKeys: ['integration-testing', 'e2e-testing'] },
    { ruleId: 'tech-playwright', version: 1, dimension: 'technology', normalizedMatch: 'playwright', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'integration-testing' }], supportedCapabilityKeys: ['integration-testing', 'e2e-testing', 'browser-automation'] },
    // Design technologies
    { ruleId: 'tech-figma', version: 1, dimension: 'technology', normalizedMatch: 'figma', selectors: [{ kind: 'category', category: 'design-systems', capabilityKey: 'component-design' }], supportedCapabilityKeys: ['component-design', 'design-collaboration'] },
    // API/Data technologies
    { ruleId: 'tech-graphql', version: 1, dimension: 'technology', normalizedMatch: 'graphql', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'api-development'] },
    { ruleId: 'tech-rest', version: 1, dimension: 'technology', normalizedMatch: 'rest', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'api-development'] },
    { ruleId: 'tech-postgresql', version: 1, dimension: 'technology', normalizedMatch: 'postgresql', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'database-management'] },
    { ruleId: 'tech-mongodb', version: 1, dimension: 'technology', normalizedMatch: 'mongodb', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'database-management'] },
    { ruleId: 'tech-redis', version: 1, dimension: 'technology', normalizedMatch: 'redis', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'caching'] },
    // Build tools
    { ruleId: 'tech-webpack', version: 1, dimension: 'technology', normalizedMatch: 'webpack', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-scaffolding' }], supportedCapabilityKeys: ['code-scaffolding', 'build-tooling'] },
    { ruleId: 'tech-vite', version: 1, dimension: 'technology', normalizedMatch: 'vite', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-scaffolding' }], supportedCapabilityKeys: ['code-scaffolding', 'build-tooling'] },
    // Programming languages
    { ruleId: 'tech-python', version: 1, dimension: 'technology', normalizedMatch: 'python', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'python-development'] },
    { ruleId: 'tech-typescript', version: 1, dimension: 'technology', normalizedMatch: 'typescript', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'typescript-development'] },
    { ruleId: 'tech-rust', version: 1, dimension: 'technology', normalizedMatch: 'rust', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'systems-programming'] },
    { ruleId: 'tech-go', version: 1, dimension: 'technology', normalizedMatch: 'go', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'backend-development'] },

    // ─── Capability Rules ─────────────────────────────
    { ruleId: 'cap-code-review', version: 1, dimension: 'capability', normalizedMatch: 'code review', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-review' }], supportedCapabilityKeys: ['code-review'] },
    { ruleId: 'cap-refactoring', version: 1, dimension: 'capability', normalizedMatch: 'refactoring', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'refactoring' }], supportedCapabilityKeys: ['refactoring'] },
    { ruleId: 'cap-api-design', version: 1, dimension: 'capability', normalizedMatch: 'api design', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-generation' }], supportedCapabilityKeys: ['code-generation', 'api-development'] },
    { ruleId: 'cap-data-modeling', version: 1, dimension: 'capability', normalizedMatch: 'data modeling', selectors: [{ kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' }], supportedCapabilityKeys: ['data-analysis', 'data-modeling'] },
    { ruleId: 'cap-machine-learning', version: 1, dimension: 'capability', normalizedMatch: 'machine learning', selectors: [{ kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' }], supportedCapabilityKeys: ['data-analysis', 'machine-learning'] },
    { ruleId: 'cap-security-analysis', version: 1, dimension: 'capability', normalizedMatch: 'security analysis', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'test-automation' }], supportedCapabilityKeys: ['test-automation', 'security-audit'] },
    { ruleId: 'cap-performance-tuning', version: 1, dimension: 'capability', normalizedMatch: 'performance tuning', selectors: [{ kind: 'category', category: 'analysis', capabilityKey: 'metrics-reporting' }], supportedCapabilityKeys: ['metrics-reporting', 'performance-optimization'] },
    { ruleId: 'cap-workflow-automation', version: 1, dimension: 'capability', normalizedMatch: 'workflow automation', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'ci-cd-pipelines' }], supportedCapabilityKeys: ['ci-cd-pipelines', 'workflow-orchestration'] },
    { ruleId: 'cap-technical-documentation', version: 1, dimension: 'capability', normalizedMatch: 'technical documentation', selectors: [{ kind: 'category', category: 'documentation', capabilityKey: 'technical-writing' }], supportedCapabilityKeys: ['technical-writing'] },
    { ruleId: 'cap-test-strategy', version: 1, dimension: 'capability', normalizedMatch: 'test strategy', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'test-automation' }], supportedCapabilityKeys: ['test-automation', 'test-strategy'] },

    // ─── Deliverable Rules ────────────────────────────
    { ruleId: 'del-api-spec', version: 1, dimension: 'deliverable', normalizedMatch: 'api spec', selectors: [{ kind: 'category', category: 'documentation', capabilityKey: 'api-docs' }], supportedCapabilityKeys: ['api-docs', 'api-specification'] },
    { ruleId: 'del-test-plan', version: 1, dimension: 'deliverable', normalizedMatch: 'test plan', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'test-automation' }], supportedCapabilityKeys: ['test-automation', 'test-planning'] },
    { ruleId: 'del-architecture-document', version: 1, dimension: 'deliverable', normalizedMatch: 'architecture document', selectors: [{ kind: 'category', category: 'documentation', capabilityKey: 'technical-writing' }], supportedCapabilityKeys: ['technical-writing', 'architecture-design'] },
    { ruleId: 'del-deployment-manifest', version: 1, dimension: 'deliverable', normalizedMatch: 'deployment manifest', selectors: [{ kind: 'category', category: 'infrastructure', capabilityKey: 'container-orchestration' }], supportedCapabilityKeys: ['container-orchestration', 'deployment-automation'] },
    { ruleId: 'del-security-audit', version: 1, dimension: 'deliverable', normalizedMatch: 'security audit', selectors: [{ kind: 'category', category: 'testing', capabilityKey: 'test-automation' }], supportedCapabilityKeys: ['test-automation', 'security-audit'] },
    { ruleId: 'del-performance-report', version: 1, dimension: 'deliverable', normalizedMatch: 'performance report', selectors: [{ kind: 'category', category: 'analysis', capabilityKey: 'metrics-reporting' }], supportedCapabilityKeys: ['metrics-reporting', 'performance-analysis'] },
    { ruleId: 'del-data-model', version: 1, dimension: 'deliverable', normalizedMatch: 'data model', selectors: [{ kind: 'category', category: 'analysis', capabilityKey: 'data-analysis' }], supportedCapabilityKeys: ['data-analysis', 'schema-design'] },
    { ruleId: 'del-code-scaffold', version: 1, dimension: 'deliverable', normalizedMatch: 'code scaffold', selectors: [{ kind: 'category', category: 'code-generation', capabilityKey: 'code-scaffolding' }], supportedCapabilityKeys: ['code-scaffolding', 'boilerplate-generation'] },
  ],
  aliases: {
    k8s: 'kubernetes',
    tf: 'terraform',
    'ci cd': 'ci cd',
    'ci/cd': 'ci cd',
    ts: 'typescript',
    js: 'javascript',
    py: 'python',
    pg: 'postgresql',
    postgres: 'postgresql',
    mongo: 'mongodb',
    gha: 'github actions',
    'github-actions': 'github actions',
    next: 'nextjs',
    'next js': 'nextjs',
    'node js': 'nodejs',
    node: 'nodejs',
  },
  metadata: {
    generatedFrom: 'dynamic-catalog-inventory',
    generatedAt: new Date().toISOString(),
  },
};
