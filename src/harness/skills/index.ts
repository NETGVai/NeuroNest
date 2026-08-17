/**
 * Skills Module — Filesystem skill discovery, validation, catalog merging,
 * scope-based visibility, deterministic profile overlays, and reversible effects.
 *
 * Requirements: 10.1–10.6, 26.1–26.8
 */

export * from './types';
export { SkillCatalog, validateSkillManifest, isScopeVisible } from './skill-catalog';
export { ProfileManager } from './profile-manager';
