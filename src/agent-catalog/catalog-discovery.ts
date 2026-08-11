import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface CatalogManifestEntry {
  /** Root-relative path using forward slashes. */
  readonly sourcePath: string;
  /** Canonical absolute path after resolving symbolic links. */
  readonly absolutePath: string;
  /** SHA-256 digest of the source bytes captured during discovery. */
  readonly sourceHash: string;
}

export interface CatalogManifest {
  /** Canonical absolute catalog root. */
  readonly rootPath: string;
  /** Unique entries sorted by sourcePath. */
  readonly entries: readonly CatalogManifestEntry[];
}

const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules']);
const EXCLUDED_FILE_NAMES = new Set(['README.md']);

/**
 * Applies the same source-membership exclusions formerly owned by the importer.
 * Hidden directories and node_modules are traversal concerns; README.md is the
 * only markdown filename explicitly treated as non-agent documentation.
 */
export function isEligibleAgentMarkdownPath(sourcePath: string): boolean {
  const normalizedPath = sourcePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  const fileName = segments.at(-1);

  if (!fileName || !fileName.endsWith('.md') || EXCLUDED_FILE_NAMES.has(fileName)) {
    return false;
  }

  return segments
    .slice(0, -1)
    .every((segment) => !segment.startsWith('.') && !EXCLUDED_DIRECTORY_NAMES.has(segment));
}

/**
 * Returns true only when candidatePath is rootPath itself or is contained by it.
 * Both arguments must already be canonical absolute paths.
 */
export function isPathWithinCatalogRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

function assertPathWithinCatalogRoot(rootPath: string, candidatePath: string): void {
  if (!isPathWithinCatalogRoot(rootPath, candidatePath)) {
    throw new Error(`Catalog path escapes root: ${candidatePath}`);
  }
}

function toSourcePath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join('/');
}

function freezeEntry(entry: CatalogManifestEntry): CatalogManifestEntry {
  return Object.freeze(entry);
}

/**
 * Dynamically discovers the complete eligible markdown catalog beneath rootPath.
 * Paths are canonicalized and containment-checked before traversal or inclusion.
 * Membership is derived solely from the current filesystem contents.
 */
export async function discoverCatalog(rootPath: string): Promise<CatalogManifest> {
  const canonicalRoot = await realpath(resolve(rootPath));
  const rootStats = await stat(canonicalRoot);
  if (!rootStats.isDirectory()) {
    throw new Error(`Catalog root is not a directory: ${canonicalRoot}`);
  }

  const entriesByCanonicalPath = new Map<string, CatalogManifestEntry>();
  const visitedDirectories = new Set<string>();

  const visitDirectory = async (directoryPath: string): Promise<void> => {
    const canonicalDirectory = await realpath(directoryPath);
    assertPathWithinCatalogRoot(canonicalRoot, canonicalDirectory);

    if (visitedDirectories.has(canonicalDirectory)) {
      return;
    }
    visitedDirectories.add(canonicalDirectory);

    const directoryEntries = await readdir(canonicalDirectory, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const directoryEntry of directoryEntries) {
      if (
        EXCLUDED_DIRECTORY_NAMES.has(directoryEntry.name)
        || (directoryEntry.isDirectory() && directoryEntry.name.startsWith('.'))
      ) {
        continue;
      }

      const lexicalPath = resolve(canonicalDirectory, directoryEntry.name);
      const canonicalPath = await realpath(lexicalPath);
      assertPathWithinCatalogRoot(canonicalRoot, canonicalPath);

      const entryStats = await stat(canonicalPath);
      if (entryStats.isDirectory()) {
        if (directoryEntry.name.startsWith('.')) {
          continue;
        }
        await visitDirectory(canonicalPath);
        continue;
      }

      if (!entryStats.isFile()) {
        continue;
      }

      const sourcePath = toSourcePath(canonicalRoot, canonicalPath);
      if (!isEligibleAgentMarkdownPath(sourcePath)) {
        continue;
      }

      const sourceBytes = await readFile(canonicalPath);
      const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
      const nextEntry = freezeEntry({
        sourcePath,
        absolutePath: canonicalPath,
        sourceHash,
      });

      const existing = entriesByCanonicalPath.get(canonicalPath);
      if (!existing || nextEntry.sourcePath.localeCompare(existing.sourcePath) < 0) {
        entriesByCanonicalPath.set(canonicalPath, nextEntry);
      }
    }
  };

  await visitDirectory(canonicalRoot);

  const entries = Array.from(entriesByCanonicalPath.values())
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  return Object.freeze({
    rootPath: canonicalRoot,
    entries: Object.freeze(entries),
  });
}
