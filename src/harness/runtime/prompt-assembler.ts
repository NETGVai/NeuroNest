/**
 * Prompt Assembler — Deterministic Prompt Assembly and Exact Reconstruction
 *
 * The sole authority for constructing ordered model-visible prompts from named
 * sections and strict variables. Implements:
 *
 * 1. Versioned named sections assembled in stable ordering-key order (12.1)
 * 2. Deterministic scope precedence for overrides (12.2)
 * 3. Normalized tool schemas in deterministic configured order (12.3)
 * 4. Structured assembly errors blocking dispatch (12.4)
 * 5. Prompt_Fingerprint computed before provider-specific translation (12.5)
 * 6. Unchanged prefix byte-for-byte stability (12.6)
 * 7. Persisted normalized inputs for exact reconstruction (12.7)
 * 8. Dispatch blocked when reconstruction is impossible (12.8, 34.1-34.2)
 *
 * Requirements: 12.1–12.8, 34.1–34.2
 */

import { createHash } from 'crypto';

import type {
  AssemblyInput,
  AssemblyResult,
  AssembledPrompt,
  AssemblyError,
  NamedPromptSection,
  NormalizedToolSchema,
  ScopeOverrideEntry,
  ScopePrecedence,
  PromptFingerprintRecord,
} from './prompt-assembler-schemas.js';

// ─── Scope Precedence Ordering ──────────────────────────────────

/**
 * Numeric precedence: higher wins. Route overrides everything.
 * route (4) > session (3) > skill (2) > profile (1)
 */
const SCOPE_PRECEDENCE_RANK: Record<ScopePrecedence, number> = {
  profile: 1,
  skill: 2,
  session: 3,
  route: 4,
};

// ─── Dependency Ports ───────────────────────────────────────────

/**
 * Port for persisting all normalized inputs required for exact reconstruction.
 * Requirement 12.7, 34.1.
 */
export interface AssemblyPersistence {
  /**
   * Persist all normalized inputs so the prompt can be exactly reconstructed.
   * Returns true if persistence succeeds; false blocks dispatch.
   */
  persist(input: AssemblyInput, fingerprint: string): Promise<boolean>;
}

/**
 * Port for verifying that a prompt can be durably reconstructed.
 * Requirement 12.8, 34.2.
 */
export interface ReconstructionVerifier {
  /**
   * Verify that the persisted inputs are sufficient for exact reconstruction.
   * Returns true if the assembled prompt can be rebuilt from durable records.
   */
  canReconstruct(fingerprint: string, sessionId: string, branchId: string): Promise<boolean>;
}

// ─── Prompt Assembler ───────────────────────────────────────────

export interface PromptAssemblerDeps {
  persistence: AssemblyPersistence;
  reconstructionVerifier: ReconstructionVerifier;
}

/**
 * Prompt_Assembler — the sole authority for constructing ordered model-visible
 * prompts from named sections and strict variables.
 *
 * Thread-safe: operates on immutable input; produces immutable output.
 */
export class PromptAssembler {
  private readonly deps: PromptAssemblerDeps;

  constructor(deps: PromptAssemblerDeps) {
    this.deps = deps;
  }

