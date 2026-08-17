/**
 * Settings — Versioned operational-bounds contract.
 *
 * Extends Settings_Service with positive, finite, unit-aware schemas,
 * documented supported ranges, deterministic scope precedence, source revisions,
 * last-valid-revision retention, and Diagnostics_Service exposure.
 *
 * Requirements: 5.6, 7.4, 11.3, 14.2, 18.2, 22.4–22.8, 31.1, 36.5, 37.3, 40.14, 40.17, 42.4, 47.1, 47.9, 47.14–47.15, 47.20–47.21
 */

export * from './bound-descriptor';
export * from './operational-bounds-schema';
export * from './settings-bounds-service';
