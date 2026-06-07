/**
 * Voice Model Downloader — Downloads large ONNX model files from configured URLs
 *
 * Downloads vector_estimator.onnx and vocoder.onnx from URLs specified in .env.
 * These files are too large for GitHub and must be hosted separately.
 * Reports progress via callback so the UI can show a download progress bar.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { getVoiceModelsDir } from './tts-engine';

export interface DownloadProgress {
  phase: 'preparing' | 'downloading' | 'verifying' | 'complete' | 'error';
  percent: number;       // 0-100
  bytesDownloaded: number;
  totalBytes: number;
  currentFile: string;
  message: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

interface VoiceModelsManifest {
  version: string;
  files: {
    [filename: string]: { url: string; size?: number; sha256?: string };
  };
}

type ManifestFailureKind = 'network' | 'http' | 'parse' | 'schema';

class ManifestUnreachableError extends Error {
  constructor(public readonly kind: ManifestFailureKind, public readonly cause?: unknown) {
    super(`voice-models manifest unreachable (${kind})`);
    this.name = 'ManifestUnreachableError';
  }
}

const VOICE_MODELS_MANIFEST_URL = 'https://neuronest.cc/versions.json';
const REQUIRED_VOICE_MODEL_FILES = ['text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx'] as const;

/**
 * Module-level cache for the voice-models manifest. Holds the in-flight or
 * resolved Promise for the duration of an app session so concurrent callers
 * share a single network request. Cleared on failure so transient errors do
 * not poison the session — the next call retries.
 */
let _manifestCache: Promise<VoiceModelsManifest> | null = null;

/**
 * Fetch the `voice-models` block from the remote versions manifest.
 *
 * Mirrors the fetch pattern in `src/main/update-checker.ts` (10-second
 * AbortSignal timeout). Validates that all required ONNX file URLs are
 * present and non-empty. Throws `ManifestUnreachableError` with a
 * `kind` discriminator on any failure mode (network, http, parse, schema).
 *
 * The result is cached at module scope for the lifetime of the process.
 * On failure the cache is cleared so subsequent calls retry.
 */
async function fetchManifest(): Promise<VoiceModelsManifest> {
  if (_manifestCache !== null) {
    return _manifestCache;
  }

  _manifestCache = (async (): Promise<VoiceModelsManifest> => {
    let response: Response;
    try {
      response = await fetch(VOICE_MODELS_MANIFEST_URL, { signal: AbortSignal.timeout(10000) });
    } catch (e) {
      throw new ManifestUnreachableError('network', e);
    }

    if (!response.ok) {
      throw new ManifestUnreachableError('http', response.status);
    }

    let json: any;
    try {
      json = await response.json();
    } catch (e) {
      throw new ManifestUnreachableError('parse', e);
    }

    const block = json && json['voice-models'];
    const files = block && block.files;
    for (const filename of REQUIRED_VOICE_MODEL_FILES) {
      const url = files && files[filename] && files[filename].url;
      if (typeof url !== 'string' || url.length === 0) {
        throw new ManifestUnreachableError('schema', null);
      }
    }

    return block as VoiceModelsManifest;
  })();

  // Do not poison the session on transient failure — the next call retries.
  _manifestCache.catch(() => {
    _manifestCache = null;
  });

  return _manifestCache;
}

interface ModelFileSpec {
  filename: string;
  envKey: string;
  destPath: string;
}

/**
 * Get the download URLs from environment variables (dev short-circuit) or
 * the remote `voice-models` manifest. No `.env` filesystem walking — packaged
 * builds rely on the manifest, dev runs rely on env vars.
 *
 * Resolution order:
 *   1. If all three `VOICE_MODEL_*_URL` env vars are set, return them with
 *      no sha256 entries and issue NO network request (Unchanged 3.5).
 *   2. Otherwise, fetch the manifest and return its URLs, with any
 *      individually-set env var taking precedence over the manifest entry.
 *
 * Throws `ManifestUnreachableError` (via `fetchManifest`) when the manifest
 * is unreachable or malformed and at least one URL was missing from the env.
 */
