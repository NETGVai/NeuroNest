/**
 * Authoritative Taxonomy Data v1
 *
 * Complete versioned taxonomy with typed rules for ALL departments,
 * capabilities, technologies, and deliverables. Uses SkillSelector
 * referencing actual catalog skill IDs for reliable resolution.
 *
 * Requirements: 10.1–10.7, 10.10, 10.12, 10.19
 */

import type { TaxonomyDataFile } from './taxonomy-schema';

export const TAXONOMY_V1: TaxonomyDataFile = {
  schemaVersion: 1,
  taxonomyVersion: 1,
  description: 'Complete authoritative taxonomy using direct skill ID selectors',
  rules: [
    // ─── Department Rules ───────────────────────────
    {
      ruleId: 'dept-engineering',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'engineering',
      selectors: [
        { kind: 'skill', skillId: 'code-review-checklist' },
        { kind: 'skill', skillId: 'unit-test-generator' },
        { kind: 'skill', skillId: 'error-handling-patterns' },
      ],
      supportedCapabilityKeys: ['dept-engineering'],
    },
    {
      ruleId: 'dept-design',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'design',
      selectors: [
        { kind: 'skill', skillId: 'accessibility-audit' },
        { kind: 'skill', skillId: 'css-architecture' },
      ],
      supportedCapabilityKeys: ['dept-design'],
    },
    {
      ruleId: 'dept-marketing',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'marketing',
      selectors: [
        { kind: 'skill', skillId: 'seo-optimization' },
        { kind: 'skill', skillId: 'technical-documentation' },
      ],
      supportedCapabilityKeys: ['dept-marketing'],
    },
    {
      ruleId: 'dept-product',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'product',
      selectors: [
        { kind: 'skill', skillId: 'requirements-analysis' },
        { kind: 'skill', skillId: 'project-planning' },
      ],
      supportedCapabilityKeys: ['dept-product'],
    },
    {
      ruleId: 'dept-project-management',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'project management',
      selectors: [
        { kind: 'skill', skillId: 'project-planning' },
        { kind: 'skill', skillId: 'task-planning' },
      ],
      supportedCapabilityKeys: ['dept-project-management'],
    },
    {
      ruleId: 'dept-testing',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'testing',
      selectors: [
        { kind: 'skill', skillId: 'unit-test-generator' },
        { kind: 'skill', skillId: 'integration-test-patterns' },
        { kind: 'skill', skillId: 'test-driven-development' },
      ],
      supportedCapabilityKeys: ['dept-testing'],
    },
    {
      ruleId: 'dept-support',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'support',
      selectors: [
        { kind: 'skill', skillId: 'technical-documentation' },
        { kind: 'skill', skillId: 'incident-response' },
      ],
      supportedCapabilityKeys: ['dept-support'],
    },
    {
      ruleId: 'dept-infrastructure',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'infrastructure',
      selectors: [
        { kind: 'skill', skillId: 'terraform-infra' },
        { kind: 'skill', skillId: 'monitoring-observability' },
        { kind: 'skill', skillId: 'kubernetes-deployer' },
      ],
      supportedCapabilityKeys: ['dept-infrastructure'],
    },
    {
      ruleId: 'dept-optimization',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'optimization',
      selectors: [
        { kind: 'skill', skillId: 'performance-optimizer' },
        { kind: 'skill', skillId: 'caching-strategies' },
      ],
      supportedCapabilityKeys: ['dept-optimization'],
    },
    {
      ruleId: 'dept-research',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'research',
      selectors: [
        { kind: 'skill', skillId: 'research-analysis' },
        { kind: 'skill', skillId: 'requirements-analysis' },
      ],
      supportedCapabilityKeys: ['dept-research'],
    },
    {
      ruleId: 'dept-software-delivery',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'software delivery',
      selectors: [
        { kind: 'skill', skillId: 'ci-cd-pipeline' },
        { kind: 'skill', skillId: 'deployment-strategies' },
        { kind: 'skill', skillId: 'release-management' },
      ],
      supportedCapabilityKeys: ['dept-software-delivery'],
    },
    {
      ruleId: 'dept-devops',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'devops',
      selectors: [
        { kind: 'skill', skillId: 'ci-cd-pipeline' },
        { kind: 'skill', skillId: 'docker-containerizer' },
        { kind: 'skill', skillId: 'github-actions-workflows' },
      ],
      supportedCapabilityKeys: ['dept-devops'],
    },
    {
      ruleId: 'dept-security',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'security',
      selectors: [
        { kind: 'skill', skillId: 'security-hardening' },
        { kind: 'skill', skillId: 'vulnerability-scanning' },
        { kind: 'skill', skillId: 'threat-modeling' },
      ],
      supportedCapabilityKeys: ['dept-security'],
    },
    {
      ruleId: 'dept-sales',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'sales',
      selectors: [
        { kind: 'skill', skillId: 'technical-documentation' },
        { kind: 'skill', skillId: 'specification-writing' },
      ],
      supportedCapabilityKeys: ['dept-sales'],
    },
    {
      ruleId: 'dept-paid-media',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'paid media',
      selectors: [
        { kind: 'skill', skillId: 'seo-optimization' },
        { kind: 'skill', skillId: 'research-analysis' },
      ],
      supportedCapabilityKeys: ['dept-paid-media'],
    },
    {
      ruleId: 'dept-spatial-computing',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'spatial computing',
      selectors: [
        { kind: 'skill', skillId: 'code-review-checklist' },
        { kind: 'skill', skillId: 'performance-optimizer' },
      ],
      supportedCapabilityKeys: ['dept-spatial-computing'],
    },
    {
      ruleId: 'dept-finance',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'finance',
      selectors: [
        { kind: 'skill', skillId: 'data-modeling' },
        { kind: 'skill', skillId: 'research-analysis' },
      ],
      supportedCapabilityKeys: ['dept-finance'],
    },
    {
      ruleId: 'dept-game-development',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'game development',
      selectors: [
        { kind: 'skill', skillId: 'code-review-checklist' },
        { kind: 'skill', skillId: 'performance-optimizer' },
        { kind: 'skill', skillId: 'unit-test-generator' },
      ],
      supportedCapabilityKeys: ['dept-game-development'],
    },
    {
      ruleId: 'dept-academic',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'academic',
      selectors: [
        { kind: 'skill', skillId: 'research-analysis' },
        { kind: 'skill', skillId: 'technical-documentation' },
      ],
      supportedCapabilityKeys: ['dept-academic'],
    },
    {
      ruleId: 'dept-gis',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'gis',
      selectors: [
        { kind: 'skill', skillId: 'data-modeling' },
        { kind: 'skill', skillId: 'data-pipeline-builder' },
      ],
      supportedCapabilityKeys: ['dept-gis'],
    },
    {
      ruleId: 'dept-healthcare',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'healthcare',
      selectors: [
        { kind: 'skill', skillId: 'research-analysis' },
        { kind: 'skill', skillId: 'technical-documentation' },
        { kind: 'skill', skillId: 'compliance-automation' },
      ],
      supportedCapabilityKeys: ['dept-healthcare'],
    },
    {
      ruleId: 'dept-specialized',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'specialized',
      selectors: [
        { kind: 'skill', skillId: 'research-analysis' },
        { kind: 'skill', skillId: 'code-review-checklist' },
      ],
      supportedCapabilityKeys: ['dept-specialized'],
    },
    {
      ruleId: 'dept-consensus',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'consensus',
      selectors: [
        { kind: 'skill', skillId: 'consensus-protocols' },
        { kind: 'skill', skillId: 'agent-communication' },
      ],
      supportedCapabilityKeys: ['dept-consensus'],
    },
    {
      ruleId: 'dept-neuronest-orchestration',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'neuronest orchestration',
      selectors: [
        { kind: 'skill', skillId: 'ai-agent-orchestration' },
        { kind: 'skill', skillId: 'swarm-coordination' },
        { kind: 'skill', skillId: 'task-automation' },
      ],
      supportedCapabilityKeys: ['dept-neuronest-orchestration'],
    },
    {
      ruleId: 'dept-data-science',
      version: 1,
      dimension: 'department',
      normalizedMatch: 'data science',
      selectors: [
        { kind: 'skill', skillId: 'data-pipeline-builder' },
        { kind: 'skill', skillId: 'data-modeling' },
        { kind: 'skill', skillId: 'ml-model-training' },
      ],
      supportedCapabilityKeys: ['dept-data-science'],
    },

    // ─── Technology Rules ─────────────────────────────
    { ruleId: 'tech-terraform', version: 1, dimension: 'technology', normalizedMatch: 'terraform', selectors: [{ kind: 'skill', skillId: 'terraform-infra' }], supportedCapabilityKeys: ['infrastructure-as-code'] },
    { ruleId: 'tech-kubernetes', version: 1, dimension: 'technology', normalizedMatch: 'kubernetes', selectors: [{ kind: 'skill', skillId: 'kubernetes-deployer' }], supportedCapabilityKeys: ['container-orchestration'] },
    { ruleId: 'tech-docker', version: 1, dimension: 'technology', normalizedMatch: 'docker', selectors: [{ kind: 'skill', skillId: 'docker-containerizer' }], supportedCapabilityKeys: ['containerization'] },
    { ruleId: 'tech-aws', version: 1, dimension: 'technology', normalizedMatch: 'aws', selectors: [{ kind: 'skill', skillId: 'cloud-cost-optimization' }], supportedCapabilityKeys: ['cloud-provisioning'] },
    { ruleId: 'tech-react', version: 1, dimension: 'technology', normalizedMatch: 'react', selectors: [{ kind: 'skill', skillId: 'react-component-builder' }], supportedCapabilityKeys: ['frontend-development'] },
    { ruleId: 'tech-nextjs', version: 1, dimension: 'technology', normalizedMatch: 'nextjs', selectors: [{ kind: 'skill', skillId: 'nextjs-app-scaffold' }], supportedCapabilityKeys: ['fullstack-development'] },
    { ruleId: 'tech-vue', version: 1, dimension: 'technology', normalizedMatch: 'vue', selectors: [{ kind: 'skill', skillId: 'vue-component-builder' }], supportedCapabilityKeys: ['frontend-development'] },
    { ruleId: 'tech-graphql', version: 1, dimension: 'technology', normalizedMatch: 'graphql', selectors: [{ kind: 'skill', skillId: 'graphql-api-builder' }], supportedCapabilityKeys: ['api-development'] },
    { ruleId: 'tech-rest', version: 1, dimension: 'technology', normalizedMatch: 'rest', selectors: [{ kind: 'skill', skillId: 'rest-api-designer' }], supportedCapabilityKeys: ['api-development'] },
    { ruleId: 'tech-playwright', version: 1, dimension: 'technology', normalizedMatch: 'playwright', selectors: [{ kind: 'skill', skillId: 'e2e-test-playwright' }], supportedCapabilityKeys: ['e2e-testing'] },
    { ruleId: 'tech-jest', version: 1, dimension: 'technology', normalizedMatch: 'jest', selectors: [{ kind: 'skill', skillId: 'unit-test-generator' }], supportedCapabilityKeys: ['unit-testing'] },
    { ruleId: 'tech-vitest', version: 1, dimension: 'technology', normalizedMatch: 'vitest', selectors: [{ kind: 'skill', skillId: 'unit-test-generator' }], supportedCapabilityKeys: ['unit-testing'] },
    { ruleId: 'tech-typescript', version: 1, dimension: 'technology', normalizedMatch: 'typescript', selectors: [{ kind: 'skill', skillId: 'typescript-refactorer' }], supportedCapabilityKeys: ['typescript-development'] },
    { ruleId: 'tech-python', version: 1, dimension: 'technology', normalizedMatch: 'python', selectors: [{ kind: 'skill', skillId: 'python-fastapi-builder' }], supportedCapabilityKeys: ['python-development'] },
    { ruleId: 'tech-postgresql', version: 1, dimension: 'technology', normalizedMatch: 'postgresql', selectors: [{ kind: 'skill', skillId: 'database-schema-designer' }], supportedCapabilityKeys: ['database-management'] },
    { ruleId: 'tech-redis', version: 1, dimension: 'technology', normalizedMatch: 'redis', selectors: [{ kind: 'skill', skillId: 'caching-strategies' }], supportedCapabilityKeys: ['caching'] },
    { ruleId: 'tech-github-actions', version: 1, dimension: 'technology', normalizedMatch: 'github actions', selectors: [{ kind: 'skill', skillId: 'github-actions-workflows' }], supportedCapabilityKeys: ['ci-cd'] },

    // ─── Capability Rules ─────────────────────────────
    { ruleId: 'cap-code-review', version: 1, dimension: 'capability', normalizedMatch: 'code review', selectors: [{ kind: 'skill', skillId: 'code-review-checklist' }], supportedCapabilityKeys: ['code-review'] },
    { ruleId: 'cap-refactoring', version: 1, dimension: 'capability', normalizedMatch: 'refactoring', selectors: [{ kind: 'skill', skillId: 'clean-code-refactoring' }], supportedCapabilityKeys: ['refactoring'] },
    { ruleId: 'cap-api-design', version: 1, dimension: 'capability', normalizedMatch: 'api design', selectors: [{ kind: 'skill', skillId: 'rest-api-designer' }], supportedCapabilityKeys: ['api-development'] },
    { ruleId: 'cap-security-analysis', version: 1, dimension: 'capability', normalizedMatch: 'security analysis', selectors: [{ kind: 'skill', skillId: 'vulnerability-scanning' }], supportedCapabilityKeys: ['security-audit'] },
    { ruleId: 'cap-performance-tuning', version: 1, dimension: 'capability', normalizedMatch: 'performance tuning', selectors: [{ kind: 'skill', skillId: 'performance-optimizer' }], supportedCapabilityKeys: ['performance-optimization'] },
    { ruleId: 'cap-documentation', version: 1, dimension: 'capability', normalizedMatch: 'technical documentation', selectors: [{ kind: 'skill', skillId: 'technical-documentation' }], supportedCapabilityKeys: ['technical-writing'] },

    // ─── Deliverable Rules ────────────────────────────
    { ruleId: 'del-api-spec', version: 1, dimension: 'deliverable', normalizedMatch: 'api spec', selectors: [{ kind: 'skill', skillId: 'api-documentation' }], supportedCapabilityKeys: ['api-docs'] },
    { ruleId: 'del-test-plan', version: 1, dimension: 'deliverable', normalizedMatch: 'test plan', selectors: [{ kind: 'skill', skillId: 'test-driven-development' }], supportedCapabilityKeys: ['test-planning'] },
    { ruleId: 'del-deployment-manifest', version: 1, dimension: 'deliverable', normalizedMatch: 'deployment manifest', selectors: [{ kind: 'skill', skillId: 'container-orchestration' }], supportedCapabilityKeys: ['deployment'] },
    { ruleId: 'del-security-audit', version: 1, dimension: 'deliverable', normalizedMatch: 'security audit', selectors: [{ kind: 'skill', skillId: 'security-hardening' }], supportedCapabilityKeys: ['security-audit'] },
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
    generatedFrom: 'catalog-skill-id-selectors',
    generatedAt: new Date().toISOString(),
  },
};
