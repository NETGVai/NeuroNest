/**
 * Plan Mode Tools — `enter_plan_mode` and `exit_plan_mode` tool definitions.
 *
 * Registered through ToolSystem.register() (Req 11.4).
 * Entry requires user approval via existing approval flow (Req 11.5).
 * Exit presents action choices: implement, send-to-loop, revise, discard (Req 11.6).
 * Entry refused while Loop Engine is active (Req 11.9).
 * Plan Mode begins inactive when a Loop run launches from a plan (Req 11.10).
 * Subagent dispatch refused while Plan Mode is active (Req 11.11).
 *
 * Requirements: 11.4, 11.5, 11.6, 11.9, 11.10, 11.11
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ExecutableToolDefinition } from '../tool-system.js';
import type { PlanModeState } from '../../session/plan-mode-state.js';

// ─── Dependency Interfaces ──────────────────────────────────────

/**
 * Interface for checking whether a Loop Engine run is currently active.
 * The concrete implementation is injected at wiring time.
 */
export interface LoopActiveChecker {
  isLoopActive(sessionId: string): boolean;
}

/**
 * Dependencies required by plan mode tools.
 */
export interface PlanModeToolDeps {
  /** Session-scoped Plan Mode state */
  planModeState: PlanModeState;
  /** Checker for Loop Engine active state */
  loopActiveChecker: LoopActiveChecker;
}

// ─── Input Interfaces ───────────────────────────────────────────

export interface EnterPlanModeInput {
  planFilePath: string;
}

export type ExitPlanModeAction = 'implement' | 'send-to-loop' | 'revise' | 'discard';

export interface ExitPlanModeInput {
  action: ExitPlanModeAction;
}

// ─── Constants ──────────────────────────────────────────────────

const VALID_EXIT_ACTIONS: readonly ExitPlanModeAction[] = [
  'implement',
  'send-to-loop',
  'revise',
  'discard',
];

// ─── enter_plan_mode execute ────────────────────────────────────

/**
 * Creates the execute function for `enter_plan_mode`.
 *
 * Behavior:
 * - Validates input (planFilePath required, non-empty string)
 * - Refuses entry if Loop Engine is active (Req 11.9)
 * - Refuses entry if already in Plan Mode
 * - Requires user approval via existing approvalHandler (Req 11.5)
 * - Activates PlanModeState on approval
 */
export function createEnterPlanModeExecute(
  deps: PlanModeToolDeps,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  const { planModeState, loopActiveChecker } = deps;

  return async (input: unknown, context: ToolContext): Promise<ToolResult> => {
    // Parse input
    const parsed = input as Record<string, unknown> | null | undefined;
    if (!parsed || typeof parsed !== 'object') {
      return {
        success: false,
        output: null,
        error: 'Invalid input: expected an object with planFilePath',
      };
    }

    const planFilePath = parsed.planFilePath;
    if (!planFilePath || typeof planFilePath !== 'string' || planFilePath.trim() === '') {
      return {
        success: false,
        output: null,
        error: 'Missing required parameter: planFilePath (non-empty string)',
      };
    }

    // Refuse entry if already in Plan Mode
    if (planModeState.isActive()) {
      return {
        success: false,
        output: null,
        error: 'Plan Mode is already active. Exit the current plan before entering a new one.',
      };
    }

    // Refuse entry while Loop Engine is active (Req 11.9)
    if (loopActiveChecker.isLoopActive(context.sessionId)) {
      return {
        success: false,
        output: null,
        error: 'Cannot enter Plan Mode while a Loop Engine run is active. Finish or stop the current run first.',
      };
    }

    // Require user approval via existing approval flow (Req 11.5)
    if (context.approvalHandler) {
      const approved = await context.approvalHandler(
        `enter_plan_mode: activate Plan Mode with plan file "${planFilePath}"`,
      );
      if (!approved) {
        return {
          success: false,
          output: null,
          error: 'Plan Mode entry rejected by user.',
        };
      }
    } else if (context.permissionMode !== 'auto-approve') {
      // No approval handler and not auto-approve — deny
      return {
        success: false,
        output: null,
        error: 'Plan Mode entry requires user approval, but no approval handler is available.',
      };
    }

    // Activate Plan Mode
    try {
      planModeState.activate(planFilePath.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: null,
        error: `Failed to activate Plan Mode: ${message}`,
      };
    }

    return {
      success: true,
      output: {
        active: true,
        planFilePath: planModeState.getPlanFilePath(),
        message: 'Plan Mode activated. Only the plan file may be edited.',
      },
    };
  };
}

