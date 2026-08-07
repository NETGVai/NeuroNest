/**
 * AST Analyzer — Structural code analysis with dependency graph building.
 *
 * Parses TypeScript/JavaScript using the TypeScript compiler API, Python using
 * regex-based extraction, and JSON for structure. Builds a CodeGraph of symbols
 * and their relationships (imports, calls, inheritance, type references).
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7
 */

import type { SupportedLanguage, SymbolInfo, CodeGraph } from './types.js';

// ---------------------------------------------------------------------------
// Lazy-loaded TypeScript module
// ---------------------------------------------------------------------------

/** Cached reference to the TypeScript module (loaded on demand). */
let _tsModule: typeof import('typescript') | null | undefined;

/**
 * Lazily load the TypeScript compiler API. Returns the module if available,
 * or null if it cannot be resolved (e.g. in production packaged builds where
 * typescript is not bundled).
 */
function getTypeScriptModule(): typeof import('typescript') | null {
  if (_tsModule !== undefined) return _tsModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _tsModule = require('typescript') as typeof import('typescript');
  } catch {
    console.warn(
      '[ast-analyzer] TypeScript compiler API not available — ' +
      'TS/JS parsing will fall back to raw-text mode. ' +
      'This is expected in packaged production builds.',
    );
    _tsModule = null;
  }
  return _tsModule;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParseResult {
  symbols: SymbolInfo[];
  errors: string[];
}

interface EdgeSet {
  imports: string[];
  calls: string[];
  inherits: string[];
  typeRefs: string[];
}

// ---------------------------------------------------------------------------
// AST Analyzer
// ---------------------------------------------------------------------------

export class ASTAnalyzer {
  private readonly graph: CodeGraph = {
    nodes: new Map(),
    edges: new Map(),
  };

  /** Last successful parse per file (retained on parse errors). */
  private readonly lastGoodParse = new Map<string, ParseResult>();

  /** Track which file each symbol belongs to for incremental updates. */
  private readonly fileSymbols = new Map<string, Set<string>>();

