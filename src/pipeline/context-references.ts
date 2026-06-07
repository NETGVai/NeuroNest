/**
 * Context References — Inline @mentions for precise context control.
 *
 * @url https://... — Fetches webpage and converts to markdown
 * @file path/to/file — Adds file contents to context
 * @folder path/to/dir — Adds all files in directory
 * @problems — Adds current workspace errors/warnings
 */

import fs from 'node:fs';
import path from 'node:path';
import { UntrustedContextBuilder, wrapUntrusted } from './untrusted-context';
import { recordUntrustedWrap, type MetricsSink } from './untrusted-telemetry';
import { PERF_FLAGS } from '../main/performance/feature-flags';

export interface ContextRef {
  type: 'url' | 'file' | 'folder' | 'problems';
  value: string;
  content: string;
  tokenEstimate: number;
}

/**
 * Parse @references from a message and resolve them.
 */
export async function resolveContextRefs(
  message: string,
  projectPath: string,
  fetchUrl?: (url: string) => Promise<string>,
  getProblems?: () => string,
): Promise<{ cleanMessage: string; refs: ContextRef[] }> {
  const refs: ContextRef[] = [];
  let cleanMessage = message;

  // @url https://...
  const urlPattern = /@url\s+(https?:\/\/[^\s]+)/gi;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(message)) !== null) {
    const url = urlMatch[1];
    let content = '';
    try {
      if (fetchUrl) {
        content = await fetchUrl(url);
      } else {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const html = await response.text();
        content = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30000);
      }
    } catch (e: any) { content = `Error fetching ${url}: ${e.message}`; }

    refs.push({ type: 'url', value: url, content, tokenEstimate: Math.ceil(content.length / 4) });
    cleanMessage = cleanMessage.replace(urlMatch[0], '').trim();
  }

  // @file path/to/file
  const filePattern = /@file\s+([^\s@]+)/gi;
  let fileMatch;
  while ((fileMatch = filePattern.exec(message)) !== null) {
    const filePath = fileMatch[1];
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
    let content = '';
    try {
      if (fs.existsSync(fullPath)) {
        content = fs.readFileSync(fullPath, 'utf-8').slice(0, 50000);
      } else { content = `File not found: ${filePath}`; }
    } catch (e: any) { content = `Error reading ${filePath}: ${e.message}`; }

    refs.push({ type: 'file', value: filePath, content: `--- ${filePath} ---\n${content}`, tokenEstimate: Math.ceil(content.length / 4) });
    cleanMessage = cleanMessage.replace(fileMatch[0], '').trim();
  }

  // @folder path/to/dir
  const folderPattern = /@folder\s+([^\s@]+)/gi;
  let folderMatch;
  while ((folderMatch = folderPattern.exec(message)) !== null) {
    const dirPath = folderMatch[1];
    const fullDir = path.isAbsolute(dirPath) ? dirPath : path.join(projectPath, dirPath);
    let content = '';
    try {
      if (fs.existsSync(fullDir) && fs.statSync(fullDir).isDirectory()) {
        const files = fs.readdirSync(fullDir).filter(f => !f.startsWith('.'));
        for (const file of files.slice(0, 20)) {
          const fp = path.join(fullDir, file);
          if (fs.statSync(fp).isFile()) {
            const fc = fs.readFileSync(fp, 'utf-8').slice(0, 10000);
            content += `--- ${dirPath}/${file} ---\n${fc}\n\n`;
          }
        }
        if (files.length > 20) content += `... and ${files.length - 20} more files\n`;
      } else { content = `Directory not found: ${dirPath}`; }
    } catch (e: any) { content = `Error reading ${dirPath}: ${e.message}`; }

    refs.push({ type: 'folder', value: dirPath, content, tokenEstimate: Math.ceil(content.length / 4) });
    cleanMessage = cleanMessage.replace(folderMatch[0], '').trim();
  }

  // @problems
  if (/@problems\b/i.test(message)) {
    const content = getProblems ? getProblems() : 'No diagnostics available.';
    refs.push({ type: 'problems', value: 'workspace', content, tokenEstimate: Math.ceil(content.length / 4) });
    cleanMessage = cleanMessage.replace(/@problems\b/gi, '').trim();
  }

  return { cleanMessage, refs };
}

/**
 * Build the context string from resolved references.
 *
 * When `PERF_FLAGS.UNTRUSTED_SOURCE_WRAP` is enabled, each referenced segment
 * is routed through an {@link UntrustedContextBuilder} (source
 * `'context-references'`) with a per-reference label `${ref.type}: ${ref.value}`,
 * so external content is framed with the Untrusted_Source_Wrapper delimiters
 * and policy header before it reaches the LLM (Requirement 5.2). This site
 * returns a `string`, so the builder's framed `content` is folded into the
 * existing context string — the trust metadata on `build()` is the documented
 * unused-in-v1 secondary signal. When the flag is disabled, the pre-existing
 * unwrapped path is preserved exactly (Requirement 4.4).
 *
 * When `metricsSink` is supplied and the flag is on, each wrapped reference
 * segment records `untrusted_wrap.invocations` + `untrusted_wrap.wrapped_bytes`
 * to the Metrics_Sink (Requirements 5.5, 5.6). Telemetry is fail-soft and
 * recorded once per actual wrap (one per reference), so counts are never
 * double-recorded.
 */
export function buildContextString(
  refs: ContextRef[],
  metricsSink?: MetricsSink | null,
  sessionId: string | null = null,
): string {
  if (refs.length === 0) return '';

  if (PERF_FLAGS.UNTRUSTED_SOURCE_WRAP) {
    const builder = new UntrustedContextBuilder('context-references');
    for (const ref of refs) {
      const label = `${ref.type}: ${ref.value}`;
      builder.append(ref.content, label);
      // Record F1 telemetry for this single wrapped segment. The byte length
      // is taken from the same framing the builder applies (Requirements 5.5,
      // 5.6).
      recordUntrustedWrap(metricsSink, wrapUntrusted(ref.content, label), sessionId);
    }
    return '\n\n--- Referenced Context ---\n\n' + builder.build().content + '\n\n';
  }

  let ctx = '\n\n--- Referenced Context ---\n\n';
  for (const ref of refs) {
    ctx += `[${ref.type}: ${ref.value}]\n${ref.content}\n\n`;
  }
  return ctx;
}

/**
 * Detect @references in a message (for UI highlighting).
 */
export function detectRefs(message: string): Array<{ type: string; value: string; start: number; end: number }> {
  const refs: Array<{ type: string; value: string; start: number; end: number }> = [];
  const patterns = [
    { type: 'url', regex: /@url\s+(https?:\/\/[^\s]+)/gi },
    { type: 'file', regex: /@file\s+([^\s@]+)/gi },
    { type: 'folder', regex: /@folder\s+([^\s@]+)/gi },
    { type: 'problems', regex: /@problems\b/gi },
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.regex.exec(message)) !== null) {
      refs.push({ type: p.type, value: m[1] || 'workspace', start: m.index, end: m.index + m[0].length });
    }
  }
  return refs;
}
