/**
 * TabMetadataService — Derives tab display state from the canonical model record.
 *
 * Renders: file name, relative-path disambiguation, language icon, dirty state,
 * read-only state, diagnostics count, and pending-agent-change state.
 *
 * Requirements: 1.4
 */

import { canonicalizeUri } from './uri-canonicalization';
import * as path from 'path';

/** Tab display metadata derived from the canonical model. */
export interface TabMetadata {
  /** File basename (e.g. "index.ts") */
  fileName: string;
  /** Relative path disambiguation shown when multiple tabs share the same name */
  relativePath: string | null;
  /** Language icon identifier derived from file extension */
  languageIcon: string;
  /** Whether the model has unsaved changes */
  dirty: boolean;
  /** Whether the model is read-only */
  readOnly: boolean;
  /** Number of active diagnostics for this file */
  diagnosticsCount: number;
  /** Whether there are pending agent changes for this file */
  pendingAgentChange: boolean;
}

/** Registry providing diagnostics count by URI. */
export interface DiagnosticsRegistry {
  getCount(canonicalUri: string): number;
}

/** Registry providing pending change set state. */
export interface ChangeSetRegistry {
  hasPendingChanges(canonicalUri: string): boolean;
}

/** Model store record interface for tab metadata derivation. */
export interface ModelRecordSource {
  isDirty(canonicalUri: string): boolean;
  isReadOnly(canonicalUri: string): boolean;
  hasModel(canonicalUri: string): boolean;
}

/** Map from extension to language icon identifier. */
const EXTENSION_TO_LANGUAGE_ICON: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.dart': 'dart',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

/**
 * Derives the language icon identifier from a file extension.
 */
export function getLanguageIcon(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_LANGUAGE_ICON[ext] ?? 'file';
}

/**
 * TabMetadataService derives complete tab display state from the canonical model
 * record and associated registries.
 */
export class TabMetadataService {
  private readonly modelSource: ModelRecordSource;
  private readonly diagnosticsRegistry: DiagnosticsRegistry;
  private readonly changeSetRegistry: ChangeSetRegistry;

  constructor(
    modelSource: ModelRecordSource,
    diagnosticsRegistry: DiagnosticsRegistry,
    changeSetRegistry: ChangeSetRegistry,
  ) {
    this.modelSource = modelSource;
    this.diagnosticsRegistry = diagnosticsRegistry;
    this.changeSetRegistry = changeSetRegistry;
  }

  /**
   * Derive tab metadata for a given URI.
   * Optionally accepts all open URIs for relative-path disambiguation.
   */
  getTabMetadata(uri: string, allOpenUris?: string[]): TabMetadata {
    const canonicalUri = canonicalizeUri(uri);
    const fileName = path.basename(canonicalUri);
    const languageIcon = getLanguageIcon(canonicalUri);
    const dirty = this.modelSource.isDirty(canonicalUri);
    const readOnly = this.modelSource.isReadOnly(canonicalUri);
    const diagnosticsCount = this.diagnosticsRegistry.getCount(canonicalUri);
    const pendingAgentChange = this.changeSetRegistry.hasPendingChanges(canonicalUri);

    // Compute relative path disambiguation when multiple files share the same name
    let relativePath: string | null = null;
    if (allOpenUris && allOpenUris.length > 1) {
      const canonicalAll = allOpenUris.map((u) => canonicalizeUri(u));
      const duplicateNames = canonicalAll.filter(
        (u) => path.basename(u) === fileName && u !== canonicalUri,
      );
      if (duplicateNames.length > 0) {
        // Show the parent directory as disambiguation
        relativePath = path.dirname(canonicalUri).split('/').pop() ?? path.dirname(canonicalUri);
      }
    }

    return {
      fileName,
      relativePath,
      languageIcon,
      dirty,
      readOnly,
      diagnosticsCount,
      pendingAgentChange,
    };
  }

  /**
   * Compute disambiguation paths for all provided URIs.
   * Returns a map from canonical URI to its tab metadata.
   */
  getTabMetadataForAll(uris: string[]): Map<string, TabMetadata> {
    const result = new Map<string, TabMetadata>();
    for (const uri of uris) {
      const canonicalUri = canonicalizeUri(uri);
      result.set(canonicalUri, this.getTabMetadata(uri, uris));
    }
    return result;
  }
}
