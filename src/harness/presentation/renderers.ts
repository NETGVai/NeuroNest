/**
 * Typed Intent Renderers
 *
 * Each renderer handles one specific RenderIntentV1.kind plus the
 * associated CanonicalToolValueV1. Renderers never branch on tool names;
 * tool names remain display metadata only.
 *
 * Requirements: 13.8, 35.5–35.6, 35.11–35.13, 37.5–37.6
 */

import type {
  RenderIntentV1,
  GenericIntentV1,
  ReadIntentV1,
  SearchIntentV1,
  DiffIntentV1,
  TerminalIntentV1,
  WebIntentV1,
  ImageIntentV1,
  TableIntentV1,
  TreeIntentV1,
  ArtifactIntentV1,
} from '../contracts/render-intent';
import type { CanonicalToolValueV1 } from '../contracts/tool-value';
import type { IntentRenderer, PresentationOutput, ContentBlock } from './types';
import { sanitizeContent, sanitizeUrl, sanitizeFilePath } from './sanitize';

// ─── Helpers ────────────────────────────────────────────────────

/** Maximum bytes of content to show before marking as expandable. */
const MAX_PREVIEW_CHARS = 10_000;

function extractStringValue(value: CanonicalToolValueV1): string {
  if (typeof value.value === 'string') return value.value;
  if (value.value != null) {
    try {
      return JSON.stringify(value.value, null, 2);
    } catch {
      return String(value.value);
    }
  }
  return '';
}

function buildOutput(
  kind: RenderIntentV1['kind'] | 'fallback',
  blocks: ContentBlock[],
  callId: string,
  sanitizationReasons: string[] = [],
): PresentationOutput {
  return {
    dispatchedKind: kind,
    blocks,
    isFallback: kind === 'fallback',
    sanitizationReasons,
    callId,
  };
}

function sanitizeAndTruncate(raw: string): { text: string; truncated: boolean; reasons: string[] } {
  const sanitized = sanitizeContent(raw);
  const truncated = sanitized.text.length > MAX_PREVIEW_CHARS;
  const text = truncated ? sanitized.text.slice(0, MAX_PREVIEW_CHARS) : sanitized.text;
  return { text, truncated, reasons: sanitized.reasons };
}

// ─── Generic Renderer ───────────────────────────────────────────

export const genericRenderer: IntentRenderer<'generic'> = {
  kind: 'generic',
  render(intent: GenericIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);

    const blocks: ContentBlock[] = [{
      kind: 'generic_card',
      content: text,
      accessibilityLabel: intent.label || 'Tool result',
      expandable: truncated,
      truncated,
    }];

    return buildOutput('generic', blocks, value.callId, reasons);
  },
};

// ─── Read (File Content) Renderer ───────────────────────────────

export const readRenderer: IntentRenderer<'read'> = {
  kind: 'read',
  render(intent: ReadIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);
    const displayPath = sanitizeFilePath(intent.filePath);

    const lineInfo = intent.startLine != null && intent.endLine != null
      ? ` (lines ${intent.startLine}–${intent.endLine})`
      : '';

    const lang = intent.language || inferLanguage(displayPath);
    const block: ContentBlock = {
      kind: 'code',
      content: text,
      accessibilityLabel: `File content: ${displayPath}${lineInfo}`,
      expandable: truncated,
      truncated,
      metadata: {
        filePath: displayPath,
        startLine: intent.startLine,
        endLine: intent.endLine,
      },
    };
    if (lang) block.language = lang;

    const blocks: ContentBlock[] = [block];

    return buildOutput('read', blocks, value.callId, reasons);
  },
};

// ─── Search Results Renderer ────────────────────────────────────

export const searchRenderer: IntentRenderer<'search'> = {
  kind: 'search',
  render(intent: SearchIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);

    const resultLabel = intent.resultCount != null
      ? `${intent.resultCount} results`
      : 'Search results';

    const blocks: ContentBlock[] = [{
      kind: 'search_results',
      content: text,
      accessibilityLabel: `Search for "${intent.query}": ${resultLabel}`,
      expandable: truncated,
      truncated,
      metadata: {
        query: intent.query,
        resultCount: intent.resultCount,
      },
    }];

    return buildOutput('search', blocks, value.callId, reasons);
  },
};

// ─── Diff Renderer ──────────────────────────────────────────────

export const diffRenderer: IntentRenderer<'diff'> = {
  kind: 'diff',
  render(intent: DiffIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);
    const displayPath = sanitizeFilePath(intent.filePath);

    const stats: string[] = [];
    if (intent.hunks != null) stats.push(`${intent.hunks} hunks`);
    if (intent.additions != null) stats.push(`+${intent.additions}`);
    if (intent.deletions != null) stats.push(`-${intent.deletions}`);

    const blocks: ContentBlock[] = [{
      kind: 'diff',
      content: text,
      language: 'diff',
      accessibilityLabel: `Diff: ${displayPath}${stats.length ? ` (${stats.join(', ')})` : ''}`,
      expandable: truncated,
      truncated,
      metadata: {
        filePath: displayPath,
        hunks: intent.hunks,
        additions: intent.additions,
        deletions: intent.deletions,
      },
    }];

    return buildOutput('diff', blocks, value.callId, reasons);
  },
};

