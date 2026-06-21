/**
 * SupplyChainDetector — Supply chain attack detection via typosquat analysis
 * and package metadata risk indicators.
 *
 * Intercepts package install commands and checks for:
 * - Typosquatting (Levenshtein distance against popular packages)
 * - Newly created packages (< 30 days)
 * - Low download counts
 * - Suspicious install lifecycle scripts (preinstall/postinstall)
 *
 * Supports a local allowlist for pre-approved packages that bypass checks.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6
 */

import * as fs from 'fs';

// ─── Interfaces ─────────────────────────────────────────────────

export interface RiskIndicator {
  type: 'typosquat' | 'new_package' | 'low_downloads' | 'install_scripts';
  severity: 'high' | 'medium' | 'low';
  details: string;
}

export interface SupplyChainAnalysis {
  packageName: string;
  riskIndicators: RiskIndicator[];
  overallRisk: 'safe' | 'suspicious' | 'dangerous';
  allowlisted: boolean;
}

export interface PackageMetadata {
  name: string;
  createdAt?: string;       // ISO date string
  downloadCount?: number;
  hasInstallScripts?: boolean;
  installScriptContents?: string;
}

export interface SupplyChainDetectorConfig {
  allowlistPath: string;
  popularPackagesPath: string;
  editDistanceThreshold: number; // default: 2
}

// ─── Default Popular Packages ───────────────────────────────────

/**
 * Built-in popular package lists per ecosystem.
 * Used as defaults when no external popularPackagesPath is configured.
 */
const DEFAULT_POPULAR_PACKAGES: Record<string, string[]> = {
  npm: [
    'react', 'react-dom', 'next', 'express', 'lodash', 'axios', 'webpack',
    'typescript', 'jest', 'mocha', 'chalk', 'commander', 'inquirer', 'yargs',
    'moment', 'dayjs', 'uuid', 'dotenv', 'cors', 'body-parser', 'mongoose',
    'sequelize', 'prisma', 'zod', 'ajv', 'eslint', 'prettier', 'babel',
    'vite', 'esbuild', 'rollup', 'nodemon', 'pm2', 'socket.io', 'rxjs',
    'underscore', 'ramda', 'immutable', 'redux', 'mobx', 'vue', 'angular',
    'svelte', 'tailwindcss', 'postcss', 'sass', 'less', 'styled-components',
    'emotion', 'material-ui', 'bootstrap', 'jquery', 'three', 'd3', 'puppeteer',
    'playwright', 'cypress', 'vitest', 'fast-check', 'supertest', 'sinon',
    'nock', 'msw', 'graphql', 'apollo', 'trpc', 'fastify', 'koa', 'hapi',
    'debug', 'winston', 'pino', 'bunyan', 'morgan', 'helmet', 'passport',
    'jsonwebtoken', 'bcrypt', 'crypto-js', 'node-fetch', 'got', 'superagent',
  ],
  PyPI: [
    'requests', 'flask', 'django', 'numpy', 'pandas', 'scipy', 'matplotlib',
    'tensorflow', 'pytorch', 'scikit-learn', 'pillow', 'sqlalchemy', 'celery',
    'fastapi', 'uvicorn', 'gunicorn', 'pytest', 'black', 'mypy', 'ruff',
    'pydantic', 'httpx', 'aiohttp', 'beautifulsoup4', 'scrapy', 'selenium',
    'boto3', 'click', 'typer', 'rich', 'tqdm', 'cryptography', 'paramiko',
  ],
  'crates.io': [
    'serde', 'tokio', 'reqwest', 'clap', 'rand', 'regex', 'hyper', 'actix-web',
    'rocket', 'diesel', 'sqlx', 'tracing', 'anyhow', 'thiserror', 'log',
    'chrono', 'uuid', 'serde_json', 'futures', 'async-trait', 'axum',
  ],
  Go: [
    'github.com/gin-gonic/gin', 'github.com/gorilla/mux', 'github.com/go-chi/chi',
    'github.com/stretchr/testify', 'github.com/spf13/cobra', 'github.com/spf13/viper',
    'gorm.io/gorm', 'github.com/sirupsen/logrus', 'go.uber.org/zap',
  ],
  RubyGems: [
    'rails', 'sinatra', 'rack', 'rspec', 'puma', 'sidekiq', 'devise',
    'nokogiri', 'bundler', 'rake', 'activerecord', 'pg', 'redis',
  ],
};

