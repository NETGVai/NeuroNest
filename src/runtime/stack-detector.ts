import { access, readdir, readFile, stat } from 'fs/promises';
import { join, basename } from 'path';
import type { StackType, ServiceDefinition, DetectionResult } from './types.js';

/**
 * Error thrown when no recognized stack marker files are found in a project directory.
 */
export class UnsupportedProjectError extends Error {
  constructor(projectPath: string) {
    super(
      `Could not detect project type. Supported: Node.js, Go, Rust, Python, Static HTML.`,
    );
    this.name = 'UnsupportedProjectError';
  }
}

/** Marker file → stack type mapping (priority order) */
const MARKER_MAP: ReadonlyArray<{ file: string; stackType: StackType }> = [
  { file: 'package.json', stackType: 'nodejs' },
  { file: 'go.mod', stackType: 'go' },
  { file: 'Cargo.toml', stackType: 'rust' },
  { file: 'requirements.txt', stackType: 'python' },
  { file: 'pyproject.toml', stackType: 'python' },
  { file: 'index.html', stackType: 'static-html' },
];

/** Well-known subdirectory names that indicate separate services */
const SERVICE_SUBDIRS = [
  'frontend', 'client', 'web', 'app', 'ui',
  'backend', 'server', 'api', 'service', 'services',
];

export class StackDetector {
  /**
   * Detect the tech stack of a project by inspecting marker files.
   * Scans subdirectories for frontend/backend structures.
   */
  async detect(projectPath: string): Promise<DetectionResult> {
    const services: ServiceDefinition[] = [];

    // 1. Check for service subdirectories (frontend/, backend/, etc.)
    const subServices = await this.detectSubdirectoryServices(projectPath);
    if (subServices.length > 0) {
      services.push(...subServices);
    }

    // 2. Check root-level markers (may find multiple stacks in same dir)
    const rootStacks = await this.detectAllStacksInDir(projectPath);
    if (rootStacks.length > 0) {
      if (subServices.length > 0) {
        // If we found subdirectory services, only add root if it's not a monorepo orchestrator
        const isMonorepoRoot = await this.isMonorepoRoot(projectPath);
        if (!isMonorepoRoot) {
          for (const st of rootStacks) {
            services.push({ name: st, stackType: st, rootPath: projectPath });
          }
        }
      } else {
        // Single root project — check if it has both frontend and backend
        const splitServices = await this.detectFrontendBackendSplit(projectPath, rootStacks);
        if (splitServices.length > 1) {
          services.push(...splitServices);
        } else {
          for (const st of rootStacks) {
            services.push({ name: st, stackType: st, rootPath: projectPath });
          }
        }
      }
    }

    // 3. Fallback: heuristic detection
    if (services.length === 0) {
      const fallback = await this.heuristicDetect(projectPath);
      if (fallback) {
        services.push(fallback);
      } else {
        throw new UnsupportedProjectError(projectPath);
      }
    }

    return {
      services,
      isMultiService: services.length > 1,
    };
  }

