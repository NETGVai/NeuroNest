import type { AgentDefinition } from '../agents/agent-registry';
import type { AgentFileParseResult, ParseStatus } from './agent-file-parser';
import type { ImportedAgent } from './types';

export type AgentSnapshot = Readonly<AgentDefinition>;

export interface StaticAgentSnapshot {
  readonly snapshotKey: string;
  readonly definition: AgentSnapshot;
}

export type ImportCatalogOutcome = 'retained' | 'skipped-duplicate-id';

export interface ImportCandidateRef {
  readonly candidateKey: string;
  readonly sourcePath: string;
  readonly division: string;
  readonly definition: AgentSnapshot;
  readonly rawFrontmatter: Readonly<Record<string, string>>;
  readonly parseEvidence: AgentFileParseResult | null;
  readonly parseStatus: ParseStatus | null;
  readonly effectiveAgentId: string;
  readonly duplicateGroupId: string | null;
  readonly catalogOutcome: ImportCatalogOutcome;
}

export interface SourceAgentRef {
  readonly candidateKey: string;
  readonly sourcePath: string;
  readonly agentId: string;
  readonly effectiveAgentId: string;
  readonly duplicateGroupId: string | null;
  readonly catalogOutcome: ImportCatalogOutcome;
}

export interface SkippedDuplicateIdRef {
  readonly candidateKey: string;
  readonly sourcePath: string;
  readonly agentId: string;
  readonly effectiveAgentId: string;
  readonly duplicateGroupId: string;
  readonly reason: 'duplicate-agent-id';
}

export interface DuplicateGroupMember {
  readonly memberKey: string;
  readonly kind: 'static' | 'import-candidate';
  readonly agentId: string;
  readonly sourcePath: string | null;
  readonly catalogOutcome: 'retained' | 'skipped-duplicate-id';
}

export interface DuplicateGroup {
  readonly duplicateGroupId: string;
  readonly agentId: string;
  readonly effectiveAgentId: string;
  readonly members: readonly DuplicateGroupMember[];
}

export interface EffectiveAgentRef {
  readonly agentId: string;
  readonly definition: AgentSnapshot;
  readonly origin: 'static' | 'imported' | 'retained-static' | 'retained-import';
  readonly retainedMemberKey: string;
  readonly sourcePaths: readonly string[];
  readonly duplicateGroupId: string | null;
}

export interface StaticRegistrySnapshot {
  readonly agents: readonly StaticAgentSnapshot[];
}

export interface ImportCandidateSnapshot {
  readonly candidates: readonly ImportCandidateRef[];
}

export interface AgentPopulationManifest {
  readonly discoveredSources: readonly SourceAgentRef[];
  readonly importCandidates: readonly ImportCandidateRef[];
  readonly staticAgents: readonly StaticAgentSnapshot[];
  readonly skippedDuplicateIds: readonly SkippedDuplicateIdRef[];
  readonly effectiveAgents: readonly EffectiveAgentRef[];
  readonly effectiveAgentIds: readonly string[];
  readonly duplicateGroups: readonly DuplicateGroup[];
}

interface CandidateDraft {
  readonly candidateKey: string;
  readonly sourcePath: string;
  readonly division: string;
  readonly definition: AgentSnapshot;
  readonly rawFrontmatter: Readonly<Record<string, string>>;
  readonly parseEvidence: AgentFileParseResult | null;
  readonly parseStatus: ParseStatus | null;
}

function canonicalSourcePath(sourcePath: string): string {
  return sourcePath.replace(/\\/g, '/');
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const seen = new WeakSet<object>();

  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object') return;
    if (ArrayBuffer.isView(candidate)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);

    for (const nested of Object.values(candidate)) freeze(nested);
    Object.freeze(candidate);
  };

  freeze(cloned);
  return cloned;
}

function snapshotDefinition(definition: AgentDefinition): AgentSnapshot {
  return cloneAndFreeze(definition);
}

function staticSortKey(agent: AgentSnapshot): string {
  return [agent.id, agent.name, agent.department, agent.specialty, agent.systemPrompt].join('\u0000');
}

/** Captures the complete static registry before any imported definition can mutate it. */
export function createStaticRegistrySnapshot(
  agents: readonly AgentDefinition[],
): StaticRegistrySnapshot {
  const sorted = agents
    .map(snapshotDefinition)
    .sort((left, right) => compareText(staticSortKey(left), staticSortKey(right)));
  const snapshots = sorted.map((definition, index) => Object.freeze({
    snapshotKey: `static:${definition.id}:${index}`,
    definition,
  }));
  return Object.freeze({ agents: Object.freeze(snapshots) });
}

function createCandidateDrafts(imported: readonly ImportedAgent[]): readonly CandidateDraft[] {
  const sorted = imported
    .map((candidate) => ({
      sourcePath: canonicalSourcePath(candidate.sourceFile),
      division: candidate.division,
      definition: snapshotDefinition(candidate.definition),
      rawFrontmatter: cloneAndFreeze(candidate.rawFrontmatter),
      parseEvidence: candidate.parseEvidence ? cloneAndFreeze(candidate.parseEvidence) : null,
      parseStatus: candidate.parseEvidence?.status ?? null,
    }))
    .sort((left, right) => (
      compareText(left.sourcePath, right.sourcePath)
      || compareText(left.definition.id, right.definition.id)
      || compareText(left.definition.name, right.definition.name)
    ));

  return Object.freeze(sorted.map((candidate, index) => Object.freeze({
    ...candidate,
    candidateKey: `import:${candidate.sourcePath}:${candidate.definition.id}:${index}`,
  })));
}

function duplicateGroupId(agentId: string): string {
  return `duplicate-id:${encodeURIComponent(agentId)}`;
}

