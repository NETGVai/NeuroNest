/**
 * Fixture type definitions for the structured response renderer test infrastructure.
 *
 * These types describe deterministic, self-contained test data that exercises every
 * Response_Block kind, contract version, compatibility/fallback outcome, lifecycle state,
 * authority state, source state, theme, viewport, and accessibility variant without
 * requiring live model calls, network requests, or authority access.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type {
  ResponseBlockKind,
  ResponseBlockRole,
  ResponseBlockStatus,
  ResponseBlockV1,
  ResponseCompositionV1,
} from '../../../harness/contracts/response-composition';

/** Every supported block kind in the V1 contract. */
export const ALL_BLOCK_KINDS: readonly ResponseBlockKind[] = [
  'narrative',
  'reasoning',
  'turn_status',
  'tool_activity',
  'task_progress',
  'decision',
  'recommendation',
  'context',
  'code',
  'diff',
  'structured_data',
  'insight',
  'attachment',
  'error',
  'follow_up_actions',
] as const;

/** Every supported block status in the V1 contract. */
export const ALL_BLOCK_STATUSES: readonly ResponseBlockStatus[] = [
  'pending',
  'ready',
  'streaming',
  'stale',
  'unavailable',
  'terminal',
] as const;

/** Every supported block role in the V1 contract. */
export const ALL_BLOCK_ROLES: readonly ResponseBlockRole[] = [
  'primary',
  'status',
  'decision',
  'evidence',
  'detail',
  'actions',
] as const;

/** Theme variants for fixture rendering. */
export type ThemeVariant = 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';

/** Viewport size variants for responsive testing. */
export type ViewportVariant = 'narrow' | 'medium' | 'wide' | 'ultra-wide';

/** Accessibility variants for fixture rendering. */
export type AccessibilityVariant =
  | 'default'
  | 'reduced-motion'
  | 'screen-reader'
  | 'keyboard-only'
  | 'text-scaling-200';

/** Lifecycle states specific to fixture testing. */
export type LifecycleVariant =
  | 'streaming'
  | 'finalized'
  | 'retrying'
  | 'failed'
  | 'cancelled'
  | 'reconnecting'
  | 'partial-recovery';

/** Authority states for fixture testing. */
export type AuthorityStateVariant =
  | 'confirmed'
  | 'pending'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'unavailable';

/** Source states from the contract. */
export type SourceStateVariant =
  | 'available'
  | 'stale'
  | 'unavailable'
  | 'redacted'
  | 'unverified'
  | 'no_longer_authorized';

/** Compatibility/fallback outcome variants. */
export type FallbackVariant =
  | 'normal'
  | 'safe-generic-block'
  | 'safe-generic-composition'
  | 'minimal-error'
  | 'unsupported-version'
  | 'unsupported-kind'
  | 'intent-conflict';

/**
 * A single deterministic fixture entry for one block under specific conditions.
 * Requires no live model calls.
 */
export interface GalleryFixture {
  /** Unique fixture identifier for snapshot comparison. */
  readonly id: string;
  /** Human-readable description of what this fixture exercises. */
  readonly description: string;
  /** The block kind this fixture tests. */
  readonly blockKind: ResponseBlockKind;
  /** Contract version being tested. */
  readonly contractVersion: number;
  /** Status of the response block. */
  readonly status: ResponseBlockStatus;
  /** Role of the block in the composition. */
  readonly role: ResponseBlockRole;
  /** Theme variant. */
  readonly theme: ThemeVariant;
  /** Viewport variant. */
  readonly viewport: ViewportVariant;
  /** Accessibility variant. */
  readonly accessibility: AccessibilityVariant;
  /** Lifecycle variant being tested. */
  readonly lifecycle: LifecycleVariant;
  /** Authority state being tested. */
  readonly authorityState: AuthorityStateVariant;
  /** Source state where applicable (primarily for context blocks). */
  readonly sourceState?: SourceStateVariant;
  /** Fallback/compatibility outcome being tested. */
  readonly fallback: FallbackVariant;
  /** The complete, valid ResponseBlockV1 fixture data. */
  readonly block: ResponseBlockV1;
  /** Content digest for snapshot stability verification. */
  readonly contentDigest: string;
  /** Stable key that must not change across test runs. */
  readonly expectedStableKey: string;
}

/**
 * A collection of related fixtures for one block kind.
 */
export interface GalleryFixtureSet {
  /** The block kind this set covers. */
  readonly kind: ResponseBlockKind;
  /** Contract version covered. */
  readonly contractVersion: number;
  /** All fixture entries. */
  readonly fixtures: readonly GalleryFixture[];
}

/**
 * A mixed-session fixture containing multiple block kinds in a single composition.
 */
export interface MixedSessionFixture {
  /** Unique session fixture identifier. */
  readonly id: string;
  /** Human-readable description. */
  readonly description: string;
  /** The full response composition containing all block kinds. */
  readonly composition: ResponseCompositionV1;
  /** Expected stable keys in declared order. */
  readonly expectedBlockOrder: readonly string[];
  /** Content digests for each block by stable key. */
  readonly blockDigests: Readonly<Record<string, string>>;
  /** Lifecycle and recovery states exercised in this fixture. */
  readonly coveredLifecycles: readonly LifecycleVariant[];
  /** Confirms no live model calls required. */
  readonly requiresLiveModel: false;
  /** Confirms no network access required. */
  readonly requiresNetwork: false;
}
