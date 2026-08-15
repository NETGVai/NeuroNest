/**
 * Repository Map Types
 *
 * Core type definitions for the versioned Repository_Map including
 * file, symbol, import, dependency, build, test, schema, migration,
 * API contract, Git, and ownership metadata.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9
 */

// ─── Node Metadata Types ─────────────────────────────────────────

export interface FileNode {
  uri: string;
  language: string;
  contentHash: string;
  lastModified: number;
  size: number;
  version: number;
}

export interface SymbolNode {
  name: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  containerName?: string;
}

export type SymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'variable'
  | 'interface'
  | 'enum'
  | 'type'
  | 'constant'
  | 'property'
  | 'module';

export interface Range {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface ImportEdge {
  sourceUri: string;
  targetUri: string;
  specifiers: string[];
  isTypeOnly: boolean;
}

export interface DependencyEdge {
  sourceUri: string;
  targetUri: string;
  kind: 'import' | 'require' | 'dynamic' | 'type-reference' | 'package';
}

export interface BuildConfig {
  uri: string;
  type: 'tsconfig' | 'webpack' | 'vite' | 'rollup' | 'esbuild' | 'package-json' | 'other';
  entryPoints: string[];
  outputPaths: string[];
}

export interface TestConfig {
  uri: string;
  framework: 'vitest' | 'jest' | 'mocha' | 'other';
  testFiles: string[];
  configHash: string;
}

export interface SchemaNode {
  uri: string;
  type: 'database' | 'graphql' | 'protobuf' | 'json-schema' | 'openapi' | 'other';
  name: string;
  version?: string;
}

export interface MigrationNode {
  uri: string;
  sequence: number;
  name: string;
  direction: 'up' | 'down' | 'both';
}

export interface ApiContractNode {
  uri: string;
  type: 'rest' | 'graphql' | 'grpc' | 'websocket' | 'other';
  endpoints: string[];
  version?: string;
}

export interface GitState {
  branch: string;
  headCommit: string;
  dirtyFiles: string[];
  untrackedFiles: string[];
  lastFetchTimestamp: number;
}

export interface OwnershipEntry {
  pattern: string;
  owners: string[];
  uri?: string;
}

// ─── Repository Map ──────────────────────────────────────────────

export interface RepositoryMapVersion {
  revision: string;
  timestamp: number;
  sequence: number;
}

export interface RepositoryMap {
  version: RepositoryMapVersion;
  files: Map<string, FileNode>;
  symbols: Map<string, SymbolNode[]>;
  imports: ImportEdge[];
  dependencies: DependencyEdge[];
  buildConfigs: BuildConfig[];
  testConfigs: TestConfig[];
  schemas: SchemaNode[];
  migrations: MigrationNode[];
  apiContracts: ApiContractNode[];
  gitState: GitState | null;
  ownership: OwnershipEntry[];
}

// ─── File Events ─────────────────────────────────────────────────

export type FileEventKind = 'create' | 'modify' | 'delete' | 'rename';

export interface FileEvent {
  kind: FileEventKind;
  uri: string;
  previousUri?: string;
  timestamp: number;
}

// ─── Query Metadata ──────────────────────────────────────────────

export type QueryMethod =
  | 'exact-search'
  | 'semantic-shortlist'
  | 'symbol-references'
  | 'dependency-traversal'
  | 'diagnostics'
  | 'recent-edits'
  | 'git-diff'
  | 'explicit-context';

export interface QueryMetadata {
  sourceUri: string;
  sourceVersion: number;
  workspaceRevision: string;
  method: QueryMethod;
  truncated: boolean;
  confidence: number;
}

export interface QueryResult<T> {
  data: T;
  metadata: QueryMetadata;
}

// ─── Impact Analysis ─────────────────────────────────────────────

export interface ImpactEntry {
  uri: string;
  method: QueryMethod;
  confidence: number;
  reason: string;
}

export interface ImpactAnalysisResult {
  affectedEntities: ImpactEntry[];
  workspaceRevision: string;
  timestamp: number;
  methods: QueryMethod[];
}

// ─── Freshness ───────────────────────────────────────────────────

export type FreshnessStatus = 'current' | 'stale' | 'unknown';

export interface FreshnessInfo {
  status: FreshnessStatus;
  lastRefresh: number;
  staleUris: string[];
  mapVersion: RepositoryMapVersion;
}
