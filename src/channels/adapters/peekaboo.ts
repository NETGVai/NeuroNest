// ─── Peekaboo Adapter ────────────────────────────────────────────
// Full ChannelAdapter implementation for macOS screen capture and OCR.
// Uses the native macOS `screencapture` CLI for screenshots and screen
// recording, and the macOS Vision framework (via osascript/Swift bridge)
// for OCR text extraction from captured images. Bidirectional: inbound
// triggers via commands; outbound delivers captured content.
//
// Supported commands: screenshot, record, ocr
// Platform: macOS only
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.12

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { platform } from 'node:process';

const execFileAsync = promisify(execFile);

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Peekaboo adapter configuration.
 *
 * - outputDir: directory for temporary capture files (defaults to system tmp)
 * - captureDelay: delay in seconds before screenshot capture (default: 0)
 * - recordDuration: default screen recording duration in seconds (default: 5)
 * - includeAudio: whether screen recordings include audio (default: false)
 */
export const PeekabooConfigSchema = z.object({
  /** Directory for temporary capture files (optional — uses system tmpdir) */
  outputDir: z.string().optional(),
  /** Delay in seconds before screenshot capture (default: 0) */
  captureDelay: z.number().int().min(0).optional().default(0),
  /** Default screen recording duration in seconds (default: 5) */
  recordDuration: z.number().int().positive().optional().default(5),
  /** Whether screen recordings include audio (default: false) */
  includeAudio: z.boolean().optional().default(false),
});

export type PeekabooConfig = z.infer<typeof PeekabooConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported peekaboo command actions (REQ 10.12) */
type PeekabooAction = 'screenshot' | 'record' | 'ocr';

/** Parsed command structure */
interface PeekabooCommand {
  action: PeekabooAction;
  /** For screenshot/record: optional region {x,y,width,height} */
  region?: { x: number; y: number; width: number; height: number };
  /** For record: duration in seconds */
  duration?: number;
  /** For ocr: path to an existing image file, or undefined to capture first */
  imagePath?: string;
  /** Whether to include the cursor in the capture */
  showCursor?: boolean;
  /** For screenshot: capture a specific window */
  window?: boolean;
}

// ─── Peekaboo Adapter ───────────────────────────────────────────

