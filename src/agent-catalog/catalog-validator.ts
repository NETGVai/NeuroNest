import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { AgentDefinition } from '../agents/agent-registry';
import type {
  AgentFileParseResult,
  ParseStatus,
  StructuralValidation,
} from './agent-file-parser';
import type { ImportCatalogOutcome } from './agent-population';
import {
  analyzeCatalogDuplicates,
  type CatalogDuplicateAnalysis,
  type CatalogDuplicateRelationship,
} from './catalog-duplicates';
import type { CatalogManifest, CatalogManifestEntry } from './catalog-discovery';
import { parseAgentFile } from './agent-importer';
import {
  validateAgentAuthenticity,
  type AdditionalReferenceDefinition,
  type AuthenticityValidation,
} from './authenticity-validator';
import {
  createQualityScorer,
  QUALITY_RULE_IDS,
  type QualityAnalysis,
  type QualityDimensionId,
  type QualityRuleId,
  type QualityScorer,
} from './quality-scorer';
import type { QualityBreakdown } from './types';

export type AvailableQualityScore = number | 'unavailable';
export type QualityCriterionComparison = 'minimum' | 'maximum' | 'exact' | 'boolean';

export type PerAgentQualityCriterionName =
  | 'structuredOutputMinimum'
  | 'domainTermMinimum'
  | 'vagueQualifierMaximum'
  | 'roleConstraintMinimum'
  | 'numberedDeliverableMinimum'
  | 'codeExampleMinimum'
  | 'successMetricMinimum'
  | 'outputFormatMinimum'
  | 'technologyMinimum'
  | 'frameworkMinimum'
  | 'methodologyMinimum'
  | 'vocabularyDensityMinimum'
  | 'contextualAssociation'
  | 'keywordStuffingAbsence';

export interface PerAgentQualityCriterionResult {
  readonly criterion: PerAgentQualityCriterionName;
  readonly dimension: QualityDimensionId;
  readonly ruleId: QualityRuleId | null;
  readonly applicable: boolean;
  readonly passed: boolean;
  readonly comparison: QualityCriterionComparison;
  readonly expected: number | boolean;
  readonly actual: number | boolean;
}

export interface QualityDimensionValidation {
  readonly dimension: QualityDimensionId;
  readonly criteria: readonly PerAgentQualityCriterionResult[];
  readonly independentCriteriaPassed: boolean;
  readonly score: AvailableQualityScore;
  readonly exactScorePassed: boolean;
  readonly passed: boolean;
}

export interface ExactScoreInvariant {
  readonly promptSpecificity: boolean;
  readonly deliverableStructure: boolean;
  readonly workflowCompleteness: boolean;
  readonly domainDepth: boolean;
  readonly total: boolean;
  readonly passed: boolean;
}

export type WorkflowCatalogCriterionName =
  | 'sequentialProcessMinimum'
  | 'decisionMinimum'
  | 'errorHandlingMinimum'
  | 'iterationMinimum';

export interface WorkflowCatalogCountResult {
  readonly criterion: WorkflowCatalogCriterionName;
  readonly ruleId: QualityRuleId;
  readonly actual: number;
  readonly minimum: number;
  readonly passed: boolean;
}

export interface WorkflowCatalogValidation {
  readonly counts: Readonly<Record<WorkflowCatalogCriterionName, WorkflowCatalogCountResult>>;
  readonly workflowCountsBelowMinima: boolean;
  readonly passed: boolean;
}

export interface CatalogQualityFinding {
  readonly code: string;
  readonly sourcePath: string | null;
  readonly scope: 'parse' | 'structure' | 'authenticity' | 'quality' | 'duplicate' | 'catalog';
  readonly classification: 'blocking' | 'informational';
  readonly message: string;
}

export interface AggregateStatusDiscrepancy {
  readonly code: 'AGGREGATE_STATUS_DISCREPANCY';
  readonly sourcePath: string | null;
  readonly scope: QualityDimensionId | 'overall' | 'workflowCatalog';
  readonly individualStatus: boolean;
  readonly aggregateStatus: boolean;
  readonly message: string;
}

