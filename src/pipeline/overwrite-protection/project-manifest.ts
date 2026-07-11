/**
 * Project Manifest Derivation
 *
 * Derives a ProjectManifest from the project directory by reading manifest files
 * in priority order: package.json > Cargo.toml > pyproject.toml > directory heuristics.
 *
 * Falls back immediately to directory-name + file-extension heuristic when no
 * manifest file exists or when a manifest is unreadable.
 *
 * Requirements: 1.1, 1.2, 1.5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectManifest } from './types';

/** Common entry point file paths to look for in a project */
const COMMON_ENTRY_POINTS = [
  'src/index.ts',
  'src/main.ts',
  'src/index.js',
  'src/main.js',
  'src/app.ts',
  'src/app.js',
  'index.ts',
  'index.js',
  'main.ts',
  'main.js',
  'main.py',
  'app.py',
  'src/main.rs',
  'src/lib.rs',
];

/** Map of file extensions to language names */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
};

/** Known frameworks and the dependency names that indicate them */
const JS_FRAMEWORK_INDICATORS: Record<string, string> = {
  'next': 'next',
  'react': 'react',
  'vue': 'vue',
  'nuxt': 'nuxt',
  'svelte': 'svelte',
  'angular': 'angular',
  '@angular/core': 'angular',
  'express': 'express',
  'fastify': 'fastify',
  'koa': 'koa',
  'nest': 'nestjs',
  '@nestjs/core': 'nestjs',
  'electron': 'electron',
};

const PYTHON_FRAMEWORK_INDICATORS: Record<string, string> = {
  'flask': 'flask',
  'django': 'django',
  'fastapi': 'fastapi',
  'tornado': 'tornado',
  'starlette': 'starlette',
};

const RUST_FRAMEWORK_INDICATORS: Record<string, string> = {
  'actix-web': 'actix-web',
  'rocket': 'rocket',
  'axum': 'axum',
  'warp': 'warp',
  'tokio': 'tokio',
  'tauri': 'tauri',
};

/**
 * Derives a ProjectManifest from the project directory.
 * Priority: package.json > Cargo.toml > pyproject.toml > directory heuristics
 */
export function deriveProjectManifest(projectDir: string): ProjectManifest {
  // Try package.json first
  const packageJsonManifest = tryParsePackageJson(projectDir);
  if (packageJsonManifest) return packageJsonManifest;

  // Try Cargo.toml
  const cargoManifest = tryParseCargoToml(projectDir);
  if (cargoManifest) return cargoManifest;

  // Try pyproject.toml
  const pyprojectManifest = tryParsePyprojectToml(projectDir);
  if (pyprojectManifest) return pyprojectManifest;

  // Fall back to directory heuristics
  return deriveFromDirectoryHeuristics(projectDir);
}

/**
 * Attempts to parse package.json and derive a manifest.
 * Returns null if the file doesn't exist or is unreadable/invalid.
 */
function tryParsePackageJson(projectDir: string): ProjectManifest | null {
  const filePath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const pkg = JSON.parse(raw);

    const name = typeof pkg.name === 'string' ? pkg.name : path.basename(projectDir);
    const purpose = typeof pkg.description === 'string' ? pkg.description : `${name} project`;

    // Collect all dependency names
    const allDeps: string[] = [];
    if (pkg.dependencies && typeof pkg.dependencies === 'object') {
      allDeps.push(...Object.keys(pkg.dependencies));
    }
    if (pkg.devDependencies && typeof pkg.devDependencies === 'object') {
      allDeps.push(...Object.keys(pkg.devDependencies));
    }

    // Detect framework from dependencies
    const framework = detectJsFramework(allDeps);

    // Determine language: TypeScript if tsconfig.json or .ts files exist
    const primaryLanguage = detectJsLanguage(projectDir);

    // Detect entry points
    const entryPoints = detectEntryPoints(projectDir);

    // Use top-level dependencies only (not devDependencies) for the manifest
    const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object'
      ? Object.keys(pkg.dependencies)
      : [];

    return {
      name,
      primaryLanguage,
      framework,
      purpose,
      entryPoints,
      dependencies,
    };
  } catch {
    // Unreadable or invalid JSON — fall back to directory heuristic
    return null;
  }
}

