/**
 * Voice Module — On-device TTS powered by Supertonic
 */

export {
  getVoiceModelsDir,
  getBundledModelsDir,
  ensureBundledFilesCopied,
  areLargeModelsDownloaded,
  areModelsReady,
  getAvailableVoices,
  chunkText,
  stripMarkdownForTTS,
} from './tts-engine';
export type { TTSConfig, TTSResult } from './tts-engine';
export { downloadVoiceModels } from './model-downloader';
export type { DownloadProgress, ProgressCallback } from './model-downloader';
export {
  TTSUtilityProcessManager,
  getTTSProcessManager,
  disposeTTSProcessManager,
} from './tts-utility-process';
export type { TTSSynthesizeRequest, ProcessHealth, TTSProcessManager } from './tts-utility-process';
