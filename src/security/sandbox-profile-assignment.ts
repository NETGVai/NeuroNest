/**
 * Sandbox Profile Assignment — maps execution modes to kernel sandbox profiles
 * and merges never-touch rules and settings deny globs into kernel deny rules.
 *
 * Profile assignment by execution mode (Req 9.5, 9.6):
 *   - Flash/Standard/Pro → workspace
 *   - Ultra workers → strict (worktree as write root)
 *   - Loop Engine verification → read-only
 *   - MCP stdio servers → workspace (phase one)
 *
 * Never-touch rules and custom deny globs from .neuronest/settings.json are
 * mirrored into kernel-level deny rules (Req 9.8).
 *
 * ToolContext carries the effective SandboxProfile so process-spawning tools
 * do not derive it independently (Req 9.9).
 *
 * Requirements: 9.5, 9.6, 9.8, 9.9
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProfile, type SandboxProfile, type SandboxProfileName } from './kernel-sandbox.js';
import type { SandboxProfileAssignment } from '../shared/types.js';

// ─── Execution Mode Types ───────────────────────────────────────

/**
 * Execution modes that determine which sandbox profile is assigned.
 */
export type SandboxExecutionMode =
  | 'flash'
  | 'standard'
  | 'pro'
  | 'ultra'
  | 'loop-verify'
  | 'mcp';

// ─── Profile Assignment ─────────────────────────────────────────

/**
 * Map an execution mode to the appropriate sandbox profile name (Req 9.5).
 *
 * - Flash/Standard/Pro → workspace
 * - Ultra workers → strict (worktree as write root)
 * - Loop Engine verification → read-only
 * - MCP stdio servers → workspace (phase one)
 */
export function assignProfileForMode(mode: SandboxExecutionMode): SandboxProfileName {
  switch (mode) {
    case 'flash':
    case 'standard':
    case 'pro':
      return 'workspace';
    case 'ultra':
      return 'strict';
    case 'loop-verify':
      return 'read-only';
    case 'mcp':
      return 'workspace';
  }
}

/**
 * Create a SandboxProfileAssignment for ToolContext based on execution mode (Req 9.9).
 *
 * For 'ultra' mode, a worktreeRoot MUST be provided — this is the isolated
 * worktree directory that serves as the writable root (Req 9.6).
 */
export function createProfileAssignment(
  mode: SandboxExecutionMode,
  opts?: { worktreeRoot?: string },
): SandboxProfileAssignment {
  const profileName = assignProfileForMode(mode);

  const assignment: SandboxProfileAssignment = { profileName };

  if (profileName === 'strict' && opts?.worktreeRoot) {
    assignment.worktreeRoot = opts.worktreeRoot;
  }

  return assignment;
}

// ─── Never-Touch and Settings Deny Glob Mirroring ───────────────

/**
 * Options for loading deny globs from project configuration.
 */
export interface DenyGlobLoadOptions {
  /** Absolute path to the project/workspace root */
  projectDir: string;
  /** Path to NEURONEST.md (defaults to projectDir/NEURONEST.md) */
  neuronestMdPath?: string;
  /** Path to GOAL.md (defaults to projectDir/GOAL.md) */
  goalMdPath?: string;
}

/**
 * Extract never-touch path patterns from a markdown file.
 *
 * Searches for a "## Never-touch" (or similar heading) section and collects
 * list items as glob patterns. These become absolute deny rules in the kernel
 * sandbox that override all allow rules (Req 9.8).
 */
export function extractNeverTouchGlobs(content: string): string[] {
  const lines = content.split('\n');
  const globs: string[] = [];
  let inNeverTouchSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section header: ## Never-touch, ## Never-Touch, ## Never Touch, etc.
    if (/^#{1,3}\s+never[- ]?touch/i.test(trimmed)) {
      inNeverTouchSection = true;
      continue;
    }

    // Exit section on next heading of same or higher level
    if (inNeverTouchSection && /^#{1,3}\s+/.test(trimmed) && !/^#{1,3}\s+never[- ]?touch/i.test(trimmed)) {
      break;
    }

    // Collect list items within the Never-touch section
    if (inNeverTouchSection) {
      const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
      if (listMatch && listMatch[1]) {
        const entry = listMatch[1].trim();
        // Remove backticks if present (e.g., `node_modules/**`)
        const cleaned = entry.replace(/^`|`$/g, '');
        if (cleaned) {
          globs.push(cleaned);
        }
      }
    }
  }

  return globs;
}

/**
 * Load custom deny globs from .neuronest/settings.json.
 *
 * Reads the `permissions.deny` array and extracts path-like glob patterns.
 * These deny patterns are of the form "Write(glob)" — we extract just the
 * glob portion for kernel-level deny rules.
 *
 * Also reads a dedicated `sandbox.denyGlobs` array if present.
 */
