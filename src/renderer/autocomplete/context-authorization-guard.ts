/**
 * ContextAuthorizationGuard — Filters Context_Items before sending to a provider.
 *
 * Only passes policy-authorized items and provides sufficient structural
 * prefix/suffix context for selection edits.
 *
 * Requirements: 4.7
 */

// ─── Types ──────────────────────────────────────────────────────

/** A context item that may be sent to a provider */
export interface ContextItem {
  /** Unique identifier for this context item */
  id: string;
  /** Type of context */
  type: 'file' | 'selection' | 'symbol' | 'diagnostic' | 'terminal' | 'git_diff' | 'artifact' | 'image';
  /** URI of the source */
  uri: string;
  /** The content text */
  content: string;
  /** Version of the content */
  version?: number;
  /** Whether the item is pinned (must include) */
  pinned?: boolean;
  /** Whether the user explicitly added this */
  explicit?: boolean;
  /** Workspace ID this belongs to */
  workspaceId?: string;
}

/** Policy configuration for authorization checks */
export interface AuthorizationPolicy {
  /** Workspace roots allowed for file access */
  allowedRoots: string[];
  /** Paths explicitly excluded (gitignore patterns or globs) */
  excludedPaths: string[];
  /** Secret patterns to detect and reject */
  secretPatterns: RegExp[];
  /** Maximum content size in bytes */
  maxContentSize: number;
  /** Whether binary content is allowed */
  allowBinary: boolean;
  /** Provider trust level */
  providerTrust: 'local' | 'trusted' | 'external';
  /** Scopes allowed for this provider */
  allowedScopes: string[];
}

/** Result of an authorization check */
export interface AuthorizationResult {
  /** Whether the item is authorized */
  authorized: boolean;
  /** Reason for denial (if unauthorized) */
  reason?: string;
  /** Category of denial */
  denialCategory?: 'path_violation' | 'secret_detected' | 'binary_content' | 'size_exceeded' | 'scope_violation' | 'excluded_path' | 'stale_version';
}

/** Structural context for inline edits */
export interface StructuralContext {
  /** Prefix text before the edit region */
  prefix: string;
  /** Suffix text after the edit region */
  suffix: string;
  /** Maximum prefix length in characters */
  maxPrefixLength: number;
  /** Maximum suffix length in characters */
  maxSuffixLength: number;
}

/** Filtered output ready for provider submission */
export interface AuthorizedPayload {
  /** Items that passed authorization */
  authorizedItems: ContextItem[];
  /** Items that were rejected with reasons */
  rejectedItems: Array<{ item: ContextItem; result: AuthorizationResult }>;
  /** Structural context for selection edits (if applicable) */
  structuralContext: StructuralContext | null;
  /** Total token estimate of authorized content */
  estimatedTokens: number;
}

// ─── ContextAuthorizationGuard ──────────────────────────────────

/**
 * ContextAuthorizationGuard filters Context_Items before they are sent
 * to a completion provider. Only policy-authorized items pass through.
 */
export class ContextAuthorizationGuard {
  private policy: AuthorizationPolicy;
  private structuralContextConfig: { maxPrefixLength: number; maxSuffixLength: number };

  constructor(
    policy: AuthorizationPolicy,
    structuralContextConfig?: { maxPrefixLength: number; maxSuffixLength: number },
  ) {
    this.policy = { ...policy };
    this.structuralContextConfig = structuralContextConfig ?? {
      maxPrefixLength: 2000,
      maxSuffixLength: 1000,
    };
  }

  // ─── Policy Management ────────────────────────────────────────

  /**
   * Update the authorization policy.
   */
  updatePolicy(policy: Partial<AuthorizationPolicy>): void {
    Object.assign(this.policy, policy);
  }

  /**
   * Get the current policy.
   */
  getPolicy(): Readonly<AuthorizationPolicy> {
    return { ...this.policy };
  }

  // ─── Authorization ────────────────────────────────────────────

