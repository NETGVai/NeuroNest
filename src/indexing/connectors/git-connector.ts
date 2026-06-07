/**
 * Git Connector
 *
 * Ingests commit messages, author information, and file-level diffs from
 * the local Git repository into the Knowledge Graph.
 *
 * Uses child_process to run `git log` commands. Parses commit messages,
 * authors, and file-level diffs. Limits to most recent 1000 commits
 * (configurable). Handles missing `.git` directory gracefully.
 *
 * Requirements: 6.1, 6.5, 6.6
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Connector, ConnectorNode, ConnectorEdge } from './connector-interface';

// ─── Interfaces ─────────────────────────────────────────────────

interface GitConnectorConfig {
  /** Maximum number of commits to ingest (default: 1000) */
  gitCommitLimit?: number;
}

interface ParsedCommit {
  hash: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
  files: string[];
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * GitConnector ingests commit messages, author information, and file-level
 * diffs from the local Git repository. Produces ConnectorNode entries of
 * type 'commit' and 'author' for inclusion in the Knowledge Graph.
 */
export class GitConnector implements Connector {
  readonly name = 'git';

  private projectPath: string = '';
  private config: GitConnectorConfig = {};
  private nodes: ConnectorNode[] = [];
  private initialized: boolean = false;

  private get gitCommitLimit(): number {
    return this.config.gitCommitLimit ?? 1000;
  }

  /**
   * Initialize the connector with a project path and configuration.
   */
  async initialize(projectPath: string, config: Record<string, any>): Promise<void> {
    this.projectPath = projectPath;
    this.config = config as GitConnectorConfig;
    this.nodes = [];
    this.initialized = true;
  }

  /**
   * Ingest Git history from the project directory.
   * Parses commit messages, authors, and file-level diffs.
   * Returns empty results if no .git directory is found.
   */
  async ingest(): Promise<{ nodes: ConnectorNode[]; edges: ConnectorEdge[] }> {
    if (!this.initialized) {
      throw new Error('GitConnector must be initialized before ingestion');
    }

    this.nodes = [];
    const edges: ConnectorEdge[] = [];

    // Check for .git directory
    if (!this.hasGitDirectory()) {
      console.warn(
        `[IndexingPipeline:GitConnector] Warning: No .git directory found at ${this.projectPath}. Skipping Git ingestion.`
      );
      return { nodes: this.nodes, edges };
    }

    try {
      const commits = this.getCommitLog();
      const authorMap = new Map<string, ConnectorNode>();

      for (const commit of commits) {
        // Create commit node
        const commitNode = this.createCommitNode(commit);
        this.nodes.push(commitNode);

        // Create or reuse author node
        const authorKey = commit.authorEmail || commit.author;
        if (!authorMap.has(authorKey)) {
          const authorNode = this.createAuthorNode(commit.author, commit.authorEmail);
          authorMap.set(authorKey, authorNode);
          this.nodes.push(authorNode);
        }

        // Create edge: author -> commit
        const authorNode = authorMap.get(authorKey)!;
        edges.push({
          source: authorNode.id,
          target: commitNode.id,
          relation: 'authored',
        });

        // Create edges: commit -> files modified
        for (const filePath of commit.files) {
          const fileNodeId = this.generateNodeId(`file:${filePath}`);
          edges.push({
            source: commitNode.id,
            target: fileNodeId,
            relation: 'modified',
          });
        }
      }
    } catch (error) {
      // Requirement 6.5: Log error and continue without blocking the pipeline
      console.error(
        `[IndexingPipeline:GitConnector] IngestionError: Failed to ingest Git history`,
        { projectPath: this.projectPath, error: error instanceof Error ? error.message : String(error) }
      );
    }

    return { nodes: this.nodes, edges };
  }

  /**
   * Return all nodes currently held by this connector.
   */
  getNodes(): ConnectorNode[] {
    return this.nodes;
  }

