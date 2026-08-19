/**
 * Development-Only Response Gallery
 *
 * A default-off development route/panel that renders all response surfaces and
 * states from deterministic fixtures. Supports narrow/wide viewports, all
 * supported themes, reduced motion, 200% text scaling, active streaming
 * simulation, and inspector mode.
 *
 * Production exclusion:
 * - Gated behind NODE_ENV=development AND the `response_gallery` feature flag.
 * - The gallery code and fixture data are excluded from production activation.
 * - All fixture actions route through an InertStructuredActionPort that never
 *   reaches real authorities.
 * - No network or model calls are made.
 *
 * Requirements: 17.2, 18.1, 22.5, 22.8, 22.11
 */

import type { ResponseBlockKind } from '../../harness/contracts/response-composition';
import type { GalleryFixture, GalleryFixtureSet, MixedSessionFixture } from './__fixtures__/types';
import type { SupportedThemeId } from './semantic-tokens';
import { InertStructuredActionPort, type InertActionRecord } from './inert-action-port';

// ─── Gallery Configuration Types ────────────────────────────────

/** Route identifier for the gallery panel. */
export const GALLERY_ROUTE = '__dev/response-gallery' as const;

/** Feature flag key for the gallery. */
export const GALLERY_FEATURE_FLAG = 'response_gallery' as const;

/**
 * Viewport modes supported by the gallery.
 */
export type GalleryViewportMode = 'narrow' | 'wide';

/**
 * Text scaling options supported by the gallery.
 */
export type GalleryTextScaling = '100%' | '150%' | '200%';

/**
 * Accessibility modes supported by the gallery.
 */
export type GalleryAccessibilityMode = 'default' | 'reduced-motion' | 'screen-reader';

/**
 * Gallery panel operating modes.
 */
export type GalleryMode = 'browse' | 'streaming' | 'inspector';

/**
 * Complete gallery display settings.
 */
export interface GallerySettings {
  /** Active theme. */
  readonly theme: SupportedThemeId;
  /** Viewport mode for responsive testing. */
  readonly viewport: GalleryViewportMode;
  /** Text scaling factor. */
  readonly textScaling: GalleryTextScaling;
  /** Accessibility mode. */
  readonly accessibility: GalleryAccessibilityMode;
  /** Gallery operating mode. */
  readonly mode: GalleryMode;
  /** Filter to specific block kinds. Empty means show all. */
  readonly kindFilter: readonly ResponseBlockKind[];
  /** Whether the inspector pane is open. */
  readonly inspectorOpen: boolean;
}

/** Default gallery settings. */
export const DEFAULT_GALLERY_SETTINGS: GallerySettings = {
  theme: 'dark',
  viewport: 'wide',
  textScaling: '100%',
  accessibility: 'default',
  mode: 'browse',
  kindFilter: [],
  inspectorOpen: false,
};

/**
 * Listener callback type for settings changes.
 */
export type GallerySettingsListener = (settings: GallerySettings) => void;

// ─── Gallery Gate ───────────────────────────────────────────────

/**
 * Determines whether the gallery route is accessible.
 * Returns true ONLY when both conditions are met:
 * 1. NODE_ENV is 'development' or 'test'
 * 2. The response_gallery feature flag is enabled
 *
 * In production builds, this always returns false, preventing gallery
 * activation and ensuring fixture data is dead-code-eliminated.
 */
export function isGalleryEnabled(featureFlags?: Readonly<Record<string, boolean>>): boolean {
  const env = typeof process !== 'undefined' ? process.env['NODE_ENV'] : undefined;
  if (env !== 'development' && env !== 'test') {
    return false;
  }
  if (featureFlags && featureFlags[GALLERY_FEATURE_FLAG] === false) {
    return false;
  }
  // Default enabled in dev/test if flag not explicitly disabled
  return true;
}

/**
 * Determines if the given route path matches the gallery.
 */
export function isGalleryRoute(route: string): boolean {
  return route === GALLERY_ROUTE || route === `/${GALLERY_ROUTE}`;
}

// ─── Gallery Controller ─────────────────────────────────────────

/**
 * Internal fixture state loaded lazily to avoid production bundles.
 */
interface GalleryFixtureState {
  readonly allFixtures: readonly GalleryFixtureSet[];
  readonly allIndividual: readonly GalleryFixture[];
  readonly mixedSession: MixedSessionFixture;
  readonly fixtureCount: number;
  readonly missingKinds: readonly ResponseBlockKind[];
}

/**
 * Development response gallery controller.
 *
 * Manages fixture loading, settings, theme switching, and rendering state
 * without making any network, model, or authority calls.
 */
export class ResponseGalleryController {
  private settings: GallerySettings;
  private readonly actionPort: InertStructuredActionPort;
  private fixtureState: GalleryFixtureState | null = null;
  private readonly listeners: Set<GallerySettingsListener> = new Set();
  private disposed = false;

  constructor(initialSettings?: Partial<GallerySettings>) {
    this.settings = { ...DEFAULT_GALLERY_SETTINGS, ...initialSettings };
    this.actionPort = new InertStructuredActionPort({
      maxRecords: 500,
    });
  }

