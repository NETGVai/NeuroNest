/**
 * Configuration parser for overwrite protection settings.
 * Parses the `# Overwrite Protection` and `# Project Identity` sections
 * from `.neuronest/rules.md` content.
 *
 * @module config-parser
 */

import { minimatch } from 'minimatch';
import type { OverwriteProtectionSettings, OverwriteGateConfig, ScopeDetectorConfig } from './types';

/**
 * Default explicit scope-change patterns that immediately classify
 * a prompt as a "new project request" regardless of divergence score.
 */
const DEFAULT_SCOPE_CHANGE_PATTERNS: RegExp[] = [
  /start fresh/i,
  /new project/i,
  /replace everything/i,
  /build a new/i,
  /create a new .+ app/i,
];

/**
 * Default configuration values when no rules.md section is found or parsing fails.
 */
function getDefaultSettings(): OverwriteProtectionSettings {
  return {
    overwriteGate: {
      enabled: true,
      relatednesThreshold: 0.2,
      excludedPaths: [],
    },
    scopeDetector: {
      enabled: true,
      threshold: 0.7,
      explicitScopeChangePatterns: DEFAULT_SCOPE_CHANGE_PATTERNS,
    },
  };
}

/**
 * Validates whether a glob pattern is well-formed by attempting a test match.
 * Returns true if the pattern is valid, false otherwise.
 */
function isValidGlobPattern(pattern: string): boolean {
  try {
    minimatch('test-file.ts', pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts a named section from markdown content.
 * Returns the content between the heading and the next heading of equal or lower level,
 * or until end of content.
 */
function extractSection(content: string, headingName: string): string | null {
  // Match the heading (# Heading Name) and capture until next # heading or end
  const headingPattern = new RegExp(
    `^#\\s+${escapeRegExp(headingName)}\\s*$`,
    'm'
  );
  const match = headingPattern.exec(content);
  if (!match) {
    return null;
  }

  const startIndex = match.index + match[0].length;
  const remaining = content.slice(startIndex);

  // Find next top-level heading (# Something)
  const nextHeadingMatch = /^#\s+/m.exec(remaining);
  const sectionContent = nextHeadingMatch
    ? remaining.slice(0, nextHeadingMatch.index)
    : remaining;

  return sectionContent.trim();
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses the `# Overwrite Protection` section from rules.md content.
 * Falls back to defaults if the section is missing or malformed.
 *
 * Expected format in rules.md:
 * ```
 * # Overwrite Protection
 * overwrite_protection: enabled
 * threshold: 20
 * scope_threshold: 0.7
 * excluded_paths: dist/*, build/*, *.generated.ts
 * ```
 *
 * @param rulesContent - The full content of the rules.md file, or null
 * @returns Parsed configuration settings with defaults applied for missing values
 */
export function parseOverwriteProtectionConfig(rulesContent: string | null): OverwriteProtectionSettings {
  const defaults = getDefaultSettings();

  if (!rulesContent) {
    return defaults;
  }

  const section = extractSection(rulesContent, 'Overwrite Protection');
  if (!section) {
    return defaults;
  }

  const overwriteGate: OverwriteGateConfig = { ...defaults.overwriteGate };
  const scopeDetector: ScopeDetectorConfig = {
    ...defaults.scopeDetector,
    explicitScopeChangePatterns: [...DEFAULT_SCOPE_CHANGE_PATTERNS],
  };

  // Parse each line for key: value pairs
  const lines = section.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const value = trimmed.slice(colonIdx + 1).trim();

    switch (key) {
      case 'overwrite_protection': {
        const normalizedValue = value.toLowerCase();
        if (normalizedValue === 'disabled') {
          overwriteGate.enabled = false;
          scopeDetector.enabled = false;
        } else if (normalizedValue === 'enabled') {
          overwriteGate.enabled = true;
          scopeDetector.enabled = true;
        }
        // Ignore unrecognized values — keep defaults
        break;
      }

      case 'threshold': {
        const parsed = parseFloat(value);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          overwriteGate.relatednesThreshold = parsed / 100;
        }
        // Ignore invalid values — keep default
        break;
      }

      case 'scope_threshold': {
        const parsed = parseFloat(value);
        if (!isNaN(parsed) && parsed >= 0.0 && parsed <= 1.0) {
          scopeDetector.threshold = parsed;
        }
        // Ignore invalid values — keep default
        break;
      }

      case 'excluded_paths': {
        const patterns = value
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);

        const validPatterns: string[] = [];
        for (const pattern of patterns) {
          if (isValidGlobPattern(pattern)) {
            validPatterns.push(pattern);
          } else {
            console.warn(
              `[overwrite-protection] Ignoring malformed glob pattern: "${pattern}"`
            );
          }
        }
        overwriteGate.excludedPaths = validPatterns;
        break;
      }

      default:
        // Ignore unknown keys
        break;
    }
  }

  return { overwriteGate, scopeDetector };
}

/**
 * Parses the `# Project Identity` section from rules.md content.
 * Returns the content string if it contains valid identity information,
 * or null if the section is missing, empty, or fails validation.
 *
 * Validation: the content must contain at least a project name or
 * technology stack reference (non-empty, meaningful text).
 *
 * @param rulesContent - The full content of the rules.md file, or null
 * @returns The identity section content if valid, null otherwise
 */
export function parseProjectIdentityOverride(rulesContent: string | null): string | null {
  if (!rulesContent) {
    return null;
  }

  const section = extractSection(rulesContent, 'Project Identity');
  if (!section) {
    return null;
  }

  // Validate that the content is meaningful (not just whitespace or punctuation)
  const meaningfulContent = section.replace(/[^a-zA-Z0-9]/g, '');
  if (meaningfulContent.length === 0) {
    return null;
  }

  // Must contain at least a word that could be a project name or tech reference
  // Check for at least one word of 2+ alphanumeric characters
  const hasIdentifiableContent = /[a-zA-Z0-9]{2,}/.test(section);
  if (!hasIdentifiableContent) {
    return null;
  }

  return section;
}
