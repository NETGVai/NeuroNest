/**
 * @neuronest/native-hashline — JS loader for the Rust napi-rs hashline module.
 *
 * Provides content-addressed line hashing (xxhash) and anchor lookup
 * for the anchored_edit tool. Attempts to load the platform-specific
 * .node binary. If loading fails, exports stubs so the TypeScript
 * fallback in src/editing/hashline-engine.ts can take over.
 */

'use strict';

const { existsSync } = require('node:fs');
const { join } = require('node:path');

let nativeBinding = null;
let loadError = null;

// Determine the expected binary name based on platform + arch
const platform = process.platform;
const arch = process.arch;

const triples = {
  'darwin-arm64': 'native-hashline.darwin-arm64.node',
  'darwin-x64': 'native-hashline.darwin-x64.node',
  'linux-x64': 'native-hashline.linux-x64-gnu.node',
  'linux-arm64': 'native-hashline.linux-arm64-gnu.node',
  'win32-x64': 'native-hashline.win32-x64-msvc.node',
};

const tripleKey = `${platform}-${arch}`;
const bindingFile = triples[tripleKey];

if (bindingFile) {
  const bindingPath = join(__dirname, bindingFile);
  if (existsSync(bindingPath)) {
    try {
      nativeBinding = require(bindingPath);
    } catch (e) {
      loadError = e;
    }
  } else {
    loadError = new Error(`Native binding not found: ${bindingPath}`);
  }
} else {
  loadError = new Error(`Unsupported platform: ${tripleKey}`);
}

if (nativeBinding) {
  module.exports = nativeBinding;
} else {
  // Export stubs that indicate the module is not available
  module.exports = {
    __notSupported: true,
    loadError: loadError ? loadError.message : 'Unknown load failure',
    computeLineHashes() {
      const err = new Error(
        `Native hashline not supported on this platform (${tripleKey}): ${loadError?.message || 'unknown'}`
      );
      err.code = 'NOT_SUPPORTED';
      throw err;
    },
    anchorLookup() {
      const err = new Error(
        `Native hashline not supported on this platform (${tripleKey}): ${loadError?.message || 'unknown'}`
      );
      err.code = 'NOT_SUPPORTED';
      throw err;
    },
  };
}
