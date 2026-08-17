/**
 * Canonical Domain Contracts - V1
 *
 * Versioned Zod schemas and TypeScript types for the durable harness and
 * projection-driven chat experience. These contracts define the canonical
 * shapes for events, projections, errors, commands, scopes, owners,
 * idempotency, provider blocks, metrics, tool values, and render intents.
 *
 * All schemas preserve unknown compatible fields via passthrough. Incompatible
 * discriminators produce typed unavailable/fallback outcomes rather than
 * throwing.
 *
 * Requirements: 3.1–3.2, 12.1, 13.1, 16.1, 29.8, 34.1–34.7, 35.3–35.6
 */

export * from './primitives';
export * from './scope';
export * from './actor';
export * from './idempotency';
export * from './error';
export * from './command';
export * from './provider-block';
export * from './metrics';
export * from './tool-value';
export * from './render-intent';
export * from './event';
export * from './projection';
export * from './chat-node';
