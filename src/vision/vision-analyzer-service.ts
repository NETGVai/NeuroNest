/**
 * Vision Analyzer Service — ONNX-based image analysis for UI detection,
 * visual diff, and diagram recognition.
 *
 * Follows the same ONNX model loading patterns as `src/voice/tts-engine.ts`:
 * - Models stored in ~/.neuronest/vision-models/
 * - Graceful degradation when model files are not present
 * - Status reporting via getModelInfo()
 *
 * Registers tools in ToolSystem:
 * - vision-analyze: Analyze a screenshot to detect UI components
 * - vision-compare: Compare two images for visual differences
 * - vision-diagram: Recognize architecture diagrams
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 8.1, 8.2, 8.3, 22.1, 22.2, 22.4
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import type {
  DetectedComponent,
  VisualAnalysisResult,
  VisualDiffResult,
  DiagramRecognitionResult,
  BoundingBox,
} from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';
import { preprocessImage, MAX_DIMENSION } from './image-preprocessor.js';
import { comparePixelData, DEFAULT_THRESHOLD } from './visual-diff.js';
import { generateMermaidSource, isValidGraphStructure } from './mermaid-generator.js';
import type { ToolSystem } from '../tools/tool-system.js';
import type { ToolContext, ToolResult } from '../shared/types.js';

// ─── Constants ──────────────────────────────────────────────────

const MODEL_VERSION = '1.0.0';
const MODEL_FILENAME = 'ui_detection.onnx';
const VISION_MODELS_DIR_NAME = 'vision-models';
const MIN_CONFIDENCE_THRESHOLD = 0.6;

// ─── Model Info ─────────────────────────────────────────────────

export type ModelStatus = 'ready' | 'missing' | 'downloading';

export interface ModelInfo {
  path: string;
  version: string;
  status: ModelStatus;
}

// ─── ONNX Session (lazy-loaded) ────────────────────────────────

let onnxSession: unknown | null = null;
let modelStatus: ModelStatus = 'missing';

/**
 * Get the directory where vision models are stored.
 * Follows the same pattern as voice models: ~/.neuronest/vision-models/
 */
export function getVisionModelsDir(): string {
  return path.join(os.homedir(), '.neuronest', VISION_MODELS_DIR_NAME);
}

/**
 * Get the full path to the ONNX model file.
 */
export function getModelPath(): string {
  return path.join(getVisionModelsDir(), MODEL_FILENAME);
}

/**
 * Check if the ONNX model file is available on disk.
 */
function checkModelAvailability(): boolean {
  try {
    const modelPath = getModelPath();
    const stat = fs.statSync(modelPath);
    // Model file must be at least 1MB to be considered valid (not a partial download)
    return stat.size > 1_000_000;
  } catch {
    return false;
  }
}

/**
 * Attempt to load the ONNX model session.
 * Uses dynamic import for onnxruntime-node to avoid hard crashes when not available.
 */
async function loadOnnxSession(): Promise<boolean> {
  if (onnxSession) return true;

  const modelPath = getModelPath();
  if (!checkModelAvailability()) {
    modelStatus = 'missing';
    return false;
  }

  try {
    // Dynamic import — follows same pattern as TTS engine
    const ort = await import('onnxruntime-node');
    onnxSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });
    modelStatus = 'ready';
    return true;
  } catch (err) {
    console.warn('[Vision] Failed to load ONNX model:', (err as Error).message);
    modelStatus = 'missing';
    return false;
  }
}

/**
 * Throw a FeatureError when the vision model is not available.
 */
function throwModelUnavailable(): never {
  throw new FeatureError({
    message: 'Vision model is not available. Download the UI detection model to enable vision capabilities.',
    category: 'vision',
    code: 'MODEL_UNAVAILABLE',
    details: {
      modelPath: getModelPath(),
      status: modelStatus,
      downloadInstructions: 'Place the ui_detection.onnx model file in ~/.neuronest/vision-models/',
    },
  });
}

// ─── VisionAnalyzerService ──────────────────────────────────────

export class VisionAnalyzerService {
  private _modelChecked = false;

  /**
   * Check if the ONNX model is available for use.
   */
  isModelAvailable(): boolean {
    if (!this._modelChecked) {
      modelStatus = checkModelAvailability() ? 'ready' : 'missing';
      this._modelChecked = true;
    }
    return modelStatus === 'ready';
  }

  /**
   * Get information about the model status.
   */
  getModelInfo(): ModelInfo {
    if (!this._modelChecked) {
      this.isModelAvailable();
    }
    return {
      path: getModelPath(),
      version: MODEL_VERSION,
      status: modelStatus,
    };
  }

