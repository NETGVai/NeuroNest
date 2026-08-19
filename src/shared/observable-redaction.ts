/**
 * Centralized credential/content redaction across observable channels.
 *
 * Task 5.5 of the enhanced-chat-ui spec establishes a single main + renderer
 * safe redaction authority that structured logging, diagnostics, analytics,
 * support export, IPC error responses, and renderer output all consult before
 * a value crosses their boundary. Combining two complementary controls
 * satisfies the requirement:
 *
 *   1. **Field deny-list.** Keys that unambiguously carry a Proxy Credential,
 *      legacy provider key, prompt/response content, reasoning, or private
 *      tool payload are replaced with the redaction placeholder wherever they
 *      appear in an object or array tree.
 *   2. **Canary-pattern redaction.** String values are scanned for known
 *      leak shapes (private user paths, provider API keys, PEM blocks, bearer
 *      tokens, `file://` locators, raw argument dumps, protected prompt/
 *      reasoning references) and replaced with a channel-safe marker.
 *
 * The module is intentionally pure TypeScript with no Electron/Node/DOM
 * imports so it runs identically in the main process, preload bridge, and
 * renderer. Each observable channel picks the adapter it needs; every
 * adapter routes through the same underlying implementation so a single
 * denial covers every surface at once.
 *
 * Requirements: 5.6, 7.4, 7.6, 8.9, 15.1, 15.2.
 */

// ─── Placeholder markers ────────────────────────────────────────────────────

/** Placeholder for a deny-listed field value. */
export const REDACTED_FIELD_PLACEHOLDER = '<redacted:field>' as const;

/** Placeholder for a canary secret value (API keys, bearer tokens, PEM). */
export const REDACTED_SECRET_PLACEHOLDER = '<redacted:secret>' as const;

/** Placeholder for a private user path. */
export const REDACTED_PATH_PLACEHOLDER = '<redacted:path>' as const;

/** Placeholder for protected prompt/reasoning references. */
export const REDACTED_PROTECTED_PLACEHOLDER = '<redacted:protected>' as const;

/** Placeholder for unauthorized locator references (file://, UNC). */
export const REDACTED_LOCATOR_PLACEHOLDER = '<redacted:locator>' as const;

/** Placeholder for raw argument/output blocks. */
export const REDACTED_RAW_PLACEHOLDER = '<redacted:raw>' as const;

/** Placeholder for redacted content that was truncated by depth or size limits. */
export const REDACTED_TRUNCATED_PLACEHOLDER = '<redacted:truncated>' as const;

// ─── Deny-list of field names ───────────────────────────────────────────────

/**
 * Object keys that MUST be replaced with {@link REDACTED_FIELD_PLACEHOLDER}
 * whenever they appear anywhere in a value tree, at any depth, regardless of
 * their string content.
 *
 * Keys are compared case-insensitively after stripping non-alphanumeric
 * characters, so `apiKey`, `api_key`, `API-KEY`, and `apikey` all match.
 */
const DENY_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  // Proxy Credential (Task 5.1 / Requirement 5.6, 6.1, 6.3, 6.6, 7.7).
  'proxycredential',
  'proxycredentialsecret',
  'proxycredentialvalue',
  'proxycredentialref',
  'neuronestcredential',

  // Legacy provider keys (Task 5.3 / Requirement 7.1, 7.3–7.6).
  'apikey',
  'apitoken',
  'providerkey',
  'providerapikey',
  'providerapitoken',

  // Generic long-lived credentials.
  'authorization',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'bearertoken',
  'bearer',
  'clientsecret',
  'password',
  'passphrase',
  'secret',
  'secretkey',
  'signingkey',
  'privatekey',
  'sshkey',
  'credential',
  'credentials',

  // Prompt / response content (Requirement 8.9, 15.1).
  'prompt',
  'prompttext',
  'promptcontent',
  'promptvalue',
  'userprompt',
  'systemprompt',
  'messages',
  'chatmessages',
  'response',
  'responsetext',
  'responsecontent',
  'responsevalue',
  'assistantresponse',
  'answer',
  'answertext',
  'answercontent',

  // Reasoning content (Requirement 11.9, 12.9).
  'reasoning',
  'reasoningtext',
  'reasoningcontent',
  'reasoningsummary',
  'chainofthought',
  'hiddenreasoning',
  'thoughtchain',

  // Tool payloads (Requirement 13.7, 15.1).
  'toolpayload',
  'toolarguments',
  'toolargs',
  'toolinput',
  'tooloutput',
  'toolresult',
  'toolresponse',
  'rawarguments',
  'rawoutput',
  'rawresponse',
  'privatetoolpayload',
]);

