/**
 * OllamaManager — Detects, starts, and monitors Ollama on the local system.
 * Ollama must be installed separately (brew install ollama or from ollama.com).
 * This manager auto-starts it when NeuroNest launches and stops it on quit.
 */

import { execSync, execFileSync, spawn, ChildProcess } from 'node:child_process';
import * as http from 'node:http';

const OLLAMA_PORT = 11434;
const OLLAMA_URL = 'http://localhost:' + OLLAMA_PORT;

let ollamaProcess: ChildProcess | null = null;
let ollamaRunning = false;

// ─── Homebrew dependency management ─────────────────────────────

/** Check if Homebrew is installed */
function isHomebrewInstalled(): boolean {
  try {
    execFileSync('which', ['brew'], { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install Homebrew silently. Uses the official install script.
 * This is non-interactive on macOS — it will prompt for sudo password via system dialog.
 */
async function ensureHomebrew(onProgress?: (msg: string) => void): Promise<boolean> {
  if (isHomebrewInstalled()) return true;

  onProgress?.('Homebrew not found. Installing Homebrew...');
  try {
    // The official Homebrew install script — runs non-interactively with NONINTERACTIVE=1
    execSync(
      'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      {
        timeout: 300000, // 5 minutes max
        encoding: 'utf-8',
        stdio: 'pipe',
        env: { ...process.env, NONINTERACTIVE: '1' },
      },
    );

    // On Apple Silicon, Homebrew installs to /opt/homebrew — add to PATH
    if (process.arch === 'arm64') {
      try {
        execSync('eval "$(/opt/homebrew/bin/brew shellenv)"', { shell: '/bin/bash', timeout: 5000 });
      } catch {}
      // Also update current process PATH
      process.env.PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:' + (process.env.PATH || '');
    }

    if (isHomebrewInstalled()) {
      onProgress?.('Homebrew installed successfully!');
      return true;
    }

    onProgress?.('Homebrew install script ran but brew not found in PATH');
    return false;
  } catch (e: any) {
    onProgress?.('Homebrew installation failed: ' + (e.message || '').slice(0, 150));
    // Try adding common Homebrew paths to PATH in case it installed but isn't in PATH
    const brewPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'];
    for (const p of brewPaths) {
      if (!process.env.PATH?.includes(p)) {
        process.env.PATH = p + ':' + (process.env.PATH || '');
      }
    }
    return isHomebrewInstalled();
  }
}

/** Check if Ollama binary is installed on the system */
export function isOllamaInstalled(): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['ollama'], { encoding: 'utf-8', timeout: 5000 });
    return result.trim().length > 0;
  } catch {
    // On Windows, also check common install locations
    if (process.platform === 'win32') {
      const fs = require('node:fs');
      const paths = [
        (process.env.LOCALAPPDATA || '') + '\\Programs\\Ollama\\ollama.exe',
        'C:\\Program Files\\Ollama\\ollama.exe',
        (process.env.USERPROFILE || '') + '\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
      ];
      for (const p of paths) {
        try { if (p && fs.existsSync(p)) return true; } catch {}
      }
    }
    return false;
  }
}

