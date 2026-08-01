// ─── KB Connector Types & Interfaces ────────────────────────────
// Defines the core types for the Knowledge Base connector framework.
// All connectors normalize heterogeneous data sources into a unified
// RawDocument structure for downstream ingest processing.
//
// Requirements: 1.1, 1.2, 1.7

import { z } from 'zod';

// ─── Connector Type Enum ────────────────────────────────────────

/**
 * Supported connector types for data source ingestion.
 */
export type ConnectorType =
  | 'local-files'
  | 'git-repository'
  | 'url-website'
  | 'pdf-document'
  | 'docx-document'
  | 'csv-file'
  | 'json-file'
  | 'markdown-wiki';

/** All connector type values as a const array for Zod schema reuse. */
export const CONNECTOR_TYPES = [
  'local-files',
  'git-repository',
  'url-website',
  'pdf-document',
  'docx-document',
  'csv-file',
  'json-file',
  'markdown-wiki',
] as const;

// ─── RawDocument ────────────────────────────────────────────────

/**
 * Unified document structure produced by all connectors.
 * Every connector adapter normalizes fetched content into this shape
 * before handing off to the Ingest Pipeline.
 */
export interface RawDocument {
  /** Raw content bytes of the document. */
  content: Buffer;
  /** MIME type of the document (e.g., 'text/plain', 'application/pdf'). */
  mimeType: string;
  /** Original URI identifying the source location of the document. */
  sourceUri: string;
  /** Unix timestamp (ms) when the content was fetched. */
  fetchTimestamp: number;
  /** SHA-256 hash of the content for deduplication and freshness checks. */
  contentHash: string;
  /** Size in bytes of the content buffer. */
  byteSize: number;
}

// ─── SourceEntry ────────────────────────────────────────────────

/**
 * Represents a discoverable document entry returned by a connector's
 * `list()` method. Used to identify which documents are available
 * for fetching from a connected source.
 */
export interface SourceEntry {
  /** URI identifying this specific document within the source. */
  uri: string;
  /** Human-readable name or filename for the entry. */
  name: string;
  /** MIME type if known ahead of fetching. */
  mimeType?: string;
  /** Size in bytes if known ahead of fetching. */
  sizeBytes?: number;
  /** Last modification timestamp (ms) if available. */
  lastModified?: number;
  /** Additional source-specific metadata. */
  metadata?: Record<string, unknown>;
}

// ─── ConnectorSecurityProfile ───────────────────────────────────

/**
 * Security profile scoped per connector type.
 * Enforced by PathGuard (file paths) and NetworkSandbox (domains).
 */
export interface ConnectorSecurityProfile {
  /** Allowed file paths for file-based connectors. */
  allowedPaths?: string[];
  /** Allowed domains for URL-based connectors. */
  allowedDomains?: string[];
  /** Maximum fetch size in bytes per individual document. */
  maxFetchSizeBytes: number;
  /** Maximum total size in bytes across all documents for a source. */
  maxTotalSizeBytes: number;
  /** Execution timeout in milliseconds for connector operations. */
  executionTimeoutMs: number;
  /** Maximum clone depth for git connectors. */
  maxCloneDepth?: number;
  /** Maximum repository size in bytes for git connectors. */
  maxRepoSizeBytes?: number;
}

// ─── KBConnector Interface ──────────────────────────────────────

/**
 * Connector lifecycle interface.
 * All connector adapters implement this interface to provide a unified
 * interaction pattern: connect → list → fetch → disconnect.
 */
export interface KBConnector {
  /** The type identifier for this connector. */
  readonly type: ConnectorType;

  /** Establish connection to the data source with the given config. */
  connect(config: ConnectorConfig): Promise<void>;

  /** List all discoverable document entries from the connected source. */
  list(): Promise<SourceEntry[]>;

  /** Fetch documents for the specified entries as an async iterable stream. */
  fetch(entries: SourceEntry[]): AsyncIterable<RawDocument>;

  /** Disconnect from the source and release resources. */
  disconnect(): Promise<void>;
}

// ─── Zod Validation Schemas ─────────────────────────────────────

/**
 * Authentication configuration schema for connectors that require
 * authenticated access (private repos, SSO-protected wikis, etc.).
 */
export const AuthenticationSchema = z.object({
  /** Authentication method used to access the source. */
  method: z.enum(['none', 'token', 'oauth2', 'api-key', 'ssh-key']),
  /** Reference to a stored credential in the CredentialVault. */
  credentialId: z.string().optional(),
});

/**
 * Security profile schema for per-connector resource limits.
 */
export const SecurityProfileSchema = z.object({
  /** Allowed file paths for file-based connectors. */
  allowedPaths: z.array(z.string()).optional(),
  /** Allowed domains for URL-based connectors. */
  allowedDomains: z.array(z.string()).optional(),
  /** Maximum fetch size per document in bytes (default: 10 MB). */
  maxFetchSizeBytes: z.number().int().positive().default(10 * 1024 * 1024),
  /** Maximum total size for all documents in a source (default: 1 GB). */
  maxTotalSizeBytes: z.number().int().positive().default(1024 * 1024 * 1024),
  /** Execution timeout in milliseconds (default: 60s). */
  executionTimeoutMs: z.number().int().positive().default(60_000),
  /** Maximum clone depth for git connectors. */
  maxCloneDepth: z.number().int().positive().optional(),
  /** Maximum repository size in bytes for git connectors. */
  maxRepoSizeBytes: z.number().int().positive().optional(),
});

/**
 * Main connector configuration schema.
 * Validates the full configuration object used to connect to a data source.
 */
export const ConnectorConfigSchema = z.object({
  /** The type of connector to use. */
  type: z.enum(CONNECTOR_TYPES),
  /** URI identifying the data source (file path, git URL, web URL, etc.). */
  uri: z.string().min(1),
  /** Optional human-readable label for the source. */
  label: z.string().optional(),
  /** Authentication configuration if the source requires credentials. */
  authentication: AuthenticationSchema.optional(),
  /** Re-indexing schedule for the source. */
  schedule: z.enum(['manual', 'on-change', 'hourly', 'daily']).default('manual'),
  /** Chunking strategy to use when ingesting content from this source. */
  chunkingStrategy: z
    .enum(['fixed-size', 'semantic-boundary', 'document-structure'])
    .default('semantic-boundary'),
  /** Per-connector security limits. */
  securityProfile: SecurityProfileSchema.optional(),
});

/**
 * Inferred TypeScript type from the ConnectorConfigSchema.
 */
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
