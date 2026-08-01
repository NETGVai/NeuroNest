/**
 * File reference link component for the chat panel.
 * Detects file paths in chat messages and renders them as clickable links.
 * Clicking opens the file in the editor panel or reveals it in the file tree.
 * Uses IPC channel `chat:open-file-reference` with `{ path: string, line?: number }`.
 *
 * Requirements: 23.2, 23.15
 */

/** CSS class names scoped to file reference links. */
const CSS = {
  link: 'nn-file-ref',
  linkIcon: 'nn-file-ref__icon',
  linkPath: 'nn-file-ref__path',
  linkLine: 'nn-file-ref__line',
} as const;

/** IPC channel used to open file references. */
const IPC_CHANNEL = 'chat:open-file-reference';

/**
 * Regex pattern to detect file paths in text content.
 * Matches patterns like:
 *   src/renderer/main.ts
 *   src/renderer/main.ts:42
 *   `src/renderer/main.ts`
 *   ./config/settings.json:10
 *   /absolute/path/file.ts
 *
 * Captures: (path)(optional :lineNumber)
 */
const FILE_PATH_REGEX =
  /(?:^|[\s`"'([\]{])((\.{0,2}\/)?[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]{1,10})(?::(\d+))?(?=[`"')\]}\s,;:]|$)/gm;

/** Minimum path segments to reduce false positives. */
const MIN_PATH_SEGMENTS = 2;

/** Known source file extensions to avoid matching domain names or abbreviations. */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'yaml', 'yml', 'toml',
  'md', 'mdx', 'txt', 'csv',
  'html', 'css', 'scss', 'less', 'sass',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql',
  'xml', 'svg', 'vue', 'svelte',
  'c', 'cpp', 'h', 'hpp',
  'env', 'gitignore', 'dockerignore',
  'dockerfile', 'makefile',
  'lock', 'config', 'cfg',
]);

/** Parsed file reference extracted from text. */
export interface FileReference {
  /** Full matched text (e.g. "src/file.ts:42"). */
  match: string;
  /** File path without line number. */
  path: string;
  /** Optional line number. */
  line?: number;
  /** Start index in the original text. */
  startIndex: number;
  /** End index in the original text. */
  endIndex: number;
}

/**
 * Typed wrapper around the preload-exposed IPC bridge.
 * Falls back to no-op if the bridge is unavailable (e.g. in unit tests).
 */
function getIpcBridge(): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const bridge = (window as unknown as Record<string, unknown>).electronAPI as {
    invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>;
  } | undefined;

  return {
    invoke: bridge?.invoke ?? (async () => undefined),
  };
}

