/**
 * User-documentation handoff contract and link/command verifier
 * (FUT-PKG-07-EXPERIENCE/T-007).
 *
 * NN-UI-015 requires user guides that cover installation, activation, projects,
 * agents, skills, chat, tools, modes, channels, security, costs, recovery,
 * worktrees, training, troubleshooting, CLI, and accessibility — and that
 * navigation, links, and commands are VERIFIED against the release. NN-OPS-009
 * requires the release handoff to include architecture, setup, development
 * commands, non-secret configuration schema, interfaces, operations, monitoring,
 * limitations, migrations, troubleshooting, accessibility, and rollback, and
 * says broken/obsolete references BLOCK readiness (a release blocker under
 * NN-VERIFY-005).
 *
 * This module reads the ACTUAL guide files on disk (no mocks) and verifies:
 *   1. every required workflow guide exists and is non-empty;
 *   2. every required NN-OPS-009 handoff section is present in the guide set;
 *   3. every intra-doc relative link resolves to an existing file (+ heading
 *      anchor when one is given) — a broken/obsolete reference is a CRITICAL
 *      finding;
 *   4. every documented development command is one the project actually exposes
 *      (an npm script or a known CLI binary) — a command that does not resolve
 *      is a broken reference.
 *
 * It is a pure verifier over the file set + a resolver: it never rewrites the
 * guides. A critical finding is a visible, blocking result (NN-OPS-009,
 * NN-VERIFY-005) — never silently passed.
 *
 * Design anchors: D-22 (verification), D-16 (operations). Requirements:
 * NN-UI-015, NN-OPS-009, NN-VERIFY-005.
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── Required coverage (NN-UI-015 workflows + NN-OPS-009 handoff) ───────────

/**
 * The workflows every user guide set MUST document (NN-UI-015). Each maps to a
 * guide file `docs/guides/<workflow>.md`. A missing/empty guide is a critical
 * finding so a required workflow can never ship undocumented.
 */
export const REQUIRED_GUIDE_WORKFLOWS = Object.freeze([
  'installation',
  'activation',
  'projects',
  'agents',
  'skills',
  'chat',
  'tools',
  'modes',
  'channels',
  'security',
  'costs',
  'recovery',
  'worktrees',
  'training',
  'troubleshooting',
  'cli',
  'accessibility',
] as const);

export type GuideWorkflow = (typeof REQUIRED_GUIDE_WORKFLOWS)[number];

/**
 * The handoff sections the guide set MUST cover (NN-OPS-009). These are matched
 * against `## ` headings across the guide set (case-insensitive) so a missing
 * handoff concern is a critical finding.
 */
export const REQUIRED_HANDOFF_SECTIONS = Object.freeze([
  'architecture',
  'setup',
  'development commands',
  'configuration',
  'interfaces',
  'operations',
  'monitoring',
  'limitations',
  'migrations',
  'troubleshooting',
  'accessibility',
  'rollback',
] as const);

// ─── Findings ────────────────────────────────────────────────────────────────

export interface DocumentationFinding {
  readonly code: string;
  readonly severity: 'critical' | 'advisory';
  readonly message: string;
  /** The guide file (relative to the docs root) the finding is about. */
  readonly file?: string;
}

