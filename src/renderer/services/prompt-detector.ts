/**
 * PromptDetector — regex-based pattern detection for confirmation prompts.
 *
 * Analyzes finalized agent response text and identifies confirmation-type prompts,
 * producing a structured DetectionResult for the ActionButtonRenderer.
 *
 * Detection strategy:
 * 1. Explicit keyword requests: "type 'confirm'", "reply with yes", "enter 'proceed'"
 * 2. Binary approval questions: sentences ending with "?" containing approval keywords
 * 3. Destructive confirmations: destructive signal words paired with a confirmation request
 *
 * When multiple patterns match, the last (most recent) match is returned.
 */

import type { DetectionResult, IPromptDetector, PromptType } from '../types/action-buttons';

// ---------------------------------------------------------------------------
// Pattern Definitions
// ---------------------------------------------------------------------------

/**
 * Explicit keyword patterns — user is asked to type a specific word.
 * Captures the keyword in group 1.
 */
const EXPLICIT_KEYWORD_PATTERNS: RegExp[] = [
  /type\s+['"](\w+)['"]/gi,
  /reply\s+with\s+(\w+)/gi,
  /enter\s+['"](\w+)['"]/gi,
];

/**
 * Binary approval keywords that appear within a question sentence.
 */
const APPROVAL_KEYWORDS = /\b(proceed|continue|confirm|approve)\b/i;

/**
 * Numbered list pattern — e.g., "1. React\n2. Vue\n3. Angular"
 * Captures the number and option text on each line.
 */
const NUMBERED_LIST_ITEM = /^\s*(\d+)[.)]\s+(.+)$/;

/**
 * Bullet list pattern — e.g., "- PostgreSQL" or "* MongoDB"
 * Captures the option text on each line.
 */
const BULLET_LIST_ITEM = /^\s*[-*•]\s+(.+)$/;

/**
 * Question line pattern — a line that ends with '?' or contains a colon prompt.
 * Used to identify a question/prompt preceding a list of options.
 */
const QUESTION_LINE = /^.*(\?|:\s*)$/;

/**
 * Destructive signal words indicating an irreversible or dangerous operation.
 */
const DESTRUCTIVE_SIGNALS = /\b(irreversible|cannot be undone|destructive|permanently delete)\b/i;

/**
 * Yes/No confirmation patterns — follow-up confirmation phrasings that ask
 * the user to say/type "yes" or "no" to proceed.
 */
const YES_NO_CONFIRMATION_PATTERNS: RegExp[] = [
  /confirm\s+by\s+saying\s+['"]?(yes|no)['"]?\s*(or\s+['"]?(yes|no)['"]?)?/gi,
  /say\s+['"]?(yes)['"]?\s+to\s+(proceed|continue|confirm)/gi,
  /respond\s+(['"]?yes['"]?\s+or\s+['"]?no['"]?)/gi,
  /type\s+(yes|no)\s+(or\s+(yes|no)\s+)?to\s/gi,
  /\b(yes)\s*\/\s*(no)\b/gi,
];

// ---------------------------------------------------------------------------
// Internal Match Representation
// ---------------------------------------------------------------------------

interface InternalMatch {
  type: PromptType;
  responseText: string | null;
  offset: number;
  isDestructive: boolean;
}

// ---------------------------------------------------------------------------
// PromptDetector Implementation
// ---------------------------------------------------------------------------

export class PromptDetector implements IPromptDetector {
  /**
   * Analyze finalized response text for confirmation prompts.
   * Returns null if no prompt is detected.
   * When multiple patterns exist, returns the last (most recent) match.
   *
   * Wrapped in try-catch to ensure parse failures never propagate —
   * the agent response displays normally even if detection fails.
   */
  detect(text: string): DetectionResult | null {
    try {
      if (!text || text.trim().length === 0) {
        return null;
      }

      const matches: InternalMatch[] = [];

      // 1. Check for multi-choice pattern first (takes priority when present)
      const multiChoiceResult = this.findMultiChoiceMatch(text);
      if (multiChoiceResult) {
        return multiChoiceResult;
      }

      // 2. Find all explicit keyword matches
      this.findExplicitKeywordMatches(text, matches);

      // 2.5 Find all yes/no confirmation matches
      this.findYesNoConfirmationMatches(text, matches);

      // 3. Find all binary approval question matches
      this.findBinaryApprovalMatches(text, matches);

      // 4. Find all destructive confirmation matches
      this.findDestructiveMatches(text, matches);

      if (matches.length === 0) {
        return null;
      }

      // Return the last (most recent) match by offset
      matches.sort((a, b) => a.offset - b.offset);
      const lastMatch = matches[matches.length - 1];

      return this.buildResult(lastMatch);
    } catch (error) {
      console.warn('[PromptDetector] Detection failed:', error);
      return null;
    }
  }

  /**
   * Extract the response text keyword from a prompt pattern.
   * e.g., "type 'confirm' to proceed" → "confirm"
   *
   * Wrapped in try-catch to ensure extraction failures never propagate.
   */
  extractResponseText(text: string): string | null {
    try {
      if (!text || text.trim().length === 0) {
        return null;
      }

      for (const pattern of EXPLICIT_KEYWORD_PATTERNS) {
        // Reset lastIndex since we use 'g' flag
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        if (match && match[1]) {
          return match[1];
        }
      }

      return null;
    } catch (error) {
      console.warn('[PromptDetector] Detection failed:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Detect multi-choice patterns: a question/prompt line followed by a numbered
   * or bullet list with 2+ short items.
   */
  private findMultiChoiceMatch(text: string): DetectionResult | null {
    const lines = text.split('\n');

    // Scan for contiguous list blocks preceded by a question/prompt line
    let i = 0;
    let lastResult: DetectionResult | null = null;

    while (i < lines.length) {
      // Look for a question/prompt line
      const line = lines[i].trim();
      if (line.length > 0 && QUESTION_LINE.test(line)) {
        const questionLineIndex = i;
        const questionOffset = this.getLineOffset(lines, questionLineIndex);
        i++;

        // Skip blank lines between question and list
        while (i < lines.length && lines[i].trim() === '') {
          i++;
        }

        // Try to collect list items (numbered or bullet)
        const options: string[] = [];
        let listType: 'numbered' | 'bullet' | null = null;

        while (i < lines.length) {
          const itemLine = lines[i];
          const numberedMatch = itemLine.match(NUMBERED_LIST_ITEM);
          const bulletMatch = itemLine.match(BULLET_LIST_ITEM);

          if (numberedMatch && (listType === null || listType === 'numbered')) {
            listType = 'numbered';
            options.push(numberedMatch[2].trim());
            i++;
          } else if (bulletMatch && (listType === null || listType === 'bullet')) {
            listType = 'bullet';
            options.push(bulletMatch[1].trim());
            i++;
          } else if (itemLine.trim() === '') {
            // Allow blank lines within a list
            i++;
          } else {
            break;
          }
        }

        // Only treat as multi-choice if we found 2+ options
        if (options.length >= 2) {
          lastResult = {
            type: 'multi-choice',
            responseText: null,
            confirmLabel: 'Select',
            cancelLabel: 'Cancel',
            options,
            isDestructive: false,
            promptOffset: questionOffset,
          };
        }
      } else {
        i++;
      }
    }

    return lastResult;
  }

  /**
   * Calculate character offset of a line within the original text.
   */
  private getLineOffset(lines: string[], lineIndex: number): number {
    let offset = 0;
    for (let i = 0; i < lineIndex; i++) {
      offset += lines[i].length + 1; // +1 for the '\n'
    }
    return offset;
  }

  private findExplicitKeywordMatches(text: string, matches: InternalMatch[]): void {
    const hasDestructiveContext = DESTRUCTIVE_SIGNALS.test(text);

    for (const pattern of EXPLICIT_KEYWORD_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        matches.push({
          type: hasDestructiveContext ? 'destructive-confirmation' : 'explicit-keyword',
          responseText: match[1],
          offset: match.index,
          isDestructive: hasDestructiveContext,
        });
      }
    }
  }

  private findYesNoConfirmationMatches(text: string, matches: InternalMatch[]): void {
    const hasDestructiveContext = DESTRUCTIVE_SIGNALS.test(text);
    for (const pattern of YES_NO_CONFIRMATION_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        matches.push({
          type: hasDestructiveContext ? 'destructive-confirmation' : 'binary-approval',
          responseText: 'yes',
          offset: match.index,
          isDestructive: hasDestructiveContext,
        });
      }
    }
  }

  private findBinaryApprovalMatches(text: string, matches: InternalMatch[]): void {
    const hasDestructiveContext = DESTRUCTIVE_SIGNALS.test(text);

    // Find sentences ending with "?" or "." that contain approval keywords
    const sentencePattern = /[^.!?\n]*[.?]/g;
    let sentenceMatch: RegExpExecArray | null;

    // Confirmation-intent heuristic: for declarative sentences (ending with '.'),
    // requires a second-person pronoun, imperative verb, or request verb to qualify.
    // This prevents false positives on narrative sentences like "The process will continue running."
    const confirmationIntent = /\b(you|please|kindly|confirm|say|type|respond)\b/i;

    while ((sentenceMatch = sentencePattern.exec(text)) !== null) {
      const sentence = sentenceMatch[0];
      if (APPROVAL_KEYWORDS.test(sentence)) {
        // For sentences ending with '.', apply confirmation-intent heuristic
        const endsWithDot = sentence.trimEnd().endsWith('.');
        if (endsWithDot && !confirmationIntent.test(sentence)) {
          // Narrative sentence with incidental approval keyword — skip
          continue;
        }

        // Avoid double-counting: skip if this sentence also contains an explicit keyword match
        let hasExplicitMatch = false;
        for (const pattern of EXPLICIT_KEYWORD_PATTERNS) {
          pattern.lastIndex = 0;
          if (pattern.test(sentence)) {
            hasExplicitMatch = true;
            break;
          }
        }

        if (!hasExplicitMatch) {
          matches.push({
            type: hasDestructiveContext ? 'destructive-confirmation' : 'binary-approval',
            responseText: null,
            offset: sentenceMatch.index,
            isDestructive: hasDestructiveContext,
          });
        }
      }
    }
  }

  private findDestructiveMatches(text: string, matches: InternalMatch[]): void {
    // Destructive patterns are already folded into the explicit keyword and binary approval
    // detection above (via the hasDestructiveContext flag). This method handles the case where
    // destructive signal words appear with a general confirmation request that isn't captured
    // by the other two patterns — e.g., "This is irreversible. Please confirm."

    if (!DESTRUCTIVE_SIGNALS.test(text)) {
      return;
    }

    // Look for general confirmation phrases that aren't questions or explicit keywords
    const confirmPhrases = /\b(please confirm|confirm this|confirm to proceed|confirm the)\b/gi;
    let phraseMatch: RegExpExecArray | null;

    while ((phraseMatch = confirmPhrases.exec(text)) !== null) {
      // Check this offset hasn't already been captured by another match
      const offset = phraseMatch.index;
      const alreadyCaptured = matches.some(
        (m) => Math.abs(m.offset - offset) < phraseMatch![0].length,
      );

      if (!alreadyCaptured) {
        matches.push({
          type: 'destructive-confirmation',
          responseText: 'confirm',
          offset,
          isDestructive: true,
        });
      }
    }
  }

  private buildResult(match: InternalMatch): DetectionResult {
    let confirmLabel: string;
    let cancelLabel: string;

    if (match.responseText === 'yes') {
      confirmLabel = 'Yes';
      cancelLabel = 'No';
    } else {
      confirmLabel = match.responseText
        ? this.capitalize(match.responseText)
        : 'Confirm';
      cancelLabel = 'Cancel';
    }

    return {
      type: match.type,
      responseText: match.responseText,
      confirmLabel,
      cancelLabel,
      isDestructive: match.isDestructive,
      promptOffset: match.offset,
    };
  }

  private capitalize(text: string): string {
    if (text.length === 0) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
}