/** Normalize a candidate key for deny-list comparison. */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Determine whether a field name should be redacted using the shared
 * deny-list plus any caller-provided extras.
 */
export function isDeniedFieldName(
  name: string,
  additionalDenyFields?: readonly string[],
): boolean {
  const normalized = normalizeFieldName(name);
  if (DENY_FIELD_NAMES.has(normalized)) return true;
  if (additionalDenyFields) {
    for (const extra of additionalDenyFields) {
      if (normalizeFieldName(extra) === normalized) return true;
    }
  }
  return false;
}

/** Frozen snapshot of the built-in deny list. Exposed for tests/audits. */
export const REDACTION_DENY_FIELDS: ReadonlySet<string> = DENY_FIELD_NAMES;

// ─── Canary patterns ────────────────────────────────────────────────────────

interface CanaryPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * String-level regexes covering leak shapes. Ordered from most specific to
 * most general so a match cannot be consumed by a broader rule before its
 * dedicated rule runs. Every pattern uses the `g` flag; the redaction
 * function resets `lastIndex` after each call so shared patterns remain
 * stateless.
 */
const CANARY_PATTERNS: readonly CanaryPattern[] = Object.freeze([
  // ── Protected prompt / reasoning references ────────────────────────────
  {
    name: 'protected-prompt',
    pattern:
      /\b(?:protected\s+prompt|system\s+prompt|hidden\s+reasoning|chain[- ]of[- ]thought)\s*[:=][^\n\r]*/gi,
    replacement: REDACTED_PROTECTED_PLACEHOLDER,
  },

  // ── Unauthorized locators ───────────────────────────────────────────────
  {
    name: 'file-locator',
    pattern: /file:\/\/\/[^\s"'`<>]+/gi,
    replacement: REDACTED_LOCATOR_PLACEHOLDER,
  },
  {
    name: 'unc-locator',
    pattern: /\\\\[^\\\s]+\\[^\s"'`<>]+/g,
    replacement: REDACTED_LOCATOR_PLACEHOLDER,
  },

  // ── Raw argument/output markers ─────────────────────────────────────────
  {
    name: 'raw-arguments',
    pattern:
      /\braw[_-]?(?:arguments?|output|response)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|\[[^\]]*\]|[^\s,;]+)/gi,
    replacement: REDACTED_RAW_PLACEHOLDER,
  },

  // ── Private key material (PEM, SSH) ─────────────────────────────────────
  {
    name: 'pem-private-key',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'ssh-public-key',
    pattern: /ssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{40,}/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },

  // ── Provider-shaped API keys ────────────────────────────────────────────
  {
    name: 'anthropic-key',
    pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    // OpenAI keys come in the classic `sk-<48 alphanumeric>` shape and in
    // the newer project/service-account shapes that embed dashes and
    // underscores. Allowing `[A-Za-z0-9_\-]` catches both without matching
    // any of the more specific prefixes above (Anthropic / Stripe).
    name: 'openai-key',
    pattern: /sk-[A-Za-z0-9_\-]{20,}/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'stripe-secret-key',
    pattern: /sk_(?:test|live)_[A-Za-z0-9]{16,}/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'stripe-publishable-key',
    pattern: /pk_(?:test|live)_[A-Za-z0-9]{16,}/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'github-token',
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'aws-access-key-id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'slack-token',
    pattern: /xox[bprs]-[A-Za-z0-9-]{10,}/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'twilio-key',
    pattern: /\bSK[a-f0-9]{32}\b/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'sendgrid-key',
    pattern: /SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{40,}/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\b/g,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },

  // ── Explicit "Bearer <token>" header shape ──────────────────────────────
  {
    name: 'bearer-header',
    pattern: /\bBearer\s+[A-Za-z0-9._\-/+=]{20,}/g,
    replacement: `Bearer ${REDACTED_SECRET_PLACEHOLDER}`,
  },

  // ── Named secret assignments (api_key=, password:, token=) ──────────────
  {
    name: 'named-credential-assignment',
    pattern:
      /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|bearer(?:[_-]?token)?|authorization|password|secret|credential|proxy[_-]?credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;'"`<>]{4,})/gi,
    replacement: REDACTED_SECRET_PLACEHOLDER,
  },

  // ── DB connection strings with embedded credentials ─────────────────────
  {
    name: 'db-connection-credentials',
    pattern:
      /(postgres|mysql|mongodb|redis|amqp|amqps):\/\/[^:@/\s]+:[^@\s]+@/gi,
    replacement: `$1://[user]:${REDACTED_SECRET_PLACEHOLDER}@`,
  },

  // ── Private user paths ──────────────────────────────────────────────────
  // Always run last so paths embedded in other patterns are consumed first.
  {
    name: 'unix-home-path',
    pattern: /\/(?:Users|home)\/[^\s/\\"'`<>]+/g,
    replacement: REDACTED_PATH_PLACEHOLDER,
  },
  {
    name: 'windows-home-path',
    pattern: /[A-Z]:\\Users\\[^\s/\\"'`<>]+/g,
    replacement: REDACTED_PATH_PLACEHOLDER,
  },
  {
    name: 'tilde-home-path',
    pattern: /~\//g,
    replacement: REDACTED_PATH_PLACEHOLDER,
  },
]);

/** Frozen snapshot of the string canary patterns. Exposed for tests. */
export const REDACTION_CANARY_PATTERNS: readonly CanaryPattern[] = CANARY_PATTERNS;

// ─── Options and channels ───────────────────────────────────────────────────

/**
 * The observable channels a value can pass through. Each adapter attaches
 * this to the redaction outcome so diagnostics can attribute a scrub to
 * the exact boundary that produced it.
 */
export type ObservableChannel =
  | 'log'
  | 'diagnostic'
  | 'analytics'
  | 'support-export'
  | 'ipc-error'
  | 'renderer'
  | 'telemetry';

/** Frozen list of every observable channel this module covers. */
export const ALL_OBSERVABLE_CHANNELS: readonly ObservableChannel[] = Object.freeze([
  'log',
  'diagnostic',
  'analytics',
  'support-export',
  'ipc-error',
  'renderer',
  'telemetry',
]);

/** Default maximum depth for recursive redaction. Prevents runaway trees. */
export const DEFAULT_MAX_DEPTH = 32;

/** Default maximum number of tree nodes visited per top-level redact call. */
export const DEFAULT_MAX_NODES = 5000;

export interface RedactionOptions {
  /**
   * Maximum object/array nesting depth before values are truncated with
   * {@link REDACTED_TRUNCATED_PLACEHOLDER}. Defaults to {@link DEFAULT_MAX_DEPTH}.
   */
  readonly maxDepth?: number;
  /**
   * Maximum number of value-tree nodes to visit per top-level call.
   * Defaults to {@link DEFAULT_MAX_NODES}.
   */
  readonly maxNodes?: number;
  /** Additional field names that MUST be redacted alongside the built-ins. */
  readonly additionalDenyFields?: readonly string[];
  /**
   * Field names that MUST NOT be redacted even if they match the built-in
   * deny list. Applies to leaf strings only; the field's descendants are
   * still scanned for canary patterns.
   */
  readonly preservedFields?: readonly string[];
  /** Observable channel label. */
  readonly channel?: ObservableChannel;
}

const EMPTY_OPTIONS: RedactionOptions = Object.freeze({});

// ─── String-level redaction ─────────────────────────────────────────────────

/**
 * Apply every canary pattern to `text` and return a channel-safe string. If
 * no pattern matches, the input is returned unchanged.
 */
export function redactString(text: string, options: RedactionOptions = EMPTY_OPTIONS): string {
  if (!text || text.length === 0) return text;
  void options; // options accepted for future extension (per-channel overrides).
  let out = text;
  for (const canary of CANARY_PATTERNS) {
    canary.pattern.lastIndex = 0;
    out = out.replace(canary.pattern, canary.replacement);
  }
  return out;
}

/**
 * Report whether the input contains any content that would be redacted.
 * Does not modify the input; useful for assertion tests and canary probes.
 */
export function containsRedactableContent(text: string): boolean {
  if (!text) return false;
  for (const canary of CANARY_PATTERNS) {
    canary.pattern.lastIndex = 0;
    if (canary.pattern.test(text)) {
      canary.pattern.lastIndex = 0;
      return true;
    }
    canary.pattern.lastIndex = 0;
  }
  return false;
}

// ─── Value tree redaction ───────────────────────────────────────────────────

interface WalkContext {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly additionalDenyFields: readonly string[] | undefined;
  readonly preservedFields: readonly string[] | undefined;
  visited: WeakSet<object>;
  nodes: number;
}

function preserveField(
  name: string,
  preservedFields: readonly string[] | undefined,
): boolean {
  if (!preservedFields) return false;
  const normalized = normalizeFieldName(name);
  for (const preserved of preservedFields) {
    if (normalizeFieldName(preserved) === normalized) return true;
  }
  return false;
}

function walkValue(
  value: unknown,
  depth: number,
  context: WalkContext,
): unknown {
  context.nodes += 1;
  if (context.nodes > context.maxNodes) return REDACTED_TRUNCATED_PLACEHOLDER;
  if (depth > context.maxDepth) return REDACTED_TRUNCATED_PLACEHOLDER;

  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') return redactString(value as string);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'symbol' || t === 'function') return REDACTED_FIELD_PLACEHOLDER;

  // Cyclic protection.
  if (value !== null && typeof value === 'object') {
    if (context.visited.has(value as object)) return REDACTED_TRUNCATED_PLACEHOLDER;
    context.visited.add(value as object);
  }

  if (Array.isArray(value)) {
    return value.map((item) => walkValue(item, depth + 1, context));
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    // Errors should be redacted through {@link redactError}; when they
    // appear inline inside a value tree, keep their identity metadata only.
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }

  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (preserveField(key, context.preservedFields)) {
        out[key] = typeof val === 'string' ? redactString(val) : walkValue(val, depth + 1, context);
        continue;
      }
      if (isDeniedFieldName(key, context.additionalDenyFields)) {
        out[key] = REDACTED_FIELD_PLACEHOLDER;
        continue;
      }
      out[key] = walkValue(val, depth + 1, context);
    }
    return out;
  }

  return REDACTED_FIELD_PLACEHOLDER;
}