export interface CatalogSourceDuplicateMetadata {
  readonly catalogOutcome?: ImportCatalogOutcome | 'unresolved';
  readonly resolutionReason?: string;
  readonly duplicateGroupId?: string | null;
}

export interface CatalogValidatorAggregateStatuses {
  readonly bySourcePath?: Readonly<
    Record<string, Partial<Record<QualityDimensionId | 'overall', boolean>>>
  >;
  readonly workflowCatalog?: boolean;
}

export interface CatalogValidatorOptions {
  readonly scorer?: Pick<QualityScorer, 'analyze'>;
  readonly readSource?: (
    entry: CatalogManifestEntry,
  ) => Promise<string | Uint8Array> | string | Uint8Array;
  readonly duplicateMetadataByPath?: Readonly<Record<string, CatalogSourceDuplicateMetadata>>;
  readonly aggregateStatuses?: CatalogValidatorAggregateStatuses;
  readonly specialtyAnchorsByPath?: Readonly<Record<string, readonly string[]>>;
  readonly additionalReferences?: readonly AdditionalReferenceDefinition[];
  readonly additionalOfficialHosts?: readonly string[];
}

export interface LoadedCatalogSource {
  readonly entry: CatalogManifestEntry;
  readonly source: string | Uint8Array | null;
  readonly loadError: string | null;
}

export interface CatalogSourceValidation {
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly agentName: string;
  readonly agentId: string | null;
  readonly definition: Readonly<AgentDefinition> | null;
  readonly parseStatus: ParseStatus | 'failed-to-read';
  readonly parseResult: AgentFileParseResult | null;
  readonly extractionComplete: boolean;
  readonly extractionOverrideApplied: boolean;
  readonly structural: StructuralValidation | null;
  readonly structuralAccepted: boolean;
  readonly authenticity: AuthenticityValidation | null;
  readonly qualityAnalysis: QualityAnalysis | null;
  readonly scores: Readonly<QualityBreakdown> | Readonly<{
    promptSpecificity: 'unavailable';
    deliverableStructure: 'unavailable';
    workflowCompleteness: 'unavailable';
    domainDepth: 'unavailable';
    total: 'unavailable';
  }>;
  readonly dimensions: Readonly<Record<QualityDimensionId, QualityDimensionValidation>>;
  readonly exactScoreInvariant: ExactScoreInvariant;
  readonly duplicateRelationships: readonly CatalogDuplicateRelationship[];
  readonly aggregateStatusDiscrepancies: readonly AggregateStatusDiscrepancy[];
  readonly findings: readonly CatalogQualityFinding[];
  readonly passed: boolean;
}

export interface CatalogValidationResult {
  readonly rootPath: string;
  readonly discoveredCount: number;
  readonly processedCount: number;
  readonly perSource: readonly CatalogSourceValidation[];
  readonly workflowCatalog: WorkflowCatalogValidation;
  readonly duplicateAnalysis: CatalogDuplicateAnalysis;
  readonly aggregateStatusDiscrepancies: readonly AggregateStatusDiscrepancy[];
  readonly catalogFindings: readonly CatalogQualityFinding[];
  readonly passed: boolean;
}

interface MutableSourceValidation {
  sourcePath: string;
  sourceHash: string;
  agentName: string;
  agentId: string | null;
  definition: Readonly<AgentDefinition> | null;
  parseStatus: ParseStatus | 'failed-to-read';
  parseResult: AgentFileParseResult | null;
  extractionComplete: boolean;
  extractionOverrideApplied: boolean;
  structural: StructuralValidation | null;
  structuralAccepted: boolean;
  authenticity: AuthenticityValidation | null;
  qualityAnalysis: QualityAnalysis | null;
  scores: CatalogSourceValidation['scores'];
  dimensions: Readonly<Record<QualityDimensionId, QualityDimensionValidation>>;
  exactScoreInvariant: ExactScoreInvariant;
  duplicateRelationships: readonly CatalogDuplicateRelationship[];
  aggregateStatusDiscrepancies: AggregateStatusDiscrepancy[];
  findings: CatalogQualityFinding[];
  basePassed: boolean;
  passed: boolean;
}

