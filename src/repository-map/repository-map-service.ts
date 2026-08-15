/**
 * RepositoryMapService — Incremental versioned repository map
 *
 * Maintains a versioned Repository_Map with file, symbol, import,
 * dependency, build, test, schema, migration, API contract, Git,
 * and ownership metadata refreshed from workspace file events.
 *
 * Incremental file events invalidate affected nodes. The workspace
 * revision (overall content hash) is recomputed on each mutation.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9
 */

import { createHash } from 'node:crypto';

import type {
  RepositoryMap,
  RepositoryMapVersion,
  FileNode,
  SymbolNode,
  ImportEdge,
  DependencyEdge,
  BuildConfig,
  TestConfig,
  SchemaNode,
  MigrationNode,
  ApiContractNode,
  GitState,
  OwnershipEntry,
  FileEvent,
  FreshnessInfo,
  FreshnessStatus,
  QueryMetadata,
  QueryResult,
  QueryMethod,
} from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function computeWorkspaceRevision(files: Map<string, FileNode>): string {
  const sortedEntries = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const hashInput = sortedEntries
    .map(([uri, node]) => `${uri}:${node.contentHash}:${node.version}`)
    .join('\n');
  return createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
}

// ─── Service ─────────────────────────────────────────────────────

export class RepositoryMapService {
  private map: RepositoryMap;
  private staleUris: Set<string> = new Set();
  private lastRefreshTimestamp: number;

