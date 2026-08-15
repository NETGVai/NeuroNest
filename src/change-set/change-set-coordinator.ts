/**
 * ChangeSetCoordinator — the only path from agent-originated proposed mutations
 * to accepted workspace mutations.
 *
 * Every agent file create, modify, rename, move, or delete flows through this
 * coordinator. It:
 * - Creates versioned Change_Sets before acceptance
 * - Maintains shadow preview models for immutable review
 * - Prevents cross-URI application
 * - Keeps multiple queued proposals separate unless explicitly consolidated
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.8, 5.9
 */

import { ChangeSetService } from './change-set-service';
import { ShadowModelService } from './shadow-model-service';
import type {
  ChangeSet,
  CreateChangeSetParams,
  FileOperation,
  RiskLevel,
} from './types';
import type { ShadowModel } from './shadow-model-service';

/**
 * Parameters for proposing a file operation through the coordinator.
 */
export interface ProposeOperationParams {
  /** The Change_Set to add the operation to (creates one if not provided). */
  changeSetId?: string;
  /** The file operation to propose. */
  operation: FileOperation;
  /** Base content for preview (null for create). */
  baseContent?: string | null;
  /** Language identifier for syntax highlighting in preview. */
  languageId?: string;
}

/**
 * Parameters for creating a new proposal (Change_Set + initial operations).
 */
export interface CreateProposalParams extends CreateChangeSetParams {
  /** Base content for each file (keyed by URI) for preview. */
  baseContents?: Record<string, string | null>;
  /** Language identifiers for preview (keyed by URI). */
  languageIds?: Record<string, string>;
}

/**
 * Result of a consolidation operation.
 */
export interface ConsolidationResult {
  /** The new consolidated Change_Set. */
  changeSet: ChangeSet;
  /** Shadow models created for the consolidated Change_Set. */
  shadowModels: ShadowModel[];
  /** IDs of the source Change_Sets that were consolidated. */
  sourceIds: string[];
}

/**
 * ChangeSetCoordinator is the single entry point for routing agent mutations
 * through Change_Sets with shadow-model previews.
 */
export class ChangeSetCoordinator {
  private readonly changeSetService: ChangeSetService;
  private readonly shadowModelService: ShadowModelService;

  constructor(
    changeSetService?: ChangeSetService,
    shadowModelService?: ShadowModelService
  ) {
    this.changeSetService = changeSetService ?? new ChangeSetService();
    this.shadowModelService = shadowModelService ?? new ShadowModelService();
  }

  /**
   * Creates a new proposal (Change_Set) with optional initial operations
   * and shadow models for preview.
   */
  createProposal(params: CreateProposalParams): {
    changeSet: ChangeSet;
    shadowModels: ShadowModel[];
  } {
    const changeSet = this.changeSetService.create(params);
    const shadowModels: ShadowModel[] = [];

    // Create shadow models for each operation
    for (const op of changeSet.operations) {
      const uri = this.getOperationTargetUri(op);
      const baseContent = params.baseContents?.[uri] ?? null;
      const proposedContent = this.getOperationProposedContent(op);
      const languageId = params.languageIds?.[uri];

      const shadow = this.shadowModelService.create({
        changeSetId: changeSet.id,
        originalUri: uri,
        baseContent,
        proposedContent,
        languageId,
      });
      shadowModels.push(shadow);
    }

    return { changeSet, shadowModels };
  }

  /**
   * Proposes a single file operation into an existing or new Change_Set.
   * Creates a shadow model for immutable preview.
   */
  proposeOperation(
    params: ProposeOperationParams & { createParams?: CreateChangeSetParams }
  ): { changeSet: ChangeSet; shadowModel: ShadowModel } {
    let changeSet: ChangeSet;

    if (params.changeSetId) {
      changeSet = this.changeSetService.addOperation(
        params.changeSetId,
        params.operation
      );
    } else if (params.createParams) {
      changeSet = this.changeSetService.create(params.createParams);
      changeSet = this.changeSetService.addOperation(changeSet.id, params.operation);
    } else {
      throw new Error(
        'Either changeSetId or createParams must be provided to propose an operation'
      );
    }

    // Create shadow model for preview
    const uri = this.getOperationTargetUri(params.operation);
    const proposedContent = this.getOperationProposedContent(params.operation);

    const shadowModel = this.shadowModelService.create({
      changeSetId: changeSet.id,
      originalUri: uri,
      baseContent: params.baseContent ?? null,
      proposedContent,
      languageId: params.languageId,
    });

    return { changeSet, shadowModel };
  }

  /**
   * Retrieves a Change_Set by ID.
   */
  getChangeSet(id: string): ChangeSet | undefined {
    return this.changeSetService.get(id);
  }

