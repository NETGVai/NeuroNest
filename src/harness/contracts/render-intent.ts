/**
 * Render Intent V1 — Closed Discriminated Union
 *
 * A typed, tool-owned, pure description of how a Canonical_Tool_Value may be
 * presented by a user interface. Renderers dispatch on `intent.kind`;
 * tool names remain display metadata only.
 *
 * Unsupported or invalid intents use the safe generic renderer via the
 * `parseRenderIntent` boundary function which returns a typed fallback
 * rather than throwing.
 *
 * Requirements: 13.1, 34.1, 35.4–35.6
 */

import { z } from 'zod';
import { IdentifierSchema } from './primitives';

// ─── Individual Intent Schemas ──────────────────────────────────

export const GenericIntentV1Schema = z.object({
  kind: z.literal('generic'),
  label: z.string().optional(),
  truncated: z.boolean().optional(),
}).passthrough();

export const ReadIntentV1Schema = z.object({
  kind: z.literal('read'),
  filePath: z.string(),
  language: z.string().optional(),
  startLine: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
}).passthrough();

export const SearchIntentV1Schema = z.object({
  kind: z.literal('search'),
  query: z.string(),
  resultCount: z.number().int().nonnegative().optional(),
}).passthrough();

export const DiffIntentV1Schema = z.object({
  kind: z.literal('diff'),
  filePath: z.string(),
  hunks: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
}).passthrough();

export const TerminalIntentV1Schema = z.object({
  kind: z.literal('terminal'),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
}).passthrough();

export const WebIntentV1Schema = z.object({
  kind: z.literal('web'),
  url: z.string().url().optional(),
  title: z.string().optional(),
  citation: z.string().optional(),
}).passthrough();

export const ImageIntentV1Schema = z.object({
  kind: z.literal('image'),
  alt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  mediaType: z.string().optional(),
}).passthrough();

export const TableIntentV1Schema = z.object({
  kind: z.literal('table'),
  columns: z.number().int().positive().optional(),
  rows: z.number().int().nonnegative().optional(),
  caption: z.string().optional(),
}).passthrough();

export const TreeIntentV1Schema = z.object({
  kind: z.literal('tree'),
  rootLabel: z.string().optional(),
  depth: z.number().int().nonnegative().optional(),
  nodeCount: z.number().int().nonnegative().optional(),
}).passthrough();

export const ArtifactIntentV1Schema = z.object({
  kind: z.literal('artifact'),
  artifactId: IdentifierSchema,
  artifactType: z.string().optional(),
  title: z.string().optional(),
}).passthrough();

// ─── Closed Discriminated Union ─────────────────────────────────

/**
 * The canonical RenderIntentV1 schema. This is a CLOSED union: only the
 * defined kinds are valid for V1. Unknown kinds are handled by the
 * `parseRenderIntent` boundary function, not by making the union open.
 */
export const RenderIntentV1Schema = z.discriminatedUnion('kind', [
  GenericIntentV1Schema,
  ReadIntentV1Schema,
  SearchIntentV1Schema,
  DiffIntentV1Schema,
  TerminalIntentV1Schema,
  WebIntentV1Schema,
  ImageIntentV1Schema,
  TableIntentV1Schema,
  TreeIntentV1Schema,
  ArtifactIntentV1Schema,
]);

export type RenderIntentV1 = z.infer<typeof RenderIntentV1Schema>;
export type GenericIntentV1 = z.infer<typeof GenericIntentV1Schema>;
export type ReadIntentV1 = z.infer<typeof ReadIntentV1Schema>;
export type SearchIntentV1 = z.infer<typeof SearchIntentV1Schema>;
export type DiffIntentV1 = z.infer<typeof DiffIntentV1Schema>;
export type TerminalIntentV1 = z.infer<typeof TerminalIntentV1Schema>;
export type WebIntentV1 = z.infer<typeof WebIntentV1Schema>;
export type ImageIntentV1 = z.infer<typeof ImageIntentV1Schema>;
export type TableIntentV1 = z.infer<typeof TableIntentV1Schema>;
export type TreeIntentV1 = z.infer<typeof TreeIntentV1Schema>;
export type ArtifactIntentV1 = z.infer<typeof ArtifactIntentV1Schema>;

// ─── Boundary Parser ────────────────────────────────────────────

/**
 * Typed result for intent parsing. Incompatible discriminators return
 * a `fallback` outcome rather than throwing.
 */
export type RenderIntentParseResult =
  | { ok: true; intent: RenderIntentV1 }
  | { ok: false; fallback: GenericIntentV1; reason: string };

/**
 * Parse a render intent value at a boundary. If the discriminator `kind`
 * is not a member of the closed V1 union or validation fails, returns
 * a typed fallback outcome with the generic renderer instead of throwing.
 */
export function parseRenderIntent(raw: unknown): RenderIntentParseResult {
  const result = RenderIntentV1Schema.safeParse(raw);
  if (result.success) {
    return { ok: true, intent: result.data };
  }

  const fallback: GenericIntentV1 = {
    kind: 'generic',
    label: typeof raw === 'object' && raw !== null && 'kind' in raw
      ? `unsupported intent: ${String((raw as Record<string, unknown>)['kind'])}`
      : 'invalid intent',
    truncated: true,
  };

  return {
    ok: false,
    fallback,
    reason: result.error.message,
  };
}
