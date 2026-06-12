/**
 * DangerPatternScorer — detects eval, exec, network calls, and obfuscation patterns.
 *
 * Scans file content in an edit for dangerous code patterns that may indicate
 * malicious or unsafe agent behavior.
 */
import type { AnomalyScorer, AnomalyScore, AgentEdit, TaskContext } from './types';

/** A dangerous pattern to scan for in code changes. */
interface DangerPattern {
  name: string;
  regex: RegExp;
  severity: 'high' | 'medium' | 'low';
  description: string;
}

/** Built-in dangerous patterns to detect. */
const DANGER_PATTERNS: DangerPattern[] = [
  // Code execution
  {
    name: 'eval',
    regex: /\beval\s*\(/g,
    severity: 'high',
    description: 'Dynamic code execution via eval()',
  },
  {
    name: 'Function-constructor',
    regex: /new\s+Function\s*\(/g,
    severity: 'high',
    description: 'Dynamic code execution via Function constructor',
  },
  {
    name: 'exec-child-process',
    regex: /\b(?:execSync|exec|execFile|spawn|spawnSync|fork)\s*\(/g,
    severity: 'high',
    description: 'Shell command execution via child_process',
  },
  {
    name: 'require-child-process',
    regex: /require\s*\(\s*['"]child_process['"]\s*\)/g,
    severity: 'high',
    description: 'Import of child_process module',
  },

  // Network access
  {
    name: 'network-fetch',
    regex: /\bfetch\s*\(\s*['"`]https?:/g,
    severity: 'medium',
    description: 'Outbound network request via fetch()',
  },
  {
    name: 'network-http-request',
    regex: /\b(?:http|https)\.(?:get|request|post)\s*\(/g,
    severity: 'medium',
    description: 'Outbound HTTP request via http/https module',
  },
  {
    name: 'network-xmlhttp',
    regex: /new\s+XMLHttpRequest\s*\(/g,
    severity: 'medium',
    description: 'Outbound request via XMLHttpRequest',
  },
  {
    name: 'network-websocket',
    regex: /new\s+WebSocket\s*\(/g,
    severity: 'medium',
    description: 'WebSocket connection initiation',
  },

  // Obfuscation
  {
    name: 'base64-atob',
    regex: /\b(?:atob|btoa)\s*\(/g,
    severity: 'low',
    description: 'Base64 encoding/decoding (possible obfuscation)',
  },
  {
    name: 'hex-encoding',
    regex: /\\x[0-9a-fA-F]{2}(?:\\x[0-9a-fA-F]{2}){3,}/g,
    severity: 'medium',
    description: 'Hex-encoded string sequences (possible obfuscation)',
  },
  {
    name: 'string-fromCharCode',
    regex: /String\.fromCharCode\s*\(/g,
    severity: 'medium',
    description: 'String construction from char codes (possible obfuscation)',
  },
  {
    name: 'dynamic-import',
    regex: /import\s*\(\s*[^'"]/g,
    severity: 'low',
    description: 'Dynamic import with non-literal module path',
  },

  // File system manipulation
  {
    name: 'fs-unlink',
    regex: /\b(?:unlinkSync|unlink|rmSync|rmdirSync)\s*\(/g,
    severity: 'medium',
    description: 'File/directory deletion',
  },
  {
    name: 'fs-chmod',
    regex: /\b(?:chmodSync|chmod|chown|chownSync)\s*\(/g,
    severity: 'medium',
    description: 'File permission modification',
  },
];

export class DangerPatternScorer implements AnomalyScorer {
  readonly name = 'DangerPatternScorer';

  async score(edit: AgentEdit, _context: TaskContext): Promise<AnomalyScore> {
    const concerns: string[] = [];
    const detectedPatterns = new Set<string>();
    let highSeverityCount = 0;
    let mediumSeverityCount = 0;

    for (const file of edit.files) {
      for (const pattern of DANGER_PATTERNS) {
        // Reset regex state for each file
        pattern.regex.lastIndex = 0;
        const matches = file.content.match(pattern.regex);

        if (matches && matches.length > 0) {
          if (!detectedPatterns.has(pattern.name)) {
            detectedPatterns.add(pattern.name);
            concerns.push(`${pattern.description} in ${file.filePath}`);
          }

          if (pattern.severity === 'high') {
            highSeverityCount++;
          } else if (pattern.severity === 'medium') {
            mediumSeverityCount++;
          }
        }
      }
    }

    // Flag if any high-severity pattern found, or multiple medium-severity
    const flagged = highSeverityCount > 0 || mediumSeverityCount >= 2;
    const confidence = Math.min(
      1.0,
      highSeverityCount * 0.4 + mediumSeverityCount * 0.2
    );

    return { flagged, confidence, concerns };
  }
}