const DIMENSIONS: readonly QualityDimensionId[] = [
  'promptSpecificity',
  'deliverableStructure',
  'workflowCompleteness',
  'domainDepth',
];

const UNAVAILABLE_SCORES = Object.freeze({
  promptSpecificity: 'unavailable' as const,
  deliverableStructure: 'unavailable' as const,
  workflowCompleteness: 'unavailable' as const,
  domainDepth: 'unavailable' as const,
  total: 'unavailable' as const,
});

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function finding(
  code: string,
  sourcePath: string | null,
  scope: CatalogQualityFinding['scope'],
  classification: CatalogQualityFinding['classification'],
  message: string,
): CatalogQualityFinding {
  return Object.freeze({ code, sourcePath, scope, classification, message });
}

function criterion(
  criterionName: PerAgentQualityCriterionName,
  dimension: QualityDimensionId,
  ruleId: QualityRuleId | null,
  comparison: QualityCriterionComparison,
  expected: number | boolean,
  actual: number | boolean,
  applicable = true,
): PerAgentQualityCriterionResult {
  const passed = !applicable || (
    comparison === 'minimum'
      ? Number(actual) >= Number(expected)
      : comparison === 'maximum'
        ? Number(actual) <= Number(expected)
        : actual === expected
  );
  return Object.freeze({
    criterion: criterionName,
    dimension,
    ruleId,
    applicable,
    passed,
    comparison,
    expected,
    actual,
  });
}

function unavailableDimension(dimension: QualityDimensionId): QualityDimensionValidation {
  return Object.freeze({
    dimension,
    criteria: Object.freeze([]),
    independentCriteriaPassed: false,
    score: 'unavailable',
    exactScorePassed: false,
    passed: false,
  });
}

function unavailableDimensions(): Readonly<Record<QualityDimensionId, QualityDimensionValidation>> {
  return Object.freeze({
    promptSpecificity: unavailableDimension('promptSpecificity'),
    deliverableStructure: unavailableDimension('deliverableStructure'),
    workflowCompleteness: unavailableDimension('workflowCompleteness'),
    domainDepth: unavailableDimension('domainDepth'),
  });
}

function failedExactInvariant(): ExactScoreInvariant {
  return Object.freeze({
    promptSpecificity: false,
    deliverableStructure: false,
    workflowCompleteness: false,
    domainDepth: false,
    total: false,
    passed: false,
  });
}

