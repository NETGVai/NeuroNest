/**
 * Typed IPC Contract System — Public API
 *
 * Requirements: 7.1, 24.7, 24.9, 28.2
 */

export {
  IPC_CONTRACT_VERSION,
  type IPCPrivilegeTier,
  type IPCCategory,
  type IPCEnvelope,
  type IPCRequest,
  type IPCResponse,
  type IPCError,
  type CancellationToken,
  type IPCCancellationRequest,
  type IPCSnapshot,
  type IPCOrderedEvent,
  type IPCContractDefinition,
  type IPCContractRegistry,
  isValidEnvelope,
  isValidRequest,
  isValidResponse,
  isValidSnapshot,
  isValidOrderedEvent,
  isValidCancellation,
} from './contracts';

export {
  generateMessageId,
  CancellationManager,
  RequestResponseRegistrar,
  CancellationRegistrar,
  SnapshotRegistrar,
  OrderedEventRegistrar,
  type CompatibilityMapping,
  buildCompatibilityMappings,
} from './registrars';
