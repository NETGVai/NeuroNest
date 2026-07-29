/**
 * OpenMythosManager — Detects, installs, starts, and monitors the OpenMythos
 * Python inference bridge on the local system.
 * OpenMythos is a PyTorch Recurrent-Depth Transformer with Mixture-of-Experts.
 * The bridge (scripts/openmythos_bridge.py) exposes an OpenAI-compatible API.
 */

import { execSync, execFileSync, spawn, ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';

const OPENMYTHOS_PORT = 8200;
const OPENMYTHOS_URL = 'http://localhost:' + OPENMYTHOS_PORT;

let openMythosProcess: ChildProcess | null = null;
let openMythosRunning = false;

// ─── Virtual environment helpers ────────────────────────────────

/** Path to the OpenMythos virtual environment inside the app data directory. */
function getVenvDir(): string {
  // Place the venv next to the app's scripts directory so it persists across sessions
  return path.join(__dirname, '..', '..', '.openmythos-venv');
}

/** Get the python executable inside the venv (if it exists). Falls back to system python. */
function getVenvPython(): string {
  const venvDir = getVenvDir();
  const venvPython = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Check if the venv exists and has a working python. */
function isVenvReady(): boolean {
  const venvPython = process.platform === 'win32'
    ? path.join(getVenvDir(), 'Scripts', 'python.exe')
    : path.join(getVenvDir(), 'bin', 'python3');
  return fs.existsSync(venvPython);
}

// ─── Interfaces ─────────────────────────────────────────────────

export interface GPUInfo {
  cudaAvailable: boolean;
  gpuName: string;
  vramMB: number;
  cudaVersion: string;
}

export interface OpenMythosStatus {
  installed: boolean;
  running: boolean;
  port: number;
  url: string;
  pythonVersion: string;
  gpu: GPUInfo | null;
}

// ─── Python version parsing ─────────────────────────────────────

/**
 * Parse a Python version string and check if it meets the minimum 3.9 requirement.
 * Exported for property-based testing.
 */
export function parsePythonVersion(versionStr: string): { valid: boolean; major: number; minor: number; patch: number } {
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { valid: false, major: 0, minor: 0, patch: 0 };
  }
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);
  const valid = (major > 3) || (major === 3 && minor >= 9);
  return { valid, major, minor, patch };
}

// ─── Python detection ───────────────────────────────────────────

/** Check if Python 3.9+ is installed on the system */
export function isPythonInstalled(): { installed: boolean; version: string; path: string } {
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const versionOutput = execFileSync(pythonCmd, ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
    const parsed = parsePythonVersion(versionOutput);
    if (!parsed.valid) {
      return { installed: false, version: '', path: '' };
    }
    let pythonPath = '';
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      pythonPath = execFileSync(whichCmd, [pythonCmd], { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0];
    } catch {}
    return {
      installed: true,
      version: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
      path: pythonPath,
    };
  } catch {
    return { installed: false, version: '', path: '' };
  }
}

// ─── Package detection ──────────────────────────────────────────

/** Check if the open-mythos pip package is installed */
export function isOpenMythosInstalled(): boolean {
  try {
    const pythonBin = getVenvPython();
    const result = execFileSync(pythonBin, ['-m', 'pip', 'show', 'open-mythos'], { encoding: 'utf-8', timeout: 10000 });
    return result.includes('Name: open-mythos');
  } catch {
    return false;
  }
}

