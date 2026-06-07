/**
 * Code Generation Enhancer — Production-Grade Code Output
 *
 * Ensures generated code is complete, has proper structure, dependencies,
 * and can be deployed without manual fixes.
 *
 * Features:
 * 1. Enhanced output format prompt (structural requirements)
 * 2. Automatic dependency detection from imports
 * 3. Post-generation validation (syntax, deps, build)
 * 4. Iterative fix loop (send errors back to LLM)
 * 5. Project scaffolding (config files, entry points)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ── Enhanced Output Format ──────────────────────────────────────────

/**
 * Enhanced output format instructions for agents.
 * Replaces the basic "generate 3-10 files" instruction with production requirements.
 */
export const PRODUCTION_OUTPUT_FORMAT = `

=== OUTPUT FORMAT (PRODUCTION-GRADE) ===
You are generating PRODUCTION-READY code that will be deployed directly to a server.

MANDATORY REQUIREMENTS:
1. Every file MUST have a "// file: path/filename.ext" annotation before its code block
2. Include ALL imports — no missing dependencies
3. Include package.json (or equivalent) with ALL dependencies and scripts:
   - "start" script for running the app
   - "build" script if compilation is needed
   - "dev" script for development mode
4. Include configuration files:
   - tsconfig.json (for TypeScript projects)
   - .env.example (for environment variables — never hardcode secrets)
   - .gitignore
5. Include an entry point file (index.ts/app.ts/main.py/etc.)
6. Use proper error handling (try/catch, error middleware)
7. Use environment variables for ports, URLs, secrets (process.env.PORT, etc.)
8. Add brief JSDoc/docstring comments on exported functions

CODE QUALITY RULES:
- No placeholder comments like "// TODO: implement this"
- No mock data — use real logic or clearly mark as seed data
- No hardcoded ports — use process.env.PORT || 3000
- No hardcoded URLs — use environment variables
- All async functions must have error handling
- All API endpoints must validate input
- All database operations must handle connection errors

FILE STRUCTURE:
// file: package.json
\`\`\`json
{...}
\`\`\`

// file: src/index.ts
\`\`\`typescript
// Entry point
\`\`\`

Generate COMPLETE, WORKING files. The code must run with just:
  npm install && npm start
=== END FORMAT ===`;

/**
 * Static-HTML output format for primary-artifact-first mode.
 * Used when the user explicitly asked for a single self-contained HTML file
 * (no NPM, no build tools, no framework). Tells the agent to produce ONE
 * runnable index.html that opens directly in a browser.
 */
export const STATIC_HTML_OUTPUT_FORMAT = `

=== OUTPUT FORMAT (SINGLE-FILE STATIC HTML) ===
You are generating a SINGLE self-contained index.html file that opens directly
in a browser. NO build step. NO npm install. NO framework. NO bundler.

MANDATORY REQUIREMENTS:
1. Output exactly ONE file with a "// file: index.html" annotation
2. All HTML, CSS, and JavaScript live INSIDE that single file
   - <style> blocks for CSS (no external .css files)
   - <script> blocks for JavaScript (no external .js files except CDN libraries)
3. External libraries are loaded ONLY via CDN <script src="https://...">
   (e.g. https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js)
4. Do NOT generate package.json, tsconfig.json, .gitignore, .env.example,
   build configs, README files, CI/CD pipelines, test files, or Docker files
5. The file must run by simply opening it in a modern browser — no tooling

CODE QUALITY RULES:
- Real working logic — no TODO comments, no placeholder stubs
- Inline JavaScript should be valid ES2020+ (no transpilation assumed)
- Use vanilla JS or CDN-loaded libraries; never assume an import resolver
- Prefer requestAnimationFrame for animation loops
- Add brief comments on non-obvious sections

FILE STRUCTURE:
// file: index.html
\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head>...</head>
<body>...</body>
</html>
\`\`\`

Generate ONE complete, runnable index.html. Do not generate any other files.
=== END FORMAT ===`;

// ── Dependency Detection ────────────────────────────────────────────

interface DetectedDependency {
  name: string;
  version: string;
  isDev: boolean;
}

