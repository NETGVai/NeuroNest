/**
 * Lean Plugin — Vendored Source
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) Lean Plugin Contributors
 *
 * This module contains the core definitions from the Lean minimalism plugin,
 * vendored into the NeuroNest repository with MIT license preserved.
 *
 * The Lean plugin provides:
 * - A five-rung Minimalism Ladder decision hierarchy
 * - Lean Comment syntax for marking intentional simplifications
 * - Safety exclusion policy for non-reducible categories
 * - Over-engineering detection patterns
 *
 * See LICENSE file in this directory for the full MIT license text.
 */

// ─── Minimalism Ladder ─────────────────────────────────────────

/**
 * The five rungs of the Minimalism Ladder, in priority order.
 * Agents descend the ladder and stop at the first rung that solves the problem.
 */
export const MINIMALISM_LADDER = [
  {
    rung: 1,
    name: 'yagni',
    label: 'Do not build it (YAGNI)',
    description: 'If the feature is not explicitly required right now, do not write it.',
  },
  {
    rung: 2,
    name: 'stdlib',
    label: 'Use standard library',
    description: "If the language's stdlib already solves it, use that.",
  },
  {
    rung: 3,
    name: 'native',
    label: 'Use native language features',
    description: 'If a built-in construct covers the need, prefer it over external code.',
  },
  {
    rung: 4,
    name: 'dependency',
    label: 'Use a single well-known dependency',
    description: 'If a widely-adopted, actively-maintained package exists, prefer one dependency over hand-rolling.',
  },
  {
    rung: 5,
    name: 'one-line',
    label: 'Write it in one line if possible',
    description: 'If the implementation can be expressed clearly in a single line or expression, do so.',
  },
] as const;

export type MinimalismRung = typeof MINIMALISM_LADDER[number];
export type RungName = MinimalismRung['name'];

// ─── Lean Comment Syntax ───────────────────────────────────────

/**
 * The Lean Comment pattern for marking intentional simplifications.
 * Format: `// lean: <ceiling_name> — <upgrade_path>`
 *
 * - ceiling_name: A non-empty identifier naming the ceiling (e.g., "stdlib_regex")
 * - upgrade_path: A non-empty description of when/how to upgrade past this ceiling
 *
 * The em-dash (—, U+2014) is used as the separator between ceiling and upgrade path.
 */
export const LEAN_COMMENT_PATTERN = '// lean: <ceiling_name> — <upgrade_path>';

/**
 * Regex for detecting and parsing well-formed Lean Comments.
 */
export const LEAN_COMMENT_REGEX = /\/\/\s*lean:\s*(\S+)\s*—\s*(.+)$/;

// ─── Safety Exclusion Categories ───────────────────────────────

/**
 * Categories that are NEVER subject to minimalism reduction.
 * These require full, robust implementations regardless of ladder position.
 */
export const SAFETY_EXCLUSION_CATEGORIES = [
  'trust-boundary',
  'data-loss',
  'security',
  'a11y',
] as const;

export type SafetyCategory = typeof SAFETY_EXCLUSION_CATEGORIES[number];

/**
 * Human-readable descriptions of each safety exclusion category.
 */
export const SAFETY_EXCLUSION_DESCRIPTIONS: Record<SafetyCategory, string> = {
  'trust-boundary': 'Input validation at system boundaries, authentication checks, authorization guards.',
  'data-loss': 'Backup logic, transaction safety, write-ahead protections, graceful degradation on storage failure.',
  'security': 'Encryption, secret management, rate limiting, CSRF/XSS protections, audit logging.',
  'a11y': 'ARIA attributes, semantic HTML, keyboard navigation, screen-reader support.',
};

// ─── Over-Engineering Detection Tags ───────────────────────────

/**
 * Tags used to categorize over-engineering findings.
 */
export const BLOAT_TAGS = ['delete', 'stdlib', 'native', 'yagni', 'shrink'] as const;
export type BloatTag = typeof BLOAT_TAGS[number];

// ─── Output Rule ───────────────────────────────────────────────

/**
 * The lean output constraint: code first, explanations limited.
 */
export const OUTPUT_RULE = {
  maxExplanationLines: 3,
  codeFirst: true,
  description: 'Code first, ≤3 lines of explanation.',
};