  /**
   * Analyze a screenshot image to detect UI components.
   *
   * @param image - Raw RGBA pixel buffer of the image
   * @param width - Image width in pixels
   * @param height - Image height in pixels
   * @returns Structured analysis result with detected components
   */
  async analyzeScreenshot(
    image: Buffer,
    width: number,
    height: number,
  ): Promise<VisualAnalysisResult> {
    if (!this.isModelAvailable()) {
      throwModelUnavailable();
    }

    const startTime = Date.now();

    // Preprocess: downscale if needed
    const processed = preprocessImage(image, width, height, MAX_DIMENSION);

    // Load ONNX session if not already loaded
    const loaded = await loadOnnxSession();
    if (!loaded) {
      throwModelUnavailable();
    }

    // Run inference through ONNX model
    const components = await this.runDetection(processed.data, processed.width, processed.height);

    const processingTimeMs = Date.now() - startTime;

    return {
      components,
      imageSize: { width: processed.width, height: processed.height },
      processingTimeMs,
    };
  }

  /**
   * Compare two images for visual differences.
   *
   * Properties:
   * - Comparing A with itself yields 100% similarity
   * - Symmetry: compare(A, B).similarityPercent === compare(B, A).similarityPercent
   * - isVisuallyDifferent = true iff (100 - similarityPercent) > threshold
   *
   * @param imageA - Raw RGBA pixel buffer of image A
   * @param widthA - Width of image A
   * @param heightA - Height of image A
   * @param imageB - Raw RGBA pixel buffer of image B
   * @param widthB - Width of image B
   * @param heightB - Height of image B
   * @param threshold - Difference threshold percentage (default 5%)
   * @returns Visual diff result
   */
  compareImages(
    imageA: Buffer,
    widthA: number,
    heightA: number,
    imageB: Buffer,
    widthB: number,
    heightB: number,
    threshold: number = DEFAULT_THRESHOLD,
  ): VisualDiffResult {
    return comparePixelData(imageA, widthA, heightA, imageB, widthB, heightB, threshold);
  }

  /**
   * Recognize an architecture diagram and extract graph structure.
   *
   * @param image - Raw RGBA pixel buffer of the diagram
   * @param width - Image width
   * @param height - Image height
   * @returns Diagram recognition result with nodes, edges, and Mermaid source
   */
  async recognizeDiagram(
    image: Buffer,
    width: number,
    height: number,
  ): Promise<DiagramRecognitionResult> {
    if (!this.isModelAvailable()) {
      throwModelUnavailable();
    }

    // Preprocess: downscale if needed
    const processed = preprocessImage(image, width, height, MAX_DIMENSION);

    // Load ONNX session if not already loaded
    const loaded = await loadOnnxSession();
    if (!loaded) {
      throwModelUnavailable();
    }

    // Run diagram detection
    const result = await this.runDiagramDetection(processed.data, processed.width, processed.height);

    // Check confidence threshold (Requirement 22.4)
    if (result.confidence < MIN_CONFIDENCE_THRESHOLD) {
      throw new FeatureError({
        message: `Image quality insufficient for reliable diagram extraction. Average confidence: ${(result.confidence * 100).toFixed(1)}% (minimum required: ${MIN_CONFIDENCE_THRESHOLD * 100}%)`,
        category: 'vision',
        code: 'LOW_CONFIDENCE',
        details: {
          confidence: result.confidence,
          threshold: MIN_CONFIDENCE_THRESHOLD,
          suggestion: 'Provide a higher resolution image with clearer labels and connections.',
        },
      });
    }

    // Generate Mermaid representation if graph is valid
    const graph = { nodes: result.nodes, edges: result.edges };
    if (isValidGraphStructure(graph)) {
      result.mermaidSource = generateMermaidSource(graph);
    }

    return result;
  }

  /**
   * Run the ONNX UI detection model on preprocessed image data.
   * Returns detected components with bounding boxes and confidence scores.
   */
  private async runDetection(
    pixelData: Buffer,
    width: number,
    height: number,
  ): Promise<DetectedComponent[]> {
    try {
      const ort = await import('onnxruntime-node');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = onnxSession as any;

      // Create input tensor from pixel data (normalized float32)
      const floatData = new Float32Array(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        // RGB channels normalized to [0, 1]
        floatData[i * 3] = (pixelData[i * 4] ?? 0) / 255.0;
        floatData[i * 3 + 1] = (pixelData[i * 4 + 1] ?? 0) / 255.0;
        floatData[i * 3 + 2] = (pixelData[i * 4 + 2] ?? 0) / 255.0;
      }

      const inputTensor = new ort.Tensor('float32', floatData, [1, 3, height, width]);

      const inputName: string = session.inputNames[0] ?? 'images';
      const results = await session.run({ [inputName]: inputTensor });

      // Parse model output into detected components
      return this.parseDetectionOutput(results, width, height);
    } catch (err) {
      throw new FeatureError({
        message: `Vision model inference failed: ${(err as Error).message}`,
        category: 'vision',
        code: 'INFERENCE_ERROR',
        details: { width, height },
      });
    }
  }

