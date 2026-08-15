/**
 * SupplyChainIntegrityService — Enforces dependency and software supply-chain integrity.
 *
 * Detects manifests, lockfiles, toolchains, images, plugins, and generated metadata;
 * validates dependency changes (reason, identity, version, license, maintenance, impact);
 * pins/locks versions per policy; checks typo-squatting/namespace confusion;
 * runs vulnerability, license, provenance, secret, install-script, native, privilege,
 * network, and credential checks; requires matched manifest/lockfile and deterministic
 * clean install; fails prohibited licenses, critical vulnerabilities, inconsistent locks,
 * or unverifiable identities absent authorized waiver; and summarizes all dependency
 * deltas, outcomes, and waivers in readiness.
 *
 * Requirements: 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.7, 34.8, 34.9
 */

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Supported dependency ecosystem identifiers.
 */
export type DependencyEcosystem =
  | 'npm'
  | 'PyPI'
  | 'crates.io'
  | 'Go'
  | 'RubyGems'
  | 'Maven'
  | 'NuGet'
  | 'container'
  | 'gradle_plugin'
  | 'github_action';

/**
 * Types of dependency-related files detected in a workspace.
 */
export type DependencyFileKind =
  | 'manifest'
  | 'lockfile'
  | 'toolchain'
  | 'container_image'
  | 'build_plugin'
  | 'generated_metadata';

/**
 * A detected dependency-related file in the affected scope.
 */
export interface DetectedDependencyFile {
  readonly path: string;
  readonly kind: DependencyFileKind;
  readonly ecosystem: DependencyEcosystem;
  readonly contentHash: string;
}

/**
 * Delta type for a dependency change.
 */
export type DependencyDeltaKind = 'added' | 'removed' | 'upgraded' | 'downgraded' | 'modified';

/**
 * A single dependency change declaration from an agent.
 */
export interface DependencyChangeDeclaration {
  readonly name: string;
  readonly ecosystem: DependencyEcosystem;
  readonly previousVersion: string | null;
  readonly newVersion: string | null;
  readonly deltaKind: DependencyDeltaKind;
  readonly reason: string;
  readonly license: string | null;
  readonly maintenanceSignal: MaintenanceSignal | null;
  readonly affectedSurface: 'runtime' | 'build' | 'dev' | 'optional';
  readonly impact: string;
}

/**
 * Maintenance signal for a dependency.
 */
export interface MaintenanceSignal {
  readonly lastPublished: string | null;
  readonly weeklyDownloads: number | null;
  readonly openIssues: number | null;
  readonly hasActiveMaintainer: boolean | null;
  readonly deprecated: boolean;
}

/**
 * Version policy enforcement mode.
 */
export type VersionPinPolicy = 'exact' | 'lockfile_resolved' | 'range_with_lock';

/**
 * Supply chain check category.
 */
export type SupplyChainCheckKind =
  | 'vulnerability'
  | 'license'
  | 'provenance'
  | 'secret'
  | 'install_script'
  | 'native_binary'
  | 'privilege'
  | 'network_access'
  | 'credential_access';

/**
 * Outcome of a single supply chain check.
 */
export type CheckOutcome = 'pass' | 'fail' | 'warn' | 'blocked' | 'skipped';

/**
 * Result from a single supply chain check.
 */
export interface SupplyChainCheckResult {
  readonly id: string;
  readonly kind: SupplyChainCheckKind;
  readonly packageName: string;
  readonly version: string;
  readonly ecosystem: DependencyEcosystem;
  readonly outcome: CheckOutcome;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  readonly details: string;
  readonly recommendation: string | null;
}

/**
 * Overall gate decision for a dependency change set.
 */
export type SupplyChainGateDecision = 'pass' | 'fail' | 'waived';

/**
 * A waiver for a supply chain gate failure.
 */
export interface SupplyChainWaiver {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly checkKind: SupplyChainCheckKind;
  readonly actor: string;
  readonly reason: string;
  readonly scope: string;
  readonly reviewDate: string;
  readonly compensatingControl: string;
  readonly grantedAt: string;
}

/**
 * Manifest/lockfile consistency verification result.
 */
export interface LockfileConsistencyResult {
  readonly manifestPath: string;
  readonly lockfilePath: string;
  readonly consistent: boolean;
  readonly discrepancies: readonly LockfileDiscrepancy[];
  readonly deterministicInstallVerified: boolean;
}

/**
 * A discrepancy between manifest and lockfile.
 */
export interface LockfileDiscrepancy {
  readonly packageName: string;
  readonly manifestVersion: string;
  readonly lockfileVersion: string | null;
  readonly issue: 'missing_from_lock' | 'version_mismatch' | 'extra_in_lock' | 'integrity_mismatch';
}

/**
 * Major-version/maintenance flag for R34.6 warnings.
 */
