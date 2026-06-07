/**
 * Supertonic TTS — ONNX-based on-device text-to-speech synthesis
 *
 * Runs inference on the bundled Supertonic ONNX voice models via
 * onnxruntime-node, entirely on-device.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ort from 'onnxruntime-node';

// ─── Types ──────────────────────────────────────────────────────

interface TTSConfig {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}

interface Style {
  ttl: ort.Tensor;
  dp: ort.Tensor;
}

// ─── Utility Functions ──────────────────────────────────────────

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

function arrayToTensor(array: any, dims: number[]): ort.Tensor {
  const flat = Array.isArray(array) ? array.flat(Infinity) : [array];
  return new ort.Tensor('float32', Float32Array.from(flat), dims);
}

function intArrayToTensor(array: number[][], dims: number[]): ort.Tensor {
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

// ─── Unicode Processor ──────────────────────────────────────────

class UnicodeProcessor {
  private indexer: Record<number, number>;

  constructor(indexerPath: string) {
    this.indexer = JSON.parse(fs.readFileSync(indexerPath, 'utf8'));
  }

  private preprocess(text: string, lang: string): string {
    let t = text.normalize('NFKD');
    // Remove emojis
    t = t.replace(/[\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}]+/gu, '');
    // Replace dashes and symbols
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

// ─── SupertonicTTS Class ────────────────────────────────────────

export class SupertonicTTS {
  private cfgs: TTSConfig;
  private textProcessor: UnicodeProcessor;
  private dpSession!: ort.InferenceSession;
  private textEncSession!: ort.InferenceSession;
  private vectorEstSession!: ort.InferenceSession;
  private vocoderSession!: ort.InferenceSession;
  private modelsLoaded = false;
  private modelsDir: string;

  public sampleRate: number;

  constructor(modelsDir: string) {
    this.modelsDir = modelsDir;
    const cfgPath = path.join(modelsDir, 'onnx', 'tts.json');
    this.cfgs = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    this.sampleRate = this.cfgs.ae.sample_rate;
    const indexerPath = path.join(modelsDir, 'onnx', 'unicode_indexer.json');
    this.textProcessor = new UnicodeProcessor(indexerPath);
  }

  async loadModels(): Promise<void> {
    if (this.modelsLoaded) return;
    const onnxDir = path.join(this.modelsDir, 'onnx');
    const opts: ort.InferenceSession.SessionOptions = {};

    console.log('[SupertonicTTS] Loading ONNX models from:', onnxDir);
    const start = Date.now();

    [this.dpSession, this.textEncSession, this.vectorEstSession, this.vocoderSession] = await Promise.all([
      ort.InferenceSession.create(path.join(onnxDir, 'duration_predictor.onnx'), opts),
      ort.InferenceSession.create(path.join(onnxDir, 'text_encoder.onnx'), opts),
      ort.InferenceSession.create(path.join(onnxDir, 'vector_estimator.onnx'), opts),
      ort.InferenceSession.create(path.join(onnxDir, 'vocoder.onnx'), opts),
    ]);

    this.modelsLoaded = true;
    console.log('[SupertonicTTS] Models loaded in', Date.now() - start, 'ms');
  }

  loadVoiceStyle(styleName: string): Style {
    const stylePath = path.join(this.modelsDir, 'voice_styles', styleName + '.json');
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

  async synthesize(text: string, lang: string = 'en', styleName: string = 'M1', speed: number = 1.05, totalSteps: number = 6): Promise<Buffer> {
    await this.loadModels();

    const style = this.loadVoiceStyle(styleName);
    const chunks = chunkTextForTTS(text, 300);
    let wavCat: number[] = [];

    for (const chunk of chunks) {
      const wav = await this.inferSingle(chunk, lang, style, totalSteps, speed);
      if (wavCat.length > 0) {
        // Add 0.3s silence between chunks
        const silence = new Array(Math.floor(0.3 * this.sampleRate)).fill(0);
        wavCat = [...wavCat, ...silence, ...wav];
      } else {
        wavCat = wav;
      }
    }

    // Convert to 16-bit PCM WAV buffer
    return this.toWavBuffer(wavCat);
  }

  private async inferSingle(text: string, lang: string, style: Style, totalStep: number, speed: number): Promise<number[]> {
    const { textIds, textMask } = this.textProcessor.call([text], [lang]);
    const bsz = 1;
    const textIdsShape = [bsz, textIds[0].length];
    const textMaskShape = [bsz, 1, textMask[0][0].length];

    const textMaskTensor = arrayToTensor(textMask, textMaskShape);

    // Duration prediction
    const dpResult = await this.dpSession.run({
      text_ids: intArrayToTensor(textIds, textIdsShape),
      style_dp: style.dp,
      text_mask: textMaskTensor,
    });
    const duration = Array.from(dpResult.duration.data as Float32Array).map(d => (d as number) / speed);

    // Text encoding
    const textEncResult = await this.textEncSession.run({
      text_ids: intArrayToTensor(textIds, textIdsShape),
      style_ttl: style.ttl,
      text_mask: textMaskTensor,
    });

    // Sample noisy latent
    const wavLenMax = Math.max(...duration) * this.sampleRate;
    const wavLengths = duration.map(d => Math.floor(d * this.sampleRate));
    const chunkSize = this.cfgs.ae.base_chunk_size * this.cfgs.ttl.chunk_compress_factor;
    const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
    const latentDim = this.cfgs.ttl.latent_dim * this.cfgs.ttl.chunk_compress_factor;

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

    const latentMask = getLatentMask(wavLengths, this.cfgs.ae.base_chunk_size, this.cfgs.ttl.chunk_compress_factor);
    // Apply mask
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
      const vectorEstResult = await this.vectorEstSession.run({
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
    const vocoderResult = await this.vocoderSession.run({
      latent: arrayToTensor(noisyLatent, latentShape),
    });

    return Array.from(vocoderResult.wav_tts.data as Float32Array);
  }

  private toWavBuffer(audioData: number[]): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = this.sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = audioData.length * bitsPerSample / 8;

    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(this.sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < audioData.length; i++) {
      const sample = Math.max(-1, Math.min(1, audioData[i]));
      buffer.writeInt16LE(Math.floor(sample * 32767), 44 + i * 2);
    }

    return buffer;
  }
}