// ─── Terminal Renderer ──────────────────────────────────────────

export const terminalRenderer: IntentRenderer<'terminal'> = {
  kind: 'terminal',
  render(intent: TerminalIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);

    const exitLabel = intent.exitCode != null
      ? ` (exit ${intent.exitCode})`
      : '';

    const blocks: ContentBlock[] = [{
      kind: 'terminal',
      content: text,
      language: 'shell',
      accessibilityLabel: `Terminal output${intent.command ? `: ${intent.command}` : ''}${exitLabel}`,
      expandable: truncated,
      truncated,
      metadata: {
        command: intent.command,
        exitCode: intent.exitCode,
      },
    }];

    return buildOutput('terminal', blocks, value.callId, reasons);
  },
};

// ─── Web/Citation Renderer ──────────────────────────────────────

export const webRenderer: IntentRenderer<'web'> = {
  kind: 'web',
  render(intent: WebIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);
    const safeUrl = sanitizeUrl(intent.url);

    const blocks: ContentBlock[] = [{
      kind: 'web_citation',
      content: text,
      accessibilityLabel: intent.title
        ? `Web content: ${intent.title}`
        : safeUrl
          ? `Web content from ${safeUrl}`
          : 'Web content',
      expandable: truncated,
      truncated,
      metadata: {
        url: safeUrl,
        title: intent.title,
        citation: intent.citation,
      },
    }];

    return buildOutput('web', blocks, value.callId, reasons);
  },
};

// ─── Image Renderer ─────────────────────────────────────────────

export const imageRenderer: IntentRenderer<'image'> = {
  kind: 'image',
  render(intent: ImageIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    // For images, the value might be a data URI, URL, or base64 content.
    // Sanitize but don't aggressively truncate image references.
    const sanitized = sanitizeContent(raw);

    const dimensions = intent.width && intent.height
      ? ` (${intent.width}x${intent.height})`
      : '';

    const blocks: ContentBlock[] = [{
      kind: 'image',
      content: sanitized.text,
      accessibilityLabel: intent.alt || `Image${dimensions}`,
      metadata: {
        alt: intent.alt,
        width: intent.width,
        height: intent.height,
        mediaType: intent.mediaType,
      },
    }];

    return buildOutput('image', blocks, value.callId, sanitized.reasons);
  },
};

// ─── Table Renderer ─────────────────────────────────────────────

export const tableRenderer: IntentRenderer<'table'> = {
  kind: 'table',
  render(intent: TableIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);

    const info: string[] = [];
    if (intent.columns != null) info.push(`${intent.columns} columns`);
    if (intent.rows != null) info.push(`${intent.rows} rows`);

    const blocks: ContentBlock[] = [{
      kind: 'table',
      content: text,
      accessibilityLabel: intent.caption
        ? `Table: ${intent.caption}`
        : `Table${info.length ? ` (${info.join(', ')})` : ''}`,
      expandable: truncated,
      truncated,
      metadata: {
        columns: intent.columns,
        rows: intent.rows,
        caption: intent.caption,
      },
    }];

    return buildOutput('table', blocks, value.callId, reasons);
  },
};

// ─── Tree Renderer ──────────────────────────────────────────────

export const treeRenderer: IntentRenderer<'tree'> = {
  kind: 'tree',
  render(intent: TreeIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);

    const info: string[] = [];
    if (intent.depth != null) info.push(`depth ${intent.depth}`);
    if (intent.nodeCount != null) info.push(`${intent.nodeCount} nodes`);

    const blocks: ContentBlock[] = [{
      kind: 'tree',
      content: text,
      accessibilityLabel: intent.rootLabel
        ? `Tree: ${intent.rootLabel}`
        : `Tree${info.length ? ` (${info.join(', ')})` : ''}`,
      expandable: truncated,
      truncated,
      metadata: {
        rootLabel: intent.rootLabel,
        depth: intent.depth,
        nodeCount: intent.nodeCount,
      },
    }];

    return buildOutput('tree', blocks, value.callId, reasons);
  },
};

// ─── Artifact Renderer ──────────────────────────────────────────

export const artifactRenderer: IntentRenderer<'artifact'> = {
  kind: 'artifact',
  render(intent: ArtifactIntentV1, value: CanonicalToolValueV1): PresentationOutput {
    const raw = extractStringValue(value);
    const { text, truncated, reasons } = sanitizeAndTruncate(raw);

    const blocks: ContentBlock[] = [{
      kind: 'artifact',
      content: text,
      accessibilityLabel: intent.title
        ? `Artifact: ${intent.title}`
        : `Artifact ${intent.artifactId}`,
      expandable: truncated,
      truncated,
      metadata: {
        artifactId: intent.artifactId,
        artifactType: intent.artifactType,
        title: intent.title,
      },
    }];

    return buildOutput('artifact', blocks, value.callId, reasons);
  },
};

// ─── Language Inference ─────────────────────────────────────────

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.xml': 'xml',
};

function inferLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex < 0) return undefined;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext];
}