// ─── SupplyChainDetector ────────────────────────────────────────

export class SupplyChainDetector {
  private allowlist: Set<string>;
  private popularPackages: Map<string, string[]>; // ecosystem -> names
  private editDistanceThreshold: number;

  constructor(config: SupplyChainDetectorConfig) {
    this.editDistanceThreshold = config.editDistanceThreshold;
    this.allowlist = this.loadAllowlist(config.allowlistPath);
    this.popularPackages = this.loadPopularPackages(config.popularPackagesPath);
  }

  /**
   * Analyze a package for supply chain attack indicators.
   *
   * If the package is in the local allowlist, returns immediately with
   * overallRisk = 'safe' and allowlisted = true.
   *
   * Otherwise aggregates risk indicators and computes overall risk:
   * - 'dangerous' if any indicator has severity 'high'
   * - 'suspicious' if any indicator has severity 'medium'
   * - 'safe' if no indicators or all are 'low'
   */
  analyze(name: string, ecosystem: string, metadata?: PackageMetadata): SupplyChainAnalysis {
    // Check allowlist first (Req 14.5)
    if (this.allowlist.has(name)) {
      return {
        packageName: name,
        riskIndicators: [],
        overallRisk: 'safe',
        allowlisted: true,
      };
    }

    const riskIndicators: RiskIndicator[] = [];

    // Check typosquatting (Req 14.1, 14.2)
    const typosquatIndicator = this.checkTyposquat(name, ecosystem);
    if (typosquatIndicator) {
      riskIndicators.push(typosquatIndicator);
    }

    // Check package metadata indicators (Req 14.3)
    if (metadata) {
      const metadataIndicators = this.checkMetadata(metadata);
      riskIndicators.push(...metadataIndicators);
    }

    const overallRisk = this.computeOverallRisk(riskIndicators);

    return {
      packageName: name,
      riskIndicators,
      overallRisk,
      allowlisted: false,
    };
  }

  /**
   * Check if a package name is a potential typosquat of a popular package.
   * Uses Levenshtein distance to detect names within the configured threshold.
   *
   * Returns a RiskIndicator if a typosquat match is found, null otherwise.
   */
  checkTyposquat(name: string, ecosystem: string): RiskIndicator | null {
    const popular = this.popularPackages.get(ecosystem) ?? [];

    // Exact match against popular packages is not a typosquat
    if (popular.includes(name)) {
      return null;
    }

    let closestMatch: string | null = null;
    let closestDistance = Infinity;

    for (const popularName of popular) {
      const distance = levenshteinDistance(name, popularName);

      // Only consider packages within the edit distance threshold
      if (distance <= this.editDistanceThreshold && distance > 0) {
        if (distance < closestDistance) {
          closestDistance = distance;
          closestMatch = popularName;
        }
      }
    }

    if (closestMatch !== null) {
      const severity: RiskIndicator['severity'] = closestDistance === 1 ? 'high' : 'medium';
      return {
        type: 'typosquat',
        severity,
        details: `Package "${name}" is ${closestDistance} edit(s) away from popular package "${closestMatch}"`,
      };
    }

    return null;
  }

  /**
   * Add a package to the local allowlist.
   */
  addToAllowlist(name: string): void {
    this.allowlist.add(name);
  }

  /**
   * Remove a package from the local allowlist.
   */
  removeFromAllowlist(name: string): void {
    this.allowlist.delete(name);
  }

  /**
   * Check if a package is on the allowlist.
   */
  isAllowlisted(name: string): boolean {
    return this.allowlist.has(name);
  }

  /**
   * Get the allowlist as an array.
   */
  getAllowlist(): string[] {
    return Array.from(this.allowlist);
  }

  // ─── Private Methods ────────────────────────────────────────────