/**
 * Builds the immutable source/static/effective population before registry mutation.
 * Duplicate-ID candidates remain in importCandidates and discoveredSources even
 * when only one definition can become the effective registry identity.
 */
export function createAgentPopulationManifest(
  staticAgents: readonly AgentDefinition[],
  imported: readonly ImportedAgent[],
): AgentPopulationManifest {
  const staticSnapshot = createStaticRegistrySnapshot(staticAgents);
  const candidateDrafts = createCandidateDrafts(imported);
  const staticById = new Map<string, StaticAgentSnapshot[]>();
  const importsById = new Map<string, CandidateDraft[]>();

  for (const agent of staticSnapshot.agents) {
    const bucket = staticById.get(agent.definition.id) ?? [];
    bucket.push(agent);
    staticById.set(agent.definition.id, bucket);
  }
  for (const candidate of candidateDrafts) {
    const bucket = importsById.get(candidate.definition.id) ?? [];
    bucket.push(candidate);
    importsById.set(candidate.definition.id, bucket);
  }

  const allIds = Array.from(new Set([...staticById.keys(), ...importsById.keys()])).sort(compareText);
  const importCandidates: ImportCandidateRef[] = [];
  const discoveredSources: SourceAgentRef[] = [];
  const skippedDuplicateIds: SkippedDuplicateIdRef[] = [];
  const effectiveAgents: EffectiveAgentRef[] = [];
  const duplicateGroups: DuplicateGroup[] = [];

  for (const agentId of allIds) {
    const staticMembers = staticById.get(agentId) ?? [];
    const importMembers = importsById.get(agentId) ?? [];
    const memberCount = staticMembers.length + importMembers.length;
    const groupId = memberCount > 1 ? duplicateGroupId(agentId) : null;
    const retainedStatic = staticMembers[0];
    const retainedImport = retainedStatic ? undefined : importMembers[0];
    const retainedDefinition = retainedStatic?.definition ?? retainedImport?.definition;
    const retainedMemberKey = retainedStatic?.snapshotKey ?? retainedImport?.candidateKey;

    if (!retainedDefinition || !retainedMemberKey) continue;

    const sourcePaths = Object.freeze(Array.from(new Set(
      importMembers.map((candidate) => candidate.sourcePath),
    )).sort(compareText));
    effectiveAgents.push(Object.freeze({
      agentId,
      definition: retainedDefinition,
      origin: retainedStatic
        ? importMembers.length > 0 || staticMembers.length > 1 ? 'retained-static' : 'static'
        : importMembers.length > 1 ? 'retained-import' : 'imported',
      retainedMemberKey,
      sourcePaths,
      duplicateGroupId: groupId,
    }));

    const groupMembers: DuplicateGroupMember[] = staticMembers.map((member, index) => Object.freeze({
      memberKey: member.snapshotKey,
      kind: 'static' as const,
      agentId,
      sourcePath: null,
      catalogOutcome: index === 0 ? 'retained' as const : 'skipped-duplicate-id' as const,
    }));

    importMembers.forEach((candidate, index) => {
      const retained = !retainedStatic && index === 0;
      const catalogOutcome: ImportCatalogOutcome = retained ? 'retained' : 'skipped-duplicate-id';
      const ref: ImportCandidateRef = Object.freeze({
        ...candidate,
        effectiveAgentId: agentId,
        duplicateGroupId: groupId,
        catalogOutcome,
      });
      importCandidates.push(ref);
      discoveredSources.push(Object.freeze({
        candidateKey: candidate.candidateKey,
        sourcePath: candidate.sourcePath,
        agentId,
        effectiveAgentId: agentId,
        duplicateGroupId: groupId,
        catalogOutcome,
      }));
      groupMembers.push(Object.freeze({
        memberKey: candidate.candidateKey,
        kind: 'import-candidate',
        agentId,
        sourcePath: candidate.sourcePath,
        catalogOutcome,
      }));

      if (!retained) {
        skippedDuplicateIds.push(Object.freeze({
          candidateKey: candidate.candidateKey,
          sourcePath: candidate.sourcePath,
          agentId,
          effectiveAgentId: agentId,
          duplicateGroupId: groupId!,
          reason: 'duplicate-agent-id',
        }));
      }
    });

    if (groupId) {
      duplicateGroups.push(Object.freeze({
        duplicateGroupId: groupId,
        agentId,
        effectiveAgentId: agentId,
        members: Object.freeze(groupMembers),
      }));
    }
  }

  importCandidates.sort((left, right) => compareText(left.candidateKey, right.candidateKey));
  discoveredSources.sort((left, right) => compareText(left.candidateKey, right.candidateKey));
  skippedDuplicateIds.sort((left, right) => compareText(left.candidateKey, right.candidateKey));

  return Object.freeze({
    discoveredSources: Object.freeze(discoveredSources),
    importCandidates: Object.freeze(importCandidates),
    staticAgents: staticSnapshot.agents,
    skippedDuplicateIds: Object.freeze(skippedDuplicateIds),
    effectiveAgents: Object.freeze(effectiveAgents),
    effectiveAgentIds: Object.freeze(effectiveAgents.map((agent) => agent.agentId)),
    duplicateGroups: Object.freeze(duplicateGroups),
  });
}

/** Alias emphasizing that this capture must happen immediately before registry import. */
export const createRegistryImportSnapshot = createAgentPopulationManifest;

/** Returns the independently frozen candidate namespace from a population capture. */
export function createImportCandidateSnapshot(
  staticAgents: readonly AgentDefinition[],
  imported: readonly ImportedAgent[],
): ImportCandidateSnapshot {
  const population = createAgentPopulationManifest(staticAgents, imported);
  return Object.freeze({ candidates: population.importCandidates });
}