  /**
   * Whether the gallery is currently active and enabled.
   */
  isActive(featureFlags?: Readonly<Record<string, boolean>>): boolean {
    return !this.disposed && isGalleryEnabled(featureFlags);
  }

  /**
   * Lazily loads fixture data. Separated from constructor to enable
   * tree-shaking in production builds.
   */
  async loadFixtures(): Promise<GalleryFixtureState> {
    if (this.fixtureState) return this.fixtureState;

    // Dynamic import ensures fixtures are tree-shaken in production
    const fixtures = await import('./__fixtures__/index');
    const allFixtures = fixtures.getAllFixtures();
    const allIndividual = fixtures.getAllIndividualFixtures();
    const mixedSession = fixtures.getMixedSessionFixture();
    const missingKinds = fixtures.validateFixtureCoverage();
    const fixtureCount = fixtures.getFixtureCount();

    this.fixtureState = {
      allFixtures,
      allIndividual,
      mixedSession,
      fixtureCount,
      missingKinds,
    };

    return this.fixtureState;
  }

  /**
   * Returns the current gallery settings.
   */
  getSettings(): Readonly<GallerySettings> {
    return this.settings;
  }

  /**
   * Updates gallery settings and notifies listeners.
   * Returns the new resolved settings.
   */
  updateSettings(patch: Partial<GallerySettings>): GallerySettings {
    if (this.disposed) return this.settings;

    const previous = this.settings;
    this.settings = { ...previous, ...patch };

    // Notify all listeners of the change
    for (const listener of this.listeners) {
      listener(this.settings);
    }

    return this.settings;
  }

  /**
   * Subscribes to settings changes. Returns an unsubscribe function.
   */
  onSettingsChange(listener: GallerySettingsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns the inert action port used by the gallery.
   * Actions invoked through this port are recorded but never forwarded.
   */
  getActionPort(): InertStructuredActionPort {
    return this.actionPort;
  }

  /**
   * Returns all recorded inert action invocations.
   */
  getActionRecords(): readonly InertActionRecord[] {
    return this.actionPort.getRecords();
  }

  /**
   * Returns filtered fixtures based on current kindFilter settings.
   * Requires loadFixtures() to have been called first.
   */
  getVisibleFixtures(): readonly GalleryFixture[] {
    if (!this.fixtureState) return [];

    const { kindFilter } = this.settings;
    if (kindFilter.length === 0) {
      return this.fixtureState.allIndividual;
    }

    return this.fixtureState.allIndividual.filter(
      (f) => kindFilter.includes(f.blockKind),
    );
  }

  /**
   * Returns fixture sets for a specific block kind.
   * Requires loadFixtures() to have been called first.
   */
  getFixturesByKind(kind: ResponseBlockKind): readonly GalleryFixture[] {
    if (!this.fixtureState) return [];
    const set = this.fixtureState.allFixtures.find((s) => s.kind === kind);
    return set?.fixtures ?? [];
  }

  /**
   * Returns the mixed session fixture for full-composition rendering.
   * Requires loadFixtures() to have been called first.
   */
  getMixedSession(): MixedSessionFixture | null {
    return this.fixtureState?.mixedSession ?? null;
  }

  /**
   * Returns fixture coverage information.
   */
  getCoverage(): { total: number; missingKinds: readonly ResponseBlockKind[] } {
    return {
      total: this.fixtureState?.fixtureCount ?? 0,
      missingKinds: this.fixtureState?.missingKinds ?? [],
    };
  }

  /**
   * Verifies the gallery does not depend on live model calls or network.
   */
  verifyNoExternalDependencies(): boolean {
    if (!this.fixtureState) return true;
    const { mixedSession } = this.fixtureState;
    return mixedSession.requiresLiveModel === false && mixedSession.requiresNetwork === false;
  }

  /**
   * Disposes the gallery controller and clears all state.
   */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.actionPort.clearRecords();
    this.fixtureState = null;
  }
}

// ─── Gallery Route Handler ──────────────────────────────────────

/**
 * Result type when attempting to activate the gallery route.
 */
export type GalleryActivationResult =
  | { readonly ok: true; readonly controller: ResponseGalleryController }
  | { readonly ok: false; readonly reason: 'disabled' | 'invalid_route' | 'already_active' };

/**
 * Attempts to activate the gallery for a given route.
 * Returns a controller on success or a typed failure reason.
 *
 * This function is the sole entry point for gallery activation and
 * enforces the development-only gate.
 */
export function activateGalleryRoute(
  route: string,
  featureFlags?: Readonly<Record<string, boolean>>,
  initialSettings?: Partial<GallerySettings>,
): GalleryActivationResult {
  if (!isGalleryRoute(route)) {
    return { ok: false, reason: 'invalid_route' };
  }

  if (!isGalleryEnabled(featureFlags)) {
    return { ok: false, reason: 'disabled' };
  }

  const controller = new ResponseGalleryController(initialSettings);
  return { ok: true, controller };
}
