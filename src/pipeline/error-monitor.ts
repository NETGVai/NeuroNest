/**
 * Error Monitor — Watches for linter/compiler errors after file changes.
 *
 * After an agent edits a file, runs quick checks to detect:
 * - Syntax errors (via simple parsing)
 * - Missing imports (common patterns)
 * - TypeScript/ESLint errors (if tools available)
 *
 * Reports errors back so the agent can self-correct.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface DiagnosticError {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string; // 'syntax' | 'typescript' | 'eslint' | 'python'
}

/**
 * Run diagnostics on a file after it's been modified.
 */
export function checkFile(filePath: string, projectPath: string): DiagnosticError[] {
  const errors: DiagnosticError[] = [];
  const ext = path.extname(filePath).toLowerCase();
  const relPath = path.relative(projectPath, filePath);

  // Syntax check based on file type
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    errors.push(...checkJavaScriptSyntax(filePath, relPath));
    errors.push(...checkTypeScript(filePath, relPath, projectPath));
  } else if (ext === '.py') {
    errors.push(...checkPythonSyntax(filePath, relPath, projectPath));
  } else if (ext === '.json') {
    errors.push(...checkJsonSyntax(filePath, relPath));
  }

  return errors;
}

/**
 * Basic JavaScript/TypeScript syntax check.
 */
function checkJavaScriptSyntax(filePath: string, relPath: string): DiagnosticError[] {
  const errors: DiagnosticError[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for common syntax issues
    let braceCount = 0;
    let parenCount = 0;
    let bracketCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments and strings (simplified)
      const stripped = line.replace(/\/\/.*$/, '').replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '').replace(/`[^`]*`/g, '');

      for (const ch of stripped) {
        if (ch === '{') braceCount++;
        else if (ch === '}') braceCount--;
        else if (ch === '(') parenCount++;
        else if (ch === ')') parenCount--;
        else if (ch === '[') bracketCount++;
        else if (ch === ']') bracketCount--;
      }

      // Check for obvious issues
      if (/\bimport\b.*from\s+['"][^'"]*$/.test(line) && !lines[i + 1]?.trim().startsWith("'") && !lines[i + 1]?.trim().startsWith('"')) {
        errors.push({ file: relPath, line: i + 1, column: 1, severity: 'error', message: 'Unterminated import statement', source: 'syntax' });
      }
    }

    if (braceCount !== 0) {
      errors.push({ file: relPath, line: lines.length, column: 1, severity: 'error', message: `Unmatched braces: ${braceCount > 0 ? braceCount + ' unclosed' : Math.abs(braceCount) + ' extra closing'}`, source: 'syntax' });
    }
    if (parenCount !== 0) {
      errors.push({ file: relPath, line: lines.length, column: 1, severity: 'error', message: `Unmatched parentheses: ${parenCount > 0 ? parenCount + ' unclosed' : Math.abs(parenCount) + ' extra closing'}`, source: 'syntax' });
    }
  } catch { /* skip unreadable files */ }

  return errors;
}

/**
 * TypeScript compiler check (if tsc is available).
 */
function checkTypeScript(filePath: string, relPath: string, projectPath: string): DiagnosticError[] {
  const errors: DiagnosticError[] = [];
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.ts' && ext !== '.tsx') return errors;

  try {
    execSync(`npx tsc --noEmit --pretty false "${filePath}" 2>&1`, {
      cwd: projectPath, encoding: 'utf-8', timeout: 15000, stdio: 'pipe',
    });
  } catch (e: any) {
    const output = e.stdout || e.stderr || '';
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/);
      if (match) {
        errors.push({
          file: relPath, line: parseInt(match[2]), column: parseInt(match[3]),
          severity: match[4] === 'error' ? 'error' : 'warning',
          message: match[5], source: 'typescript',
        });
      }
    }
  }

  return errors.slice(0, 10); // Limit to 10 errors
}

/**
 * Python syntax check.
 */
function checkPythonSyntax(filePath: string, relPath: string, projectPath: string): DiagnosticError[] {
  const errors: DiagnosticError[] = [];
  try {
    execSync(`python3 -m py_compile "${filePath}" 2>&1`, {
      cwd: projectPath, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
    });
  } catch (e: any) {
    const output = e.stderr || e.stdout || '';
    const match = output.match(/line (\d+)/);
    errors.push({
      file: relPath, line: match ? parseInt(match[1]) : 1, column: 1,
      severity: 'error', message: output.split('\n').pop()?.trim() || 'Syntax error',
      source: 'python',
    });
  }
  return errors;
}

/**
 * JSON syntax check.
 */
function checkJsonSyntax(filePath: string, relPath: string): DiagnosticError[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    JSON.parse(content);
    return [];
  } catch (e: any) {
    const match = e.message.match(/position (\d+)/);
    const content = fs.readFileSync(filePath, 'utf-8');
    const pos = match ? parseInt(match[1]) : 0;
    const line = content.substring(0, pos).split('\n').length;
    return [{ file: relPath, line, column: 1, severity: 'error', message: e.message, source: 'syntax' }];
  }
}

/**
 * Run diagnostics on all recently modified files.
 */
export function checkProject(projectPath: string, modifiedFiles: string[]): DiagnosticError[] {
  const allErrors: DiagnosticError[] = [];
  for (const file of modifiedFiles) {
    const fullPath = path.isAbsolute(file) ? file : path.join(projectPath, file);
    if (fs.existsSync(fullPath)) {
      allErrors.push(...checkFile(fullPath, projectPath));
    }
  }
  return allErrors;
}