/** Check if Ollama server is already running */
export function isOllamaRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(OLLAMA_URL + '/api/tags', { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Start Ollama server as a background process */
export async function startOllama(): Promise<{ started: boolean; message: string }> {
  if (!isOllamaInstalled()) {
    return { started: false, message: 'Ollama is not installed. Install from https://ollama.com or run: brew install ollama' };
  }

  const running = await isOllamaRunning();
  if (running) {
    ollamaRunning = true;
    console.log('[Ollama] Already running on port ' + OLLAMA_PORT);
    return { started: true, message: 'Ollama already running on port ' + OLLAMA_PORT };
  }

  try {
    console.log('[Ollama] Starting Ollama server...');
    ollamaProcess = spawn('ollama', ['serve'], {
      detached: false,
      stdio: 'ignore',
      env: { ...process.env, OLLAMA_HOST: '0.0.0.0:' + OLLAMA_PORT },
    });

    ollamaProcess.on('error', (err) => {
      console.error('[Ollama] Failed to start:', err.message);
      ollamaRunning = false;
    });

    ollamaProcess.on('exit', (code) => {
      console.log('[Ollama] Process exited with code:', code);
      ollamaRunning = false;
      ollamaProcess = null;
    });

    // Wait for it to be ready (up to 10 seconds)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ready = await isOllamaRunning();
      if (ready) {
        ollamaRunning = true;
        console.log('[Ollama] Server started on port ' + OLLAMA_PORT);
        return { started: true, message: 'Ollama started on port ' + OLLAMA_PORT };
      }
    }

    return { started: false, message: 'Ollama started but not responding on port ' + OLLAMA_PORT };
  } catch (e) {
    return { started: false, message: 'Failed to start Ollama: ' + String(e) };
  }
}

/** Stop the Ollama process we started */
export function stopOllama(): void {
  if (ollamaProcess) {
    console.log('[Ollama] Stopping...');
    try { ollamaProcess.kill('SIGTERM'); } catch {}
    ollamaProcess = null;
    ollamaRunning = false;
  }
  // Also try to stop any Ollama started outside NeuroNest
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/f', '/im', 'ollama.exe'], { timeout: 5000, stdio: 'pipe' }); } catch {}
  } else {
    try { execFileSync('killall', ['ollama'], { timeout: 3000, stdio: 'pipe' }); } catch {}
  }
}

/** Get Ollama status */
export async function getOllamaStatus(): Promise<{ installed: boolean; running: boolean; port: number; url: string }> {
  const running = await isOllamaRunning();
  ollamaRunning = running;
  return {
    installed: isOllamaInstalled(),
    running,
    port: OLLAMA_PORT,
    url: OLLAMA_URL,
  };
}