  /**
   * Parse raw ONNX model output into structured DetectedComponent array.
   */
  private parseDetectionOutput(
    results: Record<string, unknown>,
    imageWidth: number,
    imageHeight: number,
  ): DetectedComponent[] {
    const components: DetectedComponent[] = [];

    // Component type mapping for UI detection model
    const typeMap: Record<number, string> = {
      0: 'button',
      1: 'input',
      2: 'text',
      3: 'image',
      4: 'navigation',
      5: 'card',
      6: 'header',
      7: 'footer',
      8: 'sidebar',
      9: 'modal',
    };

    // Extract output tensor — format depends on model
    const outputKey = Object.keys(results)[0];
    if (!outputKey) return components;

    const output = results[outputKey] as { data?: Float32Array; dims?: number[] } | undefined;
    if (!output?.data || !output?.dims) return components;

    // Typical YOLO-style output: [batch, num_detections, 6] (x, y, w, h, confidence, class)
    const numDetections = output.dims[1] ?? 0;
    const stride = output.dims[2] ?? 6;

    for (let i = 0; i < numDetections; i++) {
      const offset = i * stride;
      const confidence = output.data[offset + 4] ?? 0;

      if (confidence < 0.3) continue; // Filter low-confidence detections

      const cx = (output.data[offset] ?? 0) * imageWidth;
      const cy = (output.data[offset + 1] ?? 0) * imageHeight;
      const w = (output.data[offset + 2] ?? 0) * imageWidth;
      const h = (output.data[offset + 3] ?? 0) * imageHeight;
      const classId = Math.round(output.data[offset + 5] ?? 0);

      components.push({
        type: typeMap[classId] ?? 'unknown',
        boundingBox: {
          x: Math.round(cx - w / 2),
          y: Math.round(cy - h / 2),
          width: Math.round(w),
          height: Math.round(h),
        },
        confidence,
      });
    }

    return components;
  }

  /**
   * Run diagram detection and extract graph structure.
   */
  private async runDiagramDetection(
    pixelData: Buffer,
    width: number,
    height: number,
  ): Promise<DiagramRecognitionResult> {
    // Similar to runDetection, but specifically looks for:
    // - Labeled boxes (nodes)
    // - Arrows/lines (edges)
    // - Text labels (OCR)

    try {
      const ort = await import('onnxruntime-node');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = onnxSession as any;

      const floatData = new Float32Array(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        floatData[i * 3] = (pixelData[i * 4] ?? 0) / 255.0;
        floatData[i * 3 + 1] = (pixelData[i * 4 + 1] ?? 0) / 255.0;
        floatData[i * 3 + 2] = (pixelData[i * 4 + 2] ?? 0) / 255.0;
      }

      const inputTensor = new ort.Tensor('float32', floatData, [1, 3, height, width]);
      const inputName: string = session.inputNames[0] ?? 'images';
      const results = await session.run({ [inputName]: inputTensor });

      return this.parseDiagramOutput(results, width, height);
    } catch (err) {
      throw new FeatureError({
        message: `Diagram recognition failed: ${(err as Error).message}`,
        category: 'vision',
        code: 'DIAGRAM_INFERENCE_ERROR',
        details: { width, height },
      });
    }
  }

  /**
   * Parse ONNX output into diagram nodes and edges.
   */
  private parseDiagramOutput(
    results: Record<string, unknown>,
    imageWidth: number,
    imageHeight: number,
  ): DiagramRecognitionResult {
    const nodes: DiagramRecognitionResult['nodes'] = [];
    const edges: DiagramRecognitionResult['edges'] = [];
    let totalConfidence = 0;

    const outputKey = Object.keys(results)[0];
    if (!outputKey) {
      return { nodes, edges, confidence: 0 };
    }

    const output = results[outputKey] as { data?: Float32Array; dims?: number[] } | undefined;
    if (!output?.data || !output?.dims) {
      return { nodes, edges, confidence: 0 };
    }

    // Parse detections — boxes are nodes, arrows are edges
    const numDetections = output.dims[1] ?? 0;
    const stride = output.dims[2] ?? 7;

    let nodeCount = 0;
    const detectedNodes: Array<{ id: string; label: string; bounds: BoundingBox; confidence: number }> = [];

    for (let i = 0; i < numDetections; i++) {
      const offset = i * stride;
      const confidence = output.data[offset + 4] ?? 0;
      if (confidence < 0.3) continue;

      const classId = Math.round(output.data[offset + 5] ?? 0);
      const cx = (output.data[offset] ?? 0) * imageWidth;
      const cy = (output.data[offset + 1] ?? 0) * imageHeight;
      const w = (output.data[offset + 2] ?? 0) * imageWidth;
      const h = (output.data[offset + 3] ?? 0) * imageHeight;

      totalConfidence += confidence;

      if (classId === 0) {
        // Box/node detection
        nodeCount++;
        const label = `Node_${nodeCount}`;
        detectedNodes.push({
          id: `node_${nodeCount}`,
          label,
          bounds: {
            x: Math.round(cx - w / 2),
            y: Math.round(cy - h / 2),
            width: Math.round(w),
            height: Math.round(h),
          },
          confidence,
        });
      }
    }

    // Build nodes
    for (const dn of detectedNodes) {
      nodes.push({
        id: dn.id,
        label: dn.label,
        bounds: dn.bounds,
      });
    }

    // Infer edges from spatial proximity of arrow detections
    // (simplified — full implementation would use arrow endpoint detection)
    for (let i = 0; i < detectedNodes.length - 1; i++) {
      const fromNode = detectedNodes[i];
      const toNode = detectedNodes[i + 1];
      if (fromNode && toNode) {
        edges.push({
          from: fromNode.id,
          to: toNode.id,
        });
      }
    }

    const elementCount = nodes.length + edges.length;
    const avgConfidence = elementCount > 0 ? totalConfidence / elementCount : 0;

    return {
      nodes,
      edges,
      confidence: avgConfidence,
    };
  }
}

