/**
 * Inert Structured Action Port
 *
 * A development-only implementation of the StructuredActionPort interface
 * that records action invocations without routing them to real authorities,
 * IPC channels, or network endpoints. Used exclusively by the response gallery
 * to prevent fixture actions from reaching production systems.
 *
 * Requirements: 17.2, 22.8, 22.11
 */

import type { CommandTransportReceiptV1 } from '../../harness/contracts/structured-command';
import type {
  DecideApprovalCommandInput,
  RetryResponseCommandInput,
  StructuredActionPort,
  SubmitFeedbackCommandInput,
} from './structured-action-port';

/**
 * Recorded action call for gallery inspection.
 */
export interface InertActionRecord {
  readonly method: keyof StructuredActionPort;
  readonly action: unknown;
  readonly payload: unknown;
  readonly timestamp: number;
}

/**
 * Inert action port configuration.
 */
export interface InertActionPortOptions {
  /** Maximum number of records retained. Defaults to 200. */
  readonly maxRecords?: number;
  /** Optional callback invoked on each action for debugging. */
  readonly onAction?: (record: InertActionRecord) => void;
}

/**
 * Generates a deterministic inert receipt without calling any authority.
 */
function createInertReceipt(method: string, index: number): CommandTransportReceiptV1 {
  return {
    schemaVersion: 1,
    commandId: `inert-cmd-${method}-${index}`,
    actionId: `inert-action-${method}-${index}`,
    receiptId: `inert-receipt-${method}-${index}`,
    transportStatus: 'delivered',
  };
}

/**
 * Development-only StructuredActionPort that captures all action invocations
 * without forwarding to real authorities. Actions are recorded for gallery
 * inspector display and assertions.
 *
 * This class MUST NOT be used in production code paths.
 */
export class InertStructuredActionPort implements StructuredActionPort {
  private readonly records: InertActionRecord[] = [];
  private readonly maxRecords: number;
  private readonly onAction: ((record: InertActionRecord) => void) | undefined;
  private callIndex = 0;

  constructor(options: InertActionPortOptions = {}) {
    this.maxRecords = options.maxRecords ?? 200;
    this.onAction = options.onAction;
  }

  /**
   * Returns all recorded action invocations in chronological order.
   */
  getRecords(): readonly InertActionRecord[] {
    return this.records;
  }

  /**
   * Clears all recorded actions.
   */
  clearRecords(): void {
    this.records.length = 0;
    this.callIndex = 0;
  }

  /**
   * Returns the number of recorded actions.
   */
  get recordCount(): number {
    return this.records.length;
  }

  async insertPrompt(action: unknown, payload: unknown): Promise<void> {
    this.record('insertPrompt', action, payload);
    // Inert: does not modify any draft store.
  }

  async submitPrompt(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('submitPrompt', action, payload);
    return createInertReceipt('submitPrompt', this.callIndex);
  }

  async navigate(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('navigate', action, payload);
    return createInertReceipt('navigate', this.callIndex);
  }

  async open(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('open', action, payload);
    return createInertReceipt('open', this.callIndex);
  }

  async apply(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('apply', action, payload);
    return createInertReceipt('apply', this.callIndex);
  }

  async approve(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('approve', action, payload);
    return createInertReceipt('approve', this.callIndex);
  }

  async retry(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('retry', action, payload);
    return createInertReceipt('retry', this.callIndex);
  }

  async cancel(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('cancel', action, payload);
    return createInertReceipt('cancel', this.callIndex);
  }

  async resume(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('resume', action, payload);
    return createInertReceipt('resume', this.callIndex);
  }

  async branch(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('branch', action, payload);
    return createInertReceipt('branch', this.callIndex);
  }

  async edit(action: unknown, payload: unknown): Promise<CommandTransportReceiptV1> {
    this.record('edit', action, payload);
    return createInertReceipt('edit', this.callIndex);
  }

  async decideApproval(command: DecideApprovalCommandInput): Promise<CommandTransportReceiptV1> {
    // The inert port records the high-level `approval:decide` command as a
    // single action so gallery inspectors and tests can observe it without
    // routing to a real authority.
    this.record('decideApproval', command, undefined);
    return createInertReceipt('decideApproval', this.callIndex);
  }

  async retryResponse(command: RetryResponseCommandInput): Promise<CommandTransportReceiptV1> {
    this.record('retryResponse', command, undefined);
    return createInertReceipt('retryResponse', this.callIndex);
  }

  async feedback(command: SubmitFeedbackCommandInput): Promise<CommandTransportReceiptV1> {
    this.record('feedback', command, undefined);
    return createInertReceipt('feedback', this.callIndex);
  }

  private record(method: keyof StructuredActionPort, action: unknown, payload: unknown): void {
    this.callIndex++;
    const record: InertActionRecord = {
      method,
      action,
      payload,
      timestamp: Date.now(),
    };

    this.records.push(record);

    // Evict oldest records when capacity exceeded
    while (this.records.length > this.maxRecords) {
      this.records.shift();
    }

    this.onAction?.(record);
  }
}
