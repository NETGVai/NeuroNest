/**
 * Capabilities — Typed capability registration and lifecycle.
 *
 * Extends Plugin_Registry with version compatibility, active-provider resolution,
 * in-flight version pinning, inspection metadata, idempotent disposers,
 * and bounded owned-work drain.
 *
 * Requirements: 2.1–2.7
 */

export * from './types.js';
export { CapabilityRegistry, isContractCompatible } from './capability-registry.js';