// Common import patterns → npm package mappings
const IMPORT_TO_PACKAGE: Record<string, string> = {
  express: 'express',
  react: 'react',
  'react-dom': 'react-dom',
  next: 'next',
  axios: 'axios',
  cors: 'cors',
  dotenv: 'dotenv',
  mongoose: 'mongoose',
  prisma: '@prisma/client',
  '@prisma/client': '@prisma/client',
  pg: 'pg',
  redis: 'redis',
  ioredis: 'ioredis',
  jsonwebtoken: 'jsonwebtoken',
  bcrypt: 'bcrypt',
  bcryptjs: 'bcryptjs',
  zod: 'zod',
  joi: 'joi',
  helmet: 'helmet',
  morgan: 'morgan',
  winston: 'winston',
  'socket.io': 'socket.io',
  ws: 'ws',
  multer: 'multer',
  nodemailer: 'nodemailer',
  stripe: 'stripe',
  'aws-sdk': 'aws-sdk',
  '@aws-sdk/client-s3': '@aws-sdk/client-s3',
  firebase: 'firebase',
  'firebase-admin': 'firebase-admin',
  graphql: 'graphql',
  'apollo-server': '@apollo/server',
  fastify: 'fastify',
  koa: 'koa',
  hono: 'hono',
  elysia: 'elysia',
  drizzle: 'drizzle-orm',
  'drizzle-orm': 'drizzle-orm',
  sequelize: 'sequelize',
  typeorm: 'typeorm',
  'better-sqlite3': 'better-sqlite3',
  sqlite3: 'sqlite3',
  uuid: 'uuid',
  lodash: 'lodash',
  dayjs: 'dayjs',
  'date-fns': 'date-fns',
  chalk: 'chalk',
  commander: 'commander',
  inquirer: 'inquirer',
  'node-cron': 'node-cron',
  'bull': 'bull',
  'bullmq': 'bullmq',
  passport: 'passport',
  'cookie-parser': 'cookie-parser',
  'express-session': 'express-session',
  'express-validator': 'express-validator',
  compression: 'compression',
  'rate-limiter-flexible': 'rate-limiter-flexible',
  'express-rate-limit': 'express-rate-limit',
  swagger: 'swagger-ui-express',
  'swagger-jsdoc': 'swagger-jsdoc',
  jest: 'jest',
  vitest: 'vitest',
  mocha: 'mocha',
  chai: 'chai',
  supertest: 'supertest',
  typescript: 'typescript',
  'ts-node': 'ts-node',
  tsx: 'tsx',
  nodemon: 'nodemon',
  eslint: 'eslint',
  prettier: 'prettier',
  tailwindcss: 'tailwindcss',
  vite: 'vite',
  webpack: 'webpack',
  esbuild: 'esbuild',
};

const DEV_PACKAGES = new Set([
  'typescript', 'ts-node', 'tsx', 'nodemon', 'eslint', 'prettier',
  'jest', 'vitest', 'mocha', 'chai', 'supertest', '@types/node',
  '@types/express', '@types/cors', '@types/jsonwebtoken', '@types/bcrypt',
  'tailwindcss', 'vite', 'webpack', 'esbuild',
]);

/**
 * Scan generated files for import statements and detect required dependencies.
 */
export function detectDependencies(projectDir: string): DetectedDependency[] {
  const deps = new Map<string, DetectedDependency>();

  try {
    const files = collectSourceFiles(projectDir);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        extractImports(content).forEach(imp => {
          const pkg = IMPORT_TO_PACKAGE[imp] || imp;
          // Skip relative imports and node builtins
          if (imp.startsWith('.') || imp.startsWith('/') || isNodeBuiltin(imp)) return;
          // Defensive: never emit an invalid npm package name (e.g. a bare
          // scope like '@testing-library'), which would make `npm install`
          // abort with EINVALIDPACKAGENAME and block every dependency.
          if (!isValidPackageName(pkg)) return;
          if (!deps.has(pkg)) {
            deps.set(pkg, { name: pkg, version: 'latest', isDev: DEV_PACKAGES.has(pkg) });
          }
        });
      } catch {}
    }
  } catch {}

  return Array.from(deps.values());
}

