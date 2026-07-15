// ─── Loop Catalog ───────────────────────────────────────────────
// Import pipeline for external loop definitions.
// Processes entries through Firewall → Doctor before storage.

export { LoopCraftFlow } from './loop-craft.js';
export type { QAQuestion, QAFlowState } from './loop-craft.js';

export { CatalogImporter, CatalogFetchError } from './catalog-importer.js';
export type { ImportResult } from './catalog-importer.js';

export {
  registerBuiltinLoops,
  BUILTIN_LOOPS,
  TYPE_CLEAN_LOOP,
  TEST_REPAIR_LOOP,
  DOCS_CURRENT_LOOP,
  BUILTIN_TYPE_CLEAN_ID,
  BUILTIN_TEST_REPAIR_ID,
  BUILTIN_DOCS_CURRENT_ID,
} from './builtin-loops.js';
