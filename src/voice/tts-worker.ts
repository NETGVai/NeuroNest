/**
 * TTS Worker — Runs inside an Electron utilityProcess
 *
 * This file is the entry point for the utility process that performs
 * ONNX-based TTS inference in its own V8 isolate, keeping the main
 * event loop free of heavy computation.
 *
 * Communication:
 *   - Receives TTSWorkerProtocol messages via parentPort (MessagePort)
 *   - Sends TTSWorkerResponse messages back via the same port
 *   - Audio buffers are transferred (zero-copy) using the transfer list
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ─── Protocol Types ─────────────────────────────────────────────

export interface TTSWorkerProtocol {
  type: 'synthesize' | 'health-check' | 'shutdown';
  id?: string;
  payload?: { text: string; voiceStyle: string; speed: number; lang?: string; totalSteps?: number };
}

export interface TTSWorkerResponse {
  type: 'audio' | 'error' | 'ready' | 'health';
  id?: string;
  buffer?: ArrayBuffer;
  sampleRate?: number;
  error?: string;
}

// ─── ONNX Inference Engine (self-contained in worker) ───────────

let ort: typeof import('onnxruntime-node');
let modelsLoaded = false;
let dpSession: any;
let textEncSession: any;
let vectorEstSession: any;
let vocoderSession: any;
let sampleRate: number = 22050;
let cfgs: { ae: { sample_rate: number; base_chunk_size: number }; ttl: { chunk_compress_factor: number; latent_dim: number } };
let textProcessor: UnicodeProcessor;

class UnicodeProcessor {
  private indexer: Record<number, number>;

  constructor(indexerPath: string) {
    this.indexer = JSON.parse(fs.readFileSync(indexerPath, 'utf8'));
  }

  private preprocess(text: string, lang: string): string {
    let t = text.normalize('NFKD');
    t = t.replace(/[\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}]+/gu, '');
    t = t.replace(/[–‑—]/g, '-').replace(/_/g, ' ').replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019´`]/g, "'");
    t = t.replace(/[♥☆♡©\\[\]|/#→←]/g, ' ');
    t = t.replace(/@/g, ' at ');
    t = t.replace(/ ([,.\!\?;:])/g, '$1');
    t = t.replace(/\s+/g, ' ').trim();
    if (!/[.!?;:,'")\]}…]$/.test(t)) t += '.';
    return `<${lang}>` + t + `</${lang}>`;
  }

  call(textList: string[], langList: string[]): { textIds: number[][]; textMask: number[][][] } {
    const processed = textList.map((t, i) => this.preprocess(t, langList[i]));
    const lengths = processed.map(t => t.length);
    const maxLen = Math.max(...lengths);

    const textIds: number[][] = processed.map(t => {
      const row = new Array(maxLen).fill(0);
      const chars = Array.from(t);
      for (let j = 0; j < chars.length; j++) {
        const code = chars[j].charCodeAt(0);
        row[j] = this.indexer[code] || 0;
      }
      return row;
    });

    const textMask = lengthToMask(lengths);
    return { textIds, textMask };
  }
}

function lengthToMask(lengths: number[], maxLen?: number): number[][][] {
  const ml = maxLen || Math.max(...lengths);
  return lengths.map(len => {
    const row: number[] = [];
    for (let j = 0; j < ml; j++) row.push(j < len ? 1.0 : 0.0);
    return [row];
  });
}

function getLatentMask(wavLengths: number[], baseChunkSize: number, chunkCompressFactor: number): number[][][] {
  const latentSize = baseChunkSize * chunkCompressFactor;
  const latentLengths = wavLengths.map(len => Math.floor((len + latentSize - 1) / latentSize));
  return lengthToMask(latentLengths);
}

function arrayToTensor(array: any, dims: number[]): any {
  const flat = Array.isArray(array) ? array.flat(Infinity) : [array];
  return new ort.Tensor('float32', Float32Array.from(flat), dims);
}

function intArrayToTensor(array: number[][], dims: number[]): any {
  const flat = array.flat(Infinity) as number[];
  return new ort.Tensor('int64', BigInt64Array.from(flat.map(x => BigInt(x))), dims);
}

function chunkTextForTTS(text: string, maxLen: number = 300): string[] {
  if (text.length <= maxLen) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function getVoiceModelsDir(): string {
  return path.join(os.homedir(), '.neuronest', 'voice-models');
}

async function loadModels(): Promise<void> {
  if (modelsLoaded) return;

  ort = require('onnxruntime-node');

  const modelsDir = getVoiceModelsDir();
  const cfgPath = path.join(modelsDir, 'onnx', 'tts.json');
  cfgs = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  sampleRate = cfgs.ae.sample_rate;

  const indexerPath = path.join(modelsDir, 'onnx', 'unicode_indexer.json');
  textProcessor = new UnicodeProcessor(indexerPath);

  const onnxDir = path.join(modelsDir, 'onnx');
  const opts = {};

  [dpSession, textEncSession, vectorEstSession, vocoderSession] = await Promise.all([
    ort.InferenceSession.create(path.join(onnxDir, 'duration_predictor.onnx'), opts),
    ort.InferenceSession.create(path.join(onnxDir, 'text_encoder.onnx'), opts),
    ort.InferenceSession.create(path.join(onnxDir, 'vector_estimator.onnx'), opts),
    ort.InferenceSession.create(path.join(onnxDir, 'vocoder.onnx'), opts),
  ]);

  modelsLoaded = true;
}

function loadVoiceStyle(styleName: string): { ttl: any; dp: any } {
  const modelsDir = getVoiceModelsDir();
  const stylePath = path.join(modelsDir, 'voice_styles', styleName + '.json');
  const data = JSON.parse(fs.readFileSync(stylePath, 'utf8'));

  const ttlDims = data.style_ttl.dims;
  const dpDims = data.style_dp.dims;
  const ttlFlat = Float32Array.from(data.style_ttl.data.flat(Infinity));
  const dpFlat = Float32Array.from(data.style_dp.data.flat(Infinity));

  return {
    ttl: new ort.Tensor('float32', ttlFlat, ttlDims),
    dp: new ort.Tensor('float32', dpFlat, dpDims),
  };
}

async function inferSingle(
  text: string,
  lang: string,
  style: { ttl: any; dp: any },
  totalStep: number,
  speed: number,
): Promise<number[]> {
  const { textIds, textMask } = textProcessor.call([text], [lang]);
  const bsz = 1;
  const textIdsShape = [bsz, textIds[0].length];
  const textMaskShape = [bsz, 1, textMask[0][0].length];
  const textMaskTensor = arrayToTensor(textMask, textMaskShape);

  // Duration prediction
  const dpResult = await dpSession.run({
    text_ids: intArrayToTensor(textIds, textIdsShape),
    style_dp: style.dp,
    text_mask: textMaskTensor,
  });
  const duration = Array.from(dpResult.duration.data as Float32Array).map(d => (d as number) / speed);

  // Text encoding
  const textEncResult = await textEncSession.run({
    text_ids: intArrayToTensor(textIds, textIdsShape),
    style_ttl: style.ttl,
    text_mask: textMaskTensor,
  });

  // Sample noisy latent
  // Duration predictor outputs duration per character in units of audio chunks
  // (each chunk = base_chunk_size samples). Multiply by base_chunk_size to get
  // wav lengths in samples. NOT by sampleRate (which would be ~86x too large).
  const wavLenMax = Math.max(...duration) * cfgs.ae.base_chunk_size;
  const wavLengths = duration.map(d => Math.floor(d * cfgs.ae.base_chunk_size));
  const chunkSize = cfgs.ae.base_chunk_size * cfgs.ttl.chunk_compress_factor;
  const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
  const latentDim = cfgs.ttl.latent_dim * cfgs.ttl.chunk_compress_factor;

  let noisyLatent: number[][][] = [[]];
  for (let d = 0; d < latentDim; d++) {
    const row: number[] = [];
    for (let t = 0; t < latentLen; t++) {
      const u1 = Math.max(1e-10, Math.random());
      const u2 = Math.random();
      row.push(Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2));
    }
    noisyLatent[0].push(row);
  }

  const latentMask = getLatentMask(wavLengths, cfgs.ae.base_chunk_size, cfgs.ttl.chunk_compress_factor);
  for (let d = 0; d < noisyLatent[0].length; d++) {
    for (let t = 0; t < noisyLatent[0][d].length; t++) {
      noisyLatent[0][d][t] *= latentMask[0][0][t];
    }
  }

  const latentShape = [bsz, latentDim, latentLen];
  const latentMaskShape = [bsz, 1, latentMask[0][0].length];
  const latentMaskTensor = arrayToTensor(latentMask, latentMaskShape);
  const scalarShape = [bsz];

  // Denoising loop
  for (let step = 0; step < totalStep; step++) {
    const vectorEstResult = await vectorEstSession.run({
      noisy_latent: arrayToTensor(noisyLatent, latentShape),
      text_emb: textEncResult.text_emb,
      style_ttl: style.ttl,
      text_mask: textMaskTensor,
      latent_mask: latentMaskTensor,
      total_step: arrayToTensor([totalStep], scalarShape),
      current_step: arrayToTensor([step], scalarShape),
    });

    const denoised = Array.from(vectorEstResult.denoised_latent.data as Float32Array);
    let idx = 0;
    for (let d = 0; d < noisyLatent[0].length; d++) {
      for (let t = 0; t < noisyLatent[0][d].length; t++) {
        noisyLatent[0][d][t] = denoised[idx++];
      }
    }
  }

  // Vocoder
  const vocoderResult = await vocoderSession.run({
    latent: arrayToTensor(noisyLatent, latentShape),
  });

  return Array.from(vocoderResult.wav_tts.data as Float32Array);
}

async function synthesize(
  text: string,
  lang: string,
  voiceStyle: string,
  speed: number,
  totalSteps: number,
): Promise<{ buffer: ArrayBuffer; sampleRate: number }> {
  await loadModels();

  const style = loadVoiceStyle(voiceStyle);
  const chunks = chunkTextForTTS(text, 300);
  let wavCat: number[] = [];

  for (const chunk of chunks) {
    const wav = await inferSingle(chunk, lang, style, totalSteps, speed);
    if (wavCat.length > 0) {
      const silence = new Array(Math.floor(0.3 * sampleRate)).fill(0);
      wavCat = [...wavCat, ...silence, ...wav];
    } else {
      wavCat = wav;
    }
  }

  // Convert to 16-bit PCM WAV as ArrayBuffer (transferable)
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = wavCat.length * bitsPerSample / 8;
  const headerSize = 44;

  const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuffer);

  // WAV header
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM samples
  for (let i = 0; i < wavCat.length; i++) {
    const sample = Math.max(-1, Math.min(1, wavCat[i]));
    view.setInt16(headerSize + i * 2, Math.floor(sample * 32767), true);
  }

  return { buffer: arrayBuffer, sampleRate };
}

// ─── Message Handler ────────────────────────────────────────────

function sendResponse(port: any, response: TTSWorkerResponse, transfer?: ArrayBuffer[]): void {
  if (transfer && transfer.length > 0) {
    port.postMessage(response, transfer as any);
  } else {
    port.postMessage(response);
  }
}

async function handleMessage(port: any, msg: TTSWorkerProtocol): Promise<void> {
  switch (msg.type) {
    case 'health-check': {
      sendResponse(port, { type: 'health', id: msg.id });
      break;
    }

    case 'synthesize': {
      if (!msg.payload) {
        sendResponse(port, { type: 'error', id: msg.id, error: 'Missing payload' });
        return;
      }
      const { text, voiceStyle, speed, lang, totalSteps } = msg.payload;
      try {
        const result = await synthesize(
          text,
          lang || 'en',
          voiceStyle || 'M1',
          speed || 1.05,
          totalSteps || 6,
        );
        // Transfer the ArrayBuffer (zero-copy)
        sendResponse(
          port,
          { type: 'audio', id: msg.id, buffer: result.buffer, sampleRate: result.sampleRate },
          [result.buffer],
        );
      } catch (err: any) {
        sendResponse(port, { type: 'error', id: msg.id, error: err.message || 'Synthesis failed' });
      }
      break;
    }

    case 'shutdown': {
      process.exit(0);
      break;
    }

    default: {
      sendResponse(port, { type: 'error', id: msg.id, error: `Unknown message type: ${(msg as any).type}` });
    }
  }
}

// ─── Process Entry Point ────────────────────────────────────────

function main(): void {
  // In Electron's utilityProcess, parentPort is available for communication
  const parentPort = (process as any).parentPort;
  if (!parentPort) {
    console.error('[TTS Worker] No parentPort available. Must run as utilityProcess.');
    process.exit(1);
  }

  // Listen for MessagePort delivery from the main process
  parentPort.on('message', (event: { data: any; ports: any[] }) => {
    if (event.ports && event.ports.length > 0) {
      // Main process sent us a MessagePort for communication.
      // In Electron's utilityProcess, ports are MessagePortMain instances
      // which use EventEmitter-style .on() rather than DOM addEventListener.
      const port = event.ports[0] as any;
      port.on('message', (msgEvent: { data: TTSWorkerProtocol }) => {
        handleMessage(port, msgEvent.data).catch((err: any) => {
          sendResponse(port, { type: 'error', error: err.message || 'Unhandled error' });
        });
      });
      port.start();

      // Signal readiness
      sendResponse(port, { type: 'ready' });
    }
  });

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (err) => {
    console.error('[TTS Worker] Uncaught exception:', err.message);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[TTS Worker] Unhandled rejection:', reason);
    process.exit(1);
  });
}

main();