/**
 * Validate an npm package name against the rules npm enforces (the same ones
 * behind EINVALIDPACKAGENAME). Accepts unscoped names (`react`, `react-dom`)
 * and scoped names (`@scope/pkg`); rejects a bare scope (`@testing-library`),
 * empty segments, uppercase, and leading dots/underscores.
 */
function isValidPackageName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214) return false;
  if (name !== name.toLowerCase()) return false;

  if (name.startsWith('@')) {
    const parts = name.split('/');
    if (parts.length !== 2) return false; // must be exactly @scope/pkg
    const scope = parts[0].slice(1); // drop the leading '@'
    const pkg = parts[1];
    return isValidNameSegment(scope) && isValidNameSegment(pkg);
  }

  return isValidNameSegment(name);
}

/** A single (unscoped) name segment: non-empty, url-safe, no leading . or _. */
function isValidNameSegment(seg: string): boolean {
  if (!seg || seg.startsWith('.') || seg.startsWith('_')) return false;
  return /^[a-z0-9][a-z0-9._-]*$/.test(seg);
}

/**
 * Normalize a raw module specifier to its installable npm package name, or
 * `null` when the specifier cannot yield a valid package name.
 *
 *   'react'                    → 'react'
 *   'react-dom/client'         → 'react-dom'
 *   '@testing-library/react'   → '@testing-library/react'
 *   '@scope/pkg/sub/path'      → '@scope/pkg'
 *   '@testing-library'         → null   (bare scope, no package — invalid)
 *
 * Scoped packages MUST retain both the `@scope` and the package segment;
 * naively taking `split('/')[0]` would reduce `@testing-library/react` to the
 * bare scope `@testing-library`, which is an invalid npm package name and
 * makes the whole `npm install` abort with EINVALIDPACKAGENAME.
 */
function toPackageName(specifier: string): string | null {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    // Need both a scope and a package segment, both non-empty.
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return parts[0] + '/' + parts[1];
  }
  return parts[0] || null;
}

/**
 * Extract import/require package names from source code.
 */
function extractImports(code: string): string[] {
  const imports: string[] = [];

  const push = (specifier: string) => {
    const pkg = toPackageName(specifier);
    if (pkg) imports.push(pkg);
  };

  // ES imports: import X from 'package'
  const esImports = code.matchAll(/import\s+(?:[\w{},\s*]+\s+from\s+)?['"]([^'"./][^'"]*)['"]/g);
  for (const m of esImports) push(m[1]);

  // require: require('package')
  const requires = code.matchAll(/require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g);
  for (const m of requires) push(m[1]);

  return [...new Set(imports)];
}

function isNodeBuiltin(name: string): boolean {
  const builtins = new Set([
    'fs', 'path', 'os', 'http', 'https', 'url', 'util', 'stream',
    'crypto', 'events', 'child_process', 'cluster', 'net', 'dns',
    'readline', 'zlib', 'buffer', 'querystring', 'assert', 'timers',
    'worker_threads', 'perf_hooks', 'async_hooks', 'v8', 'vm',
    'node:fs', 'node:path', 'node:os', 'node:http', 'node:https',
    'node:url', 'node:util', 'node:stream', 'node:crypto', 'node:events',
    'node:child_process', 'node:net', 'node:readline', 'node:zlib',
    'node:buffer', 'node:worker_threads', 'node:test',
  ]);
  return builtins.has(name) || name.startsWith('node:');
}

function collectSourceFiles(dir: string, maxDepth: number = 4): string[] {
  const files: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

  function walk(d: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(full);
      }
    } catch {}
  }

  walk(dir, 0);
  return files;
}

// ── Post-Generation Validation ──────────────────────────────────────

export interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  fixable: boolean;
}

/**
 * Validate a generated project for completeness and correctness.
 * Returns errors that need fixing and warnings for improvement.
 */