  /**
   * Assemble a provider-neutral prompt from the given inputs.
   *
   * Steps:
   * 1. Validate all sections, variables, and tool references
   * 2. Apply deterministic scope overrides by precedence
   * 3. Resolve all section templates with strict variable substitution
   * 4. Order sections by stable ordering key
   * 5. Normalize tool schemas in deterministic order
   * 6. Compute Prompt_Fingerprint before provider translation
   * 7. Persist all normalized inputs for exact reconstruction
   * 8. Verify reconstructability; block dispatch if impossible
   *
   * Returns a discriminated result: success with assembled prompt, or
   * failure with structured assembly errors.
   */
  async assemble(input: AssemblyInput): Promise<AssemblyResult> {
    // ── Step 1: Validate inputs ──────────────────────────────────

    const validationErrors = this.validateInputs(input);
    if (validationErrors.length > 0) {
      return { ok: false, errors: validationErrors };
    }

    // ── Step 2: Apply deterministic scope overrides ──────────────

    const overriddenSections = this.applyScopeOverrides(input.sections, input.scopeOverrides);

    // ── Step 3: Resolve templates with strict variable substitution ─

    const resolutionResult = this.resolveSections(overriddenSections);
    if (!resolutionResult.ok) {
      return { ok: false, errors: resolutionResult.errors };
    }

    // ── Step 4: Order sections by stable ordering key ────────────

    const orderedResolved = [...resolutionResult.resolved].sort(
      (a, b) => a.orderingKey - b.orderingKey,
    );

    // ── Step 5: Normalize tool schemas in deterministic order ────

    const orderedTools = this.normalizeToolOrder(input.tools);

    // ── Step 6: Compute Prompt_Fingerprint ───────────────────────

    const promptContent = orderedResolved
      .map(s => s.resolvedContent)
      .join('\n');

    const fingerprint = this.computeFingerprint({
      sections: orderedResolved.map(s => ({
        sectionName: s.sectionName,
        sectionVersion: s.sectionVersion,
        orderingKey: s.orderingKey,
        resolvedContent: s.resolvedContent,
      })),
      tools: orderedTools,
      routeId: input.routeId,
      adapterVersion: input.adapterVersion,
      assemblyVersion: input.assemblyVersion,
    });

    const fingerprintRecord: PromptFingerprintRecord = {
      fingerprint,
      sessionId: input.sessionId,
      branchId: input.branchId,
      routeId: input.routeId,
      assemblyVersion: input.assemblyVersion,
      sectionCount: orderedResolved.length,
      toolCount: orderedTools.length,
      computedAt: new Date().toISOString(),
    };

    // ── Step 7: Persist normalized inputs ────────────────────────

    const persisted = await this.deps.persistence.persist(input, fingerprint);
    if (!persisted) {
      return {
        ok: false,
        errors: [{
          kind: 'non_reconstructable',
          message: 'Failed to persist assembly inputs; dispatch blocked because prompt cannot be reconstructed',
          details: { sessionId: input.sessionId, branchId: input.branchId },
        }],
      };
    }

    // ── Step 8: Verify reconstructability ────────────────────────

    const canReconstruct = await this.deps.reconstructionVerifier.canReconstruct(
      fingerprint,
      input.sessionId,
      input.branchId,
    );
    if (!canReconstruct) {
      return {
        ok: false,
        errors: [{
          kind: 'non_reconstructable',
          message: 'Assembled prompt cannot be durably reconstructed; dispatch blocked',
          details: { fingerprint, sessionId: input.sessionId, branchId: input.branchId },
        }],
      };
    }

    // ── Construct result ─────────────────────────────────────────

    const assembledPrompt: AssembledPrompt = {
      assembledSections: orderedResolved.map(s => ({
        sectionName: s.sectionName,
        sectionVersion: s.sectionVersion,
        orderingKey: s.orderingKey,
        resolvedContent: s.resolvedContent,
        variableResolutions: s.variableResolutions,
        sourceRevisions: s.sourceRevisions,
      })),
      orderedTools,
      fingerprint: fingerprintRecord,
      persistedInput: input,
      promptContent,
      assembledAt: new Date().toISOString(),
    };

    return { ok: true, prompt: assembledPrompt };
  }

  // ─── Validation ─────────────────────────────────────────────────

