// ─── LoopSpec Schema ────────────────────────────────────────────
// Zod-based schema validation for LoopSpec definitions.

export {
  VerifyCheckSchema,
  StopSchema,
  ScopeSchema,
  LoopSpecSchema,
  validateLoopSpec,
} from './loop-spec.js';

export type { VerifyCheck, Stop, Scope, LoopSpec } from './loop-spec.js';
