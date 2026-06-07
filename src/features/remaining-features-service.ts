/**
 * Remaining Features Service — consolidated backend for all remaining gap features.
 *
 * Covers: Git worktrees, notifications, image/URL context, prompt cache, profiles,
 * personas, session status, file-session links, plan archive, session alerts,
 * global search, onboarding, decision log, zoom, auto-commit, AI ignore file.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ── Git Worktrees ──────────────────────────────────────────────

export interface GitWorktree {
  id: string; projectId: string; name: string; path: string;
  branch: string; baseBranch: string; sessionId?: string; createdAt: string;
}

export class GitWorktreeService {
  constructor(private db: Database.Database) {}

  create(opts: { projectId: string; name: string; path: string; branch: string; baseBranch?: string; sessionId?: string }): GitWorktree {
    const id = randomUUID();
    this.db.prepare('INSERT INTO git_worktrees (id, project_id, name, path, branch, base_branch, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, opts.projectId, opts.name, opts.path, opts.branch, opts.baseBranch || 'main', opts.sessionId || null, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): GitWorktree | null {
    const r = this.db.prepare('SELECT * FROM git_worktrees WHERE id = ?').get(id) as any;
    return r ? { id: r.id, projectId: r.project_id, name: r.name, path: r.path, branch: r.branch, baseBranch: r.base_branch, sessionId: r.session_id || undefined, createdAt: r.created_at } : null;
  }

  list(projectId: string): GitWorktree[] {
    return (this.db.prepare('SELECT * FROM git_worktrees WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as any[])
      .map(r => ({ id: r.id, projectId: r.project_id, name: r.name, path: r.path, branch: r.branch, baseBranch: r.base_branch, sessionId: r.session_id || undefined, createdAt: r.created_at }));
  }

  delete(id: string): boolean { return this.db.prepare('DELETE FROM git_worktrees WHERE id = ?').run(id).changes > 0; }
}

// ── Notification Config ────────────────────────────────────────

export interface NotificationConfig {
  projectId: string; enabled: boolean; onAgentComplete: boolean;
  onAgentNeedsInput: boolean; onCheckFailed: boolean; soundEnabled: boolean;
}

export class NotificationService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): NotificationConfig {
    const r = this.db.prepare('SELECT * FROM notification_config WHERE project_id = ?').get(projectId) as any;
    if (r) return { projectId: r.project_id, enabled: r.enabled === 1, onAgentComplete: r.on_agent_complete === 1, onAgentNeedsInput: r.on_agent_needs_input === 1, onCheckFailed: r.on_check_failed === 1, soundEnabled: r.sound_enabled === 1 };
    return { projectId, enabled: true, onAgentComplete: true, onAgentNeedsInput: true, onCheckFailed: true, soundEnabled: false };
  }

  setConfig(projectId: string, updates: Partial<NotificationConfig>): NotificationConfig {
    const existing = this.getConfig(projectId);
    const merged = { ...existing, ...updates };
    this.db.prepare('INSERT OR REPLACE INTO notification_config (project_id, enabled, on_agent_complete, on_agent_needs_input, on_check_failed, sound_enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, merged.enabled ? 1 : 0, merged.onAgentComplete ? 1 : 0, merged.onAgentNeedsInput ? 1 : 0, merged.onCheckFailed ? 1 : 0, merged.soundEnabled ? 1 : 0, new Date().toISOString());
    return this.getConfig(projectId);
  }
}

// ── Context Items (Image/URL/Note/Pipe) ────────────────────────

export interface ContextItem {
  id: string; sessionId: string; type: 'file' | 'url' | 'image' | 'note' | 'pipe';
  source: string; content?: string; tokenEstimate: number; sticky: boolean; createdAt: string;
}

export class ContextItemService {
  constructor(private db: Database.Database) {}

  add(opts: { sessionId: string; type: string; source: string; content?: string; tokenEstimate?: number; sticky?: boolean }): ContextItem {
    const id = randomUUID();
    this.db.prepare('INSERT INTO context_items (id, session_id, type, source, content, token_estimate, sticky, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, opts.sessionId, opts.type, opts.source, opts.content || null, opts.tokenEstimate || 0, opts.sticky ? 1 : 0, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): ContextItem | null {
    const r = this.db.prepare('SELECT * FROM context_items WHERE id = ?').get(id) as any;
    return r ? { id: r.id, sessionId: r.session_id, type: r.type, source: r.source, content: r.content || undefined, tokenEstimate: r.token_estimate, sticky: r.sticky === 1, createdAt: r.created_at } : null;
  }

  list(sessionId: string): ContextItem[] {
    return (this.db.prepare('SELECT * FROM context_items WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[])
      .map(r => ({ id: r.id, sessionId: r.session_id, type: r.type, source: r.source, content: r.content || undefined, tokenEstimate: r.token_estimate, sticky: r.sticky === 1, createdAt: r.created_at }));
  }

  remove(id: string): boolean { return this.db.prepare('DELETE FROM context_items WHERE id = ?').run(id).changes > 0; }
  clearNonSticky(sessionId: string): number { return this.db.prepare("DELETE FROM context_items WHERE session_id = ? AND sticky = 0").run(sessionId).changes; }
}

// ── Prompt Cache ───────────────────────────────────────────────

export class PromptCacheService {
  constructor(private db: Database.Database) {}

  lookup(hash: string): string | null {
    const r = this.db.prepare('SELECT response FROM prompt_cache WHERE hash = ?').get(hash) as any;
    if (r) { this.db.prepare('UPDATE prompt_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE hash = ?').run(new Date().toISOString(), hash); return r.response; }
    return null;
  }

  store(hash: string, provider: string, model: string, promptTokens: number, response: string): void {
    this.db.prepare('INSERT OR REPLACE INTO prompt_cache (hash, provider, model, prompt_tokens, response, hit_count, created_at, last_hit_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(hash, provider, model, promptTokens, response, new Date().toISOString(), new Date().toISOString());
  }

  getStats(): { totalEntries: number; totalHits: number; estimatedSavings: number } {
    const r = this.db.prepare('SELECT COUNT(*) as entries, SUM(hit_count) as hits, SUM(prompt_tokens * (hit_count - 1)) as saved_tokens FROM prompt_cache').get() as any;
    return { totalEntries: r?.entries || 0, totalHits: r?.hits || 0, estimatedSavings: r?.saved_tokens || 0 };
  }

  clear(): void { this.db.prepare('DELETE FROM prompt_cache').run(); }
}

// ── Config Profiles ────────────────────────────────────────────

export interface ConfigProfile { id: string; name: string; description?: string; settings: Record<string, unknown>; isActive: boolean; createdAt: string; }

export class ConfigProfileService {
  private defaultProfileId: string | null = null;

  constructor(private db: Database.Database) {
    this.ensureDefaultProfile();
  }

  private ensureDefaultProfile(): void {
    const existing = this.db.prepare('SELECT id FROM config_profiles ORDER BY created_at ASC LIMIT 1').get() as any;
    if (existing) {
      this.defaultProfileId = existing.id;
      // Ensure at least one profile is active
      const active = this.db.prepare('SELECT id FROM config_profiles WHERE is_active = 1').get() as any;
      if (!active) {
        this.db.prepare('UPDATE config_profiles SET is_active = 1 WHERE id = ?').run(existing.id);
      }
    } else {
      // Create default profile with current config as settings
      const id = randomUUID();
      let currentSettings: Record<string, unknown> = {};
      try {
        const provRow = this.db.prepare("SELECT value FROM config WHERE key = 'providers'").get() as any;
        const defProvRow = this.db.prepare("SELECT value FROM config WHERE key = 'default-provider'").get() as any;
        if (provRow) currentSettings['providers'] = provRow.value;
        if (defProvRow) currentSettings['default-provider'] = defProvRow.value;
      } catch {}
      this.db.prepare('INSERT INTO config_profiles (id, name, description, settings, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(id, 'Default', 'Default configuration profile', JSON.stringify(currentSettings), new Date().toISOString());
      this.defaultProfileId = id;
    }
  }

  getDefaultProfileId(): string {
    return this.defaultProfileId!;
  }

  getActiveProfile(): ConfigProfile | null {
    const r = this.db.prepare('SELECT * FROM config_profiles WHERE is_active = 1').get() as any;
    return r ? { id: r.id, name: r.name, description: r.description || undefined, settings: JSON.parse(r.settings || '{}'), isActive: true, createdAt: r.created_at } : null;
  }

  create(name: string, description?: string, settings?: Record<string, unknown>): ConfigProfile {
    const id = randomUUID();
    // Inherit settings from default profile if none provided
    let inheritedSettings = settings || {};
    if (!settings || Object.keys(settings).length === 0) {
      const defaultProfile = this.get(this.defaultProfileId!);
      if (defaultProfile) {
        inheritedSettings = { ...defaultProfile.settings };
      }
    }
    this.db.prepare('INSERT INTO config_profiles (id, name, description, settings, is_active, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, name, description || null, JSON.stringify(inheritedSettings), new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): ConfigProfile | null {
    const r = this.db.prepare('SELECT * FROM config_profiles WHERE id = ?').get(id) as any;
    return r ? { id: r.id, name: r.name, description: r.description || undefined, settings: JSON.parse(r.settings || '{}'), isActive: r.is_active === 1, createdAt: r.created_at } : null;
  }

  list(): ConfigProfile[] {
    return (this.db.prepare('SELECT * FROM config_profiles ORDER BY created_at ASC').all() as any[])
      .map(r => ({ id: r.id, name: r.name, description: r.description || undefined, settings: JSON.parse(r.settings || '{}'), isActive: r.is_active === 1, createdAt: r.created_at }));
  }

  activate(id: string): boolean {
    this.db.prepare('UPDATE config_profiles SET is_active = 0').run();
    return this.db.prepare('UPDATE config_profiles SET is_active = 1 WHERE id = ?').run(id).changes > 0;
  }

  updateSettings(id: string, settings: Record<string, unknown>): boolean {
    return this.db.prepare('UPDATE config_profiles SET settings = ? WHERE id = ?').run(JSON.stringify(settings), id).changes > 0;
  }

  saveCurrentConfig(id: string, providers: string, defaultProvider: string): boolean {
    const profile = this.get(id);
    if (!profile) return false;
    const settings = { ...profile.settings, providers, 'default-provider': defaultProvider };
    return this.updateSettings(id, settings);
  }

  delete(id: string): boolean {
    // Cannot delete the default (first-created) profile
    if (id === this.defaultProfileId) return false;
    const wasActive = (this.db.prepare('SELECT is_active FROM config_profiles WHERE id = ?').get(id) as any)?.is_active === 1;
    const deleted = this.db.prepare('DELETE FROM config_profiles WHERE id = ?').run(id).changes > 0;
    // If deleted profile was active, activate default
    if (deleted && wasActive) {
      this.db.prepare('UPDATE config_profiles SET is_active = 1 WHERE id = ?').run(this.defaultProfileId);
    }
    return deleted;
  }
}

// ── Team Personas ──────────────────────────────────────────────

export interface Persona { id: string; name: string; domain: string; systemPrompt: string; description?: string; icon?: string; isBuiltin: boolean; createdAt: string; }

const BUILTIN_PERSONAS: Omit<Persona, 'id' | 'createdAt'>[] = [
  { name: 'Frontend Expert', domain: 'frontend', systemPrompt: 'You are a senior frontend developer specializing in React, TypeScript, CSS, and modern web standards. Focus on component architecture, accessibility, and performance.', description: 'React, TypeScript, CSS specialist', icon: '🎨', isBuiltin: true },
  { name: 'Backend Architect', domain: 'backend', systemPrompt: 'You are a senior backend architect specializing in Node.js, databases, APIs, and distributed systems. Focus on scalability, security, and clean architecture.', description: 'Node.js, APIs, databases', icon: '⚙️', isBuiltin: true },
  { name: 'DevOps Engineer', domain: 'devops', systemPrompt: 'You are a DevOps engineer specializing in CI/CD, Docker, Kubernetes, and cloud infrastructure. Focus on automation, reliability, and monitoring.', description: 'CI/CD, Docker, cloud infra', icon: '🚀', isBuiltin: true },
  { name: 'Security Reviewer', domain: 'security', systemPrompt: 'You are a security engineer. Review code for vulnerabilities, suggest secure patterns, and ensure compliance with security best practices.', description: 'Security audits and hardening', icon: '🛡️', isBuiltin: true },
  { name: 'Code Reviewer', domain: 'quality', systemPrompt: 'You are a meticulous code reviewer. Focus on code quality, readability, maintainability, test coverage, and adherence to project conventions.', description: 'Quality and best practices', icon: '🔍', isBuiltin: true },
  { name: 'Technical Writer', domain: 'docs', systemPrompt: 'You are a technical writer. Create clear, concise documentation including API docs, READMEs, architecture docs, and user guides.', description: 'Documentation specialist', icon: '📝', isBuiltin: true },
];

export class PersonaService {
  constructor(private db: Database.Database) { this.ensureBuiltins(); }

  private ensureBuiltins(): void {
    for (const p of BUILTIN_PERSONAS) {
      const existing = this.db.prepare('SELECT id FROM personas WHERE name = ? AND is_builtin = 1').get(p.name) as any;
      if (!existing) {
        this.db.prepare('INSERT INTO personas (id, name, domain, system_prompt, description, icon, is_builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
          .run(randomUUID(), p.name, p.domain, p.systemPrompt, p.description || null, p.icon || null, new Date().toISOString());
      }
    }
  }

  list(): Persona[] {
    return (this.db.prepare('SELECT * FROM personas ORDER BY domain ASC, name ASC').all() as any[])
      .map(r => ({ id: r.id, name: r.name, domain: r.domain, systemPrompt: r.system_prompt, description: r.description || undefined, icon: r.icon || undefined, isBuiltin: r.is_builtin === 1, createdAt: r.created_at }));
  }

  create(opts: { name: string; domain: string; systemPrompt: string; description?: string; icon?: string }): Persona {
    const id = randomUUID();
    this.db.prepare('INSERT INTO personas (id, name, domain, system_prompt, description, icon, is_builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, opts.name, opts.domain, opts.systemPrompt, opts.description || null, opts.icon || null, new Date().toISOString());
    return this.list().find(p => p.id === id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM personas WHERE id = ? AND is_builtin = 0').run(id).changes > 0;
  }
}

// ── Session Status ─────────────────────────────────────────────

export class SessionStatusService {
  constructor(private db: Database.Database) {}

  get(sessionId: string): { status: string; lastActivity?: string } {
    const r = this.db.prepare('SELECT * FROM session_status WHERE session_id = ?').get(sessionId) as any;
    return r ? { status: r.status, lastActivity: r.last_activity || undefined } : { status: 'idle' };
  }

  set(sessionId: string, status: string, lastActivity?: string): void {
    this.db.prepare('INSERT OR REPLACE INTO session_status (session_id, status, last_activity, updated_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, status, lastActivity || null, new Date().toISOString());
  }
}

// ── File-Session Links ─────────────────────────────────────────

export class FileSessionLinkService {
  constructor(private db: Database.Database) {}

  link(sessionId: string, filePath: string, action: string): void {
    this.db.prepare('INSERT INTO file_session_links (id, session_id, file_path, action, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), sessionId, filePath, action, new Date().toISOString());
  }

  getFilesForSession(sessionId: string): { filePath: string; action: string; createdAt: string }[] {
    return (this.db.prepare('SELECT DISTINCT file_path, action, created_at FROM file_session_links WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as any[])
      .map(r => ({ filePath: r.file_path, action: r.action, createdAt: r.created_at }));
  }

  getSessionsForFile(filePath: string): { sessionId: string; action: string; createdAt: string }[] {
    return (this.db.prepare('SELECT DISTINCT session_id, action, created_at FROM file_session_links WHERE file_path = ? ORDER BY created_at DESC').all(filePath) as any[])
      .map(r => ({ sessionId: r.session_id, action: r.action, createdAt: r.created_at }));
  }
}

// ── Plan Archive ───────────────────────────────────────────────

export class PlanArchiveService {
  constructor(private db: Database.Database) {}

  archive(sessionId: string, name: string, snapshot: Record<string, unknown>): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO archived_plans (id, session_id, name, snapshot, archived_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, sessionId, name, JSON.stringify(snapshot), new Date().toISOString());
    return id;
  }

  list(): { id: string; sessionId: string; name: string; archivedAt: string }[] {
    return (this.db.prepare('SELECT id, session_id, name, archived_at FROM archived_plans ORDER BY archived_at DESC').all() as any[])
      .map(r => ({ id: r.id, sessionId: r.session_id, name: r.name, archivedAt: r.archived_at }));
  }

  unarchive(id: string): Record<string, unknown> | null {
    const r = this.db.prepare('SELECT snapshot FROM archived_plans WHERE id = ?').get(id) as any;
    if (r) { this.db.prepare('DELETE FROM archived_plans WHERE id = ?').run(id); return JSON.parse(r.snapshot); }
    return null;
  }
}

// ── Session Alerts ─────────────────────────────────────────────

export class SessionAlertService {
  constructor(private db: Database.Database) {}

  create(sessionId: string, type: string, severity: string, message: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO session_alerts (id, session_id, type, severity, message, dismissed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(id, sessionId, type, severity, message, new Date().toISOString());
    return id;
  }

  getActive(sessionId: string): { id: string; type: string; severity: string; message: string; createdAt: string }[] {
    return (this.db.prepare('SELECT * FROM session_alerts WHERE session_id = ? AND dismissed = 0 ORDER BY created_at DESC').all(sessionId) as any[])
      .map(r => ({ id: r.id, type: r.type, severity: r.severity, message: r.message, createdAt: r.created_at }));
  }

  dismiss(id: string): boolean { return this.db.prepare('UPDATE session_alerts SET dismissed = 1 WHERE id = ?').run(id).changes > 0; }
  dismissAll(sessionId: string): number { return this.db.prepare('UPDATE session_alerts SET dismissed = 1 WHERE session_id = ?').run(sessionId).changes; }
}

// ── Global Search ──────────────────────────────────────────────

export class GlobalSearchService {
  constructor(private db: Database.Database) {}

  index(sessionId: string, contentType: string, content: string, metadata?: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO search_index (id, session_id, content_type, content, metadata, indexed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), sessionId, contentType, content, JSON.stringify(metadata || {}), new Date().toISOString());
  }

  search(query: string, limit?: number): { sessionId: string; contentType: string; content: string; metadata: Record<string, unknown> }[] {
    const pattern = '%' + query.replace(/[%_]/g, '') + '%';
    return (this.db.prepare('SELECT * FROM search_index WHERE content LIKE ? ORDER BY indexed_at DESC LIMIT ?').all(pattern, limit || 50) as any[])
      .map(r => ({ sessionId: r.session_id, contentType: r.content_type, content: r.content, metadata: JSON.parse(r.metadata || '{}') }));
  }
}

// ── Onboarding ─────────────────────────────────────────────────

export class OnboardingService {
  constructor(private db: Database.Database) {}

  getProgress(): { completedSteps: string[]; currentStep: number; dismissed: boolean } {
    const r = this.db.prepare("SELECT * FROM onboarding_progress WHERE user_id = 'default'").get() as any;
    if (r) return { completedSteps: JSON.parse(r.completed_steps || '[]'), currentStep: r.current_step, dismissed: r.dismissed === 1 };
    return { completedSteps: [], currentStep: 0, dismissed: false };
  }

  completeStep(stepId: string): void {
    const progress = this.getProgress();
    if (!progress.completedSteps.includes(stepId)) progress.completedSteps.push(stepId);
    this.db.prepare("INSERT OR REPLACE INTO onboarding_progress (user_id, completed_steps, current_step, dismissed, updated_at) VALUES ('default', ?, ?, ?, ?)")
      .run(JSON.stringify(progress.completedSteps), progress.currentStep + 1, progress.dismissed ? 1 : 0, new Date().toISOString());
  }

  dismiss(): void {
    this.db.prepare("INSERT OR REPLACE INTO onboarding_progress (user_id, completed_steps, current_step, dismissed, updated_at) VALUES ('default', '[]', 0, 1, ?)")
      .run(new Date().toISOString());
  }
}

// ── Decision Log ───────────────────────────────────────────────

export interface Decision { id: string; projectId: string; title: string; context?: string; alternatives?: string; reasoning?: string; tradeoffs?: string; status: string; createdAt: string; }

export class DecisionLogService {
  constructor(private db: Database.Database) {}

  create(opts: { projectId: string; title: string; context?: string; alternatives?: string; reasoning?: string; tradeoffs?: string }): Decision {
    const id = randomUUID();
    this.db.prepare('INSERT INTO decision_log (id, project_id, title, context, alternatives, reasoning, tradeoffs, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, opts.projectId, opts.title, opts.context || null, opts.alternatives || null, opts.reasoning || null, opts.tradeoffs || null, 'active', new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): Decision | null {
    const r = this.db.prepare('SELECT * FROM decision_log WHERE id = ?').get(id) as any;
    return r ? { id: r.id, projectId: r.project_id, title: r.title, context: r.context || undefined, alternatives: r.alternatives || undefined, reasoning: r.reasoning || undefined, tradeoffs: r.tradeoffs || undefined, status: r.status, createdAt: r.created_at } : null;
  }

  list(projectId: string): Decision[] {
    return (this.db.prepare('SELECT * FROM decision_log WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as any[])
      .map(r => ({ id: r.id, projectId: r.project_id, title: r.title, context: r.context || undefined, alternatives: r.alternatives || undefined, reasoning: r.reasoning || undefined, tradeoffs: r.tradeoffs || undefined, status: r.status, createdAt: r.created_at }));
  }

  supersede(id: string): boolean { return this.db.prepare("UPDATE decision_log SET status = 'superseded' WHERE id = ?").run(id).changes > 0; }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM decision_log WHERE id = ?').run(id).changes > 0; }
}
