//
// Implements the default `OutboundMcpServerOptions.licenseCheck`
// (`packages/neuronest-cli/src/mcp/types.ts`).
//
// Background:
//   The `@neuronest/cli` package contains no Electron and never imports
//   `src/main/license/license-manager.ts`. Instead, the desktop-side
//   `LicenseManager.getStoredLicense()` is read by the Headless_Protocol
//   server when the IPC connection opens, and the resulting license
//   summary is embedded in the protocol's startup banner. The CLI MCP
//   server consumes that summary as its single source of truth for
//   license validity (Req 6.7).
//
// Contract:
//   - The factory accepts a `BannerReader` — a thunk that returns a
//     freshly read banner. The OutboundMcpServer is expected to
//     refresh the banner on each MCP request that needs the gate, so
//     the reader is consulted on every `licenseCheck()` call rather
//     than caching at construction time.
//   - `{ ok: false; detail }` is returned in three cases:
//       (a) no license stored — banner has no `license` field;
//       (b) `license.valid === false`;
//       (c) the license is expired — `expiresAt < now`.
//   - Otherwise `{ ok: true }`.
//
// Determinism:
//   - The current time is resolved through an injectable `now` thunk
//     defaulting to `() => new Date()` so tests can pin the clock.
//   - A malformed `expiresAt` (one that does not parse to a finite
//     epoch) is treated as expired; this is the conservative branch
//     because an unparseable expiry cannot be proven to be in the
//     future, and the alternative (admit the license) would let a
//     malformed banner pass the gate.
//
// Validates: Requirements 6.7

/**
 * The license summary embedded in the Headless_Protocol startup
 * banner. Only the fields the CLI uses for the gate are listed
 * structurally; the index signature accommodates additional fields
 * the desktop side may attach (e.g. plan, email) without forcing
 * the CLI types to track them.
 */
export interface BannerLicenseSummary {
  /**
   * Whether the desktop-side `LicenseManager` considers the license
   * valid (i.e. present and not invalidated by API/feature checks).
   * `false` triggers the `license_invalid` MCP error branch
   * regardless of `expiresAt`.
   */
  valid: boolean;

  /**
   * ISO 8601 timestamp at which the license expires. Compared
   * lexicographically only after parsing through `Date.parse`; an
   * `expiresAt` whose parsed epoch is `≤` the current epoch is
   * considered expired and rejected.
   *
   * Optional: a license without an `expiresAt` (e.g. perpetual) is
   * never rejected on expiry alone.
   */
  expiresAt?: string;

  /**
   * Index signature for forward compatibility — the desktop side
   * may attach additional summary fields (plan, features, hwid,
   * etc.) that the CLI does not consume but should not strip when
   * passing through.
   */
  readonly [key: string]: unknown;
}

/**
 * The Headless_Protocol startup banner shape relevant to the
 * license-check gate. The full banner has additional fields
 * (onboarding state, protocol version, etc.) consumed elsewhere;
 * this module reads only `license`.
 */
export interface HeadlessStartupBanner {
  /**
   * The stored license summary, present iff the desktop-side
   * `LicenseManager.getStoredLicense()` returned a non-null record
   * at the moment the banner was prepared. Absent means no license
   * is stored.
   */
  license?: BannerLicenseSummary;

  /**
   * Forward-compatible passthrough for other banner fields the CLI
   * does not consume here (e.g. `onboardingState`, `protocolVersion`).
   */
  readonly [key: string]: unknown;
}

/**
 * Thunk that returns a freshly read startup banner from the
 * Headless_Protocol transport. Implementations are expected to
 * refresh on each call rather than memoize, so the gate observes
 * up-to-date license state if the desktop app's stored license
 * changes mid-session.
 */
export type BannerReader = () => Promise<HeadlessStartupBanner>;

/** Result envelope returned by the produced `licenseCheck` thunk —
 *  intentionally identical to `OutboundMcpServerOptions.licenseCheck`
 *  so the factory's output is drop-in compatible. */
export type LicenseCheckResult =
  | { ok: true }
  | { ok: false; detail: string };

/** Construction-time options for the license-check factory. */
export interface LicenseCheckOptions {
  /**
   * Clock injection used to evaluate expiry. Defaults to
   * `() => new Date()`. Tests pin this to a fixed instant to make
   * the expiry branch deterministic.
   */
  now?: () => Date;
}

/**
 * The four detail strings the produced thunk ever returns. Exported
 * so callers (including the unit tests in this file's sibling
 * `__tests__/` directory) can assert against them without coupling
 * to free-form English.
 */
export const LICENSE_CHECK_DETAIL = Object.freeze({
  /** Case (a): banner has no `license` field. */
  NOT_STORED: 'No license stored on the desktop side.',
  /** Case (b): `license.valid === false`. */
  INVALID:
    'License is marked invalid by the desktop-side LicenseManager.',
  /** Case (c): `license.expiresAt < now`. */
  EXPIRED: 'License has expired.',
  /**
   * Defensive subcase of (c): `license.expiresAt` is present but
   * does not parse as a finite ISO 8601 timestamp. Treated as
   * expired so a malformed banner cannot pass the gate.
   */
  EXPIRED_MALFORMED:
    'License has an unparseable expiresAt and is treated as expired.',
} as const);

/**
 * Build the default `licenseCheck` thunk that
 * `OutboundMcpServerOptions.licenseCheck` defaults to when no
 * override is supplied.
 *
 * @param readBanner Thunk returning the latest Headless_Protocol
 *                   startup banner. Consulted on every check so the
 *                   CLI sees fresh license state if the desktop side
 *                   updates the stored license mid-session.
 * @param opts       Optional construction-time options — `now` is
 *                   injectable for deterministic tests.
 *
 * @returns A `() => Promise<{ ok: true } | { ok: false; detail }>`
 *          function whose shape matches
 *          `OutboundMcpServerOptions.licenseCheck`.
 */
export function createLicenseCheck(
  readBanner: BannerReader,
  opts: LicenseCheckOptions = {},
): () => Promise<LicenseCheckResult> {
  const now = opts.now ?? (() => new Date());

  return async function licenseCheck(): Promise<LicenseCheckResult> {
    const banner = await readBanner();
    const license = banner.license;

    // Case (a): no license stored.
    if (license === undefined || license === null) {
      return { ok: false, detail: LICENSE_CHECK_DETAIL.NOT_STORED };
    }

    // Case (b): license explicitly marked invalid.
    if (license.valid === false) {
      return { ok: false, detail: LICENSE_CHECK_DETAIL.INVALID };
    }

    // Case (c): license expired.
    if (typeof license.expiresAt === 'string' && license.expiresAt.length > 0) {
      const expiresAtMs = Date.parse(license.expiresAt);

      if (!Number.isFinite(expiresAtMs)) {
        // Unparseable expiry — treat as expired (conservative).
        return {
          ok: false,
          detail: LICENSE_CHECK_DETAIL.EXPIRED_MALFORMED,
        };
      }

      const nowMs = now().getTime();
      if (expiresAtMs <= nowMs) {
        return { ok: false, detail: LICENSE_CHECK_DETAIL.EXPIRED };
      }
    }

    return { ok: true };
  };
}
