/**
 * Renderer Hardening — Security Pipeline for Untrusted Content
 *
 * Provides a unified hardening pipeline for renderer adapters that:
 * 1. Sanitizes markup and links (dangerous tags, attributes, protocols)
 * 2. Isolates risky previews (sandbox iframes, blob isolation, text-only)
 * 3. Prohibits script/event-handler execution
 * 4. Routes file/web/attachment/spill actions through authorization ports
 * 5. Produces canary-safe labels and diagnostics (no secrets, paths, locators)
 *
 * Requirements: 9.9, 21.6, 24.2–24.8, 29.2, 37.9–37.11, 41.3, 41.11, 45.10
 */

export {
  sanitizeMarkup,
  sanitizeLinkUrl,
  containsMarkup,
  type MarkupSanitizeResult,
} from './content-sanitizer';

export {
  assessIsolation,
  getSandboxAttribute,
  getCspMetaContent,
} from './preview-isolator';

export {
  prohibitScripts,
  detectsScriptVectors,
  countVectorCategories,
  type ProhibitionResult,
} from './script-prohibitor';

export {
  DenyAllAuthorizationPort,
  AuthorityBackedAuthorizationPort,
  RendererActionRouter,
  type AuthorityDelegate,
} from './authorization-port';

export {
  makeCanarySafeLabel,
  makeCanarySafeDiagnostics,
  detectCanaries,
  assertCanarySafe,
} from './canary-labels';

export type {
  AuthorizedActionKind,
  AuthorizationDecision,
  AuthorizationDenialCode,
  AuthorizationRequest,
  AuthorizationResult,
  IsolationLevel,
  IsolationAssessment,
  SanitizationSeverity,
  SanitizationFinding,
  HardenedOutput,
  CanarySafeLabel,
  RendererAuthorizationPort,
} from './types';

// ─── Unified Hardening Pipeline ─────────────────────────────────

import { sanitizeMarkup, containsMarkup } from './content-sanitizer';
import { assessIsolation } from './preview-isolator';
import { prohibitScripts } from './script-prohibitor';
import { makeCanarySafeLabel, makeCanarySafeDiagnostics } from './canary-labels';
import type { HardenedOutput, SanitizationFinding } from './types';

/**
 * Options for the hardening pipeline.
 */
export interface HardeningOptions {
  /** Declared media type of the content. */
  mediaType?: string;
  /** A label to make canary-safe for display. */
  label?: string;
  /** Additional diagnostic fields to sanitize. */
  diagnostics?: Record<string, unknown>;
}

/**
 * Run the full renderer hardening pipeline on untrusted content.
 *
 * Steps:
 * 1. Markup sanitization (remove dangerous elements/attributes/links)
 * 2. Script/event-handler prohibition (neutralize execution vectors)
 * 3. Isolation assessment (determine sandbox/blob/text requirements)
 * 4. Canary-safe label and diagnostics generation
 *
 * @param input - Untrusted content string
 * @param options - Hardening options (media type, label, diagnostics)
 * @returns HardenedOutput with sanitized content and metadata
 */
export function hardenContent(
  input: string,
  options: HardeningOptions = {},
): HardenedOutput {
  const findings: SanitizationFinding[] = [];
  let content = input;
  let modified = false;

  // Step 1: Markup sanitization (if content contains HTML markup)
  if (containsMarkup(content)) {
    const markupResult = sanitizeMarkup(content);
    if (markupResult.modified) {
      content = markupResult.output;
      modified = true;
      findings.push(...markupResult.findings);
    }
  }

  // Step 2: Script/event-handler prohibition
  const prohibitionResult = prohibitScripts(content);
  if (prohibitionResult.modified) {
    content = prohibitionResult.output;
    modified = true;
    findings.push(...prohibitionResult.findings);
  }

  // Step 3: Isolation assessment
  const isolation = assessIsolation(options.mediaType, content);

  // Step 4: Canary-safe label
  const label = options.label ?? '';
  const safeLabel = makeCanarySafeLabel(label);

  // Step 5: Canary-safe diagnostics
  const diagnostics = options.diagnostics ?? {};
  const safeDiagnostics = makeCanarySafeDiagnostics(diagnostics);

  return {
    content,
    modified,
    isolation,
    findings,
    safeLabel: safeLabel.text,
    safeDiagnostics,
  };
}
