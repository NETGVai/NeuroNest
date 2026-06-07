/**
 * Global type declarations for NeuroNest
 */

import type { SupertonicTTS } from './voice/supertonic-tts';

declare global {
  namespace NodeJS {
    interface Global {
      _supertonicTTS?: SupertonicTTS;
    }
  }

  // eslint-disable-next-line no-var
  var _supertonicTTS: SupertonicTTS | undefined;
}

export {};
