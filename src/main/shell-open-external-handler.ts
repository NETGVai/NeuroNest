/**
 * Fixed external-link IPC handler (task 10.6).
 *
 * Registers the sole authorized path from the renderer to `shell.openExternal`.
 * Every request is:
 *   1. Zod-validated against `ExternalLinkRequestV1Schema` (rejects unknown
 *      keys, wrong `schemaVersion`, malformed correlation identifiers, and
 *      URLs longer than 2048 characters).
 *   2. Re-parsed with `new URL()` so the main process never trusts the
 *      renderer's parse tree.
 *   3. Checked against a strict scheme allowlist (`https:`, `mailto:`).
 *   4. Rejected on embedded credentials (`user:pass@…`), control characters
 *      anywhere in the URL, hostnames that are not already ASCII-normalized
 *      (IDN, mixed-case, uppercase, punycode round-trip mismatch), or a
 *      length above 2048 characters.
 *   5. Only *after* every check passes is `shell.openExternal` called.
 *
 * The handler never echoes the input URL or any OS-level error back to the
 * renderer. Rejections carry a fixed enumerated code so the renderer can
 * surface non-sensitive feedback.
 *
 * Requirements: 10.8, 14.4, 14.5, 15.1, 15.2
 */

import type { IpcMainInvokeEvent } from 'electron';

import {
  ExternalLinkRequestV1Schema,
  ExternalLinkResultV1Schema,
  SHELL_OPEN_EXTERNAL_CHANNEL,
  type ExternalLinkRejectionCode,
  type ExternalLinkResultV1,
} from '../shared/external-link-ipc-contracts.js';

// ─── Boundary Injection ─────────────────────────────────────────────────────

export interface ShellOpenExternalIPCMain {
  handle(
    channel: string,
    listener: (
      event: IpcMainInvokeEvent,
      request?: unknown,
    ) => Promise<unknown> | unknown,
  ): void;
  removeHandler(channel: string): void;
}

/**
 * Narrow surface of `electron.shell` the handler needs. Injecting rather
 * than importing `electron` at module load keeps the handler unit-testable
 * without a running Electron process.
 */
export interface ShellOpenExternalShell {
  openExternal(url: string): Promise<void>;
}

export interface ShellOpenExternalHandlerDependencies {
  ipcMain: ShellOpenExternalIPCMain;
  shell: ShellOpenExternalShell;
  /**
   * Optional structured-logger sink. When omitted, rejections are silent —
   * no raw URL, credential, or user-supplied string is ever logged by
   * default. The caller may wire a redacted logger for observability.
   */
  logRejection?: (code: ExternalLinkRejectionCode) => void;
}

export interface ShellOpenExternalHandlerRegistration {
  readonly channel: typeof SHELL_OPEN_EXTERNAL_CHANNEL;
  dispose(): void;
}

// ─── Allowlist ──────────────────────────────────────────────────────────────

/**
 * Approved external schemes. `https:` covers the ordinary Markdown link
 * case; `mailto:` covers the "email the author" links canonical Markdown
 * accepts. Every other scheme is rejected — including `http:` (product
 * policy does not currently opt in), `file:`, `javascript:`, `data:`,
 * `vbscript:`, and custom application schemes.
 */
const ALLOWED_SCHEMES = new Set<string>(['https:', 'mailto:']);

/**
 * Hard cap enforced at the handler layer even though the schema also
 * enforces it. Defense-in-depth: if a future refactor loosens the schema
 * bound, the handler still refuses to spend a `shell.openExternal` call on
 * an oversized URL.
 */
const MAX_URL_LENGTH = 2048;

/**
 * Matches any C0 (U+0000–U+001F) or C1 (U+007F–U+009F) control code point.
 * Rendered anchors should never contain these characters after the
 * canonical Markdown pipeline sanitizes URLs; a request that includes one
 * is either malicious or corrupted. Reject either way.
 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

// ─── Validation ─────────────────────────────────────────────────────────────

interface RejectionResult {
  readonly kind: 'rejected';
  readonly code: ExternalLinkRejectionCode;
}

interface AcceptResult {
  readonly kind: 'accepted';
  readonly url: URL;
}

type ValidationOutcome = RejectionResult | AcceptResult;

function reject(code: ExternalLinkRejectionCode): RejectionResult {
  return { kind: 'rejected', code };
}

/**
 * Applies the URL allowlist. Returns either the parsed `URL` (never handed
 * back to the renderer) or a fixed rejection code.
 */
