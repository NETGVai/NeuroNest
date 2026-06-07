import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { access, mkdir, readdir, copyFile, stat, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { StackType, ServiceDefinition } from './types.js';

/**
 * Runs project services in isolated runtime directories with all
 * dependencies installed — a lightweight virtual environment without Docker.
 */
export class NativeProcessRunner {
  private processes: Map<string, ChildProcess> = new Map();
  private runtimeDirs: Map<string, string> = new Map();

  /**
   * Prepare an isolated runtime directory for a service.
   * Copies project files and scaffolds missing config if needed.
   */
  async prepareEnvironment(
    serviceId: string,
    service: ServiceDefinition,
    onLog: (line: string) => void,
  ): Promise<string> {
    const runtimeBase = join(homedir(), '.neuronest', 'runtimes');
    await mkdir(runtimeBase, { recursive: true });

    const runtimeDir = join(runtimeBase, `${serviceId}-${Date.now()}`);
    await mkdir(runtimeDir, { recursive: true });
    this.runtimeDirs.set(serviceId, runtimeDir);

    onLog(`[env] Creating isolated runtime in ${runtimeDir}`);
    await this.copyDir(service.rootPath, runtimeDir);
    onLog('[env] Project files copied.');

    // Scaffold package.json if missing for nodejs projects
    if (service.stackType === 'nodejs') {
      const isBackend = service.name === 'backend' || service.name === 'server' || service.name === 'api';
      await this.scaffoldNodeProject(runtimeDir, onLog, isBackend);
    }

    return runtimeDir;
  }

  /**
   * Scaffold a package.json and determine the right entry point
   * for Node.js projects that don't have one.
   */
  private async scaffoldNodeProject(runtimeDir: string, onLog: (line: string) => void, isBackend: boolean = false): Promise<void> {
    const hasPkg = await this.fileExists(join(runtimeDir, 'package.json'));
    if (hasPkg) {
      try {
        const raw = await readFile(join(runtimeDir, 'package.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.scripts && (parsed.scripts.start || parsed.scripts.dev)) return;
        onLog('[scaffold] package.json has no start/dev script, enhancing...');
      } catch {
        onLog('[scaffold] package.json is invalid, regenerating...');
      }
    }

    onLog('[scaffold] Analyzing file contents...');

    // Scan ALL code files and classify by actual content, not filename/directory
    const codeFiles = await this.listCodeFiles(runtimeDir);
    let serverEntry: string | null = null;
    let reactEntry: string | null = null;

    for (const file of codeFiles) {
      try {
        const content = await readFile(join(runtimeDir, file), 'utf-8');
        const isServer = content.includes('.listen(') ||
          content.includes("require('express')") || content.includes('require("express")') ||
          content.includes("from 'express'") || content.includes('from "express"') ||
          content.includes("require('http')") || content.includes("require('koa')") ||
          content.includes("require('fastify')");
        const isReact = content.includes('React') || content.includes('createRoot') ||
          content.includes('ReactDOM') || content.includes('from \'react\'') ||
          content.includes('from "react"');

        if (isServer && !serverEntry) {
          serverEntry = file;
          onLog('[scaffold] Found server code in: ' + file);
        }
        if (isReact && !reactEntry) {
          reactEntry = file;
          onLog('[scaffold] Found React code in: ' + file);
        }
      } catch {}
    }

    // Decide: if we found server code, set up as backend; if React, set up as frontend
    if (isBackend && serverEntry) {
      await this.scaffoldAsBackend(runtimeDir, serverEntry, onLog);
    } else if (isBackend && !serverEntry && reactEntry) {
      // Directory named "backend" but code is React — treat as frontend
      onLog('[scaffold] Backend dir contains React code, setting up as frontend');
      await this.scaffoldAsFrontend(runtimeDir, onLog);
    } else if (isBackend) {
      // Backend with no clear entry — try any JS file
      const entry = await this.findNodeEntry(runtimeDir);
      await this.scaffoldAsBackend(runtimeDir, entry, onLog);
    } else if (reactEntry || await this.looksLikeReact(runtimeDir)) {
      await this.scaffoldAsFrontend(runtimeDir, onLog);
    } else if (serverEntry) {
      await this.scaffoldAsBackend(runtimeDir, serverEntry, onLog);
    } else {
      // Fallback: plain Node
      const entry = await this.findNodeEntry(runtimeDir);
      const isTs = entry.endsWith('.ts') || entry.endsWith('.tsx');
      const detectedDeps = await this.scanForDependencies(runtimeDir);
      const fallbackDeps: Record<string, string> = isTs ? { tsx: 'latest' } : {};
      for (const dep of detectedDeps) {
        fallbackDeps[dep] = 'latest';
      }
      const pkg = {
        name: 'neuronest-runtime',
        version: '1.0.0',
        private: true,
        scripts: { start: isTs ? `tsx ${entry}` : `node ${entry}` },
        dependencies: fallbackDeps,
      };
      await writeFile(join(runtimeDir, 'package.json'), JSON.stringify(pkg, null, 2));
      onLog('[scaffold] Plain Node.js project, entry: ' + entry);
      if (detectedDeps.size > 0) {
        onLog('[scaffold] Detected dependencies: ' + [...detectedDeps].join(', '));
      }
    }
  }

  private async scaffoldAsBackend(runtimeDir: string, entry: string, onLog: (line: string) => void): Promise<void> {
    const isTs = entry.endsWith('.ts') || entry.endsWith('.tsx');
    const deps: Record<string, string> = { express: '^4', cors: '^2' };
    if (isTs) deps['tsx'] = 'latest';

    // Scan all code files for require()/import statements to detect needed dependencies
    const detectedDeps = await this.scanForDependencies(runtimeDir);
    // Also detect implicit dependencies (e.g., Express view engines)
    const implicitDeps = await this.detectImplicitDeps(runtimeDir);
    for (const dep of detectedDeps) {
      if (!deps[dep]) {
        deps[dep] = 'latest';
      }
    }
    for (const dep of implicitDeps) {
      if (!deps[dep]) {
        deps[dep] = 'latest';
        detectedDeps.add(dep);
      }
    }
    if (detectedDeps.size > 0) {
      onLog('[scaffold] Detected dependencies: ' + [...detectedDeps].join(', '));
    }

    // Patch hardcoded ports to use process.env.PORT
    try {
      const entryPath = join(runtimeDir, entry);
      let content = await readFile(entryPath, 'utf-8');
      // Replace patterns like `const port = 3000` or `app.listen(3000`
      content = content.replace(/const\s+port\s*=\s*\d+/g, 'const port = process.env.PORT || 3001');
      content = content.replace(/\.listen\(\s*(\d+)\s*,/g, '.listen(process.env.PORT || $1,');
      content = content.replace(/\.listen\(\s*(\d+)\s*\)/g, '.listen(process.env.PORT || $1)');
      await writeFile(entryPath, content);
      onLog('[scaffold] Patched hardcoded ports in ' + entry);
    } catch {}

    const pkg = {
      name: 'neuronest-backend',
      version: '1.0.0',
      private: true,
      scripts: { start: isTs ? `tsx ${entry}` : `node ${entry}` },
      dependencies: deps,
    };
    await writeFile(join(runtimeDir, 'package.json'), JSON.stringify(pkg, null, 2));
    onLog('[scaffold] Backend service, entry: ' + entry);
  }

  private async scaffoldAsFrontend(runtimeDir: string, onLog: (line: string) => void): Promise<void> {
    onLog('[scaffold] Setting up Vite dev server for frontend');
    await this.fixBrokenSourceFiles(runtimeDir, onLog);

    // Ensure src/ directory exists
    await mkdir(join(runtimeDir, 'src'), { recursive: true });

    // If React files are at root level (not in src/), copy them to src/
    const rootFiles = await readdir(runtimeDir).catch(() => [] as string[]);
    for (const f of rootFiles) {
      if (f.endsWith('.tsx') || f.endsWith('.jsx')) {
        try {
          await copyFile(join(runtimeDir, f), join(runtimeDir, 'src', f));
          onLog('[scaffold] Copied ' + f + ' to src/');
        } catch {}
      }
    }

    // Always generate a clean main.tsx bootstrap and App component
    // This avoids issues with broken imports in AI-generated code
    const mainTsx = `import React from 'react';\nimport { createRoot } from 'react-dom/client';\n\nfunction App() {\n  return (\n    <div style={{padding:'40px',fontFamily:'system-ui',maxWidth:'800px',margin:'0 auto'}}>\n      <h1>🚀 NeuroNest Runtime</h1>\n      <p>Your application is running.</p>\n    </div>\n  );\n}\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`;
    await writeFile(join(runtimeDir, 'src', 'main.tsx'), mainTsx);
    onLog('[scaffold] Generated src/main.tsx');

    // Check if there's a valid App component we can import instead
    const srcFiles = await readdir(join(runtimeDir, 'src')).catch(() => [] as string[]);
    for (const f of srcFiles) {
      if (f === 'main.tsx') continue;
      if (!f.endsWith('.tsx') && !f.endsWith('.jsx')) continue;
      try {
        const content = await readFile(join(runtimeDir, 'src', f), 'utf-8');
        if ((content.includes('React') || content.includes('export default') || content.includes('return (')) &&
            !content.includes('.listen(') && !content.includes("require('express')")) {
          // Found a valid React component — update main.tsx to import it
          const moduleName = f.replace(/\.(tsx|jsx)$/, '');
          const updatedMain = `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './${moduleName}';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`;
          await writeFile(join(runtimeDir, 'src', 'main.tsx'), updatedMain);
          onLog('[scaffold] Using ' + f + ' as App component');
          break;
        }
      } catch {}
    }

    const pkg = {
      name: 'neuronest-frontend',
      version: '1.0.0',
      private: true,
      scripts: { dev: 'vite', start: 'vite' },
      dependencies: { react: '^18', 'react-dom': '^18' },
      devDependencies: {
        vite: '^5', '@vitejs/plugin-react': '^4',
        '@types/react': '^18', '@types/react-dom': '^18', typescript: '^5',
      },
    };
    await writeFile(join(runtimeDir, 'package.json'), JSON.stringify(pkg, null, 2));
    await this.scaffoldViteConfig(runtimeDir, onLog);

    // Always generate index.html
    const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>NeuroNest Runtime</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.tsx"></script>\n</body>\n</html>\n`;
    await writeFile(join(runtimeDir, 'index.html'), html);
    onLog('[scaffold] Generated index.html');
    onLog('[scaffold] Vite frontend ready');
  }

  private async looksLikeReact(dir: string): Promise<boolean> {
    const files = await readdir(dir).catch(() => [] as string[]);
    const srcFiles = await readdir(join(dir, 'src')).catch(() => [] as string[]);
    const compFiles = await readdir(join(dir, 'src', 'components')).catch(() => [] as string[]);
    const all = [...files, ...srcFiles, ...compFiles];
    const hasJsx = all.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'));
    const hasComponents = files.includes('components') || srcFiles.includes('components');
    const hasApp = srcFiles.includes('App.tsx') || srcFiles.includes('app.tsx') || files.includes('App.tsx');
    return hasApp || (hasJsx && hasComponents) || compFiles.length > 0;
  }

  private async listCodeFiles(dir: string): Promise<string[]> {
    const result: string[] = [];
    const exts = ['.js', '.ts', '.tsx', '.jsx'];
    // Scan root
    try {
      const entries = await readdir(dir);
      for (const e of entries) {
        if (exts.some(ext => e.endsWith(ext))) result.push(e);
      }
    } catch {}
    // Scan src/
    try {
      const srcEntries = await readdir(join(dir, 'src'));
      for (const e of srcEntries) {
        if (exts.some(ext => e.endsWith(ext))) result.push('src/' + e);
      }
    } catch {}
    // Scan src/components/
    try {
      const compEntries = await readdir(join(dir, 'src', 'components'));
      for (const e of compEntries) {
        if (exts.some(ext => e.endsWith(ext))) result.push('src/components/' + e);
      }
    } catch {}
    return result;
  }

  /**
   * Fix broken source files — e.g. CSS content in .tsx files.
   */
  private async fixBrokenSourceFiles(runtimeDir: string, onLog: (line: string) => void): Promise<void> {
    // Scan both root and src/ directories
    const dirsToScan = [runtimeDir, join(runtimeDir, 'src')];
    for (const dir of dirsToScan) {
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.tsx') && !file.endsWith('.jsx') && !file.endsWith('.js')) continue;
        const filePath = join(dir, file);
        try {
          const s = await stat(filePath);
          if (!s.isFile()) continue;
          const content = await readFile(filePath, 'utf-8');
          const stripped = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').trim();
          if (stripped.match(/^[.#@][a-zA-Z]/) || stripped.match(/^\s*\{/) || stripped.match(/^[a-z-]+\s*\{/)) {
            const cssName = file.replace(/\.(tsx|jsx|js)$/, '.css');
            await rename(filePath, join(dir, cssName));
            onLog('[scaffold] Fixed: ' + file + ' was CSS, renamed to ' + cssName);
          }
        } catch {}
      }
    }
  }

  /**
   * Generate a vite.config.ts for React projects.
   */
  private async scaffoldViteConfig(runtimeDir: string, onLog: (line: string) => void): Promise<void> {
    if (await this.fileExists(join(runtimeDir, 'vite.config.ts')) || await this.fileExists(join(runtimeDir, 'vite.config.js'))) {
      return;
    }
    const config = `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n  server: {\n    host: true,\n    port: parseInt(process.env.PORT || '3000'),\n    strictPort: false,\n  },\n  esbuild: {\n    loader: 'jsx',\n    include: /\\.[jt]sx?$/,\n  },\n  optimizeDeps: {\n    esbuildOptions: {\n      loader: {\n        '.js': 'jsx',\n        '.ts': 'tsx',\n      },\n    },\n  },\n});\n`;
    await writeFile(join(runtimeDir, 'vite.config.ts'), config);
    onLog('[scaffold] Generated vite.config.ts');
  }

  /**
   * Generate an index.html entry point for React/Vite projects.
   */
  private async scaffoldIndexHtml(runtimeDir: string, onLog: (line: string) => void): Promise<void> {
    if (await this.fileExists(join(runtimeDir, 'index.html'))) return;

    // Find the React entry file that has actual JSX/React code
    const candidates = ['src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js'];
    let entryScript = '';
    for (const c of candidates) {
      if (await this.fileExists(join(runtimeDir, c))) {
        entryScript = '/' + c;
        break;
      }
    }
    if (!entryScript) entryScript = '/src/index.tsx';

    // Check if the entry file has ReactDOM.createRoot — if not, create a bootstrap
    let needsBootstrap = true;
    try {
      const content = await readFile(join(runtimeDir, entryScript.slice(1)), 'utf-8');
      if (content.includes('createRoot') || content.includes('ReactDOM') || content.includes('render(')) {
        needsBootstrap = false;
      }
    } catch {}

    if (needsBootstrap) {
      // Find a valid React component to import
      let appImport = null;
      const componentCandidates = ['src/index.tsx', 'src/App.tsx', 'src/app.tsx'];
      for (const c of componentCandidates) {
        try {
          const content = await readFile(join(runtimeDir, c), 'utf-8');
          // Must contain JSX or React import to be a valid component
          if (content.includes('React') || content.includes('jsx') || content.includes('<div') || content.includes('export default')) {
            const moduleName = c.replace('src/', './').replace(/\.(tsx|jsx|ts|js)$/, '');
            appImport = moduleName;
            break;
          }
        } catch {}
      }

      let mainContent: string;
      if (appImport) {
        mainContent = `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from '${appImport}';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`;
      } else {
        mainContent = `import React from 'react';\nimport { createRoot } from 'react-dom/client';\n\nfunction App() {\n  return <div style={{padding:'40px',fontFamily:'system-ui'}}><h1>🚀 NeuroNest Runtime</h1><p>Project is running.</p></div>;\n}\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`;
      }
      await writeFile(join(runtimeDir, 'src/main.tsx'), mainContent);
      entryScript = '/src/main.tsx';
      onLog('[scaffold] Generated src/main.tsx bootstrap');
    }

    const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>NeuroNest Runtime</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="${entryScript}"></script>\n</body>\n</html>\n`;
    await writeFile(join(runtimeDir, 'index.html'), html);
    onLog('[scaffold] Generated index.html with entry: ' + entryScript);
  }

  /**
   * Check if any of the given files contain a regex pattern.
   */
  private async filesContainPattern(baseDir: string, files: string[], pattern: RegExp): Promise<boolean> {
    for (const f of files) {
      try {
        const content = await readFile(join(baseDir, f), 'utf-8');
        if (pattern.test(content)) return true;
      } catch {}
    }
    return false;
  }

  /**
   * Find the best Node.js entry point file in a directory.
   */
  private async findNodeEntry(dir: string): Promise<string> {
    const candidates = [
      'index.js', 'index.ts', 'index.tsx',
      'server.js', 'server.ts',
      'app.js', 'app.ts', 'app.tsx',
      'App.tsx', 'App.jsx',
      'main.js', 'main.ts', 'main.tsx',
      'src/index.js', 'src/index.ts', 'src/index.tsx',
      'src/app.js', 'src/app.ts', 'src/app.tsx',
      'src/App.tsx', 'src/App.jsx',
      'src/server.js', 'src/server.ts',
      'src/main.js', 'src/main.ts', 'src/main.tsx',
    ];
    for (const c of candidates) {
      if (await this.fileExists(join(dir, c))) return c;
    }
    // Fallback: first code file in root, then src/
    try {
      const entries = await readdir(dir);
      const jsFile = entries.find(e => e.endsWith('.js') || e.endsWith('.ts') || e.endsWith('.tsx') || e.endsWith('.jsx'));
      if (jsFile) return jsFile;
    } catch {}
    try {
      const srcEntries = await readdir(join(dir, 'src'));
      const jsFile = srcEntries.find(e => e.endsWith('.js') || e.endsWith('.ts') || e.endsWith('.tsx') || e.endsWith('.jsx'));
      if (jsFile) return 'src/' + jsFile;
    } catch {}
    return 'index.js'; // absolute fallback
  }

  /**
   * Recursively copy a directory, skipping heavy/generated dirs.
   */
  private async copyDir(src: string, dest: string): Promise<void> {
    const SKIP = new Set([
      'node_modules', '__pycache__', 'target', '.git', 'dist', 'build',
      '.next', 'venv', '.venv', '.cache', '.turbo', 'coverage',
    ]);
    let entries;
    try {
      entries = await readdir(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true });
        await this.copyDir(srcPath, destPath);
      } else {
        await copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Install dependencies for a service inside its runtime directory.
   */
  async installDeps(
    service: ServiceDefinition,
    runtimeDir: string,
    onLog: (line: string) => void,
  ): Promise<void> {
    if (service.stackType === 'nodejs') {
      if (!(await this.fileExists(join(runtimeDir, 'package.json')))) {
        onLog('[install] No package.json, skipping npm install.');
        return;
      }

      // Check if node_modules already exists and has content
      const nodeModulesPath = join(runtimeDir, 'node_modules');
      const hasNodeModules = await this.fileExists(nodeModulesPath);
      if (hasNodeModules) {
        try {
          const entries = await readdir(nodeModulesPath);
          if (entries.length > 5) {
            onLog('[install] node_modules already exists, running npm install to sync...');
          }
        } catch {}
      }

      // Determine package manager: prefer yarn if yarn.lock exists, otherwise npm
      const hasYarnLock = await this.fileExists(join(runtimeDir, 'yarn.lock'));
      const hasPnpmLock = await this.fileExists(join(runtimeDir, 'pnpm-lock.yaml'));

      if (hasPnpmLock) {
        onLog('[install] Running: pnpm install --no-frozen-lockfile');
        try {
          await this.runCommand('pnpm', ['install', '--no-frozen-lockfile'], runtimeDir, onLog);
          return;
        } catch {
          onLog('[install] pnpm failed, falling back to npm...');
        }
      } else if (hasYarnLock) {
        onLog('[install] Running: yarn install --no-immutable');
        try {
          await this.runCommand('yarn', ['install', '--no-immutable'], runtimeDir, onLog);
          return;
        } catch {
          onLog('[install] yarn failed, falling back to npm...');
        }
      }

      // npm install with fallback flags
      onLog('[install] Running: npm install');
      try {
        await this.runCommand('npm', ['install', '--legacy-peer-deps'], runtimeDir, onLog);
      } catch (err) {
        onLog('[install] npm install --legacy-peer-deps failed, retrying without flag...');
        try {
          await this.runCommand('npm', ['install'], runtimeDir, onLog);
        } catch (err2) {
          onLog('[install] npm install failed: ' + (err2 as Error).message);
          onLog('[install] Continuing anyway — some dependencies may be missing at runtime.');
        }
      }
      return;
    }

    if (service.stackType === 'python') {
      const reqPath = join(runtimeDir, 'requirements.txt');
      if (await this.fileExists(reqPath)) {
        // Validate requirements.txt — check if it contains Python code instead of package names
        let needsRegeneration = false;
        try {
          const reqContent = await readFile(reqPath, 'utf-8');
          const lines = reqContent.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
          for (const line of lines) {
            // Python code patterns that shouldn't be in requirements.txt
            if (/^\s*(import |from |def |class |if |for |while |print\()/.test(line)) {
              needsRegeneration = true;
              break;
            }
          }
        } catch {
          needsRegeneration = true;
        }

        if (needsRegeneration) {
          onLog('[install] requirements.txt contains Python code, not package names. Regenerating...');
          const pyDeps = await this.scanPythonImports(runtimeDir);
          if (pyDeps.size > 0) {
            const newReqs = [...pyDeps].join('\n') + '\n';
            await writeFile(reqPath, newReqs);
            onLog('[install] Generated requirements.txt with: ' + [...pyDeps].join(', '));
          } else {
            onLog('[install] No third-party Python imports detected, skipping install.');
            return;
          }
        }

        // Use a virtual environment to avoid PEP 668 "externally-managed-environment" errors
        onLog('[install] Creating Python virtual environment...');
        try {
          await this.runCommand('python3', ['-m', 'venv', '.venv'], runtimeDir, onLog);
          onLog('[install] Running: pip install -r requirements.txt (in venv)');
          const pipPath = join(runtimeDir, '.venv', 'bin', 'pip');
          await this.runCommand(pipPath, ['install', '-r', 'requirements.txt'], runtimeDir, onLog);
        } catch (venvErr) {
          // Fallback: try pip in venv with --break-system-packages
          onLog('[install] pip install in venv failed, retrying with --break-system-packages...');
          try {
            const pipPath = join(runtimeDir, '.venv', 'bin', 'pip');
            const pipExists = await this.fileExists(pipPath);
            const pip = pipExists ? pipPath : 'pip3';
            await this.runCommand(pip, ['install', '--break-system-packages', '-r', 'requirements.txt'], runtimeDir, onLog);
          } catch {
            onLog('[install] pip install failed — dependencies may be missing at runtime');
          }
        }
      } else {
        onLog('[install] No requirements.txt found, skipping.');
      }
      return;
    }

    onLog('[install] No install step needed for ' + service.stackType);
  }

  /**
   * Run a command and stream output. Returns a promise that resolves on exit.
   */
  private runCommand(cmd: string, args: string[], cwd: string, onLog: (line: string) => void, timeoutMs: number = 120000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
        shell: true, // Required for npm/npx on macOS
      });

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          onLog(`[install] Command timed out after ${timeoutMs / 1000}s, killing...`);
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
        }, timeoutMs);
      }

      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on('line', onLog);
      }
      if (child.stderr) {
        const rl = createInterface({ input: child.stderr });
        rl.on('line', onLog);
      }

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0) {
          onLog('[install] Done.');
          resolve();
        } else {
          reject(new Error(`Command "${cmd} ${args.join(' ')}" failed with exit code ${code}`));
        }
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Start a service process in its isolated runtime directory.
   */
  async startService(
    serviceId: string,
    service: ServiceDefinition,
    runtimeDir: string,
    port: number,
    onLog: (line: string) => void,
    onExit: (code: number | null) => void,
  ): Promise<void> {
    // Pre-flight: stub missing relative modules to prevent immediate crashes
    if (service.stackType === 'nodejs') {
      await this.stubMissingModules(runtimeDir, onLog);
    }

    let cmd: string;
    let args: string[];

    if (service.stackType === 'nodejs') {
      const nodeCmd = await this.detectNodeRunCmd(runtimeDir, port);
      cmd = nodeCmd.cmd;
      args = nodeCmd.args;
    } else if (service.stackType === 'python') {
      const pyCmd = await this.detectPythonEntry(runtimeDir);
      cmd = pyCmd[0];
      args = pyCmd.slice(1);
    } else if (service.stackType === 'static-html') {
      cmd = 'npx';
      args = ['serve', '-s', '.', '-l', String(port)];
    } else if (service.stackType === 'go') {
      cmd = 'go';
      args = ['run', '.'];
    } else if (service.stackType === 'rust') {
      cmd = 'cargo';
      args = ['run'];
    } else {
      cmd = 'node';
      args = ['index.js'];
    }

    const env = {
      ...process.env,
      PORT: String(port),
      HOST: '0.0.0.0',
      FORCE_COLOR: '0',
    };

    onLog(`[run] Starting: ${cmd} ${args.join(' ')} (port ${port})`);

    const child = spawn(cmd, args, {
      cwd: runtimeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: true, // Use shell so npx/npm scripts work properly
    });

    this.processes.set(serviceId, child);

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', onLog);
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', onLog);
    }

    child.on('close', (code) => {
      this.processes.delete(serviceId);
      onExit(code);
    });

    child.on('error', (err) => {
      onLog(`[error] ${err.message}`);
      this.processes.delete(serviceId);
      onExit(1);
    });
  }

  /**
   * Detect the right run command for a Node.js project.
   * Reads package.json scripts to determine the best approach.
   */
  private async detectNodeRunCmd(runtimeDir: string, port: number): Promise<{ cmd: string; args: string[] }> {
    try {
      const raw = await readFile(join(runtimeDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      const scripts = pkg.scripts || {};

      // Check if start/dev script uses vite — if so, pass --port and --host
      const startScript = scripts.start || scripts.dev || '';
      if (startScript.includes('vite')) {
        const scriptName = scripts.start ? 'start' : 'dev';
        return { cmd: 'npx', args: ['vite', '--host', '--port', String(port)] };
      }

      if (scripts.start) {
        return { cmd: 'npm', args: ['start'] };
      }
      if (scripts.dev) {
        return { cmd: 'npm', args: ['run', 'dev'] };
      }
      if (pkg.main) {
        return { cmd: 'node', args: [pkg.main] };
      }
    } catch {}

    const entry = await this.findNodeEntry(runtimeDir);
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      return { cmd: 'npx', args: ['tsx', entry] };
    }
    return { cmd: 'node', args: [entry] };
  }

  /**
   * Detect the correct entry point for a Python project.
   */
  private async detectPythonEntry(runtimeDir: string): Promise<string[]> {
    // Use venv python if available
    const venvPython = join(runtimeDir, '.venv', 'bin', 'python3');
    const pythonCmd = await this.fileExists(venvPython) ? venvPython : 'python3';
    
    const candidates = ['main.py', 'app.py', 'server.py', 'run.py', 'manage.py'];
    for (const c of candidates) {
      if (await this.fileExists(join(runtimeDir, c))) {
        if (c === 'manage.py') return [pythonCmd, 'manage.py', 'runserver', '0.0.0.0'];
        return [pythonCmd, c];
      }
    }
    try {
      const entries = await readdir(runtimeDir);
      const pyFile = entries.find(e => e.endsWith('.py'));
      if (pyFile) return [pythonCmd, pyFile];
    } catch {}
    return [pythonCmd, 'main.py'];
  }

  /**
   * Scan code files for relative require/import paths and stub any missing modules.
   * This prevents immediate crashes from AI-generated code with incomplete file references.
   */
  private async stubMissingModules(runtimeDir: string, onLog: (line: string) => void): Promise<void> {
    const codeFiles = await this.listCodeFiles(runtimeDir);
    const stubbed = new Set<string>();

    for (const file of codeFiles) {
      try {
        const content = await readFile(join(runtimeDir, file), 'utf-8');
        const fileDir = join(runtimeDir, file, '..');

        // Match require('./path') and import from './path'
        const relativeImports = [
          ...content.matchAll(/require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g),
          ...content.matchAll(/from\s+['"](\.[^'"]+)['"]/g),
        ];

        for (const match of relativeImports) {
          const importPath = match[1];
          const resolved = join(fileDir, importPath);

          // Check if the file exists (with common extensions)
          const extensions = ['', '.js', '.ts', '.tsx', '.jsx', '.json', '/index.js', '/index.ts'];
          let exists = false;
          for (const ext of extensions) {
            if (await this.fileExists(resolved + ext)) {
              exists = true;
              break;
            }
          }

          if (!exists && !stubbed.has(resolved)) {
            stubbed.add(resolved);
            // Create a stub module that exports an empty object
            const stubPath = resolved.endsWith('.js') || resolved.endsWith('.ts') ? resolved : resolved + '.js';
            const stubDir = join(stubPath, '..');
            try {
              await mkdir(stubDir, { recursive: true });
              await writeFile(stubPath, '// Auto-generated stub for missing module\nmodule.exports = {};\n');
            } catch {}
          }
        }
      } catch {}
    }

    if (stubbed.size > 0) {
      onLog(`[preflight] Stubbed ${stubbed.size} missing module(s): ${[...stubbed].map(s => s.split('/').pop()).join(', ')}`);
    }
  }

  /**
   * Scan all code files in a directory for require()/import statements
   * and return a set of npm package names that need to be installed.
   */
  private async scanForDependencies(runtimeDir: string): Promise<Set<string>> {
    const deps = new Set<string>();
    const builtins = new Set([
      'fs', 'path', 'os', 'http', 'https', 'url', 'util', 'stream', 'events',
      'crypto', 'child_process', 'cluster', 'net', 'dns', 'tls', 'readline',
      'zlib', 'buffer', 'querystring', 'assert', 'worker_threads', 'perf_hooks',
      'node:fs', 'node:path', 'node:os', 'node:http', 'node:https', 'node:url',
      'node:util', 'node:stream', 'node:events', 'node:crypto', 'node:child_process',
      'node:cluster', 'node:net', 'node:dns', 'node:tls', 'node:readline',
      'node:zlib', 'node:buffer', 'node:querystring', 'node:assert',
      'node:worker_threads', 'node:perf_hooks',
    ]);

    const codeFiles = await this.listCodeFiles(runtimeDir);
    for (const file of codeFiles) {
      try {
        const content = await readFile(join(runtimeDir, file), 'utf-8');
        
        // Match require('package-name') and require("package-name")
        const requireMatches = content.matchAll(/require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g);
        for (const m of requireMatches) {
          const pkg = m[1].split('/')[0]; // handle scoped: @scope/pkg → @scope
          const fullPkg = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : pkg;
          if (!builtins.has(fullPkg) && !builtins.has('node:' + fullPkg)) {
            deps.add(fullPkg);
          }
        }

        // Match import ... from 'package-name'
        const importMatches = content.matchAll(/from\s+['"]([^'"./][^'"]*)['"]/g);
        for (const m of importMatches) {
          const pkg = m[1].split('/')[0];
          const fullPkg = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : pkg;
          if (!builtins.has(fullPkg) && !builtins.has('node:' + fullPkg)) {
            deps.add(fullPkg);
          }
        }
      } catch {}
    }

    return deps;
  }

  /**
   * Detect implicit dependencies that aren't directly require()'d in user code
   * but are loaded by frameworks at runtime (e.g., Express view engines).
   */
  private async detectImplicitDeps(runtimeDir: string): Promise<Set<string>> {
    const deps = new Set<string>();
    const codeFiles = await this.listCodeFiles(runtimeDir);

    for (const file of codeFiles) {
      try {
        const content = await readFile(join(runtimeDir, file), 'utf-8');

        // Express view engine: app.set('view engine', 'ejs') → needs 'ejs'
        const viewEngineMatch = content.match(/\.set\s*\(\s*['"]view engine['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
        if (viewEngineMatch) {
          deps.add(viewEngineMatch[1]); // ejs, pug, hbs, handlebars, etc.
        }

        // Express session: app.use(session(...)) with require('express-session')
        if (content.includes('express-session') || content.includes("require('express-session')")) {
          deps.add('express-session');
        }

        // Mongoose
        if (content.includes('mongoose.connect') || content.includes("require('mongoose')")) {
          deps.add('mongoose');
        }

        // Sequelize database drivers — detect dialect and add the required driver package
        if (content.includes('sequelize') || content.includes('Sequelize')) {
          // PostgreSQL
          if (content.includes("'postgres'") || content.includes('"postgres"') || content.includes("dialect: 'postgres'") || content.includes('dialect: "postgres"')) {
            deps.add('pg');
            deps.add('pg-hstore');
          }
          // MySQL
          if (content.includes("'mysql'") || content.includes('"mysql"') || content.includes("dialect: 'mysql'") || content.includes('dialect: "mysql"')) {
            deps.add('mysql2');
          }
          // SQLite
          if (content.includes("'sqlite'") || content.includes('"sqlite"') || content.includes("dialect: 'sqlite'") || content.includes('dialect: "sqlite"')) {
            deps.add('sqlite3');
          }
          // MSSQL
          if (content.includes("'mssql'") || content.includes('"mssql"') || content.includes("dialect: 'mssql'") || content.includes('dialect: "mssql"')) {
            deps.add('tedious');
          }
          // If dialect isn't specified, default to pg (most common with Sequelize)
          if (!content.includes("dialect:") && !content.includes("dialect :")) {
            deps.add('pg');
            deps.add('pg-hstore');
          }
        }

        // Prisma
        if (content.includes('@prisma/client') || content.includes("require('@prisma/client')")) {
          deps.add('@prisma/client');
        }

        // TypeORM database drivers
        if (content.includes('typeorm') || content.includes('TypeORM')) {
          if (content.includes("'postgres'") || content.includes('"postgres"')) {
            deps.add('pg');
          }
          if (content.includes("'mysql'") || content.includes('"mysql"')) {
            deps.add('mysql2');
          }
          if (content.includes("'sqlite'") || content.includes('"sqlite"') || content.includes('better-sqlite3')) {
            deps.add('better-sqlite3');
          }
        }

        // Socket.io
        if (content.includes("require('socket.io')") || content.includes("from 'socket.io'")) {
          deps.add('socket.io');
        }

        // dotenv
        if (content.includes("require('dotenv')") || content.includes("from 'dotenv'")) {
          deps.add('dotenv');
        }

        // multer (file uploads)
        if (content.includes("require('multer')") || content.includes("from 'multer'")) {
          deps.add('multer');
        }

        // bcrypt / bcryptjs
        if (content.includes("require('bcrypt')") || content.includes("from 'bcrypt'")) {
          deps.add('bcryptjs'); // Use bcryptjs (pure JS, no native compilation needed)
        }

        // jsonwebtoken
        if (content.includes("require('jsonwebtoken')") || content.includes("from 'jsonwebtoken'")) {
          deps.add('jsonwebtoken');
        }

        // Redis
        if (content.includes("require('redis')") || content.includes("from 'redis'") || content.includes("require('ioredis')") || content.includes("from 'ioredis'")) {
          if (content.includes('ioredis')) deps.add('ioredis');
          else deps.add('redis');
        }
      } catch {}
    }

    return deps;
  }

  /**
   * Scan Python files for import statements and return third-party package names.
   */
  private async scanPythonImports(runtimeDir: string): Promise<Set<string>> {
    const deps = new Set<string>();
    const stdlibModules = new Set([
      'os', 'sys', 'json', 'math', 'time', 'datetime', 'collections', 'itertools',
      'functools', 'pathlib', 'typing', 'abc', 'io', 're', 'string', 'struct',
      'hashlib', 'hmac', 'secrets', 'random', 'statistics', 'decimal', 'fractions',
      'copy', 'pprint', 'textwrap', 'unicodedata', 'difflib', 'enum', 'dataclasses',
      'contextlib', 'atexit', 'traceback', 'warnings', 'logging', 'unittest',
      'argparse', 'configparser', 'csv', 'sqlite3', 'xml', 'html', 'urllib',
      'http', 'email', 'mailbox', 'mimetypes', 'base64', 'binascii', 'codecs',
      'locale', 'gettext', 'subprocess', 'shutil', 'glob', 'fnmatch', 'tempfile',
      'gzip', 'zipfile', 'tarfile', 'lzma', 'bz2', 'socket', 'ssl', 'select',
      'selectors', 'signal', 'threading', 'multiprocessing', 'concurrent', 'asyncio',
      'queue', 'sched', 'array', 'weakref', 'types', 'inspect', 'dis', 'gc',
      'pickle', 'shelve', 'marshal', 'dbm', 'platform', 'errno', 'ctypes',
      'importlib', 'pkgutil', 'modulefinder', 'runpy', 'builtins', '__future__',
    ]);
    // Common import-name → pip-package-name mappings
    const importToPkg: Record<string, string> = {
      'cv2': 'opencv-python', 'PIL': 'Pillow', 'sklearn': 'scikit-learn',
      'yaml': 'pyyaml', 'bs4': 'beautifulsoup4', 'attr': 'attrs',
      'dotenv': 'python-dotenv', 'gi': 'PyGObject', 'wx': 'wxPython',
      'serial': 'pyserial', 'usb': 'pyusb', 'Crypto': 'pycryptodome',
      'tensorflowjs': 'tensorflowjs', 'tensorflow': 'tensorflow',
      'torch': 'torch', 'torchvision': 'torchvision',
    };

    try {
      const entries = await readdir(runtimeDir);
      const pyFiles = entries.filter(e => e.endsWith('.py'));

      for (const file of pyFiles) {
        try {
          const content = await readFile(join(runtimeDir, file), 'utf-8');
          // Match: import foo, from foo import bar
          const importMatches = content.matchAll(/^\s*(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm);
          for (const m of importMatches) {
            const mod = m[1];
            if (!stdlibModules.has(mod) && mod !== file.replace('.py', '')) {
              deps.add(importToPkg[mod] || mod);
            }
          }
        } catch {}
      }
    } catch {}

    return deps;
  }

  stopService(serviceId: string): void {
    const child = this.processes.get(serviceId);
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch {}
      }, 5000);
      this.processes.delete(serviceId);
    }
  }

  stopAll(): void {
    for (const [id] of this.processes) {
      this.stopService(id);
    }
  }

  isRunning(serviceId: string): boolean {
    return this.processes.has(serviceId);
  }

  getRuntimeDir(serviceId: string): string | undefined {
    return this.runtimeDirs.get(serviceId);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