/** Download and install Ollama — platform-aware */
export async function installOllama(onProgress?: (msg: string) => void): Promise<{ success: boolean; message: string }> {
  if (isOllamaInstalled()) {
    return { success: true, message: 'Ollama is already installed' };
  }

  const { execSync: ex, exec: execAsync } = require('node:child_process');
  const platform = process.platform; // 'darwin', 'win32', 'linux'

  // ── macOS ──
  if (platform === 'darwin') {
    const hasHomebrew = await ensureHomebrew(onProgress);
    if (hasHomebrew) {
      try {
        onProgress?.('Installing Ollama via Homebrew...');
        ex('brew install ollama', { timeout: 180000, encoding: 'utf-8' });
        if (isOllamaInstalled()) {
          onProgress?.('Ollama installed via Homebrew!');
          const result = await startOllama();
          return { success: true, message: 'Installed via Homebrew. ' + result.message };
        }
      } catch (e: any) {
        onProgress?.('Homebrew install failed: ' + (e.message || '').slice(0, 100));
      }
    }
    // Fallback: curl install script
    try {
      onProgress?.('Trying direct download from ollama.com...');
      ex('curl -fsSL https://ollama.com/install.sh | sh', { timeout: 180000, encoding: 'utf-8', shell: '/bin/bash' });
      if (isOllamaInstalled()) {
        onProgress?.('Ollama installed via direct download!');
        const result = await startOllama();
        return { success: true, message: 'Installed via direct download. ' + result.message };
      }
    } catch (e: any) {
      onProgress?.('Direct download failed: ' + (e.message || '').slice(0, 100));
    }
    // Last resort: open download page
    try {
      onProgress?.('Opening Ollama download page...');
      execAsync('open "https://ollama.com/download/mac"');
      return { success: true, message: 'Download page opened. Install Ollama from ollama.com, then restart NeuroNest.' };
    } catch {
      return { success: false, message: 'Could not install Ollama. Please install manually from https://ollama.com' };
    }
  }

  // ── Windows ──
  if (platform === 'win32') {
    // Try winget first (built into Windows 10/11)
    try {
      onProgress?.('Installing Ollama via winget...');
      ex('winget install Ollama.Ollama --accept-source-agreements --accept-package-agreements', { timeout: 300000, encoding: 'utf-8', shell: 'cmd.exe' });
      // Refresh PATH from registry to pick up newly installed Ollama
      try {
        const newPath = ex('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"', { timeout: 5000, encoding: 'utf-8' }).trim();
        if (newPath) process.env.PATH = newPath + ';' + (process.env.PATH || '');
      } catch {}
      if (isOllamaInstalled()) {
        onProgress?.('Ollama installed via winget!');
        const result = await startOllama();
        return { success: true, message: 'Installed via winget. ' + result.message };
      }
    } catch (e: any) {
      onProgress?.('winget install failed: ' + (e.message || '').slice(0, 100));
    }
    // Fallback: download the installer and run it
    try {
      onProgress?.('Downloading Ollama installer from ollama.com...');
      const downloadDir = process.env.TEMP || process.env.TMP || 'C:\\Temp';
      const installerPath = downloadDir + '\\OllamaSetup.exe';
      ex(`powershell -Command "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '${installerPath}'"`, { timeout: 120000, encoding: 'utf-8' });
      onProgress?.('Running Ollama installer (silent)...');
      // Try multiple silent install flags (Inno Setup and NSIS variants)
      try {
        ex(`"${installerPath}" /VERYSILENT /NORESTART /SP-`, { timeout: 300000, encoding: 'utf-8', shell: 'cmd.exe' });
      } catch {
        try { ex(`"${installerPath}" /S`, { timeout: 300000, encoding: 'utf-8', shell: 'cmd.exe' }); } catch {}
      }
      // Refresh PATH from registry
      try {
        const newPath = ex('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"', { timeout: 5000, encoding: 'utf-8' }).trim();
        if (newPath) process.env.PATH = newPath + ';' + (process.env.PATH || '');
      } catch {}
      // Also add common Ollama install locations to PATH
      const ollamaPaths = [
        (process.env.LOCALAPPDATA || '') + '\\Programs\\Ollama',
        'C:\\Program Files\\Ollama',
        (process.env.USERPROFILE || '') + '\\AppData\\Local\\Programs\\Ollama',
      ];
      for (const p of ollamaPaths) {
        if (p && !process.env.PATH?.includes(p)) {
          process.env.PATH = p + ';' + (process.env.PATH || '');
        }
      }
      if (isOllamaInstalled()) {
        onProgress?.('Ollama installed successfully!');
        const result = await startOllama();
        return { success: true, message: 'Installed via direct download. ' + result.message };
      }
    } catch (e: any) {
      onProgress?.('Direct download failed: ' + (e.message || '').slice(0, 100));
    }
    // Last resort: open download page
    try {
      onProgress?.('Opening Ollama download page...');
      ex('start https://ollama.com/download/windows', { shell: 'cmd.exe', timeout: 5000 });
      return { success: true, message: 'Download page opened. Install Ollama from ollama.com, then restart NeuroNest.' };
    } catch {
      return { success: false, message: 'Could not install Ollama. Please install manually from https://ollama.com/download/windows' };
    }
  }

  // ── Linux ──
  if (platform === 'linux') {
    // Official install script works on most Linux distros
    try {
      onProgress?.('Installing Ollama via official install script...');
      ex('curl -fsSL https://ollama.com/install.sh | sh', { timeout: 180000, encoding: 'utf-8', shell: '/bin/sh' });
      if (isOllamaInstalled()) {
        onProgress?.('Ollama installed successfully!');
        const result = await startOllama();
        return { success: true, message: 'Installed via install script. ' + result.message };
      }
    } catch (e: any) {
      onProgress?.('Install script failed: ' + (e.message || '').slice(0, 100));
    }
    // Fallback: try snap
    try {
      onProgress?.('Trying snap install...');
      ex('sudo snap install ollama', { timeout: 120000, encoding: 'utf-8' });
      if (isOllamaInstalled()) {
        onProgress?.('Ollama installed via snap!');
        const result = await startOllama();
        return { success: true, message: 'Installed via snap. ' + result.message };
      }
    } catch (e: any) {
      onProgress?.('Snap install failed: ' + (e.message || '').slice(0, 100));
    }
    // Last resort: open download page
    try {
      onProgress?.('Opening Ollama download page...');
      ex('xdg-open "https://ollama.com/download/linux" 2>/dev/null || sensible-browser "https://ollama.com/download/linux" 2>/dev/null', { timeout: 5000, shell: '/bin/sh' });
      return { success: true, message: 'Download page opened. Install Ollama from ollama.com, then restart NeuroNest.' };
    } catch {
      return { success: false, message: 'Could not install Ollama. Please install manually: curl -fsSL https://ollama.com/install.sh | sh' };
    }
  }

  return { success: false, message: 'Unsupported platform: ' + platform + '. Please install Ollama manually from https://ollama.com' };
}