  private checkMetadata(metadata: PackageMetadata): RiskIndicator[] {
    const indicators: RiskIndicator[] = [];

    // Check creation date < 30 days (Req 14.3)
    if (metadata.createdAt) {
      const createdDate = new Date(metadata.createdAt);
      const now = new Date();
      const daysSinceCreation = (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceCreation < 30) {
        indicators.push({
          type: 'new_package',
          severity: 'medium',
          details: `Package created ${Math.floor(daysSinceCreation)} days ago (threshold: 30 days)`,
        });
      }
    }

    // Check low download count (Req 14.3)
    if (metadata.downloadCount !== undefined && metadata.downloadCount < 100) {
      indicators.push({
        type: 'low_downloads',
        severity: 'medium',
        details: `Package has only ${metadata.downloadCount} downloads (threshold: 100)`,
      });
    }

    // Check install scripts (Req 14.3, 14.4)
    if (metadata.hasInstallScripts) {
      indicators.push({
        type: 'install_scripts',
        severity: 'high',
        details: metadata.installScriptContents
          ? `Package contains install lifecycle scripts: ${metadata.installScriptContents.slice(0, 200)}`
          : 'Package contains install lifecycle scripts (preinstall/postinstall)',
      });
    }

    return indicators;
  }

  private computeOverallRisk(indicators: RiskIndicator[]): SupplyChainAnalysis['overallRisk'] {
    if (indicators.length === 0) {
      return 'safe';
    }

    const hasHigh = indicators.some((i) => i.severity === 'high');
    if (hasHigh) {
      return 'dangerous';
    }

    const hasMedium = indicators.some((i) => i.severity === 'medium');
    if (hasMedium) {
      return 'suspicious';
    }

    return 'safe';
  }

  private loadAllowlist(allowlistPath: string): Set<string> {
    try {
      if (!fs.existsSync(allowlistPath)) {
        return new Set();
      }

      const raw = fs.readFileSync(allowlistPath, 'utf-8');
      const data = JSON.parse(raw);

      if (Array.isArray(data)) {
        return new Set(data.filter((item) => typeof item === 'string'));
      }

      return new Set();
    } catch {
      return new Set();
    }
  }

  private loadPopularPackages(popularPackagesPath: string): Map<string, string[]> {
    const packages = new Map<string, string[]>();

    // Load defaults first
    for (const [ecosystem, names] of Object.entries(DEFAULT_POPULAR_PACKAGES)) {
      packages.set(ecosystem, [...names]);
    }

    // Try to load custom popular packages and merge
    try {
      if (fs.existsSync(popularPackagesPath)) {
        const raw = fs.readFileSync(popularPackagesPath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, string[]>;

        if (typeof data === 'object' && data !== null) {
          for (const [ecosystem, names] of Object.entries(data)) {
            if (Array.isArray(names)) {
              const existing = packages.get(ecosystem) ?? [];
              const mergedSet = new Set<string>(existing);
              for (const n of names) {
                mergedSet.add(n);
              }
              packages.set(ecosystem, Array.from(mergedSet));
            }
          }
        }
      }
    } catch {
      // Use defaults on parse failure — non-critical
    }

    return packages;
  }
}

// ─── Levenshtein Distance ───────────────────────────────────────

/**
 * Compute Levenshtein edit distance between two strings.
 * Uses the classic dynamic programming approach with O(min(m,n)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Early termination for empty strings
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single row of DP table (space optimization)
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);

  // Initialize first row
  for (let i = 0; i <= m; i++) {
    prev[i] = i;
  }

  for (let j = 1; j <= n; j++) {
    curr[0] = j;

    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,      // deletion
        curr[i - 1] + 1,  // insertion
        prev[i - 1] + cost, // substitution
      );
    }

    // Swap rows
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

// ─── Supply Chain Interceptor ───────────────────────────────────

/**
 * Create a pre-execution interceptor for the ToolSystem.
 * Returns a function that intercepts install commands and checks for
 * supply chain attack indicators.
 *
 * Usage:
 *   const interceptor = createSupplyChainInterceptor(detector, featureGate);
 *   // Wire into ToolSystem execute pipeline alongside VulnInterceptor
 */
export function createSupplyChainInterceptor(
  detector: SupplyChainDetector,
  isEnabled: () => boolean,
): (name: string, ecosystem: string, metadata?: PackageMetadata) => SupplyChainAnalysis | null {
  return (name: string, ecosystem: string, metadata?: PackageMetadata): SupplyChainAnalysis | null => {
    // Feature gate check — zero cost when disabled (Req 14.6)
    if (!isEnabled()) {
      return null;
    }

    return detector.analyze(name, ecosystem, metadata);
  };
}
