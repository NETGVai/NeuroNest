/**
 * Embedding Worker Thread
 *
 * Runs in a separate thread via `worker_threads`. Handles embedding requests
 * by communicating with the configured embedding provider (ollama, openai, or local).
 *
 * Communicates with the main thread via message passing:
 * - Receives: 'init', 'embed', 'embedBatch', 'health' messages
 * - Sends: 'ready', 'result', 'error', 'health' responses
 *
 * Reports memory usage periodically and unloads the model if memory limit is exceeded.
 */

import { parentPort, workerData } from 'node:worker_threads';
import http from 'node:http';
import https from 'node:https';

interface WorkerConfig {
  model: string;
  provider: 'ollama' | 'openai' | 'mistral' | 'gemini' | 'local';
  endpoint: string;
  maxMemoryMB: number;
  apiKey?: string;
  dimensions?: number;
}

interface WorkerMessage {
  type: 'embed' | 'embedBatch' | 'health' | 'init';
  id: string;
  payload?: any;
}

interface WorkerResponse {
  type: 'result' | 'error' | 'health' | 'ready';
  id: string;
  payload?: any;
  error?: string;
}

let config: WorkerConfig = workerData as WorkerConfig;
let modelLoaded = false;
let healthInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Send a response back to the main thread.
 */
function respond(msg: WorkerResponse): void {
  parentPort?.postMessage(msg);
}

/**
 * Get current memory usage in MB.
 */
function getMemoryUsageMB(): number {
  const usage = process.memoryUsage();
  return Math.round((usage.heapUsed + usage.external) / (1024 * 1024));
}

/**
 * Check if memory usage exceeds the configured limit.
 */
function isMemoryExceeded(): boolean {
  return getMemoryUsageMB() > config.maxMemoryMB;
}

/**
 * Make an HTTP request to the embedding provider.
 */
function httpRequest(url: string, body: string, headers?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...headers,
    };

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: reqHeaders,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Generate embeddings using Ollama API.
 */
async function embedWithOllama(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (const text of texts) {
    const body = JSON.stringify({
      model: config.model,
      prompt: text,
    });

    const response = await httpRequest(`${config.endpoint}/api/embeddings`, body);
    const parsed = JSON.parse(response) as { embedding: number[] };
    results.push(parsed.embedding);
  }

  return results;
}

/**
 * Generate embeddings using OpenAI-compatible API.
 */