  /**
   * Validate all inputs for well-formedness.
   * Requirement 12.4: fail before dispatch with structured assembly error.
   */
  private validateInputs(input: AssemblyInput): AssemblyError[] {
    const errors: AssemblyError[] = [];

    // Must have at least one section
    if (input.sections.length === 0) {
      errors.push({
        kind: 'empty_sections',
        message: 'At least one named prompt section is required',
        details: {},
      });
      return errors; // Short-circuit: nothing else to validate
    }

    // Check for duplicate ordering keys
    const orderingKeys = new Set<number>();
    for (const section of input.sections) {
      if (orderingKeys.has(section.orderingKey)) {
        errors.push({
          kind: 'duplicate_ordering_key',
          message: `Duplicate ordering key ${section.orderingKey} in section "${section.sectionName}"`,
          sectionName: section.sectionName,
          details: { orderingKey: section.orderingKey },
        });
      }
      orderingKeys.add(section.orderingKey);
    }

    // Validate section names and templates
    for (const section of input.sections) {
      if (!section.sectionName || section.sectionName.trim().length === 0) {
        errors.push({
          kind: 'malformed_section',
          message: 'Section name must be non-empty',
          sectionName: section.sectionName,
          details: {},
        });
      }
      if (!section.sectionVersion || section.sectionVersion.trim().length === 0) {
        errors.push({
          kind: 'malformed_section',
          message: `Section "${section.sectionName}" has empty version`,
          sectionName: section.sectionName,
          details: {},
        });
      }
    }

    // Validate tool references
    for (const tool of input.tools) {
      if (!tool.toolName || tool.toolName.trim().length === 0) {
        errors.push({
          kind: 'malformed_tool_reference',
          message: 'Tool name must be non-empty',
          toolName: tool.toolName,
          details: {},
        });
      }
      if (!tool.toolVersion || tool.toolVersion.trim().length === 0) {
        errors.push({
          kind: 'malformed_tool_reference',
          message: `Tool "${tool.toolName}" has empty version`,
          toolName: tool.toolName,
          details: {},
        });
      }
      if (!tool.schemaHash || tool.schemaHash.trim().length === 0) {
        errors.push({
          kind: 'malformed_tool_reference',
          message: `Tool "${tool.toolName}" has empty schema hash`,
          toolName: tool.toolName,
          details: {},
        });
      }
    }

    // Validate scope overrides reference existing sections/variables
    for (const override of input.scopeOverrides) {
      if (!override.sectionName || override.sectionName.trim().length === 0) {
        errors.push({
          kind: 'invalid_override',
          message: 'Override section name must be non-empty',
          details: { override },
        });
      }
      if (!override.variableName || override.variableName.trim().length === 0) {
        errors.push({
          kind: 'invalid_override',
          message: `Override for section "${override.sectionName}" has empty variable name`,
          sectionName: override.sectionName,
          details: { override },
        });
      }
    }

    return errors;
  }

  // ─── Scope Override Application ─────────────────────────────────

  /**
   * Apply deterministic scope overrides by precedence.
   * Requirement 12.2: deterministic scope precedence and record each selected source revision.
   *
   * When multiple overrides target the same section/variable, the highest
   * precedence wins. Within the same precedence level, later entries in the
   * array win (last-write-wins for equal precedence).
   */
  private applyScopeOverrides(
    sections: NamedPromptSection[],
    overrides: ScopeOverrideEntry[],
  ): NamedPromptSection[] {
    if (overrides.length === 0) return sections;

    // Group overrides by section+variable, keeping only highest-precedence
    const winningOverrides = new Map<string, ScopeOverrideEntry>();

    // Sort by precedence ascending so that higher-precedence overwrites lower
    const sortedOverrides = [...overrides].sort(
      (a, b) => SCOPE_PRECEDENCE_RANK[a.precedence] - SCOPE_PRECEDENCE_RANK[b.precedence],
    );

    for (const override of sortedOverrides) {
      const key = `${override.sectionName}::${override.variableName}`;
      // Higher precedence (processed later) always wins
      winningOverrides.set(key, override);
    }

    // Apply winning overrides to sections
    return sections.map(section => {
      const updatedVariables = section.variables.map(v => {
        const key = `${section.sectionName}::${v.name}`;
        const winning = winningOverrides.get(key);
        if (winning) {
          return {
            ...v,
            value: winning.value,
            source: winning.sourceRevision,
          };
        }
        return v;
      });

      return {
        ...section,
        variables: updatedVariables,
      };
    });
  }

  // ─── Template Resolution ────────────────────────────────────────