async function getModelUrls(): Promise<{
  textEncoder: string;
  vectorEstimator: string;
  vocoder: string;
  sha256: { [filename: string]: string | undefined };
}> {
  const envText = process.env.VOICE_MODEL_TEXT_ENCODER_URL || '';
  const envVec = process.env.VOICE_MODEL_VECTOR_ESTIMATOR_URL || '';
  const envVoc = process.env.VOICE_MODEL_VOCODER_URL || '';

  if (envText && envVec && envVoc) {
    // Unchanged 3.5: env-var short-circuit, NO network request
    return { textEncoder: envText, vectorEstimator: envVec, vocoder: envVoc, sha256: {} };
  }

  const manifest = await fetchManifest(); // throws ManifestUnreachableError

  return {
    textEncoder: envText || manifest.files['text_encoder.onnx'].url,
    vectorEstimator: envVec || manifest.files['vector_estimator.onnx'].url,
    vocoder: envVoc || manifest.files['vocoder.onnx'].url,
    sha256: {
      'text_encoder.onnx': manifest.files['text_encoder.onnx'].sha256,
      'vector_estimator.onnx': manifest.files['vector_estimator.onnx'].sha256,
      'vocoder.onnx': manifest.files['vocoder.onnx'].sha256,
    },
  };
}

/**
 * Compute the SHA-256 hex digest of a file using a streaming hash so we never
 * load the full ONNX model into memory.
 */
function sha256OfFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(p);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Download a single file with progress tracking. Supports HTTP and HTTPS.
 * Follows redirects (up to 5 hops).
 *
 * Resolves with the path of the on-disk temp file (`<destPath>.downloading`).
 * The caller is responsible for verifying integrity (when applicable) and
 * performing the atomic rename to `destPath`.
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress: (downloaded: number, total: number) => void,
  maxRedirects: number = 5
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!url || url === '') {
      reject(new Error('Download URL not configured.'));
      return;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // Use a temp file to avoid partial downloads being mistaken for complete ones
    const tempPath = destPath + '.downloading';
    const file = fs.createWriteStream(tempPath);
    let downloaded = 0;

    const doRequest = (reqUrl: string, redirectCount: number) => {
      if (redirectCount > maxRedirects) {
        file.close();
        try { fs.unlinkSync(tempPath); } catch {}
        reject(new Error('Too many redirects'));
        return;
      }

      const isHttps = reqUrl.startsWith('https');
      const client = isHttps ? https : http;

      const req = client.get(reqUrl, { headers: { 'User-Agent': 'NeuroNest/1.0' } }, (res) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // Consume response to free up memory
          doRequest(res.headers.location, redirectCount + 1);
          return;
        }

        if (res.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(tempPath); } catch {}
          reject(new Error(`HTTP ${res.statusCode} downloading ${reqUrl}`));
          return;
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          file.write(chunk);
          onProgress(downloaded, total);
        });

        res.on('end', () => {
          file.end(() => {
            // Resolve with the temp path; the caller handles verification + rename.
            resolve(tempPath);
          });
        });

        res.on('error', (err) => {
          file.close();
          try { fs.unlinkSync(tempPath); } catch {}
          reject(err);
        });
      });

      req.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(tempPath); } catch {}
        reject(err);
      });

      // Timeout after 5 minutes per file
      req.setTimeout(300_000, () => {
        req.destroy();
        file.close();
        try { fs.unlinkSync(tempPath); } catch {}
        reject(new Error('Download timed out'));
      });
    };

    doRequest(url, 0);
  });
}

/**
 * Download the large voice model files (vector_estimator + vocoder).
 * Reports progress via callback for UI display.
 */
