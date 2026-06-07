/**
 * AI Readiness Score Service — analyzes how well-prepared a project is for AI-assisted coding.
 *
 * Checks: documentation quality, code structure, test coverage, configuration,
 * .gitignore, README, package.json scripts, TypeScript config, etc.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ReadinessCategory {
  name: string;
  score: number;      // 0-100
  maxScore: number;
  issues: ReadinessIssue[];
}

export interface ReadinessIssue {
  category: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  fix?: string;        // one-click fix description
  fixAction?: string;  // action identifier for auto-fix
}

export interface ReadinessResult {
  id: string;
  projectId: string;
  overallScore: number;
  categories: ReadinessCategory[];
  issues: ReadinessIssue[];
  scannedAt: string;
}

export class AIReadinessService {
  constructor(private db: Database.Database) {}

  async scan(projectId: string, projectPath: string): Promise<ReadinessResult> {
    const categories: ReadinessCategory[] = [];
    const allIssues: ReadinessIssue[] = [];

    // 1. Documentation
    const docCat = this.checkDocumentation(projectPath);
    categories.push(docCat);
    allIssues.push(...docCat.issues);

    // 2. Project Configuration
    const configCat = this.checkConfiguration(projectPath);
    categories.push(configCat);
    allIssues.push(...configCat.issues);

    // 3. Code Structure
    const structCat = this.checkCodeStructure(projectPath);
    categories.push(structCat);
    allIssues.push(...structCat.issues);

    // 4. Testing
    const testCat = this.checkTesting(projectPath);
    categories.push(testCat);
    allIssues.push(...testCat.issues);

    // 5. Git & Version Control
    const gitCat = this.checkGit(projectPath);
    categories.push(gitCat);
    allIssues.push(...gitCat.issues);

    // 6. AI-Specific Readiness
    const aiCat = this.checkAIReadiness(projectPath);
    categories.push(aiCat);
    allIssues.push(...aiCat.issues);

    const totalScore = categories.reduce((s, c) => s + c.score, 0);
    const totalMax = categories.reduce((s, c) => s + c.maxScore, 0);
    const overallScore = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(
      'INSERT INTO ai_readiness_scores (id, project_id, overall_score, categories, issues, scanned_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, overallScore, JSON.stringify(categories), JSON.stringify(allIssues), now);

    return { id, projectId, overallScore, categories, issues: allIssues, scannedAt: now };
  }

  getLatest(projectId: string): ReadinessResult | null {
    const row = this.db.prepare(
      'SELECT * FROM ai_readiness_scores WHERE project_id = ? ORDER BY scanned_at DESC LIMIT 1'
    ).get(projectId) as any;
    if (!row) return null;
    return {
      id: row.id, projectId: row.project_id, overallScore: row.overall_score,
      categories: JSON.parse(row.categories), issues: JSON.parse(row.issues),
      scannedAt: row.scanned_at,
    };
  }

  private checkDocumentation(projectPath: string): ReadinessCategory {
    const issues: ReadinessIssue[] = [];
    let score = 0;
    const maxScore = 20;

    const readmePath = path.join(projectPath, 'README.md');
    if (fs.existsSync(readmePath)) {
      const content = fs.readFileSync(readmePath, 'utf-8');
      score += 8;
      if (content.length < 200) {
        issues.push({ category: 'Documentation', severity: 'warning', message: 'README.md is very short (< 200 chars)', fix: 'Add project description, setup instructions, and usage examples', fixAction: 'expand-readme' });
        score -= 2;
      }
      if (content.length > 500) score += 4;
      if (/## (install|setup|getting started)/i.test(content)) score += 4;
      if (/## (usage|api|examples)/i.test(content)) score += 4;
    } else {
      issues.push({ category: 'Documentation', severity: 'critical', message: 'No README.md found', fix: 'Create a README.md with project description and setup instructions', fixAction: 'create-readme' });
    }

    return { name: 'Documentation', score: Math.min(score, maxScore), maxScore, issues };
  }

  private checkConfiguration(projectPath: string): ReadinessCategory {
    const issues: ReadinessIssue[] = [];
    let score = 0;
    const maxScore = 20;

    if (fs.existsSync(path.join(projectPath, 'package.json'))) {
      score += 6;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
        if (pkg.scripts && Object.keys(pkg.scripts).length > 0) score += 4;
        else issues.push({ category: 'Configuration', severity: 'warning', message: 'No scripts defined in package.json', fix: 'Add build, test, and start scripts' });
        if (pkg.description) score += 2;
        if (pkg.engines) score += 2;
      } catch {}
    } else if (fs.existsSync(path.join(projectPath, 'Cargo.toml')) || fs.existsSync(path.join(projectPath, 'go.mod')) || fs.existsSync(path.join(projectPath, 'pom.xml'))) {
      score += 6;
    } else {
      issues.push({ category: 'Configuration', severity: 'warning', message: 'No package manager config found', fix: 'Add package.json, Cargo.toml, or equivalent' });
    }

    if (fs.existsSync(path.join(projectPath, 'tsconfig.json'))) score += 4;
    if (fs.existsSync(path.join(projectPath, '.eslintrc.js')) || fs.existsSync(path.join(projectPath, '.eslintrc.json')) || fs.existsSync(path.join(projectPath, 'eslint.config.js'))) score += 2;

    return { name: 'Configuration', score: Math.min(score, maxScore), maxScore, issues };
  }

  private checkCodeStructure(projectPath: string): ReadinessCategory {
    const issues: ReadinessIssue[] = [];
    let score = 0;
    const maxScore = 20;

    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      score += 10;
      try {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).length;
        if (dirs >= 2) score += 5; // Has organized subdirectories
        if (dirs >= 4) score += 5;
      } catch {}
    } else {
      issues.push({ category: 'Code Structure', severity: 'info', message: 'No src/ directory found', fix: 'Organize source code into a src/ directory' });
      // Check for other common structures
      if (fs.existsSync(path.join(projectPath, 'lib')) || fs.existsSync(path.join(projectPath, 'app'))) score += 8;
    }

    return { name: 'Code Structure', score: Math.min(score, maxScore), maxScore, issues };
  }

  private checkTesting(projectPath: string): ReadinessCategory {
    const issues: ReadinessIssue[] = [];
    let score = 0;
    const maxScore = 20;

    const hasTestDir = fs.existsSync(path.join(projectPath, 'tests')) || fs.existsSync(path.join(projectPath, '__tests__')) || fs.existsSync(path.join(projectPath, 'test'));
    const hasTestConfig = fs.existsSync(path.join(projectPath, 'vitest.config.ts')) || fs.existsSync(path.join(projectPath, 'jest.config.js')) || fs.existsSync(path.join(projectPath, 'jest.config.ts'));

    if (hasTestDir) score += 10;
    else issues.push({ category: 'Testing', severity: 'warning', message: 'No test directory found', fix: 'Create a tests/ directory with at least one test file', fixAction: 'create-tests-dir' });

    if (hasTestConfig) score += 10;
    else if (hasTestDir) {
      issues.push({ category: 'Testing', severity: 'info', message: 'No test runner config found', fix: 'Add vitest.config.ts or jest.config.js' });
      score += 4;
    }

    return { name: 'Testing', score: Math.min(score, maxScore), maxScore, issues };
  }

  private checkGit(projectPath: string): ReadinessCategory {
    const issues: ReadinessIssue[] = [];
    let score = 0;
    const maxScore = 10;

    if (fs.existsSync(path.join(projectPath, '.git'))) {
      score += 4;
      if (fs.existsSync(path.join(projectPath, '.gitignore'))) score += 4;
      else issues.push({ category: 'Git', severity: 'warning', message: 'No .gitignore file', fix: 'Create a .gitignore with common exclusions', fixAction: 'create-gitignore' });
      if (fs.existsSync(path.join(projectPath, '.github'))) score += 2;
    } else {
      issues.push({ category: 'Git', severity: 'critical', message: 'Not a git repository', fix: 'Initialize git with: git init', fixAction: 'git-init' });
    }

    return { name: 'Git & Version Control', score: Math.min(score, maxScore), maxScore, issues };
  }

  private checkAIReadiness(projectPath: string): ReadinessCategory {
    const issues: ReadinessIssue[] = [];
    let score = 0;
    const maxScore = 10;

    // Check for AI-friendly context files (including NeuroNest's own)
    const aiContextFiles = [
      { file: 'NEURONEST.md', label: 'NeuroNest context' },
      { file: '.neuronest/context.md', label: 'NeuroNest context' },
      { file: '.cursorrules', label: 'Cursor rules' },
      { file: '.clinerules', label: 'Cline rules' },
      { file: 'CLAUDE.md', label: 'Claude context' },
      { file: '.kiro', label: 'Kiro context' },
      { file: '.github/copilot-instructions.md', label: 'Copilot instructions' },
    ];

    let foundContext = false;
    for (const ctx of aiContextFiles) {
      if (fs.existsSync(path.join(projectPath, ctx.file))) {
        foundContext = true;
        score += 6;
        break;
      }
    }

    if (!foundContext) {
      issues.push({
        category: 'AI Readiness',
        severity: 'info',
        message: 'No AI context file found',
        fix: 'Create a NEURONEST.md in your project root with coding conventions, architecture notes, and instructions for AI agents. NeuroNest agents will read this before working on your code.',
        fixAction: 'create-neuronest-md'
      });
    }

    // Check for .env.example
    if (fs.existsSync(path.join(projectPath, '.env.example')) || fs.existsSync(path.join(projectPath, '.env.sample'))) {
      score += 4;
    } else if (fs.existsSync(path.join(projectPath, '.env'))) {
      issues.push({ category: 'AI Readiness', severity: 'info', message: 'Has .env but no .env.example', fix: 'Create .env.example so AI agents know what env vars are needed' });
      score += 2;
    }

    return { name: 'AI Readiness', score: Math.min(score, maxScore), maxScore, issues };
  }
}