async function embedWithOpenAI(texts: string[]): Promise<number[][]> {
  const body = JSON.stringify({
    model: config.model,
    input: texts,
  });

  const headers: Record<string, string> = {};
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const response = await httpRequest(`${config.endpoint}/v1/embeddings`, body, headers);
  const parsed = JSON.parse(response) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  // Sort by index to maintain order
  const sorted = parsed.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

/**
 * Generate embeddings using Mistral API (OpenAI-compatible format).
 */
async function embedWithMistral(texts: string[]): Promise<number[][]> {
  const body = JSON.stringify({
    model: config.model,
    input: texts,
  });

  const headers: Record<string, string> = {};
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const response = await httpRequest(`${config.endpoint}/v1/embeddings`, body, headers);
  const parsed = JSON.parse(response) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  const sorted = parsed.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

/**
 * Generate embeddings using Google Gemini API.
 */
async function embedWithGemini(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (const text of texts) {
    const body = JSON.stringify({
      content: { parts: [{ text }] },
    });

    // Gemini uses API key as query param
    const url = `${config.endpoint}/v1beta/models/${config.model}:embedContent?key=${config.apiKey || ''}`;
    const response = await httpRequest(url, body);
    const parsed = JSON.parse(response) as { embedding: { values: number[] } };
    results.push(parsed.embedding.values);
  }

  return results;
}

/**
 * Generate embeddings using a local model (placeholder for future implementation).
 * Generates deterministic pseudo-embeddings based on text content.
 */
function embedWithLocal(texts: string[]): number[][] {
  // Local embedding: generate a deterministic vector from text hash
  // This is a placeholder that produces consistent vectors for the same input
  return texts.map((text) => {
    const dimensions = 384; // Default dimensions
    const vector: number[] = new Array(dimensions);

    // Simple deterministic hash-based embedding for local mode
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    for (let i = 0; i < dimensions; i++) {
      // Generate pseudo-random but deterministic values
      hash = ((hash << 13) ^ hash) | 0;
      hash = (hash * 0x5bd1e995) | 0;
      hash = (hash ^ (hash >> 15)) | 0;
      vector[i] = (hash & 0xffff) / 0xffff * 2 - 1; // Normalize to [-1, 1]
    }

    // Normalize to unit vector
    let magnitude = 0;
    for (let i = 0; i < dimensions; i++) {
      magnitude += vector[i]! * vector[i]!;
    }
    magnitude = Math.sqrt(magnitude);
    if (magnitude > 0) {
      for (let i = 0; i < dimensions; i++) {
        vector[i] = vector[i]! / magnitude;
      }
    }

    return vector;
  });
}

/**
 * Known embedding model name patterns per provider (ordered by preference).
 */
const EMBEDDING_PATTERNS: Record<string, RegExp[]> = {
  ollama: [/nomic-embed/i, /mxbai-embed/i, /all-minilm/i, /snowflake-arctic-embed/i, /embed/i],
  openai: [/text-embedding-3-small/i, /text-embedding-3-large/i, /text-embedding-ada/i, /embedding/i],
  mistral: [/mistral-embed/i, /embed/i],
  gemini: [/text-embedding/i, /embedding/i],
};

/**
 * Auto-detect the best available embedding model from the configured provider.
 * Queries the provider's model list endpoint and picks the first match.
 */
async function autoDetectEmbeddingModel(): Promise<string | null> {
  const patterns = EMBEDDING_PATTERNS[config.provider];
  if (!patterns) return null;

  let models: string[] = [];

  try {
    if (config.provider === 'ollama') {
      // Ollama: GET /api/tags → { models: [{ name: "..." }] }
      const resp = await httpGet(`${config.endpoint}/api/tags`);
      const data = JSON.parse(resp) as { models?: Array<{ name: string }> };
      models = (data.models || []).map(m => m.name);
    } else if (config.provider === 'openai' || config.provider === 'mistral') {
      // OpenAI/Mistral: GET /v1/models → { data: [{ id: "..." }] }
      const headers: Record<string, string> = {};
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
      const resp = await httpGetWithHeaders(`${config.endpoint}/v1/models`, headers);
      const data = JSON.parse(resp) as { data?: Array<{ id: string }> };
      models = (data.data || []).map(m => m.id);
    } else if (config.provider === 'gemini') {
      // Gemini: GET /v1beta/models?key=... → { models: [{ name: "models/..." }] }
      const resp = await httpGet(`${config.endpoint}/v1beta/models?key=${config.apiKey || ''}`);
      const data = JSON.parse(resp) as { models?: Array<{ name: string }> };
      models = (data.models || []).map(m => m.name.replace('models/', ''));
    }
  } catch {
    return null;
  }

  if (models.length === 0) return null;

  // Find the first model matching our embedding patterns
  for (const pattern of patterns) {
    const match = models.find(m => pattern.test(m));
    if (match) return match;
  }

  return null;
}

/**
 * Simple HTTP GET request (no auth).
 */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const req = client.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * HTTP GET with custom headers.
 */
function httpGetWithHeaders(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
      timeout: 10000,
    };
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

/**
 * Generate embeddings using the configured provider.
 */
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (isMemoryExceeded()) {
    throw new Error(
      `Memory limit exceeded: ${getMemoryUsageMB()}MB > ${config.maxMemoryMB}MB`
    );
  }

  switch (config.provider) {
    case 'ollama':
      return embedWithOllama(texts);
    case 'openai':
      return embedWithOpenAI(texts);
    case 'mistral':
      return embedWithMistral(texts);
    case 'gemini':
      return embedWithGemini(texts);
    case 'local':
      return embedWithLocal(texts);
    default:
      throw new Error(`Unsupported embedding provider: ${String(config.provider)}`);
  }
}

/**
 * Handle incoming messages from the main thread.
 */
async function handleMessage(msg: WorkerMessage): Promise<void> {
  switch (msg.type) {
    case 'init': {
      const payload = msg.payload as Partial<WorkerConfig> | undefined;
      if (payload) {
        config = { ...config, ...payload };
      }

      // Auto-detect embedding model if not specified or set to 'auto'
      if (!config.model || config.model === 'auto') {
        try {
          const detected = await autoDetectEmbeddingModel();
          if (detected) {
            config.model = detected;
          }
        } catch {
          // Fall back to provider defaults if detection fails
          const defaults: Record<string, string> = {
            ollama: 'nomic-embed-text',
            openai: 'text-embedding-3-small',
            mistral: 'mistral-embed',
            gemini: 'text-embedding-004',
          };
          config.model = defaults[config.provider] || 'nomic-embed-text';
        }
      }

      modelLoaded = true;
      respond({ type: 'ready', id: msg.id, payload: { model: config.model } });
      break;
    }

    case 'embed': {
      try {
        const payload = msg.payload as { text: string };
        const startTime = Date.now();
        const vectors = await generateEmbeddings([payload.text]);
        const durationMs = Date.now() - startTime;
        respond({
          type: 'result',
          id: msg.id,
          payload: { vector: vectors[0], durationMs },
        });
      } catch (err: any) {
        respond({
          type: 'error',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'embedBatch': {
      try {
        const payload = msg.payload as { texts: string[] };
        const startTime = Date.now();
        const vectors = await generateEmbeddings(payload.texts);
        const durationMs = Date.now() - startTime;
        respond({
          type: 'result',
          id: msg.id,
          payload: { vectors, durationMs },
        });
      } catch (err: any) {
        respond({
          type: 'error',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'health': {
      respond({
        type: 'health',
        id: msg.id,
        payload: {
          modelLoaded,
          memoryUsageMB: getMemoryUsageMB(),
        },
      });
      break;
    }
  }
}

// Set up message handler
parentPort?.on('message', (msg: WorkerMessage) => {
  handleMessage(msg).catch((err: any) => {
    respond({
      type: 'error',
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

// Periodically report health to main thread
healthInterval = setInterval(() => {
  respond({
    type: 'health',
    id: 'periodic-health',
    payload: {
      modelLoaded,
      memoryUsageMB: getMemoryUsageMB(),
    },
  });
}, 10_000); // Every 10 seconds

// Clean up on exit
process.on('exit', () => {
  if (healthInterval) {
    clearInterval(healthInterval);
  }
});
