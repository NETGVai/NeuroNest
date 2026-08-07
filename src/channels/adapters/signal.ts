// ─── Signal Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for Signal using signal-cli subprocess.
// Handles connecting via signal-cli, sending messages (text + media),
// and receiving inbound messages via a long-running `signal-cli receive`
// subprocess that emits JSON-formatted messages on stdout.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 1.6,
// REQ 4.1, REQ 6.1, REQ 6.5

import { z } from 'zod';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { BaseChannelAdapter } from './base-adapter';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Signal adapter configuration.
 * Requires the registered phone number and the path to signal-cli binary.
 */
export const SignalConfigSchema = z.object({
  /** The phone number registered with signal-cli (E.164 format, e.g. +15551234567) */
  phoneNumber: z.string().min(1),
  /** Absolute path to the signal-cli binary (defaults to 'signal-cli' in PATH) */
  signalCliPath: z.string().default('signal-cli'),
});

export type SignalConfig = z.infer<typeof SignalConfigSchema>;

// ─── Signal Adapter ─────────────────────────────────────────────

export class SignalAdapter extends BaseChannelAdapter {
  readonly channelId = 'signal';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'push',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Signal',
    emoji: '🔒',
    description: 'Privacy-focused via signal-cli',
    actionTags: ['send message', 'receive message', 'send media'],
    sortOrder: 1000,
  };

  readonly configSchema = SignalConfigSchema;

  private config: SignalConfig | null = null;
  private receiveProcess: ChildProcess | null = null;
  private receiveBuffer = '';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Signal adapter requires a phone number and signal-cli path.\n\n' +
        'Setup steps:\n' +
        '1. Install signal-cli: https://github.com/AsamK/signal-cli\n' +
        '2. Register or link your phone number with signal-cli\n' +
        '3. Connect with: phoneNumber=+15551234567 signalCliPath=/path/to/signal-cli\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;
    const { phoneNumber, signalCliPath } = this.config;

    // Verify signal-cli is accessible by running a quick version check
    try {
      await this.execSignalCli(signalCliPath, ['--version']);
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
        return this.sdkMissing('signal-cli');
      }
      return {
        success: false,
        message: `Failed to verify signal-cli: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Start the background receive process
    try {
      this.startReceiveProcess(signalCliPath, phoneNumber);
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      return {
        success: false,
        message: `Failed to start signal-cli receive: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', { phoneNumber });

    return {
      success: true,
      message: `Signal connected for ${phoneNumber}`,
    };
  }

  async disconnect(): Promise<void> {
    this.stopReceiveProcess();
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Signal adapter is not connected' };
    }

    const { phoneNumber, signalCliPath } = this.config;

    const args: string[] = [
      '-a', phoneNumber,
      'send',
      '-m', message.content,
      message.to,
    ];

    // Support media attachments (REQ 6.5)
    if (message.contentType && message.contentType !== 'text' && message.providerMetadata) {
      const metadata = message.providerMetadata as Record<string, unknown>;
      const attachmentPath = metadata['attachmentPath'] as string | undefined;
      if (attachmentPath) {
        args.splice(args.indexOf('-m'), 0, '-a');
        // Insert attachment arg: signal-cli send -a <attachment> -m <message> <recipient>
        args.splice(2, 0, attachmentPath);
      }
    }

    try {
      await this.execSignalCli(signalCliPath, args);
      return { success: true, message: `Message sent to ${message.to}` };
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      this.log('error', 'Send failed', { error: errMsg, to: message.to });
      return { success: false, message: `Signal send failed: ${errMsg}` };
    }
  }

  // ─── Private: Start background receive process ──────────────────

  private startReceiveProcess(signalCliPath: string, phoneNumber: string): void {
    this.receiveBuffer = '';

    // Launch signal-cli in JSON receive mode for continuous message monitoring
    this.receiveProcess = spawn(signalCliPath, [
      '-a', phoneNumber,
      '--output=json',
      'receive',
      '--timeout', '-1', // Infinite timeout — keep receiving
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.receiveProcess.stdout?.on('data', (chunk: Buffer) => {
      this.receiveBuffer += chunk.toString('utf8');
      this.processReceiveBuffer();
    });

    this.receiveProcess.stderr?.on('data', (chunk: Buffer) => {
      const errText = chunk.toString('utf8').trim();
      if (errText) {
        this.log('warn', 'signal-cli stderr', { output: errText });
      }
    });

    this.receiveProcess.on('close', (code) => {
      this.log('info', 'signal-cli receive process exited', { code });
      // If we're still supposed to be connected, this is unexpected
      if (this.connected) {
        this.log('warn', 'signal-cli receive process terminated unexpectedly', { code });
      }
      this.receiveProcess = null;
    });

    this.receiveProcess.on('error', (err) => {
      this.log('error', 'signal-cli receive process error', { error: err.message });
      this.receiveProcess = null;
    });
  }

  // ─── Private: Process JSON lines from receive buffer ────────────

  private processReceiveBuffer(): void {
    // signal-cli --output=json emits one JSON object per line
    const lines = this.receiveBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.receiveBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const envelope = JSON.parse(trimmed);
        this.handleEnvelope(envelope);
      } catch {
        this.log('warn', 'Failed to parse signal-cli JSON line', { line: trimmed.slice(0, 200) });
      }
    }
  }

  // ─── Private: Handle a signal-cli envelope ──────────────────────

  private handleEnvelope(envelope: any): void {
    if (!this.ctx) return;

    // signal-cli JSON format: { envelope: { source, dataMessage: { message, attachments } } }
    const env = envelope?.envelope ?? envelope;
    const source = env?.source ?? env?.sourceNumber;
    const dataMessage = env?.dataMessage;

    if (!source || !dataMessage) return;

    const messageText = dataMessage.message ?? dataMessage.body ?? '';
    const attachments = dataMessage.attachments;

    // Determine content type based on attachments
    let contentType: 'text' | 'image' | 'audio' | 'video' | 'file' = 'text';
    let content = messageText;

    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      const firstAttachment = attachments[0];
      const mimeType = firstAttachment?.contentType ?? '';

      if (mimeType.startsWith('image/')) {
        contentType = 'image';
      } else if (mimeType.startsWith('audio/')) {
        contentType = 'audio';
      } else if (mimeType.startsWith('video/')) {
        contentType = 'video';
      } else {
        contentType = 'file';
      }

      // Include attachment info in the content if no text message
      if (!content && firstAttachment?.id) {
        content = `[attachment: ${mimeType || 'unknown'}]`;
      }
    }

    // Only emit if there's actual content
    if (!content) return;

    this.emitInbound(source, content, contentType);
  }

  // ─── Private: Stop the receive process ──────────────────────────

  private stopReceiveProcess(): void {
    if (this.receiveProcess) {
      this.receiveProcess.kill('SIGTERM');
      this.receiveProcess = null;
    }
    this.receiveBuffer = '';
  }

  // ─── Private: Execute signal-cli command ────────────────────────

  private execSignalCli(cliPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cliPath, args, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          const fullMsg = stderr?.trim() || error.message;
          reject(new Error(fullMsg));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}
