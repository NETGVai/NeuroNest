/**
 * IPC handler registration for Diagnostics and Security Scanner modules.
 *
 * Uses lazy singleton initialization matching the existing NeuroNest pattern
 * (firewallEngine, graphManager, etc. are created inside ensureInit()).
 *
 * Requirements: 6.4, 6.5, 6.6, 6.7, 10.4, 10.5
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import type { FirewallEngine } from '../firewall/firewall-engine';
import { DiagnosticsEngine } from '../diagnostics/diagnostics-engine.js';
import { SecurityScanner } from '../security/security-scanner.js';
import { SARIFSerializer } from '../security/sarif-serializer.js';
import type { ScanOptions } from '../security/types';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface IPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Lazy singletons ────────────────────────────────────────────

let diagnosticsEngine: DiagnosticsEngine | null = null;
let securityScanner: SecurityScanner | null = null;

function getDiagnosticsEngine(db: Database.Database): DiagnosticsEngine {
  if (!diagnosticsEngine) diagnosticsEngine = new DiagnosticsEngine(db);
  return diagnosticsEngine;
}

function getSecurityScanner(db: Database.Database, fw: FirewallEngine): SecurityScanner {
  if (!securityScanner) securityScanner = new SecurityScanner(db, fw);
  return securityScanner;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): IPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Registration ───────────────────────────────────────────────

export function registerDiagnosticsIPC(
  mainWindow: BrowserWindow,
  db: Database.Database,
  firewallEngine: FirewallEngine,
): void {
  // ── diagnostics-run-doctor ──
  // Requirement 6.4: Execute DiagnosticsEngine and return consolidated report
  ipcMain.handle('diagnostics-run-doctor', async () => {
    try {
      const engine = getDiagnosticsEngine(db);
      return engine.runAll((result) => {
        // Requirement 6.2: Stream individual HealthCheck results to renderer
        mainWindow.webContents.send('diagnostics-progress', result);
      });
    } catch (err) {
      return makeError('DIAGNOSTICS_RUN_FAILED', err);
    }
  });

  // ── security-run-scan ──
  // Requirement 6.5: Execute SecurityScanner and return findings + summary
  ipcMain.handle('security-run-scan', async (_event, options: ScanOptions & { projectPath?: string; projectId?: string }) => {
    try {
      const scanner = getSecurityScanner(db, firewallEngine);
      // Resolve project path: prefer explicit projectPath, then resolve from projectId
      let projectPath = options?.projectPath;
      if (!projectPath && options?.projectId) {
        const os = require('node:os');
        const path = require('node:path');
        projectPath = path.join(os.homedir(), '.neuronest', 'projects', options.projectId);
      }
      if (!projectPath) {
        return makeError('SECURITY_SCAN_FAILED', new Error('No project selected. Please select a project first.'));
      }
      return scanner.scan(projectPath, options);
    } catch (err) {
      return makeError('SECURITY_SCAN_FAILED', err);
    }
  });

  // ── security-run-doctor ──
  // Requirement 6.5: Execute SecurityScanner health check
  ipcMain.handle('security-run-doctor', async () => {
    try {
      const scanner = getSecurityScanner(db, firewallEngine);
      return scanner.runHealthCheck();
    } catch (err) {
      return makeError('SECURITY_DOCTOR_FAILED', err);
    }
  });

  // ── security-get-scan-history ──
  // Requirement 6.5: Return scan history for a project
  ipcMain.handle('security-get-scan-history', async (_event, projectId: string) => {
    try {
      const scanner = getSecurityScanner(db, firewallEngine);
      return scanner.getScanHistory(projectId);
    } catch (err) {
      return makeError('SECURITY_HISTORY_FAILED', err);
    }
  });

  // ── security-export-sarif ──
  // Requirement 6.6: Return SARIF JSON document for a given scan
  ipcMain.handle('security-export-sarif', async (_event, scanId: string) => {
    try {
      const scanner = getSecurityScanner(db, firewallEngine);
      // Search across all projects for the scan by ID
      const history = scanner.getScanHistory('');
      const scan = history.find((s) => s.id === scanId);
      if (!scan) {
        return makeError('SCAN_NOT_FOUND', new Error(`Scan with id "${scanId}" not found`));
      }
      return SARIFSerializer.serialize(scan.findings, '0.1.1');
    } catch (err) {
      return makeError('SARIF_EXPORT_FAILED', err);
    }
  });
}
