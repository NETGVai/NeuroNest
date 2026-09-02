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

export {
  ContractRegistry,
  CONTRACT_TIERS,
  tierRank,
  contractNameToMethod,
  contractNameToChannel,
  type ContractTier,
  type ContractDirection,
  type ReceiptBehavior,
  type ContractAlias,
  type ContractDescriptor,
  type FacadeDescriptor,
  type HandlerDescriptor,
  type ParityReport,
  type CallerIdentity,
  type DispatchDecision,
  type DispatchAuthorized,
  type DispatchRejected,
  type AliasTelemetrySample,
} from './contract-registry';

export {
  FOUNDATION_CONTRACTS,
  FOUNDATION_ALIAS_CHANNELS,
  buildFoundationContractRegistry,
} from './foundation-contract-catalog';
