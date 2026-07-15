// ─── Loop IPC Handlers ──────────────────────────────────────────
// Typed IPC channel registration for loops:* channels.
// Renderer ↔ Main process communication for loop operations.

export {
  registerLoopIpcHandlers,
  // Request schemas
  LoopsListRequestSchema,
  LoopsCraftRequestSchema,
  LoopsAuditRequestSchema,
  LoopsRunRequestSchema,
  LoopsApproveRequestSchema,
  LoopsStopRequestSchema,
  LoopsRunStatusRequestSchema,
  LoopsReceiptRequestSchema,
  // Response schemas
  LoopsListResponseSchema,
  LoopsCraftResponseSchema,
  LoopsAuditResponseSchema,
  LoopsRunResponseSchema,
  LoopsApproveResponseSchema,
  LoopsStopResponseSchema,
  LoopsRunStatusResponseSchema,
  LoopsReceiptResponseSchema,
} from './loop-ipc-handlers.js';

export type {
  LoopRunnerLike,
  LoopDoctorLike,
  ReceiptGeneratorLike,
  IPCRegistryLike,
  LoopIpcDeps,
} from './loop-ipc-handlers.js';