/**
 * Recursively redact `value`. Deny-listed fields are replaced with
 * {@link REDACTED_FIELD_PLACEHOLDER} regardless of their inner shape; every
 * remaining string is scanned for canary patterns. Depth and node counts
 * are bounded to prevent unbounded traversal.
 */
export function redactValue<T>(value: T, options: RedactionOptions = EMPTY_OPTIONS): T {
  const context: WalkContext = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    additionalDenyFields: options.additionalDenyFields,
    preservedFields: options.preservedFields,
    visited: new WeakSet<object>(),
    nodes: 0,
  };
  return walkValue(value, 0, context) as T;
}

// ─── Error redaction ────────────────────────────────────────────────────────

/**
 * Structured representation of an error safe for IPC, diagnostics, logging,
 * and support export. Fields that could carry sensitive detail (message,
 * stack, cause) have already been passed through {@link redactString}, and
 * enclosing context objects have been passed through {@link redactValue}.
 */
export interface RedactedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: RedactedError;
  readonly code?: string;
  readonly context?: Record<string, unknown>;
}

function normalizeErrorName(err: unknown): string {
  if (err instanceof Error && typeof err.name === 'string' && err.name.length > 0) {
    return err.name;
  }
  if (err && typeof err === 'object' && 'name' in err) {
    const n = (err as { name?: unknown }).name;
    if (typeof n === 'string' && n.length > 0) return n;
  }
  return 'Error';
}

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string') return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Build a {@link RedactedError} from any thrown value. Prompt/response/tool
 * payloads and secrets found in `message`, `stack`, or `cause` are redacted
 * before the caller can serialize the result.
 */
