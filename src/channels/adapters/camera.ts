// ─── Camera Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for system camera access.
// Uses the macOS AVFoundation framework (via Swift CLI bridge) for
// photo capture, video recording, and QR code scanning. Bidirectional:
// inbound triggers via commands; outbound delivers captured content.
//
// Supported commands: capture-photo, record-video, scan-qr
// Platform: macOS only (uses AVFoundation via osascript/Swift bridge)
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.11

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
 * Zod schema for Camera adapter configuration.
 *
 * - outputDir: directory for temporary capture files (defaults to system tmp)
 * - deviceIndex: camera device index to use (default: 0, the built-in camera)
 * - recordDuration: default video recording duration in seconds (default: 5)
 * - photoFormat: format for captured photos (default: 'png')
 */
export const CameraConfigSchema = z.object({
  /** Directory for temporary capture files (optional — uses system tmpdir) */
  outputDir: z.string().optional(),
  /** Camera device index (default: 0 for built-in camera) */
  deviceIndex: z.number().int().min(0).optional().default(0),
  /** Default video recording duration in seconds (default: 5) */
  recordDuration: z.number().int().positive().optional().default(5),
  /** Photo output format (default: png) */
  photoFormat: z.enum(['png', 'jpg']).optional().default('png'),
});

export type CameraConfig = z.infer<typeof CameraConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported camera command actions (REQ 10.11) */
type CameraAction = 'capture-photo' | 'record-video' | 'scan-qr';

/** Parsed command structure */
interface CameraCommand {
  action: CameraAction;
  /** For record-video: duration in seconds */
  duration?: number;
  /** For capture-photo: optional filename override */
  filename?: string;
  /** For scan-qr: optional image path to scan from (instead of live capture) */
  imagePath?: string;
}

// ─── Camera Adapter ─────────────────────────────────────────────