export function validateGeneratedProject(projectDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check for entry point (includes static-HTML entry points)
  const entryPoints = [
    'index.ts', 'index.js', 'app.ts', 'app.js', 'main.ts', 'main.py', 'server.ts', 'server.js',
    'index.html', 'index.htm', 'app.html',
  ];
  const srcEntryPoints = entryPoints.map(e => 'src/' + e);
  const allEntryPoints = [...entryPoints, ...srcEntryPoints];
  const hasEntry = allEntryPoints.some(e => fs.existsSync(path.join(projectDir, e)));
  if (!hasEntry) {
    warnings.push('No entry point found (index.ts, app.ts, main.py, index.html, etc.)');
  }

  // Detect static-only projects (HTML present, no JS/TS source files outside HTML).
  // For these, skip the package.json, tsconfig, and start-script warnings — they
  // are not Node projects and don't need build tooling.
  const hasHtmlEntry = ['index.html', 'index.htm', 'app.html', 'src/index.html', 'src/app.html']
    .some(e => fs.existsSync(path.join(projectDir, e)));
  const sourceFiles = collectSourceFiles(projectDir);
  const isStaticOnly = hasHtmlEntry && sourceFiles.length === 0;

  // 2. Check for package.json
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (!pkg.scripts?.start && !isStaticOnly) warnings.push('package.json missing "start" script');
      if ((!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) && !isStaticOnly) {
        warnings.push('package.json has no dependencies — imports may fail');
      }
    } catch {
      errors.push('package.json is not valid JSON');
    }
  } else if (!isStaticOnly) {
    // Check if there are JS/TS files that would need a package.json
    const hasJsFiles = sourceFiles.length > 0;
    if (hasJsFiles) warnings.push('No package.json found for JavaScript/TypeScript project');
  }

  // 3. Check for tsconfig.json if TypeScript files exist
  const hasTsFiles = sourceFiles.some(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  if (hasTsFiles && !fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    warnings.push('TypeScript files found but no tsconfig.json');
  }

  // 4. Check for .gitignore (skip for static-only projects)
  if (!isStaticOnly && !fs.existsSync(path.join(projectDir, '.gitignore'))) {
    warnings.push('No .gitignore file');
  }

  // 5. Detect missing dependencies
  const detectedDeps = detectDependencies(projectDir);
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeclared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const missing = detectedDeps.filter(d => !allDeclared[d.name]);
      if (missing.length > 0) {
        warnings.push('Missing dependencies in package.json: ' + missing.map(d => d.name).join(', '));
      }
    } catch {}
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    fixable: warnings.length > 0,
  };
}

// ── Auto-Fix: Dependency Installation ───────────────────────────────

/**
 * Auto-fix missing dependencies by updating package.json and running npm install.
 */
