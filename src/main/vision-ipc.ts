/**
 * IPC handler registration for the Vision Analyzer System.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, pipeline-ipc.ts).
 *
 * Channels:
 *   vision:analyze  — analyze a screenshot to detect UI components
 *   vision:compare  — compare two images for visual differences
 *   vision:diagram  — recognize architecture diagram and extract graph structure
 *
 * Requirements: 8.4, 22.3
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { VisionAnalyzerService } from '../vision/vision-analyzer-service.js';
import type {
  VisualAnalysisResult,
  VisualDiffResult,
  DiagramRecognitionResult,
} from '../shared/feature-integration-types.js';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface VisionIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Lazy singleton ─────────────────────────────────────────────

let visionService: VisionAnalyzerService | null = null;

function getVisionService(): VisionAnalyzerService {
  if (!visionService) visionService = new VisionAnalyzerService();
  return visionService;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): VisionIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Registration ───────────────────────────────────────────────

export function registerVisionIPC(_mainWindow: BrowserWindow): void {
  // ── vision:analyze ──
  // Requirement 6.1–6.5: Analyze a screenshot to detect UI components
  ipcMain.handle(
    'vision:analyze',
    async (
      _event,
      args: { image: string; width: number; height: number },
    ) => {
      try {
        const service = getVisionService();

        if (!service.isModelAvailable()) {
          return makeError(
            'MODEL_UNAVAILABLE',
            new Error('Vision model is not available. Download the UI detection model to enable vision capabilities.'),
          );
        }

        const imageBuffer = Buffer.from(args.image, 'base64');
        const result: VisualAnalysisResult = await service.analyzeScreenshot(
          imageBuffer,
          args.width,
          args.height,
        );

        return result;
      } catch (err) {
        return makeError('VISION_ANALYZE_FAILED', err);
      }
    },
  );

  // ── vision:compare ──
  // Requirement 8.1–8.4: Compare two images for visual differences
  ipcMain.handle(
    'vision:compare',
    async (
      _event,
      args: {
        imageA: string;
        widthA: number;
        heightA: number;
        imageB: string;
        widthB: number;
        heightB: number;
        threshold?: number;
      },
    ) => {
      try {
        const service = getVisionService();

        const bufferA = Buffer.from(args.imageA, 'base64');
        const bufferB = Buffer.from(args.imageB, 'base64');

        const result: VisualDiffResult = service.compareImages(
          bufferA,
          args.widthA,
          args.heightA,
          bufferB,
          args.widthB,
          args.heightB,
          args.threshold,
        );

        // Serialize diffImageBuffer to base64 for IPC transport
        const serialized = {
          similarityPercent: result.similarityPercent,
          diffRegions: result.diffRegions,
          isVisuallyDifferent: result.isVisuallyDifferent,
          diffImageBase64: result.diffImageBuffer
            ? result.diffImageBuffer.toString('base64')
            : undefined,
        };

        return serialized;
      } catch (err) {
        return makeError('VISION_COMPARE_FAILED', err);
      }
    },
  );

  // ── vision:diagram ──
  // Requirement 22.1–22.4: Recognize architecture diagram and extract graph structure
  ipcMain.handle(
    'vision:diagram',
    async (
      _event,
      args: { image: string; width: number; height: number },
    ) => {
      try {
        const service = getVisionService();

        if (!service.isModelAvailable()) {
          return makeError(
            'MODEL_UNAVAILABLE',
            new Error('Vision model is not available. Download the UI detection model to enable vision capabilities.'),
          );
        }

        const imageBuffer = Buffer.from(args.image, 'base64');
        const result: DiagramRecognitionResult = await service.recognizeDiagram(
          imageBuffer,
          args.width,
          args.height,
        );

        return result;
      } catch (err) {
        return makeError('VISION_DIAGRAM_FAILED', err);
      }
    },
  );
}
