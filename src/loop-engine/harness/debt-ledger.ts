import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ─────────────────────────────────────────────────────

/**
 * A single entry in the Debt Ledger representing an intentional
 * lean simplification that may be upgraded in the future.
 */
export interface DebtLedgerEntry {
  filePath: string;
  lineNumber: number;
  ceilingName: string;
  upgradePath: string;
  timestamp: string; // ISO 8601
}

/**
 * The on-disk schema for the Debt Ledger JSON file.
 */
export interface DebtLedgerData {
  version: 1;
  entries: DebtLedgerEntry[];
}

// ─── Constants ─────────────────────────────────────────────────

/** Relative path from project root to the debt ledger file */
const DEBT_LEDGER_RELATIVE_PATH = '.neuronest/memory/lean-debt.json';

/** Current schema version */
const SCHEMA_VERSION = 1;

// ─── DebtLedgerWriter ──────────────────────────────────────────

/**
 * Writes intentional lean simplification entries to the Debt Ledger.
 * Handles write failures gracefully — logs error but never blocks the verifier.
 *
 * Storage location: `.neuronest/memory/lean-debt.json`
 *
 * @see Requirements 6.5, 6.6
 */
export class DebtLedgerWriter {
  private readonly ledgerPath: string;

  constructor(projectRoot: string) {
    this.ledgerPath = path.join(projectRoot, DEBT_LEDGER_RELATIVE_PATH);
  }

  /**
   * Get the resolved path to the debt ledger file.
   */
  getPath(): string {
    return this.ledgerPath;
  }

  /**
   * Add a new entry to the Debt Ledger.
   * Creates the directory structure and file if they don't exist.
   * Gracefully handles all write failures by logging and returning false.
   *
   * @returns true if the entry was successfully written, false otherwise
   */
  addEntry(entry: DebtLedgerEntry): boolean {
    try {
      const data = this.readExisting();
      data.entries.push(entry);
      this.writeLedger(data);
      return true;
    } catch (err) {
      console.error(
        '[DebtLedger] Failed to write entry:',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /**
   * Add multiple entries to the Debt Ledger in a single write.
   * Gracefully handles all write failures by logging and returning false.
   *
   * @returns true if the entries were successfully written, false otherwise
   */
  addEntries(entries: DebtLedgerEntry[]): boolean {
    if (entries.length === 0) {
      return true;
    }

    try {
      const data = this.readExisting();
      data.entries.push(...entries);
      this.writeLedger(data);
      return true;
    } catch (err) {
      console.error(
        '[DebtLedger] Failed to write entries:',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /**
   * Read all current entries from the Debt Ledger.
   * Returns an empty ledger if the file does not exist or is invalid.
   */
  readEntries(): DebtLedgerEntry[] {
    return this.readExisting().entries;
  }

  /**
   * Read the existing ledger data from disk.
   * Returns a fresh empty ledger if the file doesn't exist or is invalid JSON.
   */
  private readExisting(): DebtLedgerData {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const raw = fs.readFileSync(this.ledgerPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (this.isValidLedgerData(parsed)) {
          return parsed;
        }
      }
    } catch {
      // If read/parse fails, start fresh
    }
    return { version: SCHEMA_VERSION, entries: [] };
  }

  /**
   * Write ledger data to disk, creating directories if needed.
   */
  private writeLedger(data: DebtLedgerData): void {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.ledgerPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Validate that parsed JSON conforms to the DebtLedgerData schema.
   */
  private isValidLedgerData(data: unknown): data is DebtLedgerData {
    if (typeof data !== 'object' || data === null) return false;
    const obj = data as Record<string, unknown>;
    if (obj.version !== SCHEMA_VERSION) return false;
    if (!Array.isArray(obj.entries)) return false;
    return true;
  }
}

/**
 * Create a DebtLedgerEntry from verifier reconciliation data.
 * Generates an ISO 8601 timestamp at call time.
 */
export function createDebtEntry(
  filePath: string,
  lineNumber: number,
  ceilingName: string,
  upgradePath: string,
): DebtLedgerEntry {
  return {
    filePath,
    lineNumber,
    ceilingName,
    upgradePath,
    timestamp: new Date().toISOString(),
  };
}
