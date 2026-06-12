/**
 * Voice Domain IPC Handlers
 *
 * Handles voice-related IPC operations: TTS synthesis, voice configuration,
 * model management, and transcription.
 *
 * Migrated from src/main/ipc.ts — preserves backward-compatible channel names.
 */

import { z } from 'zod';
import type { IPCRegistry } from '../registry.js';

// ─── Request/Response Schemas ───────────────────────────────────

const VoiceTranscribeRequest = z.object({
  audioBase64: z.string().min(1),
});

const VoiceTranscribeResponse = z.object({
  text: z.string().optional(),
  error: z.string().optional(),
});

const VoiceGetConfigResponse = z.object({
  enabled: z.boolean(),
  modelsReady: z.boolean(),
  largeModelsDownloaded: z.boolean(),
  voices: z.array(z.string()),
  voiceStyle: z.string(),
  speed: z.number(),
  provider: z.string().optional(),
});

const VoiceSetConfigRequest = z.object({
  enabled: z.boolean().optional(),
  voiceStyle: z.string().optional(),
  speed: z.number().min(0.1).max(5.0).optional(),
});

const VoiceSetConfigResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const VoiceDownloadModelsResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const VoiceModelsReadyResponse = z.object({
  ready: z.boolean(),
});

const VoiceSynthesizeRequest = z.object({
  text: z.string().min(1),
  voiceStyle: z.string().optional(),
  speed: z.number().optional(),
  lang: z.string().optional(),
});

const VoiceSynthesizeResponse = z.object({
  success: z.boolean(),
  audio: z.string().optional(),
  sampleRate: z.number().optional(),
  text: z.string().optional(),
  useWebSpeech: z.boolean().optional(),
  error: z.string().optional(),
});

const VoiceStopRequest = z.object({}).passthrough();

const VoiceStopResponse = z.object({
  success: z.boolean(),
});

const VoiceGetStatusResponse = z.object({
  active: z.boolean(),
  currentText: z.string().optional(),
  progress: z.number().optional(),
});

const VoiceListVoicesResponse = z.object({
  voices: z.array(z.object({
    id: z.string(),
    name: z.string(),
    gender: z.string().optional(),
    lang: z.string().optional(),
  })),
});

const VoicePreviewRequest = z.object({
  voiceStyle: z.string(),
  speed: z.number().optional(),
});

const VoicePreviewResponse = z.object({
  success: z.boolean(),
  audio: z.string().optional(),
  sampleRate: z.number().optional(),
  useWebSpeech: z.boolean().optional(),
  error: z.string().optional(),
});

// ─── Empty request schema for parameterless handlers ────────────

const EmptyRequest = z.object({}).passthrough();

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register all voice-domain IPC handlers with the registry.
 *
 * Handlers preserve the original channel names from src/main/ipc.ts
 * to maintain backward compatibility with the renderer process.
 */