// ─── exit_plan_mode execute ─────────────────────────────────────

/**
 * Creates the execute function for `exit_plan_mode`.
 *
 * Behavior:
 * - Validates input (action required, must be one of valid actions)
 * - Refuses exit if Plan Mode is not active
 * - Deactivates PlanModeState
 * - Returns the chosen action for the caller to act upon (Req 11.6)
 */
export function createExitPlanModeExecute(
  deps: PlanModeToolDeps,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  const { planModeState } = deps;

  return async (input: unknown, _context: ToolContext): Promise<ToolResult> => {
    // Parse input
    const parsed = input as Record<string, unknown> | null | undefined;
    if (!parsed || typeof parsed !== 'object') {
      return {
        success: false,
        output: null,
        error: 'Invalid input: expected an object with action',
      };
    }

    const action = parsed.action;
    if (!action || typeof action !== 'string') {
      return {
        success: false,
        output: null,
        error: `Missing required parameter: action. Valid values: ${VALID_EXIT_ACTIONS.join(', ')}`,
      };
    }

    if (!VALID_EXIT_ACTIONS.includes(action as ExitPlanModeAction)) {
      return {
        success: false,
        output: null,
        error: `Invalid action: "${action}". Valid values: ${VALID_EXIT_ACTIONS.join(', ')}`,
      };
    }

    // Refuse exit if Plan Mode is not active
    if (!planModeState.isActive()) {
      return {
        success: false,
        output: null,
        error: 'Plan Mode is not active. Nothing to exit.',
      };
    }

    const planFilePath = planModeState.getPlanFilePath();

    // Deactivate Plan Mode
    planModeState.deactivate();

    return {
      success: true,
      output: {
        active: false,
        action: action as ExitPlanModeAction,
        planFilePath,
        message: `Plan Mode deactivated. Action: ${action}`,
      },
    };
  };
}

// ─── Subagent dispatch guard (Req 11.11) ────────────────────────

/**
 * Check whether subagent dispatch should be refused.
 * While Plan Mode is active, the Swarm Orchestrator SHALL refuse subagent dispatch.
 *
 * This is exported as a utility for the Swarm Orchestrator to call before dispatching.
 */
export function isPlanModeBlockingDispatch(planModeState: PlanModeState): boolean {
  return planModeState.isActive();
}

// ─── Tool Definitions ───────────────────────────────────────────

export const EnterPlanModeTool: Omit<ExecutableToolDefinition, 'execute'> = {
  id: 'enter_plan_mode',
  name: 'EnterPlanMode',
  description:
    'Enter Plan Mode — restricts all mutations to a single plan file. Requires user approval. Cannot be activated while a Loop Engine run is active.',
  inputSchema: {
    type: 'object',
    properties: {
      planFilePath: {
        type: 'string',
        description: 'Absolute path to the plan file that may be edited during Plan Mode',
      },
    },
    required: ['planFilePath'],
  },
  riskLevel: 'write',
};

export const ExitPlanModeTool: Omit<ExecutableToolDefinition, 'execute'> = {
  id: 'exit_plan_mode',
  name: 'ExitPlanMode',
  description:
    'Exit Plan Mode — deactivates write restriction and returns the chosen action (implement, send-to-loop, revise, discard).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['implement', 'send-to-loop', 'revise', 'discard'],
        description: 'Action to take after exiting Plan Mode',
      },
    },
    required: ['action'],
  },
  riskLevel: 'write',
};

// ─── Registration Function ──────────────────────────────────────

/**
 * Registers the Plan Mode tools with the ToolSystem.
 *
 * @param deps - PlanModeToolDeps containing planModeState and loopActiveChecker
 * @param toolSystem - The ToolSystem instance to register tools with
 */
export function registerPlanModeTools(
  deps: PlanModeToolDeps,
  toolSystem: { register(tool: ExecutableToolDefinition): void },
): void {
  const enterExecute = createEnterPlanModeExecute(deps);
  const exitExecute = createExitPlanModeExecute(deps);

  toolSystem.register({ ...EnterPlanModeTool, execute: enterExecute } as ExecutableToolDefinition);
  toolSystem.register({ ...ExitPlanModeTool, execute: exitExecute } as ExecutableToolDefinition);
}
