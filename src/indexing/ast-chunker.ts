/**
 * AST Chunker - Semantic code chunking using Tree-sitter
 *
 * Parses source files into semantic chunks (functions, classes, methods, interfaces)
 * using Tree-sitter grammars. Falls back to file-level chunking when tree-sitter
 * is unavailable or the language is unsupported.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

// ─── Interfaces ─────────────────────────────────────────────────

export interface Chunk {
  id: string;
  filePath: string;
  content: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  kind: 'function' | 'class' | 'method' | 'interface' | 'module' | 'file';
  name: string;
  parentScope: string | null;
  language: string;
}

export interface CallEdge {
  callerId: string;
  calleeName: string;
  callSiteLine: number;
  callSiteFile: string;
}

// ─── Language Extension Mapping ─────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
};

// Tree-sitter node types that represent chunk boundaries per language
const CHUNK_NODE_TYPES: Record<string, Record<string, Chunk['kind']>> = {
  typescript: {
    function_declaration: 'function',
    arrow_function: 'function',
    class_declaration: 'class',
    method_definition: 'method',
    interface_declaration: 'interface',
    type_alias_declaration: 'interface',
    export_statement: 'module',
    lexical_declaration: 'function', // const fn = () => {}
  },
  javascript: {
    function_declaration: 'function',
    arrow_function: 'function',
    class_declaration: 'class',
    method_definition: 'method',
    export_statement: 'module',
  },
  python: {
    function_definition: 'function',
    class_definition: 'class',
  },
  go: {
    function_declaration: 'function',
    method_declaration: 'method',
    type_declaration: 'interface',
  },
  rust: {
    function_item: 'function',
    impl_item: 'class',
    trait_item: 'interface',
    struct_item: 'class',
  },
  java: {
    method_declaration: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    constructor_declaration: 'method',
  },
  c: {
    function_definition: 'function',
    struct_specifier: 'class',
  },
  cpp: {
    function_definition: 'function',
    class_specifier: 'class',
    struct_specifier: 'class',
  },
};

// Node types that represent function calls per language
const CALL_NODE_TYPES: Record<string, string[]> = {
  typescript: ['call_expression', 'new_expression'],
  javascript: ['call_expression', 'new_expression'],
  python: ['call'],
  go: ['call_expression'],
  rust: ['call_expression', 'macro_invocation'],
  java: ['method_invocation', 'object_creation_expression'],
  c: ['call_expression'],
  cpp: ['call_expression'],
};

// ─── Tree-sitter Availability ───────────────────────────────────

interface TreeSitterParser {
  setLanguage(lang: any): void;
  parse(content: string): any;
}

interface TreeSitterModule {
  Parser: new () => TreeSitterParser;
}

let treeSitterAvailable: boolean | null = null;
let TreeSitterParser: (new () => TreeSitterParser) | null = null;
let loadedGrammars: Record<string, any> = {};

/**
 * Attempt to load tree-sitter. Returns true if available, false otherwise.
 * Uses dynamic require to gracefully handle missing native bindings.
 */
function tryLoadTreeSitter(): boolean {
  if (treeSitterAvailable !== null) return treeSitterAvailable;

  try {
    // Dynamic require to handle missing native bindings gracefully
    const Parser = require('tree-sitter');
    TreeSitterParser = Parser;
    treeSitterAvailable = true;
    return true;
  } catch {
    treeSitterAvailable = false;
    console.warn('[ASTChunker] tree-sitter native bindings not available. Falling back to file-level chunking.');
    return false;
  }
}

/**
 * Load a grammar for a specific language.
 * Returns the grammar object or null if unavailable.
 */