function deriveName(sourcePath: string): string {
  return basename(sourcePath, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim() || 'Unnamed Agent';
}

function aggregateDiscrepancy(
  sourcePath: string | null,
  scope: AggregateStatusDiscrepancy['scope'],
  individualStatus: boolean,
  aggregateStatus: boolean,
): AggregateStatusDiscrepancy {
  return Object.freeze({
    code: 'AGGREGATE_STATUS_DISCREPANCY',
    sourcePath,
    scope,
    individualStatus,
    aggregateStatus,
    message: `Aggregate ${scope} status ${aggregateStatus ? 'passed' : 'failed'} while independently recorded criteria ${individualStatus ? 'passed' : 'failed'}; individual results remain authoritative`,
  });
}

function qualityCriterionFinding(
  sourcePath: string,
  result: PerAgentQualityCriterionResult,
): CatalogQualityFinding {
  return finding(
    `QUALITY_${result.criterion.replace(/([A-Z])/g, '_$1').toUpperCase()}`,
    sourcePath,
    'quality',
    'blocking',
    `${result.criterion} expected ${String(result.expected)} (${result.comparison}); found ${String(result.actual)}`,
  );
}

function createDimensions(
  sourcePath: string,
  analysis: QualityAnalysis,
  authenticity: AuthenticityValidation,
  findings: CatalogQualityFinding[],
): Readonly<Record<QualityDimensionId, QualityDimensionValidation>> {
  const counts = analysis.counts;
  const referenceMinimaApplicable = authenticity.references.domainPatternMinimaApplicable;
  const promptCriteria = Object.freeze([
    criterion('structuredOutputMinimum', 'promptSpecificity', QUALITY_RULE_IDS.structuredOutput, 'minimum', 3, counts[QUALITY_RULE_IDS.structuredOutput]),
    criterion('domainTermMinimum', 'promptSpecificity', QUALITY_RULE_IDS.domainTerms, 'minimum', 8, counts[QUALITY_RULE_IDS.domainTerms]),
    criterion('vagueQualifierMaximum', 'promptSpecificity', QUALITY_RULE_IDS.vagueQualifiers, 'maximum', 0, counts[QUALITY_RULE_IDS.vagueQualifiers]),
    criterion('roleConstraintMinimum', 'promptSpecificity', QUALITY_RULE_IDS.roleConstraints, 'minimum', 3, counts[QUALITY_RULE_IDS.roleConstraints]),
  ]);
  const deliverableCriteria = Object.freeze([
    criterion('numberedDeliverableMinimum', 'deliverableStructure', QUALITY_RULE_IDS.numberedDeliverables, 'minimum', 2, counts[QUALITY_RULE_IDS.numberedDeliverables]),
    criterion('codeExampleMinimum', 'deliverableStructure', QUALITY_RULE_IDS.codeExamples, 'minimum', 2, counts[QUALITY_RULE_IDS.codeExamples]),
    criterion('successMetricMinimum', 'deliverableStructure', QUALITY_RULE_IDS.successMetrics, 'minimum', 2, counts[QUALITY_RULE_IDS.successMetrics]),
    criterion('outputFormatMinimum', 'deliverableStructure', QUALITY_RULE_IDS.outputFormats, 'minimum', 3, counts[QUALITY_RULE_IDS.outputFormats]),
  ]);
  const workflowCriteria = Object.freeze([] as PerAgentQualityCriterionResult[]);
  const domainCriteria = Object.freeze([
    criterion('technologyMinimum', 'domainDepth', QUALITY_RULE_IDS.technologies, 'minimum', 3, counts[QUALITY_RULE_IDS.technologies], referenceMinimaApplicable),
    criterion('frameworkMinimum', 'domainDepth', QUALITY_RULE_IDS.frameworks, 'minimum', 2, counts[QUALITY_RULE_IDS.frameworks], referenceMinimaApplicable),
    criterion('methodologyMinimum', 'domainDepth', QUALITY_RULE_IDS.methodologies, 'minimum', 2, counts[QUALITY_RULE_IDS.methodologies], referenceMinimaApplicable),
    criterion('vocabularyDensityMinimum', 'domainDepth', QUALITY_RULE_IDS.vocabularyDensity, 'minimum', 0.3, analysis.vocabulary.density),
    criterion('contextualAssociation', 'domainDepth', null, 'boolean', true, authenticity.criteria.contextualAssociations.passed),
    criterion('keywordStuffingAbsence', 'domainDepth', null, 'exact', 0, authenticity.references.disconnectedReferences.length),
  ]);

  const criteriaByDimension: Readonly<Record<QualityDimensionId, readonly PerAgentQualityCriterionResult[]>> = {
    promptSpecificity: promptCriteria,
    deliverableStructure: deliverableCriteria,
    workflowCompleteness: workflowCriteria,
    domainDepth: domainCriteria,
  };
  const dimensions = {} as Record<QualityDimensionId, QualityDimensionValidation>;

  for (const dimension of DIMENSIONS) {
    const criteria = criteriaByDimension[dimension];
    for (const failed of criteria.filter((result) => !result.passed)) {
      findings.push(qualityCriterionFinding(sourcePath, failed));
    }
    const independentCriteriaPassed = criteria.every((result) => result.passed);
    let score: number = analysis.breakdown[dimension];

    // Per Req 5.13: When an agent is reference-free (all domain pattern minima waived)
    // and density passes, domain depth is treated as 25 for validation purposes.
    if (dimension === 'domainDepth'
      && authenticity.references.referenceFree
      && independentCriteriaPassed) {
      score = 25;
    }

    const exactScorePassed = score === 25;
    dimensions[dimension] = Object.freeze({
      dimension,
      criteria,
      independentCriteriaPassed,
      score,
      exactScorePassed,
      passed: independentCriteriaPassed && exactScorePassed,
    });
  }
  return Object.freeze(dimensions);
}

function createExactInvariant(breakdown: QualityBreakdown): ExactScoreInvariant {
  const invariant = {
    promptSpecificity: breakdown.promptSpecificity === 25,
    deliverableStructure: breakdown.deliverableStructure === 25,
    workflowCompleteness: breakdown.workflowCompleteness === 25,
    domainDepth: breakdown.domainDepth === 25,
    total: breakdown.total === 100,
  };
  return Object.freeze({ ...invariant, passed: Object.values(invariant).every(Boolean) });
}

function scoreFindings(
  sourcePath: string,
  breakdown: QualityBreakdown,
  invariant: ExactScoreInvariant,
): CatalogQualityFinding[] {
  const findings: CatalogQualityFinding[] = [];
  for (const dimension of DIMENSIONS) {
    if (!invariant[dimension]) {
      findings.push(finding(
        `SCORE_${dimension.replace(/([A-Z])/g, '_$1').toUpperCase()}_NOT_EXACT`,
        sourcePath,
        'quality',
        'blocking',
        `${dimension} must equal 25; found ${breakdown[dimension]}`,
      ));
    }
  }
  if (!invariant.total) {
    findings.push(finding(
      'SCORE_TOTAL_NOT_EXACT',
      sourcePath,
      'quality',
      'blocking',
      `Total score must equal 100; found ${breakdown.total}`,
    ));
  }
  return findings;
}

function sortFindings(values: CatalogQualityFinding[]): void {
  values.sort((left, right) => compareText(left.sourcePath ?? '', right.sourcePath ?? '')
    || compareText(left.scope, right.scope)
    || compareText(left.code, right.code)
    || compareText(left.message, right.message));
}

function validateLoadedSource(
  loaded: LoadedCatalogSource,
  options: CatalogValidatorOptions,
  scorer: Pick<QualityScorer, 'analyze'>,
): MutableSourceValidation {
  const { entry } = loaded;
  const findings: CatalogQualityFinding[] = [];
  if (loaded.source === null) {
    findings.push(finding(
      'VALIDATION_SYSTEM_ERROR',
      entry.sourcePath,
      'parse',
      'blocking',
      loaded.loadError ?? 'Source could not be read',
    ));
    return {
      sourcePath: entry.sourcePath,
      sourceHash: entry.sourceHash,
      agentName: deriveName(entry.sourcePath),
      agentId: null,
      definition: null,
      parseStatus: 'failed-to-read',
      parseResult: null,
      extractionComplete: false,
      extractionOverrideApplied: false,
      structural: null,
      structuralAccepted: false,
      authenticity: null,
      qualityAnalysis: null,
      scores: UNAVAILABLE_SCORES,
      dimensions: unavailableDimensions(),
      exactScoreInvariant: failedExactInvariant(),
      duplicateRelationships: Object.freeze([]),
      aggregateStatusDiscrepancies: [],
      findings,
      basePassed: false,
      passed: false,
    };
  }

  const imported = parseAgentFile(entry.sourcePath, loaded.source);
  const parseResult = imported.parseEvidence!;
  const definition = Object.freeze({ ...imported.definition });
  const structuralAccepted = parseResult.structural.strictValid || parseResult.extractionOverride.applied;
  const extractionAccepted = parseResult.status !== 'failed'
    && parseResult.extractionComplete
    && Boolean(parseResult.systemPrompt?.trim());

  for (const diagnostic of parseResult.diagnostics) {
    const informational = extractionAccepted && diagnostic.recoverable;
    findings.push(finding(
      diagnostic.code,
      entry.sourcePath,
      'parse',
      informational ? 'informational' : 'blocking',
      diagnostic.message,
    ));
  }
  for (const structuralFinding of parseResult.structural.findings) {
    findings.push(finding(
      structuralFinding.code,
      entry.sourcePath,
      'structure',
      structuralFinding.classification,
      structuralFinding.message,
    ));
  }
  if (!structuralAccepted && parseResult.structural.findings.length === 0) {
    findings.push(finding(
      'STRUCTURE_NOT_ACCEPTED',
      entry.sourcePath,
      'structure',
      'blocking',
      'Strict structure failed and the extraction override did not apply',
    ));
  }

  const authenticity = validateAgentAuthenticity({
    sourcePath: entry.sourcePath,
    specialty: definition.specialty,
    parseResult,
    specialtyAnchors: options.specialtyAnchorsByPath?.[entry.sourcePath],
    additionalReferences: options.additionalReferences,
    additionalOfficialHosts: options.additionalOfficialHosts,
  });
  for (const authenticityFinding of authenticity.findings) {
    findings.push(finding(
      authenticityFinding.code,
      entry.sourcePath,
      'authenticity',
      authenticityFinding.classification,
      authenticityFinding.message,
    ));
  }

  let qualityAnalysis: QualityAnalysis | null = null;
  let scores: CatalogSourceValidation['scores'] = UNAVAILABLE_SCORES;
  let dimensions = unavailableDimensions();
  let exactScoreInvariant = failedExactInvariant();
  const discrepancies: AggregateStatusDiscrepancy[] = [];

  if (extractionAccepted) {
    qualityAnalysis = scorer.analyze(definition);
    dimensions = createDimensions(entry.sourcePath, qualityAnalysis, authenticity, findings);

    // Build effective scores: override domainDepth when reference-free and density/criteria pass
    const rawBreakdown = qualityAnalysis.breakdown;
    const effectiveDomainDepth = dimensions.domainDepth.score as number;
    if (effectiveDomainDepth !== rawBreakdown.domainDepth) {
      const effectiveTotal = rawBreakdown.promptSpecificity
        + rawBreakdown.deliverableStructure
        + rawBreakdown.workflowCompleteness
        + effectiveDomainDepth;
      scores = {
        promptSpecificity: rawBreakdown.promptSpecificity,
        deliverableStructure: rawBreakdown.deliverableStructure,
        workflowCompleteness: rawBreakdown.workflowCompleteness,
        domainDepth: effectiveDomainDepth,
        total: effectiveTotal,
      };
    } else {
      scores = rawBreakdown;
    }
    exactScoreInvariant = createExactInvariant(scores as QualityBreakdown);
    findings.push(...scoreFindings(entry.sourcePath, scores as QualityBreakdown, exactScoreInvariant));

    for (const dimension of DIMENSIONS) {
      const individualStatus = dimensions[dimension].independentCriteriaPassed;
      const aggregateStatus = dimensions[dimension].exactScorePassed;
      if (individualStatus !== aggregateStatus) {
        discrepancies.push(aggregateDiscrepancy(
          entry.sourcePath,
          dimension,
          individualStatus,
          aggregateStatus,
        ));
      }
      const declaredStatus = options.aggregateStatuses?.bySourcePath?.[entry.sourcePath]?.[dimension];
      if (declaredStatus !== undefined && declaredStatus !== dimensions[dimension].passed) {
        discrepancies.push(aggregateDiscrepancy(
          entry.sourcePath,
          dimension,
          dimensions[dimension].passed,
          declaredStatus,
        ));
      }
    }
  }

  const basePassed = extractionAccepted
    && structuralAccepted
    && authenticity.valid
    && Object.values(dimensions).every((dimension) => dimension.passed)
    && exactScoreInvariant.passed
    && !findings.some((candidate) => candidate.classification === 'blocking');
  return {
    sourcePath: entry.sourcePath,
    sourceHash: entry.sourceHash,
    agentName: definition.name,
    agentId: definition.id,
    definition,
    parseStatus: parseResult.status,
    parseResult,
    extractionComplete: parseResult.extractionComplete,
    extractionOverrideApplied: parseResult.extractionOverride.applied,
    structural: parseResult.structural,
    structuralAccepted,
    authenticity,
    qualityAnalysis,
    scores,
    dimensions,
    exactScoreInvariant,
    duplicateRelationships: Object.freeze([]),
    aggregateStatusDiscrepancies: discrepancies,
    findings,
    basePassed,
    passed: basePassed,
  };
}

function workflowCount(
  criterionName: WorkflowCatalogCriterionName,
  ruleId: QualityRuleId,
  minimum: number,
  perSource: readonly MutableSourceValidation[],
): WorkflowCatalogCountResult {
  const actual = perSource.reduce(
    (total, source) => total + (source.qualityAnalysis?.counts[ruleId] ?? 0),
    0,
  );
  return Object.freeze({
    criterion: criterionName,
    ruleId,
    actual,
    minimum,
    passed: actual >= minimum,
  });
}

function validateWorkflowCatalog(
  perSource: readonly MutableSourceValidation[],
): WorkflowCatalogValidation {
  const counts = Object.freeze({
    sequentialProcessMinimum: workflowCount(
      'sequentialProcessMinimum',
      QUALITY_RULE_IDS.sequentialProcess,
      3,
      perSource,
    ),
    decisionMinimum: workflowCount(
      'decisionMinimum',
      QUALITY_RULE_IDS.decisions,
      2,
      perSource,
    ),
    errorHandlingMinimum: workflowCount(
      'errorHandlingMinimum',
      QUALITY_RULE_IDS.errorHandling,
      2,
      perSource,
    ),
    iterationMinimum: workflowCount(
      'iterationMinimum',
      QUALITY_RULE_IDS.iteration,
      2,
      perSource,
    ),
  });
  const workflowCountsBelowMinima = Object.values(counts).some((result) => !result.passed);
  return Object.freeze({ counts, workflowCountsBelowMinima, passed: !workflowCountsBelowMinima });
}

function freezeSource(source: MutableSourceValidation): CatalogSourceValidation {
  sortFindings(source.findings);
  source.aggregateStatusDiscrepancies.sort((left, right) => compareText(left.scope, right.scope)
    || Number(left.aggregateStatus) - Number(right.aggregateStatus));
  return Object.freeze({
    sourcePath: source.sourcePath,
    sourceHash: source.sourceHash,
    agentName: source.agentName,
    agentId: source.agentId,
    definition: source.definition,
    parseStatus: source.parseStatus,
    parseResult: source.parseResult,
    extractionComplete: source.extractionComplete,
    extractionOverrideApplied: source.extractionOverrideApplied,
    structural: source.structural,
    structuralAccepted: source.structuralAccepted,
    authenticity: source.authenticity,
    qualityAnalysis: source.qualityAnalysis,
    scores: source.scores,
    dimensions: source.dimensions,
    exactScoreInvariant: source.exactScoreInvariant,
    duplicateRelationships: source.duplicateRelationships,
    aggregateStatusDiscrepancies: Object.freeze(source.aggregateStatusDiscrepancies),
    findings: Object.freeze(source.findings),
    passed: source.passed,
  });
}

/**
 * Validates already loaded manifest sources. This is shared by filesystem and
 * staged-candidate callers and deliberately finishes every source before deriving
 * catalog totals or duplicate deficiencies.
 */
export function validateLoadedCatalog(
  manifest: CatalogManifest,
  loadedSources: readonly LoadedCatalogSource[],
  options: CatalogValidatorOptions = {},
): CatalogValidationResult {
  const scorer = options.scorer ?? createQualityScorer();
  const sourceByPath = new Map(loadedSources.map((loaded) => [loaded.entry.sourcePath, loaded]));
  const perSource = [...manifest.entries]
    .sort((left, right) => compareText(left.sourcePath, right.sourcePath))
    .map((entry) => validateLoadedSource(
      sourceByPath.get(entry.sourcePath) ?? {
        entry,
        source: null,
        loadError: 'Manifest entry has no loaded source result',
      },
      options,
      scorer,
    ));

  const duplicateAnalysis = analyzeCatalogDuplicates(perSource.flatMap((source) => {
    if (!source.parseResult || !source.definition || !source.agentId) return [];
    const metadata = options.duplicateMetadataByPath?.[source.sourcePath];
    return [{
      sourcePath: source.sourcePath,
      agentId: source.agentId,
      agentName: source.agentName,
      parseResult: source.parseResult,
      catalogOutcome: metadata?.catalogOutcome,
      resolutionReason: metadata?.resolutionReason,
      duplicateGroupId: metadata?.duplicateGroupId,
    }];
  }));

  for (const source of perSource) {
    source.duplicateRelationships = duplicateAnalysis.relationshipsBySource[source.sourcePath]
      ?? Object.freeze([]);
    for (const relationship of source.duplicateRelationships) {
      source.findings.push(finding(
        relationship.code,
        source.sourcePath,
        'duplicate',
        relationship.classification,
        `${relationship.resolutionReason}; related source: ${relationship.relatedSourcePath}`,
      ));
    }
    source.passed = source.basePassed
      && !source.duplicateRelationships.some(
        (relationship) => relationship.classification === 'blocking',
      );

    const declaredOverall = options.aggregateStatuses?.bySourcePath?.[source.sourcePath]?.overall;
    if (declaredOverall !== undefined && declaredOverall !== source.passed) {
      source.aggregateStatusDiscrepancies.push(aggregateDiscrepancy(
        source.sourcePath,
        'overall',
        source.passed,
        declaredOverall,
      ));
    }
    for (const discrepancy of source.aggregateStatusDiscrepancies) {
      source.findings.push(finding(
        discrepancy.code,
        source.sourcePath,
        'quality',
        'informational',
        discrepancy.message,
      ));
    }
  }

  const workflowCatalog = validateWorkflowCatalog(perSource);
  const catalogFindings: CatalogQualityFinding[] = [];
  for (const count of Object.values(workflowCatalog.counts)) {
    if (!count.passed) {
      catalogFindings.push(finding(
        `WORKFLOW_CATALOG_${count.criterion.replace(/([A-Z])/g, '_$1').toUpperCase()}`,
        null,
        'catalog',
        'blocking',
        `${count.criterion} requires at least ${count.minimum} distinct pattern matches across the catalog; found ${count.actual}`,
      ));
    }
  }

  const catalogDiscrepancies: AggregateStatusDiscrepancy[] = perSource.flatMap(
    (source) => source.aggregateStatusDiscrepancies,
  );
  const declaredWorkflowStatus = options.aggregateStatuses?.workflowCatalog;
  if (declaredWorkflowStatus !== undefined && declaredWorkflowStatus !== workflowCatalog.passed) {
    const discrepancy = aggregateDiscrepancy(
      null,
      'workflowCatalog',
      workflowCatalog.passed,
      declaredWorkflowStatus,
    );
    catalogDiscrepancies.push(discrepancy);
    catalogFindings.push(finding(
      discrepancy.code,
      null,
      'catalog',
      'informational',
      discrepancy.message,
    ));
  }
  sortFindings(catalogFindings);
  catalogDiscrepancies.sort((left, right) => compareText(left.sourcePath ?? '', right.sourcePath ?? '')
    || compareText(left.scope, right.scope));

  const frozenSources = Object.freeze(perSource.map(freezeSource));
  return Object.freeze({
    rootPath: manifest.rootPath,
    discoveredCount: manifest.entries.length,
    processedCount: frozenSources.length,
    perSource: frozenSources,
    workflowCatalog,
    duplicateAnalysis,
    aggregateStatusDiscrepancies: Object.freeze(catalogDiscrepancies),
    catalogFindings: Object.freeze(catalogFindings),
    passed: workflowCatalog.passed && frozenSources.every((source) => source.passed),
  });
}

/**
 * Reads and validates every immutable manifest entry. Read failures are captured
 * per source and never reject or short-circuit validation of later entries.
 */
export async function validateCatalog(
  manifest: CatalogManifest,
  options: CatalogValidatorOptions = {},
): Promise<CatalogValidationResult> {
  const reader = options.readSource ?? ((entry: CatalogManifestEntry) => readFile(entry.absolutePath));
  const loadedSources = await Promise.all(manifest.entries.map(async (entry): Promise<LoadedCatalogSource> => {
    try {
      return Object.freeze({ entry, source: await reader(entry), loadError: null });
    } catch (error) {
      return Object.freeze({
        entry,
        source: null,
        loadError: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  return validateLoadedCatalog(manifest, loadedSources, options);
}