export class PeekabooAdapter extends BaseChannelAdapter {
  readonly channelId = 'peekaboo';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Peekaboo',
    emoji: '📸',
    description: 'macOS screen capture, recording, and OCR text extraction',
    actionTags: ['screenshot', 'record', 'OCR'],
    sortOrder: 1120,
  };

  readonly configSchema = PeekabooConfigSchema;

  private config: PeekabooConfig | null = null;
  private tempDir: string | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Platform check — macOS only
    if (platform !== 'darwin') {
      return {
        success: false,
        message:
          'Peekaboo adapter is macOS-only. The screencapture CLI and Vision framework are not available on this platform.',
        error: { code: 'PROVIDER_ERROR', message: 'macOS required' },
      };
    }

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Peekaboo adapter configuration is invalid.\n\n' +
        'Configuration options:\n' +
        '  - outputDir (optional): Directory for temporary capture files\n' +
        '  - captureDelay (optional, default: 0): Delay in seconds before capture\n' +
        '  - recordDuration (optional, default: 5): Default recording duration in seconds\n' +
        '  - includeAudio (optional, default: false): Include audio in recordings\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify screencapture is available
    try {
      await execFileAsync('which', ['screencapture']);
    } catch {
      return {
        success: false,
        message:
          'screencapture CLI not found. This tool is bundled with macOS and should be available at /usr/sbin/screencapture.',
        error: { code: 'SDK_MISSING', message: 'screencapture not found' },
      };
    }

    // Create temp directory for captures
    try {
      const baseDir = this.config.outputDir ?? tmpdir();
      this.tempDir = await mkdtemp(join(baseDir, 'peekaboo-'));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to create temporary directory: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Peekaboo adapter connected', {
      tempDir: this.tempDir,
      captureDelay: this.config.captureDelay,
      recordDuration: this.config.recordDuration,
    });

    return {
      success: true,
      message: 'Peekaboo connected (macOS screen capture ready)',
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
    this.tempDir = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config || !this.tempDir) {
      return { success: false, message: 'Peekaboo adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message:
          'Could not parse peekaboo command. Supported actions: screenshot, record, ocr',
      };
    }

    // Execute the parsed command (REQ 10.12)
    try {
      switch (command.action) {
        case 'screenshot':
          return await this.takeScreenshot(command);

        case 'record':
          return await this.recordScreen(command);

        case 'ocr':
          return await this.performOcr(command);

        default:
          return { success: false, message: `Unknown peekaboo action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Peekaboo command failed', { action: command.action, error: errMsg });
      return { success: false, message: `Peekaboo operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Operations (REQ 10.12) ──────────────────────────

  /**
   * Take a screenshot using macOS screencapture CLI.
   * Returns the screenshot as a base64-encoded PNG string.
   */
  private async takeScreenshot(command: PeekabooCommand): Promise<SendResult> {
    const filename = `screenshot-${Date.now()}.png`;
    const filePath = join(this.tempDir!, filename);

    const args: string[] = [];

    // Add delay if configured
    const delay = this.config!.captureDelay;
    if (delay > 0) {
      args.push('-T', String(delay));
    }

    // Capture specific region if provided
    if (command.region) {
      const { x, y, width, height } = command.region;
      args.push('-R', `${x},${y},${width},${height}`);
    }

    // Capture specific window
    if (command.window) {
      args.push('-w');
    }

    // Hide cursor unless explicitly requested
    if (!command.showCursor) {
      args.push('-C');
    }

    // Non-interactive mode (no sound, no crosshair)
    args.push('-x');

    // Output file
    args.push(filePath);

    await execFileAsync('screencapture', args);

    // Read the file and encode as base64
    const imageBuffer = await readFile(filePath);
    const base64Data = imageBuffer.toString('base64');

    // Clean up temp file
    await unlink(filePath).catch(() => {});

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'screenshot',
          filename,
          data: base64Data,
          encoding: 'base64',
          mimeType: 'image/png',
          size: imageBuffer.length,
          region: command.region ?? 'fullscreen',
        },
        null,
        2,
      ),
    };
  }

  /**
   * Record a screen segment using macOS screencapture CLI.
   * Returns metadata about the recording file.
   */
  private async recordScreen(command: PeekabooCommand): Promise<SendResult> {
    const duration = command.duration ?? this.config!.recordDuration;
    const filename = `recording-${Date.now()}.mov`;
    const filePath = join(this.tempDir!, filename);

    const args: string[] = [];

    // Video recording mode
    args.push('-v');

    // Include audio if configured
    if (this.config!.includeAudio) {
      // Use -k flag for audio capture with screen recording
      args.push('-k');
    }

    // Capture specific region if provided
    if (command.region) {
      const { x, y, width, height } = command.region;
      args.push('-R', `${x},${y},${width},${height}`);
    }

    // Non-interactive mode
    args.push('-x');

    // Output file
    args.push(filePath);

    // screencapture -v records until interrupted. We use a timeout to stop it.
    const recordingProcess = execFile('screencapture', args);

    // Wait for the specified duration, then terminate recording
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (recordingProcess.pid) {
          // Send SIGINT to gracefully stop recording
          recordingProcess.kill('SIGINT');
        }
        resolve();
      }, duration * 1000);

      recordingProcess.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      recordingProcess.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // Read the recording file size (don't base64 encode large videos)
    let fileSize = 0;
    try {
      const videoBuffer = await readFile(filePath);
      fileSize = videoBuffer.length;
    } catch {
      // File might not exist if recording was too short
    }

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'record',
          filename,
          filePath,
          duration,
          mimeType: 'video/quicktime',
          size: fileSize,
          includeAudio: this.config!.includeAudio,
          region: command.region ?? 'fullscreen',
        },
        null,
        2,
      ),
    };
  }

  /**
   * Perform OCR on a captured screenshot using macOS Vision framework.
   * If no imagePath is provided, takes a screenshot first and then OCRs it.
   * Uses osascript with a Swift/ObjC bridge to invoke VNRecognizeTextRequest.
   */
  private async performOcr(command: PeekabooCommand): Promise<SendResult> {
    let imagePath = command.imagePath;

    // If no image path provided, take a screenshot first
    if (!imagePath) {
      const filename = `ocr-source-${Date.now()}.png`;
      imagePath = join(this.tempDir!, filename);

      const args: string[] = ['-x', '-C'];
      if (command.region) {
        const { x, y, width, height } = command.region;
        args.push('-R', `${x},${y},${width},${height}`);
      }
      args.push(imagePath);

      await execFileAsync('screencapture', args);
    }

    // Use osascript to invoke macOS Vision framework for OCR
    // This uses an AppleScript that calls the Objective-C Vision API
    const ocrScript = `
use framework "Vision"
use framework "AppKit"
use scripting additions

set imagePath to "${imagePath.replace(/"/g, '\\"')}"
set theImage to current application's NSImage's alloc()'s initWithContentsOfFile:imagePath

if theImage is missing value then
  return "ERROR: Could not load image at path: " & imagePath
end if

set tiffData to theImage's TIFFRepresentation()
set bitmapRep to current application's NSBitmapImageRep's imageRepWithData:tiffData
set ciImage to current application's CIImage's imageWithData:(bitmapRep's representationUsingType:(current application's NSBitmapImageFileTypePNG) |properties|:(missing value))

set requestHandler to current application's VNImageRequestHandler's alloc()'s initWithCIImage:ciImage options:(current application's NSDictionary's dictionary())
set textRequest to current application's VNRecognizeTextRequest's alloc()'s init()
textRequest's setRecognitionLevel:(current application's VNRequestTextRecognitionLevelAccurate)

set {success, theError} to requestHandler's performRequests:{textRequest} |error|:(reference)

if not success then
  return "ERROR: OCR request failed"
end if

set observations to textRequest's results()
set recognizedTexts to {}

repeat with observation in observations
  set topCandidate to (observation's topCandidates:1)'s firstObject()
  if topCandidate is not missing value then
    set end of recognizedTexts to (topCandidate's |string|() as text)
  end if
end repeat

set AppleScript's text item delimiters to linefeed
return recognizedTexts as text
`;

    const { stdout } = await execFileAsync('osascript', ['-l', 'AppleScript', '-e', ocrScript]);
    const ocrText = stdout.trim();

    // Check for errors from the script
    if (ocrText.startsWith('ERROR:')) {
      return {
        success: false,
        message: ocrText,
      };
    }

    // Clean up screenshot if we took one
    if (!command.imagePath) {
      await unlink(imagePath).catch(() => {});
    }

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'ocr',
          text: ocrText,
          lines: ocrText.split('\n').filter((l) => l.trim().length > 0).length,
          length: ocrText.length,
          source: command.imagePath ? 'provided-image' : 'screenshot',
          region: command.region ?? 'fullscreen',
        },
        null,
        2,
      ),
    };
  }

  // ─── Private: Command parsing ─────────────────────────────────

  /**
   * Parse message content into a structured peekaboo command.
   * Supports JSON-format commands and natural language patterns:
   * - "screenshot" / "capture screen"
   * - "screenshot window" / "capture window"
   * - "record [duration]" / "record screen [for N seconds]"
   * - "ocr" / "read screen" / "extract text from screen"
   * - "ocr /path/to/image.png"
   */
  private parseCommand(content: string): PeekabooCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as PeekabooCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const trimmed = content.trim().toLowerCase();

    // Pattern: "screenshot" / "capture screen" / "take screenshot" / "screenshot window"
    const screenshotMatch = trimmed.match(
      /^(?:screenshot|capture\s+screen|take\s+(?:a\s+)?screenshot|screen\s*cap(?:ture)?)(?:\s+(window|win))?$/i,
    );
    if (screenshotMatch) {
      return {
        action: 'screenshot',
        window: !!screenshotMatch[1],
      };
    }

    // Pattern: "record [N]" / "record screen [for N seconds]" / "screen record [N]"
    const recordMatch = trimmed.match(
      /^(?:record|record\s+screen|screen\s+record)(?:\s+(?:for\s+)?(\d+)(?:\s*(?:s|sec|seconds?))?)?$/i,
    );
    if (recordMatch) {
      return {
        action: 'record',
        duration: recordMatch[1] ? parseInt(recordMatch[1], 10) : undefined,
      };
    }

    // Pattern: "ocr [path]" / "read screen" / "extract text" / "ocr from <path>"
    const ocrMatch = trimmed.match(
      /^(?:ocr|read\s+screen|extract\s+text(?:\s+from\s+screen)?)(?:\s+(?:from\s+)?(.+))?$/i,
    );
    if (ocrMatch) {
      const imagePath = ocrMatch[1]?.trim();
      return {
        action: 'ocr',
        imagePath: imagePath && imagePath.length > 0 ? imagePath : undefined,
      };
    }

    return null;
  }
}
