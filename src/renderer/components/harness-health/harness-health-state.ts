/**
 * Pure state logic for the Harness Health widget.
 * Tracks which harness components are present in the workspace
 * and provides scaffold actions to fill gaps.
 *
 * Requirements: 30.1, 30.2, 30.3, 30.4
 */

// ─── Types ──────────────────────────────────────────────────────

export type ComponentStatus = 'present' | 'absent';

export interface HarnessComponentDef {
  id: string;
  label: string;
  scaffoldOrder: number;
  filePath: string;
  degradationMessage: string;
}

export interface ComponentState {
  id: string;
  label: string;
  scaffoldOrder: number;
  filePath: string;
  degradationMessage: string;
  status: ComponentStatus;
}

export interface HarnessHealthState {
  components: ComponentState[];
  presentCount: number;
  absentCount: number;
  isScaffolding: boolean;
}

export interface ScaffoldAction {
  componentId: string;
  label: string;
  scaffoldOrder: number;
  filePath: string;
}

// ─── Component Registry ─────────────────────────────────────────

export const HARNESS_COMPONENTS: HarnessComponentDef[] = [
  {
    id: 'standing-context',
    label: 'Standing Context (NEURONEST.md)',
    scaffoldOrder: 1,
    filePath: 'NEURONEST.md',
    degradationMessage: 'Without NEURONEST.md, the agent lacks persistent project context across sessions.',
  },
  {
    id: 'permission-pattern-engine',
    label: 'Permission Pattern Engine',
    scaffoldOrder: 2,
    filePath: '.neuronest/settings.json',
    degradationMessage: 'Without permission patterns, the agent cannot enforce tool-level access control policies.',
  },
  {
    id: 'verifier-subagent',
    label: 'Verifier Sub-agent',
    scaffoldOrder: 3,
    filePath: '.neuronest/agents/verifier.md',
    degradationMessage: 'Without the verifier sub-agent, loop verification relies on basic check evaluation only.',
  },
  {
    id: 'hooks',
    label: 'Hook Engine',
    scaffoldOrder: 4,
    filePath: '.neuronest/settings.json#hooks',
    degradationMessage: 'Without hooks configured, pre/post tool-use automation is unavailable.',
  },
  {
    id: 'mcp-scoping',
    label: 'MCP Scoping',
    scaffoldOrder: 5,
    filePath: '.mcp.json',
    degradationMessage: 'Without MCP scoping, external tool servers operate without scope constraints.',
  },
  {
    id: 'memory-vault',
    label: 'Memory Vault',
    scaffoldOrder: 6,
    filePath: '.neuronest/memory/MEMORY.md',
    degradationMessage: 'Without the memory vault, cross-session learnings and context are not persisted.',
  },
  {
    id: 'progress-hash',
    label: 'Progress Hash (Plan)',
    scaffoldOrder: 7,
    filePath: '.neuronest/PLAN.md',
    degradationMessage: 'Without a plan file, progress hashing cannot detect stall conditions in loops.',
  },
];

// ─── Core Functions ─────────────────────────────────────────────

export function isComponentPresent(filePath: string, presentFiles: Set<string>): boolean {
  // Handle fragment paths (e.g. ".neuronest/settings.json#hooks")
  const base = filePath.split('#')[0];
  return presentFiles.has(base);
}

export function computeHarnessHealthState(presentFiles: Set<string>): HarnessHealthState {
  const components: ComponentState[] = HARNESS_COMPONENTS.map((def) => ({
    ...def,
    status: isComponentPresent(def.filePath, presentFiles) ? 'present' : 'absent',
  }));

  const presentCount = components.filter((c) => c.status === 'present').length;

  return {
    components,
    presentCount,
    absentCount: components.length - presentCount,
    isScaffolding: false,
  };
}

export function getScaffoldActions(state: HarnessHealthState): ScaffoldAction[] {
  return state.components
    .filter((c) => c.status === 'absent')
    .sort((a, b) => a.scaffoldOrder - b.scaffoldOrder)
    .map((c) => ({
      componentId: c.id,
      label: c.label,
      scaffoldOrder: c.scaffoldOrder,
      filePath: c.filePath,
    }));
}

export function getNextScaffoldComponent(state: HarnessHealthState): HarnessComponentDef | null {
  const absent = state.components
    .filter((c) => c.status === 'absent')
    .sort((a, b) => a.scaffoldOrder - b.scaffoldOrder);

  if (absent.length === 0) return null;

  const target = absent[0];
  return HARNESS_COMPONENTS.find((d) => d.id === target.id) ?? null;
}

export function updateComponentStatus(
  state: HarnessHealthState,
  componentId: string,
  status: ComponentStatus,
): HarnessHealthState {
  const components = state.components.map((c) =>
    c.id === componentId ? { ...c, status } : c,
  );
  const presentCount = components.filter((c) => c.status === 'present').length;

  return {
    ...state,
    components,
    presentCount,
    absentCount: components.length - presentCount,
  };
}

export function setScaffolding(state: HarnessHealthState, isScaffolding: boolean): HarnessHealthState {
  return { ...state, isScaffolding };
}

export function getHealthScore(state: HarnessHealthState): number {
  if (state.components.length === 0) return 0;
  return Math.round((state.presentCount / state.components.length) * 100);
}
