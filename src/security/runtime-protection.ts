/**
 * NeuroNest Runtime Protection — Anti-tamper and anti-debug measures.
 *
 * Detects and responds to:
 * - DevTools being opened in production
 * - Debugger/inspection flags
 * - File integrity violations
 * - Suspicious environment variables
 *
 * Only active in production builds. Dev mode is unrestricted.
 */

import { app, BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ProtectionConfig {
  /** Enable DevTools detection (production only) */
  detectDevTools: boolean;
  /** Enable debugger flag detection */
  detectDebugger: boolean;
  /** Enable file integrity checks */
  integrityChecks: boolean;
  /** Action on violation: 'log' | 'restrict' | 'quit' */
  violationAction: 'log' | 'restrict' | 'quit';
  /** Critical files to hash-check (relative to app root) */
  criticalFiles: string[];
}

const DEFAULT_CONFIG: ProtectionConfig = {
  detectDevTools: true,
  detectDebugger: true,
  integrityChecks: true,
  violationAction: 'log',
  criticalFiles: [
    'dist/main/ipc.js',
    'dist/main/electron-app.js',
    'dist/renderer/preload.js',
  ],
};

export class RuntimeProtection {
  private config: ProtectionConfig;
  private isProduction: boolean;
  private violations: Array<{ type: string; message: string; timestamp: number }> = [];
  private integrityHashes: Map<string, string> = new Map();

  constructor(config?: Partial<ProtectionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isProduction = app.isPackaged || process.env.NODE_ENV === 'production';
  }

  /**
   * Initialize all runtime protections.
   * Call this after app is ready and window is created.
   */
  initialize(mainWindow: BrowserWindow): void {
    if (!this.isProduction) {
      console.log('[RuntimeProtection] Dev mode — protections disabled');
      return;
    }

    console.log('[RuntimeProtection] Initializing production protections');

    if (this.config.detectDebugger) {
      this.checkDebuggerFlags();
    }

    if (this.config.detectDevTools) {
      this.setupDevToolsDetection(mainWindow);
    }

    if (this.config.integrityChecks) {
      this.performIntegrityChecks();
    }

    this.checkEnvironment();
    this.disableProductionDebugAccess(mainWindow);
  }

  /**
   * Detect if app was launched with debugging flags.
   */
  private checkDebuggerFlags(): void {
    const suspiciousFlags = ['--inspect', '--inspect-brk', '--debug', '--debug-brk', '--remote-debugging-port'];

    for (const arg of process.execArgv) {
      for (const flag of suspiciousFlags) {
        if (arg.includes(flag)) {
          this.recordViolation('debugger', `Debugging flag detected: ${arg}`);
          this.handleViolation();
          return;
        }
      }
    }
  }

  /**
   * Setup DevTools open detection.
   */
  private setupDevToolsDetection(win: BrowserWindow): void {
    win.webContents.on('devtools-opened', () => {
      this.recordViolation('devtools', 'DevTools opened in production');
      if (this.config.violationAction === 'quit') {
        win.webContents.closeDevTools();
      }
    });
  }

  /**
   * Compute and verify integrity of critical files.
   */
  private performIntegrityChecks(): void {
    const appRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'app')
      : path.join(__dirname, '..', '..');

    for (const relPath of this.config.criticalFiles) {
      const fullPath = path.join(appRoot, relPath);
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath);
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          this.integrityHashes.set(relPath, hash);
        }
      } catch {
        // File not accessible — not necessarily a violation
      }
    }

    // Store hashes for future verification
    console.log(`[RuntimeProtection] Computed integrity hashes for ${this.integrityHashes.size} files`);
  }

  /**
   * Verify file integrity hasn't changed since startup.
   */
  verifyIntegrity(): { valid: boolean; violations: string[] } {
    if (!this.isProduction) return { valid: true, violations: [] };

    const violations: string[] = [];
    const appRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'app')
      : path.join(__dirname, '..', '..');

    for (const [relPath, expectedHash] of this.integrityHashes) {
      const fullPath = path.join(appRoot, relPath);
      try {
        const content = fs.readFileSync(fullPath);
        const currentHash = crypto.createHash('sha256').update(content).digest('hex');
        if (currentHash !== expectedHash) {
          violations.push(`Integrity mismatch: ${relPath}`);
        }
      } catch {
        violations.push(`File inaccessible: ${relPath}`);
      }
    }

    if (violations.length > 0) {
      this.recordViolation('integrity', violations.join('; '));
    }

    return { valid: violations.length === 0, violations };
  }

  /**
   * Check for suspicious environment variables.
   */
  private checkEnvironment(): void {
    const suspiciousVars = [
      'ELECTRON_ENABLE_LOGGING',
      'ELECTRON_DEBUG_NOTIFICATIONS',
      'ELECTRON_RUN_AS_NODE',
    ];

    for (const v of suspiciousVars) {
      if (process.env[v]) {
        this.recordViolation('environment', `Suspicious env var: ${v}`);
      }
    }
  }

  /**
   * Disable debug access in production.
   */
  private disableProductionDebugAccess(win: BrowserWindow): void {
    // Block Cmd+Alt+I (DevTools shortcut)
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'I' && input.meta && input.alt) {
        event.preventDefault();
      }
      // Also block Cmd+Shift+I
      if (input.key === 'I' && input.meta && input.shift) {
        event.preventDefault();
      }
    });
  }

  /**
   * Record a security violation.
   */
  private recordViolation(type: string, message: string): void {
    this.violations.push({ type, message, timestamp: Date.now() });
    console.warn(`[RuntimeProtection] VIOLATION [${type}]: ${message}`);
  }

  /**
   * Handle a violation based on configured action.
   */
  private handleViolation(): void {
    switch (this.config.violationAction) {
      case 'quit':
        app.quit();
        break;
      case 'restrict':
        // Caller should check getViolations() and restrict features
        break;
      case 'log':
      default:
        // Already logged in recordViolation
        break;
    }
  }

  /**
   * Get all recorded violations.
   */
  getViolations(): Array<{ type: string; message: string; timestamp: number }> {
    return [...this.violations];
  }

  /**
   * Check if the app is in a safe state (no violations).
   */
  isSafe(): boolean {
    return this.violations.length === 0;
  }
}
