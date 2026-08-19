/**
 * Session Exporter — Serializes sessions as portable JSON archives with sensitive data scrubbing.
 *
 * Exports session state (messages, tool calls, file changes, metadata) into a compressed
 * JSON archive suitable for sharing or replay. Applies regex + pattern-based detection to
 * scrub API keys, tokens, .env values, and credentials from code blocks.
 *
 * Compression uses Node's built-in zlib (gzip) for efficient transfer.
 * NOTE: zstd would be ideal (~30% better ratio) but isn't in Node stdlib;
 * use the `zstd` npm package if higher compression becomes a requirement.
 *
 * Requirements: 6.1, 6.2, 6.5, 6.6
 */

import { gzipSync, gunzipSync } from 'node:zlib';

import {
  redactForSupportExport,
  redactValue,
} from '../shared/observable-redaction';

// ─── Types ──────────────────────────────────────────────────────

/** A single message in the exported session */
export interface ExportedMessage {
  id: string;
  role: string;
  content: string;
  agent?: string;
  toolCalls?: unknown;
  createdAt: string;
}

/** A tool call record in the exported session */
export interface ExportedToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: string | undefined;
  success: boolean;
  timestamp: string;
}

/** A file change record in the exported session */
export interface ExportedFileChange {
  filePath: string;
  action: 'create' | 'modify' | 'delete';
  diff?: string | undefined;
  timestamp: string;
}

/** Session metadata for the export archive */
export interface ExportMetadata {
  sessionId: string;
  sessionName: string;
  projectId?: string | undefined;
  exportedAt: string;
  exporterVersion: string;
  messageCount: number;
  toolCallCount: number;
  fileChangeCount: number;
  scrubbed: boolean;
  compressionAlgorithm: 'gzip';
}

/** The full session archive structure */
export interface SessionArchive {
  version: '1.0';
  metadata: ExportMetadata;
  messages: ExportedMessage[];
  toolCalls: ExportedToolCall[];
  fileChanges: ExportedFileChange[];
  customData?: Record<string, unknown> | undefined;
}

/** Options for session export */
export interface ExportOptions {
  scrubSensitiveData?: boolean;  // default: true
  includeToolCalls?: boolean;     // default: true
  includeFileChanges?: boolean;   // default: true
  compress?: boolean;             // default: true
  customData?: Record<string, unknown>;
}

/** Result of an export operation */
export interface ExportResult {
  success: boolean;
  archive?: Buffer;               // compressed archive (when compress=true)
  archiveJson?: SessionArchive;   // uncompressed archive (when compress=false)
  metadata?: ExportMetadata;
  error?: string;
}

/** Export eligibility check result */
export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

// ─── Sensitive Data Patterns ────────────────────────────────────

/**
 * Regex patterns for detecting sensitive data that must be scrubbed.
 * Each pattern targets a known credential/secret format.
 */