export function redactError(
  err: unknown,
  options: RedactionOptions = EMPTY_OPTIONS,
): RedactedError {
  const message = redactString(normalizeErrorMessage(err), options);
  const name = normalizeErrorName(err);

  const base: {
    -readonly [K in keyof RedactedError]: RedactedError[K];
  } = { name, message };

  if (err instanceof Error) {
    if (typeof err.stack === 'string') {
      base.stack = redactString(err.stack, options);
    }
    if ('cause' in err && err.cause !== undefined && err.cause !== null) {
      base.cause = redactError(err.cause, options);
    }
  }

  if (err && typeof err === 'object') {
    const candidate = err as Record<string, unknown>;
    if (typeof candidate['code'] === 'string') base.code = candidate['code'] as string;
    if (
      candidate['context'] !== undefined &&
      candidate['context'] !== null &&
      typeof candidate['context'] === 'object'
    ) {
      base.context = redactValue(candidate['context'] as Record<string, unknown>, options);
    }
  }

  return base;
}

// ─── Channel adapters ───────────────────────────────────────────────────────

/**
 * Redact a value that will be written to structured logs. Deny-listed
 * fields (Proxy Credential, provider keys, prompt/response/reasoning/tool
 * payloads) become {@link REDACTED_FIELD_PLACEHOLDER}; canary-pattern
 * strings are replaced by their category-specific placeholder. Non-object
 * inputs are treated as strings.
 */