export function validateExternalLinkHref(href: string): ValidationOutcome {
  if (typeof href !== 'string' || href.length === 0) {
    return reject('invalid-url');
  }
  if (href.length > MAX_URL_LENGTH) {
    return reject('url-too-long');
  }
  if (CONTROL_CHARACTER_PATTERN.test(href)) {
    return reject('control-characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return reject('invalid-url');
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return reject('scheme-not-allowed');
  }

  // `mailto:` targets do not have a hostname/username/password. Skip the
  // credential and hostname-normalization checks that only apply to
  // authority-bearing schemes like `https:`.
  if (parsed.protocol === 'https:') {
    if (parsed.username !== '' || parsed.password !== '') {
      return reject('embedded-credentials');
    }

    // Detect *any* WHATWG-side normalization by comparing the raw hostname
    // (verbatim from the input string) against the parsed hostname. If the
    // parser had to lowercase, IDN → punycode, or trim leading zeros, they
    // differ — reject the request as not normalized. This is the belt to
    // `isNormalizedHostname`'s braces.
    const rawHostname = extractRawHostname(href);
    if (rawHostname === null || rawHostname.length === 0) {
      return reject('invalid-url');
    }
    if (rawHostname !== parsed.hostname) {
      return reject('hostname-not-normalized');
    }
    if (!isNormalizedHostname(rawHostname)) {
      return reject('hostname-not-normalized');
    }
  } else {
    // `mailto:` still cannot embed userinfo (`mailto://user:pass@…`); reject
    // if any showed up. Standards-compliant `mailto:` targets have
    // `parsed.username === ''` because the local-part lives in `pathname`.
    if (parsed.username !== '' || parsed.password !== '') {
      return reject('embedded-credentials');
    }
  }

  // Re-check the *serialized* URL length after `new URL` normalization.
  // A caller may have supplied a shorter string that expanded when the
  // WHATWG parser normalized escaped octets.
  if (parsed.href.length > MAX_URL_LENGTH) {
    return reject('url-too-long');
  }

  return { kind: 'accepted', url: parsed };
}

/**
 * Extracts the hostname substring from a raw https URL exactly as it
 * appeared in the input, without letting the WHATWG URL parser normalize
 * it first. Returns `null` when the URL is not an `https:` URL with a
 * recognizable authority. Comparison against `new URL(href).hostname`
 * catches parser normalizations (case folding, IDN → punycode, IPv4
 * leading-zero trimming) that would otherwise silently pass validation.
 *
 * IPv6 hostnames appear in brackets in both raw form and in
 * `URL.hostname`; the brackets are preserved so comparison succeeds.
 */
export function extractRawHostname(href: string): string | null {
  const match = /^https:\/\/([^/?#]+)/i.exec(href);
  if (!match) return null;
  let authority = match[1] ?? '';

  // Strip userinfo — validation of embedded credentials happens separately.
  const atIdx = authority.lastIndexOf('@');
  if (atIdx >= 0) authority = authority.slice(atIdx + 1);
  if (authority.length === 0) return null;

  if (authority.startsWith('[')) {
    // IPv6: keep the bracketed form; port (if any) sits after `]`.
    const closeIdx = authority.indexOf(']');
    if (closeIdx < 0) return null;
    return authority.slice(0, closeIdx + 1);
  }

  const colonIdx = authority.indexOf(':');
  return colonIdx >= 0 ? authority.slice(0, colonIdx) : authority;
}

/**
 * Returns true iff the hostname is already in its canonical ASCII form.
 * A hostname is considered normalized when:
 *   - It contains only ASCII characters (rejects raw IDN input).
 *   - It is already lowercase (rejects `Example.COM`).
 *   - It contains no whitespace, angle brackets, or other structural chars.
 *   - Every label is well-formed (no leading/trailing hyphen, non-empty,
 *     ≤ 63 chars).
 *   - The total length is ≤ 253 characters.
 *   - Punycode labels (starting with `xn--`) can round-trip through the
 *     WHATWG parser without changing shape — protects against
 *     look-alike Unicode injected via decoded IDN forms.
 */
export function isNormalizedHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;

  // Only allow ASCII a-z, 0-9, hyphen, dot. Reject any uppercase letter so
  // callers that don't lowercase are visibly caught.
  if (!/^[a-z0-9.-]+$/.test(hostname)) return false;

  // IPv4 literal? Accept only when every octet is in range and no
  // leading zeros are present ("192.168.001.1" collapses to "192.168.1.1"
  // in WHATWG parsing, so treat it as non-normalized).
  if (/^\d+(\.\d+){3}$/.test(hostname)) {
    return hostname.split('.').every((octet) => {
      if (octet.length === 0 || octet.length > 3) return false;
      if (octet.length > 1 && octet.startsWith('0')) return false;
      const value = Number(octet);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    });
  }

  // Labels must be non-empty and shape-valid.
  const labels = hostname.split('.');
  if (labels.length === 0) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
  }

  // Round-trip through the WHATWG URL parser. If the parser normalizes the
  // hostname to a different string (e.g., percent-decoding, IDN mapping,
  // punycode expansion), the input was not already normalized.
  try {
    const roundTrip = new URL(`https://${hostname}/`).hostname;
    if (roundTrip !== hostname) return false;
  } catch {
    return false;
  }

  return true;
}

// ─── Handler Registration ───────────────────────────────────────────────────

const registrations = new WeakMap<object, ShellOpenExternalHandlerRegistration>();

/**
 * Registers the fixed `shell:open-external-v1` handler. Re-registering
 * against the same `ipcMain` replaces the prior registration and disposes
 * it — matching the pattern used by `registerAppBootstrapIPC`.
 */
export function registerShellOpenExternalHandler(
  deps: ShellOpenExternalHandlerDependencies,
): ShellOpenExternalHandlerRegistration {
  const { ipcMain, shell, logRejection } = deps;

  registrations.get(ipcMain as object)?.dispose();

  try {
    ipcMain.removeHandler(SHELL_OPEN_EXTERNAL_CHANNEL);
  } catch {
    // No prior handler — ignore.
  }

  const handler = async (
    _event: IpcMainInvokeEvent,
    rawRequest?: unknown,
  ): Promise<ExternalLinkResultV1> => {
    const parsed = ExternalLinkRequestV1Schema.safeParse(rawRequest);
    if (!parsed.success) {
      return produceRejection('invalid-request', logRejection);
    }

    const outcome = validateExternalLinkHref(parsed.data.href);
    if (outcome.kind === 'rejected') {
      return produceRejection(outcome.code, logRejection);
    }

    try {
      // Handing `parsed.href` (WHATWG-normalized) rather than the raw input
      // ensures `shell.openExternal` receives exactly the URL we validated.
      await shell.openExternal(outcome.url.href);
    } catch {
      // Never echo OS error text; return a fixed non-sensitive code.
      return produceRejection('shell-open-failed', logRejection);
    }

    return ExternalLinkResultV1Schema.parse({
      schemaVersion: 1,
      status: 'opened',
    });
  };

  ipcMain.handle(SHELL_OPEN_EXTERNAL_CHANNEL, handler);

  let disposed = false;
  const registration: ShellOpenExternalHandlerRegistration = {
    channel: SHELL_OPEN_EXTERNAL_CHANNEL,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (registrations.get(ipcMain as object) !== registration) return;
      try {
        ipcMain.removeHandler(SHELL_OPEN_EXTERNAL_CHANNEL);
      } catch {
        // Ignore — Electron surface is best-effort during teardown.
      }
      registrations.delete(ipcMain as object);
    },
  };
  registrations.set(ipcMain as object, registration);
  return registration;
}

function produceRejection(
  code: ExternalLinkRejectionCode,
  logRejection: ((code: ExternalLinkRejectionCode) => void) | undefined,
): ExternalLinkResultV1 {
  try {
    logRejection?.(code);
  } catch {
    // Logger failures cannot influence the caller-visible outcome.
  }
  return ExternalLinkResultV1Schema.parse({
    schemaVersion: 1,
    status: 'rejected',
    rejectionCode: code,
  });
}
