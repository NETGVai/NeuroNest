/**
 * Harness Health Widget State Management.
 *
 * Pure functions for computing harness component status,
 * degradation messages, and scaffolding order.
 *
 * Validates: Requirements 30.1, 30.2, 30.3, 30.4
 */

import type {
  HarnessComponentId,
  HarnessComponentStatus,
  HarnessHealthState,
  ComponentStatus,
  ScaffoldAction,
} from './types';

// ─── Component Definitions ──────────────────────────────────────

/**
 * The 7 harness components in recommended scaffolding order.
 *
 * Scaffolding order per design:
 * NEURONEST.md → permission patterns → verifier → hooks → MCP → memory → progress hash
 */
export const HARNESS_COMPONENTS: ReadonlyArray<{
  id: HarnessComponentId;
  label: string;
  filePath: string;
  degradationMessage: string;
  scaffoldOrder: number;
}> = [
  {
    id: 'standing-context',
    label: 'Standing Context (NEURONEST.md)',
    filePath: 'NEURONEST.md',
    degradationMessage:
      'No standing context → agent lacks persistent project shape, conventions, and Never-touch constraints each pass',
    scaffoldOrder: 1,
  },
  {
    id: 'permission-pattern-engine',
    label: 'Permission Patterns (.neuronest/settings.json)',
    filePath: '.neuronest/settings.json',
    degradationMessage:
      'No permission patterns → every tool call prompts for approval, blocking unattended runs',
    scaffoldOrder: 2,
  },
  {
    id: 'verifier-subagent',
    label: 'Verifier Subagent (.neuronest/agents/verifier.md)',
    filePath: '.neuronest/agents/verifier.md',
    degradationMessage:
      'No verifier agent → verification runs in main context and always agrees with the maker',
    scaffoldOrder: 3,
  },
  {
    id: 'hooks',
    label: 'Deterministic Hooks (settings hooks config)',
    filePath: '.neuronest/settings.json#hooks',
    degradationMessage:
      'No hooks configured → no automatic formatting, linting, or iteration logging after each tool use',
    scaffoldOrder: 4,
  },
  {
    id: 'mcp-scoping',
    label: 'MCP Config (.mcp.json)',
    filePath: '.mcp.json',
    degradationMessage:
      'No MCP config → external tools use global config with no workspace-level scoping or write-call logging',
    scaffoldOrder: 5,
  },
  {
    id: 'memory-vault',
    label: 'Memory/Vault (.neuronest/memory/)',
    filePath: '.neuronest/memory/MEMORY.md',
    degradationMessage:
      'No memory vault → loop passes cannot re-read canonical project knowledge; context degrades with each pass',
    scaffoldOrder: 6,
  },
  {
    id: 'progress-hash',
    label: 'Progress Hash (PLAN.md)',
    filePath: '.neuronest/PLAN.md',
    degradationMessage:
      'No PLAN.md → stall detection disabled; loops may repeat identical work without terminating',
    scaffoldOrder: 7,
  },
];

// ─── State Computation ──────────────────────────────────────────

/**
 * Compute the full harness health state from a map of present/absent statuses.
 *
 * @param presentFiles - Set of file paths that currently exist in the workspace.
 */
export function computeHarnessHealthState(
  presentFiles: Set<string>,
): HarnessHealthState {
  const components: HarnessComponentStatus[] = HARNESS_COMPONENTS.map((def) => {
    const status: ComponentStatus = isComponentPresent(def.filePath, presentFiles)
      ? 'present'
      : 'absent';
    return {
      id: def.id,
      label: def.label,
      status,
      filePath: def.filePath,
      degradationMessage: def.degradationMessage,
      scaffoldOrder: def.scaffoldOrder,
    };
  });

  return {
    components,
    presentCount: components.filter((c) => c.status === 'present').length,
    absentCount: components.filter((c) => c.status === 'absent').length,
    isScaffolding: false,
  };
}

/**
 * Determine if a component is present based on its file path and the set of present files.
 *
 * Handles special cases:
 * - Paths with '#' fragment (e.g., '.neuronest/settings.json#hooks') check base file existence.
 * - Directory paths check for directory presence.
 */
export function isComponentPresent(filePath: string, presentFiles: Set<string>): boolean {
  // Handle fragment paths (e.g., '.neuronest/settings.json#hooks')
  const basePath = filePath.split('#')[0];
  return presentFiles.has(basePath);
}

/**
 * Get scaffolding actions for missing components in recommended order.
 *
 * Returns only absent components sorted by scaffold order.
 */
export function getScaffoldActions(state: HarnessHealthState): ScaffoldAction[] {
  return state.components
    .filter((c) => c.status === 'absent')
    .sort((a, b) => a.scaffoldOrder - b.scaffoldOrder)
    .map((c) => ({
      componentId: c.id,
      label: c.label,
      description: `Create ${c.filePath}`,
    }));
}

/**
 * Get the next component to scaffold (the one with lowest order that is absent).
 */
export function getNextScaffoldComponent(
  state: HarnessHealthState,
): HarnessComponentStatus | null {
  const absent = state.components
    .filter((c) => c.status === 'absent')
    .sort((a, b) => a.scaffoldOrder - b.scaffoldOrder);
  return absent[0] ?? null;
}

/**
 * Update a single component's status in the health state.
 */
export function updateComponentStatus(
  state: HarnessHealthState,
  componentId: HarnessComponentId,
  status: ComponentStatus,
): HarnessHealthState {
  const components = state.components.map((c) =>
    c.id === componentId ? { ...c, status } : c,
  );
  return {
    ...state,
    components,
    presentCount: components.filter((c) => c.status === 'present').length,
    absentCount: components.filter((c) => c.status === 'absent').length,
  };
}

/**
 * Mark the widget as scaffolding (or done scaffolding).
 */
export function setScaffolding(
  state: HarnessHealthState,
  isScaffolding: boolean,
): HarnessHealthState {
  return { ...state, isScaffolding };
}

/**
 * Get the health score as a percentage (0-100).
 */
export function getHealthScore(state: HarnessHealthState): number {
  const total = state.components.length;
  if (total === 0) return 100;
  return Math.round((state.presentCount / total) * 100);
}
