/**
 * ADR Connector
 *
 * Indexes Architecture Decision Records (ADRs) into the Knowledge Graph
 * as nodes with relationships to affected modules.
 *
 * Scans `docs/adr/` for ADR markdown files, parses their structured sections
 * (context, decision, consequences, status), and produces ConnectorNode entries
 * with edges linking ADRs to referenced modules.
 *
 * Requirements: 22.3
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Connector, ConnectorNode, ConnectorEdge } from './connector-interface';

// ─── Interfaces ─────────────────────────────────────────────────

export interface ADRConfig {
  /** Directory containing ADR files relative to project root (default: 'docs/adr') */
  adrDirectory?: string;
  /** File extensions to process (default: ['.md']) */
  extensions?: string[];
  /** Maximum file size in bytes to process (default: 512KB) */
  maxFileSize?: number;
}

export interface ParsedADR {
  /** ADR number extracted from filename or heading */
  number: string;
  /** ADR title */
  title: string;
  /** Current status (Proposed, Accepted, Deprecated, Superseded) */
  status: string;
  /** Context section content */
  context: string;
  /** Decision section content */
  decision: string;
  /** Consequences section content */
  consequences: string;
  /** File path relative to project root */
  filePath: string;
  /** Module references extracted from content */
  affectedModules: string[];
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * ADRConnector indexes Architecture Decision Records into the Knowledge Graph.
 * Each ADR becomes a node with edges linking to affected module nodes.
 */
export class ADRConnector implements Connector {
  readonly name = 'adr';

  private projectPath: string = '';
  private config: ADRConfig = {};
  private nodes: ConnectorNode[] = [];
  private initialized: boolean = false;

  private get adrDirectory(): string {
    return this.config.adrDirectory ?? 'docs/adr';
  }

  private get extensions(): string[] {
    return this.config.extensions ?? ['.md'];
  }

  private get maxFileSize(): number {
    return this.config.maxFileSize ?? 512 * 1024; // 512KB
  }

  /**
   * Initialize the connector with a project path and configuration.
   */
  async initialize(projectPath: string, config: Record<string, any>): Promise<void> {
    this.projectPath = projectPath;
    this.config = config as ADRConfig;
    this.nodes = [];
    this.initialized = true;
  }

