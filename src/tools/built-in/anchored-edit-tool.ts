/**
 * Anchored Edit Tool — Content-anchored file editing using hashline native module.
 *
 * Uses content-addressed line hashing (xxhash via native hashline module) to locate
 * the correct edit position even when files have been modified by other operations
 * in the same session. Falls back to text-based search when native module unavailable.
 *
 * Registered alongside existing search_replace/file-edit tool with riskLevel: 'write'.
 *
 * Requirements: 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ExecutableToolDefinition } from '../tool-system.js';
import { safeExecute, type FieldSchema } from './input-validator.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AnchoredEditInput {
  path: string;
  contextBefore: string;
  contextAfter: string;
  oldContent: string;
  newContent: string;
}

export type AnchoredEditStatus = 'exact' | 'shifted' | 'lost';

export interface AnchoredEditOutput {
  status: AnchoredEditStatus;
  offset: number;
  shiftedBy?: number;
  path: string;
}

// ─── Native Hashline Interface ──────────────────────────────────

interface HashlineModule {
  __notSupported?: boolean;
  loadError?: string;
  computeLineHashes(source: Buffer): Uint32Array;
  anchorLookup(hashes: Uint32Array, target: Uint32Array): { offset: number; confidence: number };
}

// ─── Module-level hashline binding ──────────────────────────────

let hashlineModule: HashlineModule | null = null;
let hashlineLoadAttempted = false;

/**
 * Attempts to load the native hashline module.
 * Returns null if the module is unavailable or unsupported.
 */
function getHashlineModule(): HashlineModule | null {
  if (hashlineLoadAttempted) {
    return hashlineModule;
  }
  hashlineLoadAttempted = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../../native/hashline/index.js') as HashlineModule;
    if (mod.__notSupported) {
      hashlineModule = null;
    } else {
      hashlineModule = mod;
    }
  } catch {
    hashlineModule = null;
  }

  return hashlineModule;
}

// ─── Text-based fallback search ─────────────────────────────────

/**
 * Fallback: locate the edit region using plain text indexOf matching.
 * Searches for the combined contextBefore + oldContent + contextAfter string
 * within the file content.
 *
 * Returns the character offset of oldContent within the file, or -1 if not found.
 */
function textFallbackSearch(
  fileContent: string,
  contextBefore: string,
  oldContent: string,
  contextAfter: string,
): { offset: number; charStart: number; charEnd: number } | null {
  // Build the combined search string
  const searchString = contextBefore + oldContent + contextAfter;

  const foundIndex = fileContent.indexOf(searchString);
  if (foundIndex === -1) {
    return null;
  }

  // The oldContent starts after contextBefore within the found match
  const charStart = foundIndex + contextBefore.length;
  const charEnd = charStart + oldContent.length;

  return { offset: foundIndex, charStart, charEnd };
}

// ─── Native anchor-based search ─────────────────────────────────

/**
 * Use hashline native module to locate the edit region via content-addressed
 * line hashes and sliding-window anchor lookup.
 *
 * Returns the line offset and confidence, or null if not found with sufficient confidence.
 */
function nativeAnchorSearch(
  hashline: HashlineModule,
  fileContent: string,
  contextBefore: string,
  oldContent: string,
  contextAfter: string,
): { lineOffset: number; confidence: number; status: AnchoredEditStatus } | null {
  // Compute hashes for the full file
  const fileBuffer = Buffer.from(fileContent, 'utf-8');
  const fileHashes = hashline.computeLineHashes(fileBuffer);

  // Build the target region: contextBefore + oldContent + contextAfter
  const targetRegion = contextBefore + oldContent + contextAfter;
  const targetBuffer = Buffer.from(targetRegion, 'utf-8');
  const targetHashes = hashline.computeLineHashes(targetBuffer);

  if (targetHashes.length === 0) {
    return null;
  }

  // Anchor lookup: find best position of target within file
  const result = hashline.anchorLookup(fileHashes, targetHashes);

  // Confidence threshold: > 0.5 required (per design spec)
  if (result.offset === -1 || result.confidence <= 0.5) {
    return null;
  }

  // Determine status based on confidence
  // confidence === 1.0 means exact match; < 1.0 means shifted/relocated
  const status: AnchoredEditStatus = result.confidence >= 1.0 ? 'exact' : 'shifted';

  return {
    lineOffset: result.offset,
    confidence: result.confidence,
    status,
  };
}