  /**
   * Check if a single context item is authorized.
   */
  checkAuthorization(item: ContextItem): AuthorizationResult {
    // Check path policy (must be within allowed roots)
    if (item.uri) {
      if (!this.isWithinAllowedRoots(item.uri)) {
        return {
          authorized: false,
          reason: `Path "${item.uri}" is outside allowed workspace roots`,
          denialCategory: 'path_violation',
        };
      }

      if (this.isExcludedPath(item.uri)) {
        return {
          authorized: false,
          reason: `Path "${item.uri}" is in the exclusion list`,
          denialCategory: 'excluded_path',
        };
      }
    }

    // Check for secrets
    if (item.content && this.containsSecrets(item.content)) {
      return {
        authorized: false,
        reason: 'Content contains detected secrets or credentials',
        denialCategory: 'secret_detected',
      };
    }

    // Check binary content
    if (!this.policy.allowBinary && this.isBinaryContent(item.content)) {
      return {
        authorized: false,
        reason: 'Binary content is not allowed by policy',
        denialCategory: 'binary_content',
      };
    }

    // Check size limit
    if (item.content && this.getByteLength(item.content) > this.policy.maxContentSize) {
      return {
        authorized: false,
        reason: `Content size exceeds maximum of ${this.policy.maxContentSize} bytes`,
        denialCategory: 'size_exceeded',
      };
    }

    // Check scope
    if (item.workspaceId && this.policy.allowedScopes.length > 0) {
      if (!this.policy.allowedScopes.includes(item.workspaceId)) {
        return {
          authorized: false,
          reason: `Workspace "${item.workspaceId}" is not in allowed scopes`,
          denialCategory: 'scope_violation',
        };
      }
    }

    return { authorized: true };
  }

  /**
   * Filter a list of context items, returning only authorized ones.
   */
  filterItems(
    items: ContextItem[],
    structuralPrefix?: string,
    structuralSuffix?: string,
  ): AuthorizedPayload {
    const authorizedItems: ContextItem[] = [];
    const rejectedItems: Array<{ item: ContextItem; result: AuthorizationResult }> = [];

    for (const item of items) {
      const result = this.checkAuthorization(item);
      if (result.authorized) {
        authorizedItems.push(item);
      } else {
        rejectedItems.push({ item, result });
      }
    }

    // Build structural context if prefix/suffix provided
    let structuralContext: StructuralContext | null = null;
    if (structuralPrefix !== undefined || structuralSuffix !== undefined) {
      structuralContext = this.buildStructuralContext(
        structuralPrefix ?? '',
        structuralSuffix ?? '',
      );
    }

    // Estimate tokens (rough: ~4 chars per token)
    const totalContent = authorizedItems.reduce((acc, item) => acc + (item.content?.length ?? 0), 0);
    const structuralTokens = structuralContext
      ? (structuralContext.prefix.length + structuralContext.suffix.length) / 4
      : 0;
    const estimatedTokens = Math.ceil(totalContent / 4 + structuralTokens);

    return {
      authorizedItems,
      rejectedItems,
      structuralContext,
      estimatedTokens,
    };
  }

  /**
   * Build bounded structural prefix/suffix for selection edits.
   */
  buildStructuralContext(prefix: string, suffix: string): StructuralContext {
    const maxPrefixLength = this.structuralContextConfig.maxPrefixLength;
    const maxSuffixLength = this.structuralContextConfig.maxSuffixLength;

    // Trim to configured bounds
    const trimmedPrefix = prefix.length > maxPrefixLength
      ? prefix.slice(-maxPrefixLength)
      : prefix;

    const trimmedSuffix = suffix.length > maxSuffixLength
      ? suffix.slice(0, maxSuffixLength)
      : suffix;

    return {
      prefix: trimmedPrefix,
      suffix: trimmedSuffix,
      maxPrefixLength,
      maxSuffixLength,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────

  private isWithinAllowedRoots(uri: string): boolean {
    if (this.policy.allowedRoots.length === 0) return true;

    const normalizedUri = this.normalizePath(uri);
    return this.policy.allowedRoots.some(root => {
      const normalizedRoot = this.normalizePath(root);
      return normalizedUri.startsWith(normalizedRoot);
    });
  }

  private isExcludedPath(uri: string): boolean {
    const normalizedUri = this.normalizePath(uri);
    return this.policy.excludedPaths.some(pattern => {
      // Simple glob matching: check if the path contains the pattern or matches
      const normalizedPattern = this.normalizePath(pattern);
      if (normalizedPattern.includes('*')) {
        // Convert simple glob to regex
        const regex = new RegExp(
          '^' + normalizedPattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
        );
        return regex.test(normalizedUri);
      }
      return normalizedUri.includes(normalizedPattern);
    });
  }

  private containsSecrets(content: string): boolean {
    return this.policy.secretPatterns.some(pattern => pattern.test(content));
  }

  private isBinaryContent(content: string): boolean {
    if (!content) return false;
    // Check for null bytes or high ratio of non-printable chars
    const nonPrintable = content.split('').filter(c => {
      const code = c.charCodeAt(0);
      return code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
    });
    return nonPrintable.length / content.length > 0.1;
  }

  private getByteLength(content: string): number {
    return new TextEncoder().encode(content).length;
  }

  private normalizePath(path: string): string {
    // Remove file:// prefix if present, normalize slashes
    return path
      .replace(/^file:\/\//, '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .toLowerCase();
  }
}