// ─── Tool Registration ──────────────────────────────────────────

/**
 * Register vision analysis tools with the ToolSystem.
 * Called during application startup.
 */
export function registerVisionTools(toolSystem: ToolSystem, service: VisionAnalyzerService): void {
  // vision-analyze tool
  toolSystem.register({
    id: 'vision-analyze',
    name: 'Vision Analyze',
    description: 'Analyze a screenshot image to detect UI components (buttons, inputs, text, images, navigation, cards) with bounding box coordinates and confidence scores.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Base64-encoded RGBA image data' },
        width: { type: 'number', description: 'Image width in pixels' },
        height: { type: 'number', description: 'Image height in pixels' },
      },
      required: ['image', 'width', 'height'],
    },
    riskLevel: 'read-only',
    execute: async (input: unknown, _context: ToolContext): Promise<ToolResult> => {
      try {
        const { image, width, height } = input as { image: string; width: number; height: number };
        const imageBuffer = Buffer.from(image, 'base64');
        const result = await service.analyzeScreenshot(imageBuffer, width, height);
        return { success: true, output: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: message };
      }
    },
  });

  // vision-compare tool
  toolSystem.register({
    id: 'vision-compare',
    name: 'Vision Compare',
    description: 'Compare two images pixel-by-pixel to detect visual differences, compute similarity percentage, and identify differing regions.',
    inputSchema: {
      type: 'object',
      properties: {
        imageA: { type: 'string', description: 'Base64-encoded RGBA data for image A' },
        widthA: { type: 'number', description: 'Width of image A' },
        heightA: { type: 'number', description: 'Height of image A' },
        imageB: { type: 'string', description: 'Base64-encoded RGBA data for image B' },
        widthB: { type: 'number', description: 'Width of image B' },
        heightB: { type: 'number', description: 'Height of image B' },
        threshold: { type: 'number', description: 'Difference threshold percentage (default 5%)' },
      },
      required: ['imageA', 'widthA', 'heightA', 'imageB', 'widthB', 'heightB'],
    },
    riskLevel: 'read-only',
    execute: async (input: unknown, _context: ToolContext): Promise<ToolResult> => {
      try {
        const {
          imageA, widthA, heightA,
          imageB, widthB, heightB,
          threshold,
        } = input as {
          imageA: string; widthA: number; heightA: number;
          imageB: string; widthB: number; heightB: number;
          threshold?: number;
        };

        const bufferA = Buffer.from(imageA, 'base64');
        const bufferB = Buffer.from(imageB, 'base64');

        const result = service.compareImages(
          bufferA, widthA, heightA,
          bufferB, widthB, heightB,
          threshold,
        );

        return { success: true, output: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: message };
      }
    },
  });

  // vision-diagram tool
  toolSystem.register({
    id: 'vision-diagram',
    name: 'Vision Diagram',
    description: 'Recognize an architecture diagram or flowchart image, extract nodes and edges, and generate Mermaid diagram source.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Base64-encoded RGBA image data' },
        width: { type: 'number', description: 'Image width in pixels' },
        height: { type: 'number', description: 'Image height in pixels' },
      },
      required: ['image', 'width', 'height'],
    },
    riskLevel: 'read-only',
    execute: async (input: unknown, _context: ToolContext): Promise<ToolResult> => {
      try {
        const { image, width, height } = input as { image: string; width: number; height: number };
        const imageBuffer = Buffer.from(image, 'base64');
        const result = await service.recognizeDiagram(imageBuffer, width, height);
        return { success: true, output: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: message };
      }
    },
  });
}
