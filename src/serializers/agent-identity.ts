import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PackSync, Parser } from 'tar';
import { AgentIdentitySchema } from '../shared/schemas.js';
import type { AgentIdentity } from '../shared/types.js';

const FILE_MAP: Record<keyof AgentIdentity, string> = {
  soul: 'SOUL.md',
  identity: 'IDENTITY.md',
  tools: 'TOOLS.md',
  claude: 'CLAUDE.md',
};

const REVERSE_FILE_MAP: Record<string, keyof AgentIdentity> = Object.fromEntries(
  Object.entries(FILE_MAP).map(([k, v]) => [v, k as keyof AgentIdentity]),
);

/**
 * Exports an AgentIdentity as a tar.gz archive containing
 * SOUL.md, IDENTITY.md, TOOLS.md, and CLAUDE.md.
 * Validates: Requirements 8.5, 8.6
 */
export function exportIdentity(identity: AgentIdentity): Buffer {
  const dir = join(tmpdir(), `agent-identity-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(dir, { recursive: true });
    for (const [field, filename] of Object.entries(FILE_MAP)) {
      writeFileSync(join(dir, filename), identity[field as keyof AgentIdentity], 'utf-8');
    }

    const chunks: Buffer[] = [];
    const pack = new PackSync({ gzip: true, cwd: dir });
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    for (const filename of Object.values(FILE_MAP)) {
      pack.add(filename);
    }
    pack.end();
    return Buffer.concat(chunks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Imports an AgentIdentity from a tar.gz archive.
 * Validates: Requirements 8.5, 8.7
 */
export function importIdentity(archive: Buffer): Promise<AgentIdentity> {
  const decompressed = gunzipSync(archive);
  const result: Partial<AgentIdentity> = {};

  return new Promise((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry: any) => {
        const field = REVERSE_FILE_MAP[entry.path];
        if (!field) {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
        entry.on('end', () => {
          result[field] = Buffer.concat(chunks).toString('utf-8');
        });
      },
    });

    parser.on('end', () => {
      try {
        resolve(AgentIdentitySchema.parse(result));
      } catch (err) {
        reject(err);
      }
    });

    parser.on('error', reject);
    parser.write(decompressed);
    parser.end();
  });
}
