// SSL.com eSigner CodeSignTool wrapper for electron-builder's `win.sign` hook.
//
// electron-builder calls this once per Windows binary it produces (installer,
// portable exe, nupkg auto-updater files). The script delegates to
// CodeSignTool, which talks to SSL.com's HSM-backed cloud signing service.
//
// Required env vars (set in CI as secrets):
//   ESIGNER_USERNAME       SSL.com account username
//   ESIGNER_PASSWORD       SSL.com account password
//   ESIGNER_CREDENTIAL_ID  Credential ID for the EV cert in eSigner
//   ESIGNER_TOTP_SECRET    OAuth TOTP secret for automated signing
//
// Optional env vars:
//   ESIGNER_ENVIRONMENT    "PROD" (default) or "TEST" for demo cert
//   CODESIGNTOOL_DIR       Override the CodeSignTool install dir (auto-cached otherwise)
//   ESIGNER_SKIP           If "1", skip signing entirely and exit 0 (for unsigned local dev builds)
//
// CodeSignTool is downloaded once per runner from SSL.com's official URL and
// cached under ~/.codesigntool. Set CODESIGNTOOL_DIR to use a pre-staged copy.

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODESIGNTOOL_VERSION = '1.3.2';
const CODESIGNTOOL_URL_WIN =
  'https://github.com/SSLcom/CodeSignTool/releases/download/v1.3.2/CodeSignTool-v1.3.2-windows.zip';
const CODESIGNTOOL_URL_NIX =
  'https://github.com/SSLcom/CodeSignTool/releases/download/v1.3.2/CodeSignTool-v1.3.2.zip';

function log(...args) {
  console.log('[sign-windows]', ...args);
}

function fail(msg) {
  console.error('[sign-windows] ERROR:', msg);
  process.exit(1);
}

