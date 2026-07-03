/**
 * Spec document persistence service.
 *
 * Handles persisting spec documents (spec.md, plan.md, tasks.md) to the
 * project's `.neuronest/specs/<workflow-id>/` directory via IPC to the main process.
 *
 * Validates: Requirements 9.6, 10.6, 11.8
 */

import { ipcInvokeSafe } from './ipc-client';

/** IPC channel for spec persistence. */
const IPC_PERSIST_CHANNEL = 'spec:persist';

/** Message payload sent to the main process for file persistence. */
export interface SpecPersistMessage {
  type: 'spec:persist';
  payload: {
    workflowId: string;
    directory: string;
    files: Array<{ name: string; content: string }>;
  };
}

/** Documents to persist during spec workflow. */
export interface SpecDocuments {
  specDocument: string | null;
  implementationPlan: string | null;
  taskList: string | null;
}

/**
 * Persist spec documents to the project's spec directory via IPC.
 *
 * Sends a structured message to the main process requesting file writes to:
 *   `.neuronest/specs/<workflowId>/spec.md`
 *   `.neuronest/specs/<workflowId>/plan.md`
 *   `.neuronest/specs/<workflowId>/tasks.md`
 *
 * Only includes documents that have non-null content.
 *
 * @param workflowId - The workflow identifier used as the subdirectory name
 * @param documents - The accumulated spec documents to persist
 * @returns A promise that resolves to `true` on success, `false` on failure
 */
export async function persistSpecDocuments(
  workflowId: string,
  documents: SpecDocuments,
): Promise<boolean> {
  const files: Array<{ name: string; content: string }> = [];

  if (documents.specDocument != null) {
    files.push({ name: 'spec.md', content: documents.specDocument });
  }
  if (documents.implementationPlan != null) {
    files.push({ name: 'plan.md', content: documents.implementationPlan });
  }
  if (documents.taskList != null) {
    files.push({ name: 'tasks.md', content: documents.taskList });
  }

  if (files.length === 0) {
    return true; // Nothing to persist
  }

  const directory = `.neuronest/specs/${workflowId}`;

  const message: SpecPersistMessage = {
    type: 'spec:persist',
    payload: {
      workflowId,
      directory,
      files,
    },
  };

  const result = await ipcInvokeSafe(IPC_PERSIST_CHANNEL, message);

  if (!result.success) {
    console.error(`[spec-persistence] Failed to persist documents for workflow ${workflowId}:`, result.error);
    return false;
  }

  return true;
}
