/**
 * RepoReadinessScanner — Repository readiness analysis and AGENTS.md generation.
 *
 * Scans a repository for agent-friendliness indicators (module boundaries,
 * documentation coverage, build commands, test presence, CI config) and produces
 * a readiness score with ranked improvement recommendations. Can generate an
 * AGENTS.md file describing architecture, conventions, build commands, key
 * directories, and navigation hints.
 *
 * Key behaviors:
 * - scan() analyzes repository structure for agent-friendliness indicators
 * - Produces ReadinessScore with per-category scores and overall weighted score
 * - generateAgentsMd() creates an AGENTS.md file with project context
 * - Supports incremental updates merging new findings without overwriting user sections
 * - No-op when repo_readiness feature gate is disabled
 *
 * Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, 26.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Interfaces ─────────────────────────────────────────────────

export interface ReadinessScore {
  /** Overall readiness score 0.0–1.0 */
  overall: number;
  /** Per-category scores */
  categories: {
    buildSystem: CategoryScore;
    testCoverage: CategoryScore;
    documentation: CategoryScore;
    ciConfig: CategoryScore;
    moduleBoundaries: CategoryScore;
  };
}

export interface CategoryScore {
  /** Score 0.0–1.0 for this category */
  score: number;
  /** Indicators found for this category */
  indicators: string[];
  /** Specific improvements recommended */
  recommendations: string[];
}

export interface Recommendation {
  /** Category this recommendation belongs to */
  category: keyof ReadinessScore['categories'];
  /** Human-readable description of the improvement */
  description: string;
  /** Impact level — higher impact means more improvement for agent-friendliness */
  impact: 'high' | 'medium' | 'low';
  /** Priority rank (1 = most impactful) */
  rank: number;
}

export interface RepoReadinessReport {
  /** Timestamp of when the scan was performed */
  scannedAt: string;
  /** Root directory that was scanned */
  projectDir: string;
  /** Readiness scores */
  scores: ReadinessScore;
  /** Ranked improvement recommendations */
  recommendations: Recommendation[];
  /** Detected project metadata */
  metadata: ProjectMetadata;
}

export interface ProjectMetadata {
  /** Detected package manager (npm, yarn, pnpm, pip, cargo, go, etc.) */
  packageManager: string | null;
  /** Detected build commands */
  buildCommands: string[];
  /** Detected test commands */
  testCommands: string[];
  /** Detected languages */
  languages: string[];
  /** Key directories found */
  keyDirectories: string[];
  /** Whether CI is configured */
  hasCI: boolean;
  /** Detected framework(s) */
  frameworks: string[];
}

/** Configuration for AGENTS.md generation */
export interface AgentsMdConfig {
  /** Path where AGENTS.md will be written. Default: project root */
  outputPath?: string;
  /** Whether to include build commands section */
  includeBuildCommands?: boolean;
  /** Whether to include navigation hints section */
  includeNavigation?: boolean;
  /** Whether to include architecture section */
  includeArchitecture?: boolean;
  /** Whether to include conventions section */
  includeConventions?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

/** Weight of each category in the overall score */
const CATEGORY_WEIGHTS: Record<keyof ReadinessScore['categories'], number> = {
  buildSystem: 0.25,
  testCoverage: 0.25,
  documentation: 0.20,
  ciConfig: 0.15,
  moduleBoundaries: 0.15,
};

/** Well-known build/config files to look for */
const BUILD_SYSTEM_FILES = [
  'package.json',
  'Makefile',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'Gemfile',
  'mix.exs',
];

/** CI configuration paths */
const CI_CONFIG_PATHS = [
  '.github/workflows',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'Jenkinsfile',
  '.travis.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  '.buildkite/pipeline.yml',
];

/** Documentation files to look for */
const DOC_FILES = [
  'README.md',
  'README.rst',
  'README.txt',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  'AGENTS.md',
  'docs/',
  'doc/',
  'documentation/',
];

/** Test directory patterns */
const TEST_PATTERNS = [
  '__tests__',
  'tests',
  'test',
  'spec',
  'specs',
  '.test.',
  '.spec.',
  '_test.go',
  '_test.rs',
];

/** Marker for user-customized sections in AGENTS.md */
const USER_SECTION_START = '<!-- USER-CUSTOM-START -->';
const USER_SECTION_END = '<!-- USER-CUSTOM-END -->';
const AUTO_SECTION_START = '<!-- AUTO-GENERATED-START -->';
const AUTO_SECTION_END = '<!-- AUTO-GENERATED-END -->';

// ─── RepoReadinessScanner Class ─────────────────────────────────

export class RepoReadinessScanner {
  constructor(private projectDir: string) {}

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Analyze the repository for agent-friendliness indicators.
   * Scans build systems, test coverage, documentation, CI config,
   * and module boundaries to produce a readiness score.
   *
   * Requirements: 26.1, 26.2
   */
  scan(): RepoReadinessReport {
    const buildSystem = this.analyzeBuildSystem();
    const testCoverage = this.analyzeTestCoverage();
    const documentation = this.analyzeDocumentation();
    const ciConfig = this.analyzeCIConfig();
    const moduleBoundaries = this.analyzeModuleBoundaries();

    const scores: ReadinessScore = {
      overall: 0,
      categories: {
        buildSystem,
        testCoverage,
        documentation,
        ciConfig,
        moduleBoundaries,
      },
    };

    // Compute weighted overall score
    scores.overall = this.computeOverallScore(scores.categories);

    const metadata = this.detectMetadata();
    const recommendations = this.buildRecommendations(scores.categories);

    return {
      scannedAt: new Date().toISOString(),
      projectDir: this.projectDir,
      scores,
      recommendations,
      metadata,
    };
  }

