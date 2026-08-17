/**
 * Non-Color Indicators — Meaning Without Color Dependency
 *
 * Ensures status, risk, staleness, error, selection, and diff meaning
 * is conveyed through text or non-color indicators in addition to color.
 * No semantic information depends solely on color.
 *
 * Requirements: 46.10
 */

import { z } from 'zod';

// ─── Schemas ────────────────────────────────────────────────────

/**
 * Semantic meaning categories that must never depend on color alone.
 */
export const SemanticMeaningKindSchema = z.enum([
  'status',
  'risk',
  'staleness',
  'error',
  'warning',
  'success',
  'selection',
  'diff_addition',
  'diff_deletion',
  'diff_modification',
  'active',
  'disabled',
  'pending',
  'unavailable',
]);
export type SemanticMeaningKind = z.infer<typeof SemanticMeaningKindSchema>;

/**
 * The non-color indicator type applied alongside any color usage.
 */
export const IndicatorTypeSchema = z.enum([
  'icon',
  'text_prefix',
  'text_suffix',
  'shape',
  'pattern',
  'border_style',
  'text_decoration',
]);
export type IndicatorType = z.infer<typeof IndicatorTypeSchema>;

/**
 * A non-color indicator descriptor: the non-color method used
 * to convey meaning alongside color.
 */
export const NonColorIndicatorSchema = z.object({
  /** The semantic meaning being conveyed. */
  meaning: SemanticMeaningKindSchema,
  /** The non-color indicator type. */
  indicatorType: IndicatorTypeSchema,
  /** The indicator value (icon name, text prefix, etc.). */
  value: z.string().min(1),
  /** Accessible description of the indicator. */
  accessibleDescription: z.string().min(1),
});
export type NonColorIndicator = z.infer<typeof NonColorIndicatorSchema>;

// ─── Default Indicator Mappings ─────────────────────────────────

/**
 * Default non-color indicators for each semantic meaning.
 * These are the required indicators that ensure meaning
 * is never conveyed by color alone (Requirement 46.10).
 */
export const DEFAULT_INDICATORS: Record<SemanticMeaningKind, NonColorIndicator> = {
  status: {
    meaning: 'status',
    indicatorType: 'icon',
    value: 'circle-dot',
    accessibleDescription: 'Status indicator',
  },
  risk: {
    meaning: 'risk',
    indicatorType: 'icon',
    value: 'shield-alert',
    accessibleDescription: 'Risk level indicator',
  },
  staleness: {
    meaning: 'staleness',
    indicatorType: 'text_suffix',
    value: '(stale)',
    accessibleDescription: 'Content may be outdated',
  },
  error: {
    meaning: 'error',
    indicatorType: 'icon',
    value: 'circle-x',
    accessibleDescription: 'Error indicator',
  },
  warning: {
    meaning: 'warning',
    indicatorType: 'icon',
    value: 'triangle-alert',
    accessibleDescription: 'Warning indicator',
  },
  success: {
    meaning: 'success',
    indicatorType: 'icon',
    value: 'circle-check',
    accessibleDescription: 'Success indicator',
  },
  selection: {
    meaning: 'selection',
    indicatorType: 'border_style',
    value: 'solid-2px',
    accessibleDescription: 'Selected item',
  },
  diff_addition: {
    meaning: 'diff_addition',
    indicatorType: 'text_prefix',
    value: '+',
    accessibleDescription: 'Added line',
  },
  diff_deletion: {
    meaning: 'diff_deletion',
    indicatorType: 'text_prefix',
    value: '-',
    accessibleDescription: 'Removed line',
  },
  diff_modification: {
    meaning: 'diff_modification',
    indicatorType: 'text_prefix',
    value: '~',
    accessibleDescription: 'Modified line',
  },
  active: {
    meaning: 'active',
    indicatorType: 'icon',
    value: 'dot-filled',
    accessibleDescription: 'Active indicator',
  },
  disabled: {
    meaning: 'disabled',
    indicatorType: 'text_suffix',
    value: '(disabled)',
    accessibleDescription: 'Disabled state',
  },
  pending: {
    meaning: 'pending',
    indicatorType: 'icon',
    value: 'clock',
    accessibleDescription: 'Pending indicator',
  },
  unavailable: {
    meaning: 'unavailable',
    indicatorType: 'icon',
    value: 'slash',
    accessibleDescription: 'Unavailable indicator',
  },
};

// ─── Non-Color Indicator Resolver ───────────────────────────────

/**
 * Resolves non-color indicators for semantic meanings.
 * All meanings get an indicator regardless of color presence,
 * ensuring accessibility compliance.
 */
export class NonColorIndicatorResolver {
  private overrides: Map<SemanticMeaningKind, NonColorIndicator> = new Map();

  /**
   * Registers a custom indicator for a meaning, overriding the default.
   */
  registerOverride(indicator: NonColorIndicator): void {
    const parsed = NonColorIndicatorSchema.parse(indicator);
    this.overrides.set(parsed.meaning, parsed);
  }

  /**
   * Resolves the non-color indicator for a given meaning.
   * Returns the override if registered, otherwise the default.
   */
  resolve(meaning: SemanticMeaningKind): NonColorIndicator {
    return this.overrides.get(meaning) ?? DEFAULT_INDICATORS[meaning];
  }

  /**
   * Resolves indicators for multiple meanings.
   */
  resolveMany(meanings: SemanticMeaningKind[]): NonColorIndicator[] {
    return meanings.map((m) => this.resolve(m));
  }

  /**
   * Validates that a set of UI elements all have non-color indicators.
   * Returns any elements that rely solely on color.
   */
  validateElements(
    elements: Array<{ id: string; meaning: SemanticMeaningKind; hasNonColorIndicator: boolean }>,
  ): { valid: boolean; violations: Array<{ id: string; meaning: SemanticMeaningKind }> } {
    const violations = elements
      .filter((el) => !el.hasNonColorIndicator)
      .map(({ id, meaning }) => ({ id, meaning }));

    return {
      valid: violations.length === 0,
      violations,
    };
  }
}
