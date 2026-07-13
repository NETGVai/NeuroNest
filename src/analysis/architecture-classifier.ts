/**
 * Architecture Layer Classifier
 *
 * Assigns files to architectural layers using directory naming conventions
 * and content-based heuristics as a fallback.
 *
 * Layer assignment priority:
 * 1. Directory convention (case-insensitive path segment matching)
 * 2. Content heuristic (React exports → UI, DB patterns → Data, HTTP handlers → Services)
 * 3. Default fallback → Utils
 */

import * as fs from 'fs';
import type {
  ArchitectureLayer,
  ClassificationMethod,
  DependencyGraph,
  LayerAssignment,
} from './types.js';

/**
 * Maps directory name patterns (case-insensitive) to architecture layers.
 * Each entry is checked against every path segment of the file path.
 */
const DIRECTORY_RULES: ReadonlyArray<{ patterns: readonly string[]; layer: ArchitectureLayer }> = [
  {
    patterns: ['component', 'view', 'page', 'ui', 'pages', 'views', 'components'],
    layer: 'UI',
  },
  {
    patterns: ['service', 'api', 'services', 'apis', 'handler', 'controller'],
    layer: 'Services',
  },
  {
    patterns: ['util', 'helper', 'lib', 'utils', 'helpers', 'shared'],
    layer: 'Utils',
  },
  {
    patterns: ['model', 'schema', 'db', 'database', 'entity', 'migration'],
    layer: 'Data',
  },
  {
    patterns: ['config', 'configuration', 'settings', 'env'],
    layer: 'Config',
  },
  {
    patterns: ['test', 'spec', '__tests__', '__mocks__', 'fixtures'],
    layer: 'Tests',
  },
];

/**
 * Regex patterns for content-based heuristic classification.
 */
const REACT_COMPONENT_PATTERN =
  /export\s+default\s+function\s+[A-Z]|export\s+const\s+\w+\s*[=:]\s*React\.FC|export\s+const\s+\w+\s*:\s*React\.FC|export\s+default\s+class\s+\w+\s+extends\s+React\.(Component|PureComponent)/;

const DATABASE_PATTERN =
  /\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b|prisma\.|knex\.|sequelize\.|typeorm\.|mongoose\./i;

const HTTP_HANDLER_PATTERN =
  /\(\s*req\s*,\s*res\s*(,\s*next\s*)?\)|app\.(get|post|put|delete|patch|use)\s*\(|router\.(get|post|put|delete|patch|use)\s*\(/;

export class ArchitectureLayerClassifier {
  /**
   * Classify all files in the dependency graph into architectural layers.
   *
   * For each node in the graph:
   * 1. Try directory-convention matching first
   * 2. Fall back to content-heuristic if no directory match
   * 3. Default to 'Utils' if no heuristic matches
   *
   * Each file is assigned exactly one layer.
   */
  classifyFiles(graph: DependencyGraph): LayerAssignment[] {
    const assignments: LayerAssignment[] = [];

    for (const [fileId, node] of graph.nodes) {
      const directoryLayer = this.classifyByDirectory(node.filePath);

      if (directoryLayer !== null) {
        assignments.push({
          fileId,
          filePath: node.filePath,
          layer: directoryLayer,
          method: 'directory-convention',
        });
      } else {
        // Attempt content-based classification
        let content = '';
        try {
          content = fs.readFileSync(node.filePath, 'utf-8');
        } catch {
          // If file cannot be read, fall back to default
        }

        const contentLayer = this.classifyByContent(node.filePath, content);
        const method: ClassificationMethod = content.length > 0 && contentLayer !== 'Utils'
          ? 'content-heuristic'
          : 'default';

        assignments.push({
          fileId,
          filePath: node.filePath,
          layer: contentLayer,
          method,
        });
      }
    }

    return assignments;
  }

  /**
   * Classify a file by its directory path segments.
   *
   * Splits the file path into segments and checks each segment (case-insensitive)
   * against the directory convention rules. Returns the first matching layer,
   * or null if no directory convention matches.
   */
  classifyByDirectory(filePath: string): ArchitectureLayer | null {
    // Normalize path separators and split into segments
    const normalizedPath = filePath.replace(/\\/g, '/');
    const segments = normalizedPath.split('/');

    // Check each segment against each rule (case-insensitive)
    for (const segment of segments) {
      const lowerSegment = segment.toLowerCase();
      for (const rule of DIRECTORY_RULES) {
        if (rule.patterns.includes(lowerSegment)) {
          return rule.layer;
        }
      }
    }

    return null;
  }

  /**
   * Classify a file by its content using heuristic patterns.
   *
   * Checks for:
   * 1. React component exports → UI
   * 2. Database query patterns → Data
   * 3. HTTP handler patterns → Services
   * 4. Default → Utils
   */
  classifyByContent(filePath: string, content: string): ArchitectureLayer {
    if (!content) {
      return 'Utils';
    }

    // Check for React component patterns
    if (REACT_COMPONENT_PATTERN.test(content)) {
      return 'UI';
    }

    // Check for database patterns
    if (DATABASE_PATTERN.test(content)) {
      return 'Data';
    }

    // Check for HTTP handler patterns
    if (HTTP_HANDLER_PATTERN.test(content)) {
      return 'Services';
    }

    // Default fallback
    return 'Utils';
  }
}
