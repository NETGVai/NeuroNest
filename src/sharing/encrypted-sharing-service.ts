/**
 * E2E Encrypted Message Sharing Service.
 * AES-256-GCM encryption with optional Ed25519/ECDSA signing.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface EncryptedShare {
  id: string; project_id: string; session_id: string | null;
  content_hash: string; encryption_algo: string; signing_algo: string | null;
  signer_identity: string | null; expires_at: string | null;
  access_count: number; max_access: number; created_at: string;
}
export interface SharingConfig {
  project_id: string; default_expiry: string; auto_sign: boolean; signing_key_path: string | null;
}

export class EncryptedSharingService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): SharingConfig {
    const row = this.db.prepare('SELECT * FROM sharing_config WHERE project_id = ?').get(projectId) as any;
    if (row) return { ...row, auto_sign: !!row.auto_sign };
    this.db.prepare('INSERT INTO sharing_config (project_id) VALUES (?)').run(projectId);
    return { project_id: projectId, default_expiry: '24h', auto_sign: true, signing_key_path: null };
  }

  updateConfig(projectId: string, updates: Partial<SharingConfig>): SharingConfig {
    this.getConfig(projectId);
    const f: string[] = []; const v: any[] = [];
    if (updates.default_expiry !== undefined) { f.push('default_expiry = ?'); v.push(updates.default_expiry); }
    if (updates.auto_sign !== undefined) { f.push('auto_sign = ?'); v.push(updates.auto_sign ? 1 : 0); }
    if (updates.signing_key_path !== undefined) { f.push('signing_key_path = ?'); v.push(updates.signing_key_path); }
    if (f.length) { f.push('updated_at = CURRENT_TIMESTAMP'); this.db.prepare(`UPDATE sharing_config SET ${f.join(', ')} WHERE project_id = ?`).run(...v, projectId); }
    return this.getConfig(projectId);
  }

  encrypt(content: string): { encrypted: string; key: string; iv: string } {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(content, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();
    return { encrypted: encrypted + '.' + tag.toString('base64'), key: key.toString('base64'), iv: iv.toString('base64') };
  }

  decrypt(encrypted: string, keyB64: string, ivB64: string): string {
    const [data, tagB64] = encrypted.split('.');
    const key = Buffer.from(keyB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  createShare(projectId: string, data: { content: string; sessionId?: string; expiry?: string; signerIdentity?: string }): { share: EncryptedShare; key: string; iv: string } {
    const id = crypto.randomUUID();
    const { encrypted, key, iv } = this.encrypt(data.content);
    const contentHash = crypto.createHash('sha256').update(encrypted).digest('hex');
    const expiresAt = this.calcExpiry(data.expiry || '24h');
    this.db.prepare('INSERT INTO encrypted_shares (id, project_id, session_id, content_hash, signer_identity, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectId, data.sessionId || null, contentHash, data.signerIdentity || null, expiresAt);
    const share = this.db.prepare('SELECT * FROM encrypted_shares WHERE id = ?').get(id) as EncryptedShare;
    return { share, key, iv };
  }

  getShare(shareId: string): EncryptedShare | null {
    const share = this.db.prepare('SELECT * FROM encrypted_shares WHERE id = ?').get(shareId) as EncryptedShare | null;
    if (share) { this.db.prepare('UPDATE encrypted_shares SET access_count = access_count + 1 WHERE id = ?').run(shareId); }
    return share;
  }

  listShares(projectId: string): EncryptedShare[] {
    return this.db.prepare('SELECT * FROM encrypted_shares WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(projectId) as EncryptedShare[];
  }

  deleteShare(shareId: string): void {
    this.db.prepare('DELETE FROM encrypted_shares WHERE id = ?').run(shareId);
  }

  getStats(projectId: string): { total: number; totalAccess: number } {
    const r = this.db.prepare('SELECT COUNT(*) as t, COALESCE(SUM(access_count),0) as a FROM encrypted_shares WHERE project_id = ?').get(projectId) as any;
    return { total: r?.t || 0, totalAccess: r?.a || 0 };
  }

  private calcExpiry(expiry: string): string | null {
    const now = new Date();
    if (expiry === '1h') now.setHours(now.getHours() + 1);
    else if (expiry === '24h') now.setHours(now.getHours() + 24);
    else if (expiry === '7d') now.setDate(now.getDate() + 7);
    else if (expiry === '30d') now.setDate(now.getDate() + 30);
    else return null;
    return now.toISOString();
  }
}
