/**
 * Build readiness pre-check for the Autonomy auto-build step.
 *
 * An npm build script (e.g. CRA's `react-scripts build`, or `vite build`,
 * `next build`, `tsc`) invokes a binary that npm resolves from the project's
 * `node_modules/.bin/`. If dependencies were never installed (or the install
 * aborted), that binary is absent and the build dies with a confusing
 * `sh: <tool>: command not found` and exit code 127.
 *
 * This module inspects the build script BEFORE we run it and reports whether
 * the required tooling is actually present, so the caller can skip the build
 * with an actionable message instead of surfacing a cryptic 127.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BuildReadiness {
  /** True when the build command can run (or when readiness can't be assessed). */
  ready: boolean;
  /** Human-readable explanation when `ready` is false. */
  reason?: string;
  /** The first missing binary, when applicable. */
  missingTool?: string;
}

/**
 * Command prefixes that wrap another command and pass through to it, e.g.
 * `cross-env NODE_ENV=production react-scripts build`. We step over these to
 * reach the real binary.
 */
const SCRIPT_WRAPPERS = new Set([
  'cross-env', 'env', 'npx', 'sudo', 'nice', 'time', 'dotenv', 'concurrently',
]);

/**
 * Commands that do NOT resolve through `node_modules/.bin/` — Node itself,
 * package managers, and common shell builtins/coreutils. A script that only
 * uses these needs no locally-installed build tool.
 */
const NON_BIN_COMMANDS = new Set([
  'node', 'npm', 'yarn', 'pnpm', 'bun', 'deno',
  'echo', 'cd', 'rm', 'mkdir', 'cp', 'mv', 'cat', 'true', 'false', 'exit',
  'set', 'export', 'wait', 'sleep', 'touch', 'test',
]);

/**
 * Extract the package-binary names an npm script invokes.
 *
 * Splits the script on shell operators (`&&`, `||`, `;`, `|`, `&`), then for
 * each segment skips leading `FOO=bar` env assignments and pass-through
 * wrappers, and takes the resulting command token. Tokens that are Node /
 * package-manager / shell commands, or that are file paths (contain a `/` or
 * start with `.`), are ignored — only bare binary names (which npm resolves
 * from `node_modules/.bin/`) are returned.
 *
 * Examples:
 *   'react-scripts build'                  → ['react-scripts']
 *   'tsc -p tsconfig.json && webpack'      → ['tsc', 'webpack']
 *   'cross-env NODE_ENV=prod next build'   → ['next']
 *   'node ./scripts/build.js'              → []
 *   'rimraf dist && tsc'                   → ['rimraf', 'tsc']
 */
export function extractScriptBinaries(script: string): string[] {
  if (typeof script !== 'string' || script.trim() === '') return [];

  const bins: string[] = [];
  const segments = script.split(/&&|\|\||;|\||&/);

  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // Skip leading env-var assignments (FOO=bar) and pass-through wrappers.
    while (
      i < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || SCRIPT_WRAPPERS.has(tokens[i]))
    ) {
      i++;
    }

    const cmd = tokens[i];
    if (!cmd) continue;
    if (NON_BIN_COMMANDS.has(cmd)) continue;
    // File paths (relative, absolute, or nested) are not .bin entries.
    if (cmd.startsWith('.') || cmd.startsWith('/') || cmd.includes('/') || cmd.includes('\\')) continue;

    bins.push(cmd);
  }

  return [...new Set(bins)];
}

/** True when `bin` is resolvable in `<projectDir>/node_modules/.bin/`. */
function binExists(projectDir: string, bin: string): boolean {
  const binDir = path.join(projectDir, 'node_modules', '.bin');
  // On Windows npm creates `<bin>.cmd` / `<bin>.ps1` shims alongside the
  // shell wrapper; accept any of them.
  return (
    fs.existsSync(path.join(binDir, bin)) ||
    fs.existsSync(path.join(binDir, bin + '.cmd')) ||
    fs.existsSync(path.join(binDir, bin + '.ps1'))
  );
}

/**
 * Assess whether `buildCommand` can run in `projectDir`.
 *
 * Only npm-script builds (`npm run <script>`) are inspected — other build
 * systems (`make`, `cargo build`, …) carry their own toolchain expectations
 * and are reported as ready. For npm scripts:
 *
 *   - A script invoking no local binary (e.g. `node build.js`) is ready.
 *   - When the script needs a binary but `node_modules` is absent → NOT ready
 *     (dependencies were never installed).
 *   - When `node_modules` exists but a required binary is missing from
 *     `.bin/` → NOT ready (partial/failed install).
 *
 * Readiness defaults to `true` whenever it cannot be determined (missing or
 * unreadable `package.json`, unrecognised command), so this check never blocks
 * a build it doesn't understand.
 */
export function checkBuildReadiness(projectDir: string, buildCommand: string): BuildReadiness {
  const npmRun = /^npm run (\S+)$/.exec((buildCommand || '').trim());
  if (!npmRun) return { ready: true };

  const scriptName = npmRun[1];
  const pkgPath = path.join(projectDir, 'package.json');

  let scriptBody = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    scriptBody = pkg?.scripts?.[scriptName] ?? '';
  } catch {
    return { ready: true }; // can't read manifest — let the build attempt run
  }

  const bins = extractScriptBinaries(scriptBody);
  if (bins.length === 0) return { ready: true };

  if (!fs.existsSync(path.join(projectDir, 'node_modules'))) {
    return {
      ready: false,
      reason: 'dependencies are not installed (node_modules is missing)',
      missingTool: bins[0],
    };
  }

  for (const bin of bins) {
    if (!binExists(projectDir, bin)) {
      return {
        ready: false,
        reason: 'the build tool "' + bin + '" is not installed (run npm install)',
        missingTool: bin,
      };
    }
  }

  return { ready: true };
}
