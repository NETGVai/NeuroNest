// Skill-pack IPC handlers: install/list/sync/remove + drift detection & eval.
//
// Extracted from the inline block in registerIPCHandlers() (ipc.ts, task 46.2)
// into a dedicated, dependency-injected registerXxxIPC module — matching the
// established pattern of registerSkillsIPC / registerDiagnosticsIPC /
// registerLicenseIPC — so the six channels are independently unit-testable
// (task 47.6) without booting the whole main process.
//
// Requirements: 58 (kill-switch), 59 (loader contract), 60 (drift), 61 (eval),
// 62 (sync/remove), 63.1 (the six invocable channels).

import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { installPack, registerSkills, syncPack, removePack, type PackSource } from '../skills/pack-loader';
import { checkDrift, findInstalledPacks } from '../skills/drift-detector';
import { runEval } from '../skills/eval-runner';
import { SkillRegistry } from '../skills/skill-registry.js';
import { initDatabase } from '../storage/database';
import { PERF_FLAGS } from './performance/feature-flags';

/**
 * Minimal slice of the active LLM client the eval runner needs: a `chat()` that
 * takes messages and resolves to `{ content }`. Kept loose so the real
 * LLMClient (whose `chat()` returns a richer LLMResponse) is structurally
 * assignable without coupling this module to the pipeline types.
 */
export interface SkillPacksLLMClient {
  chat(messages: any, options?: any): Promise<{ content?: string | null } | null | undefined>;
}

/**
 * Dependencies injected by ipc.ts so this module never reaches into the
 * monolith's module-level singletons directly.
 */
export interface SkillPacksIPCDeps {
  /** Returns the shared SQLite handle, or null/undefined before bootstrap. */
  getDb: () => Database.Database | null | undefined;
  /** Resolves the active LLM client (never a hardcoded model, Req 61.3). */
  resolveActiveLLMClient: () => SkillPacksLLMClient | null;
}

/**
 * Register the six Skill_Pack IPC channels (Requirement 63.1):
 *   skill-packs:install | :list | :sync | :remove | :check-drift | :run-eval
 *
 * Mutating channels (install/sync/remove) are gated on
 * SKILL_PACK_LOADER_ENABLED (Requirement 58); read-only inspection
 * (list/check-drift/run-eval) stays available so an operator can still audit
 * already-installed packs after flipping the flag off. Every handler returns
 * `{ error }` on failure, matching the cookbook handler style.
 */
export function registerSkillPacksIPC(deps: SkillPacksIPCDeps): void {
  // Registry wiring: the pack-loader registers a pack's skills into the existing
  // Skill_Registry (namespaced `<pack.name>/<skillId>`). We build a SkillRegistry
  // over the shared `db` handle (mirroring registerSkillsIPC), falling back to a
  // standalone DB init only when subsystems haven't bootstrapped yet.
  const resolveSkillRegistry = (): SkillRegistry => new SkillRegistry(deps.getDb() ?? initDatabase());

  ipcMain.handle('skill-packs:install', async (_ev: any, args: { source: PackSource; force?: boolean } = {} as any) => {
    // Kill-switch (Requirement 58): when the loader flag is OFF, nothing can be
    // installed or registered. Mutating handlers are gated; read-only inspection
    // (list/check-drift/run-eval) stays available so an operator can still audit
    // already-installed packs after flipping the flag off.
    if (!PERF_FLAGS.SKILL_PACK_LOADER_ENABLED) return { error: 'Skill pack loader is disabled' };
    try {
      const result = await installPack(args.source, { force: args.force === true });
      // installPack only places + validates the pack; skill registration into the
      // Skill_Registry is a separate step. Register on a successful install so the
      // pack's skills are immediately routable (Requirement 59.4).
      if (result.ok && result.packId) {
        const installed = findInstalledPacks().find(
          (p) => p.packId === result.packId || p.manifest.name === result.packId,
        );
        if (installed) {
          const reg = registerSkills(result.packId, installed.manifest, resolveSkillRegistry());
          return { ...result, registered: reg.registered, skipped: reg.skipped };
        }
      }
      return result;
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('skill-packs:list', async () => {
    // listPacks() (task 43.5) is not yet implemented in pack-loader; the
    // drift-detector's findInstalledPacks() already enumerates the on-disk cache
    // (`<host>/<owner>/<repo>/` dirs carrying a readable pack.json), so we project
    // it into the renderer-facing shape here.
    try {
      return findInstalledPacks().map((p) => ({
        packId: p.packId,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        source: p.manifest.source,
        skills: p.manifest.skills,
        dir: p.dir,
      }));
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('skill-packs:sync', async (_ev: any, args: { packId: string }) => {
    if (!PERF_FLAGS.SKILL_PACK_LOADER_ENABLED) return { error: 'Skill pack loader is disabled' };
    try { return await syncPack(args.packId, resolveSkillRegistry()); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('skill-packs:remove', async (_ev: any, args: { packId: string }) => {
    if (!PERF_FLAGS.SKILL_PACK_LOADER_ENABLED) return { error: 'Skill pack loader is disabled' };
    try { return await removePack(args.packId, resolveSkillRegistry()); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('skill-packs:check-drift', async (_ev: any, args: { packId: string }) => {
    try { return await checkDrift(args.packId); }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle('skill-packs:run-eval', async (_ev: any, args: { packId: string }) => {
    try {
      // Wire the eval runner to the active LLM client (never a hardcoded model,
      // Requirement 61.3). The runner only needs prompt → text, so adapt the
      // client's chat() to a thin string-in/string-out call.
      const client = deps.resolveActiveLLMClient();
      if (!client) return { error: 'No AI provider configured' };
      const llmCall = async (prompt: string): Promise<string> => {
        const res = await client.chat([{ role: 'user', content: prompt }]);
        return res?.content ?? '';
      };
      return await runEval(args.packId, llmCall);
    } catch (e: any) { return { error: e.message }; }
  });
}
