/**
 * HTML Sanitizer
 *
 * Provides functions to strip HTML tags from strings, preventing
 * XSS via version strings or other network-sourced values that
 * get injected into the renderer.
 *
 * @module src/main/security/html-sanitizer
 */

/**
 * Strips all HTML tags from a string, returning only text content.
 * This is used to sanitize version strings and other values from
 * network sources before they are injected into the renderer.
 *
 * The function removes anything matching `<...>` patterns, including
 * self-closing tags, closing tags, and attribute-bearing tags.
 *
 * @param input - The string to sanitize
 * @returns The input with all HTML tags removed
 *
 * @example
 * ```ts
 * stripHtmlTags('1.2.3') // → '1.2.3'
 * stripHtmlTags('<b>bold</b>') // → 'bold'
 * stripHtmlTags('<img src=x onerror=alert(1)>') // → ''
 * ```
 */
export function stripHtmlTags(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  // Remove all HTML/XML tags (opening, closing, self-closing, with attributes)
  // The pattern matches < followed by a letter or / then any chars except > then >
  return input.replace(/<[a-zA-Z/][^>]*>/g, '');
}

/**
 * Sanitizes a version string for safe renderer injection.
 * Strips HTML tags and restricts the character set to semver-safe characters.
 * Only allows digits, dots, hyphens, plus signs, and letters
 * (which covers standard semver including pre-release identifiers like "beta").
 *
 * @param version - The version string to sanitize
 * @returns A sanitized version string safe for injection
 *
 * @example
 * ```ts
 * sanitizeVersionString('1.2.3') // → '1.2.3'
 * sanitizeVersionString('1.2.3-beta.1') // → '1.2.3-beta.1'
 * sanitizeVersionString('<script>1.0</script>') // → '1.0'
 * ```
 */
export function sanitizeVersionString(version: string): string {
  if (typeof version !== 'string') {
    return '';
  }
  // First strip any HTML tags
  const stripped = stripHtmlTags(version);
  // Then restrict to semver-safe characters only
  return stripped.replace(/[^0-9a-zA-Z.\-+]/g, '');
}
