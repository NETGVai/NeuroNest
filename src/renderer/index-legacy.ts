/**
 * Legacy renderer entry point redirect.
 *
 * The original src/renderer/index.ts (~27,833 lines) is the legacy god-file
 * that is still referenced by the old build path (index.html).
 *
 * The new modular entry point is src/renderer/main.ts, served via main.html.
 * This file exists as a marker for the migration — once all functionality
 * has been extracted into the modular panels structure, the legacy index.ts
 * can be fully removed and this file deleted.
 *
 * See: src/renderer/main.ts (new entry point)
 * See: src/renderer/panels/ (extracted modules)
 */
export {};