  /**
   * Detect if a single-root project has both frontend and backend components
   * that should be run as separate services.
   */
  private async detectFrontendBackendSplit(projectPath: string, rootStacks: StackType[]): Promise<ServiceDefinition[]> {
    const services: ServiceDefinition[] = [];

    try {
      const entries = await readdir(projectPath);
      const hasPublicDir = entries.includes('public') || entries.includes('static') || entries.includes('dist');
      const hasIndexHtml = entries.includes('index.html') || await this.fileExists(join(projectPath, 'public', 'index.html'));

      // Check package.json for frontend/backend script indicators
      let hasFrontendScript = false;
      let hasBackendScript = false;
      let pkgScripts: Record<string, string> = {};

      if (await this.fileExists(join(projectPath, 'package.json'))) {
        try {
          const raw = await readFile(join(projectPath, 'package.json'), 'utf-8');
          const pkg = JSON.parse(raw);
          pkgScripts = pkg.scripts || {};
          const allScripts = Object.entries(pkgScripts);

          for (const [name, cmd] of allScripts) {
            const cmdStr = String(cmd).toLowerCase();
            // Frontend indicators
            if (name.match(/^(dev|start|serve|frontend|client|web)$/) && cmdStr.match(/vite|react-scripts|next|webpack|parcel|serve/)) {
              hasFrontendScript = true;
            }
            // Backend indicators
            if (name.match(/^(server|backend|api|start:server|dev:server)$/) && cmdStr.match(/node|nodemon|ts-node|tsx|python|flask|express/)) {
              hasBackendScript = true;
            }
          }

          // If start script uses concurrently, both are in one command
          const startCmd = pkgScripts['start'] || pkgScripts['dev'] || '';
          if (startCmd.includes('concurrently')) {
            hasFrontendScript = true;
            hasBackendScript = true;
          }
        } catch {}
      }

      // Check for server entry files (backend indicators)
      const serverFiles = ['server.js', 'server.ts', 'app.js', 'app.ts', 'main.py', 'app.py', 'index.js', 'index.ts'];
      let hasServerFile = false;
      for (const sf of serverFiles) {
        if (entries.includes(sf)) {
          // Verify it's actually a server (contains listen/express/flask/http)
          try {
            const content = await readFile(join(projectPath, sf), 'utf-8');
            if (content.match(/\.listen\(|express\(|Flask\(|createServer|http\.server|fastify|koa|hono/i)) {
              hasServerFile = true;
              break;
            }
          } catch {}
        }
      }
      // Also check src/ for server files
      if (!hasServerFile && entries.includes('src')) {
        try {
          const srcEntries = await readdir(join(projectPath, 'src'));
          for (const sf of serverFiles) {
            if (srcEntries.includes(sf)) {
              try {
                const content = await readFile(join(projectPath, 'src', sf), 'utf-8');
                if (content.match(/\.listen\(|express\(|Flask\(|createServer|http\.server|fastify|koa|hono/i)) {
                  hasServerFile = true;
                  break;
                }
              } catch {}
            }
          }
        } catch {}
      }

      // Determine if we should split into frontend + backend
      const hasFrontend = hasIndexHtml || hasPublicDir || hasFrontendScript;
      const hasBackend = hasServerFile || hasBackendScript;

      if (hasFrontend && hasBackend) {
        // Split into two services
        // Backend: run the server
        const backendStack = rootStacks.includes('python') ? 'python' : 'nodejs';
        services.push({ name: 'backend', stackType: backendStack as StackType, rootPath: projectPath });

        // Frontend: serve static files from public/ or the root
        const frontendPath = hasPublicDir
          ? join(projectPath, entries.includes('public') ? 'public' : entries.includes('static') ? 'static' : 'dist')
          : projectPath;
        services.push({ name: 'frontend', stackType: 'static-html', rootPath: frontendPath });
      }
    } catch {}

    return services;
  }

  /**
   * Scan well-known subdirectories for separate services.
   * Checks both root-level and src/ subdirectories.
   */
  private async detectSubdirectoryServices(projectPath: string): Promise<ServiceDefinition[]> {
    const services: ServiceDefinition[] = [];
    const seen = new Set<string>();

    // Scan root-level directories
    await this.scanDirForServices(projectPath, services, seen);

    // Also scan src/ subdirectory — many projects put frontend/backend inside src/
    const srcPath = join(projectPath, 'src');
    try {
      const s = await stat(srcPath);
      if (s.isDirectory()) {
        await this.scanDirForServices(srcPath, services, seen);
      }
    } catch {}

    return services;
  }

  /**
   * Scan a directory for well-known service subdirectories.
   */
  private async scanDirForServices(
    dirPath: string,
    services: ServiceDefinition[],
    seen: Set<string>,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      return;
    }

    for (const dirName of entries) {
      const lowerName = dirName.toLowerCase();
      if (!SERVICE_SUBDIRS.includes(lowerName)) continue;

      const role = this.classifyRole(lowerName);
      if (seen.has(role)) continue; // Don't add duplicate roles

      const subPath = join(dirPath, dirName);
      try {
        const s = await stat(subPath);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }

      // Detect the actual stack type of this subdirectory
      const detectedStack = await this.detectStackInDir(subPath);
      if (detectedStack) {
        seen.add(role);
        services.push({
          name: role,
          stackType: detectedStack,
          rootPath: subPath,
        });
      } else {
        // Fallback: check if directory has runnable code
        const hasCode = await this.dirHasRunnableCode(subPath);
        if (hasCode) {
          // Infer stack type from files present
          const inferredStack = await this.inferStackFromFiles(subPath);
          seen.add(role);
          services.push({
            name: role,
            stackType: inferredStack,
            rootPath: subPath,
          });
        }
      }
    }
  }

  /**
   * Infer stack type from files in a directory when no marker file is found.
   */
  private async inferStackFromFiles(dirPath: string): Promise<StackType> {
    try {
      const entries = await readdir(dirPath);
      // Check for index.html (static frontend)
      if (entries.includes('index.html')) return 'static-html';
      // Check for Python files
      if (entries.some(e => e.endsWith('.py'))) return 'python';
      // Check for Go files
      if (entries.some(e => e.endsWith('.go'))) return 'go';
      // Check for Rust files
      if (entries.some(e => e.endsWith('.rs'))) return 'rust';
      // Default to nodejs for JS/TS files
      if (entries.some(e => e.endsWith('.js') || e.endsWith('.ts') || e.endsWith('.tsx') || e.endsWith('.jsx'))) return 'nodejs';
    } catch {}
    return 'nodejs'; // ultimate fallback
  }

  /**
   * Check if a directory contains runnable code files.
   */
  private async dirHasRunnableCode(dirPath: string): Promise<boolean> {
    try {
      const entries = await readdir(dirPath);
      return entries.some(e =>
        e.endsWith('.js') || e.endsWith('.ts') || e.endsWith('.tsx') ||
        e.endsWith('.jsx') || e.endsWith('.py') || e === 'package.json'
      );
    } catch {
      return false;
    }
  }

  /**
   * Classify a subdirectory name into a role (frontend/backend).
   */
  private classifyRole(dirName: string): string {
    const frontendNames = ['frontend', 'client', 'web', 'app', 'ui'];
    const backendNames = ['backend', 'server', 'api', 'service', 'services'];
    if (frontendNames.includes(dirName)) return 'frontend';
    if (backendNames.includes(dirName)) return 'backend';
    return dirName;
  }

  /**
   * Detect all stack types in a single directory by checking marker files.
   * Returns all found types (for multi-stack root directories).
   */
  private async detectAllStacksInDir(dirPath: string): Promise<StackType[]> {
    const found: StackType[] = [];
    const seen = new Set<StackType>();
    for (const marker of MARKER_MAP) {
      if (await this.fileExists(join(dirPath, marker.file))) {
        if (!seen.has(marker.stackType)) {
          seen.add(marker.stackType);
          found.push(marker.stackType);
        }
      }
    }
    // static-html only if it's the sole marker
    if (found.length > 1) {
      const idx = found.indexOf('static-html');
      if (idx !== -1) found.splice(idx, 1);
    }
    return found;
  }

  /**
   * Detect the primary stack type in a single directory (first match).
   */
  private async detectStackInDir(dirPath: string): Promise<StackType | null> {
    for (const marker of MARKER_MAP) {
      if (await this.fileExists(join(dirPath, marker.file))) {
        if (marker.stackType === 'static-html') continue;
        return marker.stackType;
      }
    }
    if (await this.fileExists(join(dirPath, 'index.html'))) {
      return 'static-html';
    }
    return null;
  }

  /**
   * Check if a root package.json is just a monorepo orchestrator
   * (scripts that delegate to subdirs via concurrently, lerna, etc.)
   */
  private async isMonorepoRoot(projectPath: string): Promise<boolean> {
    try {
      const raw = await readFile(join(projectPath, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts || {};
      const allScripts = Object.values(scripts).join(' ');
      // If scripts reference subdirectories or use concurrently/lerna/turbo
      if (/concurrently|lerna|turbo|cd\s+(frontend|backend|client|server|api)/i.test(allScripts)) {
        return true;
      }
      // If it has workspaces, it's a monorepo
      if (pkg.workspaces) return true;
    } catch {}
    return false;
  }

  /**
   * Heuristic fallback: scan files for common patterns.
   */
  private async heuristicDetect(projectPath: string): Promise<ServiceDefinition | null> {
    try {
      const entries = await readdir(projectPath);
      const hasExt = (ext: string) => entries.some(e => e.endsWith(ext));

      if (hasExt('.ts') || hasExt('.js') || hasExt('.tsx') || hasExt('.jsx')) {
        return { name: 'nodejs', stackType: 'nodejs', rootPath: projectPath };
      }
      if (hasExt('.py')) {
        return { name: 'python', stackType: 'python', rootPath: projectPath };
      }
      if (hasExt('.go')) {
        return { name: 'go', stackType: 'go', rootPath: projectPath };
      }
      if (hasExt('.rs')) {
        return { name: 'rust', stackType: 'rust', rootPath: projectPath };
      }
      if (hasExt('.html')) {
        return { name: 'static-html', stackType: 'static-html', rootPath: projectPath };
      }

      // Check src/ subdirectory
      if (entries.includes('src')) {
        const srcEntries = await readdir(join(projectPath, 'src')).catch(() => [] as string[]);
        const srcHasExt = (ext: string) => srcEntries.some(e => e.endsWith(ext));
        if (srcHasExt('.ts') || srcHasExt('.js') || srcHasExt('.tsx') || srcHasExt('.jsx')) {
          return { name: 'nodejs', stackType: 'nodejs', rootPath: projectPath };
        }
        if (srcHasExt('.py')) {
          return { name: 'python', stackType: 'python', rootPath: projectPath };
        }
      }
    } catch {}
    return null;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private deduplicateByStack(
    markers: Array<{ file: string; stackType: StackType }>,
  ): Array<{ file: string; stackType: StackType }> {
    const seen = new Set<StackType>();
    const result: Array<{ file: string; stackType: StackType }> = [];
    for (const marker of markers) {
      if (!seen.has(marker.stackType)) {
        seen.add(marker.stackType);
        result.push(marker);
      }
    }
    return result;
  }
}