  /**
   * Check if the project has a .git directory.
   */
  private hasGitDirectory(): boolean {
    try {
      const gitPath = path.join(this.projectPath, '.git');
      return fs.existsSync(gitPath);
    } catch {
      return false;
    }
  }

  /**
   * Run git log and parse the output into structured commit data.
   * Uses a custom format separator to reliably parse multi-line messages.
   */
  private getCommitLog(): ParsedCommit[] {
    const separator = '---COMMIT_SEPARATOR---';
    const fieldSeparator = '---FIELD_SEPARATOR---';

    // Format: hash, author name, author email, date, subject
    const format = `${separator}%H${fieldSeparator}%an${fieldSeparator}%ae${fieldSeparator}%aI${fieldSeparator}%s`;

    try {
      const logOutput = execSync(
        `git log --pretty=format:"${format}" --name-only -n ${this.gitCommitLimit}`,
        {
          cwd: this.projectPath,
          encoding: 'utf-8',
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large repos
          timeout: 30000, // 30 second timeout
        }
      );

      return this.parseGitLogOutput(logOutput, separator, fieldSeparator);
    } catch (error) {
      // Handle git command failures gracefully
      console.error(
        `[IndexingPipeline:GitConnector] GitLogError: Failed to run git log`,
        { projectPath: this.projectPath, error: error instanceof Error ? error.message : String(error) }
      );
      return [];
    }
  }

  /**
   * Parse the raw git log output into structured commit objects.
   */
  private parseGitLogOutput(
    output: string,
    separator: string,
    fieldSeparator: string
  ): ParsedCommit[] {
    const commits: ParsedCommit[] = [];

    // Split by commit separator (skip the first empty entry)
    const rawCommits = output.split(separator).filter((s) => s.trim().length > 0);

    for (const rawCommit of rawCommits) {
      try {
        const commit = this.parseSingleCommit(rawCommit, fieldSeparator);
        if (commit) {
          commits.push(commit);
        }
      } catch {
        // Skip malformed commit entries
        continue;
      }
    }

    return commits;
  }

  /**
   * Parse a single commit block from git log output.
   */
  private parseSingleCommit(raw: string, fieldSeparator: string): ParsedCommit | null {
    const lines = raw.split('\n');
    if (lines.length === 0) return null;

    // First line contains the formatted commit info
    const headerLine = lines[0];
    const fields = headerLine.split(fieldSeparator);

    if (fields.length < 5) return null;

    const hash = fields[0].trim();
    const author = fields[1].trim();
    const authorEmail = fields[2].trim();
    const date = fields[3].trim();
    const message = fields[4].trim();

    if (!hash || hash.length < 7) return null;

    // Remaining non-empty lines are file paths (from --name-only)
    const files = lines
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return { hash, author, authorEmail, date, message, files };
  }

  /**
   * Create a ConnectorNode for a commit.
   */
  private createCommitNode(commit: ParsedCommit): ConnectorNode {
    return {
      id: this.generateNodeId(`commit:${commit.hash}`),
      label: this.truncateMessage(commit.message, 80),
      type: 'commit',
      content: commit.message,
      metadata: {
        hash: commit.hash,
        author: commit.author,
        authorEmail: commit.authorEmail,
        date: commit.date,
        filesChanged: String(commit.files.length),
        files: commit.files.slice(0, 20).join(','), // Limit stored file list
      },
    };
  }

  /**
   * Create a ConnectorNode for an author.
   */
  private createAuthorNode(name: string, email: string): ConnectorNode {
    return {
      id: this.generateNodeId(`author:${email || name}`),
      label: name,
      type: 'author',
      content: `${name} <${email}>`,
      metadata: {
        name,
        email,
      },
    };
  }

  /**
   * Generate a deterministic node ID from an input string.
   */
  private generateNodeId(input: string): string {
    return createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  /**
   * Truncate a message to a maximum length, appending ellipsis if needed.
   */
  private truncateMessage(message: string, maxLength: number): string {
    if (message.length <= maxLength) return message;
    return message.substring(0, maxLength - 3) + '...';
  }
}
