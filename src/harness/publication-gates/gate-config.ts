/**
 * Publication Gate Configuration
 *
 * Defines the mapping from publishable artifacts to their required gate
 * categories and the test patterns that fulfill each category.
 *
 * Each MCP artifact can be evaluated independently — evaluating session-mcp
 * does not require runtime-mcp to be started and vice versa.
 *
 * Requirements: 33.4–33.9, 46.13, 46.17, 47.13, 47.19
 */

import type {
  ArtifactGateConfig,
  GateCategory,
  GateCategoryConfig,
  PublishableArtifact,
} from './types.js';

/**
 * Gate category definitions with their associated test patterns.
 *
 * Test patterns use Vitest include glob syntax and are resolved relative
 * to the project root.
 */
export const GATE_CATEGORIES: Record<GateCategory, GateCategoryConfig> = {
  'mcp-conformance': {
    category: 'mcp-conformance',
    label: 'MCP Protocol Conformance',
    testPatterns: [
      'src/harness/mcp/__tests__/mcp-conformance.test.ts',
      'src/harness/mcp/__tests__/architecture-conformance.test.ts',
      'src/harness/mcp/__tests__/lifecycle.test.ts',
    ],
    blocking: true,
    timeout: 60_000,
  },
  'migration-compatibility': {
    category: 'migration-compatibility',
    label: 'Migration & Schema Compatibility',
    testPatterns: [
      'src/harness/database/__tests__/migration*.test.ts',
      'src/harness/database/__tests__/compatibility*.test.ts',
      'tests/property/**/property-33-*.prop.ts',
    ],
    blocking: true,
    timeout: 60_000,
  },
  'invariant-reconstruction': {
    category: 'invariant-reconstruction',
    label: 'Invariant Reconstruction & Diagnostics',
    testPatterns: [
      'src/harness/diagnostics/__tests__/*.test.ts',
      'tests/property/**/property-31-*.prop.ts',
    ],
    blocking: true,
    timeout: 45_000,
  },
  'platform-security': {
    category: 'platform-security',
    label: 'Supported Platform Security',
    testPatterns: [
      'src/harness/runtime/__tests__/sandbox*.test.ts',
      'src/harness/runtime/__tests__/execution-world*.test.ts',
      'tests/property/**/property-9-*.prop.ts',
      'tests/property/**/property-29-*.prop.ts',
    ],
    blocking: true,
    timeout: 60_000,
  },
  accessibility: {
    category: 'accessibility',
    label: 'Critical Accessibility',
    testPatterns: [
      'src/harness/presentation/__tests__/accessibility*.test.ts',
      'src/harness/presentation/quality-gates/__tests__/*.test.ts',
      'tests/property/**/property-48-*.prop.ts',
      'tests/property/**/property-49-*.prop.ts',
    ],
    blocking: true,
    timeout: 45_000,
  },
  'rendering-correctness': {
    category: 'rendering-correctness',
    label: 'Rendering Correctness',
    testPatterns: [
      'src/harness/presentation/__tests__/rendering*.test.ts',
      'tests/property/**/property-50-*.prop.ts',
      'tests/property/**/property-34-*.prop.ts',
      'tests/property/**/property-36-*.prop.ts',
      'tests/property/**/property-37-*.prop.ts',
    ],
    blocking: true,
    timeout: 60_000,
  },
  performance: {
    category: 'performance',
    label: 'Configured Performance Budgets',
    testPatterns: [
      'tests/benchmark/harness-*.bench.ts',
      'src/harness/presentation/__tests__/performance*.test.ts',
    ],
    blocking: true,
    timeout: 90_000,
  },
  snapshots: {
    category: 'snapshots',
    label: 'Protocol & Contract Snapshots',
    testPatterns: [
      'src/harness/mcp/__tests__/schema-snapshot*.test.ts',
      'src/harness/contracts/__tests__/snapshot*.test.ts',
    ],
    blocking: true,
    timeout: 30_000,
  },
  traceability: {
    category: 'traceability',
    label: 'Requirement/Property Traceability',
    testPatterns: [
      'src/harness/traceability/__tests__/*.test.ts',
    ],
    blocking: true,
    timeout: 30_000,
  },
};

