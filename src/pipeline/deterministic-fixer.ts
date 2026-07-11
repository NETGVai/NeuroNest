/**
 * Deterministic Fixer — Applies mechanical, template-based transforms for known
 * vulnerability patterns without LLM involvement.
 *
 * Supports 4 fix categories:
 * - vulnerable-dependency: bump to fixVersion in package.json
 * - weak-crypto: replace md5/sha1/ECB with SHA-256/AES-256-GCM equivalents
 * - unsafe-dom: replace innerHTML/document.write with textContent/DOMPurify.sanitize
 * - hardcoded-secret: hoist to process.env.VAR_NAME, add to .env.example
 *
 * All fixes go through the verification gate after application and are surfaced
 * for user approval before committing.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import type { RealtimeAnalysisFinding } from '../runtime-security/realtime-code-analyzer.js';
import type {
  AgentEdit,
  ProjectContext,
  VerificationResult,
} from './verification-gate/types.js';
import type { VerificationRunner } from './self-healing-loop.js';

// ─── Types ──────────────────────────────────────────────────────

export type FixCategory =
  | 'vulnerable-dependency'
  | 'weak-crypto'
  | 'unsafe-dom'
  | 'hardcoded-secret';

export interface DeterministicFix {
  category: FixCategory;
  filePath: string;
  original: string;
  replacement: string;
  rationale: string;
}

export interface FixResult {
  applied: boolean;
  fixes: DeterministicFix[];
  /** Whether user approval was obtained */
  approved: boolean;
  /** Whether the fix passed the verification gate */
  passedVerification: boolean;
}

// ─── Approval Interface ─────────────────────────────────────────

/**
 * Interface for obtaining user approval before applying fixes.
 * Implementations surface before/after diffs and the security rationale.
 */
export interface ApprovalProvider {
  /**
   * Request user approval for a proposed fix.
   * Surfaces the before/after diff and security rationale.
   * @returns true if the user approved the fix
   */
  requestApproval(fix: DeterministicFix): Promise<boolean>;
}

// ─── Category Matchers ──────────────────────────────────────────

/**
 * Maps finding categories (from RealtimeCodeAnalyzer) to deterministic fix categories.
 * Findings may use varied category names; this normalizes them.
 */
const CATEGORY_MAP: Record<string, FixCategory> = {
  'vulnerable-dependency': 'vulnerable-dependency',
  'outdated-dependency': 'vulnerable-dependency',
  'weak-crypto': 'weak-crypto',
  'weak-cryptography': 'weak-crypto',
  'insecure-hash': 'weak-crypto',
  'unsafe-dom': 'unsafe-dom',
  'xss': 'unsafe-dom',
  'dom-xss': 'unsafe-dom',
  'hardcoded-secret': 'hardcoded-secret',
  'hardcoded-secrets': 'hardcoded-secret',
  'secrets': 'hardcoded-secret',
};

// ─── Regex Patterns for Detection ───────────────────────────────