  /**
   * Resolve all section templates with strict variable substitution.
   * Requirement 12.4: fail if a variable is unresolved.
   */
  private resolveSections(sections: NamedPromptSection[]): ResolutionResult {
    const resolved: ResolvedSection[] = [];
    const errors: AssemblyError[] = [];

    for (const section of sections) {
      const variableMap = new Map<string, string>();
      const sourceRevisions: string[] = [];

      for (const v of section.variables) {
        variableMap.set(v.name, v.value);
        sourceRevisions.push(v.source);
      }

      // Find all template variables ({{variableName}})
      const templateVarRegex = /\{\{([^}]+)\}\}/g;
      let match: RegExpExecArray | null;
      const unresolvedVars: string[] = [];
      const usedVars = new Set<string>();

      // First pass: check for unresolved variables
      const template = section.template;
      // Reset regex state
      templateVarRegex.lastIndex = 0;
      while ((match = templateVarRegex.exec(template)) !== null) {
        const varName = (match[1] ?? '').trim();
        usedVars.add(varName);
        if (!variableMap.has(varName)) {
          unresolvedVars.push(varName);
        }
      }

      if (unresolvedVars.length > 0) {
        for (const varName of unresolvedVars) {
          errors.push({
            kind: 'unresolved_variable',
            message: `Unresolved variable "{{${varName}}}" in section "${section.sectionName}"`,
            sectionName: section.sectionName,
            variableName: varName,
            details: {},
          });
        }
        continue;
      }

      // Second pass: substitute variables
      const resolvedContent = template.replace(templateVarRegex, (_, varName: string) => {
        return variableMap.get(varName.trim()) ?? '';
      });

      const variableResolutions: Record<string, string> = {};
      for (const [name, value] of variableMap) {
        variableResolutions[name] = value;
      }

      resolved.push({
        sectionName: section.sectionName,
        sectionVersion: section.sectionVersion,
        orderingKey: section.orderingKey,
        resolvedContent,
        variableResolutions,
        sourceRevisions: [...new Set(sourceRevisions)],
      });
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return { ok: true, resolved };
  }

  // ─── Tool Normalization ─────────────────────────────────────────

  /**
   * Normalize tool schema ordering deterministically.
   * Requirement 12.3: order by configured order, then stable tool identity.
   *
   * Stable identity ordering ensures byte-for-byte identical output when
   * the same tools are presented regardless of input array order.
   */
  private normalizeToolOrder(tools: NormalizedToolSchema[]): NormalizedToolSchema[] {
    return [...tools].sort((a, b) => {
      // Primary: configured order
      if (a.configuredOrder !== b.configuredOrder) {
        return a.configuredOrder - b.configuredOrder;
      }
      // Secondary: stable tool name
      if (a.toolName !== b.toolName) {
        return a.toolName.localeCompare(b.toolName);
      }
      // Tertiary: version (for determinism)
      return a.toolVersion.localeCompare(b.toolVersion);
    });
  }

  // ─── Fingerprint Computation ────────────────────────────────────

  /**
   * Compute a stable Prompt_Fingerprint from normalized assembly inputs.
   * Requirement 12.5: compute before provider-specific translation.
   * Requirement 12.6: unchanged prefixes produce identical bytes.
   *
   * The fingerprint is a SHA-256 digest over the deterministic JSON
   * serialization of sections, tools, route, adapter version, and assembly version.
   */
  computeFingerprint(params: {
    sections: Array<{
      sectionName: string;
      sectionVersion: string;
      orderingKey: number;
      resolvedContent: string;
    }>;
    tools: NormalizedToolSchema[];
    routeId: string;
    adapterVersion: string;
    assemblyVersion: string;
  }): string {
    // Deterministic JSON: sorted keys, no whitespace variance
    const canonical = JSON.stringify({
      assemblyVersion: params.assemblyVersion,
      routeId: params.routeId,
      adapterVersion: params.adapterVersion,
      sections: params.sections.map(s => ({
        n: s.sectionName,
        v: s.sectionVersion,
        o: s.orderingKey,
        c: s.resolvedContent,
      })),
      tools: params.tools.map(t => ({
        n: t.toolName,
        v: t.toolVersion,
        h: t.schemaHash,
        o: t.configuredOrder,
        i: JSON.stringify(t.inputSchema, Object.keys(t.inputSchema).sort()),
      })),
    });

    return createHash('sha256').update(canonical).digest('hex');
  }
}

// ─── Internal Types ─────────────────────────────────────────────

interface ResolvedSection {
  sectionName: string;
  sectionVersion: string;
  orderingKey: number;
  resolvedContent: string;
  variableResolutions: Record<string, string>;
  sourceRevisions: string[];
}

type ResolutionResult =
  | { ok: true; resolved: ResolvedSection[] }
  | { ok: false; errors: AssemblyError[] };
