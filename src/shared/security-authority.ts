/**
 * Security Authority — centralized, deny-by-default policy layer (D-05, D-16).
 *
 * Implements the SecurityAuthority component (D-05) as the single place that
 * decides path, command, network, SSRF, and exclusion/privacy questions before
 * any effect. Every scattered check in `src/security`, `src/terminal`,
 * `src/channels`, etc. is meant to call *through* this authority as an adapter;
 * a feature flag can never bypass the safety floor (NN-INV-002).
 *
 * The controls implemented here are pure and synchronous where the decision is
 * a pure function of policy + input (path containment, command tiers, network
 * rule evaluation, SSRF address classification, exclusion matching). DNS
 * resolution itself is injected so the authority stays testable and so the
 * DNS-rebinding recheck can be exercised deterministically (D-16.5).
 *
 * Ordering (NN-SEC-002): every combined evaluation walks the fixed order
 *
 *   scope+path → agent/tool permission → firewall/command/network → credential
 *   scope → sandbox → budget → approval
 *
 * and stops at the first denial. Unknown values default to deny; an unmatched
 * command defaults to `ask` (NN-SEC-006). No decision, reason, or audit record
 * ever contains a raw secret or a private absolute path (NN-INV-001/004).
 *
 * This task is deliberately additive (FUT-PKG-04-SECURITY/T-004): the authority
 * is a new central decision surface and typed adapters. Rollback restores a
 * *stricter* validated adapter, never an open default (task rollback rule).
 *
 * Design anchors: D-03 (trust boundaries), D-05 (SecurityAuthority), D-11
 * (fail-closed tool sequence), D-16 (security/privacy), D-18.
 * Requirements: NN-INV-001/004/005, NN-SEC-001/002/005/006/007/014,
 * NN-CONTEXT exclusions.
 */

import * as nodePath from 'node:path';
import * as fs from 'node:fs';

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type RedactionClass,
} from './contract-primitives';

// ─── Common decision types ──────────────────────────────────────────────────

/**
 * The stage of the ordered policy evaluation (NN-SEC-002). A denial names the
 * stage it stopped at so audit can show *why* without leaking the input.
 */
export const POLICY_STAGES = Object.freeze([
  'scope-path',
  'agent-tool-permission',
  'firewall-command-network',
  'credential-scope',
  'sandbox',
  'budget',
  'approval',
] as const);
export type PolicyStage = (typeof POLICY_STAGES)[number];

/**
 * The disposition of a security decision.
 *
 *   - `allow` — the operation may proceed under least privilege.
 *   - `ask`   — a human/approval decision is required before any effect; this
 *     is the fail-safe default for an unmatched command (NN-SEC-006).
 *   - `deny`  — the operation is forbidden and MUST have no effect
 *     (no read/write/spawn/transmit).
 */
export const DECISIONS = Object.freeze(['allow', 'ask', 'deny'] as const);
export type Decision = (typeof DECISIONS)[number];

/**
 * A typed decision. `deny`/`ask` carry a typed {@link ErrorEnvelope}
 * (`FORBIDDEN` for deny, `UNAVAILABLE`/`VALIDATION` where noted) whose message
 * is pre-redacted: it never contains a raw secret or a private absolute path
 * (NN-INV-004). `allow` may carry a normalized artifact (e.g. a canonical
 * `PathRef`) that the caller uses instead of the raw input.
 */
export type SecurityDecision<T = undefined> =
  | {
      readonly decision: 'allow';
      readonly stage: PolicyStage;
      readonly reason: string;
      readonly value: T;
    }
  | {
      readonly decision: 'ask';
      readonly stage: PolicyStage;
      readonly reason: string;
      readonly error: ErrorEnvelope;
    }
  | {
      readonly decision: 'deny';
      readonly stage: PolicyStage;
      readonly reason: string;
      readonly error: ErrorEnvelope;
    };

/** Options threaded into every typed error this authority produces. */
export interface DecisionContext {
  /** Correlation id for the audit trail; a safe fallback is used if absent. */
  readonly correlationId?: string;
  /** Operation label for the ErrorEnvelope. */
  readonly operation?: string;
}

const AUTHORITY_OWNER = 'authority-security';