export function loadSettingsDenyGlobs(projectDir: string): string[] {
  const globs: string[] = [];
  const settingsPath = join(projectDir, '.neuronest', 'settings.json');

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    const json = JSON.parse(content);

    // Extract from permissions.deny patterns (format: "Write(glob)")
    const permissions = json?.permissions;
    if (permissions && Array.isArray(permissions.deny)) {
      for (const pattern of permissions.deny) {
        if (typeof pattern === 'string') {
          // Extract glob from "Write(glob)" or "Read(glob)" format
          const match = pattern.match(/^\w+\((.+)\)$/);
          if (match && match[1]) {
            globs.push(match[1]);
          }
        }
      }
    }

    // Extract from sandbox.denyGlobs (dedicated kernel deny config)
    const sandbox = json?.sandbox;
    if (sandbox && Array.isArray(sandbox.denyGlobs)) {
      for (const glob of sandbox.denyGlobs) {
        if (typeof glob === 'string' && glob.trim()) {
          globs.push(glob.trim());
        }
      }
    }
  } catch {
    // File doesn't exist or is invalid — no additional deny globs
  }

  return globs;
}

/**
 * Load all deny globs that should be mirrored into kernel-level deny rules (Req 9.8).
 *
 * Sources:
 *   1. Never-touch rules from NEURONEST.md
 *   2. Never-touch rules from GOAL.md (if present)
 *   3. Custom deny globs from .neuronest/settings.json
 *
 * These are absolute deny rules that override all allow rules in the kernel sandbox.
 */
export function loadKernelDenyGlobs(opts: DenyGlobLoadOptions): string[] {
  const { projectDir } = opts;
  const globs: string[] = [];

  // 1. Never-touch from NEURONEST.md
  const neuronestMdPath = opts.neuronestMdPath || join(projectDir, 'NEURONEST.md');
  try {
    const content = readFileSync(neuronestMdPath, 'utf-8');
    globs.push(...extractNeverTouchGlobs(content));
  } catch {
    // File doesn't exist — no never-touch rules from this source
  }

  // 2. Never-touch from GOAL.md
  const goalMdPath = opts.goalMdPath || join(projectDir, 'GOAL.md');
  try {
    const content = readFileSync(goalMdPath, 'utf-8');
    globs.push(...extractNeverTouchGlobs(content));
  } catch {
    // File doesn't exist — no never-touch rules from this source
  }

  // 3. Custom deny globs from .neuronest/settings.json
  globs.push(...loadSettingsDenyGlobs(projectDir));

  // Deduplicate
  return [...new Set(globs)];
}

/**
 * Build a complete SandboxProfile for a given execution mode, merging in
 * never-touch rules and settings deny globs as kernel-level deny rules (Req 9.8).
 *
 * This is the primary integration point for task 2.10: it combines:
 *   - Profile assignment by execution mode (Req 9.5, 9.6)
 *   - Never-touch and settings deny glob mirroring (Req 9.8)
 *   - ToolContext-compatible profile data (Req 9.9)
 */
export function buildProfileForExecution(
  mode: SandboxExecutionMode,
  opts: {
    projectDir: string;
    worktreeRoot?: string;
  },
): SandboxProfile {
  const { projectDir, worktreeRoot } = opts;
  const profileName = assignProfileForMode(mode);

  // Load kernel-level deny globs from never-touch rules and settings
  const kernelDenyGlobs = loadKernelDenyGlobs({ projectDir });

  // Build the full profile with merged deny globs
  const profileOpts: {
    projectDir?: string;
    worktreeRoot?: string;
    additionalDenyGlobs?: string[];
  } = {
    projectDir,
    additionalDenyGlobs: kernelDenyGlobs,
  };

  if (profileName === 'strict') {
    profileOpts.worktreeRoot = worktreeRoot || projectDir;
  }

  return buildProfile(profileName, profileOpts);
}

/**
 * Resolve the effective SandboxProfile from a ToolContext's sandboxProfile assignment.
 *
 * Process-spawning tools (bash, shell) should call this to get the full profile
 * rather than deriving it independently (Req 9.9).
 *
 * If no sandboxProfile is set on the context, defaults to 'workspace' profile.
 */
export function resolveProfileFromContext(
  assignment: SandboxProfileAssignment | undefined,
  projectDir: string,
): SandboxProfile {
  if (!assignment) {
    // Default to workspace when no explicit assignment
    const kernelDenyGlobs = loadKernelDenyGlobs({ projectDir });
    return buildProfile('workspace', { projectDir, additionalDenyGlobs: kernelDenyGlobs });
  }

  const kernelDenyGlobs = loadKernelDenyGlobs({ projectDir });

  const profileOpts: {
    projectDir?: string;
    worktreeRoot?: string;
    additionalDenyGlobs?: string[];
  } = {
    projectDir,
    additionalDenyGlobs: kernelDenyGlobs,
  };

  if (assignment.worktreeRoot) {
    profileOpts.worktreeRoot = assignment.worktreeRoot;
  }

  return buildProfile(assignment.profileName, profileOpts);
}