/**
 * Artifact gate configurations.
 *
 * Each artifact declares which gate categories it requires and whether
 * it can be evaluated independently (without the other MCP process).
 */
export const ARTIFACT_GATES: Record<PublishableArtifact, ArtifactGateConfig> = {
  'session-mcp': {
    artifact: 'session-mcp',
    label: 'neuronest-session-mcp',
    requiredGates: [
      'mcp-conformance',
      'migration-compatibility',
      'invariant-reconstruction',
      'platform-security',
      'snapshots',
      'traceability',
    ],
    independent: true,
  },
  'runtime-mcp': {
    artifact: 'runtime-mcp',
    label: 'neuronest-runtime-mcp',
    requiredGates: [
      'mcp-conformance',
      'migration-compatibility',
      'invariant-reconstruction',
      'platform-security',
      'snapshots',
      'traceability',
    ],
    independent: true,
  },
  schema: {
    artifact: 'schema',
    label: 'Shared Database Schema',
    requiredGates: [
      'migration-compatibility',
      'invariant-reconstruction',
      'snapshots',
      'traceability',
    ],
    independent: true,
  },
  ui: {
    artifact: 'ui',
    label: 'Chat Interface (UI)',
    requiredGates: [
      'accessibility',
      'rendering-correctness',
      'performance',
      'snapshots',
      'traceability',
    ],
    independent: true,
  },
};

/**
 * Returns the gate configuration for a specific artifact.
 */
export function getArtifactGateConfig(artifact: PublishableArtifact): ArtifactGateConfig {
  return ARTIFACT_GATES[artifact];
}

/**
 * Returns the gate category configuration.
 */
export function getGateCategoryConfig(category: GateCategory): GateCategoryConfig {
  return GATE_CATEGORIES[category];
}

/**
 * Returns all publishable artifact identifiers.
 */
export function getAllArtifacts(): PublishableArtifact[] {
  return Object.keys(ARTIFACT_GATES) as PublishableArtifact[];
}

/**
 * Returns all gate categories.
 */
export function getAllGateCategories(): GateCategory[] {
  return Object.keys(GATE_CATEGORIES) as GateCategory[];
}

/**
 * Returns the unique set of gate categories needed across the specified artifacts.
 * Used to deduplicate test runs when evaluating multiple artifacts at once.
 */
export function getRequiredGatesForArtifacts(artifacts: PublishableArtifact[]): GateCategory[] {
  const categories = new Set<GateCategory>();
  for (const artifact of artifacts) {
    const config = ARTIFACT_GATES[artifact];
    for (const gate of config.requiredGates) {
      categories.add(gate);
    }
  }
  return Array.from(categories);
}

/**
 * Returns the test patterns for a specific gate category, optionally filtered
 * to only patterns relevant to a single artifact scope.
 *
 * When artifact is 'session-mcp', MCP conformance patterns are filtered to
 * session-specific tests only. When 'runtime-mcp', to runtime-specific.
 * Other artifacts get all patterns for their categories.
 */
export function getTestPatternsForGate(
  category: GateCategory,
  artifact?: PublishableArtifact,
): string[] {
  const config = GATE_CATEGORIES[category];
  if (!artifact) return config.testPatterns;

  // MCP conformance can be scoped to a single server
  if (category === 'mcp-conformance') {
    if (artifact === 'session-mcp') {
      return config.testPatterns.filter(
        (p) => !p.includes('runtime') || p.includes('architecture'),
      );
    }
    if (artifact === 'runtime-mcp') {
      return config.testPatterns.filter(
        (p) => !p.includes('session') || p.includes('architecture'),
      );
    }
  }

  return config.testPatterns;
}