  /**
   * Ingest ADR files from the project's ADR directory.
   * Parses each file into structured sections and produces nodes and edges.
   */
  async ingest(): Promise<{ nodes: ConnectorNode[]; edges: ConnectorEdge[] }> {
    if (!this.initialized) {
      throw new Error('ADRConnector must be initialized before ingestion');
    }

    this.nodes = [];
    const edges: ConnectorEdge[] = [];

    const adrDir = path.join(this.projectPath, this.adrDirectory);

    if (!fs.existsSync(adrDir)) {
      // No ADR directory — return empty results gracefully
      return { nodes: this.nodes, edges };
    }

    const adrFiles = this.findADRFiles(adrDir);

    for (const filePath of adrFiles) {
      try {
        const parsed = this.parseADRFile(filePath);
        if (!parsed) continue;

        // Create the main ADR node
        const adrNodeId = this.generateNodeId(parsed.filePath, parsed.title);
        this.nodes.push({
          id: adrNodeId,
          label: `ADR-${parsed.number}: ${parsed.title}`,
          type: 'section',
          content: this.buildNodeContent(parsed),
          metadata: {
            filePath: parsed.filePath,
            adrNumber: parsed.number,
            status: parsed.status,
            source_file: parsed.filePath,
          },
        });

        // Create edges to affected modules
        for (const modulePath of parsed.affectedModules) {
          const moduleNodeId = this.generateNodeId(modulePath, modulePath);
          edges.push({
            source: adrNodeId,
            target: moduleNodeId,
            relation: 'affects_module',
          });
        }
      } catch (error) {
        console.error(
          `[IndexingPipeline:ADRConnector] ParseError: Failed to parse ${filePath}`,
          { filePath, error: error instanceof Error ? error.message : String(error) }
        );
        continue;
      }
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
   * Parse a single ADR markdown file into structured sections.
   * Returns null if the file doesn't appear to be a valid ADR.
   */
  parseADRFile(filePath: string): ParsedADR | null {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.projectPath, filePath);

    // Extract ADR number from filename (e.g., 001-use-event-sourcing.md)
    const basename = path.basename(filePath, path.extname(filePath));
    const numberMatch = basename.match(/^(\d+)/);
    const number = numberMatch ? numberMatch[1] : '0';

    // Extract title from first H1 heading or filename
    const titleMatch = content.match(/^#\s+(?:ADR[-\s]*\d*:?\s*)?(.+)$/m);
    const title = titleMatch
      ? titleMatch[1].trim()
      : basename.replace(/^\d+-/, '').replace(/-/g, ' ');

    // Extract status
    const status = this.extractSection(content, 'Status') || 'Proposed';

    // Extract context
    const context = this.extractSection(content, 'Context') || '';

    // Extract decision
    const decision = this.extractSection(content, 'Decision') || '';

    // Extract consequences
    const consequences = this.extractSection(content, 'Consequences') || '';

    // Extract module references from content
    const affectedModules = this.extractModuleReferences(content);

    return {
      number,
      title,
      status: status.trim(),
      context,
      decision,
      consequences,
      filePath: relativePath,
      affectedModules,
    };
  }

  /**
   * Extract a named section from ADR markdown content.
   * Looks for a heading matching the section name and returns content until the next heading of same or higher level.
   */
  private extractSection(content: string, sectionName: string): string {
    const lines = content.split('\n');
    let capturing = false;
    let capturedLines: string[] = [];
    let sectionLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();

        if (!capturing && title.toLowerCase() === sectionName.toLowerCase()) {
          capturing = true;
          sectionLevel = level;
          continue;
        }

        if (capturing && level <= sectionLevel) {
          // Hit a same-level or higher heading, stop capturing
          break;
        }
      }

      if (capturing) {
        capturedLines.push(line);
      }
    }

    return capturedLines.join('\n').trim();
  }

  /**
   * Extract module/file references from ADR content.
   * Looks for patterns like `src/path/to/module.ts` or backtick-quoted paths.
   */
  private extractModuleReferences(content: string): string[] {
    const modules: Set<string> = new Set();

    // Match backtick-quoted file paths (e.g., `src/pipeline/agent-loop.ts`)
    const backtickPattern = /`(src\/[^`]+\.[a-z]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = backtickPattern.exec(content)) !== null) {
      modules.add(match[1]);
    }

    // Match bare file paths that start with src/
    const barePathPattern = /(?:^|\s)(src\/[\w\-./]+\.[a-z]+)/gm;
    while ((match = barePathPattern.exec(content)) !== null) {
      modules.add(match[1]);
    }

    return Array.from(modules);
  }

  /**
   * Build the full node content string from parsed ADR sections.
   */
  private buildNodeContent(parsed: ParsedADR): string {
    const parts: string[] = [
      `Status: ${parsed.status}`,
    ];
    if (parsed.context) parts.push(`Context: ${parsed.context}`);
    if (parsed.decision) parts.push(`Decision: ${parsed.decision}`);
    if (parsed.consequences) parts.push(`Consequences: ${parsed.consequences}`);
    return parts.join('\n\n');
  }

  /**
   * Find all ADR files in the given directory.
   */
  private findADRFiles(dirPath: string): string[] {
    const files: string[] = [];

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!this.extensions.includes(ext)) continue;

        // Skip index files
        if (entry.name.toLowerCase() === 'index.md') continue;

        const fullPath = path.join(dirPath, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size <= this.maxFileSize) {
            files.push(fullPath);
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      console.error(
        `[IndexingPipeline:ADRConnector] DirectoryError: Failed to read ${dirPath}`,
        { dirPath, error: error instanceof Error ? error.message : String(error) }
      );
    }

    return files;
  }

  /**
   * Generate a deterministic node ID from a file path and label.
   */
  private generateNodeId(filePath: string, label: string): string {
    const input = `adr:${filePath}:${label}`;
    return createHash('sha256').update(input).digest('hex').substring(0, 16);
  }
}
