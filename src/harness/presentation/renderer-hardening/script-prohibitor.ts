/**
 * Script and Event-Handler Prohibitor
 *
 * Ensures no script execution or event-handler invocation can occur
 * within rendered content. This module provides a secondary defense
 * layer beyond content sanitization, specifically targeting dynamic
 * execution vectors.
 *
 * Requirements: 9.9, 37.9–37.11, 45.10
 */

import type { SanitizationFinding } from './types';

// ─── Script Detection Patterns ──────────────────────────────────

/**
 * Patterns that indicate script execution vectors.
 * These go beyond simple <script> tags to catch all known execution paths.
 */
const SCRIPT_EXECUTION_VECTORS: ReadonlyArray<{ pattern: RegExp; category: string; description: string }> = [
  // Direct script elements
  { pattern: /<script[\s>]/gi, category: 'script_element', description: 'Script element detected' },
  { pattern: /<\/script>/gi, category: 'script_element', description: 'Script close tag detected' },

  // Event handler attributes
  { pattern: /\bon\w+\s*=\s*["'][^"']*["']/gi, category: 'event_handler', description: 'Event handler attribute detected' },
  { pattern: /\bon\w+\s*=\s*[^"'\s>]+/gi, category: 'event_handler', description: 'Unquoted event handler detected' },

  // JavaScript/VBScript protocol handlers
  { pattern: /javascript\s*:/gi, category: 'protocol_handler', description: 'JavaScript protocol handler detected' },
  { pattern: /vbscript\s*:/gi, category: 'protocol_handler', description: 'VBScript protocol handler detected' },
  { pattern: /livescript\s*:/gi, category: 'protocol_handler', description: 'LiveScript protocol handler detected' },

  // Dynamic evaluation
  { pattern: /\beval\s*\(/g, category: 'dynamic_eval', description: 'eval() call detected' },
  { pattern: /\bnew\s+Function\s*\(/g, category: 'dynamic_eval', description: 'new Function() call detected' },
  { pattern: /\bsetTimeout\s*\(\s*["']/g, category: 'dynamic_eval', description: 'setTimeout with string detected' },
  { pattern: /\bsetInterval\s*\(\s*["']/g, category: 'dynamic_eval', description: 'setInterval with string detected' },

  // DOM manipulation that could enable script execution
  { pattern: /\.innerHTML\s*=/g, category: 'dom_injection', description: 'innerHTML assignment detected' },
  { pattern: /\.outerHTML\s*=/g, category: 'dom_injection', description: 'outerHTML assignment detected' },
  { pattern: /\.insertAdjacentHTML\s*\(/g, category: 'dom_injection', description: 'insertAdjacentHTML call detected' },
  { pattern: /document\.write\s*\(/g, category: 'dom_injection', description: 'document.write call detected' },
  { pattern: /document\.writeln\s*\(/g, category: 'dom_injection', description: 'document.writeln call detected' },

  // Import/require for module execution
  { pattern: /\bimport\s*\(/g, category: 'module_import', description: 'Dynamic import() detected' },
  { pattern: /\brequire\s*\(/g, category: 'module_import', description: 'require() call detected' },

  // CSS expression execution (IE legacy but still dangerous)
  { pattern: /expression\s*\(/gi, category: 'css_expression', description: 'CSS expression() detected' },
  { pattern: /-moz-binding\s*:/gi, category: 'css_expression', description: 'CSS -moz-binding detected' },
  { pattern: /behavior\s*:/gi, category: 'css_expression', description: 'CSS behavior property detected' },

  // Data URI execution vectors
  { pattern: /data\s*:\s*text\/html/gi, category: 'data_uri_exec', description: 'Executable data URI detected' },
  { pattern: /data\s*:\s*application\/javascript/gi, category: 'data_uri_exec', description: 'JavaScript data URI detected' },
  { pattern: /data\s*:\s*application\/x-javascript/gi, category: 'data_uri_exec', description: 'JavaScript data URI detected' },

  // SVG script execution
  { pattern: /<svg[^>]*on\w+/gi, category: 'svg_execution', description: 'SVG with event handler detected' },
  { pattern: /<animate[^>]*on\w+/gi, category: 'svg_execution', description: 'SVG animate with handler detected' },
  { pattern: /<set[^>]*on\w+/gi, category: 'svg_execution', description: 'SVG set with handler detected' },
];

// ─── Prohibition Result ─────────────────────────────────────────

export interface ProhibitionResult {
  /** Content with all execution vectors neutralized. */
  output: string;
  /** Whether content was modified. */
  modified: boolean;
  /** Detected execution vectors (detailed findings). */
  findings: SanitizationFinding[];
  /** Quick boolean: were any execution vectors detected? */
  hasViolations: boolean;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Prohibit script execution and event handlers in rendered content.
 *
 * This is the LAST line of defense before content reaches the renderer.
 * It operates after content sanitization and isolation assessment, providing
 * defense-in-depth against execution vectors that may have been missed.
 *
 * All detected vectors are neutralized by replacement with inert text.
 */
export function prohibitScripts(input: string): ProhibitionResult {
  const findings: SanitizationFinding[] = [];
  let output = input;
  let modified = false;

  for (const vector of SCRIPT_EXECUTION_VECTORS) {
    // Reset regex state
    const regex = new RegExp(vector.pattern.source, vector.pattern.flags);
    if (regex.test(output)) {
      const freshRegex = new RegExp(vector.pattern.source, vector.pattern.flags);
      output = output.replace(freshRegex, (match) => {
        modified = true;
        findings.push({
          severity: 'critical',
          category: vector.category,
          description: vector.description,
          offset: output.indexOf(match),
        });
        return `[blocked:${vector.category}]`;
      });
    }
  }

  return {
    output,
    modified,
    findings,
    hasViolations: findings.length > 0,
  };
}

/**
 * Quick check: does content contain any script/event-handler execution vectors?
 * Use this for fast pre-screening without full neutralization.
 */
export function detectsScriptVectors(input: string): boolean {
  for (const vector of SCRIPT_EXECUTION_VECTORS) {
    const regex = new RegExp(vector.pattern.source, vector.pattern.flags);
    if (regex.test(input)) return true;
  }
  return false;
}

/**
 * Count the number of distinct execution vector categories found.
 */
export function countVectorCategories(input: string): number {
  const categories = new Set<string>();
  for (const vector of SCRIPT_EXECUTION_VECTORS) {
    const regex = new RegExp(vector.pattern.source, vector.pattern.flags);
    if (regex.test(input)) {
      categories.add(vector.category);
    }
  }
  return categories.size;
}
