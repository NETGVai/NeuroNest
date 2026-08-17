/**
 * Renderer Benchmark Module
 *
 * Exports Settings_Service-driven benchmark fixtures, measurement functions,
 * and report generation for renderer performance validation.
 *
 * All budgets and fixture definitions come from Settings_Service configuration
 * with source revision tracking. No hard-coded product limits.
 *
 * Requirements: 47.9–47.11, 47.14, 47.18
 */

export * from './types';
export * from './fixture-generator';
export * from './measurement';
