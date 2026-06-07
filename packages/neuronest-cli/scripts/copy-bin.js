#!/usr/bin/env node
"use strict";

// File: packages/neuronest-cli/scripts/copy-bin.js (task 9.6)
//
// Post-tsc step that copies `bin/neuronest.js` to `dist/bin/neuronest.js`
// and chmods it +x. The copy is required because `tsc` only transpiles
// files under `src/`, and `package.json#bin.neuronest` points at
// `./dist/bin/neuronest.js`. The smoke test in task 1.3 asserts both
// the source `bin/neuronest.js` existence and the
// `pkg.bin.neuronest === './dist/bin/neuronest.js'` mapping; this
// script is what makes that mapping resolvable after `npm run build`.

const fs = require("fs");
const path = require("path");

const packageDir = path.resolve(__dirname, "..");
const srcBin = path.join(packageDir, "bin", "neuronest.js");
const dstDir = path.join(packageDir, "dist", "bin");
const dstBin = path.join(dstDir, "neuronest.js");

if (!fs.existsSync(srcBin)) {
  process.stderr.write(
    "copy-bin: source bin file missing at " + srcBin + "\n",
  );
  process.exit(1);
}

fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(srcBin, dstBin);
// 0o755 — owner rwx, group/world rx; matches typical npm bin install mode.
fs.chmodSync(dstBin, 0o755);