export function redactForLog<T>(
  value: T,
  options: Omit<RedactionOptions, 'channel'> = EMPTY_OPTIONS,
): T {
  return redactValue(value, { ...options, channel: 'log' });
}

/** Redact a value for a diagnostic export payload. Same policy as logs. */
export function redactForDiagnostic<T>(
  value: T,
  options: Omit<RedactionOptions, 'channel'> = EMPTY_OPTIONS,
): T {
  return redactValue(value, { ...options, channel: 'diagnostic' });
}

/**
 * Redact analytics metadata before persisting or emitting. Analytics events
 * are aggregated; carrying secret material or prompt content into that
 * pipeline is a defect.
 */
export function redactForAnalytics<T>(
  value: T,
  options: Omit<RedactionOptions, 'channel'> = EMPTY_OPTIONS,
): T {
  return redactValue(value, { ...options, channel: 'analytics' });
}

/**
 * Redact a text buffer bound for support export/download. Structured
 * exports should route their tree through {@link redactForDiagnostic} first,
 * then their serialized text through this helper for defense in depth.
 */
export function redactForSupportExport(
  text: string,
  options: Omit<RedactionOptions, 'channel'> = EMPTY_OPTIONS,
): string {
  return redactString(text, { ...options, channel: 'support-export' });
}

