/**
 * Supertonic TTS Engine — On-device text-to-speech using ONNX Runtime
 *
 * Drives the on-device TTS inference pipeline over the bundled ONNX voice
 * models to provide speech synthesis entirely on-device. No cloud API calls,
 * no privacy concerns.
 *
 * Models are stored in ~/.neuronest/voice-models/. Small model files are
 * bundled with the app and copied on first run. Large files (vector_estimator,
 * vocoder) are downloaded from URLs configured in .env.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface TTSConfig {
  voiceStyle: string;  // e.g., 'M1', 'F1'
  speed: number;       // 0.8 - 1.5
  language: string;    // e.g., 'en', 'ko', 'es'
  totalSteps: number;  // denoising steps (higher = better quality, slower)
}

export interface TTSResult {
  audio: Buffer;       // 16-bit PCM WAV data
  duration: number;    // seconds
  sampleRate: number;  // typically 22050
}

const DEFAULT_CONFIG: TTSConfig = {
  voiceStyle: 'M1',
  speed: 1.05,
  language: 'en',
  totalSteps: 8,
};

// Files bundled with the app (small enough for GitHub — under 5MB each)
const BUNDLED_FILES = [
  'onnx/tts.json',
  'onnx/unicode_indexer.json',
  'onnx/duration_predictor.onnx',
  'voice_styles/M1.json',
  'voice_styles/M2.json',
  'voice_styles/M3.json',
  'voice_styles/M4.json',
  'voice_styles/M5.json',
  'voice_styles/F1.json',
  'voice_styles/F2.json',
  'voice_styles/F3.json',
  'voice_styles/F4.json',
  'voice_styles/F5.json',
];

// Large files that must be downloaded separately (too large for GitHub/bundling)
const DOWNLOADABLE_FILES = [
  'onnx/text_encoder.onnx',
  'onnx/vector_estimator.onnx',
  'onnx/vocoder.onnx',
];

/**
 * Get the user-home voice models directory.
 * This is the single source of truth for all model files at runtime.
 * Bundled small files are copied here on app startup via ensureBundledFilesCopied().
 * Large files (vector_estimator.onnx, vocoder.onnx) are downloaded here on user demand.
 */
export function getVoiceModelsDir(): string {
  return path.join(os.homedir(), '.neuronest', 'voice-models');
}

/**
 * Get the bundled assets path (where small files ship with the app).
 */
export function getBundledModelsDir(): string {
  // Development: dist/voice/tts-engine.js → ../../assets/voice-models
  const devPath = path.resolve(__dirname, '..', '..', 'assets', 'voice-models');
  if (fs.existsSync(path.join(devPath, 'onnx', 'tts.json'))) {
    return devPath;
  }
  // Packaged app: asar archive (small files are read-only but readable from asar)
  const asarPath = path.join(process.resourcesPath || '', 'app.asar', 'assets', 'voice-models');
  if (fs.existsSync(path.join(asarPath, 'onnx', 'tts.json'))) {
    return asarPath;
  }
  // Packaged app: asar unpacked (legacy path)
  const unpackedPath = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', 'voice-models');
  if (fs.existsSync(path.join(unpackedPath, 'onnx', 'tts.json'))) {
    return unpackedPath;
  }
  return devPath;
}

/**
 * Ensure bundled (small) model files are copied to the user-home directory.
 * Called on app startup. Skips files that already exist.
 */
export function ensureBundledFilesCopied(): void {
  const bundledDir = getBundledModelsDir();
  const targetDir = getVoiceModelsDir();

  // Create target directories
  fs.mkdirSync(path.join(targetDir, 'onnx'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'voice_styles'), { recursive: true });

  for (const file of BUNDLED_FILES) {
    const src = path.join(bundledDir, file);
    const dst = path.join(targetDir, file);
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dst);
      } catch (err) {
        console.warn(`[Voice] Failed to copy ${file}:`, (err as Error).message);
      }
    }
  }
}

/**
 * Check if the large downloadable model files are present.
 */
export function areLargeModelsDownloaded(): boolean {
  const modelsDir = getVoiceModelsDir();
  return DOWNLOADABLE_FILES.every(f => {
    const filePath = path.join(modelsDir, f);
    try {
      // Check file exists and is not a partial download (> 1MB)
      const stat = fs.statSync(filePath);
      return stat.size > 1_000_000;
    } catch {
      return false;
    }
  });
}

/**
 * Check if ALL TTS models are ready (bundled + downloaded).
 */
export function areModelsReady(): boolean {
  try {
    const modelsDir = getVoiceModelsDir();
    const allRequired = ['onnx/tts.json', 'onnx/duration_predictor.onnx', ...DOWNLOADABLE_FILES];
    return allRequired.every(f => fs.existsSync(path.join(modelsDir, f)));
  } catch {
    return false;
  }
}

/**
 * Get available voice styles from the models directory.
 */
export function getAvailableVoices(): string[] {
  const voiceStylesDir = path.join(getVoiceModelsDir(), 'voice_styles');
  try {
    if (!fs.existsSync(voiceStylesDir)) return [];
    return fs.readdirSync(voiceStylesDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * Chunk text into sentences for streaming TTS.
 */
export function chunkText(text: string, maxChars: number = 300): string[] {
  if (text.length <= maxChars) return [text];

  const sentences: string[] = [];
  const parts = text.split(/(?<=[.!?])\s+/);

  let current = '';
  for (const part of parts) {
    if (current.length + part.length + 1 > maxChars && current.length > 0) {
      sentences.push(current.trim());
      current = part;
    } else {
      current += (current ? ' ' : '') + part;
    }
  }
  if (current.trim()) {
    sentences.push(current.trim());
  }

  return sentences;
}

/**
 * Strip markdown formatting from text before sending to TTS.
 */
export function stripMarkdownForTTS(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
