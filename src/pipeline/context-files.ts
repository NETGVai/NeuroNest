/**
 * Context Files — Project-Level Instructions
 *
 * Scans the project directory for context files that shape every AI conversation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CONTEXT_FILES = [
  'NEURONEST.md',
  'AGENTS.md',
  'CONTEXT.md',
  '.neuronest/context.md',
  '.neuronest/instructions.md',
];

const MAX_CONTEXT_CHARS = 4000;

export function loadProjectContextFiles(projectDir: string): string {
  if (!projectDir || !fs.existsSync(projectDir)) return '';

  const sections: string[] = [];
  let totalChars = 0;

  for (const file of CONTEXT_FILES) {
    const filePath = path.join(projectDir, file);
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > 50_000) continue;
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content.length > 0) {
          const section = `[${file}]\n${content}`;
          if (totalChars + section.length > MAX_CONTEXT_CHARS) {
            const remaining = MAX_CONTEXT_CHARS - totalChars - 20;
            if (remaining > 100) sections.push(`[${file}]\n${content.slice(0, remaining)}...[truncated]`);
            break;
          }
          sections.push(section);
          totalChars += section.length;
        }
      }
    } catch {}
  }

  if (sections.length === 0) return '';
  return '--- PROJECT CONTEXT FILES ---\n' + sections.join('\n\n') + '\n--- END PROJECT CONTEXT ---';
}

export function hasContextFiles(projectDir: string): boolean {
  if (!projectDir || !fs.existsSync(projectDir)) return false;
  return CONTEXT_FILES.some(file => {
    try { return fs.existsSync(path.join(projectDir, file)); } catch { return false; }
  });
}
