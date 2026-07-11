/**
 * Lean Plugin — Vendored Source Entry Point
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) Lean Plugin Contributors
 *
 * Re-exports all public definitions from the vendored Lean plugin.
 * See LICENSE file in this directory for the full MIT license text.
 */

export {
  MINIMALISM_LADDER,
  LEAN_COMMENT_PATTERN,
  LEAN_COMMENT_REGEX,
  SAFETY_EXCLUSION_CATEGORIES,
  SAFETY_EXCLUSION_DESCRIPTIONS,
  BLOAT_TAGS,
  OUTPUT_RULE,
} from './lean-plugin.js';

export type {
  MinimalismRung,
  RungName,
  SafetyCategory,
  BloatTag,
} from './lean-plugin.js';