export interface DependencyFlag {
  readonly packageName: string;
  readonly flagType:
    | 'major_version_change'
    | 'abandoned'
    | 'unmaintained'
    | 'install_scripts'
    | 'native_binary'
    | 'privileged_container'
    | 'network_access'
    | 'credential_access';
  readonly details: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Complete supply chain gate evaluation for a Change_Set.
 */
export interface SupplyChainGateResult {
  readonly id: string;
  readonly changeSetId: string;
  readonly workspaceRevision: string;
  readonly detectedFiles: readonly DetectedDependencyFile[];
  readonly declarations: readonly DependencyChangeDeclaration[];
  readonly checkResults: readonly SupplyChainCheckResult[];
  readonly lockfileConsistency: readonly LockfileConsistencyResult[];
  readonly flags: readonly DependencyFlag[];
  readonly preferenceViolations: readonly PreferenceViolation[];
  readonly decision: SupplyChainGateDecision;
  readonly blockers: readonly GateBlocker[];
  readonly waivers: readonly SupplyChainWaiver[];
  readonly evaluatedAt: string;
  readonly fingerprint: string;
}

/**
 * A specific gate blocker preventing passage.
 */
export interface GateBlocker {
  readonly checkId: string;
  readonly kind: SupplyChainCheckKind | 'inconsistent_lockfile' | 'unverifiable_identity' | 'prohibited_license' | 'missing_declaration';
  readonly packageName: string;
  readonly details: string;
  readonly waiverRequired: boolean;
}

/**
 * Preference violation (R34.7): when an existing dep or platform capability could suffice.
 */
export interface PreferenceViolation {
  readonly newDependency: string;
  readonly existingAlternative: string | null;
  readonly platformCapability: string | null;
  readonly justificationProvided: boolean;
  readonly justification: string | null;
}

/**
 * Readiness summary for the Production_Readiness_Report (R34.9).
 */
export interface DependencyReadinessSummary {
  readonly introduced: readonly DependencyDeltaSummary[];
  readonly removed: readonly DependencyDeltaSummary[];
  readonly upgraded: readonly DependencyDeltaSummary[];
  readonly scanOutcomes: readonly ScanOutcomeSummary[];
  readonly waivers: readonly SupplyChainWaiver[];
  readonly overallDecision: SupplyChainGateDecision;
  readonly blockerCount: number;
  readonly generatedAt: string;
}

/**
 * A dependency delta entry for readiness reporting.
 */
export interface DependencyDeltaSummary {
  readonly name: string;
  readonly ecosystem: DependencyEcosystem;
  readonly previousVersion: string | null;
  readonly newVersion: string | null;
  readonly license: string | null;
  readonly reason: string;
  readonly scanDecision: CheckOutcome;
}

/**
 * Aggregated scan outcome for readiness.
 */
export interface ScanOutcomeSummary {
  readonly kind: SupplyChainCheckKind;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly warned: number;
  readonly waived: number;
}

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Supply chain integrity configuration for a project.
 */
export interface SupplyChainConfig {
  /** Version pinning policy. */
  readonly versionPinPolicy: VersionPinPolicy;
  /** Prohibited license identifiers (SPDX). */
  readonly prohibitedLicenses: readonly string[];
  /** Allowed license identifiers (SPDX). If non-empty, only these are permitted. */
  readonly allowedLicenses: readonly string[];
  /** Maximum tolerable vulnerability severity without waiver. */
  readonly maxVulnerabilitySeverity: 'critical' | 'high' | 'medium' | 'low';
  /** Whether deterministic clean install is enforced. */
  readonly requireDeterministicInstall: boolean;
  /** Existing project dependency names for preference checking. */
  readonly existingDependencies: readonly string[];
  /** Known platform capabilities that may substitute a new dependency. */
  readonly platformCapabilities: readonly string[];
  /** Typosquat edit distance threshold. */
  readonly typosquatThreshold: number;
}

// ─── Adapters ───────────────────────────────────────────────────────────────

/**
 * Adapter for detecting dependency files in the workspace scope.
 */
export interface DependencyFileDetector {
  detect(workspacePath: string, affectedFiles: readonly string[]): Promise<readonly DetectedDependencyFile[]>;
}

/**
 * Adapter for running vulnerability scans.
 */
export interface VulnerabilityScanAdapter {
  scan(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
}

/**
 * Adapter for license detection.
 */
export interface LicenseScanAdapter {
  detect(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
}

/**
 * Adapter for provenance verification.
 */
export interface ProvenanceScanAdapter {
  verify(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
}

/**
 * Adapter for typo-squatting checks.
 */
export interface TyposquatCheckAdapter {
  check(name: string, ecosystem: DependencyEcosystem, threshold: number): Promise<SupplyChainCheckResult>;
}

/**
 * Adapter for lockfile consistency and deterministic install verification.
 */
export interface LockfileVerificationAdapter {
  verifyConsistency(
    manifestPath: string,
    lockfilePath: string,
  ): Promise<LockfileConsistencyResult>;
  verifyDeterministicInstall(workspacePath: string): Promise<boolean>;
}

/**
 * Adapter for additional security checks (secrets, scripts, native, privilege, network, credential).
 */
export interface SecurityCheckAdapter {
  checkSecrets(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
  checkInstallScripts(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
  checkNativeBinaries(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
  checkPrivilege(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
  checkNetworkAccess(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
  checkCredentialAccess(name: string, version: string, ecosystem: DependencyEcosystem): Promise<SupplyChainCheckResult>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default manifest/lockfile pairings per ecosystem. */
export const MANIFEST_LOCKFILE_PAIRS: ReadonlyArray<{
  ecosystem: DependencyEcosystem;
  manifests: readonly string[];
  lockfiles: readonly string[];
}> = [
  { ecosystem: 'npm', manifests: ['package.json'], lockfiles: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] },
  { ecosystem: 'PyPI', manifests: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'], lockfiles: ['requirements.lock', 'Pipfile.lock', 'poetry.lock'] },
  { ecosystem: 'crates.io', manifests: ['Cargo.toml'], lockfiles: ['Cargo.lock'] },
  { ecosystem: 'Go', manifests: ['go.mod'], lockfiles: ['go.sum'] },
  { ecosystem: 'RubyGems', manifests: ['Gemfile'], lockfiles: ['Gemfile.lock'] },
  { ecosystem: 'Maven', manifests: ['pom.xml'], lockfiles: [] },
  { ecosystem: 'NuGet', manifests: ['*.csproj', 'packages.config'], lockfiles: ['packages.lock.json'] },
] as const;

/** File patterns for container images. */
export const CONTAINER_IMAGE_PATTERNS: readonly string[] = [
  'Dockerfile',
  'Dockerfile.*',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  '.dockerignore',
];

/** File patterns for build plugins. */
export const BUILD_PLUGIN_PATTERNS: readonly string[] = [
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  'bitbucket-pipelines.yml',
];

/** File patterns for toolchain declarations. */
export const TOOLCHAIN_PATTERNS: readonly string[] = [
  '.node-version',
  '.nvmrc',
  '.python-version',
  '.ruby-version',
  '.tool-versions',
  'rust-toolchain.toml',
  '.sdkmanrc',
];

// ─── Errors ─────────────────────────────────────────────────────────────────

export class MissingDeclarationError extends Error {
  constructor(packageName: string) {
    super(`Dependency change for '${packageName}' lacks required declaration (reason, identity, version, license, maintenance, impact)`);
    this.name = 'MissingDeclarationError';
  }
}

export class ProhibitedLicenseError extends Error {
  constructor(packageName: string, license: string) {
    super(`Package '${packageName}' uses prohibited license: ${license}`);
    this.name = 'ProhibitedLicenseError';
  }
}

export class InconsistentLockfileError extends Error {
  constructor(manifestPath: string, lockfilePath: string) {
    super(`Manifest '${manifestPath}' and lockfile '${lockfilePath}' are inconsistent`);
    this.name = 'InconsistentLockfileError';
  }
}

// ─── SupplyChainIntegrityService ────────────────────────────────────────────

/**
 * Enforces dependency and software supply-chain integrity for Change_Sets.
 *
 * Integrates existing VulnerabilityBlocker and SupplyChainDetector with
 * additional license, provenance, lockfile, preference, and readiness checks.
 */
export class SupplyChainIntegrityService {
  private readonly gateResults: Map<string, SupplyChainGateResult> = new Map();
  private readonly waivers: Map<string, SupplyChainWaiver> = new Map();

  constructor(
    private readonly fileDetector: DependencyFileDetector,
    private readonly vulnScanner: VulnerabilityScanAdapter,
    private readonly licenseScanner: LicenseScanAdapter,
    private readonly provenanceScanner: ProvenanceScanAdapter,
    private readonly typosquatChecker: TyposquatCheckAdapter,
    private readonly lockfileVerifier: LockfileVerificationAdapter,
    private readonly securityChecker: SecurityCheckAdapter,
    private readonly config: SupplyChainConfig,
  ) {}

  // ─── R34.1: Detect Manifests, Lockfiles, Toolchains, Images, Plugins ────

  /**
   * Detect all dependency-related files within the affected scope.
   */
  async detectDependencyFiles(
    workspacePath: string,
    affectedFiles: readonly string[],
  ): Promise<readonly DetectedDependencyFile[]> {
    return this.fileDetector.detect(workspacePath, affectedFiles);
  }

  // ─── R34.2: Validate Dependency Change Declarations ────────────────────

  /**
   * Validate that every dependency change has the required declaration fields:
   * reason, exact identity/version, detectable license, maintenance signal, and impact.
   *
   * Returns missing-declaration blockers for changes lacking required fields.
   */
  validateDeclarations(
    declarations: readonly DependencyChangeDeclaration[],
  ): readonly GateBlocker[] {
    const blockers: GateBlocker[] = [];

    for (const decl of declarations) {
      const missing: string[] = [];

      if (!decl.reason || decl.reason.trim().length === 0) {
        missing.push('reason');
      }
      if (!decl.name || decl.name.trim().length === 0) {
        missing.push('exact identity');
      }
      if (decl.deltaKind !== 'removed' && (!decl.newVersion || decl.newVersion.trim().length === 0)) {
        missing.push('exact version');
      }
      if (decl.deltaKind !== 'removed' && decl.license === null) {
        missing.push('detectable license');
      }
      if (decl.deltaKind !== 'removed' && decl.maintenanceSignal === null) {
        missing.push('maintenance signal');
      }
      if (!decl.impact || decl.impact.trim().length === 0) {
        missing.push('impact assessment');
      }

      if (missing.length > 0) {
        blockers.push({
          checkId: randomUUID(),
          kind: 'missing_declaration',
          packageName: decl.name,
          details: `Missing required fields: ${missing.join(', ')}`,
          waiverRequired: true,
        });
      }
    }

    return blockers;
  }

  // ─── R34.3: Version Pinning and Typosquat Checks ──────────────────────

  /**
   * Verify that versions are pinned or locked per policy and check for
   * typo-squatting/namespace confusion.
   */
  async checkVersionPolicyAndTyposquat(
    declarations: readonly DependencyChangeDeclaration[],
  ): Promise<{
    versionViolations: readonly GateBlocker[];
    typosquatResults: readonly SupplyChainCheckResult[];
  }> {
    const versionViolations: GateBlocker[] = [];
    const typosquatResults: SupplyChainCheckResult[] = [];

    for (const decl of declarations) {
      if (decl.deltaKind === 'removed') continue;

      // Check version pinning policy
      if (decl.newVersion && !this.isVersionPinned(decl.newVersion)) {
        versionViolations.push({
          checkId: randomUUID(),
          kind: 'unverifiable_identity',
          packageName: decl.name,
          details: `Version '${decl.newVersion}' does not conform to ${this.config.versionPinPolicy} policy`,
          waiverRequired: false,
        });
      }

      // Check typo-squatting
      const typosquatResult = await this.typosquatChecker.check(
        decl.name,
        decl.ecosystem,
        this.config.typosquatThreshold,
      );
      typosquatResults.push(typosquatResult);
    }

    return { versionViolations, typosquatResults };
  }

  // ─── R34.4: Full Security Scan Pipeline ───────────────────────────────

  /**
   * Run the complete supply chain check pipeline on each dependency:
   * vulnerability, license, provenance, secret, install-script, native,
   * privilege, network, and credential checks.
   */
  async runFullScanPipeline(
    declarations: readonly DependencyChangeDeclaration[],
  ): Promise<readonly SupplyChainCheckResult[]> {
    const results: SupplyChainCheckResult[] = [];

    for (const decl of declarations) {
      if (decl.deltaKind === 'removed') continue;
      if (!decl.newVersion) continue;

      // Vulnerability scan
      const vulnResult = await this.vulnScanner.scan(decl.name, decl.newVersion, decl.ecosystem);
      results.push(vulnResult);

      // License scan
      const licenseResult = await this.licenseScanner.detect(decl.name, decl.newVersion, decl.ecosystem);
      results.push(licenseResult);

      // Provenance scan
      const provenanceResult = await this.provenanceScanner.verify(decl.name, decl.newVersion, decl.ecosystem);
      results.push(provenanceResult);

      // Security checks
      const secretResult = await this.securityChecker.checkSecrets(decl.name, decl.newVersion, decl.ecosystem);
      results.push(secretResult);

      const installScriptResult = await this.securityChecker.checkInstallScripts(decl.name, decl.newVersion, decl.ecosystem);
      results.push(installScriptResult);

      const nativeResult = await this.securityChecker.checkNativeBinaries(decl.name, decl.newVersion, decl.ecosystem);
      results.push(nativeResult);

      const privilegeResult = await this.securityChecker.checkPrivilege(decl.name, decl.newVersion, decl.ecosystem);
      results.push(privilegeResult);

      const networkResult = await this.securityChecker.checkNetworkAccess(decl.name, decl.newVersion, decl.ecosystem);
      results.push(networkResult);

      const credentialResult = await this.securityChecker.checkCredentialAccess(decl.name, decl.newVersion, decl.ecosystem);
      results.push(credentialResult);
    }

    return results;
  }

  // ─── R34.5: Lockfile Consistency and Deterministic Install ────────────

  /**
   * Verify that Change_Sets include matched manifest/lockfile and that
   * the lockfile produces a deterministic clean install.
   */
  async verifyLockfileConsistency(
    detectedFiles: readonly DetectedDependencyFile[],
    workspacePath: string,
  ): Promise<readonly LockfileConsistencyResult[]> {
    const results: LockfileConsistencyResult[] = [];

    // Find manifest/lockfile pairs among detected files
    const manifests = detectedFiles.filter((f) => f.kind === 'manifest');
    const lockfiles = detectedFiles.filter((f) => f.kind === 'lockfile');

    for (const manifest of manifests) {
      // Find matching lockfile for this manifest's ecosystem
      const matchingLockfile = lockfiles.find((l) => l.ecosystem === manifest.ecosystem);

      if (!matchingLockfile) {
        // Missing lockfile for manifest change
        results.push({
          manifestPath: manifest.path,
          lockfilePath: '',
          consistent: false,
          discrepancies: [{
            packageName: '*',
            manifestVersion: '*',
            lockfileVersion: null,
            issue: 'missing_from_lock',
          }],
          deterministicInstallVerified: false,
        });
        continue;
      }

      // Verify consistency
      const consistency = await this.lockfileVerifier.verifyConsistency(
        manifest.path,
        matchingLockfile.path,
      );
      results.push(consistency);
    }

    // Additionally verify deterministic install if policy requires it
    if (this.config.requireDeterministicInstall && manifests.length > 0) {
      const deterministicOk = await this.lockfileVerifier.verifyDeterministicInstall(workspacePath);
      // Update results with deterministic install status
      for (let i = 0; i < results.length; i++) {
        if (!results[i]!.deterministicInstallVerified && deterministicOk) {
          results[i] = { ...results[i]!, deterministicInstallVerified: deterministicOk };
        }
      }
    }

    return results;
  }

  // ─── R34.6: Flag Major-Version, Maintenance, and Risk Changes ─────────

  /**
   * Flag major-version changes, abandoned/unmaintained packages, install scripts,
   * native binaries, privileged containers, and dependencies requiring network or
   * credential access.
   */
  flagDependencyRisks(
    declarations: readonly DependencyChangeDeclaration[],
    checkResults: readonly SupplyChainCheckResult[],
  ): readonly DependencyFlag[] {
    const flags: DependencyFlag[] = [];

    for (const decl of declarations) {
      if (decl.deltaKind === 'removed') continue;

      // Major version change
      if (decl.previousVersion && decl.newVersion) {
        const prevMajor = this.extractMajor(decl.previousVersion);
        const newMajor = this.extractMajor(decl.newVersion);
        if (prevMajor !== null && newMajor !== null && newMajor > prevMajor) {
          flags.push({
            packageName: decl.name,
            flagType: 'major_version_change',
            details: `Major version change: ${decl.previousVersion} -> ${decl.newVersion}`,
            severity: 'medium',
          });
        }
      }

      // Maintenance signals
      if (decl.maintenanceSignal) {
        if (decl.maintenanceSignal.deprecated) {
          flags.push({
            packageName: decl.name,
            flagType: 'abandoned',
            details: 'Package is marked as deprecated',
            severity: 'high',
          });
        } else if (decl.maintenanceSignal.lastPublished) {
          const lastPub = new Date(decl.maintenanceSignal.lastPublished);
          const daysSince = (Date.now() - lastPub.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince > 365) {
            flags.push({
              packageName: decl.name,
              flagType: 'unmaintained',
              details: `No updates for ${Math.floor(daysSince)} days`,
              severity: 'medium',
            });
          }
        }
      }

      // Check results-based flags
      const packageChecks = checkResults.filter((r) => r.packageName === decl.name);
      for (const check of packageChecks) {
        if (check.kind === 'install_script' && check.outcome === 'warn') {
          flags.push({
            packageName: decl.name,
            flagType: 'install_scripts',
            details: check.details,
            severity: 'high',
          });
        }
        if (check.kind === 'native_binary' && check.outcome === 'warn') {
          flags.push({
            packageName: decl.name,
            flagType: 'native_binary',
            details: check.details,
            severity: 'medium',
          });
        }
        if (check.kind === 'network_access' && check.outcome === 'warn') {
          flags.push({
            packageName: decl.name,
            flagType: 'network_access',
            details: check.details,
            severity: 'medium',
          });
        }
        if (check.kind === 'credential_access' && check.outcome === 'warn') {
          flags.push({
            packageName: decl.name,
            flagType: 'credential_access',
            details: check.details,
            severity: 'high',
          });
        }
      }
    }

    return flags;
  }

  // ─── R34.7: Prefer Existing Dependencies and Platform Capabilities ────

  /**
   * Check whether newly added dependencies could be replaced by existing project
   * dependencies or platform capabilities.
   */
  checkDependencyPreferences(
    declarations: readonly DependencyChangeDeclaration[],
  ): readonly PreferenceViolation[] {
    const violations: PreferenceViolation[] = [];

    for (const decl of declarations) {
      if (decl.deltaKind !== 'added') continue;

      // Check if an existing dependency could satisfy the need
      const existingMatch = this.config.existingDependencies.find(
        (existing) => this.isReasonableAlternative(existing, decl.name),
      );

      // Check if a platform capability covers this
      const platformMatch = this.config.platformCapabilities.find(
        (cap) => this.isPlatformAlternative(cap, decl.name),
      );

      if (existingMatch || platformMatch) {
        // Check if the declaration provides justification
        const justificationProvided = decl.reason.toLowerCase().includes('existing') ||
          decl.reason.toLowerCase().includes('platform') ||
          decl.reason.toLowerCase().includes('necessary') ||
          decl.reason.toLowerCase().includes('required') ||
          decl.reason.length > 50;

        violations.push({
          newDependency: decl.name,
          existingAlternative: existingMatch ?? null,
          platformCapability: platformMatch ?? null,
          justificationProvided,
          justification: justificationProvided ? decl.reason : null,
        });
      }
    }

    return violations;
  }

  // ─── R34.8: Mandatory Supply Chain Gate ────────────────────────────────

  /**
   * Evaluate the full mandatory supply chain gate. Fails on:
   * - Prohibited licenses
   * - Unresolved critical vulnerabilities
   * - Inconsistent lockfiles
   * - Unverifiable package identity
   *
   * Unless an authorized waiver is recorded.
   */
  async evaluateGate(params: {
    changeSetId: string;
    workspacePath: string;
    workspaceRevision: string;
    affectedFiles: readonly string[];
    declarations: readonly DependencyChangeDeclaration[];
  }): Promise<SupplyChainGateResult> {
    // Step 1: Detect dependency files (R34.1)
    const detectedFiles = await this.detectDependencyFiles(
      params.workspacePath,
      params.affectedFiles,
    );

    // Step 2: Validate declarations (R34.2)
    const declarationBlockers = this.validateDeclarations(params.declarations);

    // Step 3: Check version policy and typosquat (R34.3)
    const { versionViolations, typosquatResults } = await this.checkVersionPolicyAndTyposquat(
      params.declarations,
    );

    // Step 4: Run full scan pipeline (R34.4)
    const scanResults = await this.runFullScanPipeline(params.declarations);
    const allCheckResults = [...typosquatResults, ...scanResults];

    // Step 5: Verify lockfile consistency (R34.5)
    const lockfileResults = await this.verifyLockfileConsistency(detectedFiles, params.workspacePath);

    // Step 6: Flag dependency risks (R34.6)
    const flags = this.flagDependencyRisks(params.declarations, allCheckResults);

    // Step 7: Check preferences (R34.7)
    const preferenceViolations = this.checkDependencyPreferences(params.declarations);

    // Step 8: Compute blockers (R34.8)
    const blockers = this.computeBlockers(
      declarationBlockers,
      versionViolations,
      allCheckResults,
      lockfileResults,
    );

    // Step 9: Apply waivers
    const effectiveBlockers = this.applyWaivers(blockers);

    // Step 10: Determine decision
    const decision = this.determineDecision(effectiveBlockers, blockers);

    const result: SupplyChainGateResult = {
      id: randomUUID(),
      changeSetId: params.changeSetId,
      workspaceRevision: params.workspaceRevision,
      detectedFiles,
      declarations: params.declarations,
      checkResults: allCheckResults,
      lockfileConsistency: lockfileResults,
      flags,
      preferenceViolations,
      decision,
      blockers: effectiveBlockers,
      waivers: this.getWaiversForChangeSet(params.declarations),
      evaluatedAt: new Date().toISOString(),
      fingerprint: this.computeGateFingerprint(params, allCheckResults, lockfileResults),
    };

    this.gateResults.set(result.id, result);
    return result;
  }

  // ─── R34.9: Readiness Summary ─────────────────────────────────────────

  /**
   * Generate a dependency readiness summary for the Production_Readiness_Report.
   * Lists introduced, removed, and upgraded dependencies with scan outcomes and waivers.
   */
  generateReadinessSummary(gateResult: SupplyChainGateResult): DependencyReadinessSummary {
    const introduced: DependencyDeltaSummary[] = [];
    const removed: DependencyDeltaSummary[] = [];
    const upgraded: DependencyDeltaSummary[] = [];

    for (const decl of gateResult.declarations) {
      const relevantChecks = gateResult.checkResults.filter((r) => r.packageName === decl.name);
      const worstOutcome = this.worstCheckOutcome(relevantChecks);

      const summary: DependencyDeltaSummary = {
        name: decl.name,
        ecosystem: decl.ecosystem,
        previousVersion: decl.previousVersion,
        newVersion: decl.newVersion,
        license: decl.license,
        reason: decl.reason,
        scanDecision: worstOutcome,
      };

      switch (decl.deltaKind) {
        case 'added':
          introduced.push(summary);
          break;
        case 'removed':
          removed.push(summary);
          break;
        case 'upgraded':
        case 'downgraded':
        case 'modified':
          upgraded.push(summary);
          break;
      }
    }

    // Aggregate scan outcomes
    const scanOutcomes = this.aggregateScanOutcomes(gateResult.checkResults, gateResult.waivers);

    return {
      introduced,
      removed,
      upgraded,
      scanOutcomes,
      waivers: gateResult.waivers,
      overallDecision: gateResult.decision,
      blockerCount: gateResult.blockers.length,
      generatedAt: new Date().toISOString(),
    };
  }

  // ─── Waiver Management ────────────────────────────────────────────────

  /**
   * Grant a waiver for a specific supply chain gate failure.
   */
  grantWaiver(params: {
    packageName: string;
    version: string;
    checkKind: SupplyChainCheckKind;
    actor: string;
    reason: string;
    scope: string;
    reviewDate: string;
    compensatingControl: string;
  }): SupplyChainWaiver {
    const waiver: SupplyChainWaiver = {
      id: randomUUID(),
      packageName: params.packageName,
      version: params.version,
      checkKind: params.checkKind,
      actor: params.actor,
      reason: params.reason,
      scope: params.scope,
      reviewDate: params.reviewDate,
      compensatingControl: params.compensatingControl,
      grantedAt: new Date().toISOString(),
    };

    const key = `${params.packageName}:${params.version}:${params.checkKind}`;
    this.waivers.set(key, waiver);
    return waiver;
  }

  /**
   * Get all active waivers.
   */
  getWaivers(): readonly SupplyChainWaiver[] {
    return Array.from(this.waivers.values());
  }

  /**
   * Get a gate result by ID.
   */
  getGateResult(id: string): SupplyChainGateResult | null {
    return this.gateResults.get(id) ?? null;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /**
   * Check if a version string is pinned per the configured policy.
   */
  private isVersionPinned(version: string): boolean {
    switch (this.config.versionPinPolicy) {
      case 'exact':
        // Must not contain range characters
        return !version.match(/[~^>=<*|]/);
      case 'lockfile_resolved':
        // Any version is acceptable if lockfile is present and consistent
        return true;
      case 'range_with_lock':
        // Ranges are acceptable as long as lockfile is verified
        return true;
      default:
        return true;
    }
  }

  /**
   * Extract major version number from a semver-like string.
   */
  private extractMajor(version: string): number | null {
    const match = version.match(/^v?(\d+)/);
    return match ? parseInt(match[1]!, 10) : null;
  }

  /**
   * Heuristic to detect if an existing dependency is a reasonable alternative.
   */
  private isReasonableAlternative(existing: string, newDep: string): boolean {
    // Simple heuristic: check if names share significant segments
    const existingParts = existing.toLowerCase().split(/[-/_@]/);
    const newParts = newDep.toLowerCase().split(/[-/_@]/);

    // If key functional terms overlap, they might be alternatives
    const significantOverlap = newParts.filter((p) => p.length > 3).some(
      (p) => existingParts.some((ep) => ep === p || ep.includes(p) || p.includes(ep)),
    );

    return significantOverlap;
  }

  /**
   * Heuristic to detect if a platform capability could substitute a dependency.
   */
  private isPlatformAlternative(capability: string, newDep: string): boolean {
    const capLower = capability.toLowerCase();
    const depLower = newDep.toLowerCase();
    return capLower.includes(depLower) || depLower.includes(capLower);
  }

  /**
   * Compute all gate blockers from individual checks.
   */
  private computeBlockers(
    declarationBlockers: readonly GateBlocker[],
    versionViolations: readonly GateBlocker[],
    checkResults: readonly SupplyChainCheckResult[],
    lockfileResults: readonly LockfileConsistencyResult[],
  ): readonly GateBlocker[] {
    const blockers: GateBlocker[] = [...declarationBlockers, ...versionViolations];

    // Check for prohibited licenses
    for (const result of checkResults) {
      if (result.kind === 'license' && result.outcome === 'fail') {
        blockers.push({
          checkId: result.id,
          kind: 'prohibited_license',
          packageName: result.packageName,
          details: result.details,
          waiverRequired: true,
        });
      }
    }

    // Check for critical/high vulnerabilities
    for (const result of checkResults) {
      if (result.kind === 'vulnerability' && result.outcome === 'fail') {
        const isCritical = result.severity === 'critical' || result.severity === 'high';
        if (isCritical && result.severity <= this.config.maxVulnerabilitySeverity) {
          blockers.push({
            checkId: result.id,
            kind: 'vulnerability',
            packageName: result.packageName,
            details: result.details,
            waiverRequired: true,
          });
        }
      }
    }

    // Check for unverifiable identity
    for (const result of checkResults) {
      if (result.kind === 'provenance' && result.outcome === 'fail') {
        blockers.push({
          checkId: result.id,
          kind: 'unverifiable_identity',
          packageName: result.packageName,
          details: result.details,
          waiverRequired: true,
        });
      }
    }

    // Check for inconsistent lockfiles
    for (const consistency of lockfileResults) {
      if (!consistency.consistent) {
        blockers.push({
          checkId: randomUUID(),
          kind: 'inconsistent_lockfile',
          packageName: '*',
          details: `Inconsistent lockfile: ${consistency.manifestPath} vs ${consistency.lockfilePath}. ${consistency.discrepancies.length} discrepancies found.`,
          waiverRequired: true,
        });
      }
    }

    return blockers;
  }

  /**
   * Filter out blockers that have an active waiver.
   */
  private applyWaivers(blockers: readonly GateBlocker[]): readonly GateBlocker[] {
    return blockers.filter((blocker) => {
      // Map blocker kinds to check kinds for waiver lookup
      const checkKind = this.blockerKindToCheckKind(blocker.kind);
      if (!checkKind) return true; // No mappable check kind — cannot waive

      const specificWaiver = Array.from(this.waivers.values()).find(
        (w) => w.packageName === blocker.packageName && w.checkKind === checkKind,
      );
      return !specificWaiver;
    });
  }

  /**
   * Map a GateBlocker kind to the corresponding SupplyChainCheckKind for waiver lookup.
   */
  private blockerKindToCheckKind(
    kind: GateBlocker['kind'],
  ): SupplyChainCheckKind | null {
    switch (kind) {
      case 'vulnerability': return 'vulnerability';
      case 'prohibited_license': return 'license';
      case 'unverifiable_identity': return 'provenance';
      case 'inconsistent_lockfile': return null; // lockfile issues need separate waiver mechanism
      case 'missing_declaration': return null;
      default: return kind as SupplyChainCheckKind;
    }
  }

  /**
   * Get all waivers relevant to the declarations in this change set.
   */
  private getWaiversForChangeSet(
    declarations: readonly DependencyChangeDeclaration[],
  ): readonly SupplyChainWaiver[] {
    const relevantWaivers: SupplyChainWaiver[] = [];
    for (const waiver of this.waivers.values()) {
      if (declarations.some((d) => d.name === waiver.packageName)) {
        relevantWaivers.push(waiver);
      }
    }
    return relevantWaivers;
  }

  /**
   * Determine overall gate decision based on remaining blockers.
   */
  private determineDecision(
    effectiveBlockers: readonly GateBlocker[],
    originalBlockers: readonly GateBlocker[],
  ): SupplyChainGateDecision {
    if (effectiveBlockers.length > 0) {
      return 'fail';
    }
    if (originalBlockers.length > effectiveBlockers.length) {
      // Some blockers were waived
      return 'waived';
    }
    return 'pass';
  }

  /**
   * Determine the worst outcome from a set of check results.
   */
  private worstCheckOutcome(results: readonly SupplyChainCheckResult[]): CheckOutcome {
    if (results.some((r) => r.outcome === 'fail')) return 'fail';
    if (results.some((r) => r.outcome === 'blocked')) return 'blocked';
    if (results.some((r) => r.outcome === 'warn')) return 'warn';
    if (results.some((r) => r.outcome === 'skipped')) return 'skipped';
    return 'pass';
  }

  /**
   * Aggregate scan outcomes for the readiness summary.
   */
  private aggregateScanOutcomes(
    checkResults: readonly SupplyChainCheckResult[],
    waivers: readonly SupplyChainWaiver[],
  ): readonly ScanOutcomeSummary[] {
    const kinds: SupplyChainCheckKind[] = [
      'vulnerability', 'license', 'provenance', 'secret',
      'install_script', 'native_binary', 'privilege', 'network_access', 'credential_access',
    ];

    return kinds.map((kind) => {
      const kindResults = checkResults.filter((r) => r.kind === kind);
      const waived = waivers.filter((w) => w.checkKind === kind).length;

      return {
        kind,
        total: kindResults.length,
        passed: kindResults.filter((r) => r.outcome === 'pass').length,
        failed: kindResults.filter((r) => r.outcome === 'fail').length,
        warned: kindResults.filter((r) => r.outcome === 'warn').length,
        waived,
      };
    });
  }

  /**
   * Compute a fingerprint for the gate evaluation.
   */
  private computeGateFingerprint(
    params: { changeSetId: string; workspaceRevision: string; declarations: readonly DependencyChangeDeclaration[] },
    checkResults: readonly SupplyChainCheckResult[],
    lockfileResults: readonly LockfileConsistencyResult[],
  ): string {
    const data = JSON.stringify({
      changeSetId: params.changeSetId,
      revision: params.workspaceRevision,
      declCount: params.declarations.length,
      checkCount: checkResults.length,
      lockCount: lockfileResults.length,
      failedChecks: checkResults.filter((r) => r.outcome === 'fail').length,
    });
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `sc_${Math.abs(hash).toString(36)}`;
  }
}