const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // API keys by prefix
  { name: 'OpenAI API key', pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED:openai-key]' },
  { name: 'GitHub PAT', pattern: /ghp_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED:github-pat]' },
  { name: 'GitHub OAuth', pattern: /gho_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED:github-oauth]' },
  { name: 'GitHub App', pattern: /ghu_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED:github-app]' },
  { name: 'GitHub Refresh', pattern: /ghr_[a-zA-Z0-9]{36,}/g, replacement: '[REDACTED:github-refresh]' },
  { name: 'Anthropic API key', pattern: /sk-ant-[a-zA-Z0-9-]{20,}/g, replacement: '[REDACTED:anthropic-key]' },
  { name: 'Stripe key', pattern: /sk_(test|live)_[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED:stripe-key]' },
  { name: 'Stripe publishable', pattern: /pk_(test|live)_[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED:stripe-pub-key]' },
  { name: 'AWS key', pattern: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED:aws-key]' },
  { name: 'Slack token', pattern: /xox[bprs]-[a-zA-Z0-9-]{10,}/g, replacement: '[REDACTED:slack-token]' },
  { name: 'Twilio', pattern: /SK[a-f0-9]{32}/g, replacement: '[REDACTED:twilio-key]' },
  { name: 'SendGrid', pattern: /SG\.[a-zA-Z0-9-_]{22}\.[a-zA-Z0-9-_]{43}/g, replacement: '[REDACTED:sendgrid-key]' },
  { name: 'npm token', pattern: /npm_[a-zA-Z0-9]{36}/g, replacement: '[REDACTED:npm-token]' },

  // Bearer tokens in headers
  { name: 'Bearer token', pattern: /Bearer\s+[a-zA-Z0-9._\-\/+=]{20,}/g, replacement: 'Bearer [REDACTED:token]' },

  // Generic long hex/base64 secrets (40+ chars after common key indicators)
  { name: 'Generic secret', pattern: /(?:api[_-]?key|secret|token|password|auth|credential)["\s:=]+["']?([a-zA-Z0-9+/=._\-]{40,})["']?/gi, replacement: '[REDACTED:credential]' },

  // .env KEY=VALUE patterns (KEY must look like a secret name)
  { name: '.env secret', pattern: /^((?:API_KEY|SECRET|TOKEN|PASSWORD|AUTH|PRIVATE_KEY|DB_PASSWORD|DATABASE_URL|REDIS_URL|MONGODB_URI|JWT_SECRET|SESSION_SECRET|ENCRYPTION_KEY|AWS_SECRET_ACCESS_KEY)[A-Z_0-9]*)=(.+)$/gm, replacement: '$1=[REDACTED]' },

  // Connection strings with credentials
  { name: 'DB connection string', pattern: /(postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@/g, replacement: '$1://[user]:[REDACTED]@' },

  // Private keys (PEM format)
  { name: 'Private key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, replacement: '[REDACTED:private-key]' },

  // SSH keys
  { name: 'SSH key', pattern: /ssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/=]{40,}/g, replacement: '[REDACTED:ssh-key]' },
];

// ─── Session Exporter ───────────────────────────────────────────

/**
 * SessionExporter handles serialization and scrubbing of session data.
 * Uses a lazy-initialized singleton pattern consistent with the codebase.
 */
export class SessionExporter {
  private static instance: SessionExporter | null = null;

  private constructor() {}

  static getInstance(): SessionExporter {
    if (!SessionExporter.instance) {
      SessionExporter.instance = new SessionExporter();
    }
    return SessionExporter.instance;
  }

  /**
   * Check if a session is eligible for export.
   * Blocks export of security-classified sessions.
   */
  checkEligibility(sessionMetadata: {
    id: string;
    securityClassification?: string;
    locked?: boolean;
  }): EligibilityResult {
    // Block security-classified sessions
    if (sessionMetadata.securityClassification === 'restricted' ||
        sessionMetadata.securityClassification === 'confidential' ||
        sessionMetadata.securityClassification === 'top-secret') {
      return {
        eligible: false,
        reason: `Session is security-classified (${sessionMetadata.securityClassification}) and cannot be exported`,
      };
    }

    // Block locked sessions
    if (sessionMetadata.locked) {
      return {
        eligible: false,
        reason: 'Session is locked and cannot be exported',
      };
    }

    return { eligible: true };
  }

  /**
   * Export a session as a compressed JSON archive.
   */
  export(
    messages: ExportedMessage[],
    toolCalls: ExportedToolCall[],
    fileChanges: ExportedFileChange[],
    sessionInfo: { id: string; name: string; projectId?: string },
    options: ExportOptions = {},
  ): ExportResult {
    const {
      scrubSensitiveData = true,
      includeToolCalls = true,
      includeFileChanges = true,
      compress = true,
      customData,
    } = options;

    try {
      // Scrub sensitive data from messages
      const processedMessages = scrubSensitiveData
        ? messages.map((m) => ({ ...m, content: this.scrubContent(m.content) }))
        : messages;

      // Scrub tool call results if included
      let processedToolCalls: ExportedToolCall[] = [];
      if (includeToolCalls) {
        if (scrubSensitiveData) {
          processedToolCalls = toolCalls.map((tc): ExportedToolCall => ({
            id: tc.id,
            tool: tc.tool,
            args: this.scrubObject(tc.args),
            result: tc.result ? this.scrubContent(tc.result) : tc.result,
            success: tc.success,
            timestamp: tc.timestamp,
          }));
        } else {
          processedToolCalls = toolCalls;
        }
      }

      // Include file changes if requested
      let processedFileChanges: ExportedFileChange[] = [];
      if (includeFileChanges) {
        if (scrubSensitiveData) {
          processedFileChanges = fileChanges.map((fc): ExportedFileChange => ({
            filePath: fc.filePath,
            action: fc.action,
            diff: fc.diff ? this.scrubContent(fc.diff) : fc.diff,
            timestamp: fc.timestamp,
          }));
        } else {
          processedFileChanges = fileChanges;
        }
      }

      const metadata: ExportMetadata = {
        sessionId: sessionInfo.id,
        sessionName: sessionInfo.name,
        projectId: sessionInfo.projectId,
        exportedAt: new Date().toISOString(),
        exporterVersion: '1.0.0',
        messageCount: processedMessages.length,
        toolCallCount: processedToolCalls.length,
        fileChangeCount: processedFileChanges.length,
        scrubbed: scrubSensitiveData,
        compressionAlgorithm: 'gzip',
      };

      const archive: SessionArchive = {
        version: '1.0',
        metadata,
        messages: processedMessages,
        toolCalls: processedToolCalls,
        fileChanges: processedFileChanges,
        customData,
      };

      if (compress) {
        const jsonString = JSON.stringify(archive);
        const compressed = gzipSync(Buffer.from(jsonString, 'utf-8'), { level: 9 });
        return { success: true, archive: compressed, metadata };
      }

      return { success: true, archiveJson: archive, metadata };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Export failed' };
    }
  }

  /**
   * Decompress and parse an archive buffer back into a SessionArchive.
   */
  decompress(buffer: Buffer): SessionArchive | null {
    try {
      const decompressed = gunzipSync(buffer);
      const json = decompressed.toString('utf-8');
      return JSON.parse(json) as SessionArchive;
    } catch {
      return null;
    }
  }

  /**
   * Scrub sensitive data from a text string using regex patterns.
   *
   * Task 5.5 (enhanced-chat-ui): support export is one of the observable
   * channels the shared credential/content redaction boundary must cover.
   * The session-exporter's dedicated {@link SENSITIVE_PATTERNS} list is
   * retained for its explicit format labels (they double as an audit trail
   * of what was scrubbed), and the shared boundary runs afterwards as a
   * defence-in-depth pass covering Proxy Credentials, legacy provider keys,
   * bearer tokens, PEM blocks, and private paths.
   */
  scrubContent(content: string): string {
    let scrubbed = content;
    for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;
      scrubbed = scrubbed.replace(pattern, replacement);
    }
    return redactForSupportExport(scrubbed);
  }

  /**
   * Recursively scrub sensitive data from an object's string values. The
   * shared redaction boundary is invoked after the local per-string pass so
   * deny-listed keys (Proxy Credential, legacy provider keys, prompt/
   * response/reasoning/tool payloads) never survive an export archive.
   */
  scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.scrubContent(value);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.scrubObject(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          typeof item === 'string'
            ? this.scrubContent(item)
            : item && typeof item === 'object'
              ? this.scrubObject(item as Record<string, unknown>)
              : item,
        );
      } else {
        result[key] = value;
      }
    }
    return redactValue(result, { channel: 'support-export' });
  }
}
