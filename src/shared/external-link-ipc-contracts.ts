/**
 * Fixed external-link IPC contracts (task 10.6).
 *
 * The renderer never crosses raw HTTP requests, `window.open` calls, or
 * `target="_blank"` navigation to the main process. Every rendered anchor
 * routes through this fixed channel. The main-process handler reparses the
 * URL, applies an allowlist (see `shell-open-external-handler.ts`), and only
 * then calls `shell.openExternal`.
 *
 * BrowserWindow navigation and new-window creation remain denied by
 * `window-hardener.ts`. This contract is the *sole* authorized escape route
 * for external navigation.
 *
 * Requirements: 10.8, 14.4, 14.5, 15.1, 15.2
 */

import { z } from 'zod';

/**
 * The fixed channel name used for the external-link IPC operation.
 *
 * Versioned so future schema changes can coexist during rollout without
 * breaking the currently-running renderer.
 */
export const SHELL_OPEN_EXTERNAL_CHANNEL = 'shell:open-external-v1' as const;
export type ShellOpenExternalChannel = typeof SHELL_OPEN_EXTERNAL_CHANNEL;

/**
 * Renderer → main request payload. The renderer supplies only the raw href
 * string it parsed out of a canonical Markdown link and an optional
 * correlation identifier for observability. The renderer MUST NOT decorate
 * the request with additional fields (`strictObject` rejects them).
 */
export const ExternalLinkRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  /**
   * URL to open in the operating-system default browser or mail client.
   * The main-process handler re-parses this string with `new URL()` and
   * rejects the request when parsing fails or when the parsed URL violates
   * the allowlist.
   *
   * Bounded to 2048 characters at the schema layer so the renderer cannot
   * force the main process to parse pathological input. The main-process
   * handler applies the same limit as a defense-in-depth check.
   */
  href: z.string().min(1).max(2048),
  /**
   * Optional correlation identifier for observability. Truncated to a
   * conservative bound so a compromised renderer cannot flood main-process
   * logs. Absence is normal — the renderer only supplies one when it is
   * routing through the response-action feedback surface.
   */
  correlationId: z.string().min(1).max(128).optional(),
});
export type ExternalLinkRequestV1 = z.infer<typeof ExternalLinkRequestV1Schema>;

/**
 * Enumerates every reason the main-process handler may reject a request.
 * Renderer surfaces use these codes for non-sensitive user feedback; no
 * raw URL, credential, or system state is ever crossed back.
 */
export const ExternalLinkRejectionCodeSchema = z.enum([
  'invalid-request',
  'invalid-url',
  'url-too-long',
  'scheme-not-allowed',
  'embedded-credentials',
  'control-characters',
  'hostname-not-normalized',
  'shell-open-failed',
]);
export type ExternalLinkRejectionCode = z.infer<
  typeof ExternalLinkRejectionCodeSchema
>;

/**
 * Main → renderer result. `status: 'opened'` is returned only after
 * `shell.openExternal` resolved successfully. Every rejection carries a
 * fixed non-sensitive code; the handler never echoes the input URL or any
 * OS-level error text back to the renderer.
 */
export const ExternalLinkResultV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('opened'),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal('rejected'),
    rejectionCode: ExternalLinkRejectionCodeSchema,
  }),
]);
export type ExternalLinkResultV1 = z.infer<typeof ExternalLinkResultV1Schema>;

/**
 * Convenience alias for the "channels this feature owns" export style used
 * by the rest of the fixed-IPC contracts. Consumed by the IPC allowlist
 * drift guard so the channel cannot be added to the generic invoke bag.
 */
export const EXTERNAL_LINK_IPC_CHANNELS = [
  SHELL_OPEN_EXTERNAL_CHANNEL,
] as const;
export type ExternalLinkIPCChannel = (typeof EXTERNAL_LINK_IPC_CHANNELS)[number];
