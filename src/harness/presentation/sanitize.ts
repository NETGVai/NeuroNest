/**
 * Content Sanitization for Presentation Layer
 *
 * Ensures untrusted content from Render_Intent and Canonical_Tool_Value
 * cannot contain executable HTML, script, private paths, secrets,
 * or unrestricted locators.
 *
 * Requirements: 13.8, 35.11–35.13, 37.5–37.6, 37.9, 37.17
 */

// ─── Dangerous Patterns ─────────────────────────────────────────

const SCRIPT_PATTERNS: RegExp[] = [
  /<script[\s>]/i,
  /<\/script>/i,
  /javascript:/i,
  /vbscript:/i,
  /on\w+\s*=/i,
  /data:\s*text\/html/i,
];

const EXECUTABLE_PATTERNS: RegExp[] = [
  /import\s*\(/,
  /require\s*\(/,
  /eval\s*\(/,
  /Function\s*\(/,
  /document\.\w/,
  /window\.\w/,
  /globalThis\.\w/,
  /location\.\w/,
  /navigator\.\w/,
  /\.innerHTML\s*=/,
  /\.outerHTML\s*=/,
  /\.insertAdjacentHTML/,
];

/**
 * Patterns that indicate private filesystem paths.
 * Matches absolute paths on Unix and Windows that look like user directories.
 */
const PRIVATE_PATH_PATTERNS: RegExp[] = [
  /\/Users\/[^/\s]+\//,
  /\/home\/[^/\s]+\//,
  /\/root\//,
  /[A-Z]:\\Users\\[^\\]+\\/i,
  /~\//,
];

/**
 * Patterns for potential secrets/tokens.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9+/=_-]{16,}/i,
  /(?:sk|pk|rk|ak)-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36,}/,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/,
];

/**
 * Patterns for unrestricted locators that could bypass authorization.
 */
const UNRESTRICTED_LOCATOR_PATTERNS: RegExp[] = [
  /file:\/\/\//,
  /\\\\[^\\]+\\/,
];

// ─── Sanitization Result ────────────────────────────────────────

export interface SanitizeResult {
  /** Sanitized text safe for presentation. */
  text: string;
  /** Whether any content was stripped or replaced. */
  sanitized: boolean;
  /** Reasons content was modified. */
  reasons: string[];
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Sanitize text content for safe presentation. Strips executable HTML,
 * scripts, private paths, secrets, and unrestricted locators while
 * preserving the rest of the content.
 */
export function sanitizeContent(input: string): SanitizeResult {
  const reasons: string[] = [];
  let text = input;

  // Strip script and executable patterns
  for (const pattern of SCRIPT_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push('executable_script');
      text = text.replace(new RegExp(pattern.source, 'gi'), '[removed]');
    }
  }

  for (const pattern of EXECUTABLE_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push('executable_code');
      text = text.replace(new RegExp(pattern.source, 'g'), '[removed]');
    }
  }

  // Redact private paths
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push('private_path');
      text = text.replace(new RegExp(pattern.source, 'g'), '[redacted-path]');
    }
  }

  // Redact secrets
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push('secret_content');
      text = text.replace(new RegExp(pattern.source, 'gi'), '[redacted]');
    }
  }

  // Strip unrestricted locators
  for (const pattern of UNRESTRICTED_LOCATOR_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push('unrestricted_locator');
      text = text.replace(new RegExp(pattern.source, 'g'), '[removed-locator]');
    }
  }

  // Deduplicate reasons
  const uniqueReasons = [...new Set(reasons)];

  return {
    text,
    sanitized: uniqueReasons.length > 0,
    reasons: uniqueReasons,
  };
}

/**
 * Sanitize a URL for safe presentation and linking. Returns null if unsafe.
 */
export function sanitizeUrl(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  // Allow only http/https protocols
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Sanitize a file path for display. Strips private prefix information
 * to project-relative paths while preserving structure.
 */
export function sanitizeFilePath(filePath: string): string {
  let result = filePath;
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    result = result.replace(pattern, '');
  }
  for (const pattern of UNRESTRICTED_LOCATOR_PATTERNS) {
    result = result.replace(pattern, '');
  }
  // Remove leading slash if the path was made relative
  if (result.startsWith('/') && result !== filePath) {
    result = result.slice(1);
  }
  return result || filePath;
}

/**
 * Check if content contains any dangerous patterns.
 * Returns a list of reasons the content is unsafe, or empty if safe.
 */
export function checkContentSafety(input: string): string[] {
  const reasons: string[] = [];

  for (const pattern of SCRIPT_PATTERNS) {
    if (pattern.test(input)) {
      reasons.push('executable_script');
      break;
    }
  }

  for (const pattern of EXECUTABLE_PATTERNS) {
    if (pattern.test(input)) {
      reasons.push('executable_code');
      break;
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(input)) {
      reasons.push('secret_content');
      break;
    }
  }

  for (const pattern of UNRESTRICTED_LOCATOR_PATTERNS) {
    if (pattern.test(input)) {
      reasons.push('unrestricted_locator');
      break;
    }
  }

  return reasons;
}
