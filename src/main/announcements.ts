/**
 * Announcements Service — in-app announcements from the NeuroNest domain.
 *
 * Features:
 * - Fetches versioned static announcement feed from neuronest.cc
 * - Version targeting, publication/expiry dates, severity, link, dismissibility
 * - Dismissed state persists across restarts (unless revision changes)
 * - Feed failure is silent (no startup delay)
 * - External links through hardened navigation path
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5
 */

import type Database from 'better-sqlite3';

// ─── Types ──────────────────────────────────────────────────────

export interface Announcement {
  id: string;
  revision: number;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  link?: string | undefined;
  dismissible: boolean;
  publishedAt: string;
  expiresAt?: string | undefined;
  targetVersionMin?: string | undefined;
  targetVersionMax?: string | undefined;
}

export interface AnnouncementFeed {
  version: number;
  announcements: Announcement[];
}

export interface DismissedRecord {
  announcementId: string;
  revision: number;
  dismissedAt: string;
}

// ─── Announcements Service ──────────────────────────────────────

export class AnnouncementsService {
  private db: Database.Database;
  private feedUrl: string;
  private appVersion: string;

  constructor(db: Database.Database, options?: { feedUrl?: string; appVersion?: string }) {
    this.db = db;
    this.feedUrl = options?.feedUrl || 'https://neuronest.cc/announcements/feed.json';
    this.appVersion = options?.appVersion || '0.0.0';
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS announcements_dismissed (
          announcement_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (announcement_id, revision)
        )
      `);
    } catch { /* non-fatal */ }
  }

  /**
   * Fetch and filter announcements.
   * Returns only active, non-dismissed, version-targeted announcements.
   * Failure is silent (Req 27.4).
   */
  async getActiveAnnouncements(): Promise<Announcement[]> {
    let feed: AnnouncementFeed;
    try {
      feed = await this.fetchFeed();
    } catch {
      // Feed failure is silent — no startup delay (Req 27.4)
      return [];
    }

    const now = new Date().toISOString();
    const dismissed = this.getDismissedSet();

    return feed.announcements.filter((a) => {
      // Check publication date
      if (a.publishedAt > now) return false;
      // Check expiry
      if (a.expiresAt && a.expiresAt < now) return false;
      // Check version targeting
      if (!this.matchesVersion(a)) return false;
      // Check dismissed (revision must match)
      const key = a.id + ':' + a.revision;
      if (dismissed.has(key)) return false;
      return true;
    });
  }

  /**
   * Dismiss an announcement. Persists across restarts.
   * Revised announcements (different revision) redisplay.
   *
   * Requirement 27.3
   */
  dismiss(announcementId: string, revision: number): void {
    try {
      this.db.prepare(
        `INSERT OR REPLACE INTO announcements_dismissed (announcement_id, revision, dismissed_at)
         VALUES (?, ?, datetime('now'))`,
      ).run(announcementId, revision);
    } catch { /* non-fatal */ }
  }

  /**
   * Check if an announcement is dismissed at its current revision.
   */
  isDismissed(announcementId: string, revision: number): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM announcements_dismissed WHERE announcement_id = ? AND revision = ?`,
    ).get(announcementId, revision);
    return !!row;
  }

  /**
   * Get all dismissed announcement IDs with their revisions.
   */
  getDismissedList(): DismissedRecord[] {
    return this.db.prepare(
      `SELECT announcement_id, revision, dismissed_at FROM announcements_dismissed`,
    ).all() as any[];
  }

  // ─── Private ──────────────────────────────────────────────────

  private async fetchFeed(): Promise<AnnouncementFeed> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    try {
      const response = await fetch(this.feedUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) throw new Error('Feed fetch failed: ' + response.status);
      return await response.json() as AnnouncementFeed;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getDismissedSet(): Set<string> {
    const rows = this.db.prepare(
      `SELECT announcement_id, revision FROM announcements_dismissed`,
    ).all() as { announcement_id: string; revision: number }[];
    return new Set(rows.map((r) => r.announcement_id + ':' + r.revision));
  }

  private matchesVersion(announcement: Announcement): boolean {
    if (!announcement.targetVersionMin && !announcement.targetVersionMax) return true;
    const current = this.parseVersion(this.appVersion);
    if (!current) return true; // can't parse — show anyway

    if (announcement.targetVersionMin) {
      const min = this.parseVersion(announcement.targetVersionMin);
      if (min && this.compareVersions(current, min) < 0) return false;
    }
    if (announcement.targetVersionMax) {
      const max = this.parseVersion(announcement.targetVersionMax);
      if (max && this.compareVersions(current, max) > 0) return false;
    }
    return true;
  }

  private parseVersion(v: string): number[] | null {
    const parts = v.split('.').map(Number);
    if (parts.some(isNaN)) return null;
    return parts;
  }

  private compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const ai = a[i] || 0;
      const bi = b[i] || 0;
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
    return 0;
  }
}