/**
 * Attempts to parse Cargo.toml and derive a manifest.
 * Returns null if the file doesn't exist or is unreadable/invalid.
 */
function tryParseCargoToml(projectDir: string): ProjectManifest | null {
  const filePath = path.join(projectDir, 'Cargo.toml');
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');

    const name = extractTomlValue(raw, 'name') || path.basename(projectDir);
    const purpose = extractTomlValue(raw, 'description') || `${name} Rust project`;

    // Extract dependencies
    const dependencies = extractTomlDependencies(raw);

    // Detect framework from dependencies
    const framework = detectRustFramework(dependencies);

    // Detect entry points
    const entryPoints = detectEntryPoints(projectDir);

    return {
      name,
      primaryLanguage: 'rust',
      framework,
      purpose,
      entryPoints,
      dependencies,
    };
  } catch {
    return null;
  }
}

/**
 * Attempts to parse pyproject.toml and derive a manifest.
 * Returns null if the file doesn't exist or is unreadable/invalid.
 */
function tryParsePyprojectToml(projectDir: string): ProjectManifest | null {
  const filePath = path.join(projectDir, 'pyproject.toml');
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');

    const name = extractTomlValue(raw, 'name') || path.basename(projectDir);
    const purpose = extractTomlValue(raw, 'description') || `${name} Python project`;

    // Extract dependencies
    const dependencies = extractPyprojectDependencies(raw);

    // Detect framework from dependencies
    const framework = detectPythonFramework(dependencies);

    // Detect entry points
    const entryPoints = detectEntryPoints(projectDir);

    return {
      name,
      primaryLanguage: 'python',
      framework,
      purpose,
      entryPoints,
      dependencies,
    };
  } catch {
    return null;
  }
}

/**
 * Falls back to directory-name + file-extension heuristic.
 * Scans the top-level and src/ directory to determine the most common language.
 */
function deriveFromDirectoryHeuristics(projectDir: string): ProjectManifest {
  const name = path.basename(projectDir);
  const primaryLanguage = detectPrimaryLanguageFromFiles(projectDir);
  const entryPoints = detectEntryPoints(projectDir);

  return {
    name,
    primaryLanguage,
    framework: null,
    purpose: `${name} project`,
    entryPoints,
    dependencies: [],
  };
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Detects JavaScript/TypeScript framework from dependency list.
 */
function detectJsFramework(deps: string[]): string | null {
  for (const dep of deps) {
    if (dep in JS_FRAMEWORK_INDICATORS) {
      return JS_FRAMEWORK_INDICATORS[dep];
    }
  }
  return null;
}

/**
 * Detects whether the project uses TypeScript or JavaScript.
 */
function detectJsLanguage(projectDir: string): string {
  // Check for tsconfig.json
  if (fs.existsSync(path.join(projectDir, 'tsconfig.json'))) {
    return 'typescript';
  }

  // Check for .ts files in src/ or root
  try {
    const srcDir = path.join(projectDir, 'src');
    if (fs.existsSync(srcDir)) {
      const srcFiles = fs.readdirSync(srcDir);
      if (srcFiles.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))) {
        return 'typescript';
      }
    }

    const rootFiles = fs.readdirSync(projectDir);
    if (rootFiles.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      return 'typescript';
    }
  } catch {
    // Ignore read errors
  }

  return 'javascript';
}

/**
 * Detects Python framework from dependency list.
 */
