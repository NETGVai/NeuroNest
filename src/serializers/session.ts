import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PackSync, Parser } from 'tar';
import { SessionSchema } from '../shared/schemas.js';
import type { Session } from '../shared/types.js';

const SESSION_FILE = 'session.json';
const MESSAGES_FILE = 'messages.json';

/**
 * Serializes a Date to ISO string for JSON storage.
 */
function serializeSession(session: Session): { sessionJson: string; messagesJson: string } {
  const { messages, ...metadata } = session;
  const sessionJson = JSON.stringify({
    ...metadata,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  }, null, 2);

  const messagesJson = JSON.stringify(
    messages.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    })),
    null,
    2,
  );

  return { sessionJson, messagesJson };
}

/**
 * Exports a Session as a tar.gz archive containing session.json and messages.json.
 * Validates: Requirements 11.6, 11.7
 */
export function exportSession(session: Session): Buffer {
  const dir = join(tmpdir(), `session-export-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(dir, { recursive: true });
    const { sessionJson, messagesJson } = serializeSession(session);
    writeFileSync(join(dir, SESSION_FILE), sessionJson, 'utf-8');
    writeFileSync(join(dir, MESSAGES_FILE), messagesJson, 'utf-8');

    const chunks: Buffer[] = [];
    const pack = new PackSync({ gzip: true, cwd: dir });
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.add(SESSION_FILE);
    pack.add(MESSAGES_FILE);
    pack.end();
    return Buffer.concat(chunks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Imports a Session from a tar.gz archive.
 * Validates: Requirements 11.7, 11.8
 */
export function importSession(archive: Buffer): Promise<Session> {
  const decompressed = gunzipSync(archive);
  const files: Record<string, string> = {};

  return new Promise((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry: any) => {
        if (entry.path !== SESSION_FILE && entry.path !== MESSAGES_FILE) {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          files[entry.path] = Buffer.concat(chunks).toString('utf-8');
        });
      },
    });

    parser.on('end', () => {
      try {
        if (!files[SESSION_FILE] || !files[MESSAGES_FILE]) {
          throw new Error('Archive missing required files: session.json and/or messages.json');
        }
        const metadata = JSON.parse(files[SESSION_FILE]);
        const messages = JSON.parse(files[MESSAGES_FILE]);
        const session = { ...metadata, messages };
        resolve(SessionSchema.parse(session));
      } catch (err) {
        reject(err);
      }
    });

    parser.on('error', reject);
    parser.write(decompressed);
    parser.end();
  });
}
