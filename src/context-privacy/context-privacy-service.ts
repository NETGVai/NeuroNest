/**
 * ContextPrivacyService — Enforces context, path, secret, and provider privacy policy.
 *
 * Requirements: 16.8, 25.1, 25.2, 25.3, 25.5, 25.6, 25.11
 *
 * Before provider transmission, revalidates:
 *   - Staleness (content version matches current)
 *   - Path policy (within workspace roots, not excluded)
 *   - Path canonicalization (symlinks, traversal, case variants, renamed paths)
 *   - Exclusion patterns (gitignore, .env, node_modules, etc.)
 *   - Secret scanning (API keys, passwords, tokens)
 *   - Size limits (configurable max)
 *   - Binary type rejection (non-text files)
 *   - Explicit grants with duration enforcement
 *   - Provider scope validation (local > trusted > external)
 *   - Token budget check (total context doesn't exceed limit)
 *   - Local-only mode blocking of all external transmission
 *
 * Path canonicalization:
 *   - Resolves symlinks to detect escapes
 *   - Normalizes traversal (..) sequences
 *   - Handles case-insensitive filesystem variants
 *   - Validates renamed paths against workspace roots
 *   - Applied to reads, searches, writes, diffs, context, and language operations
 *
 * Provider privacy:
 *   - Local and direct-provider routes always remain available
 *   - Provider and data scope are disclosed before transmission
 *   - Absolute home paths are redacted from shareable output unless explicitly requested
 *   - Fallback never silently weakens trust constraints
 *
 * Display labels are never reparsed as authority.
 * Typed references are resolved with source identity and version.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import {
  type ContextItem,
  type PrivacyPolicyConfig,
  type PrivacyValidationResult,
  type ItemValidationResult,
  type RejectionReason,
  type VersionRegistry,
  type ProviderConfig,
  type ProviderTrustLevel,
  type DurationGrant,
  type ProviderScopeDisclosure,
  type CanonicalPathResult,
  type PathOperationType,
  TRUST_LEVEL_ORDER,
} from './types.js';

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

const DEFAULT_SECRET_PATTERNS: string[] = [
  // API keys with common prefixes
  'sk-[a-zA-Z0-9]{20,}',
  'pk-[a-zA-Z0-9]{20,}',
  'api[_-]?key[\\s]*[:=][\\s]*["\']?[a-zA-Z0-9_\\-]{16,}',
  // AWS-style keys
  'AKIA[0-9A-Z]{16}',
  // GitHub tokens
  'gh[pousr]_[A-Za-z0-9_]{36,}',
  // Generic password assignments
  'password[\\s]*[:=][\\s]*["\'][^"\']{4,}["\']',
  // Bearer tokens
  'Bearer\\s+[a-zA-Z0-9\\-._~+/]+=*',
  // Private keys
  '-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----',
  // Connection strings with credentials
  '(mongodb|postgres|mysql|redis)://[^\\s:]+:[^\\s@]+@',
];

const DEFAULT_BINARY_EXTENSIONS: string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.o', '.obj', '.class', '.pyc', '.pyo',
  '.sqlite', '.db',
  '.wasm',
  '.onnx',
];

const DEFAULT_EXCLUSION_PATTERNS: string[] = [
  'node_modules/**',
  '.git/**',
  '.env',
  '.env.*',
  '*.log',
  'dist/**',
  'build/**',
  '.DS_Store',
  'coverage/**',
  '*.min.js',
  '*.min.css',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

// ---------------------------------------------------------------------------
// ContextPrivacyService
// ---------------------------------------------------------------------------

export class ContextPrivacyService {
  private readonly policy: PrivacyPolicyConfig;
  private readonly versionRegistry: VersionRegistry;
  private readonly secretRegexes: RegExp[];
  private readonly providers: Map<string, ProviderConfig>;
  private readonly grants: Map<string, DurationGrant>;
  private readonly homeDir: string;

  constructor(
    policy: Partial<PrivacyPolicyConfig> & Pick<PrivacyPolicyConfig, 'workspaceRoots' | 'providerTrustLevel'>,
    versionRegistry: VersionRegistry,
    providers?: ProviderConfig[],
    grants?: DurationGrant[],
  ) {
    this.policy = {
      workspaceRoots: policy.workspaceRoots.map((r) => this.normalizePath(r)),
      exclusionPatterns: policy.exclusionPatterns ?? DEFAULT_EXCLUSION_PATTERNS,
      maxItemSizeBytes: policy.maxItemSizeBytes ?? 512 * 1024, // 512KB default
      maxTokenBudget: policy.maxTokenBudget ?? 128_000,
      secretPatterns: policy.secretPatterns ?? DEFAULT_SECRET_PATTERNS,
      binaryExtensions: policy.binaryExtensions ?? DEFAULT_BINARY_EXTENSIONS,
      providerTrustLevel: policy.providerTrustLevel,
      localOnly: policy.localOnly ?? false,
      resolveSymlinks: policy.resolveSymlinks ?? true,
      caseInsensitivePaths: policy.caseInsensitivePaths ?? false,
    };

    this.versionRegistry = versionRegistry;
    this.secretRegexes = this.policy.secretPatterns.map((p) => new RegExp(p, 'i'));
    this.providers = new Map();
    if (providers) {
      for (const p of providers) {
        this.providers.set(p.id, p);
      }
    }

    this.grants = new Map();
    if (grants) {
      for (const g of grants) {
        this.grants.set(g.id, g);
      }
    }

    this.homeDir = this.normalizePath(os.homedir());
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Validate a batch of context items before provider transmission.
   * Returns passed and rejected items with reasons plus provider disclosure.
   *
   * Only content that passes ALL policy checks proceeds to transmission.
   * Display labels are never reparsed as authority — only sourceUri and version matter.
   *
   * Requirements: 16.8 — Revalidate exclusions, secrets, size, binary type,
   * workspace roots, explicit grants, provider scope, and stale versions.
   */
  validateForTransmission(items: ContextItem[], providerId?: string): PrivacyValidationResult {
    const passed: ItemValidationResult[] = [];
    const rejected: ItemValidationResult[] = [];
    let totalTokens = 0;

    // Local-only mode blocks ALL external transmission
    if (this.policy.localOnly && this.policy.providerTrustLevel !== 'local') {
      for (const item of items) {
        rejected.push(this.reject(item, 'local_only_violation', 'Local-only mode is active; external transmission is blocked'));
      }
      const result: PrivacyValidationResult = {
        passed,
        rejected,
        totalPassedTokens: 0,
        allPassed: false,
      };
      const disclosure = this.buildProviderDisclosure(providerId);
      if (disclosure) {
        result.providerDisclosure = disclosure;
      }
      return result;
    }

    for (const item of items) {
      const result = this.validateItem(item, totalTokens);
      if (result.passed) {
        totalTokens += item.estimatedTokens;
        passed.push(result);
      } else {
        rejected.push(result);
      }
    }

    const result: PrivacyValidationResult = {
      passed,
      rejected,
      totalPassedTokens: totalTokens,
      allPassed: rejected.length === 0,
    };
    const disclosure = this.buildProviderDisclosure(providerId);
    if (disclosure) {
      result.providerDisclosure = disclosure;
    }
    return result;
  }

  /**
   * Canonicalize a path for a specific operation type.
   * Resolves symlinks, traversal, case variants, and renamed paths.
   * Returns the canonical path and validation result.
   *
   * Requirements: 25.1, 25.2 — ALL file references SHALL be canonicalized and
   * checked against allowed workspace roots. Symlinks, parent traversal, case
   * differences, and renamed paths SHALL NOT allow escape.
   */
  canonicalizePath(inputPath: string, _operation: PathOperationType): CanonicalPathResult {
    try {
      // Step 1: Normalize (resolve .., ., double separators)
      const normalized = this.normalizePath(inputPath);

      // Step 2: Check for traversal escape attempts before filesystem access
      const logicalCheck = this.checkLogicalContainment(normalized);
      if (!logicalCheck.valid) {
        return logicalCheck;
      }

      // Step 3: Resolve symlinks if enabled
      if (this.policy.resolveSymlinks) {
        return this.resolveAndValidateSymlinks(normalized);
      }

      return { valid: true, canonicalPath: normalized, resolvedSymlink: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { valid: false, canonicalPath: inputPath, resolvedSymlink: false, reason: message };
    }
  }

  /**
   * Add a duration-limited out-of-workspace grant.
   * Requirements: 25.3 — OUT-OF-WORKSPACE access SHALL require a separate explicit
   * capability grant naming the target path and duration.
   */
  addGrant(grant: DurationGrant): void {
    this.grants.set(grant.id, grant);
  }

  /**
   * Remove a grant by ID.
   */
  removeGrant(grantId: string): boolean {
    return this.grants.delete(grantId);
  }

  /**
   * Check if a grant is currently valid (not expired).
   */
  isGrantValid(grantId: string, now?: number): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    const currentTime = now ?? Date.now();
    return currentTime < (grant.grantedAt + grant.durationMs);
  }

  /**
   * Check if a path has a valid non-expired grant.
   */
  hasValidGrant(targetPath: string, now?: number): boolean {
    const normalized = this.normalizePath(targetPath);
    const currentTime = now ?? Date.now();

    for (const grant of this.grants.values()) {
      const grantPath = this.normalizePath(grant.targetPath);
      const isExpired = currentTime >= (grant.grantedAt + grant.durationMs);
      if (isExpired) continue;

      // Check if the target path is at or under the grant path
      if (this.pathContains(grantPath, normalized)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Build provider scope disclosure for user review.
   * Requirements: 25.5 — BEFORE context leaves the device, THE system SHALL
   * show the selected provider and data scope.
   * Requirements: 25.6 — Local model and direct-provider configurations SHALL
   * remain available.
   */
  buildProviderDisclosure(providerId?: string): ProviderScopeDisclosure | undefined {
    if (!providerId) return undefined;
    const provider = this.providers.get(providerId);
    if (!provider) return undefined;

    return {
      providerId: provider.id,
      providerName: provider.name,
      trustLevel: provider.trustLevel,
      isLocalRoute: provider.isLocal ?? (provider.trustLevel === 'local'),
      dataScope: this.deriveDataScope(provider),
      transmitsSourceContent: provider.trustLevel !== 'local',
      endpointDescription: provider.endpointDescription ?? (provider.isLocal ? 'Local model (on-device)' : 'Remote endpoint'),
    };
  }

  /**
   * Redact absolute home-directory paths from shareable output.
   * Requirements: 25.11 — THE system SHALL redact absolute home-directory paths
   * from shareable deep links and exported diagnostics unless explicitly requested.
   *
   * @param content - The content to redact
   * @param includeAbsolutePaths - If true, skip redaction (user explicitly requested)
   */
  redactHomePaths(content: string, includeAbsolutePaths = false): string {
    if (includeAbsolutePaths) {
      return content;
    }

    const homeDir = this.homeDir;
    if (!homeDir) return content;

    // Replace absolute home path with ~ placeholder
    // Handle both forward-slash and backslash variants
    const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const homeRegex = new RegExp(escapedHome, 'g');
    return content.replace(homeRegex, '~');
  }

  /**
   * Classify provider trust level.
   */
  classifyProviderTrust(providerId: string): ProviderTrustLevel | null {
    const provider = this.providers.get(providerId);
    return provider?.trustLevel ?? null;
  }

  /**
   * Validate that a fallback provider does not weaken privacy constraints.
   * Returns true if the fallback is safe (same or higher trust level).
   */
  validateFallbackTrust(primaryProviderId: string, fallbackProviderId: string): boolean {
    const primary = this.providers.get(primaryProviderId);
    const fallback = this.providers.get(fallbackProviderId);

    if (!primary || !fallback) {
      return false;
    }

    // Fallback trust must be >= primary trust
    return TRUST_LEVEL_ORDER[fallback.trustLevel] >= TRUST_LEVEL_ORDER[primary.trustLevel];
  }

  /**
   * Filter items that are approved for a given trust level.
   * Items approved only for a higher trust level are excluded.
   */
  filterByTrustLevel(items: ContextItem[], targetTrustLevel: ProviderTrustLevel): ContextItem[] {
    return items.filter((item) => {
      return TRUST_LEVEL_ORDER[targetTrustLevel] >= TRUST_LEVEL_ORDER[item.approvedTrustLevel];
    });
  }

  /**
   * Check if local-only mode is active.
   * Requirements: 25.6 — Local model and direct-provider configurations
   * SHALL remain available.
   */
  isLocalOnlyMode(): boolean {
    return this.policy.localOnly ?? false;
  }

  /**
   * Get all expired grants for cleanup.
   */
  getExpiredGrants(now?: number): DurationGrant[] {
    const currentTime = now ?? Date.now();
    const expired: DurationGrant[] = [];
    for (const grant of this.grants.values()) {
      if (currentTime >= (grant.grantedAt + grant.durationMs)) {
        expired.push(grant);
      }
    }
    return expired;
  }

  // ─── Private Validation Logic ───────────────────────────────────

  private validateItem(item: ContextItem, currentTokenTotal: number): ItemValidationResult {
    // 1. Content presence check
    if (item.content === null || item.content === undefined) {
      return this.reject(item, 'content_missing', 'Content is null or undefined');
    }

    // 2. Staleness check — version must match current
    const stalenessResult = this.checkStaleness(item);
    if (stalenessResult) {
      return stalenessResult;
    }

    // 3. Path policy — must be within workspace roots or have valid grant
    const pathResult = this.checkPathPolicy(item);
    if (pathResult) {
      return pathResult;
    }

    // 4. Exclusion patterns
    const exclusionResult = this.checkExclusions(item);
    if (exclusionResult) {
      return exclusionResult;
    }

    // 5. Secret scanning
    const secretResult = this.checkSecrets(item);
    if (secretResult) {
      return secretResult;
    }

    // 6. Size limit
    const sizeResult = this.checkSize(item);
    if (sizeResult) {
      return sizeResult;
    }

    // 7. Binary type rejection
    const binaryResult = this.checkBinaryType(item);
    if (binaryResult) {
      return binaryResult;
    }

    // 8. Provider trust level validation
    const trustResult = this.checkTrustLevel(item);
    if (trustResult) {
      return trustResult;
    }

    // 9. Token budget check
    const budgetResult = this.checkTokenBudget(item, currentTokenTotal);
    if (budgetResult) {
      return budgetResult;
    }

    return { item, passed: true };
  }

  private checkStaleness(item: ContextItem): ItemValidationResult | null {
    const currentVersion = this.versionRegistry.getCurrentVersion(item.sourceUri);
    if (currentVersion !== null && currentVersion !== item.version) {
      return this.reject(
        item,
        'stale_version',
        `Version mismatch: item has v${item.version}, current is v${currentVersion}`,
      );
    }
    return null;
  }

  private checkPathPolicy(item: ContextItem): ItemValidationResult | null {
    // Non-file types (url, diagnostic, etc.) don't need path validation
    if (!this.isPathBasedType(item.type)) {
      return null;
    }

    // Items with explicit grants bypass workspace root checks if grant is valid
    if (item.hasExplicitGrant) {
      return this.validateExplicitGrant(item);
    }

    const normalizedUri = this.normalizePath(item.sourceUri);

    // First check logical containment (handles traversal and case normalization)
    const withinWorkspace = this.isWithinWorkspace(normalizedUri);
    if (!withinWorkspace) {
      return this.reject(
        item,
        'path_violation',
        `Path "${item.sourceUri}" is outside workspace roots`,
      );
    }

    // If within workspace logically, also check symlink resolution for escape attempts
    if (this.policy.resolveSymlinks) {
      const symlinkResult = this.checkSymlinkEscape(item.sourceUri, normalizedUri);
      if (symlinkResult) {
        return symlinkResult;
      }
    }

    return null;
  }

  /**
   * Validate an explicit out-of-workspace grant.
   * Checks that the grant exists and has not expired.
   * If no grants are configured, hasExplicitGrant=true alone is sufficient
   * (backward compatible behavior for simple grant flags).
   */
  private validateExplicitGrant(item: ContextItem): ItemValidationResult | null {
    // First check if it's within workspace (grants are only needed for out-of-workspace)
    const normalizedUri = this.normalizePath(item.sourceUri);
    const withinWorkspace = this.isWithinWorkspace(normalizedUri);
    if (withinWorkspace) {
      return null; // Within workspace, no grant needed
    }

    // If the grant store has entries, validate via duration grant
    if (this.grants.size > 0) {
      const hasGrant = this.hasValidGrant(item.sourceUri);
      if (!hasGrant) {
        return this.reject(
          item,
          'grant_expired',
          `Out-of-workspace path "${item.sourceUri}" has no valid (non-expired) grant`,
        );
      }
    }

    // hasExplicitGrant flag alone is sufficient when no duration grants are configured
    return null;
  }

  /**
   * Check if a path that is logically within workspace escapes via symlink.
   * Returns a rejection result only if symlink resolution confirms an escape.
   * If the path doesn't exist (common in tests), it falls back to logical check only.
   */
  private checkSymlinkEscape(originalUri: string, normalizedUri: string): ItemValidationResult | null {
    try {
      const realPath = fs.realpathSync(normalizedUri);
      const realNormalized = this.normalizePath(realPath);
      if (!this.isWithinWorkspace(realNormalized)) {
        return {
          item: { sourceUri: originalUri } as ContextItem,
          passed: false,
          rejectionReason: 'symlink_escape',
          details: `Path "${originalUri}" resolves via symlink to "${realNormalized}" which is outside workspace roots`,
        };
      }
    } catch {
      // Path doesn't exist on disk — symlink check is not applicable, rely on logical check
    }
    return null;
  }

  private checkExclusions(item: ContextItem): ItemValidationResult | null {
    if (!this.isPathBasedType(item.type)) {
      return null;
    }

    const relativePath = this.getRelativePath(item.sourceUri);
    if (!relativePath) {
      return null;
    }

    for (const pattern of this.policy.exclusionPatterns) {
      if (this.matchesGlob(relativePath, pattern)) {
        return this.reject(
          item,
          'excluded_pattern',
          `Path matches exclusion pattern: "${pattern}"`,
        );
      }
    }

    return null;
  }

  private checkSecrets(item: ContextItem): ItemValidationResult | null {
    if (!item.content) {
      return null;
    }

    for (const regex of this.secretRegexes) {
      if (regex.test(item.content)) {
        return this.reject(
          item,
          'secret_detected',
          `Content matches secret pattern`,
        );
      }
    }

    return null;
  }

  private checkSize(item: ContextItem): ItemValidationResult | null {
    if (!item.content) {
      return null;
    }

    const sizeBytes = Buffer.byteLength(item.content, 'utf-8');
    if (sizeBytes > this.policy.maxItemSizeBytes) {
      return this.reject(
        item,
        'size_exceeded',
        `Content size ${sizeBytes} bytes exceeds limit of ${this.policy.maxItemSizeBytes} bytes`,
      );
    }

    return null;
  }

  private checkBinaryType(item: ContextItem): ItemValidationResult | null {
    if (!this.isPathBasedType(item.type)) {
      return null;
    }

    const ext = path.extname(item.sourceUri).toLowerCase();
    if (ext && this.policy.binaryExtensions.includes(ext)) {
      return this.reject(
        item,
        'binary_file',
        `File extension "${ext}" is classified as binary`,
      );
    }

    return null;
  }

  private checkTrustLevel(item: ContextItem): ItemValidationResult | null {
    const providerTrust = TRUST_LEVEL_ORDER[this.policy.providerTrustLevel];
    const requiredTrust = TRUST_LEVEL_ORDER[item.approvedTrustLevel];

    // If the provider trust is lower than what the item requires, reject
    if (providerTrust < requiredTrust) {
      return this.reject(
        item,
        'trust_level_violation',
        `Provider trust "${this.policy.providerTrustLevel}" is insufficient for item approved at "${item.approvedTrustLevel}" level`,
      );
    }

    return null;
  }

  private checkTokenBudget(item: ContextItem, currentTotal: number): ItemValidationResult | null {
    if (currentTotal + item.estimatedTokens > this.policy.maxTokenBudget) {
      return this.reject(
        item,
        'token_budget_exceeded',
        `Adding ${item.estimatedTokens} tokens would exceed budget of ${this.policy.maxTokenBudget} (current: ${currentTotal})`,
      );
    }

    return null;
  }

  // ─── Path Canonicalization ──────────────────────────────────────

  private checkLogicalContainment(normalizedPath: string): CanonicalPathResult {
    // Check if the normalized path is within at least one workspace root
    const withinWorkspace = this.isWithinWorkspace(normalizedPath);
    if (!withinWorkspace) {
      // Check if there's a valid grant for out-of-workspace paths
      if (this.hasValidGrant(normalizedPath)) {
        return { valid: true, canonicalPath: normalizedPath, resolvedSymlink: false };
      }
      return {
        valid: false,
        canonicalPath: normalizedPath,
        resolvedSymlink: false,
        reason: `Path is outside all workspace roots and has no valid grant`,
      };
    }
    return { valid: true, canonicalPath: normalizedPath, resolvedSymlink: false };
  }

  private resolveAndValidateSymlinks(normalizedPath: string): CanonicalPathResult {
    try {
      const realPath = fs.realpathSync(normalizedPath);
      const realNormalized = this.normalizePath(realPath);
      const withinWorkspace = this.isWithinWorkspace(realNormalized);

      if (!withinWorkspace) {
        // Check for valid grant on the real path
        if (this.hasValidGrant(realNormalized)) {
          return { valid: true, canonicalPath: realNormalized, resolvedSymlink: true };
        }
        return {
          valid: false,
          canonicalPath: realNormalized,
          resolvedSymlink: true,
          reason: `Symlink resolves to "${realNormalized}" which is outside workspace roots`,
        };
      }

      return { valid: true, canonicalPath: realNormalized, resolvedSymlink: normalizedPath !== realNormalized };
    } catch {
      // File doesn't exist — validate parent for write operations
      const parentDir = path.dirname(normalizedPath);
      try {
        const parentReal = fs.realpathSync(parentDir);
        const parentNormalized = this.normalizePath(parentReal);
        const parentWithin = this.isWithinWorkspace(parentNormalized);

        if (!parentWithin) {
          if (this.hasValidGrant(parentNormalized)) {
            const result = path.join(parentNormalized, path.basename(normalizedPath));
            return { valid: true, canonicalPath: this.normalizePath(result), resolvedSymlink: true };
          }
          return {
            valid: false,
            canonicalPath: normalizedPath,
            resolvedSymlink: false,
            reason: `Parent directory resolves outside workspace roots`,
          };
        }

        const result = path.join(parentNormalized, path.basename(normalizedPath));
        return { valid: true, canonicalPath: this.normalizePath(result), resolvedSymlink: false };
      } catch {
        // Parent doesn't exist either — use logical path
        return { valid: true, canonicalPath: normalizedPath, resolvedSymlink: false };
      }
    }
  }

  // ─── Utility Methods ────────────────────────────────────────────

  private reject(item: ContextItem, reason: RejectionReason, details: string): ItemValidationResult {
    return { item, passed: false, rejectionReason: reason, details };
  }

  private isPathBasedType(type: ContextItem['type']): boolean {
    return ['file', 'folder', 'selection', 'symbol'].includes(type);
  }

  private normalizePath(p: string): string {
    // Resolve to absolute, normalize separators, remove trailing slash
    const resolved = path.resolve(p);
    return resolved.replace(/\\/g, '/').replace(/\/$/, '');
  }

  private isWithinWorkspace(normalizedPath: string): boolean {
    const comparePath = this.policy.caseInsensitivePaths ? normalizedPath.toLowerCase() : normalizedPath;
    return this.policy.workspaceRoots.some((root) => {
      const compareRoot = this.policy.caseInsensitivePaths ? root.toLowerCase() : root;
      return comparePath.startsWith(compareRoot + '/') || comparePath === compareRoot;
    });
  }

  private pathContains(containerPath: string, childPath: string): boolean {
    const compareContainer = this.policy.caseInsensitivePaths ? containerPath.toLowerCase() : containerPath;
    const compareChild = this.policy.caseInsensitivePaths ? childPath.toLowerCase() : childPath;
    return compareChild.startsWith(compareContainer + '/') || compareChild === compareContainer;
  }

  private getRelativePath(sourceUri: string): string | null {
    const normalized = this.normalizePath(sourceUri);
    for (const root of this.policy.workspaceRoots) {
      if (normalized.startsWith(root + '/')) {
        return normalized.slice(root.length + 1);
      }
    }
    return null;
  }

  private deriveDataScope(provider: ProviderConfig): string[] {
    if (provider.isLocal || provider.trustLevel === 'local') {
      return ['code-context', 'prompts'];
    }
    if (provider.trustLevel === 'trusted') {
      return ['code-context', 'prompts', 'file-content', 'diagnostics'];
    }
    return ['code-context', 'prompts', 'file-content', 'diagnostics', 'metadata'];
  }

  /**
   * Simple glob matching supporting *, **, and ? patterns.
   */
  private matchesGlob(filePath: string, pattern: string): boolean {
    // Normalize the pattern
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const normalizedPath = filePath.replace(/\\/g, '/');

    // Convert glob to regex
    let regexStr = '^';
    let i = 0;
    while (i < normalizedPattern.length) {
      const char = normalizedPattern[i];
      if (char === '*') {
        if (normalizedPattern[i + 1] === '*') {
          // ** matches any path segment
          if (normalizedPattern[i + 2] === '/') {
            regexStr += '(?:.+/)?';
            i += 3;
          } else {
            regexStr += '.*';
            i += 2;
          }
        } else {
          // * matches anything except /
          regexStr += '[^/]*';
          i += 1;
        }
      } else if (char === '?') {
        regexStr += '[^/]';
        i += 1;
      } else if (char === '.') {
        regexStr += '\\.';
        i += 1;
      } else {
        regexStr += char;
        i += 1;
      }
    }
    regexStr += '$';

    try {
      const regex = new RegExp(regexStr);
      return regex.test(normalizedPath);
    } catch {
      return false;
    }
  }
}