/** Check if llama.cpp is installed */
export function isLlamaCppInstalled(): boolean {
  try {
    if (process.platform === 'win32') {
      const result = execSync('where llama-server 2>nul', { encoding: 'utf-8', timeout: 5000 });
      if (result.trim().length > 0) return true;
      // Also check common install locations
      const fs = require('node:fs');
      const extractDir = (process.env.LOCALAPPDATA || process.env.USERPROFILE + '\\AppData\\Local') + '\\llama-cpp';
      const paths = [
        extractDir + '\\llama-server.exe',
        'C:\\llama-cpp\\llama-server.exe',
      ];
      // Check subdirectories too (release zips often nest)
      try {
        const entries = fs.readdirSync(extractDir);
        for (const entry of entries) {
          paths.push(extractDir + '\\' + entry + '\\llama-server.exe');
        }
      } catch {}
      for (const p of paths) {
        try { if (fs.existsSync(p)) return true; } catch {}
      }
      return false;
    }
    const r = execSync('which llama-server 2>/dev/null || brew list llama.cpp 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    return r.trim().length > 0;
  } catch { return false; }
}
export function isLlamaCppRunning(): Promise<boolean> {
  return new Promise((resolve) => { const req = http.get('http://localhost:8080/health', { timeout: 2000 }, (res) => { resolve(res.statusCode === 200); }); req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); }); });
}
export async function installLlamaCpp(onProgress?: (msg: string) => void): Promise<{ success: boolean; message: string }> {
  if (isLlamaCppInstalled()) return { success: true, message: 'Already installed' };

  const platform = process.platform;

  // ── macOS ──
  if (platform === 'darwin') {
    const hasHomebrew = await ensureHomebrew(onProgress);
    if (!hasHomebrew) {
      return { success: false, message: 'Homebrew is required to install llama.cpp on macOS but could not be installed. Please install Homebrew manually: https://brew.sh' };
    }
    try {
      onProgress?.('Installing llama.cpp via Homebrew...');
      execSync('brew install llama.cpp', { timeout: 300000, encoding: 'utf-8' });
      return isLlamaCppInstalled() ? { success: true, message: 'Installed via Homebrew' } : { success: false, message: 'Install ran but binary not found' };
    } catch (e: any) {
      return { success: false, message: 'Failed: ' + (e.message || '').slice(0, 100) };
    }
  }

  // ── Windows ──
  if (platform === 'win32') {
    try {
      onProgress?.('Downloading llama.cpp for Windows...');
      const downloadDir = process.env.TEMP || process.env.TMP || 'C:\\Temp';
      const extractDir = (process.env.LOCALAPPDATA || process.env.USERPROFILE + '\\AppData\\Local') + '\\llama-cpp';
      const zipPath = downloadDir + '\\llama-cpp.zip';
      // Download latest release — use GitHub API to find the correct asset name
      const downloadScript = `$releases = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggerganov/llama.cpp/releases/latest'; $asset = $releases.assets | Where-Object { $_.name -match 'llama-.*-bin-win-x64\\.zip' -or $_.name -match 'llama-server.*win.*x64\\.zip' } | Select-Object -First 1; if ($asset) { Invoke-WebRequest -Uri $asset.browser_download_url -OutFile '${zipPath}' } else { Invoke-WebRequest -Uri 'https://github.com/ggerganov/llama.cpp/releases/latest/download/llama-server-win-x64.zip' -OutFile '${zipPath}' }`;
      execFileSync('powershell', ['-Command', downloadScript], { timeout: 180000, encoding: 'utf-8' });
      onProgress?.('Extracting llama.cpp...');
      const extractScript = `New-Item -ItemType Directory -Force -Path '${extractDir}' | Out-Null; Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`;
      execFileSync('powershell', ['-Command', extractScript], { timeout: 60000, encoding: 'utf-8' });
      // Add to PATH for current process and persist via registry
      process.env.PATH = (process.env.PATH || '') + ';' + extractDir;
      try { execFileSync('setx', ['PATH', `%PATH%;${extractDir}`], { timeout: 10000, stdio: 'pipe' }); } catch {}
      if (isLlamaCppInstalled()) {
        return { success: true, message: 'Installed to ' + extractDir };
      }
      // Check subdirectories (release zips often have a nested folder)
      const fsCheck = require('node:fs');
      const entries = fsCheck.readdirSync(extractDir);
      for (const entry of entries) {
        const subPath = extractDir + '\\' + entry;
        if (fsCheck.statSync(subPath).isDirectory()) {
          process.env.PATH = (process.env.PATH || '') + ';' + subPath;
          if (isLlamaCppInstalled()) return { success: true, message: 'Installed to ' + subPath };
        }
      }
      return { success: false, message: 'Extracted but llama-server.exe not found. Check ' + extractDir };
    } catch (e: any) {
      onProgress?.('Download failed: ' + (e.message || '').slice(0, 100));
      // Open GitHub releases page
      try { execSync('start https://github.com/ggerganov/llama.cpp/releases', { shell: 'cmd.exe', timeout: 5000 }); } catch {}
      return { success: false, message: 'Could not install llama.cpp. Download manually from https://github.com/ggerganov/llama.cpp/releases' };
    }
  }

  // ── Linux ──
  if (platform === 'linux') {
    // Try building from source or using package manager
    try {
      onProgress?.('Installing llama.cpp build dependencies...');
      execSync('apt-get install -y build-essential cmake 2>/dev/null || dnf install -y gcc-c++ cmake 2>/dev/null || true', { timeout: 60000, encoding: 'utf-8', shell: '/bin/sh' });
      onProgress?.('Cloning and building llama.cpp...');
      execSync('git clone https://github.com/ggerganov/llama.cpp /tmp/llama-cpp && cd /tmp/llama-cpp && cmake -B build && cmake --build build --target llama-server -j$(nproc) && cp build/bin/llama-server /usr/local/bin/', { timeout: 600000, encoding: 'utf-8', shell: '/bin/sh' });
      return isLlamaCppInstalled() ? { success: true, message: 'Built and installed from source' } : { success: false, message: 'Build completed but binary not found' };
    } catch (e: any) {
      onProgress?.('Build failed: ' + (e.message || '').slice(0, 100));
      return { success: false, message: 'Could not install llama.cpp. Build manually: https://github.com/ggerganov/llama.cpp#build' };
    }
  }

  return { success: false, message: 'Unsupported platform: ' + platform };
}
let llamaCppProcess: ChildProcess | null = null;