export function registerVoiceHandlers(registry: IPCRegistry): void {
  // 1. Voice transcription (Whisper API)
  registry.register({
    channel: 'voice:transcribe',
    requestSchema: VoiceTranscribeRequest,
    responseSchema: VoiceTranscribeResponse,
    handler: async (_event, _req) => {
      // Voice transcription would use Whisper API or similar
      return {
        text: '',
        error: 'Voice transcription requires an OpenAI API key with Whisper access. Configure in Settings.',
      };
    },
  });

  // 2. Get voice configuration
  registry.register({
    channel: 'voice:get-config',
    requestSchema: EmptyRequest,
    responseSchema: VoiceGetConfigResponse,
    handler: async (_event, _req) => {
      try {
        const { areModelsReady, areLargeModelsDownloaded, getAvailableVoices } = require('../../voice/tts-engine');
        const modelsReady = areModelsReady();
        const largeModelsDownloaded = areLargeModelsDownloaded();
        const voices: string[] = modelsReady ? getAvailableVoices() : [];
        return {
          enabled: false,
          modelsReady,
          largeModelsDownloaded,
          voices,
          voiceStyle: 'M1',
          speed: 1.05,
          provider: 'supertonic-local',
        };
      } catch {
        return {
          enabled: false,
          modelsReady: false,
          largeModelsDownloaded: false,
          voices: [],
          voiceStyle: 'M1',
          speed: 1.05,
        };
      }
    },
  });

  // 3. Set voice configuration
  registry.register({
    channel: 'voice:set-config',
    requestSchema: VoiceSetConfigRequest,
    responseSchema: VoiceSetConfigResponse,
    handler: async (_event, _req) => {
      try {
        return { success: true };
      } catch {
        return { success: false };
      }
    },
  });

  // 4. Download voice models
  registry.register({
    channel: 'voice:download-models',
    requestSchema: EmptyRequest,
    responseSchema: VoiceDownloadModelsResponse,
    handler: async (_event, _req) => {
      try {
        const { downloadVoiceModels } = require('../../voice/model-downloader');
        const result = await downloadVoiceModels();
        return { success: result };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });

  // 5. Check if voice models are ready
  registry.register({
    channel: 'voice:models-ready',
    requestSchema: EmptyRequest,
    responseSchema: VoiceModelsReadyResponse,
    handler: async (_event, _req) => {
      try {
        const { areModelsReady } = require('../../voice/tts-engine');
        return { ready: areModelsReady() };
      } catch {
        return { ready: false };
      }
    },
  });

  // 6. Synthesize text to speech
  registry.register({
    channel: 'voice:synthesize',
    requestSchema: VoiceSynthesizeRequest,
    responseSchema: VoiceSynthesizeResponse,
    handler: async (_event, req) => {
      try {
        const { stripMarkdownForTTS, getVoiceModelsDir, areModelsReady } = require('../../voice/tts-engine');
        const { SupertonicTTS } = require('../../voice/supertonic-tts');

        let cleanText = stripMarkdownForTTS(req.text);
        if (!cleanText || cleanText.length < 3) {
          return { success: false, error: 'No speakable text' };
        }

        // Truncate long text for TTS
        if (cleanText.length > 800) {
          cleanText = cleanText.slice(0, 800) + '. That is the summary of the response.';
        }

        if (!areModelsReady()) {
          return { success: true, text: cleanText, useWebSpeech: true };
        }

        const modelsDir = getVoiceModelsDir();
        if (!(global as any)._supertonicTTS) {
          (global as any)._supertonicTTS = new SupertonicTTS(modelsDir);
        }

        const voiceStyle = req.voiceStyle || 'M1';
        const speed = req.speed || 1.05;
        const lang = req.lang || 'en';

        const wavBuffer = await (global as any)._supertonicTTS.synthesize(cleanText, lang, voiceStyle, speed, 6);

        return {
          success: true,
          audio: wavBuffer.toString('base64'),
          sampleRate: (global as any)._supertonicTTS.sampleRate,
          useWebSpeech: false,
        };
      } catch (err: any) {
        const { stripMarkdownForTTS } = require('../../voice/tts-engine');
        const cleanText = stripMarkdownForTTS(req.text);
        return { success: true, text: cleanText, useWebSpeech: true };
      }
    },
  });

  // 7. Stop active voice playback
  registry.register({
    channel: 'voice:stop',
    requestSchema: VoiceStopRequest,
    responseSchema: VoiceStopResponse,
    handler: async (_event, _req) => {
      return { success: true };
    },
  });

  // 8. Get current voice playback status
  registry.register({
    channel: 'voice:get-status',
    requestSchema: EmptyRequest,
    responseSchema: VoiceGetStatusResponse,
    handler: async (_event, _req) => {
      return { active: false };
    },
  });

  // 9. List available voice styles
  registry.register({
    channel: 'voice:list-voices',
    requestSchema: EmptyRequest,
    responseSchema: VoiceListVoicesResponse,
    handler: async (_event, _req) => {
      try {
        const { getAvailableVoices } = require('../../voice/tts-engine');
        const voiceIds: string[] = getAvailableVoices();
        return {
          voices: voiceIds.map((id: string) => ({
            id,
            name: id,
            gender: id.startsWith('F') ? 'female' : 'male',
            lang: 'en',
          })),
        };
      } catch {
        return { voices: [] };
      }
    },
  });

  // 10. Preview a voice style with sample text
  registry.register({
    channel: 'voice:preview',
    requestSchema: VoicePreviewRequest,
    responseSchema: VoicePreviewResponse,
    handler: async (_event, req) => {
      try {
        const { areModelsReady, getVoiceModelsDir } = require('../../voice/tts-engine');
        const { SupertonicTTS } = require('../../voice/supertonic-tts');

        if (!areModelsReady()) {
          return { success: true, useWebSpeech: true };
        }

        const modelsDir = getVoiceModelsDir();
        if (!(global as any)._supertonicTTS) {
          (global as any)._supertonicTTS = new SupertonicTTS(modelsDir);
        }

        const sampleText = 'Hello, this is a voice preview.';
        const speed = req.speed || 1.05;
        const wavBuffer = await (global as any)._supertonicTTS.synthesize(sampleText, 'en', req.voiceStyle, speed, 6);

        return {
          success: true,
          audio: wavBuffer.toString('base64'),
          sampleRate: (global as any)._supertonicTTS.sampleRate,
          useWebSpeech: false,
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  });
}
