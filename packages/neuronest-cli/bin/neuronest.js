#!/usr/bin/env node
"use strict";

// File: packages/neuronest-cli/bin/neuronest.js (task 9.6)
//
// Thin entrypoint stub for the `neuronest` binary. At install time
// this file is copied (by the `build:bin` step wired into the
// package.json `build` script) to `dist/bin/neuronest.js` — the
// path referenced by `package.json#bin.neuronest`. The same file
// also lives at the source location `bin/neuronest.js`, which is the
// existence target asserted by the smoke test in task 1.3.
//
// Behavior (task 9.6):
//   1. Imports the compiled `dist/cli/main.js`. The relative require
//      path is computed against the *installed* location of this
//      file (`dist/bin/neuronest.js`), where `../cli/main.js`
//      resolves to `dist/cli/main.js`.
//   2. Calls `main(process.argv.slice(2))` — the strict-mode yargs
//      parser built in task 9.5, which returns
//      `Promise<CliExitCode>` resolving to exactly `0`, `1`, or `2`.
//   3. Calls `process.exit(code)` with the resolved exit code.
//
// On a thrown rejection (e.g. an uncaught error inside the parser
// or a subcommand handler that escaped its own exit-code mapping),
// we treat it as exit code 1 and emit a single `fatal:` line to
// stderr — never propagating raw stack traces to the bin surface.
//
// Validates: Requirement 5.1.

const { main } = require("../cli/main.js");

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then(
    function onResolved(code) {
      // CliExitCode is constrained to 0 | 1 | 2; defensively coerce
      // anything non-numeric (or NaN) to 0 so the bin never exits
      // with the implicit Node default of `null` → 0 confusingly.
      const exitCode = typeof code === "number" && Number.isFinite(code) ? code : 0;
      process.exit(exitCode);
    },
    function onRejected(err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String(err.message)
          : String(err);
      process.stderr.write("fatal: " + message + "\n");
      process.exit(1);
    },
  );