/**
 * Given a line offset (from anchor search), extract the actual character positions
 * within the file content for the oldContent replacement.
 */
function resolveLineOffsetToCharRange(
  fileContent: string,
  lineOffset: number,
  contextBefore: string,
  oldContent: string,
  _contextAfter: string,
): { charStart: number; charEnd: number } | null {
  const lines = fileContent.split('\n');
  const contextBeforeLines = contextBefore ? contextBefore.split('\n') : [];
  const oldContentLines = oldContent.split('\n');

  // The oldContent starts after contextBefore lines
  const oldStartLine = lineOffset + contextBeforeLines.length;

  // Safety check: ensure we don't go out of bounds
  if (oldStartLine >= lines.length) {
    return null;
  }

  // Calculate character offset of the start line
  let charStart = 0;
  for (let i = 0; i < oldStartLine; i++) {
    charStart += (lines[i]?.length ?? 0) + 1; // +1 for newline
  }

  // If contextBefore doesn't end with newline, we need to handle partial line
  // But for line-based hashing, we work at line boundaries
  // The charEnd is at the end of oldContent lines
  const oldEndLine = oldStartLine + oldContentLines.length;
  let charEnd = charStart;
  for (let i = oldStartLine; i < Math.min(oldEndLine, lines.length); i++) {
    charEnd += (lines[i]?.length ?? 0) + 1;
  }

  // Trim trailing newline if old content doesn't end with one
  if (!oldContent.endsWith('\n') && charEnd > 0) {
    charEnd -= 1;
  }

  return { charStart, charEnd };
}

// ─── Input Schema ───────────────────────────────────────────────

const anchoredEditSchema: FieldSchema[] = [
  { name: 'path', type: 'string', required: true },
  { name: 'contextBefore', type: 'string', required: true },
  { name: 'contextAfter', type: 'string', required: true },
  { name: 'oldContent', type: 'string', required: true },
  { name: 'newContent', type: 'string', required: true },
];

// ─── Execute Function ───────────────────────────────────────────

/**
 * Creates the anchored_edit tool execute function.
 *
 * Execution logic:
 * 1. Read the file at `path`
 * 2. Try native hashline anchor lookup (if available)
 * 3. If native unavailable or lookup fails, fall back to text-based search
 * 4. Apply the replacement at the found position
 * 5. Write the modified file
 * 6. Return success/failure with status and offset
 */