function ensureCodeSignTool() {
  if (process.env.CODESIGNTOOL_DIR) {
    const dir = process.env.CODESIGNTOOL_DIR;
    if (!fs.existsSync(dir)) fail(`CODESIGNTOOL_DIR points to missing path: ${dir}`);
    return dir;
  }

  const cacheRoot = path.join(os.homedir(), '.codesigntool');
  const isWin = process.platform === 'win32';
  const launcher = isWin ? 'CodeSignTool.bat' : 'CodeSignTool.sh';

  // Check common extracted folder names
  const candidates = [
    `CodeSignTool-v${CODESIGNTOOL_VERSION}`,
    `CodeSignTool-v${CODESIGNTOOL_VERSION}-windows`,
    'CodeSignTool',
  ];

  // Check if launcher is directly in cacheRoot (flat extraction)
  if (fs.existsSync(path.join(cacheRoot, launcher))) return cacheRoot;

  for (const candidate of candidates) {
    const candidatePath = path.join(cacheRoot, candidate);
    if (fs.existsSync(path.join(candidatePath, launcher))) return candidatePath;
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  const url = isWin ? CODESIGNTOOL_URL_WIN : CODESIGNTOOL_URL_NIX;
  const zipPath = path.join(cacheRoot, 'CodeSignTool.zip');

  log('Downloading CodeSignTool from', url);
  if (isWin) {
    execSync(
      `powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}' -UseBasicParsing"`,
      { stdio: 'inherit' },
    );
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${cacheRoot}' -Force"`,
      { stdio: 'inherit' },
    );
  } else {
    execSync(`curl -sSL -o "${zipPath}" "${url}"`, { stdio: 'inherit' });
    execSync(`unzip -q -o "${zipPath}" -d "${cacheRoot}"`, { stdio: 'inherit' });
  }
  fs.unlinkSync(zipPath);

  // Find the extracted directory containing the launcher
  // First check if the launcher is directly in cacheRoot (no subfolder)
  if (fs.existsSync(path.join(cacheRoot, launcher))) {
    if (!isWin && fs.existsSync(path.join(cacheRoot, 'CodeSignTool.sh'))) {
      execSync(`chmod +x "${path.join(cacheRoot, 'CodeSignTool.sh')}"`, { stdio: 'inherit' });
    }
    return cacheRoot;
  }

  let installDir = null;
  for (const candidate of candidates) {
    const candidatePath = path.join(cacheRoot, candidate);
    if (fs.existsSync(path.join(candidatePath, launcher))) {
      installDir = candidatePath;
      break;
    }
  }

  // Fallback: scan cacheRoot for any directory containing the launcher
  if (!installDir) {
    const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidatePath = path.join(cacheRoot, entry.name);
        if (fs.existsSync(path.join(candidatePath, launcher))) {
          installDir = candidatePath;
          break;
        }
      }
    }
  }

  if (!installDir) {
    // Log what was actually extracted for debugging
    const extracted = fs.readdirSync(cacheRoot);
    fail(`CodeSignTool launcher (${launcher}) not found in any subdirectory of ${cacheRoot}. Contents: ${extracted.join(', ')}`);
  }

  if (!isWin && fs.existsSync(path.join(installDir, 'CodeSignTool.sh'))) {
    execSync(`chmod +x "${path.join(installDir, 'CodeSignTool.sh')}"`, { stdio: 'inherit' });
  }

  return installDir;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function signOne(installDir, inputFile) {
  const isWin = process.platform === 'win32';
  const launcher = path.join(installDir, isWin ? 'CodeSignTool.bat' : 'CodeSignTool.sh');

  const args = [
    'sign',
    `-username=${process.env.ESIGNER_USERNAME}`,
    `-password=${process.env.ESIGNER_PASSWORD}`,
    `-credential_id=${process.env.ESIGNER_CREDENTIAL_ID}`,
    `-totp_secret=${process.env.ESIGNER_TOTP_SECRET}`,
    `-input_file_path=${inputFile}`,
    '-override=true',
  ];

  log('Signing', path.basename(inputFile));
  // CodeSignTool spawns Java; pipe stdio so the runner shows progress.
  // On Windows, .bat files must be run through cmd.exe (shell: true).
  // Credentials are passed via args array; we redact them from logs.
  const result = spawnSync(launcher, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: installDir,
    shell: isWin,
  });

  const redact = (buf) =>
    String(buf || '')
      .replace(new RegExp(escapeRegExp(process.env.ESIGNER_PASSWORD || ''), 'g'), '***')
      .replace(new RegExp(escapeRegExp(process.env.ESIGNER_TOTP_SECRET || ''), 'g'), '***');
  if (result.stdout && result.stdout.length) process.stdout.write(redact(result.stdout));
  if (result.stderr && result.stderr.length) process.stderr.write(redact(result.stderr));

  if (result.status !== 0) {
    fail(`CodeSignTool exited ${result.status} for ${inputFile}`);
  }
}

function requireEnv(name) {
  if (!process.env[name] || process.env[name].length === 0) {
    fail(`Missing required env var: ${name}`);
  }
}

// electron-builder loads this with require() and calls the export per file.
// Signature: function(configuration: { path: string, ... }): Promise<void>
module.exports = async function sign(configuration) {
  if (process.env.ESIGNER_SKIP === '1') {
    log('ESIGNER_SKIP=1 — skipping signing for', path.basename(configuration.path));
    return;
  }

  for (const v of ['ESIGNER_USERNAME', 'ESIGNER_PASSWORD', 'ESIGNER_CREDENTIAL_ID', 'ESIGNER_TOTP_SECRET']) {
    requireEnv(v);
  }

  const inputFile = configuration.path;
  if (!inputFile || !fs.existsSync(inputFile)) {
    fail(`Input file not found: ${inputFile}`);
  }

  const installDir = ensureCodeSignTool();
  signOne(installDir, inputFile);
  log('Signed:', path.basename(inputFile));
};
