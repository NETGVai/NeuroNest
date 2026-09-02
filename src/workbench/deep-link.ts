/**
 * Deep links — workspace-relative stable identities for cross-surface
 * navigation (FUT-PKG-07-EXPERIENCE/T-003, NN-UI-003).
 *
 * Deep links connect requirements, tasks, chat nodes, files/ranges, diffs, tool
 * events, terminal evidence, checkpoints, and artifacts. Every link uses a
 * workspace-relative stable identity and AVOIDS absolute-path disclosure by
 * default (NN-UI-003, NN-INV-004): {@link makeFileLink}/{@link makeRangeLink}
 * normalize a path to a workspace-relative POSIX form and REFUSE an absolute
 * host path or a path that escapes the workspace with a typed error. Serialized
 * links round-trip losslessly so a stored/shared link resolves to the same
 * target (deterministic, no ambient state).
 *
 * Design anchors: D-03, D-16 (typed path references). Requirements: NN-UI-003,
 * NN-INV-004.
 */

import path from 'node:path';

import {
  CONTRACT_WRITE_VERSION,
  type ErrorCode,
  type ErrorEnvelope,
} from '../shared/contract-primitives.js';
import type { DeepLink, DeepLinkKind, LinkRange } from './workbench-types.js';

/** The workbench view authority owner id stamped on link errors. */
export const WORKBENCH_LINK_OWNER = 'authority-renderer-workbench';

/** A typed deep-link failure (e.g. an absolute-path disclosure attempt). */
export class DeepLinkError extends Error {
  readonly error: ErrorEnvelope;
  constructor(error: ErrorEnvelope) {
    super(error.message);
    this.name = 'DeepLinkError';
    this.error = error;
  }
}

function linkError(code: ErrorCode, message: string, correlationId: string): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: WORKBENCH_LINK_OWNER,
    operation: 'deep-link',
    correlationId,
    retryable: false,
    redaction: 'internal',
  };
}

/**
 * Normalize a workspace-relative POSIX path. Refuses (typed FORBIDDEN) an
 * absolute host path or a path that escapes the workspace root via `..`, so a
 * deep link never discloses a private absolute path (NN-UI-003, NN-INV-004).
 * Backslashes are normalized to POSIX separators and a leading `./` is dropped.
 */
export function normalizeWorkspaceRelative(rawPath: string, correlationId = 'corr-link'): string {
  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
    throw new DeepLinkError(
      linkError(
        'FORBIDDEN',
        'deep link path must be workspace-relative, not an absolute host path',
        correlationId,
      ),
    );
  }
  const posix = rawPath.split('\\').join('/');
  const normalized = path.posix.normalize(posix).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new DeepLinkError(
      linkError('FORBIDDEN', 'deep link path escapes the workspace root', correlationId),
    );
  }
  return normalized;
}

/** Build a workspace-relative file deep link (NN-UI-003). */
export function makeFileLink(relativePath: string, correlationId?: string): DeepLink {
  return {
    kind: 'file',
    relativePath: normalizeWorkspaceRelative(relativePath, correlationId),
    range: null,
    anchorId: null,
  };
}

/** Build a workspace-relative range deep link (file + inclusive range). */
export function makeRangeLink(
  relativePath: string,
  range: LinkRange,
  correlationId?: string,
): DeepLink {
  assertRange(range, correlationId ?? 'corr-link');
  return {
    kind: 'range',
    relativePath: normalizeWorkspaceRelative(relativePath, correlationId),
    range,
    anchorId: null,
  };
}

/** Build an anchor-only deep link (chat node, tool event, checkpoint, …). */
export function makeAnchorLink(kind: DeepLinkKind, anchorId: string): DeepLink {
  return { kind, relativePath: null, range: null, anchorId };
}

/**
 * Serialize a deep link to a stable, workspace-relative URI string. The scheme
 * carries no host prefix; a range is encoded as `#Lstart:col-Lend:col`.
 */
export function serializeDeepLink(link: DeepLink): string {
  const base = `nn:${link.kind}`;
  if (link.relativePath !== null) {
    const rangeSuffix =
      link.range !== null
        ? `#L${link.range.startLine}:${link.range.startColumn}-L${link.range.endLine}:${link.range.endColumn}`
        : '';
    return `${base}/${encodeURI(link.relativePath)}${rangeSuffix}`;
  }
  return `${base}/@${encodeURIComponent(link.anchorId ?? '')}`;
}

/** Parse a serialized deep link back to its structured form (round-trip). */
export function parseDeepLink(uri: string, correlationId = 'corr-link'): DeepLink {
  const match = /^nn:([a-zA-Z]+)\/(.*)$/.exec(uri);
  if (!match) {
    throw new DeepLinkError(linkError('VALIDATION', 'malformed deep link uri', correlationId));
  }
  const kind = match[1] as DeepLinkKind;
  const rest = match[2]!;
  if (rest.startsWith('@')) {
    return { kind, relativePath: null, range: null, anchorId: decodeURIComponent(rest.slice(1)) };
  }
  const hashIndex = rest.indexOf('#L');
  const pathPart = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  const relativePath = normalizeWorkspaceRelative(decodeURI(pathPart), correlationId);
  let range: LinkRange | null = null;
  if (hashIndex >= 0) {
    const rangeMatch = /^#L(\d+):(\d+)-L(\d+):(\d+)$/.exec(rest.slice(hashIndex));
    if (!rangeMatch) {
      throw new DeepLinkError(linkError('VALIDATION', 'malformed deep link range', correlationId));
    }
    range = {
      startLine: Number(rangeMatch[1]),
      startColumn: Number(rangeMatch[2]),
      endLine: Number(rangeMatch[3]),
      endColumn: Number(rangeMatch[4]),
    };
    assertRange(range, correlationId);
  }
  return { kind, relativePath, range, anchorId: null };
}

function assertRange(range: LinkRange, correlationId: string): void {
  const positive =
    Number.isInteger(range.startLine) &&
    Number.isInteger(range.startColumn) &&
    Number.isInteger(range.endLine) &&
    Number.isInteger(range.endColumn) &&
    range.startLine >= 1 &&
    range.startColumn >= 1 &&
    range.endLine >= 1 &&
    range.endColumn >= 1;
  const ordered =
    range.endLine > range.startLine ||
    (range.endLine === range.startLine && range.endColumn >= range.startColumn);
  if (!positive || !ordered) {
    throw new DeepLinkError(linkError('VALIDATION', 'deep link range is not a valid 1-based ordered range', correlationId));
  }
}
