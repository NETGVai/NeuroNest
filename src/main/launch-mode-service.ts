import type Database from 'better-sqlite3';

import {
  LaunchModeInstallationClassConfigPayloadSchema,
  LaunchModeSchema,
  LaunchModeSettingsSchema,
  UI_LAUNCH_MODE_CONFIG_KEY,
  UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY,
  type InstallationClass,
  type LaunchMode,
  type LaunchModeResolution,
  type LaunchModeSettings,
} from '../shared/app-bootstrap-contracts.js';

interface ConfigRow {
  value: string;
}

export type LaunchModeRepairReason =
  | 'invalid-json'
  | 'unsupported-mode'
  | 'invalid-payload';

/** Non-sensitive diagnostic emitted after a corrupt setting is repaired. */
export interface LaunchModeRepairDiagnostic {
  kind: 'launch-mode-repaired';
  reason: LaunchModeRepairReason;
  replacementMode: 'advanced';
  repairedRevision: number;
}

export interface LaunchModeServiceOptions {
  now?: () => Date;
  onRepair?: (diagnostic: LaunchModeRepairDiagnostic) => void;
}

export class LaunchModeRevisionConflictError extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly currentRevision: number,
  ) {
    super(
      `Launch mode revision conflict: expected=${expectedRevision}, current=${currentRevision}`,
    );
    this.name = 'LaunchModeRevisionConflictError';
  }
}

interface AtomicResult<T> {
  value: T;
  repair?: LaunchModeRepairDiagnostic;
}

interface NormalizedSettings {
  settings: LaunchModeSettings;
  resolution: LaunchModeResolution;
  repair?: LaunchModeRepairDiagnostic;
}

const EXISTING_INSTALLATION_TABLES = [
  'sessions',
  'messages',
  'chat_sessions',
  'projects',
  'conversations',
  'workspaces',
  'user_profiles',
  'execution_history',
  'token_usage',
  'prompt_history',
  'legacy_history_import_markers',
] as const;

/**
 * Main-process authority for the persisted graphical launch mode.
 *
 * Only the two dedicated launch-mode config rows are ever written. Installation
 * classification, fallback repair, and revision changes run in immediate SQLite
 * transactions so edition, auth, project, conversation, provider/model,
 * Inspector, and window-state rows remain independent.
 */
export class LaunchModeService {
  private readonly now: () => Date;
  private readonly onRepair: ((diagnostic: LaunchModeRepairDiagnostic) => void) | undefined;

  constructor(
    private readonly db: Database.Database,
    options: LaunchModeServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onRepair = options.onRepair;
  }

  /** Resolve startup mode, persisting classification/default/repair as needed. */
  resolve(): LaunchModeResolution {
    return this.atomic(() => {
      const installationClass = this.classifyInstallationInTransaction();
      const normalized = this.normalizeSettingsInTransaction(installationClass);
      return {
        value: normalized.resolution,
        repair: normalized.repair,
      };
    });
  }

  /** Read the revisioned setting after applying required default or repair rules. */
  getSettings(): LaunchModeSettings {
    return this.atomic(() => {
      const installationClass = this.classifyInstallationInTransaction();
      const normalized = this.normalizeSettingsInTransaction(installationClass);
      return { value: normalized.settings, repair: normalized.repair };
    });
  }

  /** Return the stable, one-time installation classification. */
  classifyInstallation(): InstallationClass {
    return this.atomic(() => ({
      value: this.classifyInstallationInTransaction(),
    }));
  }

  /**
   * Persist a user choice with optimistic concurrency control.
   * The caller must supply the revision returned by getSettings().
   */
  setMode(mode: LaunchMode, expectedRevision: number): LaunchModeSettings {
    const parsedMode = LaunchModeSchema.parse(mode);

    return this.atomic(() => {
      const installationClass = this.classifyInstallationInTransaction();
      const normalized = this.normalizeSettingsInTransaction(installationClass);
      const current = normalized.settings;

      if (current.revision !== expectedRevision) {
        throw new LaunchModeRevisionConflictError(
          expectedRevision,
          current.revision,
        );
      }

      const updated = LaunchModeSettingsSchema.parse({
        mode: parsedMode,
        revision: current.revision + 1,
        updatedAt: this.timestamp(),
      });
      this.writeConfig(UI_LAUNCH_MODE_CONFIG_KEY, updated);

      return { value: updated, repair: normalized.repair };
    });
  }

  /** Compatibility name for settings/IPC callers that express this as an update. */
  updateMode(mode: LaunchMode, expectedRevision: number): LaunchModeSettings {
    return this.setMode(mode, expectedRevision);
  }

  private atomic<T>(work: () => AtomicResult<T>): T {
    const result = this.db.transaction(work).immediate();
    if (result.repair && this.onRepair) {
      try {
        this.onRepair(result.repair);
      } catch {
        // Diagnostics must never make a successfully repaired launch unusable.
      }
    }
    return result.value;
  }

  private classifyInstallationInTransaction(): InstallationClass {
    const row = this.readConfig(UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY);
    if (row) {
      const parsed = this.parseJson(row.value);
      const validated = parsed.ok
        ? LaunchModeInstallationClassConfigPayloadSchema.safeParse(parsed.value)
        : undefined;
      if (validated?.success) {
        return validated.data.installationClass;
      }

      // A damaged classification row proves that launch-mode initialization ran
      // previously. Repair conservatively to existing to preserve old behavior.
      this.writeConfig(UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY, {
        installationClass: 'existing',
        revision: this.nextRevision(parsed.ok ? parsed.value : undefined),
      });
      return 'existing';
    }

    const installationClass: InstallationClass = this.hasExistingInstallationEvidence()
      ? 'existing'
      : 'new';
    this.writeConfig(UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY, {
      installationClass,
      revision: 1,
    });
    return installationClass;
  }