  constructor() {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Parse a file and extract symbols + edges. Updates the internal CodeGraph.
   * On parse error, retains last successful result and returns error info.
   */
  parse(filePath: string, content: string, language: SupportedLanguage): ParseResult {
    let result: ParseResult;

    try {
      switch (language) {
        case 'typescript':
        case 'javascript':
          result = this.parseTsJs(filePath, content, language);
          break;
        case 'python':
          result = this.parsePython(filePath, content);
          break;
        case 'json':
          result = this.parseJson(filePath, content);
          break;
        default:
          result = this.fallbackRawText(filePath, content);
          break;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const lastGood = this.lastGoodParse.get(filePath);
      if (lastGood) {
        return { symbols: lastGood.symbols, errors: [`parse_error: ${errorMsg}`] };
      }
      return { symbols: [], errors: [`parse_error: ${errorMsg}`] };
    }

    if (result.errors.length === 0) {
      this.lastGoodParse.set(filePath, result);
    }

    // Update the graph with new symbols
    this.updateGraphForFile(filePath, result.symbols);

    return result;
  }

  /**
   * Look up a symbol by name from the CodeGraph.
   */
  getSymbol(symbolName: string): SymbolInfo | null {
    return this.graph.nodes.get(symbolName) ?? null;
  }

  /**
   * Get all symbols that the given symbol depends on (outgoing edges).
   */
  getDependencies(symbolName: string): SymbolInfo[] {
    const edges = this.graph.edges.get(symbolName);
    if (!edges) return [];

    const deps = new Set<string>([
      ...edges.imports,
      ...edges.calls,
      ...edges.inherits,
      ...edges.typeRefs,
    ]);

    const results: SymbolInfo[] = [];
    for (const dep of deps) {
      const sym = this.graph.nodes.get(dep);
      if (sym) results.push(sym);
    }
    return results;
  }

  /**
   * Get all symbols that depend on the given symbol (incoming edges).
   */
  getDependents(symbolName: string): SymbolInfo[] {
    const results: SymbolInfo[] = [];
    for (const [name, edges] of this.graph.edges) {
      if (name === symbolName) continue;
      const allRefs = [...edges.imports, ...edges.calls, ...edges.inherits, ...edges.typeRefs];
      if (allRefs.includes(symbolName)) {
        const sym = this.graph.nodes.get(name);
        if (sym) results.push(sym);
      }
    }
    return results;
  }

  /**
   * Incrementally update a single file. Re-parses and updates affected edges.
   * Target: <500ms for files <10k lines.
   */
  updateFile(filePath: string, content: string): void {
    const language = this.detectLanguage(filePath);
    this.parse(filePath, content, language);
  }

  /**
   * Returns the full CodeGraph.
   */
  getCodeGraph(): CodeGraph {
    return this.graph;
  }

  // -------------------------------------------------------------------------
  // Language Detection
  // -------------------------------------------------------------------------

  private detectLanguage(filePath: string): SupportedLanguage {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'js':
      case 'jsx':
      case 'mjs':
      case 'cjs':
        return 'javascript';
      case 'py':
        return 'python';
      case 'json':
        return 'json';
      default:
        return 'typescript'; // fallback to TS parser which handles plain text gracefully
    }
  }

  // -------------------------------------------------------------------------
  // TypeScript / JavaScript Parser
  // -------------------------------------------------------------------------

  private parseTsJs(filePath: string, content: string, language: SupportedLanguage): ParseResult {
    const ts = getTypeScriptModule();
    if (!ts) {
      // TypeScript not available — graceful fallback to raw text extraction
      return this.fallbackRawText(filePath, content);
    }

    const scriptKind = language === 'typescript'
      ? (filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      : (filePath.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.JS);

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    const symbols: SymbolInfo[] = [];
    const errors: string[] = [];
    const edges = new Map<string, EdgeSet>();

    // Collect parse diagnostics
    // Note: createSourceFile only produces syntactic diagnostics for severe errors
    // We track errors from try/catch above

    this.visitTsNode(ts, sourceFile, sourceFile, filePath, symbols, edges);

    // Store edges
    for (const [name, edgeSet] of edges) {
      this.graph.edges.set(name, edgeSet);
    }

    return { symbols, errors };
  }

  private visitTsNode(
    ts: typeof import('typescript'),
    node: import('typescript').Node,
    sourceFile: import('typescript').SourceFile,
    filePath: string,
    symbols: SymbolInfo[],
    edges: Map<string, EdgeSet>,
  ): void {
    // Only process top-level statements
    if (node === sourceFile) {
      for (const stmt of sourceFile.statements) {
        this.extractTsSymbol(ts, stmt, sourceFile, filePath, symbols, edges);
      }
      return;
    }
  }

  private extractTsSymbol(
    ts: typeof import('typescript'),
    node: import('typescript').Node,
    sourceFile: import('typescript').SourceFile,
    filePath: string,
    symbols: SymbolInfo[],
    edges: Map<string, EdgeSet>,
  ): void {
    const isExported = this.hasExportModifier(ts, node);

    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const params = node.parameters.map(p => p.name.getText(sourceFile));
      const returnType = node.type ? node.type.getText(sourceFile) : undefined;
      const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const signature = this.buildFunctionSignature(name, params, returnType);

      symbols.push({
        name, kind: 'function', filePath, lineStart, lineEnd,
        parameters: params, returnType, exported: isExported, signature,
      });

      const edgeSet = this.getOrCreateEdges(edges, name);
      this.extractCallsAndRefs(node, sourceFile, edgeSet);
    }

    // Class declarations
    else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const signature = `class ${name}`;

      symbols.push({
        name, kind: 'class', filePath, lineStart, lineEnd,
        exported: isExported, signature,
      });

      const edgeSet = this.getOrCreateEdges(edges, name);

      // Heritage clauses (extends, implements)
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          for (const type of clause.types) {
            const baseName = type.expression.getText(sourceFile);
            if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
              edgeSet.inherits.push(baseName);
            } else {
              edgeSet.typeRefs.push(baseName);
            }
          }
        }
      }

      this.extractCallsAndRefs(node, sourceFile, edgeSet);
    }

    // Interface declarations
    else if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const signature = `interface ${name}`;

      symbols.push({
        name, kind: 'interface', filePath, lineStart, lineEnd,
        exported: isExported, signature,
      });

      const edgeSet = this.getOrCreateEdges(edges, name);
      // Interface heritage (extends)
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          for (const type of clause.types) {
            edgeSet.typeRefs.push(type.expression.getText(sourceFile));
          }
        }
      }
    }

    // Type alias declarations
    else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const signature = `type ${name} = ${node.type.getText(sourceFile)}`;

      symbols.push({
        name, kind: 'type', filePath, lineStart, lineEnd,
        exported: isExported, signature,
      });

      const edgeSet = this.getOrCreateEdges(edges, name);
      this.extractTypeReferences(node.type, sourceFile, edgeSet);
    }

    // Enum declarations
    else if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const signature = `enum ${name}`;

      symbols.push({
        name, kind: 'enum', filePath, lineStart, lineEnd,
        exported: isExported, signature,
      });
    }

    // Variable declarations (const/let/var at top level — constants)
    else if (ts.isVariableStatement(node)) {
      const varExported = isExported;
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          const lineStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const lineEnd = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

          // Detect arrow functions / function expressions as "function" kind
          if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            const fn = decl.initializer;
            const params = fn.parameters.map(p => p.name.getText(sourceFile));
            const returnType = fn.type ? fn.type.getText(sourceFile) : undefined;
            const signature = this.buildFunctionSignature(name, params, returnType);

            symbols.push({
              name, kind: 'function', filePath, lineStart, lineEnd,
              parameters: params, returnType, exported: varExported, signature,
            });

            const edgeSet = this.getOrCreateEdges(edges, name);
            this.extractCallsAndRefs(fn, sourceFile, edgeSet);
          } else {
            const typeAnnotation = decl.type ? decl.type.getText(sourceFile) : undefined;
            const signature = typeAnnotation ? `const ${name}: ${typeAnnotation}` : `const ${name}`;

            symbols.push({
              name, kind: 'constant', filePath, lineStart, lineEnd,
              returnType: typeAnnotation, exported: varExported, signature,
            });

            if (decl.initializer) {
              const edgeSet = this.getOrCreateEdges(edges, name);
              this.extractCallsAndRefs(decl.initializer, sourceFile, edgeSet);
            }
          }
        }
      }
    }

    // Import declarations — track as edges on consuming symbols
    else if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        const importPath = moduleSpecifier.text;
        const importedNames: string[] = [];

        if (node.importClause) {
          // Default import
          if (node.importClause.name) {
            importedNames.push(node.importClause.name.text);
          }
          // Named imports
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const el of node.importClause.namedBindings.elements) {
                importedNames.push(el.name.text);
              }
            }
            // Namespace import
            else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              importedNames.push(node.importClause.namedBindings.name.text);
            }
          }
        }

        // Store imports as edges: each symbol defined in this file that
        // references imported names will get import edges added during
        // call/ref extraction. For now we track the import for the file.
        this.trackFileImports(filePath, importPath, importedNames);
      }
    }

    // Export declarations (re-exports)
    else if (ts.isExportDeclaration(node)) {
      // Handle re-exports if they have a module specifier
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        // Track as import edge for the file
        this.trackFileImports(filePath, node.moduleSpecifier.text, []);
      }
    }
  }

  // -------------------------------------------------------------------------
  // TS/JS Helpers
  // -------------------------------------------------------------------------

  private hasExportModifier(ts: typeof import('typescript'), node: import('typescript').Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    if (!modifiers) return false;
    return modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  private buildFunctionSignature(name: string, params: string[], returnType?: string): string {
    const paramStr = params.join(', ');
    return returnType
      ? `function ${name}(${paramStr}): ${returnType}`
      : `function ${name}(${paramStr})`;
  }

  private getOrCreateEdges(edges: Map<string, EdgeSet>, name: string): EdgeSet {
    let edgeSet = edges.get(name);
    if (!edgeSet) {
      edgeSet = { imports: [], calls: [], inherits: [], typeRefs: [] };
      edges.set(name, edgeSet);
    }
    return edgeSet;
  }

  /** Track imported names from a file for later edge resolution. */
  private readonly fileImports = new Map<string, Map<string, string[]>>();

  private trackFileImports(filePath: string, modulePath: string, names: string[]): void {
    let fileMap = this.fileImports.get(filePath);
    if (!fileMap) {
      fileMap = new Map();
      this.fileImports.set(filePath, fileMap);
    }
    const existing = fileMap.get(modulePath) ?? [];
    fileMap.set(modulePath, [...existing, ...names]);
  }

  /**
   * Walk a node tree to find function calls and type references.
   */
  private extractCallsAndRefs(
    node: import('typescript').Node,
    sourceFile: import('typescript').SourceFile,
    edgeSet: EdgeSet,
  ): void {
    const ts = getTypeScriptModule()!;
    const visit = (n: import('typescript').Node): void => {
      // Function calls
      if (ts.isCallExpression(n)) {
        const callName = this.getCallExpressionName(ts, n, sourceFile);
        if (callName && !edgeSet.calls.includes(callName)) {
          edgeSet.calls.push(callName);
        }
      }
      // Type references
      if (ts.isTypeReferenceNode(n)) {
        const typeName = n.typeName.getText(sourceFile);
        if (!edgeSet.typeRefs.includes(typeName)) {
          edgeSet.typeRefs.push(typeName);
        }
      }
      // Identifier references that match known imports
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
  }

  private getCallExpressionName(ts: typeof import('typescript'), node: import('typescript').CallExpression, sourceFile: import('typescript').SourceFile): string | null {
    const expr = node.expression;
    if (ts.isIdentifier(expr)) {
      return expr.text;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return expr.name.text;
    }
    return null;
  }

  private extractTypeReferences(
    typeNode: import('typescript').TypeNode,
    sourceFile: import('typescript').SourceFile,
    edgeSet: EdgeSet,
  ): void {
    const ts = getTypeScriptModule()!;
    const visit = (n: import('typescript').Node): void => {
      if (ts.isTypeReferenceNode(n)) {
        const typeName = n.typeName.getText(sourceFile);
        if (!edgeSet.typeRefs.includes(typeName)) {
          edgeSet.typeRefs.push(typeName);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(typeNode);
  }

  // -------------------------------------------------------------------------
  // Python Parser (Regex-based)
  // -------------------------------------------------------------------------

  private parsePython(filePath: string, content: string): ParseResult {
    const symbols: SymbolInfo[] = [];
    const errors: string[] = [];
    const lines = content.split('\n');

    // Regex patterns for top-level Python constructs
    const funcPattern = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/;
    const classPattern = /^class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/;
    const importPattern = /^(?:from\s+(\S+)\s+)?import\s+(.+)/;
    const constantPattern = /^([A-Z][A-Z0-9_]*)\s*[=:]/;

    const edges = new Map<string, EdgeSet>();
    let currentSymbolName: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip indented lines (not top-level)
      if (line.startsWith(' ') || line.startsWith('\t')) {
        continue;
      }

      // Update end of previous symbol
      if (currentSymbolName !== null && line.trim() !== '' && !line.startsWith('#')) {
        const sym = symbols.find(s => s.name === currentSymbolName);
        if (sym) {
          sym.lineEnd = lineNum - 1;
        }
      }

      // Function definition
      const funcMatch = line.match(funcPattern);
      if (funcMatch) {
        const isAsync = !!funcMatch[1];
        const name = funcMatch[2];
        const paramsStr = funcMatch[3];
        const returnType = funcMatch[4]?.trim();
        const params = paramsStr
          ? paramsStr.split(',').map(p => p.trim().split(':')[0].split('=')[0].trim()).filter(Boolean)
          : [];

        const prefix = isAsync ? 'async def' : 'def';
        const signature = returnType
          ? `${prefix} ${name}(${paramsStr.trim()}) -> ${returnType}`
          : `${prefix} ${name}(${paramsStr.trim()})`;

        currentSymbolName = name;
        symbols.push({
          name, kind: 'function', filePath, lineStart: lineNum,
          lineEnd: lineNum, // Updated when next symbol starts or EOF
          parameters: params, returnType, exported: true, signature,
        });
        continue;
      }

      // Class definition
      const classMatch = line.match(classPattern);
      if (classMatch) {
        const name = classMatch[1];
        const bases = classMatch[2];
        const signature = bases ? `class ${name}(${bases})` : `class ${name}`;

        currentSymbolName = name;
        symbols.push({
          name, kind: 'class', filePath, lineStart: lineNum,
          lineEnd: lineNum, exported: true, signature,
        });

        // Track inheritance edges
        if (bases) {
          const edgeSet = this.getOrCreateEdges(edges, name);
          const baseNames = bases.split(',').map(b => b.trim()).filter(Boolean);
          for (const base of baseNames) {
            if (base !== 'object') {
              edgeSet.inherits.push(base);
            }
          }
        }
        continue;
      }

      // Import statement (track edges)
      const importMatch = line.match(importPattern);
      if (importMatch) {
        const moduleName = importMatch[1] ?? '';
        const importedItems = importMatch[2];
        const importedNames = importedItems
          .split(',')
          .map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
          .filter(Boolean);

        // Store as file-level imports for edge resolution
        this.trackFileImports(filePath, moduleName || importedItems.trim(), importedNames);
        continue;
      }

      // Top-level constants (ALL_CAPS naming convention)
      const constMatch = line.match(constantPattern);
      if (constMatch) {
        const name = constMatch[1];
        const signature = `${name} = ...`;

        currentSymbolName = name;
        symbols.push({
          name, kind: 'constant', filePath, lineStart: lineNum,
          lineEnd: lineNum, exported: true, signature,
        });
        continue;
      }
    }

    // Fix lineEnd for last symbol (set to last line)
    if (currentSymbolName !== null) {
      const lastSym = symbols.find(s => s.name === currentSymbolName);
      if (lastSym && lastSym.lineEnd === lastSym.lineStart) {
        lastSym.lineEnd = lines.length;
      }
    }

    // Finalize Python symbol line ends by scanning indentation
    this.finalizePythonLineEnds(symbols, lines);

    // Store edges
    for (const [name, edgeSet] of edges) {
      this.graph.edges.set(name, edgeSet);
    }

    return { symbols, errors };
  }

  /**
   * Refine Python symbol lineEnd by looking at indentation blocks.
   */
  private finalizePythonLineEnds(symbols: SymbolInfo[], lines: string[]): void {
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      if (sym.kind === 'constant') continue; // Constants are single-line

      let endLine = sym.lineStart;
      for (let j = sym.lineStart; j < lines.length; j++) {
        const line = lines[j];
        if (j === sym.lineStart - 1) {
          endLine = j + 1;
          continue;
        }
        // If we encounter a non-empty, non-comment, non-indented line, the block ended
        if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('#')) {
          break;
        }
        if (line.trim() !== '') {
          endLine = j + 1;
        }
      }
      sym.lineEnd = endLine;
    }
  }

  // -------------------------------------------------------------------------
  // JSON Parser
  // -------------------------------------------------------------------------

  private parseJson(filePath: string, content: string): ParseResult {
    const symbols: SymbolInfo[] = [];
    const errors: string[] = [];

    try {
      const parsed = JSON.parse(content);

      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        for (const key of keys) {
          const valueType = Array.isArray(parsed[key]) ? 'array' : typeof parsed[key];
          const signature = `"${key}": ${valueType}`;

          symbols.push({
            name: key,
            kind: 'constant',
            filePath,
            lineStart: 1,
            lineEnd: 1,
            exported: true,
            signature,
          });
        }

        // Try to find actual line numbers for keys
        this.resolveJsonLineNumbers(symbols, content);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      errors.push(`json_parse_error: ${errorMsg}`);
    }

    return { symbols, errors };
  }

  /**
   * Attempt to resolve line numbers for JSON keys by scanning the content.
   */
  private resolveJsonLineNumbers(symbols: SymbolInfo[], content: string): void {
    const lines = content.split('\n');
    for (const sym of symbols) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`"${sym.name}"`)) {
          sym.lineStart = i + 1;
          sym.lineEnd = i + 1;
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fallback (raw text for unsupported languages)
  // -------------------------------------------------------------------------

  private fallbackRawText(filePath: string, content: string): ParseResult {
    // For unsupported languages, we cannot extract meaningful symbols.
    // Return empty symbols to indicate no structural analysis available.
    return { symbols: [], errors: [] };
  }

  // -------------------------------------------------------------------------
  // Graph Management
  // -------------------------------------------------------------------------

  /**
   * Update the CodeGraph when a file is (re-)parsed.
   * Removes old symbols for the file, inserts new ones, and resolves import edges.
   */
  private updateGraphForFile(filePath: string, symbols: SymbolInfo[]): void {
    // Remove old symbols for this file
    const oldSymbolNames = this.fileSymbols.get(filePath);
    if (oldSymbolNames) {
      for (const name of oldSymbolNames) {
        this.graph.nodes.delete(name);
        this.graph.edges.delete(name);
      }
    }

    // Insert new symbols
    const newNames = new Set<string>();
    for (const sym of symbols) {
      this.graph.nodes.set(sym.name, sym);
      newNames.add(sym.name);

      // Ensure edges entry exists
      if (!this.graph.edges.has(sym.name)) {
        this.graph.edges.set(sym.name, { imports: [], calls: [], inherits: [], typeRefs: [] });
      }
    }
    this.fileSymbols.set(filePath, newNames);

    // Resolve import edges: if a symbol uses an imported name that
    // matches a known symbol in the graph, add an import edge.
    const fileImports = this.fileImports.get(filePath);
    if (fileImports) {
      for (const sym of symbols) {
        const edgeSet = this.graph.edges.get(sym.name);
        if (!edgeSet) continue;

        for (const [, importedNames] of fileImports) {
          for (const importedName of importedNames) {
            if (this.graph.nodes.has(importedName) && importedName !== sym.name) {
              if (!edgeSet.imports.includes(importedName)) {
                edgeSet.imports.push(importedName);
              }
            }
          }
        }
      }
    }
  }
}
