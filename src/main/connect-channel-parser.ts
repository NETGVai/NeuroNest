/**
 * Backward-compatible config parsing shim for the `connect-channel` IPC handler.
 *
 * Supports three payload shapes (Requirements 13.1–13.5):
 *   1. JSON string → parse first, then apply flat/nested detection
 *   2. Nested object: { channelId, config: { ... } } → pass config directly
 *   3. Flat object: { channelId, accessToken, ... } → extract channelId, pass rest as config
 *
 * The fix is isolated to the IPC layer — ChannelManager.connect method signature
 * and adapter configSchema are unchanged.
 */

export interface ParsedConnectPayload {
  channelId: string;
  config: unknown;
}

export interface ParseError {
  success: false;
  message: string;
}

export type ParseResult = ParsedConnectPayload | ParseError;

/**
 * Parse a raw `connect-channel` IPC argument into a channelId + config pair.
 *
 * @param arg - The raw argument from the IPC handler (could be object, string, or anything)
 * @returns A ParsedConnectPayload on success, or a ParseError on failure
 */
export function parseConnectChannelArg(arg: unknown): ParseResult {
  // Step 1: Parse JSON string payloads into an object
  let payload = arg;
  if (typeof arg === 'string') {
    try {
      payload = JSON.parse(arg);
    } catch {
      return { success: false, message: 'Invalid connect-channel payload: malformed JSON string' };
    }
  }

  // Step 2: Validate that we have an object with a channelId
  if (typeof payload !== 'object' || payload === null) {
    return { success: false, message: 'Invalid connect-channel payload' };
  }

  const obj = payload as Record<string, unknown>;
  const channelId = obj.channelId;

  if (!channelId || typeof channelId !== 'string') {
    return { success: false, message: 'Invalid connect-channel payload: missing channelId' };
  }

  // Step 3: Detect nested vs flat format
  let config: unknown;
  if (obj.config !== undefined && obj.config !== null) {
    // Nested format: { channelId, config: { accessToken, phoneNumberId, ... } }
    config = obj.config;
  } else {
    // Flat format: { channelId, accessToken, phoneNumberId, ... }
    // Extract channelId and pass the remaining fields as config
    const { channelId: _cid, ...rest } = obj;
    config = rest;
  }

  return { channelId, config };
}

/**
 * Type guard to check if a ParseResult is an error.
 */
export function isParseError(result: ParseResult): result is ParseError {
  return 'success' in result && (result as ParseError).success === false;
}
