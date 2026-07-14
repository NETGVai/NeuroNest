/**
 * MCP Marketplace Detector — project-aware MCP recommendations.
 *
 * Analyzes project config files (package.json, go.mod, requirements.txt, etc.)
 * to detect the tech stack and score relevance of available MCP servers.
 *
 * Notifies the user when new relevant MCPs are available for their project.
 *
 * Requirements: 9.2, 9.6
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { MCPCatalogEntry } from './marketplace-catalog.js';

// ─── Types ──────────────────────────────────────────────────────

export interface DetectedTechnology {
  name: string;
  confidence: number; // 0..1
  source: string; // file that indicated this technology
}

export interface MCPRecommendation {
  entry: MCPCatalogEntry;
  relevanceScore: number; // 0..1
  reasons: string[];
}

export interface DetectionResult {
  technologies: DetectedTechnology[];
  recommendations: MCPRecommendation[];
}

// ─── Technology → MCP category mappings ─────────────────────────

interface TechMapping {
  technology: string;
  categories: string[];
  mcpIds: string[];
}

const TECH_TO_MCP_MAPPINGS: TechMapping[] = [
  { technology: 'node', categories: ['filesystem', 'core'], mcpIds: ['filesystem-mcp'] },
  { technology: 'react', categories: ['browser', 'frontend'], mcpIds: ['puppeteer-mcp'] },
  { technology: 'next', categories: ['browser', 'frontend'], mcpIds: ['puppeteer-mcp'] },
  { technology: 'postgres', categories: ['database', 'backend'], mcpIds: ['postgres-mcp'] },
  { technology: 'postgresql', categories: ['database', 'backend'], mcpIds: ['postgres-mcp'] },
  { technology: 'redis', categories: ['database', 'backend'], mcpIds: ['redis-mcp'] },
  { technology: 'docker', categories: ['devops', 'containers'], mcpIds: ['docker-mcp'] },
  { technology: 'github', categories: ['vcs', 'productivity'], mcpIds: ['github-mcp'] },
  { technology: 'git', categories: ['vcs', 'productivity'], mcpIds: ['github-mcp'] },
  { technology: 'sqlite', categories: ['database', 'core'], mcpIds: ['sqlite-mcp'] },
  { technology: 'slack', categories: ['communication', 'productivity'], mcpIds: ['slack-mcp'] },
  { technology: 'python', categories: ['core', 'backend'], mcpIds: ['filesystem-mcp'] },
  { technology: 'go', categories: ['core', 'backend'], mcpIds: ['filesystem-mcp'] },
  { technology: 'rust', categories: ['core', 'backend'], mcpIds: ['filesystem-mcp'] },
  { technology: 'typescript', categories: ['core', 'frontend'], mcpIds: ['filesystem-mcp'] },
];

// ─── File detectors ─────────────────────────────────────────────

interface FileDetector {
  file: string;
  detect(content: string): DetectedTechnology[];
}

const FILE_DETECTORS: FileDetector[] = [
  {
    file: 'package.json',
    detect(content: string): DetectedTechnology[] {
      const techs: DetectedTechnology[] = [];
      try {
        const pkg = JSON.parse(content);
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };

        techs.push({ name: 'node', confidence: 1.0, source: 'package.json' });

        if (allDeps['typescript'] || pkg.main?.endsWith('.ts')) {
          techs.push({ name: 'typescript', confidence: 0.9, source: 'package.json' });
        }
        if (allDeps['react'] || allDeps['react-dom']) {
          techs.push({ name: 'react', confidence: 0.9, source: 'package.json' });
        }
        if (allDeps['next']) {
          techs.push({ name: 'next', confidence: 0.9, source: 'package.json' });
        }
        if (allDeps['pg'] || allDeps['postgres'] || allDeps['knex'] || allDeps['prisma']) {
          techs.push({ name: 'postgres', confidence: 0.7, source: 'package.json' });
        }
        if (allDeps['redis'] || allDeps['ioredis']) {
          techs.push({ name: 'redis', confidence: 0.8, source: 'package.json' });
        }
        if (allDeps['better-sqlite3'] || allDeps['sqlite3']) {
          techs.push({ name: 'sqlite', confidence: 0.8, source: 'package.json' });
        }
        if (allDeps['@slack/bolt'] || allDeps['@slack/web-api']) {
          techs.push({ name: 'slack', confidence: 0.8, source: 'package.json' });
        }
        if (allDeps['puppeteer'] || allDeps['playwright']) {
          techs.push({ name: 'puppeteer', confidence: 0.7, source: 'package.json' });
        }
      } catch {
        // Invalid JSON — skip
      }
      return techs;
    },
  },
  {
    file: 'go.mod',
    detect(content: string): DetectedTechnology[] {
      const techs: DetectedTechnology[] = [
        { name: 'go', confidence: 1.0, source: 'go.mod' },
      ];

      if (content.includes('github.com/lib/pq') || content.includes('github.com/jackc/pgx')) {
        techs.push({ name: 'postgres', confidence: 0.8, source: 'go.mod' });
      }
      if (content.includes('github.com/go-redis/redis') || content.includes('github.com/redis/go-redis')) {
        techs.push({ name: 'redis', confidence: 0.8, source: 'go.mod' });
      }
      if (content.includes('github.com/mattn/go-sqlite3')) {
        techs.push({ name: 'sqlite', confidence: 0.8, source: 'go.mod' });
      }
      if (content.includes('github.com/docker/docker')) {
        techs.push({ name: 'docker', confidence: 0.7, source: 'go.mod' });
      }
      return techs;
    },
  },
  {
    file: 'requirements.txt',
    detect(content: string): DetectedTechnology[] {
      const techs: DetectedTechnology[] = [
        { name: 'python', confidence: 1.0, source: 'requirements.txt' },
      ];
      const lower = content.toLowerCase();

      if (lower.includes('psycopg') || lower.includes('sqlalchemy')) {
        techs.push({ name: 'postgres', confidence: 0.7, source: 'requirements.txt' });
      }
      if (lower.includes('redis')) {
        techs.push({ name: 'redis', confidence: 0.7, source: 'requirements.txt' });
      }
      if (lower.includes('docker')) {
        techs.push({ name: 'docker', confidence: 0.6, source: 'requirements.txt' });
      }
      return techs;
    },
  },
  {
    file: 'pyproject.toml',
    detect(content: string): DetectedTechnology[] {
      const techs: DetectedTechnology[] = [
        { name: 'python', confidence: 1.0, source: 'pyproject.toml' },
      ];
      const lower = content.toLowerCase();

      if (lower.includes('psycopg') || lower.includes('sqlalchemy') || lower.includes('asyncpg')) {
        techs.push({ name: 'postgres', confidence: 0.7, source: 'pyproject.toml' });
      }
      if (lower.includes('redis')) {
        techs.push({ name: 'redis', confidence: 0.7, source: 'pyproject.toml' });
      }
      return techs;
    },
  },
  {
    file: 'Cargo.toml',
    detect(content: string): DetectedTechnology[] {
      const techs: DetectedTechnology[] = [
        { name: 'rust', confidence: 1.0, source: 'Cargo.toml' },
      ];
      const lower = content.toLowerCase();

      if (lower.includes('tokio-postgres') || lower.includes('sqlx')) {
        techs.push({ name: 'postgres', confidence: 0.7, source: 'Cargo.toml' });
      }
      if (lower.includes('redis')) {
        techs.push({ name: 'redis', confidence: 0.7, source: 'Cargo.toml' });
      }
      return techs;
    },
  },
  {
    file: 'docker-compose.yml',
    detect(_content: string): DetectedTechnology[] {
      return [{ name: 'docker', confidence: 1.0, source: 'docker-compose.yml' }];
    },
  },
  {
    file: 'docker-compose.yaml',
    detect(_content: string): DetectedTechnology[] {
      return [{ name: 'docker', confidence: 1.0, source: 'docker-compose.yaml' }];
    },
  },
  {
    file: 'Dockerfile',
    detect(_content: string): DetectedTechnology[] {
      return [{ name: 'docker', confidence: 0.9, source: 'Dockerfile' }];
    },
  },
  {
    file: '.github/workflows',
    detect(_content: string): DetectedTechnology[] {
      return [{ name: 'github', confidence: 0.9, source: '.github/workflows' }];
    },
  },
];

// ─── MarketplaceDetector ────────────────────────────────────────

export class MarketplaceDetector {
  private lastDetection: DetectionResult | null = null;

  /**
   * Analyze a project directory for its tech stack and return
   * MCP recommendations sorted by relevance.
   */
  detect(projectDir: string, catalog: MCPCatalogEntry[]): DetectionResult {
    const technologies = this.detectTechnologies(projectDir);
    const recommendations = this.scoreRecommendations(technologies, catalog);

    this.lastDetection = { technologies, recommendations };
    return this.lastDetection;
  }

  /** Get cached detection result (from last call to detect). */
  getLastDetection(): DetectionResult | null {
    return this.lastDetection;
  }

  // ─── Technology detection ─────────────────────────────────────

  private detectTechnologies(projectDir: string): DetectedTechnology[] {
    const detected: DetectedTechnology[] = [];

    for (const detector of FILE_DETECTORS) {
      const filePath = join(projectDir, detector.file);

      // Handle directory-based detection (e.g. .github/workflows)
      if (existsSync(filePath)) {
        try {
          let content = '';
          try {
            content = readFileSync(filePath, 'utf-8');
          } catch {
            // Might be a directory — that's fine, detect with empty content
          }
          const techs = detector.detect(content);
          detected.push(...techs);
        } catch {
          // Skip on error
        }
      }
    }

    // Deduplicate — keep the highest confidence for each technology
    const techMap = new Map<string, DetectedTechnology>();
    for (const tech of detected) {
      const existing = techMap.get(tech.name);
      if (!existing || tech.confidence > existing.confidence) {
        techMap.set(tech.name, tech);
      }
    }

    return [...techMap.values()].sort((a, b) => b.confidence - a.confidence);
  }

  // ─── Recommendation scoring ───────────────────────────────────

  private scoreRecommendations(
    technologies: DetectedTechnology[],
    catalog: MCPCatalogEntry[],
  ): MCPRecommendation[] {
    const recommendations: MCPRecommendation[] = [];

    for (const entry of catalog) {
      const { score, reasons } = this.computeRelevance(entry, technologies);
      if (score > 0) {
        recommendations.push({
          entry,
          relevanceScore: score,
          reasons,
        });
      }
    }

    // Sort by relevance descending
    recommendations.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return recommendations;
  }

  private computeRelevance(
    entry: MCPCatalogEntry,
    technologies: DetectedTechnology[],
  ): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];

    for (const tech of technologies) {
      // Check direct MCP ID match
      const mapping = TECH_TO_MCP_MAPPINGS.find((m) => m.technology === tech.name);
      if (mapping) {
        if (mapping.mcpIds.includes(entry.id)) {
          score += 0.4 * tech.confidence;
          reasons.push(`Directly relevant to ${tech.name}`);
        }

        // Check category overlap
        const categoryOverlap = entry.categories.filter((c) =>
          mapping.categories.includes(c)
        );
        if (categoryOverlap.length > 0) {
          score += 0.2 * tech.confidence * (categoryOverlap.length / mapping.categories.length);
          reasons.push(`Category match: ${categoryOverlap.join(', ')}`);
        }
      }
    }

    // Boost for verified entries
    if (entry.verified) {
      score += 0.05;
      reasons.push('Verified publisher');
    }

    // Boost for high ratings
    if (entry.rating >= 4.5) {
      score += 0.03;
    }

    // Normalize to 0..1
    score = Math.min(1, score);

    return { score, reasons };
  }

  /**
   * Check if there are new recommendations that the user hasn't seen.
   * Returns entries that are recommended but not yet installed.
   */
  getNewRecommendations(
    projectDir: string,
    catalog: MCPCatalogEntry[],
    installedIds: string[],
  ): MCPRecommendation[] {
    const { recommendations } = this.detect(projectDir, catalog);
    return recommendations.filter(
      (rec) => !installedIds.includes(rec.entry.id) && rec.relevanceScore >= 0.3
    );
  }
}