export async function startLlamaCpp(): Promise<{ started: boolean; message: string }> {
  if (!isLlamaCppInstalled()) return { started: false, message: 'llama.cpp is not installed' };
  const running = await isLlamaCppRunning();
  if (running) return { started: true, message: 'llama.cpp already running on port 8080' };
  try {
    // llama-server requires a model file. Try to start with --port only.
    // If no model is loaded it will start but return errors on inference.
    llamaCppProcess = spawn('llama-server', ['--host', '0.0.0.0', '--port', '8080'], { detached: false, stdio: 'ignore' });
    llamaCppProcess.on('error', () => { llamaCppProcess = null; });
    llamaCppProcess.on('exit', () => { llamaCppProcess = null; });
    // Wait a bit then check
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isLlamaCppRunning()) return { started: true, message: 'llama.cpp running on port 8080' };
    }
    // Even if health check fails, the process may be running
    if (llamaCppProcess && !llamaCppProcess.killed) {
      return { started: true, message: 'llama.cpp started on port 8080 (load a model to use it)' };
    }
    return { started: false, message: 'llama.cpp failed to start. You may need to load a model first.' };
  } catch (e: any) { return { started: false, message: 'Failed: ' + e.message }; }
}

export function stopLlamaCpp(): void {
  if (llamaCppProcess) { llamaCppProcess.kill(); llamaCppProcess = null; }
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/f', '/im', 'llama-server.exe'], { timeout: 5000, stdio: 'pipe' }); } catch {}
  } else {
    try { execFileSync('killall', ['llama-server'], { timeout: 3000, stdio: 'pipe' }); } catch {}
  }
}