/**
 * Convert any thrown value into a {@link RedactedError} suitable for IPC
 * error responses and renderer display.
 */
export function redactForIpcError(
  err: unknown,
  options: Omit<RedactionOptions, 'channel'> = EMPTY_OPTIONS,
): RedactedError {
  return redactError(err, { ...options, channel: 'ipc-error' });
}

/** Redact a string for use in renderer output surfaces (labels, tooltips). */
export function redactForRenderer(
  text: string,
  options: Omit<RedactionOptions, 'channel'> = EMPTY_OPTIONS,
): string {
  return redactString(text, { ...options, channel: 'renderer' });
}

/** Redact a string for a telemetry payload. */
export function redactForTelemetry(
  text: string,
  options: Omit<RedactionOptions, 'channel'> = EMPTY_OPTIONS,
): string {
  return redactString(text, { ...options, channel: 'telemetry' });
}

// ─── Canary values for tests and audits ─────────────────────────────────────

/**
 * Canaries whose values already sit in a recognizable wire shape (Bearer
 * header, `api_key=`, `sk-...`, `AKIA...`, `file://...`, `raw_arguments:`,
 * `system prompt:`, PEM block, private path). Every canary in this group
 * MUST be scrubbed by {@link redactString} regardless of the surrounding
 * text, because the scrubbing regex matches the shape rather than the
 * literal identifier.
 */
export const STRING_SHAPED_REDACTION_CANARIES = Object.freeze({
  proxyCredentialBearer:
    'Bearer nn-proxy-credential-CANARY_ZQ7X_MUST_NOT_LEAK_1234567890',
  legacyProviderApiKeyAssignment:
    'api_key=PROVIDER_API_KEY_CANARY_R7Y2_MUST_NEVER_LEAK_1234567890',
  legacyOpenaiKey: 'sk-legacy-openai-CANARY-MUST-NOT-LEAK-1234567890',
  legacyAnthropicKey: 'sk-ant-legacy-CANARY-abcdef-MUST-NOT-LEAK-9012',
  legacyGithubToken: 'ghp_legacyCANARYMUSTNOTLEAK1234567890ABCDEF',
  legacyStripeKey: 'sk_test_legacyCANARYMUSTNOTLEAKabcdef1234567',
  legacyAwsKey: 'AKIACANARYMUSTNOTLE1',
  privateUnixPath: '/Users/canary-user/Documents/private/secrets.env',
  privateWindowsPath: 'C:\\Users\\canary-user\\AppData\\Local\\secrets.env',
  privateFileLocator: 'file:///Users/canary-user/private/id_rsa',
  privateUncLocator: '\\\\canary-server\\share\\secrets\\config.yaml',
  protectedSystemPrompt:
    'system prompt: CANARY_SYSTEM_PROMPT_MUST_NOT_LEAK - continue as usual',
  protectedHiddenReasoning:
    'hidden reasoning: CANARY_HIDDEN_REASONING_MUST_NOT_LEAK',
  protectedChainOfThought:
    'chain-of-thought: CANARY_COT_MUST_NOT_LEAK first step',
  rawArgumentsBlock:
    'raw_arguments: {"password": "CANARY_RAW_MUST_NOT_LEAK"}',
  rawOutputBlock: 'raw_output: {"secret": "CANARY_RAW_MUST_NOT_LEAK"}',
  namedCredentialAssignment:
    'api_key=CANARY_NAMED_SECRET_MUST_NOT_LEAK_abcdef1234567890',
  bearerAuthorizationHeader:
    'Authorization: Bearer CANARY_BEARER_MUST_NOT_LEAK_abcdef1234567890',
  pemPrivateKey:
    '-----BEGIN PRIVATE KEY-----\nCANARY_PEM_MUST_NOT_LEAK\nabcdefghijk==\n-----END PRIVATE KEY-----',
});