/** True when any documentation finding is release-blocking. */
export function hasCriticalDocumentationFinding(findings: readonly DocumentationFinding[]): boolean {
  return findings.some((f) => f.severity === 'critical');
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

/** A markdown link target parsed from `[text](target)`. */
interface ParsedLink {
  readonly raw: string;
  /** The path portion before an optional `#anchor`. */
  readonly targetPath: string;
  /** The `#anchor` fragment without the hash, or null. */
  readonly anchor: string | null;
}

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const HEADING_RE = /^#{1,6}\s+(.*)$/gm;
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]*`/g;
/** A documented command inside an inline `code` span that starts a run command. */
const COMMAND_RE = /`(npm run [a-z0-9:_-]+|npx [a-z0-9@._/-]+|neuronest [a-z0-9:_-]+)`/g;

/** Convert a heading's text into a GitHub-style anchor slug. */
export function headingToAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function stripCode(markdown: string): string {
  return markdown.replace(FENCE_RE, '').replace(INLINE_CODE_RE, '');
}

/** Parse the relative markdown links out of a doc body (ignores code spans). */
export function parseLinks(markdown: string): ParsedLink[] {
  const body = stripCode(markdown);
  const links: ParsedLink[] = [];
  for (const m of body.matchAll(LINK_RE)) {
    const raw = m[1]!.trim();
    // Skip absolute URLs and mailto — only intra-doc relative links are verified.
    if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith('mailto:')) continue;
    const hashIndex = raw.indexOf('#');
    if (hashIndex === 0) {
      links.push({ raw, targetPath: '', anchor: raw.slice(1) });
    } else if (hashIndex > 0) {
      links.push({ raw, targetPath: raw.slice(0, hashIndex), anchor: raw.slice(hashIndex + 1) });
    } else {
      links.push({ raw, targetPath: raw, anchor: null });
    }
  }
  return links;
}

/** Collect the set of heading anchors defined in a doc body. */
export function collectAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const m of markdown.matchAll(HEADING_RE)) {
    anchors.add(headingToAnchor(m[1]!));
  }
  return anchors;
}

/** Collect the documented run-commands referenced in a doc body. */
export function collectCommands(markdown: string): string[] {
  const commands: string[] = [];
  for (const m of markdown.matchAll(COMMAND_RE)) commands.push(m[1]!.trim());
  return commands;
}

// ─── Verification ────────────────────────────────────────────────────────────

export interface DocumentationVerifyOptions {
  /** Absolute path to the docs guides directory (e.g. <repo>/docs/guides). */
  readonly guidesDir: string;
  /**
   * The set of run-commands the release actually exposes (npm scripts + known
   * CLI verbs). A documented command not in this set is a broken reference.
   */
  readonly knownCommands: ReadonlySet<string>;
}

/**
 * Verify the on-disk guide set against NN-UI-015 / NN-OPS-009. Reads every
 * required guide file, checks coverage, resolves every intra-doc link (file +
 * heading anchor), and validates every documented command against the release's
 * real command set. Returns every finding (empty = the docs pass the floor). A
 * broken link, an unresolved command, a missing workflow guide, or a missing
 * handoff section is a CRITICAL finding that blocks readiness (NN-OPS-009,
 * NN-VERIFY-005).
 */
export function verifyDocumentationHandoff(options: DocumentationVerifyOptions): DocumentationFinding[] {
  const findings: DocumentationFinding[] = [];
  const { guidesDir, knownCommands } = options;

  // Load every guide file that exists in the guides dir.
  const bodies = new Map<string, string>();
  const anchorsByFile = new Map<string, Set<string>>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(guidesDir).filter((f) => f.endsWith('.md'));
  } catch {
    findings.push({
      code: 'guides-dir-missing',
      severity: 'critical',
      message: `guides directory ${guidesDir} does not exist`,
    });
    return findings;
  }
  for (const file of entries) {
    const body = fs.readFileSync(path.join(guidesDir, file), 'utf8');
    bodies.set(file, body);
    anchorsByFile.set(file, collectAnchors(body));
  }

  // 1. Required workflow guides exist and are non-empty.
  for (const workflow of REQUIRED_GUIDE_WORKFLOWS) {
    const file = `${workflow}.md`;
    const body = bodies.get(file);
    if (body === undefined) {
      findings.push({
        code: 'missing-workflow-guide',
        severity: 'critical',
        message: `required workflow guide ${file} is missing`,
        file,
      });
    } else if (body.trim().length === 0) {
      findings.push({
        code: 'empty-workflow-guide',
        severity: 'critical',
        message: `required workflow guide ${file} is empty`,
        file,
      });
    }
  }

  // 2. Required handoff sections present somewhere in the guide set.
  const allHeadings = new Set<string>();
  for (const body of bodies.values()) {
    for (const m of body.matchAll(HEADING_RE)) allHeadings.add(m[1]!.trim().toLowerCase());
  }
  for (const section of REQUIRED_HANDOFF_SECTIONS) {
    const covered = [...allHeadings].some((h) => h.includes(section));
    if (!covered) {
      findings.push({
        code: 'missing-handoff-section',
        severity: 'critical',
        message: `required handoff section "${section}" (NN-OPS-009) is not covered by any guide heading`,
      });
    }
  }

  // 3. Every intra-doc link resolves (file + anchor), and 4. commands resolve.
  for (const [file, body] of bodies) {
    for (const link of parseLinks(body)) {
      // Resolve the target file relative to the current guide.
      let targetFile = file;
      if (link.targetPath !== '') {
        const resolved = path.normalize(path.join(guidesDir, path.dirname(file), link.targetPath));
        if (!fs.existsSync(resolved)) {
          findings.push({
            code: 'broken-link',
            severity: 'critical',
            message: `${file} links to missing target "${link.raw}"`,
            file,
          });
          continue;
        }
        targetFile = path.relative(guidesDir, resolved);
      }
      // Verify the heading anchor exists in the target file.
      if (link.anchor !== null && link.anchor.length > 0) {
        const targetAnchors = anchorsByFile.get(targetFile);
        if (!targetAnchors || !targetAnchors.has(link.anchor)) {
          findings.push({
            code: 'broken-anchor',
            severity: 'critical',
            message: `${file} links to missing heading anchor "#${link.anchor}" in ${targetFile}`,
            file,
          });
        }
      }
    }

    for (const command of collectCommands(body)) {
      if (!knownCommands.has(command)) {
        findings.push({
          code: 'unknown-command-reference',
          severity: 'critical',
          message: `${file} documents command "${command}" that the release does not expose`,
          file,
        });
      }
    }
  }

  return findings;
}

/**
 * Build the set of run-commands the release actually exposes from a parsed
 * package.json `scripts` map plus the known CLI verbs. A documented command must
 * be in this set to resolve (NN-UI-015 "commands verified against the release").
 */
export function buildKnownCommands(
  scripts: Readonly<Record<string, string>>,
  cliVerbs: readonly string[] = [],
): Set<string> {
  const known = new Set<string>();
  for (const name of Object.keys(scripts)) known.add(`npm run ${name}`);
  for (const verb of cliVerbs) known.add(`neuronest ${verb}`);
  return known;
}