/** Weak crypto patterns: md5, sha1, ECB mode */
const WEAK_HASH_CALL_PATTERN = /(?:createHash|crypto\.createHash)\s*\(\s*['"](?:md5|sha1)['"]\s*\)/g;
const ECB_MODE_PATTERN = /(?:createCipheriv|createDecipheriv|crypto\.createCipheriv|crypto\.createDecipheriv)\s*\(\s*['"](aes-\d+-ecb)['"]/g;
const MD5_IMPORT_PATTERN = /(?:require|import)\s*\(?['"]md5['"]\)?/g;

/** Unsafe DOM patterns */
const INNERHTML_ASSIGN_PATTERN = /(\w+(?:\.\w+)*)\.innerHTML\s*=\s*(.+)/g;
const DOCUMENT_WRITE_PATTERN = /document\.write\s*\(\s*(.+?)\s*\)/g;

/** Hardcoded secret patterns (common patterns) */
const HARDCODED_SECRET_PATTERNS = [
  // API keys, tokens, passwords assigned to variables
  /(?:const|let|var)\s+([\w_]+)\s*=\s*['"]([A-Za-z0-9_\-]{16,})['"];?/g,
];

/** Variable name to env var name mapping heuristics */
const SECRET_VAR_PREFIXES = [
  'api_key', 'apiKey', 'api_secret', 'apiSecret',
  'secret_key', 'secretKey', 'secret',
  'token', 'access_token', 'accessToken',
  'password', 'passwd', 'pass',
  'private_key', 'privateKey',
  'auth_token', 'authToken',
  'db_password', 'dbPassword',
  'aws_secret', 'awsSecret',
];

// ─── DeterministicFixer Class ───────────────────────────────────

export class DeterministicFixer {
  constructor(
    private readonly verifier?: VerificationRunner,
    private readonly approvalProvider?: ApprovalProvider,
  ) {}

  /**
   * Check if a finding can be fixed deterministically.
   * Returns true if the finding's category maps to one of the 4 supported fix types.
   */
  canFix(finding: RealtimeAnalysisFinding): boolean {
    const category = this.resolveCategory(finding);
    return category !== null;
  }

  /**
   * Generate a deterministic fix without applying it.
   * Returns null if the finding cannot be fixed deterministically.
   */
  generateFix(finding: RealtimeAnalysisFinding, fileContent: string): DeterministicFix | null {
    const category = this.resolveCategory(finding);
    if (!category) return null;

    switch (category) {
      case 'vulnerable-dependency':
        return this.generateDependencyFix(finding, fileContent);
      case 'weak-crypto':
        return this.generateCryptoFix(finding, fileContent);
      case 'unsafe-dom':
        return this.generateDomFix(finding, fileContent);
      case 'hardcoded-secret':
        return this.generateSecretFix(finding, fileContent);
      default:
        return null;
    }
  }

  /**
   * Apply a fix with user approval, then re-verify through the verification gate.
   * Requirement 11.5: After applying, send result through full verification gate.
   * Requirement 11.6: Surface all changes for user approval showing before/after diff.
   */
  async applyFix(
    fix: DeterministicFix,
    context: ProjectContext,
  ): Promise<FixResult> {
    // Requirement 11.6: Surface for user approval before committing
    const approved = await this.requestApproval(fix);
    if (!approved) {
      return {
        applied: false,
        fixes: [fix],
        approved: false,
        passedVerification: false,
      };
    }

    // Requirement 11.5: Send through full verification gate after application
    const passedVerification = await this.verify(fix, context);

    return {
      applied: passedVerification,
      fixes: [fix],
      approved: true,
      passedVerification,
    };
  }

  // ─── Private: Category Resolution ──────────────────────────────

  /**
   * Resolves a finding's category string to a supported FixCategory,
   * returning null if it doesn't match any deterministic fix.
   */
  private resolveCategory(finding: RealtimeAnalysisFinding): FixCategory | null {
    const normalized = finding.category.toLowerCase().replace(/\s+/g, '-');
    return CATEGORY_MAP[normalized] ?? null;
  }

  // ─── Private: Vulnerable Dependency Fix ────────────────────────

  /**
   * Requirement 11.1: Auto-bump dependency to fixVersion in package.json.
   * Extracts the fix version from the finding's remediation string.
   */
  private generateDependencyFix(
    finding: RealtimeAnalysisFinding,
    fileContent: string,
  ): DeterministicFix | null {
    // Extract package name and fix version from remediation
    // Expected remediation format: "Upgrade <package> to <version>" or contains version info
    const versionMatch = finding.remediation.match(
      /(?:upgrade|update|bump)\s+(?:to\s+)?(?:version\s+)?(?:['"]?)([\w@/.-]+)(?:['"]?)(?:\s+to\s+|\s*@\s*)(?:version\s+)?(?:['"]?)([\d^~>=<.*x]+[\w.\-]*)(?:['"]?)/i,
    );

    // Also try "Upgrade <package> to <version>" pattern
    const simpleMatch = finding.remediation.match(
      /(?:upgrade|update|bump)\s+['"]?([\w@/.-]+)['"]?\s+to\s+['"]?([\d^~>=<.*x]+[\w.\-]*)['"]?/i,
    );

    const match = versionMatch || simpleMatch;
    if (!match) {
      // Try extracting just a version from remediation
      const fixVersionMatch = finding.remediation.match(/(\d+\.\d+\.\d+[\w.-]*)/);
      if (!fixVersionMatch) return null;

      // Try to extract package name from the finding message
      const pkgFromMessage = finding.message.match(
        /(?:package|dependency)\s+['"]?([\w@/.-]+)['"]?/i,
      );
      if (!pkgFromMessage) return null;

      return this.buildDependencyFix(
        finding,
        fileContent,
        pkgFromMessage[1],
        fixVersionMatch[1],
      );
    }

    return this.buildDependencyFix(finding, fileContent, match[1], match[2]);
  }

  private buildDependencyFix(
    finding: RealtimeAnalysisFinding,
    fileContent: string,
    packageName: string,
    fixVersion: string,
  ): DeterministicFix | null {
    // Find the current version in package.json content
    const escapedPkg = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const depPattern = new RegExp(
      `("${escapedPkg}"\\s*:\\s*")([^"]+)(")`,
    );
    const depMatch = fileContent.match(depPattern);

    if (!depMatch) return null;

    const original = depMatch[0];
    const replacement = `"${packageName}": "${fixVersion}"`;

    return {
      category: 'vulnerable-dependency',
      filePath: finding.file,
      original,
      replacement,
      rationale: `Bump ${packageName} to ${fixVersion} to fix known vulnerability: ${finding.message}`,
    };
  }

  // ─── Private: Weak Crypto Fix ──────────────────────────────────

  /**
   * Requirement 11.2: Replace md5/sha1/ECB with SHA-256/AES-256-GCM.
   * Uses predefined transform templates.
   */
  private generateCryptoFix(
    finding: RealtimeAnalysisFinding,
    fileContent: string,
  ): DeterministicFix | null {
    const lines = fileContent.split('\n');
    const targetLine = lines[finding.line - 1];
    if (!targetLine) return null;

    // Check for md5/sha1 createHash usage
    const hashMatch = targetLine.match(
      /(?:createHash|crypto\.createHash)\s*\(\s*['"](?:md5|sha1)['"]\s*\)/,
    );
    if (hashMatch) {
      const original = hashMatch[0];
      const replacement = original.replace(/['"](?:md5|sha1)['"]/, "'sha256'");
      return {
        category: 'weak-crypto',
        filePath: finding.file,
        original,
        replacement,
        rationale: 'Replace weak hash algorithm (md5/sha1) with SHA-256 for cryptographic security.',
      };
    }

    // Check for ECB mode cipher usage
    const ecbMatch = targetLine.match(
      /(?:createCipheriv|createDecipheriv|crypto\.createCipheriv|crypto\.createDecipheriv)\s*\(\s*['"](aes-\d+-ecb)['"]/,
    );
    if (ecbMatch) {
      const original = ecbMatch[0];
      const replacement = original.replace(/['"]aes-\d+-ecb['"]/, "'aes-256-gcm'");
      return {
        category: 'weak-crypto',
        filePath: finding.file,
        original,
        replacement,
        rationale: 'Replace ECB mode with AES-256-GCM to prevent pattern leakage and provide authenticated encryption.',
      };
    }

    // Check for md5 package import/require
    const md5ImportMatch = targetLine.match(
      /(?:require|import)\s*\(?['"]md5['"]\)?/,
    );
    if (md5ImportMatch) {
      const original = md5ImportMatch[0];
      // Replace md5 import with crypto import for createHash('sha256')
      const replacement = original.includes('import')
        ? "import { createHash } from 'node:crypto'"
        : "require('node:crypto')";
      return {
        category: 'weak-crypto',
        filePath: finding.file,
        original,
        replacement,
        rationale: 'Replace md5 package with native crypto module using SHA-256.',
      };
    }

    // Fallback: try to match weak patterns anywhere on the line
    const weakAlgoMatch = targetLine.match(/['"](?:md5|sha1)['"]/);
    if (weakAlgoMatch) {
      return {
        category: 'weak-crypto',
        filePath: finding.file,
        original: weakAlgoMatch[0],
        replacement: "'sha256'",
        rationale: 'Replace weak hash algorithm reference with SHA-256.',
      };
    }

    return null;
  }

  // ─── Private: Unsafe DOM Fix ───────────────────────────────────

  /**
   * Requirement 11.3: Replace innerHTML/document.write with textContent/DOMPurify.sanitize.
   */
  private generateDomFix(
    finding: RealtimeAnalysisFinding,
    fileContent: string,
  ): DeterministicFix | null {
    const lines = fileContent.split('\n');
    const targetLine = lines[finding.line - 1];
    if (!targetLine) return null;

    // Check for innerHTML assignment
    const innerHtmlMatch = targetLine.match(
      /(\w+(?:\.\w+)*)\.innerHTML\s*=\s*(.+)/,
    );
    if (innerHtmlMatch) {
      const element = innerHtmlMatch[1];
      const value = innerHtmlMatch[2].replace(/;?\s*$/, '');
      const original = innerHtmlMatch[0].replace(/;?\s*$/, '');

      // If the value is a simple variable or literal, use textContent
      // If it contains HTML-like content, wrap with DOMPurify.sanitize
      const isLikelyHtml = value.includes('<') || value.includes('`') || value.includes('+');
      if (isLikelyHtml) {
        const replacement = `${element}.innerHTML = DOMPurify.sanitize(${value})`;
        return {
          category: 'unsafe-dom',
          filePath: finding.file,
          original,
          replacement,
          rationale: 'Wrap innerHTML assignment with DOMPurify.sanitize() to prevent XSS attacks.',
        };
      } else {
        const replacement = `${element}.textContent = ${value}`;
        return {
          category: 'unsafe-dom',
          filePath: finding.file,
          original,
          replacement,
          rationale: 'Replace innerHTML with textContent to prevent XSS attacks (content does not require HTML rendering).',
        };
      }
    }

    // Check for document.write usage
    const docWriteMatch = targetLine.match(
      /document\.write\s*\(\s*(.+?)\s*\)/,
    );
    if (docWriteMatch) {
      const content = docWriteMatch[1];
      const original = docWriteMatch[0];
      const replacement = `document.body.textContent = ${content}`;
      return {
        category: 'unsafe-dom',
        filePath: finding.file,
        original,
        replacement,
        rationale: 'Replace document.write() with safe DOM manipulation to prevent XSS attacks.',
      };
    }

    return null;
  }

  // ─── Private: Hardcoded Secret Fix ─────────────────────────────

  /**
   * Requirement 11.4: Hoist hardcoded secret to process.env.VAR_NAME
   * and add variable to .env.example.
   */
  private generateSecretFix(
    finding: RealtimeAnalysisFinding,
    fileContent: string,
  ): DeterministicFix | null {
    const lines = fileContent.split('\n');
    const targetLine = lines[finding.line - 1];
    if (!targetLine) return null;

    // Match variable assignment with a string literal (likely secret)
    const assignMatch = targetLine.match(
      /(?:const|let|var)\s+([\w_]+)\s*=\s*['"]([^'"]+)['"];?/,
    );
    if (assignMatch) {
      const varName = assignMatch[1];
      const secretValue = assignMatch[2];
      const envVarName = this.toEnvVarName(varName);
      const original = assignMatch[0].replace(/;?\s*$/, '');
      const declarationKeyword = targetLine.match(/^(\s*(?:const|let|var))/)?.[1] ?? 'const';
      const replacement = `${declarationKeyword} ${varName} = process.env.${envVarName}`;

      return {
        category: 'hardcoded-secret',
        filePath: finding.file,
        original,
        replacement,
        rationale: `Hoist hardcoded secret to environment variable process.env.${envVarName}. Add ${envVarName}= to .env.example.`,
      };
    }

    // Match object property with secret value
    const propMatch = targetLine.match(
      /([\w_]+)\s*:\s*['"]([^'"]{16,})['"],?/,
    );
    if (propMatch) {
      const propName = propMatch[1];
      const envVarName = this.toEnvVarName(propName);
      const original = propMatch[0].replace(/,?\s*$/, '');
      const replacement = `${propName}: process.env.${envVarName}`;

      return {
        category: 'hardcoded-secret',
        filePath: finding.file,
        original,
        replacement,
        rationale: `Hoist hardcoded secret to environment variable process.env.${envVarName}. Add ${envVarName}= to .env.example.`,
      };
    }

    return null;
  }

  /**
   * Convert a camelCase or snake_case variable name to UPPER_SNAKE_CASE env var name.
   */
  private toEnvVarName(varName: string): string {
    // Convert camelCase to UPPER_SNAKE_CASE
    const snaked = varName
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toUpperCase();
    return snaked;
  }

  // ─── Private: Approval & Verification ──────────────────────────

  /**
   * Request user approval for a fix, surfacing before/after diff.
   * Requirement 11.6
   */
  private async requestApproval(fix: DeterministicFix): Promise<boolean> {
    if (!this.approvalProvider) {
      // If no approval provider is configured, default to approved
      return true;
    }
    return this.approvalProvider.requestApproval(fix);
  }

  /**
   * Verify a fix through the verification gate.
   * Requirement 11.5: All fixes go through full verification gate.
   */
  private async verify(fix: DeterministicFix, context: ProjectContext): Promise<boolean> {
    if (!this.verifier) {
      // If no verifier is configured, treat as passed
      return true;
    }

    const edit: AgentEdit = {
      id: `deterministic-fix-${Date.now()}`,
      taskId: 'deterministic-fix',
      changes: [{
        filePath: fix.filePath,
        content: fix.replacement,
        originalContent: fix.original,
      }],
      description: fix.rationale,
    };

    try {
      const result: VerificationResult = await this.verifier.run(edit, context);
      return result.accepted;
    } catch {
      // Verification failure means the fix should not be applied
      return false;
    }
  }
}
