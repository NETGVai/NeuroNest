/**
 * Extensions — Controlled introspection and staged extensions.
 *
 * Provides secret-free capability/profile/policy/health inspection and
 * disabled-by-default staged extensions with isolated bounded tests,
 * exact-content approval, reversible registration, audit events, and
 * host-escape rejection.
 *
 * Requirements: 27.1–27.8
 */

export * from './schemas';
export * from './introspection-service';
export * from './extension-manager';