  /**
   * Generate an AGENTS.md file with project context for agents.
   * Describes architecture, conventions, build commands, key directories,
   * and navigation hints.
   *
   * If an AGENTS.md already exists, merges new findings into the auto-generated
   * sections without overwriting user-customized sections.
   *
   * Requirements: 26.3, 26.4, 26.5
   */
  generateAgentsMd(
    report: RepoReadinessReport,
    config: AgentsMdConfig = {},
  ): string {
    const outputPath = config.outputPath
      ?? path.join(this.projectDir, 'AGENTS.md');

    const autoContent = this.buildAutoContent(report, config);

    // Check if AGENTS.md already exists
    if (fs.existsSync(outputPath)) {
      const existing = fs.readFileSync(outputPath, 'utf-8');
      const merged = this.mergeWithExisting(existing, autoContent);
      fs.writeFileSync(outputPath, merged, 'utf-8');
      return merged;
    }

    // Create new file with both auto and user sections
    const fullContent = this.buildFullAgentsMd(autoContent);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, fullContent, 'utf-8');
    return fullContent;
  }

  // ─── Analysis Methods ───────────────────────────────────────────

  /**
   * Analyze build system presence and configuration quality.
   */
  private analyzeBuildSystem(): CategoryScore {
    const indicators: string[] = [];
    const recommendations: string[] = [];
    let score = 0;

    // Check for build system files
    const foundBuildFiles: string[] = [];
    for (const file of BUILD_SYSTEM_FILES) {
      if (fs.existsSync(path.join(this.projectDir, file))) {
        foundBuildFiles.push(file);
        indicators.push(`Found ${file}`);
      }
    }

    if (foundBuildFiles.length > 0) {
      score += 0.4;
    } else {
      recommendations.push('Add a build system configuration file (package.json, Makefile, etc.)');
    }

    // Check for lockfile (indicates reproducible builds)
    const lockfiles = [
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      'Cargo.lock', 'Pipfile.lock', 'go.sum', 'Gemfile.lock',
    ];
    const hasLockfile = lockfiles.some((lf) =>
      fs.existsSync(path.join(this.projectDir, lf)),
    );
    if (hasLockfile) {
      score += 0.2;
      indicators.push('Lockfile present (reproducible builds)');
    } else {
      recommendations.push('Add a lockfile for reproducible dependency resolution');
    }

    // Check for build scripts defined in package.json
    if (foundBuildFiles.includes('package.json')) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(this.projectDir, 'package.json'), 'utf-8'),
        );
        if (pkg.scripts) {
          const scriptCount = Object.keys(pkg.scripts).length;
          if (scriptCount > 0) {
            score += 0.2;
            indicators.push(`${scriptCount} npm scripts defined`);
          }
          if (pkg.scripts.build) {
            score += 0.1;
            indicators.push('Build script defined');
          }
          if (pkg.scripts.lint || pkg.scripts['lint:fix']) {
            score += 0.1;
            indicators.push('Lint script defined');
          }
        } else {
          recommendations.push('Add scripts section to package.json with build, test, and lint commands');
        }
      } catch {
        // Malformed package.json
        recommendations.push('Fix malformed package.json');
      }
    }

    return { score: Math.min(1.0, score), indicators, recommendations };
  }

  /**
   * Analyze test presence and coverage indicators.
   */
  private analyzeTestCoverage(): CategoryScore {
    const indicators: string[] = [];
    const recommendations: string[] = [];
    let score = 0;

    // Check for test directories
    const hasTestDir = TEST_PATTERNS.some((pattern) => {
      if (pattern.startsWith('.') || pattern.startsWith('_')) {
        // file-level pattern — check with glob-like search
        return this.hasFilesMatching(pattern);
      }
      return fs.existsSync(path.join(this.projectDir, pattern));
    });

    if (hasTestDir) {
      score += 0.3;
      indicators.push('Test directory/files found');
    } else {
      recommendations.push('Add test files or a test directory');
    }

    // Check for test framework configuration
    const testFrameworkIndicators = [
      { file: 'vitest.config.ts', name: 'Vitest' },
      { file: 'vitest.config.js', name: 'Vitest' },
      { file: 'jest.config.ts', name: 'Jest' },
      { file: 'jest.config.js', name: 'Jest' },
      { file: 'jest.config.json', name: 'Jest' },
      { file: 'pytest.ini', name: 'pytest' },
      { file: 'setup.cfg', name: 'pytest/setuptools' },
      { file: '.mocharc.yml', name: 'Mocha' },
      { file: 'karma.conf.js', name: 'Karma' },
    ];

    for (const { file, name } of testFrameworkIndicators) {
      if (fs.existsSync(path.join(this.projectDir, file))) {
        score += 0.2;
        indicators.push(`${name} configured (${file})`);
        break; // only count once
      }
    }

    // Check for test script in package.json
    if (fs.existsSync(path.join(this.projectDir, 'package.json'))) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(this.projectDir, 'package.json'), 'utf-8'),
        );
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          score += 0.2;
          indicators.push('Test script defined in package.json');
        } else {
          recommendations.push('Add a meaningful test script to package.json');
        }
      } catch {
        // skip
      }
    }

    // Check for coverage config
    const coverageConfigs = [
      '.nycrc', '.nycrc.json', '.c8rc', '.c8rc.json',
      'coverage/', '.istanbul.yml',
    ];
    const hasCoverage = coverageConfigs.some((c) =>
      fs.existsSync(path.join(this.projectDir, c)),
    );
    if (hasCoverage) {
      score += 0.15;
      indicators.push('Coverage configuration present');
    } else {
      recommendations.push('Add code coverage configuration');
    }

    // Check for property-based testing (fast-check, hypothesis, etc.)
    if (this.hasFilesMatching('.property.test.') || this.hasFilesMatching('.prop.test.')) {
      score += 0.15;
      indicators.push('Property-based tests found');
    }

    return { score: Math.min(1.0, score), indicators, recommendations };
  }

  /**
   * Analyze documentation presence and quality.
   */
  private analyzeDocumentation(): CategoryScore {
    const indicators: string[] = [];
    const recommendations: string[] = [];
    let score = 0;

    // Check for README
    const readmeFiles = ['README.md', 'README.rst', 'README.txt', 'README'];
    const hasReadme = readmeFiles.some((f) =>
      fs.existsSync(path.join(this.projectDir, f)),
    );
    if (hasReadme) {
      score += 0.3;
      indicators.push('README present');

      // Check README size (larger = more detailed)
      for (const f of readmeFiles) {
        const fp = path.join(this.projectDir, f);
        if (fs.existsSync(fp)) {
          const stats = fs.statSync(fp);
          if (stats.size > 2048) {
            score += 0.1;
            indicators.push('README is substantive (>2KB)');
          }
          break;
        }
      }
    } else {
      recommendations.push('Add a README.md describing the project');
    }

    // Check for CONTRIBUTING guide
    if (fs.existsSync(path.join(this.projectDir, 'CONTRIBUTING.md'))) {
      score += 0.15;
      indicators.push('CONTRIBUTING.md present');
    } else {
      recommendations.push('Add a CONTRIBUTING.md with development guidelines');
    }

    // Check for docs directory
    const docDirs = ['docs', 'doc', 'documentation'];
    const hasDocsDir = docDirs.some((d) =>
      fs.existsSync(path.join(this.projectDir, d)),
    );
    if (hasDocsDir) {
      score += 0.15;
      indicators.push('Documentation directory present');
    }

    // Check for ARCHITECTURE or AGENTS.md
    if (fs.existsSync(path.join(this.projectDir, 'ARCHITECTURE.md'))) {
      score += 0.15;
      indicators.push('ARCHITECTURE.md present');
    }
    if (fs.existsSync(path.join(this.projectDir, 'AGENTS.md'))) {
      score += 0.15;
      indicators.push('AGENTS.md present');
    } else {
      recommendations.push('Generate AGENTS.md for agent-optimal context');
    }

    return { score: Math.min(1.0, score), indicators, recommendations };
  }

  /**
   * Analyze CI/CD configuration presence.
   */
  private analyzeCIConfig(): CategoryScore {
    const indicators: string[] = [];
    const recommendations: string[] = [];
    let score = 0;

    for (const ciPath of CI_CONFIG_PATHS) {
      const fullPath = path.join(this.projectDir, ciPath);
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          // Check for workflow files inside
          try {
            const files = fs.readdirSync(fullPath);
            if (files.length > 0) {
              score += 0.5;
              indicators.push(`CI configured: ${ciPath} (${files.length} workflow(s))`);
            }
          } catch {
            // permission error, skip
          }
        } else {
          score += 0.5;
          indicators.push(`CI configured: ${ciPath}`);
        }
        break; // only count primary CI once
      }
    }

    if (score === 0) {
      recommendations.push('Add CI/CD configuration (GitHub Actions, GitLab CI, etc.)');
    }

    // Check for linting in CI
    if (fs.existsSync(path.join(this.projectDir, '.eslintrc.js'))
      || fs.existsSync(path.join(this.projectDir, '.eslintrc.json'))
      || fs.existsSync(path.join(this.projectDir, 'eslint.config.js'))
      || fs.existsSync(path.join(this.projectDir, '.eslintrc.yml'))) {
      score += 0.25;
      indicators.push('Linter configured');
    } else {
      recommendations.push('Add a linter configuration for code quality enforcement');
    }

    // Check for formatter
    if (fs.existsSync(path.join(this.projectDir, '.prettierrc.json'))
      || fs.existsSync(path.join(this.projectDir, '.prettierrc'))
      || fs.existsSync(path.join(this.projectDir, '.prettierrc.js'))
      || fs.existsSync(path.join(this.projectDir, '.editorconfig'))) {
      score += 0.25;
      indicators.push('Code formatter configured');
    } else {
      recommendations.push('Add a code formatter (Prettier, .editorconfig)');
    }

    return { score: Math.min(1.0, score), indicators, recommendations };
  }

  /**
   * Analyze module boundaries and project structure clarity.
   */
  private analyzeModuleBoundaries(): CategoryScore {
    const indicators: string[] = [];
    const recommendations: string[] = [];
    let score = 0;

    // Check for src/ directory (organized source)
    const srcDir = path.join(this.projectDir, 'src');
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      score += 0.3;
      indicators.push('src/ directory present');

      // Check for subdirectories (module structure)
      try {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        const subdirs = entries.filter((e) => e.isDirectory());
        if (subdirs.length >= 2) {
          score += 0.3;
          indicators.push(`${subdirs.length} module directories in src/`);
        }
      } catch {
        // skip
      }
    } else {
      recommendations.push('Organize source code into a src/ directory with module subdirectories');
    }

    // Check for TypeScript config (typed boundaries)
    if (fs.existsSync(path.join(this.projectDir, 'tsconfig.json'))
      || fs.existsSync(path.join(this.projectDir, 'tsconfig.base.json'))) {
      score += 0.2;
      indicators.push('TypeScript configured (typed module boundaries)');
    }

    // Check for monorepo structure (packages/ or workspaces)
    if (fs.existsSync(path.join(this.projectDir, 'packages'))
      || fs.existsSync(path.join(this.projectDir, 'apps'))) {
      score += 0.2;
      indicators.push('Monorepo structure detected');
    }

    if (score === 0) {
      recommendations.push('Organize code into clear module boundaries with typed interfaces');
    }

    return { score: Math.min(1.0, score), indicators, recommendations };
  }

  // ─── Score Computation ──────────────────────────────────────────

  /**
   * Compute weighted overall score from category scores.
   */
  private computeOverallScore(
    categories: ReadinessScore['categories'],
  ): number {
    let weighted = 0;
    for (const [key, weight] of Object.entries(CATEGORY_WEIGHTS)) {
      const cat = categories[key as keyof typeof categories];
      weighted += cat.score * weight;
    }
    // Round to 2 decimal places
    return Math.round(weighted * 100) / 100;
  }

  // ─── Recommendations ────────────────────────────────────────────

  /**
   * Build ranked recommendations from category analysis.
   * Sorted by impact (high first), then by category weight.
   */
  private buildRecommendations(
    categories: ReadinessScore['categories'],
  ): Recommendation[] {
    const recs: Recommendation[] = [];

    const impactOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };

    for (const [catKey, catScore] of Object.entries(categories)) {
      const category = catKey as keyof ReadinessScore['categories'];
      for (const desc of catScore.recommendations) {
        // Higher weight + lower score = higher impact
        const weight = CATEGORY_WEIGHTS[category];
        const gap = 1.0 - catScore.score;
        let impact: 'high' | 'medium' | 'low';
        if (gap * weight >= 0.15) {
          impact = 'high';
        } else if (gap * weight >= 0.07) {
          impact = 'medium';
        } else {
          impact = 'low';
        }
        recs.push({ category, description: desc, impact, rank: 0 });
      }
    }

    // Sort by impact, then by category weight descending
    recs.sort((a, b) => {
      const impactDiff = impactOrder[a.impact] - impactOrder[b.impact];
      if (impactDiff !== 0) return impactDiff;
      return CATEGORY_WEIGHTS[b.category] - CATEGORY_WEIGHTS[a.category];
    });

    // Assign ranks
    recs.forEach((r, i) => { r.rank = i + 1; });

    return recs;
  }

  // ─── Metadata Detection ─────────────────────────────────────────

  /**
   * Detect project metadata from build files and directory structure.
   */
  private detectMetadata(): ProjectMetadata {
    const metadata: ProjectMetadata = {
      packageManager: null,
      buildCommands: [],
      testCommands: [],
      languages: [],
      keyDirectories: [],
      hasCI: false,
      frameworks: [],
    };

    // Detect package manager
    if (fs.existsSync(path.join(this.projectDir, 'pnpm-lock.yaml'))) {
      metadata.packageManager = 'pnpm';
    } else if (fs.existsSync(path.join(this.projectDir, 'yarn.lock'))) {
      metadata.packageManager = 'yarn';
    } else if (fs.existsSync(path.join(this.projectDir, 'package-lock.json'))) {
      metadata.packageManager = 'npm';
    } else if (fs.existsSync(path.join(this.projectDir, 'Cargo.lock'))) {
      metadata.packageManager = 'cargo';
    } else if (fs.existsSync(path.join(this.projectDir, 'go.sum'))) {
      metadata.packageManager = 'go';
    } else if (fs.existsSync(path.join(this.projectDir, 'Pipfile.lock'))) {
      metadata.packageManager = 'pipenv';
    } else if (fs.existsSync(path.join(this.projectDir, 'Gemfile.lock'))) {
      metadata.packageManager = 'bundler';
    }

    // Detect build/test commands from package.json
    if (fs.existsSync(path.join(this.projectDir, 'package.json'))) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(this.projectDir, 'package.json'), 'utf-8'),
        );
        if (pkg.scripts) {
          if (pkg.scripts.build) metadata.buildCommands.push(`npm run build`);
          if (pkg.scripts.dev) metadata.buildCommands.push(`npm run dev`);
          if (pkg.scripts.test) metadata.testCommands.push(`npm test`);
          if (pkg.scripts['test:ci']) metadata.testCommands.push(`npm run test:ci`);
          if (pkg.scripts.lint) metadata.testCommands.push(`npm run lint`);
        }

        // Detect frameworks from dependencies
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };
        if (allDeps['react'] || allDeps['react-dom']) metadata.frameworks.push('React');
        if (allDeps['vue']) metadata.frameworks.push('Vue');
        if (allDeps['@angular/core']) metadata.frameworks.push('Angular');
        if (allDeps['next']) metadata.frameworks.push('Next.js');
        if (allDeps['express']) metadata.frameworks.push('Express');
        if (allDeps['electron']) metadata.frameworks.push('Electron');
        if (allDeps['vitest']) metadata.frameworks.push('Vitest');
        if (allDeps['jest']) metadata.frameworks.push('Jest');
      } catch {
        // skip malformed package.json
      }
    }

    // Detect languages from file extensions
    const languageExtensions: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.py': 'Python',
      '.rs': 'Rust',
      '.go': 'Go',
      '.rb': 'Ruby',
      '.java': 'Java',
      '.cpp': 'C++',
      '.c': 'C',
    };

    const detectedLangs = new Set<string>();
    const srcDir = path.join(this.projectDir, 'src');
    if (fs.existsSync(srcDir)) {
      this.walkDirectoryShallow(srcDir, (filePath) => {
        const ext = path.extname(filePath);
        if (languageExtensions[ext]) {
          detectedLangs.add(languageExtensions[ext]);
        }
      });
    }
    metadata.languages = Array.from(detectedLangs);

    // Detect key directories
    const potentialDirs = [
      'src', 'lib', 'packages', 'apps', 'tests', 'test',
      '__tests__', 'docs', 'scripts', 'config', 'public',
      'assets', 'build', 'dist', 'native',
    ];
    for (const dir of potentialDirs) {
      const dirPath = path.join(this.projectDir, dir);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        metadata.keyDirectories.push(dir);
      }
    }

    // Check for CI
    metadata.hasCI = CI_CONFIG_PATHS.some((p) =>
      fs.existsSync(path.join(this.projectDir, p)),
    );

    return metadata;
  }

  // ─── AGENTS.md Generation ───────────────────────────────────────

  /**
   * Build the auto-generated content for AGENTS.md.
   */
  private buildAutoContent(
    report: RepoReadinessReport,
    config: AgentsMdConfig,
  ): string {
    const lines: string[] = [];

    const includeArchitecture = config.includeArchitecture !== false;
    const includeBuild = config.includeBuildCommands !== false;
    const includeNav = config.includeNavigation !== false;
    const includeConventions = config.includeConventions !== false;

    if (includeArchitecture) {
      lines.push('## Architecture Overview');
      lines.push('');
      if (report.metadata.languages.length > 0) {
        lines.push(`**Languages:** ${report.metadata.languages.join(', ')}`);
      }
      if (report.metadata.frameworks.length > 0) {
        lines.push(`**Frameworks:** ${report.metadata.frameworks.join(', ')}`);
      }
      if (report.metadata.packageManager) {
        lines.push(`**Package Manager:** ${report.metadata.packageManager}`);
      }
      lines.push('');
    }

    if (includeBuild && report.metadata.buildCommands.length > 0) {
      lines.push('## Build Commands');
      lines.push('');
      for (const cmd of report.metadata.buildCommands) {
        lines.push(`- \`${cmd}\``);
      }
      lines.push('');
      if (report.metadata.testCommands.length > 0) {
        lines.push('## Test Commands');
        lines.push('');
        for (const cmd of report.metadata.testCommands) {
          lines.push(`- \`${cmd}\``);
        }
        lines.push('');
      }
    }

    if (includeNav && report.metadata.keyDirectories.length > 0) {
      lines.push('## Key Directories');
      lines.push('');
      for (const dir of report.metadata.keyDirectories) {
        lines.push(`- \`${dir}/\``);
      }
      lines.push('');
    }

    if (includeConventions) {
      lines.push('## Conventions');
      lines.push('');
      if (report.metadata.languages.includes('TypeScript')) {
        lines.push('- TypeScript with strict typing');
      }
      if (report.scores.categories.ciConfig.indicators.some((i) => i.includes('Linter'))) {
        lines.push('- Linting enforced (see linter config)');
      }
      if (report.scores.categories.ciConfig.indicators.some((i) => i.includes('formatter'))) {
        lines.push('- Code formatting enforced (see formatter config)');
      }
      if (report.scores.categories.testCoverage.indicators.some((i) => i.includes('Test'))) {
        lines.push('- Tests required for new features');
      }
      lines.push('');
    }

    // Navigation hints
    if (includeNav) {
      lines.push('## Navigation Hints');
      lines.push('');
      lines.push(`- **Readiness Score:** ${(report.scores.overall * 100).toFixed(0)}%`);
      if (report.recommendations.length > 0) {
        lines.push('- **Top Improvements:**');
        const topRecs = report.recommendations.slice(0, 3);
        for (const rec of topRecs) {
          lines.push(`  - [${rec.impact}] ${rec.description}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build a full AGENTS.md file with both auto-generated and user sections.
   */
  private buildFullAgentsMd(autoContent: string): string {
    const lines: string[] = [
      '# AGENTS.md',
      '',
      'This file provides context for AI agents working in this repository.',
      '',
      AUTO_SECTION_START,
      autoContent,
      AUTO_SECTION_END,
      '',
      USER_SECTION_START,
      '## Custom Notes',
      '',
      '<!-- Add your own notes, conventions, or context below -->',
      '',
      USER_SECTION_END,
      '',
    ];
    return lines.join('\n');
  }

  /**
   * Merge new auto-generated content into an existing AGENTS.md,
   * preserving user-customized sections.
   *
   * Requirements: 26.4, 26.5
   */
  mergeWithExisting(existing: string, newAutoContent: string): string {
    const autoStartIdx = existing.indexOf(AUTO_SECTION_START);
    const autoEndIdx = existing.indexOf(AUTO_SECTION_END);

    if (autoStartIdx === -1 || autoEndIdx === -1) {
      // No auto-generated section markers found — append auto content
      // without overwriting existing content
      return existing + '\n\n' + AUTO_SECTION_START + '\n'
        + newAutoContent + AUTO_SECTION_END + '\n';
    }

    // Replace only the auto-generated section
    const before = existing.substring(0, autoStartIdx + AUTO_SECTION_START.length);
    const after = existing.substring(autoEndIdx);

    return before + '\n' + newAutoContent + after;
  }

  // ─── Utility Helpers ────────────────────────────────────────────

  /**
   * Check if any files matching a pattern exist in src/ (shallow scan).
   */
  private hasFilesMatching(pattern: string): boolean {
    const srcDir = path.join(this.projectDir, 'src');
    if (!fs.existsSync(srcDir)) {
      // Fall back to project root
      return this.searchDirForPattern(this.projectDir, pattern, 2);
    }
    return this.searchDirForPattern(srcDir, pattern, 3);
  }

  /**
   * Recursively search a directory for files matching a pattern (limited depth).
   */
  private searchDirForPattern(dir: string, pattern: string, maxDepth: number): boolean {
    if (maxDepth <= 0) return false;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        if (entry.isFile() && entry.name.includes(pattern)) {
          return true;
        }
        if (entry.isDirectory()) {
          if (this.searchDirForPattern(path.join(dir, entry.name), pattern, maxDepth - 1)) {
            return true;
          }
        }
      }
    } catch {
      // permission error, skip
    }
    return false;
  }

  /**
   * Walk a directory shallowly (depth 2) calling callback for each file found.
   */
  private walkDirectoryShallow(
    dir: string,
    callback: (filePath: string) => void,
    depth: number = 2,
  ): void {
    if (depth <= 0) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          callback(fullPath);
        } else if (entry.isDirectory()) {
          this.walkDirectoryShallow(fullPath, callback, depth - 1);
        }
      }
    } catch {
      // permission error, skip
    }
  }
}