export function createAnchoredEditExecute(): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<AnchoredEditInput>(anchoredEditSchema, async (input, context) => {
    const { path: filePath, contextBefore, contextAfter, oldContent, newContent } = input;

    // Validate project directory
    if (!context.projectDir) {
      return { success: false, output: null, error: 'No project directory set in context' };
    }

    const projectDir = path.resolve(context.projectDir);

    // Resolve file path
    const resolvedPath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(projectDir, filePath);

    // Security: prevent path traversal outside project directory
    if (!resolvedPath.startsWith(projectDir + path.sep) && resolvedPath !== projectDir) {
      return {
        success: false,
        output: null,
        error: 'Access denied: path is outside project directory',
      };
    }

    // Read the file
    let fileContent: string;
    try {
      fileContent = await fs.readFile(resolvedPath, 'utf-8');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return { success: false, output: null, error: `File not found: ${filePath}` };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `Failed to read file: ${message}` };
    }

    // Attempt native hashline anchor lookup first (Req 12.4)
    const hashline = getHashlineModule();
    let editResult: { charStart: number; charEnd: number; status: AnchoredEditStatus; offset: number; shiftedBy?: number } | null = null;

    if (hashline) {
      const anchorResult = nativeAnchorSearch(hashline, fileContent, contextBefore, oldContent, contextAfter);

      if (anchorResult) {
        // Resolve line offset to character range
        const charRange = resolveLineOffsetToCharRange(
          fileContent,
          anchorResult.lineOffset,
          contextBefore,
          oldContent,
          contextAfter,
        );

        if (charRange) {
          // Calculate expected line offset for shift detection
          const expectedRegion = contextBefore + oldContent + contextAfter;
          const expectedIndex = fileContent.indexOf(expectedRegion);
          let shiftedBy: number | undefined;

          if (expectedIndex !== -1 && anchorResult.status === 'shifted') {
            // Count lines to expected position vs actual position
            const expectedLine = fileContent.substring(0, expectedIndex).split('\n').length - 1;
            shiftedBy = anchorResult.lineOffset - expectedLine;
          } else if (anchorResult.status === 'shifted') {
            shiftedBy = anchorResult.lineOffset;
          }

          editResult = {
            charStart: charRange.charStart,
            charEnd: charRange.charEnd,
            status: anchorResult.status,
            offset: anchorResult.lineOffset,
            ...(shiftedBy !== undefined ? { shiftedBy } : {}),
          };
        }
      }
    }

    // Fallback to text-based search if native unavailable or anchor not found (Req 12.5)
    if (!editResult) {
      const textResult = textFallbackSearch(fileContent, contextBefore, oldContent, contextAfter);

      if (!textResult) {
        // Lost anchor — fail and instruct reread (Req 12.6)
        return {
          success: false,
          output: {
            status: 'lost' as AnchoredEditStatus,
            offset: -1,
            path: filePath,
            message: 'Anchor lost: could not locate the edit region. Re-read the file and retry with updated context.',
          },
          error: 'Anchor lost: could not locate the edit region in the file. The file may have been modified. Re-read the file to obtain current context.',
        };
      }

      editResult = {
        charStart: textResult.charStart,
        charEnd: textResult.charEnd,
        status: 'exact',
        offset: fileContent.substring(0, textResult.charStart).split('\n').length - 1,
      };
    }

    // Apply the replacement (Req 12.7: acquire edit lock semantics handled by ToolSystem)
    const modifiedContent =
      fileContent.substring(0, editResult.charStart) +
      newContent +
      fileContent.substring(editResult.charEnd);

    // Write the modified file
    try {
      await fs.writeFile(resolvedPath, modifiedContent, 'utf-8');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: `Failed to write file: ${message}` };
    }

    // Return success with applied offset (Req 12.5, 12.6)
    const output: AnchoredEditOutput = {
      status: editResult.status,
      offset: editResult.offset,
      path: filePath,
    };

    if (editResult.shiftedBy !== undefined) {
      output.shiftedBy = editResult.shiftedBy;
    }

    return { success: true, output };
  });
}

// ─── Tool Definition ────────────────────────────────────────────

export const AnchoredEditTool: Omit<ExecutableToolDefinition, 'execute'> = {
  id: 'anchored_edit',
  name: 'AnchoredEditTool',
  description:
    'Apply a content-anchored edit to a file using hashline fingerprints. Locates the edit region via content hashes even when the file has shifted due to concurrent edits. Falls back to text search if native module is unavailable.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path to edit (relative to project root or absolute)',
      },
      contextBefore: {
        type: 'string',
        description: 'Lines immediately before the edit region (used for anchoring)',
      },
      contextAfter: {
        type: 'string',
        description: 'Lines immediately after the edit region (used for anchoring)',
      },
      oldContent: {
        type: 'string',
        description: 'The content to replace (between context lines)',
      },
      newContent: {
        type: 'string',
        description: 'The replacement content',
      },
    },
    required: ['path', 'contextBefore', 'contextAfter', 'oldContent', 'newContent'],
  },
  riskLevel: 'write',
};

// ─── Registration Function ──────────────────────────────────────

/**
 * Registers the anchored_edit tool with the ToolSystem.
 *
 * The tool uses content-addressed line hashing to locate edit positions
 * even when files have been modified by other operations in the same session.
 * Falls back to text-based search when the native hashline module is unavailable.
 *
 * @param toolSystem - The ToolSystem instance to register the tool with
 */
export function registerAnchoredEditTool(
  toolSystem: { register(tool: ExecutableToolDefinition): void },
): void {
  const execute = createAnchoredEditExecute();
  toolSystem.register({ ...AnchoredEditTool, execute } as ExecutableToolDefinition);
}