function detectPythonFramework(deps: string[]): string | null {
  for (const dep of deps) {
    const normalized = dep.toLowerCase().replace(/[^a-z]/g, '');
    for (const [indicator, framework] of Object.entries(PYTHON_FRAMEWORK_INDICATORS)) {
      if (normalized.includes(indicator)) {
        return framework;
      }
    }
  }
  return null;
}

/**
 * Detects Rust framework from dependency list.
 */
function detectRustFramework(deps: string[]): string | null {
  for (const dep of deps) {
    if (dep in RUST_FRAMEWORK_INDICATORS) {
      return RUST_FRAMEWORK_INDICATORS[dep];
    }
  }
  return null;
}

/**
 * Detects the primary language from file extensions in the project.
 */
function detectPrimaryLanguageFromFiles(projectDir: string): string {
  const extensionCounts: Record<string, number> = {};

  try {
    // Scan root directory
    const rootFiles = fs.readdirSync(projectDir);
    for (const file of rootFiles) {
      const ext = path.extname(file).toLowerCase();
      if (ext in EXTENSION_TO_LANGUAGE) {
        extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
      }
    }

    // Scan src/ directory if it exists
    const srcDir = path.join(projectDir, 'src');
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      const srcFiles = fs.readdirSync(srcDir);
      for (const file of srcFiles) {
        const ext = path.extname(file).toLowerCase();
        if (ext in EXTENSION_TO_LANGUAGE) {
          extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  // Find the most common extension
  let maxCount = 0;
  let dominantExt = '';
  for (const [ext, count] of Object.entries(extensionCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantExt = ext;
    }
  }

  return dominantExt ? EXTENSION_TO_LANGUAGE[dominantExt] : 'unknown';
}

/**
 * Detects entry point files that exist in the project.
 */
function detectEntryPoints(projectDir: string): string[] {
  const found: string[] = [];
  for (const entry of COMMON_ENTRY_POINTS) {
    try {
      if (fs.existsSync(path.join(projectDir, entry))) {
        found.push(entry);
      }
    } catch {
      // Ignore access errors
    }
  }
  return found;
}

/**
 * Extracts a simple string value from a TOML key in the [package] section.
 * Uses a basic regex approach — does not require a full TOML parser.
 */
function extractTomlValue(content: string, key: string): string | null {
  // Match key = "value" or key = 'value' patterns
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm');
  const match = content.match(regex);
  return match ? match[1] : null;
}

/**
 * Extracts dependency names from Cargo.toml [dependencies] section.
 */
function extractTomlDependencies(content: string): string[] {
  const deps: string[] = [];

  // Find [dependencies] section
  const depsMatch = content.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (!depsMatch) return deps;

  const depsSection = depsMatch[1];
  // Match lines like: dep_name = "version" or dep_name = { ... }
  const lineRegex = /^\s*([a-zA-Z0-9_-]+)\s*=/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(depsSection)) !== null) {
    deps.push(match[1]);
  }

  return deps;
}

/**
 * Extracts dependency names from pyproject.toml.
 * Looks in [project.dependencies] array or [tool.poetry.dependencies] table.
 */
function extractPyprojectDependencies(content: string): string[] {
  const deps: string[] = [];

  // Try [project] dependencies array: dependencies = ["flask>=2.0", "sqlalchemy"]
  const projectDepsMatch = content.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (projectDepsMatch) {
    const arrayContent = projectDepsMatch[1];
    const stringRegex = /["']([^"'>=<!\s,;]+)/g;
    let match: RegExpExecArray | null;
    while ((match = stringRegex.exec(arrayContent)) !== null) {
      deps.push(match[1]);
    }
    return deps;
  }

  // Try [tool.poetry.dependencies] section
  const poetryMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (poetryMatch) {
    const section = poetryMatch[1];
    const lineRegex = /^\s*([a-zA-Z0-9_-]+)\s*=/gm;
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(section)) !== null) {
      if (match[1] !== 'python') {
        deps.push(match[1]);
      }
    }
  }

  return deps;
}