function loadGrammar(language: string): any | null {
  if (loadedGrammars[language] !== undefined) return loadedGrammars[language];

  try {
    let grammar: any;
    switch (language) {
      case 'typescript':
        grammar = require('tree-sitter-typescript').typescript;
        break;
      case 'tsx':
        grammar = require('tree-sitter-typescript').tsx;
        break;
      case 'javascript':
        grammar = require('tree-sitter-javascript');
        break;
      case 'python':
        grammar = require('tree-sitter-python');
        break;
      case 'go':
        grammar = require('tree-sitter-go');
        break;
      case 'rust':
        grammar = require('tree-sitter-rust');
        break;
      case 'java':
        grammar = require('tree-sitter-java');
        break;
      case 'c':
        grammar = require('tree-sitter-c');
        break;
      case 'cpp':
        grammar = require('tree-sitter-cpp');
        break;
      default:
        loadedGrammars[language] = null;
        return null;
    }
    loadedGrammars[language] = grammar;
    return grammar;
  } catch {
    loadedGrammars[language] = null;
    return null;
  }
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Generate a content hash for a string using SHA-256.
 */
function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Generate a chunk ID as hash(filePath + startLine + endLine + contentHash).
 */
function generateChunkId(filePath: string, startLine: number, endLine: number, chunkContentHash: string): string {
  const input = `${filePath}:${startLine}:${endLine}:${chunkContentHash}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Detect language from file extension.
 */
function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] || null;
}

/**
 * Extract the name identifier from a tree-sitter node.
 */
function extractNodeName(node: any, language: string): string {
  // Try common name child patterns
  const nameChild = node.childForFieldName?.('name');
  if (nameChild) return nameChild.text;

  // For arrow functions assigned to variables, look at parent
  if (node.type === 'arrow_function' || node.type === 'function') {
    const parent = node.parent;
    if (parent && parent.type === 'variable_declarator') {
      const nameNode = parent.childForFieldName?.('name');
      if (nameNode) return nameNode.text;
    }
  }

  // For lexical_declaration (const/let/var), get the declarator name
  if (node.type === 'lexical_declaration') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName?.('name');
        if (nameNode) return nameNode.text;
      }
    }
  }

  // For export statements, look at the declaration inside
  if (node.type === 'export_statement') {
    const decl = node.childForFieldName?.('declaration');
    if (decl) return extractNodeName(decl, language);
  }

  // Fallback: use first identifier child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      return child.text;
    }
  }

  return '<anonymous>';
}

/**
 * Extract the callee name from a call expression node.
 */
function extractCalleeName(node: any): string | null {
  const fnNode = node.childForFieldName?.('function') || node.childForFieldName?.('name');
  if (fnNode) {
    // Handle member expressions like obj.method()
    if (fnNode.type === 'member_expression' || fnNode.type === 'field_expression') {
      const prop = fnNode.childForFieldName?.('property') || fnNode.childForFieldName?.('field');
      if (prop) return prop.text;
    }
    return fnNode.text;
  }

  // For method_invocation (Java), try 'name' field
  const nameNode = node.childForFieldName?.('name');
  if (nameNode) return nameNode.text;

  // Fallback: first identifier
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier') return child.text;
  }

  return null;
}

// ─── Raw Chunk (before merging) ─────────────────────────────────

interface RawChunk {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  kind: Chunk['kind'];
  name: string;
  content: string;
  parentNodeId: number | null; // tree-sitter node id for parent tracking
  nodeId: number;
}

// ─── ASTChunker Class ───────────────────────────────────────────

export class ASTChunker {
  private minChunkLines: number;

  constructor(minChunkLines: number = 3) {
    this.minChunkLines = minChunkLines;
  }

  /**
   * Parse a file and return semantic chunks + call edges.
   * Falls back to file-level chunking if tree-sitter is unavailable
   * or the language is unsupported.
   */
  parseFile(filePath: string, content: string): { chunks: Chunk[]; callEdges: CallEdge[] } {
    const language = detectLanguage(filePath);

    // If language is unsupported, fall back to file-level chunking
    if (!language) {
      return { chunks: [this.createFileChunk(filePath, content)], callEdges: [] };
    }

    // If tree-sitter is not available, fall back to file-level chunking
    if (!tryLoadTreeSitter() || !TreeSitterParser) {
      return { chunks: [this.createFileChunk(filePath, content, language)], callEdges: [] };
    }

    // Try to load the grammar
    const grammar = loadGrammar(language);
    if (!grammar) {
      return { chunks: [this.createFileChunk(filePath, content, language)], callEdges: [] };
    }

    try {
      // Parse with tree-sitter
      const parser = new TreeSitterParser!();
      parser.setLanguage(grammar);
      const tree = parser.parse(content);

      if (!tree || !tree.rootNode) {
        return { chunks: [this.createFileChunk(filePath, content, language)], callEdges: [] };
      }

      // Extract raw chunks from AST
      const rawChunks = this.extractChunks(tree.rootNode, language, content);

      // Merge small chunks (< minChunkLines) into nearest enclosing scope
      const mergedChunks = this.mergeSmallChunks(rawChunks);

      // Convert to final Chunk objects with IDs
      const chunks = this.finalizeChunks(mergedChunks, filePath, content, language);

      // If no chunks were extracted, fall back to file-level
      if (chunks.length === 0) {
        return { chunks: [this.createFileChunk(filePath, content, language)], callEdges: [] };
      }

      // Extract call edges
      const callEdges = this.extractCallEdges(tree.rootNode, chunks, filePath, language);

      return { chunks, callEdges };
    } catch (error) {
      // Parse error: fall back to file-level chunking
      console.warn(`[ASTChunker] Parse error for ${filePath}:`, error);
      return { chunks: [this.createFileChunk(filePath, content, language)], callEdges: [] };
    }
  }

  /**
   * Get the list of supported languages.
   */
  getSupportedLanguages(): string[] {
    return ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'c', 'cpp'];
  }

  /**
   * Check if a file's language is supported based on its extension.
   */
  isSupported(filePath: string): boolean {
    const language = detectLanguage(filePath);
    return language !== null && this.getSupportedLanguages().includes(language);
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Create a file-level chunk (fallback for unsupported languages or parse errors).
   */
  private createFileChunk(filePath: string, content: string, language?: string): Chunk {
    const lines = content.split('\n');
    const hash = contentHash(content);
    const lineCount = lines.length;
    const startLine = 1;
    const endLine = lineCount;
    const id = generateChunkId(filePath, startLine, endLine, hash);

    return {
      id,
      filePath,
      content,
      contentHash: hash,
      startLine,
      endLine,
      startByte: 0,
      endByte: Buffer.byteLength(content, 'utf8'),
      kind: 'file',
      name: path.basename(filePath),
      parentScope: null,
      language: language || path.extname(filePath).slice(1) || 'unknown',
    };
  }

  /**
   * Recursively extract chunk boundaries from the AST.
   */
  private extractChunks(rootNode: any, language: string, content: string): RawChunk[] {
    const chunkTypes = CHUNK_NODE_TYPES[language] || {};
    const rawChunks: RawChunk[] = [];

    const visit = (node: any, parentChunkNodeId: number | null) => {
      const kind = chunkTypes[node.type];

      if (kind) {
        // Special handling for lexical_declaration: only chunk if it contains a function
        if (node.type === 'lexical_declaration') {
          let hasFunctionChild = false;
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child.type === 'variable_declarator') {
              const value = child.childForFieldName?.('value');
              if (value && (value.type === 'arrow_function' || value.type === 'function')) {
                hasFunctionChild = true;
              }
            }
          }
          if (!hasFunctionChild) {
            // Not a function declaration, skip
            for (let i = 0; i < node.childCount; i++) {
              visit(node.child(i), parentChunkNodeId);
            }
            return;
          }
        }

        // Special handling for export_statement: only chunk if it wraps a declaration
        if (node.type === 'export_statement') {
          const decl = node.childForFieldName?.('declaration');
          if (!decl || !chunkTypes[decl.type]) {
            // Not wrapping a chunkable declaration, recurse into children
            for (let i = 0; i < node.childCount; i++) {
              visit(node.child(i), parentChunkNodeId);
            }
            return;
          }
        }

        const startLine = node.startPosition.row + 1; // tree-sitter is 0-indexed
        const endLine = node.endPosition.row + 1;
        const name = extractNodeName(node, language);

        rawChunks.push({
          startLine,
          endLine,
          startByte: node.startIndex,
          endByte: node.endIndex,
          kind,
          name,
          content: node.text,
          parentNodeId: parentChunkNodeId,
          nodeId: node.id,
        });

        // Recurse into children with this node as parent
        for (let i = 0; i < node.childCount; i++) {
          visit(node.child(i), node.id);
        }
      } else {
        // Not a chunk boundary, recurse
        for (let i = 0; i < node.childCount; i++) {
          visit(node.child(i), parentChunkNodeId);
        }
      }
    };

    visit(rootNode, null);
    return rawChunks;
  }

  /**
   * Merge chunks that span fewer than minChunkLines into their nearest enclosing scope.
   * If there's no enclosing scope, keep them as-is (they'll be included in file-level).
   */
  private mergeSmallChunks(rawChunks: RawChunk[]): RawChunk[] {
    if (rawChunks.length === 0) return rawChunks;

    const result: RawChunk[] = [];
    const parentMap = new Map<number, RawChunk>();

    // Build a map of nodeId -> chunk for parent lookup
    for (const chunk of rawChunks) {
      parentMap.set(chunk.nodeId, chunk);
    }

    for (const chunk of rawChunks) {
      const lineSpan = chunk.endLine - chunk.startLine + 1;

      if (lineSpan < this.minChunkLines && chunk.parentNodeId !== null) {
        // Find the parent chunk and merge into it (skip this chunk)
        const parent = parentMap.get(chunk.parentNodeId);
        if (parent) {
          // The parent already encompasses this chunk, so we just skip the small one
          continue;
        }
      }

      result.push(chunk);
    }

    return result;
  }

  /**
   * Convert raw chunks to final Chunk objects with proper IDs and parent references.
   */
  private finalizeChunks(rawChunks: RawChunk[], filePath: string, fullContent: string, language: string): Chunk[] {
    const chunks: Chunk[] = [];
    const nodeIdToChunkId = new Map<number, string>();

    // First pass: generate IDs
    for (const raw of rawChunks) {
      const hash = contentHash(raw.content);
      const id = generateChunkId(filePath, raw.startLine, raw.endLine, hash);
      nodeIdToChunkId.set(raw.nodeId, id);
    }

    // Second pass: build final chunks with parent references
    for (const raw of rawChunks) {
      const hash = contentHash(raw.content);
      const id = nodeIdToChunkId.get(raw.nodeId)!;
      const parentScope = raw.parentNodeId !== null
        ? nodeIdToChunkId.get(raw.parentNodeId) || null
        : null;

      chunks.push({
        id,
        filePath,
        content: raw.content,
        contentHash: hash,
        startLine: raw.startLine,
        endLine: raw.endLine,
        startByte: raw.startByte,
        endByte: raw.endByte,
        kind: raw.kind,
        name: raw.name,
        parentScope,
        language,
      });
    }

    return chunks;
  }

  /**
   * Extract call edges from the AST by finding call expression nodes.
   */
  private extractCallEdges(rootNode: any, chunks: Chunk[], filePath: string, language: string): CallEdge[] {
    const callTypes = CALL_NODE_TYPES[language] || [];
    if (callTypes.length === 0) return [];

    const callEdges: CallEdge[] = [];

    const visit = (node: any) => {
      if (callTypes.includes(node.type)) {
        const calleeName = extractCalleeName(node);
        if (calleeName) {
          const callLine = node.startPosition.row + 1;

          // Find the enclosing chunk (caller)
          const callerChunk = this.findEnclosingChunk(chunks, callLine);
          if (callerChunk) {
            callEdges.push({
              callerId: callerChunk.id,
              calleeName,
              callSiteLine: callLine,
              callSiteFile: filePath,
            });
          }
        }
      }

      // Recurse into children
      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    };

    visit(rootNode);
    return callEdges;
  }

  /**
   * Find the most specific (innermost) chunk that contains a given line.
   */
  private findEnclosingChunk(chunks: Chunk[], line: number): Chunk | null {
    let best: Chunk | null = null;
    let bestSpan = Infinity;

    for (const chunk of chunks) {
      if (line >= chunk.startLine && line <= chunk.endLine) {
        const span = chunk.endLine - chunk.startLine;
        if (span < bestSpan) {
          bestSpan = span;
          best = chunk;
        }
      }
    }

    return best;
  }
}
