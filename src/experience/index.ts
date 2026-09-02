/**
 * Experience VIEW authority barrel (FUT-PKG-07-EXPERIENCE/T-006).
 *
 * Re-exports the authority-derived dashboard/selector/provider/firewall/channel
 * view derivations plus the voice status/integrity and system-monitor profile.
 * Every surface here DERIVES from a canonical registry/projection/authority and
 * never holds durable truth or a hardcoded total (NN-IDENT-004, NN-UI-007).
 */

export * from './experience-types.js';
export * from './dashboard-authority.js';
export * from './voice-status.js';
export * from './system-monitor-profile.js';
export * from './performance-profile.js';
export * from './accessibility.js';
export * from './localization.js';
export * from './documentation.js';
export * from './renderer-exit-gate.js';