/** Injects scoped styles for file reference links. */
function injectStyles(): void {
  if (document.getElementById('nn-file-ref-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-file-ref-styles';
  style.textContent = `
    .${CSS.link} {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--file-ref-bg, rgba(86, 156, 214, 0.12));
      color: var(--file-ref-text, #569cd6);
      text-decoration: none;
      font-family: var(--font-mono, 'SF Mono', 'Fira Code', monospace);
      font-size: 0.9em;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
      line-height: 1.4;
    }
    .${CSS.link}:hover {
      background: var(--file-ref-hover-bg, rgba(86, 156, 214, 0.22));
      color: var(--file-ref-hover-text, #79b8f8);
      text-decoration: underline;
    }
    .${CSS.link}:focus-visible {
      outline: 2px solid var(--focus-ring, #569cd6);
      outline-offset: 1px;
    }
    .${CSS.linkIcon} {
      font-size: 0.85em;
      opacity: 0.8;
      flex-shrink: 0;
    }
    .${CSS.linkPath} {
      word-break: break-all;
    }
    .${CSS.linkLine} {
      color: var(--file-ref-line-text, #888888);
      font-size: 0.85em;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Determine if a matched path looks like a valid file reference.
 * Helps filter false positives (URLs, version numbers, etc.).
 */
function isValidFilePath(path: string): boolean {
  // Must have at least MIN_PATH_SEGMENTS segments (directory/file)
  const segments = path.split('/').filter(Boolean);
  if (segments.length < MIN_PATH_SEGMENTS) return false;

  // Extract extension
  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1) return false;

  const ext = path.slice(lastDot + 1).toLowerCase();
  if (!FILE_EXTENSIONS.has(ext)) return false;

  // Reject patterns that look like URLs
  if (path.includes('://') || path.includes('www.')) return false;

  // Reject patterns that are version strings (e.g. v1.2.3)
  if (/^v?\d+\.\d+\.\d+/.test(path)) return false;

  return true;
}

/**
 * Parse file references from a text string.
 * Returns an array of detected file references with their positions.
 */
export function parseFileReferences(text: string): FileReference[] {
  const refs: FileReference[] = [];
  const regex = new RegExp(FILE_PATH_REGEX.source, FILE_PATH_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1];
    const lineStr = match[3];

    if (!isValidFilePath(filePath)) continue;

    const fullMatch = lineStr ? `${filePath}:${lineStr}` : filePath;
    const startIndex = match.index + (match[0].indexOf(filePath));
    const endIndex = startIndex + fullMatch.length;

    refs.push({
      match: fullMatch,
      path: filePath,
      line: lineStr ? parseInt(lineStr, 10) : undefined,
      startIndex,
      endIndex,
    });
  }

  return refs;
}

/**
 * Create a clickable file reference link element.
 * Clicking sends an IPC message to open the file in the editor.
 */
export function createFileReferenceLink(ref: FileReference): HTMLElement {
  injectStyles();

  const link = document.createElement('a');
  link.className = CSS.link;
  link.setAttribute('role', 'link');
  link.setAttribute('tabindex', '0');
  link.setAttribute('aria-label', `Open file ${ref.path}${ref.line ? ` at line ${ref.line}` : ''}`);
  link.title = `Open ${ref.path}${ref.line ? `:${ref.line}` : ''}`;

  // File icon
  const icon = document.createElement('span');
  icon.className = CSS.linkIcon;
  icon.textContent = '📄';
  icon.setAttribute('aria-hidden', 'true');
  link.appendChild(icon);

  // File path text
  const pathSpan = document.createElement('span');
  pathSpan.className = CSS.linkPath;
  pathSpan.textContent = ref.path;
  link.appendChild(pathSpan);

  // Optional line number
  if (ref.line !== undefined) {
    const lineSpan = document.createElement('span');
    lineSpan.className = CSS.linkLine;
    lineSpan.textContent = `:${ref.line}`;
    link.appendChild(lineSpan);
  }

  // Click handler — open file via IPC
  const handleOpen = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();

    const bridge = getIpcBridge();
    bridge.invoke(IPC_CHANNEL, { path: ref.path, line: ref.line });
  };

  link.addEventListener('click', handleOpen);
  link.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      handleOpen(e);
    }
  });

  return link;
}

/**
 * Process a text content element and replace detected file paths with clickable links.
 * Operates on the textContent of the provided element, replacing it with a mix of
 * text nodes and file reference link elements.
 *
 * @param element - The DOM element whose text content should be processed.
 * @returns The number of file references found and linked.
 */
export function processFileReferences(element: HTMLElement): number {
  const text = element.textContent || '';
  const refs = parseFileReferences(text);

  if (refs.length === 0) return 0;

  // Sort references by startIndex to process in order
  refs.sort((a, b) => a.startIndex - b.startIndex);

  // Build new content with links replacing file paths
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;

  for (const ref of refs) {
    // Add text before this reference
    if (ref.startIndex > lastIndex) {
      const textBefore = text.slice(lastIndex, ref.startIndex);
      fragment.appendChild(document.createTextNode(textBefore));
    }

    // Add the file reference link
    fragment.appendChild(createFileReferenceLink(ref));
    lastIndex = ref.endIndex;
  }

  // Add remaining text after last reference
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  // Replace element content
  element.innerHTML = '';
  element.appendChild(fragment);

  return refs.length;
}
