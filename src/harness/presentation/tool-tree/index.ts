/**
 * Tool Tree Module — Structured tool tree projection, inspection, and presentation.
 *
 * Exports:
 * - Schemas: All Zod schemas and types for the tool tree domain
 * - ToolTreeProjector: Projects verified call lineage into structured trees
 * - ToolInspector: Bounded redacted inspection with authority-routed actions
 * - ToolPresentationPortImpl: Facade coordinating projection, inspection, and spill
 *
 * Requirements: 37.1–37.17
 */

export * from './tool-tree-schemas';
export { ToolTreeProjector, type RawToolCallRecord, type ToolTreeProjectorConfig } from './tool-tree-projector';
export { ToolInspector, type ToolCallDataSource, type AuthorityActionPort, type ToolInspectorConfig } from './tool-inspector';
export { ToolPresentationPortImpl, type SpillServicePort, type ToolCallRecordProvider, type ToolPresentationPortConfig } from './tool-presentation-port';