/**
 * Canaries whose bare token values cannot be recognized by any regex
 * pattern alone. They stand in for free-form Proxy Credential values,
 * legacy provider key strings, prompt/response/reasoning bodies, and
 * private tool payloads. Each MUST be scrubbed by the field deny-list
 * whenever it is placed under a deny-listed key such as `proxyCredential`,
 * `apiKey`, `prompt`, `response`, `reasoning`, or `toolPayload`.
 */
export const FIELD_ONLY_REDACTION_CANARIES = Object.freeze({
  proxyCredential: 'nn-proxy-credential-CANARY_ZQ7X_MUST_NOT_LEAK',
  legacyProviderApiKey: 'PROVIDER_API_KEY_CANARY_R7Y2_MUST_NEVER_LEAK',
  privatePromptContent: 'PROMPT_CANARY_ROLE_USER_MUST_NEVER_LEAK',
  privateResponseContent: 'RESPONSE_CANARY_ASSISTANT_MUST_NEVER_LEAK',
  privateReasoningContent: 'REASONING_CANARY_HIDDEN_MUST_NEVER_LEAK',
  privateToolPayload: 'TOOL_PAYLOAD_CANARY_MUST_NEVER_LEAK',
});

/**
 * Field-only canary key → the deny-listed field name a caller should place
 * that canary under when asserting the deny list scrubs it.
 */
export const FIELD_ONLY_CANARY_FIELD: Readonly<
  Record<keyof typeof FIELD_ONLY_REDACTION_CANARIES, string>
> = Object.freeze({
  proxyCredential: 'proxyCredential',
  legacyProviderApiKey: 'apiKey',
  privatePromptContent: 'prompt',
  privateResponseContent: 'response',
  privateReasoningContent: 'reasoning',
  privateToolPayload: 'toolPayload',
});

/**
 * Every canary — the union of string-shaped and field-only canaries.
 * Retained for tests that want to iterate the full sweep and then delegate
 * to the appropriate assertion mechanism per canary.
 */
export const ENHANCED_CHAT_UI_REDACTION_CANARIES = Object.freeze({
  ...STRING_SHAPED_REDACTION_CANARIES,
  ...FIELD_ONLY_REDACTION_CANARIES,
});

/** Return every canary string as a flat array for iteration in tests. */
export function getEnhancedChatUiCanaryValues(): readonly string[] {
  return Object.freeze(Object.values(ENHANCED_CHAT_UI_REDACTION_CANARIES));
}

/** Return every string-shaped canary value (should be scrubbed by regex). */
export function getStringShapedCanaryValues(): readonly string[] {
  return Object.freeze(Object.values(STRING_SHAPED_REDACTION_CANARIES));
}

/** Return every field-only canary value (should be scrubbed by deny-list). */
export function getFieldOnlyCanaryValues(): readonly string[] {
  return Object.freeze(Object.values(FIELD_ONLY_REDACTION_CANARIES));
}

/**
 * Return the canary names still present in `text` after redaction. An empty
 * array means every canary was scrubbed. Useful in assertion tests.
 */
export function findUnredactedEnhancedChatUiCanaries(text: string): string[] {
  const found: string[] = [];
  for (const [key, canary] of Object.entries(ENHANCED_CHAT_UI_REDACTION_CANARIES)) {
    if (text.includes(canary)) found.push(key);
  }
  return found;
}

/**
 * Return the string-shaped canary names still present after redaction.
 * Only counts canaries that should have been scrubbed by
 * {@link redactString}. Empty array means the string channel is clean.
 */
export function findUnredactedStringShapedCanaries(text: string): string[] {
  const found: string[] = [];
  for (const [key, canary] of Object.entries(STRING_SHAPED_REDACTION_CANARIES)) {
    if (text.includes(canary)) found.push(key);
  }
  return found;
}
