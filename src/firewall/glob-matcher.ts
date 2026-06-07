/**
 * Glob Pattern Matcher Utility
 * 
 * Provides glob-style pattern matching for the Command Policy Engine.
 * Supports `*` (matches any sequence of zero or more characters) and
 * `?` (matches exactly one character). Patterns without wildcards
 * match only the exact string.
 * 
 * Requirements: 3.7
 */

/**
 * Match a string against a glob pattern.
 * 
 * Supported wildcards:
 * - `*` matches any sequence of zero or more characters
 * - `?` matches exactly one character
 * 
 * A pattern without wildcards performs an exact string comparison.
 * 
 * @param pattern - The glob pattern to match against
 * @param str - The string to test
 * @returns true if the string matches the pattern
 */
export function globMatch(pattern: string, str: string): boolean {
  // Fast path: no wildcards means exact match
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern === str;
  }

  // Dynamic programming approach for glob matching
  // dp[i][j] = true if pattern[0..i-1] matches str[0..j-1]
  const pLen = pattern.length;
  const sLen = str.length;

  // Use two rows for space efficiency
  let prev = new Array<boolean>(sLen + 1).fill(false);
  let curr = new Array<boolean>(sLen + 1).fill(false);

  // Empty pattern matches empty string
  prev[0] = true;

  // Handle leading '*' characters that can match empty string
  for (let i = 1; i <= pLen; i++) {
    curr[0] = pattern[i - 1] === '*' ? prev[0] : false;

    for (let j = 1; j <= sLen; j++) {
      const pChar = pattern[i - 1];

      if (pChar === '*') {
        // '*' matches zero chars (prev[j]) or one-or-more chars (curr[j-1])
        curr[j] = prev[j] || curr[j - 1];
      } else if (pChar === '?') {
        // '?' matches exactly one character
        curr[j] = prev[j - 1];
      } else {
        // Literal character must match exactly
        curr[j] = pChar === str[j - 1] && prev[j - 1];
      }
    }

    // Swap rows
    [prev, curr] = [curr, prev];
    curr.fill(false);
  }

  return prev[sLen];
}