  constructor() {
    this.map = this.createEmptyMap();
    this.lastRefreshTimestamp = Date.now();
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Get the current repository map version */
  getVersion(): RepositoryMapVersion {
    return { ...this.map.version };
  }

  /** Get current workspace revision (overall content hash) */
  getWorkspaceRevision(): string {
    return this.map.version.revision;
  }

  /** Get freshness information */
  getFreshness(): FreshnessInfo {
    const status: FreshnessStatus = this.staleUris.size === 0 ? 'current' : 'stale';
    return {
      status,
      lastRefresh: this.lastRefreshTimestamp,
      staleUris: [...this.staleUris],
      mapVersion: { ...this.map.version },
    };
  }

  /** Process a file event and invalidate affected nodes */
  handleFileEvent(event: FileEvent): void {
    switch (event.kind) {
      case 'create':
        this.handleCreate(event);
        break;
      case 'modify':
        this.handleModify(event);
        break;
      case 'delete':
        this.handleDelete(event);
        break;
      case 'rename':
        this.handleRename(event);
        break;
    }
    this.recomputeRevision();
  }

  /** Register a file with its metadata */
  registerFile(node: FileNode): void {
    this.map.files.set(node.uri, { ...node });
    this.staleUris.delete(node.uri);
    this.recomputeRevision();
  }

  /** Register symbols for a file URI */
  registerSymbols(uri: string, symbols: SymbolNode[]): void {
    this.map.symbols.set(uri, [...symbols]);
  }

  /** Add an import edge */
  addImport(edge: ImportEdge): void {
    this.map.imports.push({ ...edge });
  }

  /** Add a dependency edge */
  addDependency(edge: DependencyEdge): void {
    this.map.dependencies.push({ ...edge });
  }

  /** Register a build configuration */
  registerBuildConfig(config: BuildConfig): void {
    const existing = this.map.buildConfigs.findIndex((c) => c.uri === config.uri);
    if (existing >= 0) {
      this.map.buildConfigs[existing] = { ...config };
    } else {
      this.map.buildConfigs.push({ ...config });
    }
  }

  /** Register a test configuration */
  registerTestConfig(config: TestConfig): void {
    const existing = this.map.testConfigs.findIndex((c) => c.uri === config.uri);
    if (existing >= 0) {
      this.map.testConfigs[existing] = { ...config };
    } else {
      this.map.testConfigs.push({ ...config });
    }
  }

  /** Register a schema node */
  registerSchema(schema: SchemaNode): void {
    const existing = this.map.schemas.findIndex((s) => s.uri === schema.uri);
    if (existing >= 0) {
      this.map.schemas[existing] = { ...schema };
    } else {
      this.map.schemas.push({ ...schema });
    }
  }

  /** Register a migration node */
  registerMigration(migration: MigrationNode): void {
    const existing = this.map.migrations.findIndex((m) => m.uri === migration.uri);
    if (existing >= 0) {
      this.map.migrations[existing] = { ...migration };
    } else {
      this.map.migrations.push({ ...migration });
    }
  }

  /** Register an API contract */
  registerApiContract(contract: ApiContractNode): void {
    const existing = this.map.apiContracts.findIndex((c) => c.uri === contract.uri);
    if (existing >= 0) {
      this.map.apiContracts[existing] = { ...contract };
    } else {
      this.map.apiContracts.push({ ...contract });
    }
  }

  /** Update Git state */
  updateGitState(state: GitState): void {
    this.map.gitState = { ...state };
  }

  /** Update ownership entries */
  updateOwnership(entries: OwnershipEntry[]): void {
    this.map.ownership = entries.map((e) => ({ ...e }));
  }

  /** Query file nodes with full metadata */
  queryFiles(uris: string[]): QueryResult<FileNode[]> {
    const results: FileNode[] = [];
    for (const uri of uris) {
      const file = this.map.files.get(uri);
      if (file) {
        results.push({ ...file });
      }
    }
    return this.wrapResult(results, 'exact-search', uris[0] ?? '', results.length > 0 ? 1.0 : 0.0);
  }

  /** Query symbols by URI */
  querySymbolsByUri(uri: string): QueryResult<SymbolNode[]> {
    const symbols = this.map.symbols.get(uri) ?? [];
    return this.wrapResult([...symbols], 'symbol-references', uri, symbols.length > 0 ? 1.0 : 0.0);
  }

  /** Query symbols by name (fuzzy) */
  querySymbolsByName(name: string, maxResults: number = 50): QueryResult<SymbolNode[]> {
    const results: SymbolNode[] = [];
    const lowerName = name.toLowerCase();
    for (const [, symbols] of this.map.symbols) {
      for (const sym of symbols) {
        if (sym.name.toLowerCase().includes(lowerName)) {
          results.push({ ...sym });
          if (results.length >= maxResults) break;
        }
      }
      if (results.length >= maxResults) break;
    }
    const truncated = results.length >= maxResults;
    return this.wrapResult(
      results,
      'exact-search',
      name,
      results.length > 0 ? 0.8 : 0.0,
      truncated,
    );
  }

  /** Get dependencies for a given URI */
  queryDependencies(uri: string): QueryResult<DependencyEdge[]> {
    const deps = this.map.dependencies.filter((d) => d.sourceUri === uri);
    return this.wrapResult([...deps], 'dependency-traversal', uri, deps.length > 0 ? 1.0 : 0.0);
  }

  /** Get reverse dependencies (who depends on this file) */
  queryReverseDependencies(uri: string): QueryResult<DependencyEdge[]> {
    const deps = this.map.dependencies.filter((d) => d.targetUri === uri);
    return this.wrapResult([...deps], 'dependency-traversal', uri, deps.length > 0 ? 1.0 : 0.0);
  }

  /** Get all imports for a given URI */
  queryImports(uri: string): QueryResult<ImportEdge[]> {
    const imports = this.map.imports.filter((i) => i.sourceUri === uri);
    return this.wrapResult([...imports], 'dependency-traversal', uri, imports.length > 0 ? 1.0 : 0.0);
  }

  /** Get Git state */
  queryGitState(): QueryResult<GitState | null> {
    return this.wrapResult(
      this.map.gitState ? { ...this.map.gitState } : null,
      'git-diff',
      '',
      this.map.gitState ? 1.0 : 0.0,
    );
  }

  /** Get the full repository map (read-only snapshot) */
  getSnapshot(): RepositoryMap {
    return {
      version: { ...this.map.version },
      files: new Map(this.map.files),
      symbols: new Map(this.map.symbols),
      imports: [...this.map.imports],
      dependencies: [...this.map.dependencies],
      buildConfigs: [...this.map.buildConfigs],
      testConfigs: [...this.map.testConfigs],
      schemas: [...this.map.schemas],
      migrations: [...this.map.migrations],
      apiContracts: [...this.map.apiContracts],
      gitState: this.map.gitState ? { ...this.map.gitState } : null,
      ownership: [...this.map.ownership],
    };
  }

  /** Mark refresh completed */
  markRefreshed(): void {
    this.staleUris.clear();
    this.lastRefreshTimestamp = Date.now();
  }

  // ── Private Methods ─────────────────────────────────────────────

  private createEmptyMap(): RepositoryMap {
    return {
      version: { revision: computeContentHash(''), timestamp: Date.now(), sequence: 0 },
      files: new Map(),
      symbols: new Map(),
      imports: [],
      dependencies: [],
      buildConfigs: [],
      testConfigs: [],
      schemas: [],
      migrations: [],
      apiContracts: [],
      gitState: null,
      ownership: [],
    };
  }

  private handleCreate(event: FileEvent): void {
    // Mark as stale until full re-index provides content hash
    this.staleUris.add(event.uri);
  }

  private handleModify(event: FileEvent): void {
    const file = this.map.files.get(event.uri);
    if (file) {
      file.version += 1;
      file.lastModified = event.timestamp;
    }
    // Mark affected symbols/imports as stale
    this.staleUris.add(event.uri);
    this.invalidateRelatedNodes(event.uri);
  }

  private handleDelete(event: FileEvent): void {
    this.map.files.delete(event.uri);
    this.map.symbols.delete(event.uri);
    this.removeImportsForUri(event.uri);
    this.removeDependenciesForUri(event.uri);
    this.staleUris.delete(event.uri);
    this.invalidateRelatedNodes(event.uri);
  }

  private handleRename(event: FileEvent): void {
    if (event.previousUri) {
      const file = this.map.files.get(event.previousUri);
      if (file) {
        this.map.files.delete(event.previousUri);
        file.uri = event.uri;
        this.map.files.set(event.uri, file);
      }

      const symbols = this.map.symbols.get(event.previousUri);
      if (symbols) {
        this.map.symbols.delete(event.previousUri);
        const updated = symbols.map((s) => ({ ...s, uri: event.uri }));
        this.map.symbols.set(event.uri, updated);
      }

      // Update imports/dependencies
      for (const imp of this.map.imports) {
        if (imp.sourceUri === event.previousUri) imp.sourceUri = event.uri;
        if (imp.targetUri === event.previousUri) imp.targetUri = event.uri;
      }
      for (const dep of this.map.dependencies) {
        if (dep.sourceUri === event.previousUri) dep.sourceUri = event.uri;
        if (dep.targetUri === event.previousUri) dep.targetUri = event.uri;
      }

      this.staleUris.delete(event.previousUri);
      this.staleUris.add(event.uri);
    }
  }

  private invalidateRelatedNodes(uri: string): void {
    // Mark reverse dependents as stale
    for (const dep of this.map.dependencies) {
      if (dep.targetUri === uri) {
        this.staleUris.add(dep.sourceUri);
      }
    }
    for (const imp of this.map.imports) {
      if (imp.targetUri === uri) {
        this.staleUris.add(imp.sourceUri);
      }
    }
  }

  private removeImportsForUri(uri: string): void {
    this.map.imports = this.map.imports.filter(
      (i) => i.sourceUri !== uri && i.targetUri !== uri,
    );
  }

  private removeDependenciesForUri(uri: string): void {
    this.map.dependencies = this.map.dependencies.filter(
      (d) => d.sourceUri !== uri && d.targetUri !== uri,
    );
  }

  private recomputeRevision(): void {
    const newRevision = computeWorkspaceRevision(this.map.files);
    this.map.version = {
      revision: newRevision,
      timestamp: Date.now(),
      sequence: this.map.version.sequence + 1,
    };
  }

  private wrapResult<T>(
    data: T,
    method: QueryMethod,
    sourceUri: string,
    confidence: number,
    truncated: boolean = false,
  ): QueryResult<T> {
    const fileNode = this.map.files.get(sourceUri);
    return {
      data,
      metadata: {
        sourceUri,
        sourceVersion: fileNode?.version ?? 0,
        workspaceRevision: this.map.version.revision,
        method,
        truncated,
        confidence,
      },
    };
  }
}

export { computeContentHash, computeWorkspaceRevision };
