/**
 * @neuronest/native-fast-worktree — JS loader for the Rust napi-rs worktree module.
 *
 * Provides native-speed git worktree operations for the Ultra execution mode.
 * Attempts to load the platform-specific .node binary. If loading fails,
 * exports stubs so the TypeScript fallback in src/worktree/fast-worktree-engine.ts
 * can take over.
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
  'darwin-arm64': 'native-fast-worktree.darwin-arm64.node',
  'darwin-x64': 'native-fast-worktree.darwin-x64.node',
  'linux-x64': 'native-fast-worktree.linux-x64-gnu.node',
  'linux-arm64': 'native-fast-worktree.linux-arm64-gnu.node',
  'win32-x64': 'native-fast-worktree.win32-x64-msvc.node',
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
    createWorktree() {
      const err = new Error(
        `Native fast-worktree not supported on this platform (${tripleKey}): ${loadError?.message || 'unknown'}`
      );
      err.code = 'NOT_SUPPORTED';
      throw err;
    },
    removeWorktree() {
      const err = new Error(
        `Native fast-worktree not supported on this platform (${tripleKey}): ${loadError?.message || 'unknown'}`
      );
      err.code = 'NOT_SUPPORTED';
      throw err;
    },
    promoteWorktree() {
      const err = new Error(
        `Native fast-worktree not supported on this platform (${tripleKey}): ${loadError?.message || 'unknown'}`
      );
      err.code = 'NOT_SUPPORTED';
      throw err;
    },
    collectGarbage() {
      const err = new Error(
        `Native fast-worktree not supported on this platform (${tripleKey}): ${loadError?.message || 'unknown'}`
      );
      err.code = 'NOT_SUPPORTED';
      throw err;
    },
  };
}
