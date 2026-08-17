/**
 * Session Header Module — Authority-attributed header and controls.
 *
 * Exports:
 * - Schemas: All Zod schemas and types for authority-attributed fields
 * - SessionHeaderProjector: Projects raw authority data into attributed field projections
 * - SessionHeaderCommandPort: Submits revisioned commands with dry-run enforcement
 *
 * Requirements: 43.1-43.17
 */

export * from './session-header-schemas';
export {
  SessionHeaderProjector,
  type RawHeaderFieldRecord,
  type RawConnectionRecord,
  type SessionHeaderProjectorConfig,
} from './session-header-projector';
export {
  SessionHeaderCommandPort,
  type HeaderAuthorityPort,
  type CommandSubmitResult,
  type ChangeValidationResult,
  type SessionHeaderCommandPortConfig,
  type SubmitChangeResult,
  type SubmitChangeSuccess,
  type SubmitChangeFailure,
} from './session-header-command-port';