  private normalizeSettingsInTransaction(
    _installationClass: InstallationClass,
  ): NormalizedSettings {
    const row = this.readConfig(UI_LAUNCH_MODE_CONFIG_KEY);
    if (!row) {
      // No config row exists yet — show the selector so the user makes an
      // explicit choice, regardless of whether this is a new or existing install.
      const settings = LaunchModeSettingsSchema.parse({
        mode: null,
        revision: 1,
        updatedAt: null,
      });
      this.writeConfig(UI_LAUNCH_MODE_CONFIG_KEY, settings);
      return {
        settings,
        resolution: {
          state: 'selection-required',
          installationClass: 'new',
        },
      };
    }

    const parsed = this.parseJson(row.value);
    const validated = parsed.ok
      ? LaunchModeSettingsSchema.safeParse(parsed.value)
      : undefined;

    if (validated?.success) {
      const settings = validated.data;
      if (settings.mode && settings.revision > 1) {
        // Mode was explicitly chosen by the user (revision > 1 means the mode
        // was updated via the selector UI after the initial null-mode write).
        return {
          settings,
          resolution: { state: 'resolved', mode: settings.mode, source: 'saved' },
        };
      }

      // No mode explicitly chosen yet — show the selector regardless of
      // installation class so both new and existing users make an explicit choice.
      // This also handles legacy-defaulted modes (revision 1, auto-set to advanced)
      // by re-prompting the user to confirm their preference.
      // Present settings with mode: null so the renderer selector UI knows to
      // wait for user input instead of immediately finishing.
      const selectionSettings = LaunchModeSettingsSchema.parse({
        mode: null,
        revision: settings.revision,
        updatedAt: settings.updatedAt,
      });
      return {
        settings: selectionSettings,
        resolution: {
          state: 'selection-required',
          installationClass: 'new',
        },
      };
    }

    const repaired = this.createAdvancedSettings(
      this.nextRevision(parsed.ok ? parsed.value : undefined),
    );
    this.writeConfig(UI_LAUNCH_MODE_CONFIG_KEY, repaired);
    const repair: LaunchModeRepairDiagnostic = {
      kind: 'launch-mode-repaired',
      reason: this.repairReason(parsed),
      replacementMode: 'advanced',
      repairedRevision: repaired.revision,
    };
    return {
      settings: repaired,
      resolution: {
        state: 'resolved',
        mode: 'advanced',
        source: 'corrupt-fallback',
      },
      repair,
    };
  }

  private hasExistingInstallationEvidence(): boolean {
    const modeRow = this.readConfig(UI_LAUNCH_MODE_CONFIG_KEY);
    if (modeRow) return true;

    const unrelatedConfig = this.db
      .prepare(
        `SELECT 1
           FROM config
          WHERE key NOT IN (?, ?)
          LIMIT 1`,
      )
      .get(
        UI_LAUNCH_MODE_CONFIG_KEY,
        UI_LAUNCH_MODE_INSTALLATION_CLASS_CONFIG_KEY,
      );
    if (unrelatedConfig) return true;

    for (const table of EXISTING_INSTALLATION_TABLES) {
      if (this.tableExists(table) && this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
        return true;
      }
    }

    // On upgrade, migration 76 is applied after older schema history. A clean
    // install applies both in the same migration run; user rows/config remain
    // the primary evidence when timestamp precision cannot distinguish them.
    if (this.tableExists('schema_migrations')) {
      const priorSchemaHistory = this.db
        .prepare(
          `SELECT 1
             FROM schema_migrations AS prior
             JOIN schema_migrations AS foundation ON foundation.version = 76
            WHERE prior.version < 76
              AND prior.applied_at < foundation.applied_at
            LIMIT 1`,
        )
        .get();
      if (priorSchemaHistory) return true;
    }

    return false;
  }

  private tableExists(table: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        )
        .get(table),
    );
  }

  private readConfig(key: string): ConfigRow | undefined {
    return this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(key) as ConfigRow | undefined;
  }

  private writeConfig(key: string, payload: unknown): void {
    const timestamp = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(payload), timestamp);
  }

  private createAdvancedSettings(revision: number): LaunchModeSettings {
    return LaunchModeSettingsSchema.parse({
      mode: 'advanced',
      revision,
      updatedAt: this.timestamp(),
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private parseJson(raw: string):
    | { ok: true; value: unknown }
    | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false };
    }
  }

  private nextRevision(payload: unknown): number {
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'revision' in payload &&
      typeof payload.revision === 'number' &&
      Number.isInteger(payload.revision) &&
      payload.revision > 0 &&
      Number.isFinite(payload.revision)
    ) {
      return payload.revision + 1;
    }
    return 1;
  }

  private repairReason(
    parsed: { ok: true; value: unknown } | { ok: false },
  ): LaunchModeRepairReason {
    if (!parsed.ok) return 'invalid-json';
    if (
      typeof parsed.value === 'object' &&
      parsed.value !== null &&
      'mode' in parsed.value &&
      typeof parsed.value.mode === 'string' &&
      !LaunchModeSchema.safeParse(parsed.value.mode).success
    ) {
      return 'unsupported-mode';
    }
    return 'invalid-payload';
  }
}
