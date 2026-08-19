/**
 * Bounded incremental decoder for untrusted proxy SSE and NDJSON streams.
 *
 * The decoder preserves one semantic data payload per wire frame. It never
 * exposes protocol field syntax as content and never includes rejected wire
 * bytes in diagnostics.
 *
 * Requirements: 8.1–8.3, 15.1, 15.8
 */

export const DEFAULT_MAX_PROXY_FRAME_BYTES = 256 * 1024;
export const DEFAULT_MAX_PROXY_CHUNK_BYTES = 512 * 1024;
export const DEFAULT_MAX_PROXY_EVENT_NAME_LENGTH = 128;

export type ProxyStreamFraming = 'sse' | 'ndjson';

export interface ProxyStreamDecoderOptions {
  framing?: ProxyStreamFraming;
  maxFrameBytes?: number;
  maxChunkBytes?: number;
}

export interface ProxyStreamFrame {
  data: string;
  event?: string;
  id?: string;
  retryMs?: number;
}

export type ProxyStreamDecodeErrorCode =
  | 'chunk_too_large'
  | 'frame_too_large'
  | 'invalid_utf8'
  | 'malformed_frame';

export interface ProxyStreamDecodeError {
  code: ProxyStreamDecodeErrorCode;
  summary: string;
  recoverable: true;
}

export type ProxyStreamDecodeResult =
  | { ok: true; frame: ProxyStreamFrame }
  | { ok: false; error: ProxyStreamDecodeError };

const EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function positiveBound(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function decodeError(code: ProxyStreamDecodeErrorCode, summary: string): ProxyStreamDecodeResult {
  return { ok: false, error: { code, summary, recoverable: true } };
}

/** Stateful because network chunks may split UTF-8 code points and frames. */
export class ProxyStreamDecoder {
  private readonly framing: ProxyStreamFraming;
  private readonly maxFrameBytes: number;
  private readonly maxChunkBytes: number;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private discardingOversizedFrame = false;
  private closed = false;

  constructor(options: ProxyStreamDecoderOptions = {}) {
    this.framing = options.framing ?? 'sse';
    this.maxFrameBytes = positiveBound(options.maxFrameBytes, DEFAULT_MAX_PROXY_FRAME_BYTES);
    this.maxChunkBytes = positiveBound(options.maxChunkBytes, DEFAULT_MAX_PROXY_CHUNK_BYTES);
  }

  push(chunk: Uint8Array | string): ProxyStreamDecodeResult[] {
    if (this.closed) {
      return [decodeError('malformed_frame', 'The proxy stream was already closed.')];
    }

    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (bytes.byteLength > this.maxChunkBytes) {
      this.resetAfterInvalidInput();
      return [decodeError('chunk_too_large', 'A proxy stream chunk exceeded the configured limit.')];
    }

    let decoded: string;
    try {
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      this.resetAfterInvalidInput();
      return [decodeError('invalid_utf8', 'The proxy stream contained invalid UTF-8.')];
    }

    return this.consume(decoded, false);
  }

  /** Compatibility alias for stream-style consumers. */
  write(chunk: Uint8Array | string): ProxyStreamDecodeResult[] {
    return this.push(chunk);
  }

  finish(): ProxyStreamDecodeResult[] {
    if (this.closed) return [];
    this.closed = true;

    let trailing = '';
    try {
      trailing = this.decoder.decode();
    } catch {
      this.buffer = '';
      return [decodeError('invalid_utf8', 'The proxy stream ended with invalid UTF-8.')];
    }

    return this.consume(trailing, true);
  }

  /** Compatibility alias for stream-style consumers. */
  end(): ProxyStreamDecodeResult[] {
    return this.finish();
  }

  private consume(decoded: string, flush: boolean): ProxyStreamDecodeResult[] {
    this.buffer += decoded;
    const results: ProxyStreamDecodeResult[] = [];

    if (this.discardingOversizedFrame) {
      const boundary = this.findBoundary(this.buffer);
      if (boundary === undefined) {
        this.buffer = '';
        return results;
      }
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.discardingOversizedFrame = false;
    }

    while (true) {
      const boundary = this.findBoundary(this.buffer);
      if (boundary === undefined) break;

      const rawFrame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.decodeFrame(rawFrame, results);
    }

    if (!flush && byteLength(this.buffer) > this.maxFrameBytes) {
      this.buffer = '';
      this.discardingOversizedFrame = true;
      results.push(
        decodeError('frame_too_large', 'A proxy stream frame exceeded the configured limit.'),
      );
    }

    if (flush) {
      if (this.discardingOversizedFrame) {
        this.discardingOversizedFrame = false;
        this.buffer = '';
      } else if (this.buffer.length > 0) {
        const rawFrame = this.buffer;
        this.buffer = '';
        this.decodeFrame(rawFrame, results);
      }
    }

    return results;
  }

  private decodeFrame(rawFrame: string, results: ProxyStreamDecodeResult[]): void {
    if (rawFrame.length === 0) return;
    if (byteLength(rawFrame) > this.maxFrameBytes) {
      results.push(
        decodeError('frame_too_large', 'A proxy stream frame exceeded the configured limit.'),
      );
      return;
    }

    if (this.framing === 'ndjson') {
      const data = rawFrame.endsWith('\r') ? rawFrame.slice(0, -1) : rawFrame;
      if (data.trim().length > 0) results.push({ ok: true, frame: { data } });
      return;
    }

    const parsed = this.parseSseFrame(rawFrame);
    if (parsed === undefined) return;
    results.push(parsed);
  }

  private parseSseFrame(rawFrame: string): ProxyStreamDecodeResult | undefined {
    const dataLines: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    let retryMs: number | undefined;

    for (const line of rawFrame.split(/\r\n|\r|\n/u)) {
      if (line === '' || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'data':
          dataLines.push(value);
          break;
        case 'event':
          if (
            value.length === 0 ||
            value.length > DEFAULT_MAX_PROXY_EVENT_NAME_LENGTH ||
            !EVENT_NAME_PATTERN.test(value)
          ) {
            return decodeError('malformed_frame', 'A proxy stream frame had invalid metadata.');
          }
          event = value;
          break;
        case 'id':
          if (value.includes('\0') || byteLength(value) > 256) {
            return decodeError('malformed_frame', 'A proxy stream frame had invalid metadata.');
          }
          id = value;
          break;
        case 'retry':
          if (!/^\d+$/u.test(value)) {
            return decodeError('malformed_frame', 'A proxy stream frame had invalid metadata.');
          }
          retryMs = Number(value);
          if (!Number.isSafeInteger(retryMs)) {
            return decodeError('malformed_frame', 'A proxy stream frame had invalid metadata.');
          }
          break;
        default:
          // Unknown SSE fields are ignored by the protocol and never become content.
          break;
      }
    }

    if (dataLines.length === 0) return undefined;
    return {
      ok: true,
      frame: {
        data: dataLines.join('\n'),
        ...(event === undefined ? {} : { event }),
        ...(id === undefined ? {} : { id }),
        ...(retryMs === undefined ? {} : { retryMs }),
      },
    };
  }

  private findBoundary(value: string): { index: number; length: number } | undefined {
    if (this.framing === 'ndjson') {
      const index = value.indexOf('\n');
      return index < 0 ? undefined : { index, length: 1 };
    }

    const match = /\r\n\r\n|\n\n|\r\r/u.exec(value);
    return match === null ? undefined : { index: match.index, length: match[0].length };
  }

  private resetAfterInvalidInput(): void {
    this.buffer = '';
    this.discardingOversizedFrame = false;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
  }
}