export async function getLlamaCppStatus(): Promise<{ installed: boolean; running: boolean; port: number; url: string }> {
  return { installed: isLlamaCppInstalled(), running: await isLlamaCppRunning(), port: 8080, url: 'http://localhost:8080' };
}
export async function uninstallOllama(): Promise<{ success: boolean; message: string }> {
  stopOllama();
  if (process.platform === 'darwin') {
    try { execSync('brew uninstall ollama 2>/dev/null', { timeout: 60000, encoding: 'utf-8' }); } catch {}
    try { execSync('rm -f /usr/local/bin/ollama 2>/dev/null', { timeout: 5000 }); } catch {}
  } else if (process.platform === 'win32') {
    try { execSync('winget uninstall Ollama.Ollama', { timeout: 60000, encoding: 'utf-8', shell: 'cmd.exe' }); } catch {}
  } else {
    try { execSync('rm -f /usr/local/bin/ollama 2>/dev/null', { timeout: 5000 }); } catch {}
    try { execSync('sudo snap remove ollama 2>/dev/null', { timeout: 60000 }); } catch {}
  }
  return isOllamaInstalled() ? { success: false, message: 'Could not fully remove Ollama' } : { success: true, message: 'Ollama uninstalled' };
}

export async function uninstallLlamaCpp(): Promise<{ success: boolean; message: string }> {
  stopLlamaCpp();
  if (process.platform === 'darwin') {
    try { execSync('brew uninstall llama.cpp 2>/dev/null', { timeout: 60000, encoding: 'utf-8' }); } catch {}
  } else if (process.platform === 'win32') {
    const extractDir = (process.env.LOCALAPPDATA || process.env.USERPROFILE + '\\AppData\\Local') + '\\llama-cpp';
    try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', extractDir], { timeout: 10000, stdio: 'pipe' }); } catch {}
    // Also try old location
    try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', 'C:\\llama-cpp'], { timeout: 10000, stdio: 'pipe' }); } catch {}
  } else {
    try { execSync('rm -f /usr/local/bin/llama-server 2>/dev/null', { timeout: 5000 }); } catch {}
  }
  return isLlamaCppInstalled() ? { success: false, message: 'Could not fully remove llama.cpp' } : { success: true, message: 'llama.cpp uninstalled' };
}

export const OLLAMA_DEFAULT_PORT = OLLAMA_PORT;
export const OLLAMA_DEFAULT_URL = OLLAMA_URL;