/**
 * Build a pre-redacted typed error. `message` is assumed already safe (the
 * callers below never interpolate a raw secret or an absolute private path into
 * it — they use the *relative* or *class* representation). Redaction defaults to
 * `internal` so it never crosses to the renderer as-is without a further
 * redaction pass (D-16.6).
 */
function securityError(
  code: ErrorCode,
  message: string,
  stage: PolicyStage,
  ctx: DecisionContext,
  redaction: RedactionClass = 'internal',
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: AUTHORITY_OWNER,
    operation: ctx.operation ?? `security:${stage}`,
    correlationId: isOpaqueId(ctx.correlationId) ? ctx.correlationId : 'corr-unset',
    retryable: code === 'VALIDATION',
    redaction,
  };
}

function allow<T>(stage: PolicyStage, reason: string, value: T): SecurityDecision<T> {
  return { decision: 'allow', stage, reason, value };
}

function deny(
  stage: PolicyStage,
  reason: string,
  ctx: DecisionContext,
  code: ErrorCode = 'FORBIDDEN',
): SecurityDecision<never> {
  return { decision: 'deny', stage, reason, error: securityError(code, reason, stage, ctx) };
}

function ask(stage: PolicyStage, reason: string, ctx: DecisionContext): SecurityDecision<never> {
  // `ask` is a fail-safe pause, not a failure: modeled as FORBIDDEN-until-approved
  // so an accidental "truthy decision" bug still cannot proceed (NN-INV-001).
  return { decision: 'ask', stage, reason, error: securityError('FORBIDDEN', reason, stage, ctx) };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Path canonicalization and containment (NN-SEC-005, D-16.3)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A validated typed path reference. `relative` is the POSIX-normalized path
 * *relative to the containing root* and is the only representation safe to log
 * or surface (NN-INV-004): the absolute path stays inside the authority. The
 * caller performs I/O against `absolute` but never echoes it outward.
 */
export interface PathRef {
  /** Absolute canonical path. Private — never logged/serialized outward. */
  readonly absolute: string;
  /** POSIX-normalized path relative to the root; safe for audit/display. */
  readonly relative: string;
  /** Whether the concrete target currently exists on disk. */
  readonly exists: boolean;
}

/** Options for {@link evaluatePath}. */
export interface PathPolicyOptions {
  /**
   * When true (default), resolve symbolic links with `fs.realpathSync` and
   * verify the *real* path is still contained. This is the no-follow/open-safe
   * containment check that blocks symlink escape (D-16.3). Disable only for a
   * pure logical check with no filesystem access.
   */
  readonly followSymlinks?: boolean;
}

/** A control character / NUL / device-path rejection reason, or `null` if clean. */
function rejectHostilePathShape(inputPath: string): string | null {
  if (inputPath.length === 0) return 'empty path';
  // NUL byte and other control chars can truncate/confuse OS path handling.
  if (inputPath.includes('\u0000')) return 'path contains a NUL byte';
  // Windows device namespace (`\\.\` or `\\?\`) and alternate data streams
  // (D-16.3, D-17). Checked with string ops to avoid backslash-regex ambiguity.
  if (inputPath.startsWith('\\\\.\\') || inputPath.startsWith('\\\\?\\')) {
    return 'path uses a device namespace';
  }
  return null;
}

/**
 * Canonicalize `inputPath` against `root` and verify containment. Blocks:
 *   - `..` traversal that escapes the root (logical check, before any I/O),
 *   - unauthorized absolute paths outside the root,
 *   - symlink escape (the *real* path of the target or its parent leaves root),
 *   - NUL bytes and device namespaces.
 *
 * Containment uses canonical path *segment* comparison, never a string prefix
 * (D-17 "no string-prefix containment"): `/root-evil` is not inside `/root`.
 *
 * Returns an `allow` decision carrying a {@link PathRef} on success, or a typed
 * `deny` (`FORBIDDEN`) whose reason references only the relative or attempted
 * input, never a resolved private absolute path (NN-INV-004).
 */
export function evaluatePath(
  inputPath: string,
  root: string,
  options: PathPolicyOptions = {},
  ctx: DecisionContext = {},
): SecurityDecision<PathRef> {
  const stage: PolicyStage = 'scope-path';
  const followSymlinks = options.followSymlinks ?? true;

  const hostile = rejectHostilePathShape(inputPath);
  if (hostile) {
    return deny(stage, `path rejected: ${hostile}`, ctx, 'VALIDATION');
  }

  // Logical resolution first: catches `..` escape BEFORE touching the filesystem.
  const logicalRoot = nodePath.resolve(root);
  const logicalResolved = nodePath.isAbsolute(inputPath)
    ? nodePath.normalize(inputPath)
    : nodePath.resolve(logicalRoot, inputPath);

  if (!isContained(logicalResolved, logicalRoot)) {
    return deny(
      stage,
      `path "${safeRelative(logicalRoot, inputPath)}" resolves outside the allowed root`,
      ctx,
    );
  }

  if (!followSymlinks) {
    return allow(stage, 'logical containment satisfied (symlink check skipped)', {
      absolute: logicalResolved,
      relative: toPosixRelative(logicalRoot, logicalResolved),
      exists: safeExists(logicalResolved),
    });
  }

  // Real-path (symlink-following) containment. The realpath of the target — or,
  // for a not-yet-existing target, of its parent — must remain inside the
  // realpath of the root. This blocks a symlink that points outside root.
  const realRoot = safeRealpath(logicalRoot) ?? logicalRoot;

  const realTarget = safeRealpath(logicalResolved);
  if (realTarget !== null) {
    if (!isContained(realTarget, realRoot)) {
      return deny(
        stage,
        `path "${toPosixRelative(logicalRoot, logicalResolved)}" escapes the root via a symbolic link`,
        ctx,
      );
    }
    return allow(stage, 'path contained after symlink resolution', {
      absolute: realTarget,
      relative: toPosixRelative(realRoot, realTarget),
      exists: true,
    });
  }

  // Target does not exist yet (write scenario): validate the parent directory's
  // realpath instead, then re-attach the basename.
  const parentDir = nodePath.dirname(logicalResolved);
  const realParent = safeRealpath(parentDir);
  if (realParent === null) {
    return deny(
      stage,
      `path "${toPosixRelative(logicalRoot, logicalResolved)}" has no resolvable parent directory`,
      ctx,
      'VALIDATION',
    );
  }
  if (!isContained(realParent, realRoot)) {
    return deny(
      stage,
      `parent of "${toPosixRelative(logicalRoot, logicalResolved)}" escapes the root via a symbolic link`,
      ctx,
    );
  }
  const resolvedAbsolute = nodePath.join(realParent, nodePath.basename(logicalResolved));
  return allow(stage, 'parent contained after symlink resolution', {
    absolute: resolvedAbsolute,
    relative: toPosixRelative(realRoot, resolvedAbsolute),
    exists: false,
  });
}

/**
 * Canonical *segment-wise* containment: `child` is contained in `root` iff it
 * equals `root` or is a descendant of `root`. Uses `path.relative` so a sibling
 * like `/root-evil` (which shares the `/root` string prefix) is correctly
 * rejected (D-17).
 */
export function isContained(child: string, root: string): boolean {
  const rel = nodePath.relative(root, child);
  if (rel === '') return true; // same path
  // Escapes if the relative path climbs out (`..`) or is absolute (different volume).
  if (rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
    return false;
  }
  return true;
}

function toPosixRelative(root: string, absolute: string): string {
  const rel = nodePath.relative(root, absolute);
  return rel.split(nodePath.sep).join('/');
}

/** Safe relative representation of the *attempted* input for messages. */
function safeRelative(root: string, inputPath: string): string {
  if (!nodePath.isAbsolute(inputPath)) return inputPath.split(nodePath.sep).join('/');
  return toPosixRelative(root, nodePath.normalize(inputPath));
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function safeExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Command policy — ordered deny → ask → allow tiers (NN-SEC-006, D-16.3)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A command match rule. A rule matches by executable basename (exact) and/or a
 * substring/argument predicate. Rules never trigger shell interpretation; the
 * command is always structured `{ executable, args }` (NN-SEC-006).
 */
export interface CommandRule {
  readonly id: string;
  /** Executable basename this rule applies to (`*` matches any). */
  readonly executable: string;
  /**
   * Optional argv substrings that must ALL be present (case-insensitive) for
   * the rule to match. Empty/absent means "match on executable alone".
   */
  readonly argContains?: readonly string[];
  readonly description?: string;
}

/**
 * The three ordered command tiers (NN-SEC-006). Evaluated deny → ask → allow;
 * an unmatched command uses `defaultDecision` whose factory value is `ask`.
 */
export interface CommandPolicy {
  readonly denyRules: readonly CommandRule[];
  readonly askRules: readonly CommandRule[];
  readonly allowRules: readonly CommandRule[];
  /** Factory default is `ask` (NN-SEC-006). */
  readonly defaultDecision: Decision;
}

/** A structured command — never a shell string (NN-SEC-006, D-16.3). */
export interface StructuredCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/** Shell metacharacters that indicate an attempt at shell interpolation. */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r]|\$\(|&&|\|\|/;

/** The factory-default command policy: deny-nothing-extra, ask by default. */
export function defaultCommandPolicy(): CommandPolicy {
  return {
    denyRules: [
      { id: 'deny-rm-rf', executable: 'rm', argContains: ['-rf'], description: 'recursive force delete' },
      { id: 'deny-mkfs', executable: 'mkfs', description: 'filesystem format' },
      { id: 'deny-dd', executable: 'dd', description: 'raw disk write' },
    ],
    askRules: [
      { id: 'ask-git-push', executable: 'git', argContains: ['push'], description: 'publishes commits' },
      { id: 'ask-npm-install', executable: 'npm', argContains: ['install'], description: 'runs install scripts' },
    ],
    allowRules: [
      { id: 'allow-git-status', executable: 'git', argContains: ['status'] },
      { id: 'allow-ls', executable: 'ls' },
      { id: 'allow-cat', executable: 'cat' },
    ],
    defaultDecision: 'ask',
  };
}

function ruleMatches(rule: CommandRule, command: StructuredCommand): boolean {
  const base = nodePath.basename(command.executable).toLowerCase();
  const ruleExe = rule.executable.toLowerCase();
  if (ruleExe !== '*' && ruleExe !== base) return false;
  if (!rule.argContains || rule.argContains.length === 0) return true;
  const argvLower = command.args.map((a) => a.toLowerCase());
  return rule.argContains.every((needle) =>
    argvLower.some((arg) => arg.includes(needle.toLowerCase())),
  );
}

/**
 * Evaluate a structured command against the ordered deny → ask → allow tiers
 * (NN-SEC-006). Any attempt to smuggle shell metacharacters through the
 * executable field is rejected up front as `VALIDATION` (structured argv only;
 * shell interpolation requires a separate trusted-terminal contract, D-16.3).
 * An unmatched command falls to `policy.defaultDecision` (factory `ask`).
 */
export function evaluateCommand(
  command: StructuredCommand,
  policy: CommandPolicy = defaultCommandPolicy(),
  ctx: DecisionContext = {},
): SecurityDecision<StructuredCommand> {
  const stage: PolicyStage = 'firewall-command-network';

  if (typeof command.executable !== 'string' || command.executable.length === 0) {
    return deny(stage, 'command executable is empty', ctx, 'VALIDATION');
  }
  // The executable must be a program, not a shell one-liner.
  if (SHELL_METACHARACTERS.test(command.executable)) {
    return deny(
      stage,
      'command executable contains shell metacharacters; structured argv is required',
      ctx,
      'VALIDATION',
    );
  }

  // Ordered tiers: deny first, then ask, then allow.
  for (const rule of policy.denyRules) {
    if (ruleMatches(rule, command)) {
      return deny(stage, `command denied by rule ${rule.id}`, ctx);
    }
  }
  for (const rule of policy.askRules) {
    if (ruleMatches(rule, command)) {
      return ask(stage, `command requires approval by rule ${rule.id}`, ctx);
    }
  }
  for (const rule of policy.allowRules) {
    if (ruleMatches(rule, command)) {
      return allow(stage, `command allowed by rule ${rule.id}`, command);
    }
  }

  // Unmatched → validated default (factory ask).
  if (policy.defaultDecision === 'allow') {
    return allow(stage, 'command allowed by default policy', command);
  }
  if (policy.defaultDecision === 'deny') {
    return deny(stage, 'command denied by default policy', ctx);
  }
  return ask(stage, 'command unmatched; default policy requires approval', ctx);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Network / firewall policy + SSRF + DNS rebinding (NN-SEC-007, D-16.5)
// ════════════════════════════════════════════════════════════════════════════

/** Network policy presets (NN-SEC-007). */
export const NETWORK_PRESETS = Object.freeze(['permissive', 'standard', 'strict'] as const);
export type NetworkPreset = (typeof NETWORK_PRESETS)[number];

/** A domain/IP-range/port allow-or-deny rule (NN-SEC-007). */
export interface NetworkRule {
  readonly id: string;
  readonly action: 'allow' | 'deny';
  /** Domain pattern; supports a single leading `*.` wildcard, or `*` for any. */
  readonly domain?: string;
  /** IPv4 CIDR (`10.0.0.0/8`) or exact IPv4 address. */
  readonly ipRange?: string;
  /** Port number or `start-end` range. */
  readonly port?: number | string;
  readonly description?: string;
}

/** A resolved network policy (NN-SEC-007). */
export interface NetworkPolicy {
  readonly preset: NetworkPreset;
  readonly allowRules: readonly NetworkRule[];
  readonly denyRules: readonly NetworkRule[];
  /** Explicit allowlist domains for `strict` (allowlist-only). */
  readonly strictAllowlist?: readonly string[];
  /** Max HTTP redirects to follow before the request is denied (D-16.5). */
  readonly maxRedirects: number;
}

/** Permitted URL schemes; everything else (file/data/javascript) is denied. */
const ALLOWED_SCHEMES = Object.freeze(['http:', 'https:']);

/** Cloud metadata endpoints — always blocked as SSRF targets (D-16.5). */
const METADATA_HOSTS = Object.freeze([
  '169.254.169.254', // AWS/GCP/Azure IMDS
  'metadata.google.internal',
  'metadata.goog',
  'fd00:ec2::254',
]);

/** Build a named preset policy (NN-SEC-007). */
export function networkPreset(preset: NetworkPreset, strictAllowlist?: readonly string[]): NetworkPolicy {
  switch (preset) {
    case 'permissive':
      return {
        preset,
        allowRules: [{ id: 'permissive-all', action: 'allow', domain: '*' }],
        denyRules: [],
        maxRedirects: 5,
      };
    case 'strict': {
      const domains = strictAllowlist ?? [];
      return {
        preset,
        allowRules: domains.map((domain, i) => ({ id: `strict-allow-${i}`, action: 'allow', domain })),
        denyRules: [],
        strictAllowlist: domains,
        maxRedirects: 2,
      };
    }
    case 'standard':
    default:
      return {
        preset: 'standard',
        allowRules: [],
        denyRules: [
          { id: 'std-deny-ngrok', action: 'deny', domain: '*.ngrok.io', description: 'exfiltration tunnel' },
          { id: 'std-deny-webhook', action: 'deny', domain: '*.webhook.site', description: 'exfiltration sink' },
        ],
        maxRedirects: 4,
      };
  }
}

/** IPv4 dotted-quad → 32-bit number, or `null` if malformed. */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

/** Whether `ip` (IPv4) is inside CIDR/exact `range`. */
export function ipv4InRange(ip: string, range: string): boolean {
  if (!range.includes('/')) return ip === range;
  const [base, prefixStr] = range.split('/');
  const prefix = Number(prefixStr);
  if (!base || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipN = ipv4ToNumber(ip);
  const baseN = ipv4ToNumber(base);
  if (ipN === null || baseN === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

/**
 * Whether an address is a forbidden SSRF target: loopback, link-local,
 * multicast, private, reserved, unspecified, or a cloud metadata host (D-16.5).
 * Covers IPv4 and the common IPv6 forms. Deny-by-default: an address that
 * cannot be classified as clearly public is treated as private.
 */
export function isForbiddenAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');

  if ((METADATA_HOSTS as readonly string[]).includes(host)) return true;

  // IPv6 classes.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (host.startsWith('fe80') || host.startsWith('fec0')) return true; // link/site-local
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique-local
    if (host.startsWith('ff')) return true; // multicast
    if (host.startsWith('::ffff:')) {
      // IPv4-mapped IPv6 — classify the embedded IPv4.
      return isForbiddenAddress(host.slice('::ffff:'.length));
    }
    // Unrecognized IPv6 → deny-by-default.
    return true;
  }

  const n = ipv4ToNumber(host);
  if (n === null) {
    // Not a bare IPv4 literal → caller must resolve it first; treat as public
    // here (domain-level rules handle names). Resolution + recheck happens in
    // evaluateNetworkResolved.
    return false;
  }
  // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10 (CGNAT),
  // 224/4 multicast, 240/4 reserved.
  return (
    ipv4InRange(host, '0.0.0.0/8') ||
    ipv4InRange(host, '10.0.0.0/8') ||
    ipv4InRange(host, '127.0.0.0/8') ||
    ipv4InRange(host, '169.254.0.0/16') ||
    ipv4InRange(host, '172.16.0.0/12') ||
    ipv4InRange(host, '192.168.0.0/16') ||
    ipv4InRange(host, '100.64.0.0/10') ||
    ipv4InRange(host, '224.0.0.0/4') ||
    ipv4InRange(host, '240.0.0.0/4')
  );
}

/** Single leading-wildcard domain match (`*.example.com`, `example.com`, `*`). */
export function domainMatches(domain: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const d = domain.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return d === suffix || d.endsWith(`.${suffix}`);
  }
  return d === p;
}

function ruleTargets(rule: NetworkRule, domain: string, port: number, ip?: string): boolean {
  let criteria = 0;
  let hits = 0;
  if (rule.domain !== undefined) {
    criteria++;
    if (domainMatches(domain, rule.domain)) hits++;
  }
  if (rule.port !== undefined) {
    criteria++;
    if (portMatches(port, rule.port)) hits++;
  }
  if (rule.ipRange !== undefined && ip) {
    criteria++;
    if (ipv4InRange(ip, rule.ipRange)) hits++;
  }
  return criteria > 0 && hits === criteria;
}

function portMatches(port: number, rulePort: number | string): boolean {
  if (typeof rulePort === 'number') return port === rulePort;
  const [a, b] = rulePort.split('-');
  const lo = Number(a);
  const hi = Number(b);
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
  return port >= lo && port <= hi;
}

/**
 * Rule-level policy evaluation for an already-classified destination
 * (domain + port [+ resolved ip]). Deny rules win over allow; `standard` allows
 * anything not explicitly denied; `strict` denies anything not explicitly
 * allowed (allowlist-only); unknown preset → deny (NN-SEC-007, NN-INV-001).
 */
function evaluateRules(
  policy: NetworkPolicy,
  domain: string,
  port: number,
  ip: string | undefined,
): { allowed: boolean; reason: string } {
  for (const rule of policy.denyRules) {
    if (ruleTargets(rule, domain, port, ip)) {
      return { allowed: false, reason: `blocked by deny rule ${rule.id}` };
    }
  }
  switch (policy.preset) {
    case 'permissive':
      return { allowed: true, reason: 'permissive preset' };
    case 'standard':
      return { allowed: true, reason: 'standard preset: not in deny list' };
    case 'strict': {
      for (const rule of policy.allowRules) {
        if (ruleTargets(rule, domain, port, ip)) {
          return { allowed: true, reason: `allowed by rule ${rule.id}` };
        }
      }
      return { allowed: false, reason: 'strict preset: destination not in allowlist' };
    }
    default:
      return { allowed: false, reason: 'unknown network preset (deny-by-default)' };
  }
}

/** Parsed destination used across the network checks. */
export interface Destination {
  readonly url: string;
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
}

/**
 * Parse and pre-screen a URL before any DNS resolution or connection (D-16.5):
 *   - reject non-http(s) schemes (file/data/javascript/etc.),
 *   - reject credentials embedded in the URL,
 *   - reject a host that is a literal forbidden IP or metadata endpoint.
 *
 * Returns the parsed {@link Destination} on `allow`, else a typed `deny`.
 */
export function evaluateUrl(
  url: string,
  policy: NetworkPolicy,
  ctx: DecisionContext = {},
): SecurityDecision<Destination> {
  const stage: PolicyStage = 'firewall-command-network';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny(stage, 'malformed URL', ctx, 'VALIDATION');
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return deny(stage, `scheme "${parsed.protocol}" is not permitted`, ctx);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return deny(stage, 'credentials in URL are not permitted', ctx);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

  if (isForbiddenAddress(host)) {
    return deny(stage, `destination host is a forbidden (private/loopback/metadata) address`, ctx);
  }

  const dest: Destination = { url, scheme: parsed.protocol, host, port };

  // Apply domain/port rules on the name (IP rules applied after resolution).
  const ruleResult = evaluateRules(policy, host, port, undefined);
  if (!ruleResult.allowed) {
    return deny(stage, `destination "${host}:${port}" ${ruleResult.reason}`, ctx);
  }
  return allow(stage, `URL pre-screen passed (${ruleResult.reason})`, dest);
}

/**
 * DNS-rebinding-resistant recheck (D-16.5). Given the destination and the set
 * of addresses the host actually resolved to, re-run the SSRF classification
 * and the IP-range rules against *every* resolved address. If any resolved
 * address is a forbidden target — or violates the policy — the whole request is
 * denied. This defeats a name that pre-screened as public but resolves to a
 * loopback/link-local/private address (classic DNS rebinding).
 */
export function evaluateResolvedAddresses(
  dest: Destination,
  resolvedAddresses: readonly string[],
  policy: NetworkPolicy,
  ctx: DecisionContext = {},
): SecurityDecision<Destination> {
  const stage: PolicyStage = 'firewall-command-network';
  if (resolvedAddresses.length === 0) {
    return deny(stage, 'host did not resolve to any address', ctx, 'UNAVAILABLE');
  }
  for (const addr of resolvedAddresses) {
    if (isForbiddenAddress(addr)) {
      return deny(
        stage,
        'resolved address is a forbidden (private/loopback/metadata) target — possible DNS rebinding',
        ctx,
      );
    }
    const ruleResult = evaluateRules(policy, dest.host, dest.port, addr);
    if (!ruleResult.allowed) {
      return deny(stage, `resolved destination ${ruleResult.reason}`, ctx);
    }
  }
  return allow(stage, 'all resolved addresses passed SSRF and rule checks', dest);
}

/**
 * Full network destination evaluation with an injected resolver so the
 * DNS-rebinding recheck is deterministic and testable (D-16.5). Order:
 *   1. URL pre-screen (scheme/credentials/literal-IP/name rules),
 *   2. resolve the host,
 *   3. recheck every resolved address (SSRF + IP rules).
 * Any failure denies with no connection.
 */
export function evaluateNetworkDestination(
  url: string,
  policy: NetworkPolicy,
  resolve: (host: string) => readonly string[],
  ctx: DecisionContext = {},
): SecurityDecision<Destination> {
  const pre = evaluateUrl(url, policy, ctx);
  if (pre.decision !== 'allow') return pre;
  let resolved: readonly string[];
  try {
    resolved = resolve(pre.value.host);
  } catch {
    return deny('firewall-command-network', 'host resolution failed', ctx, 'UNAVAILABLE');
  }
  return evaluateResolvedAddresses(pre.value, resolved, policy, ctx);
}

/** Whether a redirect count is within the policy budget (D-16.5). */
export function redirectWithinLimit(count: number, policy: NetworkPolicy): boolean {
  return Number.isInteger(count) && count >= 0 && count <= policy.maxRedirects;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Exclusion / privacy — applied before egress (NN-SEC-014, NN-CONTEXT-004)
// ════════════════════════════════════════════════════════════════════════════

/** A destination class that exclusion runs before (NN-SEC-014). */
export const EGRESS_CHANNELS = Object.freeze([
  'index',
  'prompt',
  'telemetry',
  'export',
  'training',
  'cloud',
  'fan-out',
] as const);
export type EgressChannel = (typeof EGRESS_CHANNELS)[number];

/**
 * The exclusion inputs that apply before any egress (NN-SEC-014):
 *   - `.neuronestignore` and `.gitignore` glob patterns,
 *   - explicit private path classifications,
 *   - a redaction ceiling (paths classified `sensitive`/`secret` never egress).
 * Derived embeddings/caches/traces inherit this exclusion by construction —
 * they are computed only from content that already passed this gate.
 */
export interface ExclusionPolicy {
  /** gitignore-style glob patterns from `.gitignore`/`.neuronestignore`. */
  readonly patterns: readonly string[];
  /** Relative paths explicitly classified private (exact or prefix). */
  readonly privatePaths: readonly string[];
}

/** Parse a gitignore/neuronestignore file body into patterns. */
export function parseIgnorePatterns(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'));
}

/** Convert a gitignore-style glob to a RegExp anchored on path segments. */
function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/');
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  const prefix = anchored ? '^' : '(^|.*/)';
  const suffix = dirOnly ? '(/.*)?$' : '(/.*)?$';
  return new RegExp(`${prefix}${re}${suffix}`);
}

/**
 * Whether a relative path is excluded by the policy (matched an ignore pattern,
 * or lies under an explicitly private path). Path is normalized to POSIX and
 * matched segment-aware so `secret/` also excludes `secret/inner.txt`.
 */
export function isPathExcluded(relativePath: string, policy: ExclusionPolicy): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const priv of policy.privatePaths) {
    const p = priv.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (normalized === p || normalized.startsWith(`${p}/`)) return true;
  }
  for (const pattern of policy.patterns) {
    if (globToRegExp(pattern).test(normalized)) return true;
  }
  return false;
}

/**
 * Gate a candidate path before egress on `channel` (NN-SEC-014,
 * NN-CONTEXT-004). Excluded content produces a `deny` with no leak of the
 * excluded content; allowed content proceeds. This is the "exclusion first"
 * check that must run before file contents, symbols, embeddings, or derived
 * summaries enter any egress path.
 */
export function evaluateExclusion(
  relativePath: string,
  channel: EgressChannel,
  policy: ExclusionPolicy,
  ctx: DecisionContext = {},
): SecurityDecision<{ relativePath: string; channel: EgressChannel }> {
  const stage: PolicyStage = 'scope-path';
  if (isPathExcluded(relativePath, policy)) {
    return deny(
      stage,
      `"${relativePath.replace(/\\/g, '/')}" is excluded from ${channel} by ignore/privacy policy`,
      ctx,
    );
  }
  return allow(stage, `path permitted for ${channel}`, {
    relativePath: relativePath.replace(/\\/g, '/'),
    channel,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Ordered, deny-by-default combined evaluation (NN-SEC-002, D-11)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A single ordered check: a stage label and a thunk that returns a decision.
 * The combined evaluator runs checks in {@link POLICY_STAGES} order and stops
 * at the first non-`allow`, so a denial short-circuits every later stage
 * (NN-SEC-002). This models "policy immediately before effect" (D-03.1).
 */
export interface OrderedCheck {
  readonly stage: PolicyStage;
  readonly run: () => SecurityDecision<unknown>;
}

/** The outcome of a combined evaluation. */
export type CombinedOutcome =
  | { readonly decision: 'allow'; readonly stages: readonly PolicyStage[] }
  | {
      readonly decision: 'ask' | 'deny';
      readonly stage: PolicyStage;
      readonly reason: string;
      readonly error: ErrorEnvelope;
    };

const STAGE_ORDER: Readonly<Record<PolicyStage, number>> = Object.freeze({
  'scope-path': 0,
  'agent-tool-permission': 1,
  'firewall-command-network': 2,
  'credential-scope': 3,
  sandbox: 4,
  budget: 5,
  approval: 6,
});

/**
 * Run ordered checks in canonical NN-SEC-002 order and stop at the first denial
 * or ask. Checks are sorted by stage so a caller cannot reorder the pipeline to
 * evaluate approval before path containment. If every check allows, the result
 * is `allow` with the list of stages that ran. If the check list is empty, the
 * result is a deny-by-default (NN-INV-001): an operation with no evaluated
 * policy is never permitted.
 */
export function evaluateOrdered(
  checks: readonly OrderedCheck[],
  ctx: DecisionContext = {},
): CombinedOutcome {
  if (checks.length === 0) {
    const stage: PolicyStage = 'scope-path';
    return {
      decision: 'deny',
      stage,
      reason: 'no policy evaluated; deny-by-default',
      error: securityError('FORBIDDEN', 'no policy evaluated; deny-by-default', stage, ctx),
    };
  }
  const ordered = [...checks].sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]);
  const ran: PolicyStage[] = [];
  for (const check of ordered) {
    const result = check.run();
    ran.push(check.stage);
    if (result.decision !== 'allow') {
      return {
        decision: result.decision,
        stage: result.stage,
        reason: result.reason,
        error: result.error,
      };
    }
  }
  return { decision: 'allow', stages: ran };
}