export function autoFixDependencies(projectDir: string): { fixed: boolean; message: string } {
  const pkgPath = path.join(projectDir, 'package.json');
  const pkgExists = fs.existsSync(pkgPath);

  // Detect what's needed
  const detected = detectDependencies(projectDir);

  // Nothing to add AND no existing manifest to sanitize → nothing to do.
  if (detected.length === 0 && !pkgExists) {
    return { fixed: true, message: 'No dependencies needed' };
  }

  // Create or update package.json
  let pkg: any = { name: 'neuronest-project', version: '1.0.0', scripts: {}, dependencies: {}, devDependencies: {} };
  if (pkgExists) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch {}
  }

  if (!pkg.dependencies) pkg.dependencies = {};
  if (!pkg.devDependencies) pkg.devDependencies = {};
  if (!pkg.scripts) pkg.scripts = {};

  // Strip any pre-existing invalid dependency names (e.g. a bare scope like
  // '@testing-library' the model may have emitted). A single invalid name
  // makes `npm install` abort with EINVALIDPACKAGENAME and blocks EVERY
  // dependency — so we drop the malformed entries and keep going.
  let removed = 0;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const block = pkg[field];
    if (block && typeof block === 'object') {
      for (const depName of Object.keys(block)) {
        if (!isValidPackageName(depName)) {
          delete block[depName];
          removed++;
        }
      }
    }
  }

  let added = 0;
  for (const dep of detected) {
    const target = dep.isDev ? pkg.devDependencies : pkg.dependencies;
    if (!target[dep.name] && !pkg.dependencies[dep.name] && !pkg.devDependencies[dep.name]) {
      target[dep.name] = dep.version === 'latest' ? '*' : dep.version;
      added++;
    }
  }

  // Ensure start script exists
  if (!pkg.scripts.start) {
    const hasTsFiles = collectSourceFiles(projectDir).some(f => f.endsWith('.ts'));
    if (hasTsFiles) {
      pkg.scripts.start = 'tsx src/index.ts';
      if (!pkg.devDependencies.tsx) { pkg.devDependencies.tsx = '*'; added++; }
    } else {
      pkg.scripts.start = 'node src/index.js';
    }
  }
  if (!pkg.scripts.dev) {
    pkg.scripts.dev = pkg.scripts.start.replace('node ', 'nodemon ').replace('tsx ', 'tsx watch ');
  }

  if (added > 0 || removed > 0) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  }

  // Run npm install
  try {
    execSync('npm install --legacy-peer-deps 2>/dev/null || npm install', {
      cwd: projectDir,
      timeout: 120000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      fixed: true,
      message:
        `Installed ${added} dependencies` +
        (removed > 0 ? ` (removed ${removed} invalid package name${removed === 1 ? '' : 's'})` : ''),
    };
  } catch (err: any) {
    return { fixed: false, message: 'npm install failed: ' + (err.message || '').slice(0, 200) };
  }
}

// ── Scaffolding: Generate Missing Config Files ──────────────────────

/**
 * Generate missing configuration files for a project.
 */
export function scaffoldMissingConfigs(projectDir: string): string[] {
  const created: string[] = [];

  // .gitignore
  if (!fs.existsSync(path.join(projectDir, '.gitignore'))) {
    fs.writeFileSync(path.join(projectDir, '.gitignore'),
      'node_modules/\ndist/\nbuild/\n.env\n*.log\ncoverage/\n.DS_Store\n', 'utf-8');
    created.push('.gitignore');
  }

  // tsconfig.json (if TS files exist)
  const hasTsFiles = collectSourceFiles(projectDir).some(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  if (hasTsFiles && !fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: './dist',
        rootDir: './src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        declaration: true,
      },
      include: ['src/**/*'],
      exclude: ['node_modules', 'dist'],
    };
    fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n', 'utf-8');
    created.push('tsconfig.json');
  }

  // .env.example (if .env references found in code)
  if (!fs.existsSync(path.join(projectDir, '.env.example'))) {
    const envVars = detectEnvVars(projectDir);
    if (envVars.length > 0) {
      const content = envVars.map(v => `${v}=`).join('\n') + '\n';
      fs.writeFileSync(path.join(projectDir, '.env.example'), content, 'utf-8');
      created.push('.env.example');
    }
  }

  return created;
}

/**
 * Detect environment variable references in source code.
 */
function detectEnvVars(projectDir: string): string[] {
  const vars = new Set<string>();
  const files = collectSourceFiles(projectDir);

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g);
      for (const m of matches) vars.add(m[1]);
      // Also check Deno.env.get and import.meta.env
      const denoMatches = content.matchAll(/(?:Deno\.env\.get|import\.meta\.env)\.([A-Z_][A-Z0-9_]*)/g);
      for (const m of denoMatches) vars.add(m[1]);
    } catch {}
  }

  // Always include common ones if any env vars are used
  if (vars.size > 0) {
    vars.add('NODE_ENV');
    vars.add('PORT');
  }

  return Array.from(vars).sort();
}

// ── Iterative Fix Loop ──────────────────────────────────────────────

/**
 * Build an error context string that can be sent back to the LLM for fixing.
 */
export function buildFixPrompt(errors: string[], projectDir: string): string {
  let context = 'The generated code has the following issues that need fixing:\n\n';
  for (const err of errors) {
    context += `- ${err}\n`;
  }
  context += '\nPlease fix these issues. Output ONLY the corrected files using the same "// file: path" format. Do not regenerate files that are already correct.';
  return context;
}