export async function downloadVoiceModels(onProgress: ProgressCallback): Promise<boolean> {
  const modelsDir = getVoiceModelsDir();

  let urls;
  try {
    urls = await getModelUrls();
  } catch (e) {
    if (e instanceof ManifestUnreachableError) {
      onProgress({
        phase: 'error',
        percent: 0,
        bytesDownloaded: 0,
        totalBytes: 0,
        currentFile: '',
        message:
          'Could not reach update server to fetch voice model URLs. ' +
          'Check your internet connection and try again.',
      });
      return false;
    }
    throw e;
  }

  const files: ModelFileSpec[] = [
    {
      filename: 'text_encoder.onnx',
      envKey: 'VOICE_MODEL_TEXT_ENCODER_URL',
      destPath: path.join(modelsDir, 'onnx', 'text_encoder.onnx'),
    },
    {
      filename: 'vector_estimator.onnx',
      envKey: 'VOICE_MODEL_VECTOR_ESTIMATOR_URL',
      destPath: path.join(modelsDir, 'onnx', 'vector_estimator.onnx'),
    },
    {
      filename: 'vocoder.onnx',
      envKey: 'VOICE_MODEL_VOCODER_URL',
      destPath: path.join(modelsDir, 'onnx', 'vocoder.onnx'),
    },
  ];

  const fileUrls: Record<string, string> = {
    'text_encoder.onnx': urls.textEncoder,
    'vector_estimator.onnx': urls.vectorEstimator,
    'vocoder.onnx': urls.vocoder,
  };

  onProgress({
    phase: 'preparing',
    percent: 0,
    bytesDownloaded: 0,
    totalBytes: 0,
    currentFile: '',
    message: 'Preparing to download voice models...',
  });

  let totalDownloaded = 0;
  // Estimate total size (~342MB)
  const estimatedTotal = 342_000_000;

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = fileUrls[file.filename];

      // Skip if already downloaded (check file size > 1MB to avoid partials)
      try {
        const stat = fs.statSync(file.destPath);
        if (stat.size > 1_000_000) {
          totalDownloaded += stat.size;
          onProgress({
            phase: 'downloading',
            percent: Math.round((totalDownloaded / estimatedTotal) * 100),
            bytesDownloaded: totalDownloaded,
            totalBytes: estimatedTotal,
            currentFile: file.filename,
            message: `${file.filename} already downloaded, skipping...`,
          });
          continue;
        }
      } catch {
        // File doesn't exist, proceed with download
      }

      onProgress({
        phase: 'downloading',
        percent: Math.round((totalDownloaded / estimatedTotal) * 100),
        bytesDownloaded: totalDownloaded,
        totalBytes: estimatedTotal,
        currentFile: file.filename,
        message: `Downloading ${file.filename}...`,
      });

      const tempPath = await downloadFile(url, file.destPath, (downloaded, total) => {
        const currentTotal = totalDownloaded + downloaded;
        const actualTotal = total > 0 ? (totalDownloaded + total + (i < files.length - 1 ? estimatedTotal / 2 : 0)) : estimatedTotal;
        onProgress({
          phase: 'downloading',
          percent: Math.min(99, Math.round((currentTotal / actualTotal) * 100)),
          bytesDownloaded: currentTotal,
          totalBytes: actualTotal,
          currentFile: file.filename,
          message: `Downloading ${file.filename}... (${(downloaded / 1024 / 1024).toFixed(1)} MB)`,
        });
      });

      // Optional sha256 integrity verification. Only emitted when the manifest
      // configured a sha256 for this file; otherwise the legacy event sequence
      // ('preparing' -> 'downloading' -> 'complete') is preserved unchanged.
      const expected = urls.sha256[file.filename];
      if (expected) {
        onProgress({
          phase: 'verifying',
          percent: Math.round((totalDownloaded / estimatedTotal) * 100),
          bytesDownloaded: totalDownloaded,
          totalBytes: estimatedTotal,
          currentFile: file.filename,
          message: `Verifying ${file.filename}...`,
        });
        const actual = await sha256OfFile(tempPath);
        if (actual !== expected) {
          try { fs.unlinkSync(tempPath); } catch {}
          // do NOT renameSync to destPath
          throw new Error(
            `Integrity check failed for ${file.filename}: expected ${expected}, got ${actual}`
          );
        }
      }

      // Atomic rename: move the verified temp file into its final destination.
      try {
        if (fs.existsSync(file.destPath)) fs.unlinkSync(file.destPath);
        fs.renameSync(tempPath, file.destPath);
      } catch (err) {
        try { fs.unlinkSync(tempPath); } catch {}
        throw err;
      }

      // Update total with actual file size
      try {
        const stat = fs.statSync(file.destPath);
        totalDownloaded += stat.size;
      } catch {
        totalDownloaded += estimatedTotal / 2;
      }
    }

    onProgress({
      phase: 'complete',
      percent: 100,
      bytesDownloaded: totalDownloaded,
      totalBytes: totalDownloaded,
      currentFile: '',
      message: 'Voice models downloaded successfully!',
    });

    return true;
  } catch (err: any) {
    onProgress({
      phase: 'error',
      percent: Math.round((totalDownloaded / estimatedTotal) * 100),
      bytesDownloaded: totalDownloaded,
      totalBytes: estimatedTotal,
      currentFile: '',
      message: `Download failed: ${err.message}`,
    });
    return false;
  }
}
