/**
 * Documentation Connector
 *
 * Parses Markdown files into semantic sections by heading boundaries (h1, h2)
 * and produces ConnectorNode entries for inclusion in the Knowledge Graph.
 *
 * Handles parse errors gracefully by skipping problematic files and continuing
 * with the rest.
 *
 * Requirements: 6.2, 6.5
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Connector, ConnectorNode, ConnectorEdge } from './connector-interface';

// ─── Interfaces ─────────────────────────────────────────────────

interface DocumentationConfig {
  /** File extensions to process (default: ['.md']) */
  extensions?: string[];
  /** Directories to exclude from scanning */
  excludeDirs?: string[];
  /** Maximum file size in bytes to process (default: 1MB) */
  maxFileSize?: number;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * DocumentationConnector parses Markdown files into semantic sections
 * by heading boundaries (h1, h2) and produces ConnectorNode entries
 * of type 'section' or 'heading'.
 */
export class DocumentationConnector implements Connector {
  readonly name = 'documentation';

  private projectPath: string = '';
  private config: DocumentationConfig = {};
  private nodes: ConnectorNode[] = [];
  private initialized: boolean = false;

  private get extensions(): string[] {
    return this.config.extensions ?? ['.md'];
  }

  private get excludeDirs(): string[] {
    return this.config.excludeDirs ?? ['node_modules', '.git', 'dist', 'build', '.kiro'];
  }

  private get maxFileSize(): number {
    return this.config.maxFileSize ?? 1024 * 1024; // 1MB
  }

  /**
   * Initialize the connector with a project path and configuration.
   */
  async initialize(projectPath: string, config: Record<string, any>): Promise<void> {
    this.projectPath = projectPath;
    this.config = config as DocumentationConfig;
    this.nodes = [];
    this.initialized = true;
  }

  /**
   * Ingest Markdown files from the project directory.
   * Parses each file into semantic sections by heading boundaries.
   * Skips files that fail to parse and continues with others.
   */
  async ingest(): Promise<{ nodes: ConnectorNode[]; edges: ConnectorEdge[] }> {
    if (!this.initialized) {
      throw new Error('DocumentationConnector must be initialized before ingestion');
    }

    this.nodes = [];
    const edges: ConnectorEdge[] = [];

    const markdownFiles = this.findMarkdownFiles(this.projectPath);

    for (const filePath of markdownFiles) {
      try {
        const fileNodes = this.parseMarkdownFile(filePath);
        this.nodes.push(...fileNodes);

        // Create edges linking sections to their parent heading
        for (let i = 1; i < fileNodes.length; i++) {
          const node = fileNodes[i];
          if (node.type === 'section') {
            // Find the most recent heading before this section
            for (let j = i - 1; j >= 0; j--) {
              if (fileNodes[j].type === 'heading') {
                edges.push({
                  source: fileNodes[j].id,
                  target: node.id,
                  relation: 'contains_section',
                });
                break;
              }
            }
          }
        }
      } catch (error) {
        // Requirement 6.5: Log error and continue with other files
        console.error(
          `[IndexingPipeline:DocumentationConnector] ParseError: Failed to parse ${filePath}`,
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
   * Parse a single Markdown file into ConnectorNode entries.
   * Splits content by h1/h2 heading boundaries.
   */
  private parseMarkdownFile(filePath: string): ConnectorNode[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.projectPath, filePath);
    const nodes: ConnectorNode[] = [];

    const sections = this.splitByHeadings(content);

    for (const section of sections) {
      if (section.isHeading) {
        const nodeId = this.generateNodeId(relativePath, section.heading, section.startLine);
        nodes.push({
          id: nodeId,
          label: section.heading,
          type: 'heading',
          content: section.heading,
          metadata: {
            filePath: relativePath,
            level: String(section.level),
            startLine: String(section.startLine),
          },
        });
      } else {
        // Body section node
        const sectionId = this.generateNodeId(relativePath, section.heading + ':body', section.startLine);
        nodes.push({
          id: sectionId,
          label: section.heading || `Section at line ${section.startLine}`,
          type: 'section',
          content: section.body.trim(),
          metadata: {
            filePath: relativePath,
            heading: section.heading,
            level: String(section.level),
            startLine: String(section.startLine),
            endLine: String(section.endLine),
          },
        });
      }
    }

    return nodes;
  }

  /**
   * Split Markdown content into sections by h1/h2 heading boundaries.
   * Each heading produces a heading entry, and the body text below it
   * produces a separate section entry.
   */
  private splitByHeadings(content: string): ParsedSection[] {
    const lines = content.split('\n');
    const sections: ParsedSection[] = [];
    let currentHeading = '';
    let currentLevel = 0;
    let currentBodyLines: string[] = [];
    let sectionStartLine = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;
      const headingMatch = line.match(/^(#{1,2})\s+(.+)$/);

      if (headingMatch) {
        // Flush the previous body as a section (if any content)
        if (currentBodyLines.length > 0) {
          const bodyContent = currentBodyLines.join('\n');
          if (bodyContent.trim().length > 0) {
            sections.push({
              heading: currentHeading,
              level: currentLevel,
              body: bodyContent,
              startLine: sectionStartLine,
              endLine: lineNumber - 1,
              isHeading: false,
            });
          }
        }

        // Record the new heading
        currentHeading = headingMatch[2].trim();
        currentLevel = headingMatch[1].length;
        currentBodyLines = [];
        sectionStartLine = lineNumber;

        // Add the heading entry
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          body: '',
          startLine: lineNumber,
          endLine: lineNumber,
          isHeading: true,
        });
      } else {
        currentBodyLines.push(line);
      }
    }

    // Flush the last body section
    if (currentBodyLines.length > 0) {
      const bodyContent = currentBodyLines.join('\n');
      if (bodyContent.trim().length > 0) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          body: bodyContent,
          startLine: sectionStartLine,
          endLine: lines.length,
          isHeading: false,
        });
      }
    }

    return sections;
  }

  /**
   * Recursively find all Markdown files in the project directory.
   */
  private findMarkdownFiles(dirPath: string): string[] {
    const files: string[] = [];

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (!this.excludeDirs.includes(entry.name)) {
            files.push(...this.findMarkdownFiles(fullPath));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (this.extensions.includes(ext)) {
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size <= this.maxFileSize) {
                files.push(fullPath);
              }
            } catch {
              // Skip files we can't stat
              continue;
            }
          }
        }
      }
    } catch (error) {
      // Gracefully handle directory read errors
      console.error(
        `[IndexingPipeline:DocumentationConnector] DirectoryError: Failed to read ${dirPath}`,
        { dirPath, error: error instanceof Error ? error.message : String(error) }
      );
    }

    return files;
  }

  /**
   * Generate a deterministic node ID from file path, heading, and line number.
   */
  private generateNodeId(filePath: string, heading: string, startLine: number): string {
    const input = `${filePath}:${heading}:${startLine}`;
    return createHash('sha256').update(input).digest('hex').substring(0, 16);
  }
}

// ─── Internal Types ─────────────────────────────────────────────

interface ParsedSection {
  heading: string;
  level: number;
  body: string;
  startLine: number;
  endLine: number;
  isHeading: boolean;
}