  /**
   * Lists all queued (non-terminal) Change_Sets for a workspace.
   * Queued proposals are kept separate.
   */
  listQueuedProposals(workspaceId: string): ChangeSet[] {
    return this.changeSetService
      .listByWorkspace(workspaceId)
      .filter((cs) => !this.changeSetService.isTerminal(cs.id));
  }

  /**
   * Lists all Change_Sets for a workspace, including terminal ones.
   */
  listAllProposals(workspaceId: string): ChangeSet[] {
    return this.changeSetService.listByWorkspace(workspaceId);
  }

  /**
   * Consolidates multiple queued Change_Sets into one new Change_Set.
   * Only allowed when the user explicitly requests it.
   * Source Change_Sets are rejected after consolidation.
   */
  consolidate(
    changeSetIds: string[],
    params: Omit<CreateChangeSetParams, 'operations'>,
    baseContents?: Record<string, string | null>,
    languageIds?: Record<string, string>
  ): ConsolidationResult {
    if (changeSetIds.length < 2) {
      throw new Error('Consolidation requires at least two Change_Sets');
    }

    // Gather all operations from source Change_Sets
    const allOperations: FileOperation[] = [];
    for (const id of changeSetIds) {
      const cs = this.changeSetService.get(id);
      if (!cs) {
        throw new Error(`Change_Set ${id} not found`);
      }
      if (this.changeSetService.isTerminal(cs.id)) {
        throw new Error(
          `Cannot consolidate terminal Change_Set ${id} (state: ${cs.state})`
        );
      }
      allOperations.push(...cs.operations);
    }

    // Create the consolidated Change_Set
    const consolidated = this.changeSetService.create({
      ...params,
      operations: allOperations,
    });

    // Create shadow models for the consolidated Change_Set
    const shadowModels: ShadowModel[] = [];
    for (const op of consolidated.operations) {
      const uri = this.getOperationTargetUri(op);
      const proposedContent = this.getOperationProposedContent(op);

      const shadow = this.shadowModelService.create({
        changeSetId: consolidated.id,
        originalUri: uri,
        baseContent: baseContents?.[uri] ?? null,
        proposedContent,
        languageId: languageIds?.[uri],
      });
      shadowModels.push(shadow);
    }

    // Reject source Change_Sets and dispose their shadow models
    for (const id of changeSetIds) {
      const cs = this.changeSetService.get(id)!;
      // Transition through valid paths to rejected
      if (cs.state === 'streaming') {
        this.changeSetService.transition(id, 'ready');
        this.changeSetService.transition(id, 'rejected');
      } else if (cs.state === 'incomplete') {
        this.changeSetService.transition(id, 'rejected');
      } else if (cs.state === 'ready') {
        this.changeSetService.transition(id, 'rejected');
      } else if (cs.state === 'reviewing') {
        this.changeSetService.transition(id, 'rejected');
      } else if (cs.state === 'conflicted') {
        this.changeSetService.transition(id, 'rejected');
      }
      this.shadowModelService.disposeByChangeSet(id);
    }

    return {
      changeSet: consolidated,
      shadowModels,
      sourceIds: changeSetIds,
    };
  }

  /**
   * Gets all shadow models for a Change_Set.
   */
  getShadowModels(changeSetId: string): ShadowModel[] {
    return this.shadowModelService.listByChangeSet(changeSetId);
  }

  /**
   * Asserts that a URI is not a shadow model URI (prevents writes to previews).
   */
  assertNotShadowModel(uri: string): void {
    this.shadowModelService.assertNotWritable(uri);
  }

  /**
   * Disposes shadow models when a Change_Set reaches a terminal state.
   */
  disposePreview(changeSetId: string): number {
    return this.shadowModelService.disposeByChangeSet(changeSetId);
  }

  /**
   * Provides access to the underlying ChangeSetService for state transitions
   * and validation (used by ChangeTransactionService).
   */
  get service(): ChangeSetService {
    return this.changeSetService;
  }

  /**
   * Provides access to the ShadowModelService.
   */
  get shadows(): ShadowModelService {
    return this.shadowModelService;
  }

  /**
   * Gets the primary target URI from a file operation.
   */
  private getOperationTargetUri(op: FileOperation): string {
    return op.targetUri;
  }

  /**
   * Gets the proposed content from a file operation.
   */
  private getOperationProposedContent(op: FileOperation): string | null {
    switch (op.kind) {
      case 'create':
        return op.proposedBlob;
      case 'modify':
        return op.proposedBlob;
      case 'rename':
      case 'move':
      case 'delete':
        return null;
    }
  }
}