export class CameraAdapter extends BaseChannelAdapter {
  readonly channelId = 'camera';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Camera',
    emoji: '📷',
    description: 'Capture photos, record video, and scan QR codes using system camera',
    actionTags: ['capture photo', 'record video', 'scan QR'],
    sortOrder: 1130,
  };

  readonly configSchema = CameraConfigSchema;

  private config: CameraConfig | null = null;
  private tempDir: string | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Platform check — macOS only
    if (platform !== 'darwin') {
      return {
        success: false,
        message:
          'Camera adapter is macOS-only. AVFoundation camera APIs are not available on this platform.',
        error: { code: 'PROVIDER_ERROR', message: 'macOS required' },
      };
    }

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Camera adapter configuration is invalid.\n\n' +
        'Configuration options:\n' +
        '  - outputDir (optional): Directory for temporary capture files\n' +
        '  - deviceIndex (optional, default: 0): Camera device index\n' +
        '  - recordDuration (optional, default: 5): Default recording duration in seconds\n' +
        '  - photoFormat (optional, default: "png"): Photo format (png or jpg)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify camera access is possible via system_profiler
    try {
      const { stdout } = await execFileAsync('system_profiler', ['SPCameraDataType']);
      if (!stdout || stdout.trim().length === 0) {
        return {
          success: false,
          message: 'No camera device detected on this system.',
          error: { code: 'PROVIDER_ERROR', message: 'No camera found' },
        };
      }
    } catch {
      return {
        success: false,
        message:
          'Unable to query camera devices. Ensure camera permissions are granted to this application.',
        error: { code: 'PROVIDER_ERROR', message: 'Camera query failed' },
      };
    }

    // Create temp directory for captures
    try {
      const baseDir = this.config.outputDir ?? tmpdir();
      this.tempDir = await mkdtemp(join(baseDir, 'camera-'));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to create temporary directory: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Camera adapter connected', {
      tempDir: this.tempDir,
      deviceIndex: this.config.deviceIndex,
      recordDuration: this.config.recordDuration,
      photoFormat: this.config.photoFormat,
    });

    return {
      success: true,
      message: 'Camera connected (system camera ready)',
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
      return { success: false, message: 'Camera adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message:
          'Could not parse camera command. Supported actions: capture-photo, record-video, scan-qr',
      };
    }

    // Execute the parsed command (REQ 10.11)
    try {
      switch (command.action) {
        case 'capture-photo':
          return await this.capturePhoto(command);

        case 'record-video':
          return await this.recordVideo(command);

        case 'scan-qr':
          return await this.scanQr(command);

        default:
          return { success: false, message: `Unknown camera action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Camera command failed', { action: command.action, error: errMsg });
      return { success: false, message: `Camera operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Operations (REQ 10.11) ──────────────────────────

  /**
   * Capture a photo using the system camera via AVFoundation Swift bridge.
   * Returns the captured photo as a base64-encoded image string.
   */
  private async capturePhoto(command: CameraCommand): Promise<SendResult> {
    const format = this.config!.photoFormat;
    const filename = command.filename ?? `photo-${Date.now()}.${format}`;
    const filePath = join(this.tempDir!, filename);

    // Use a Swift script via osascript to capture a still frame from the camera
    // via AVFoundation. This uses AVCaptureSession to grab a single frame.
    const captureScript = this.buildCapturePhotoScript(filePath, format);

    const { stdout, stderr } = await execFileAsync('swift', ['-e', captureScript], {
      timeout: 15000,
    });

    // Check for errors from the script
    const output = (stdout || stderr || '').trim();
    if (output.startsWith('ERROR:')) {
      return { success: false, message: output };
    }

    // Read the file and encode as base64
    let imageBuffer: Buffer;
    try {
      imageBuffer = await readFile(filePath);
    } catch {
      return {
        success: false,
        message: 'Photo capture completed but output file was not created. Check camera permissions.',
      };
    }

    const base64Data = imageBuffer.toString('base64');

    // Clean up temp file
    await unlink(filePath).catch(() => {});

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'capture-photo',
          filename,
          data: base64Data,
          encoding: 'base64',
          mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
          size: imageBuffer.length,
          deviceIndex: this.config!.deviceIndex,
        },
        null,
        2,
      ),
    };
  }

  /**
   * Record video using the system camera via AVFoundation Swift bridge.
   * Returns metadata about the recorded video file.
   */
  private async recordVideo(command: CameraCommand): Promise<SendResult> {
    const duration = command.duration ?? this.config!.recordDuration;
    const filename = `video-${Date.now()}.mov`;
    const filePath = join(this.tempDir!, filename);

    // Use a Swift script via osascript to record video from the camera
    const recordScript = this.buildRecordVideoScript(filePath, duration);

    // Allow enough time for recording plus startup overhead
    const timeout = (duration + 10) * 1000;
    const { stdout, stderr } = await execFileAsync('swift', ['-e', recordScript], {
      timeout,
    });

    // Check for errors from the script
    const output = (stdout || stderr || '').trim();
    if (output.startsWith('ERROR:')) {
      return { success: false, message: output };
    }

    // Read the recording file size
    let fileSize = 0;
    try {
      const videoBuffer = await readFile(filePath);
      fileSize = videoBuffer.length;
    } catch {
      return {
        success: false,
        message: 'Video recording completed but output file was not created. Check camera permissions.',
      };
    }

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'record-video',
          filename,
          filePath,
          duration,
          mimeType: 'video/quicktime',
          size: fileSize,
          deviceIndex: this.config!.deviceIndex,
        },
        null,
        2,
      ),
    };
  }

  /**
   * Scan for QR codes using the camera or from a provided image.
   * Uses macOS Vision framework (VNDetectBarcodesRequest) for QR detection.
   */
  private async scanQr(command: CameraCommand): Promise<SendResult> {
    let imagePath = command.imagePath;
    let capturedForScan = false;

    // If no image path provided, capture a photo first to scan
    if (!imagePath) {
      imagePath = join(this.tempDir!, `qr-source-${Date.now()}.png`);
      const captureScript = this.buildCapturePhotoScript(imagePath, 'png');

      const { stdout, stderr } = await execFileAsync('swift', ['-e', captureScript], {
        timeout: 15000,
      });

      const output = (stdout || stderr || '').trim();
      if (output.startsWith('ERROR:')) {
        return { success: false, message: `Failed to capture image for QR scan: ${output}` };
      }
      capturedForScan = true;
    }

    // Use Vision framework to detect QR codes in the image
    const scanScript = this.buildQrScanScript(imagePath);

    const { stdout } = await execFileAsync('osascript', ['-l', 'AppleScript', '-e', scanScript]);
    const scanOutput = stdout.trim();

    // Clean up captured image if we took one
    if (capturedForScan) {
      await unlink(imagePath).catch(() => {});
    }

    // Check for errors
    if (scanOutput.startsWith('ERROR:')) {
      return { success: false, message: scanOutput };
    }

    // Parse detected QR codes (newline-separated)
    const codes = scanOutput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'scan-qr',
          found: codes.length > 0,
          codes,
          count: codes.length,
          source: command.imagePath ? 'provided-image' : 'camera-capture',
        },
        null,
        2,
      ),
    };
  }

  // ─── Private: Script builders ─────────────────────────────────

  /**
   * Build a Swift script that captures a single photo from the camera
   * using AVFoundation and writes it to the specified file path.
   */
  private buildCapturePhotoScript(outputPath: string, format: string): string {
    const escapedPath = outputPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const imageType = format === 'png' ? 'png' : 'jpeg';

    return `
import AVFoundation
import AppKit
import Darwin

let outputPath = "${escapedPath}"
let semaphore = DispatchSemaphore(value: 0)
var captureError: String? = nil

class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    let path: String
    let format: String
    let sem: DispatchSemaphore

    init(path: String, format: String, sem: DispatchSemaphore) {
        self.path = path
        self.format = format
        self.sem = sem
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        defer { sem.signal() }
        if let error = error {
            captureError = "ERROR: Photo capture failed: \\(error.localizedDescription)"
            return
        }
        guard let imageData = photo.fileDataRepresentation() else {
            captureError = "ERROR: Could not get image data"
            return
        }
        let url = URL(fileURLWithPath: path)
        do {
            try imageData.write(to: url)
        } catch {
            captureError = "ERROR: Failed to write image: \\(error.localizedDescription)"
        }
    }
}

let session = AVCaptureSession()
session.sessionPreset = .photo

guard let device = AVCaptureDevice.default(for: .video) else {
    print("ERROR: No camera device available")
    exit(1)
}

guard let input = try? AVCaptureDeviceInput(device: device) else {
    print("ERROR: Cannot create camera input")
    exit(1)
}

guard session.canAddInput(input) else {
    print("ERROR: Cannot add camera input to session")
    exit(1)
}
session.addInput(input)

let photoOutput = AVCapturePhotoOutput()
guard session.canAddOutput(photoOutput) else {
    print("ERROR: Cannot add photo output to session")
    exit(1)
}
session.addOutput(photoOutput)

session.startRunning()

// Allow camera to warm up
Thread.sleep(forTimeInterval: 0.5)

let settings = AVCapturePhotoSettings()
let delegate = PhotoCaptureDelegate(path: outputPath, format: "${imageType}", sem: semaphore)
photoOutput.capturePhoto(with: settings, delegate: delegate)

_ = semaphore.wait(timeout: .now() + 10)
session.stopRunning()

if let error = captureError {
    print(error)
    exit(1)
}
print("OK")
`;
  }

  /**
   * Build a Swift script that records video from the camera
   * using AVFoundation for the specified duration.
   */
  private buildRecordVideoScript(outputPath: string, duration: number): string {
    const escapedPath = outputPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    return `
import AVFoundation
import Darwin

let outputPath = "${escapedPath}"
let duration: Double = ${duration}
let semaphore = DispatchSemaphore(value: 0)

class RecordingDelegate: NSObject, AVCaptureFileOutputRecordingDelegate {
    let sem: DispatchSemaphore

    init(sem: DispatchSemaphore) {
        self.sem = sem
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        if let error = error {
            print("ERROR: Recording failed: \\(error.localizedDescription)")
        }
        sem.signal()
    }
}

let session = AVCaptureSession()
session.sessionPreset = .high

guard let device = AVCaptureDevice.default(for: .video) else {
    print("ERROR: No camera device available")
    exit(1)
}

guard let input = try? AVCaptureDeviceInput(device: device) else {
    print("ERROR: Cannot create camera input")
    exit(1)
}

guard session.canAddInput(input) else {
    print("ERROR: Cannot add camera input to session")
    exit(1)
}
session.addInput(input)

let movieOutput = AVCaptureMovieFileOutput()
guard session.canAddOutput(movieOutput) else {
    print("ERROR: Cannot add movie output to session")
    exit(1)
}
session.addOutput(movieOutput)

session.startRunning()

// Allow camera to warm up
Thread.sleep(forTimeInterval: 0.5)

let outputURL = URL(fileURLWithPath: outputPath)
let delegate = RecordingDelegate(sem: semaphore)
movieOutput.startRecording(to: outputURL, recordingDelegate: delegate)

// Record for the specified duration then stop
Thread.sleep(forTimeInterval: duration)
movieOutput.stopRecording()

_ = semaphore.wait(timeout: .now() + 10)
session.stopRunning()
print("OK")
`;
  }

  /**
   * Build an AppleScript that uses the Vision framework to detect
   * QR/barcode content from an image file.
   */
  private buildQrScanScript(imagePath: string): string {
    const escapedPath = imagePath.replace(/"/g, '\\"');

    return `
use framework "Vision"
use framework "AppKit"
use scripting additions

set imagePath to "${escapedPath}"
set theImage to current application's NSImage's alloc()'s initWithContentsOfFile:imagePath

if theImage is missing value then
  return "ERROR: Could not load image at path: " & imagePath
end if

set tiffData to theImage's TIFFRepresentation()
set bitmapRep to current application's NSBitmapImageRep's imageRepWithData:tiffData
set ciImage to current application's CIImage's imageWithData:(bitmapRep's representationUsingType:(current application's NSBitmapImageFileTypePNG) |properties|:(missing value))

set requestHandler to current application's VNImageRequestHandler's alloc()'s initWithCIImage:ciImage options:(current application's NSDictionary's dictionary())
set barcodeRequest to current application's VNDetectBarcodesRequest's alloc()'s init()

set {success, theError} to requestHandler's performRequests:{barcodeRequest} |error|:(reference)

if not success then
  return "ERROR: Barcode detection failed"
end if

set observations to barcodeRequest's results()
set detectedCodes to {}

repeat with observation in observations
  set payload to observation's payloadStringValue()
  if payload is not missing value then
    set end of detectedCodes to (payload as text)
  end if
end repeat

if (count of detectedCodes) = 0 then
  return ""
end if

set AppleScript's text item delimiters to linefeed
return detectedCodes as text
`;
  }

  // ─── Private: Command parsing ─────────────────────────────────

  /**
   * Parse message content into a structured camera command.
   * Supports JSON-format commands and natural language patterns:
   * - "capture-photo" / "take photo" / "capture"
   * - "record-video [duration]" / "record [N seconds]"
   * - "scan-qr" / "scan qr code" / "scan barcode"
   * - "scan-qr /path/to/image.png"
   */
  private parseCommand(content: string): CameraCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as CameraCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const trimmed = content.trim().toLowerCase();

    // Pattern: "capture-photo" / "take photo" / "capture" / "take a photo" / "photo"
    const photoMatch = trimmed.match(
      /^(?:capture[- ]?photo|take\s+(?:a\s+)?(?:photo|picture)|capture|photo|picture|snap)$/i,
    );
    if (photoMatch) {
      return { action: 'capture-photo' };
    }

    // Pattern: "record-video [N]" / "record [for N seconds]" / "record video [N]"
    const recordMatch = trimmed.match(
      /^(?:record[- ]?video|record|video)(?:\s+(?:for\s+)?(\d+)(?:\s*(?:s|sec|seconds?))?)?$/i,
    );
    if (recordMatch) {
      return {
        action: 'record-video',
        duration: recordMatch[1] ? parseInt(recordMatch[1], 10) : undefined,
      };
    }

    // Pattern: "scan-qr [path]" / "scan qr code" / "scan barcode" / "qr" / "scan qr from <path>"
    const qrMatch = trimmed.match(
      /^(?:scan[- ]?qr(?:\s+code)?|scan\s+barcode|qr(?:\s+code)?|barcode)(?:\s+(?:from\s+)?(.+))?$/i,
    );
    if (qrMatch) {
      const imagePath = qrMatch[1]?.trim();
      return {
        action: 'scan-qr',
        imagePath: imagePath && imagePath.length > 0 ? imagePath : undefined,
      };
    }

    return null;
  }
}