/** Check if the bridge server dependencies (fastapi, uvicorn) are installed in the venv */
function areBridgeDepsInstalled(): boolean {
  try {
    const pythonBin = getVenvPython();
    execFileSync(pythonBin, ['-c', 'import fastapi; import uvicorn'], { encoding: 'utf-8', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** Ensure bridge dependencies are installed in the venv. Called before starting. */
function ensureBridgeDeps(): void {
  if (areBridgeDepsInstalled()) return;
  const venvDir = getVenvDir();
  const venvPip = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip');
  if (!fs.existsSync(venvPip)) return;
  console.log('[OpenMythos] Installing missing bridge dependencies (fastapi, uvicorn)...');
  execFileSync(venvPip, ['install', 'fastapi', 'uvicorn', 'pydantic'], {
    timeout: 120000,
    encoding: 'utf-8',
  });
}

// ─── Health check ───────────────────────────────────────────────

/** Check if the OpenMythos bridge server is running and healthy */
export function isOpenMythosRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(OPENMYTHOS_URL + '/health', { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── Start bridge ───────────────────────────────────────────────

/** Start the OpenMythos bridge server as a background process */
export async function startOpenMythos(): Promise<{ started: boolean; message: string }> {
  const python = isPythonInstalled();
  if (!python.installed) {
    return { started: false, message: 'Python 3.9+ is not installed. Please install Python from https://python.org' };
  }

  if (!isOpenMythosInstalled()) {
    return { started: false, message: 'open-mythos package is not installed. Use the Install button to install it.' };
  }

  const running = await isOpenMythosRunning();
  if (running) {
    openMythosRunning = true;
    console.log('[OpenMythos] Already running on port ' + OPENMYTHOS_PORT);
    return { started: true, message: 'OpenMythos bridge already running on port ' + OPENMYTHOS_PORT };
  }

  try {
    console.log('[OpenMythos] Starting bridge server...');
    const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'openmythos_bridge.py');
    const pythonBin = getVenvPython();

    // Ensure fastapi/uvicorn are installed (handles upgrades from older installs)
    try {
      ensureBridgeDeps();
    } catch (e) {
      console.error('[OpenMythos] Failed to install bridge deps:', e);
      return { started: false, message: 'Failed to install bridge dependencies (fastapi, uvicorn). Check Python/pip.' };
    }

    openMythosProcess = spawn(pythonBin, [bridgeScript, '--port', String(OPENMYTHOS_PORT)], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    // Capture stderr for debugging startup failures
    if (openMythosProcess.stderr) {
      let stderrBuf = '';
      openMythosProcess.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrBuf += text;
        // Only log the first 500 chars to avoid flooding
        if (stderrBuf.length <= 500) {
          console.error('[OpenMythos stderr]', text.trim());
        }
      });
    }

    openMythosProcess.unref();

    openMythosProcess.on('error', (err) => {
      console.error('[OpenMythos] Failed to start:', err.message);
      openMythosRunning = false;
    });

    openMythosProcess.on('exit', (code) => {
      console.log('[OpenMythos] Process exited with code:', code);
      openMythosRunning = false;
      openMythosProcess = null;
    });

    // Poll /health every 500ms for up to 30 seconds (model loading is slow)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ready = await isOpenMythosRunning();
      if (ready) {
        openMythosRunning = true;
        console.log('[OpenMythos] Bridge started on port ' + OPENMYTHOS_PORT);
        return { started: true, message: 'OpenMythos bridge started on port ' + OPENMYTHOS_PORT };
      }
    }

    return { started: false, message: 'OpenMythos bridge started but not responding on port ' + OPENMYTHOS_PORT };
  } catch (e) {
    return { started: false, message: 'Failed to start OpenMythos bridge: ' + String(e) };
  }
}

// ─── Stop bridge ────────────────────────────────────────────────

/** Stop the OpenMythos bridge process. Sends SIGTERM, falls back to SIGKILL after 5s. */
export function stopOpenMythos(): void {
  if (openMythosProcess) {
    console.log('[OpenMythos] Stopping via process reference...');
    try {
      openMythosProcess.kill('SIGTERM');
    } catch {}

    // Fall back to SIGKILL after 5 seconds if still alive
    const proc = openMythosProcess;
    setTimeout(() => {
      if (proc && !proc.killed) {
        console.log('[OpenMythos] SIGTERM did not stop process, sending SIGKILL...');
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, 5000);

    openMythosProcess = null;
    openMythosRunning = false;
  } else {
    // Fallback: kill any process listening on the OpenMythos port
    console.log('[OpenMythos] No process reference, killing by port', OPENMYTHOS_PORT);
    try {
      if (process.platform === 'win32') {
        // Windows: use netstat + findstr to find process on port
        const netstat = execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${OPENMYTHOS_PORT}`], { encoding: 'utf-8', timeout: 5000 });
        const lines = netstat.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid)) {
            try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch {}
          }
        }
        openMythosRunning = false;
      } else {
        // Unix: use lsof
        const pid = execFileSync('lsof', ['-ti', `tcp:${OPENMYTHOS_PORT}`], { encoding: 'utf-8', timeout: 5000 }).trim();
        if (pid) {
          pid.split('\n').forEach(p => {
            try { process.kill(parseInt(p, 10), 'SIGTERM'); } catch {}
          });
          openMythosRunning = false;
          console.log('[OpenMythos] Killed process(es) on port', OPENMYTHOS_PORT, ':', pid);
        }
      }
    } catch {
      // No process found on port — that's fine
    }
    openMythosRunning = false;
  }
}

// ─── GPU detection ──────────────────────────────────────────────

/** Detect GPU capabilities via PyTorch */
export async function detectGPU(): Promise<GPUInfo> {
  const defaultInfo: GPUInfo = { cudaAvailable: false, gpuName: '', vramMB: 0, cudaVersion: '' };

  try {
    const pythonBin = getVenvPython();
    const script = `import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''); print(torch.cuda.get_device_properties(0).total_mem // (1024*1024) if torch.cuda.is_available() else 0); print(torch.version.cuda or '')`;
    const output = execFileSync(pythonBin, ['-c', script], {
      encoding: 'utf-8',
      timeout: 15000,
    }).trim();

    const lines = output.split('\n');
    if (lines.length < 4) return defaultInfo;

    return {
      cudaAvailable: lines[0].trim() === 'True',
      gpuName: lines[1].trim(),
      vramMB: parseInt(lines[2].trim(), 10) || 0,
      cudaVersion: lines[3].trim(),
    };
  } catch {
    return defaultInfo;
  }
}

// ─── Status ─────────────────────────────────────────────────────

/** Get full OpenMythos status */
export async function getOpenMythosStatus(): Promise<OpenMythosStatus> {
  const python = isPythonInstalled();
  const running = await isOpenMythosRunning();
  openMythosRunning = running;

  let gpu: GPUInfo | null = null;
  if (python.installed) {
    try {
      gpu = await detectGPU();
    } catch {
      gpu = null;
    }
  }

  return {
    installed: isOpenMythosInstalled(),
    running,
    port: OPENMYTHOS_PORT,
    url: OPENMYTHOS_URL,
    pythonVersion: python.version,
    gpu,
  };
}

// ─── Install ────────────────────────────────────────────────────

/** Install the open-mythos pip package into a dedicated virtual environment */
export async function installOpenMythos(
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; message: string }> {
  const python = isPythonInstalled();
  if (!python.installed) {
    return { success: false, message: 'Python 3.9+ is required. Please install Python from https://python.org' };
  }

  if (isOpenMythosInstalled()) {
    return { success: true, message: 'open-mythos is already installed' };
  }

  try {
    // Create virtual environment if it doesn't exist
    const venvDir = getVenvDir();
    if (!isVenvReady()) {
      onProgress?.('Creating virtual environment...');
      console.log('[OpenMythos] Creating venv at', venvDir);
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      execFileSync(pythonCmd, ['-m', 'venv', venvDir], {
        timeout: 60000,
        encoding: 'utf-8',
      });
    }

    const venvPip = process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'pip.exe')
      : path.join(venvDir, 'bin', 'pip');
    onProgress?.('Installing open-mythos via pip (in virtual environment)...');
    console.log('[OpenMythos] Running pip install in venv...');
    execFileSync(venvPip, ['install', 'open-mythos', 'fastapi', 'uvicorn', 'pydantic'], {
      timeout: 300000, // 5 minutes max
      encoding: 'utf-8',
    });

    if (isOpenMythosInstalled()) {
      onProgress?.('open-mythos installed successfully!');
      return { success: true, message: 'open-mythos installed successfully' };
    }

    onProgress?.('pip install ran but package not found');
    return { success: false, message: 'pip install ran but open-mythos package not detected' };
  } catch (e: any) {
    const msg = (e.message || '').slice(0, 200);
    onProgress?.('Installation failed: ' + msg);
    return { success: false, message: 'Failed to install open-mythos: ' + msg };
  }
}

// ─── Status builder (pure, for property testing) ────────────────

/**
 * Build an OpenMythosStatus object from the given parameters.
 * This is the pure structural logic extracted from getOpenMythosStatus()
 * so it can be property-tested without real system calls.
 */
export function buildOpenMythosStatus(
  installed: boolean,
  running: boolean,
  port: number,
  pythonVersion: string = '',
  gpu: GPUInfo | null = null,
): OpenMythosStatus {
  return {
    installed,
    running,
    port,
    url: 'http://localhost:' + port,
    pythonVersion,
    gpu,
  };
}

// ─── Uninstall ───────────────────────────────────────────────────

/** Uninstall OpenMythos by removing the virtual environment */
export async function uninstallOpenMythos(): Promise<{ success: boolean; message: string }> {
  // Stop the bridge first
  stopOpenMythos();

  const venvDir = getVenvDir();
  if (!fs.existsSync(venvDir)) {
    return { success: true, message: 'OpenMythos is not installed' };
  }

  try {
    console.log('[OpenMythos] Removing venv at', venvDir);
    if (process.platform === 'win32') {
      execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', venvDir], { timeout: 30000, encoding: 'utf-8' });
    } else {
      execFileSync('rm', ['-rf', venvDir], { timeout: 30000, encoding: 'utf-8' });
    }
    return { success: true, message: 'OpenMythos uninstalled successfully' };
  } catch (e: any) {
    return { success: false, message: 'Failed to uninstall: ' + (e.message || '').slice(0, 200) };
  }
}

// ─── Exports ────────────────────────────────────────────────────

export const OPENMYTHOS_DEFAULT_PORT = OPENMYTHOS_PORT;
export const OPENMYTHOS_DEFAULT_URL = OPENMYTHOS_URL;
