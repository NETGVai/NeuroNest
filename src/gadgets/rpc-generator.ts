/**
 * RPC Generator — Agent-Friendly API Generation for Gadgets.
 *
 * Automatically produces typed RPC interfaces for every Gadget by:
 * - Parsing Gadget server source with TypeScript compiler API
 * - Extracting exported async functions as RPC methods with full type information
 * - Generating .d.ts files for type safety
 * - Regenerating on file changes (< 2s via chokidar watcher)
 * - Runtime validation via Zod schemas derived from TypeScript types
 *
 * Ensures identical method signatures are accessible from client UI,
 * agent swarm, and Code Mode contexts.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { z, type ZodType } from 'zod';
import type {
  RPCGenerator,
  RPCInterfaceDefinition,
  RPCMethod,
  RPCParameter,
  RPCValidationError,
} from '../types/cloudflare-os.js';
import { createSubsystemError, type SubsystemError } from '../types/subsystem-error.js';

// ─── Constants ──────────────────────────────────────────────────

/** Base directory for all gadget data */
const GADGETS_BASE_DIR = path.join(homedir(), '.neuronest', 'gadgets');

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for RPCGeneratorImpl */
export interface RPCGeneratorConfig {
  /** Optional custom base directory for gadget data (for testing) */
  gadgetsBaseDir?: string;
  /** Optional callback when an RPC interface is regenerated */
  onRegenerate?: (gadgetId: string, definition: RPCInterfaceDefinition) => void;
}

/** Cached interface definition with validation schemas */
interface CachedInterface {
  definition: RPCInterfaceDefinition;
  schemas: Map<string, ZodType[]>;
}

// ─── TypeScript Type to String Mapping ──────────────────────────

/**
 * Resolve a TypeScript type node to a string representation.
 */
function typeNodeToString(node: ts.TypeNode | undefined, sourceFile: ts.SourceFile): string {
  if (!node) return 'unknown';

  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'string';
    case ts.SyntaxKind.NumberKeyword:
      return 'number';
    case ts.SyntaxKind.BooleanKeyword:
      return 'boolean';
    case ts.SyntaxKind.VoidKeyword:
      return 'void';
    case ts.SyntaxKind.AnyKeyword:
      return 'any';
    case ts.SyntaxKind.UndefinedKeyword:
      return 'undefined';
    case ts.SyntaxKind.NullKeyword:
      return 'null';
    case ts.SyntaxKind.NeverKeyword:
      return 'never';
    case ts.SyntaxKind.ObjectKeyword:
      return 'object';
    case ts.SyntaxKind.UnknownKeyword:
      return 'unknown';
    default:
      // Fall back to the source text for complex types
      return node.getText(sourceFile);
  }
}

/**
 * Resolve a return type from a function declaration, unwrapping Promise<T>.
 */
function resolveReturnType(
  funcDecl: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
): string {
  // First try the explicit type annotation
  if (funcDecl.type) {
    const typeText = typeNodeToString(funcDecl.type, sourceFile);
    // Unwrap Promise<T> to just T for RPC interface
    const promiseMatch = typeText.match(/^Promise<(.+)>$/);
    if (promiseMatch) {
      return promiseMatch[1];
    }
    return typeText;
  }

  // If no explicit annotation, try the type checker
  if (checker) {
    const signature = checker.getSignatureFromDeclaration(funcDecl);
    if (signature) {
      const returnType = checker.getReturnTypeOfSignature(signature);
      let typeString = checker.typeToString(returnType);
      // Unwrap Promise<T>
      const promiseMatch = typeString.match(/^Promise<(.+)>$/);
      if (promiseMatch) {
        typeString = promiseMatch[1];
      }
      return typeString;
    }
  }

  return 'unknown';
}

/**
 * Extract the JSDoc description from a function declaration.
 */
function extractDescription(funcDecl: ts.FunctionDeclaration, sourceFile: ts.SourceFile): string | undefined {
  const jsDocTags = ts.getJSDocTags(funcDecl);
  // Get full JSDoc comment
  const jsDocs = (funcDecl as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (jsDocs && jsDocs.length > 0) {
    const comment = jsDocs[0].comment;
    if (typeof comment === 'string') return comment;
    if (Array.isArray(comment)) {
      return comment.map((part) => (typeof part === 'string' ? part : part.text || '')).join('');
    }
  }

  // Fallback: check for leading comment
  const fullText = sourceFile.getFullText();
  const leadingComments = ts.getLeadingCommentRanges(fullText, funcDecl.getFullStart());
  if (leadingComments && leadingComments.length > 0) {
    const lastComment = leadingComments[leadingComments.length - 1];
    const commentText = fullText.substring(lastComment.pos, lastComment.end);
    // Strip comment markers
    const cleaned = commentText
      .replace(/^\/\*\*?\s*/, '')
      .replace(/\s*\*\/$/, '')
      .replace(/^\s*\*\s?/gm, '')
      .trim();
    if (cleaned.length > 0 && cleaned.length < 200) {
      return cleaned;
    }
  }

  return undefined;
}

// ─── TypeScript Type to Zod Schema Mapping ──────────────────────

/**
 * Convert a TypeScript type string to a Zod schema for runtime validation.
 */
function typeStringToZodSchema(typeStr: string): ZodType {
  switch (typeStr) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'undefined':
      return z.undefined();
    case 'void':
      return z.void();
    case 'any':
    case 'unknown':
      return z.unknown();
    case 'object':
      return z.record(z.string(), z.unknown());
    case 'never':
      return z.never();
    default:
      // Handle array types
      if (typeStr.endsWith('[]')) {
        const elementType = typeStr.slice(0, -2);
        return z.array(typeStringToZodSchema(elementType));
      }
      // Handle Array<T>
      const arrayMatch = typeStr.match(/^Array<(.+)>$/);
      if (arrayMatch) {
        return z.array(typeStringToZodSchema(arrayMatch[1]));
      }
      // Handle union types: string | number
      if (typeStr.includes(' | ')) {
        const parts = typeStr.split(' | ').map((p) => p.trim());
        if (parts.length === 2) {
          return z.union([typeStringToZodSchema(parts[0]), typeStringToZodSchema(parts[1])]);
        }
        // For 3+ parts, build a union
        const schemas = parts.map(typeStringToZodSchema) as [ZodType, ZodType, ...ZodType[]];
        return z.union(schemas);
      }
      // Handle Record<K, V>
      const recordMatch = typeStr.match(/^Record<(.+),\s*(.+)>$/);
      if (recordMatch) {
        return z.record(z.string(), typeStringToZodSchema(recordMatch[2].trim()));
      }
      // Default: accept anything for complex/unknown types
      return z.unknown();
  }
}

/**
 * Build Zod schemas for all parameters of an RPC method.
 */
function buildParameterSchemas(method: RPCMethod): ZodType[] {
  return method.parameters.map((param) => {
    const schema = typeStringToZodSchema(param.type);
    if (!param.required) {
      return schema.optional() as unknown as ZodType;
    }
    return schema;
  });
}

// ─── .d.ts Generation ───────────────────────────────────────────

/**
 * Generate a TypeScript .d.ts declaration file from an RPC interface definition.
 * The generated interface is identical regardless of calling context (client UI,
 * agent swarm, or Code Mode), ensuring uniform access.
 */
function generateTypeDefinitions(definition: RPCInterfaceDefinition): string {
  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * Auto-generated RPC interface for gadget: ${definition.gadgetId}`);
  lines.push(` * Version: ${definition.version}`);
  lines.push(` * Generated at: ${definition.generatedAt}`);
  lines.push(` *`);
  lines.push(` * This interface is identical across all calling contexts:`);
  lines.push(` * - Client UI`);
  lines.push(` * - Agent Swarm`);
  lines.push(` * - Code Mode`);
  lines.push(` */`);
  lines.push('');
  lines.push(`export interface ${sanitizeIdentifier(definition.gadgetId)}RPC {`);

  for (const method of definition.methods) {
    // Add JSDoc for the method
    if (method.description) {
      lines.push(`  /** ${method.description} */`);
    }

    // Build parameter list
    const params = method.parameters
      .map((p) => {
        const optional = p.required ? '' : '?';
        return `${p.name}${optional}: ${p.type}`;
      })
      .join(', ');

    lines.push(`  ${method.name}(${params}): Promise<${method.returnType}>;`);
  }

  lines.push(`}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Sanitize a gadget ID into a valid TypeScript identifier.
 */
function sanitizeIdentifier(id: string): string {
  // Replace non-alphanumeric characters with underscores, ensure starts with letter
  const sanitized = id.replace(/[^a-zA-Z0-9]/g, '_');
  if (/^[0-9]/.test(sanitized)) {
    return `Gadget_${sanitized}`;
  }
  return sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
}

// ─── Implementation ─────────────────────────────────────────────

export class RPCGeneratorImpl implements RPCGenerator {
  private readonly baseDir: string;
  private readonly onRegenerate: ((gadgetId: string, definition: RPCInterfaceDefinition) => void) | null;

  /** Cached interface definitions keyed by gadgetId */
  private readonly cache: Map<string, CachedInterface> = new Map();

  /** Active file watchers keyed by gadgetId */
  private readonly watchers: Map<string, { close(): void }> = new Map();

  constructor(config?: RPCGeneratorConfig) {
    this.baseDir = config?.gadgetsBaseDir ?? GADGETS_BASE_DIR;
    this.onRegenerate = config?.onRegenerate ?? null;
  }

  // ─── RPCGenerator Interface Methods ─────────────────────────────

  /**
   * Generate an RPC interface definition by parsing source code.
   * Extracts all exported async functions as RPC methods with full type information.
   *
   * Requirements: 9.1, 9.3
   */
  generate(gadgetId: string, sourceCode: string): RPCInterfaceDefinition {
    try {
      const methods = this.parseSourceCode(sourceCode);
      const definition: RPCInterfaceDefinition = {
        gadgetId,
        version: this.getNextVersion(gadgetId),
        methods,
        generatedAt: new Date().toISOString(),
        typeDefinitions: '',
      };

      // Generate .d.ts content
      definition.typeDefinitions = generateTypeDefinitions(definition);

      // Build and cache validation schemas
      const schemas = new Map<string, ZodType[]>();
      for (const method of methods) {
        schemas.set(method.name, buildParameterSchemas(method));
      }

      this.cache.set(gadgetId, { definition, schemas });

      // Write .d.ts file to the gadget's source directory
      this.writeTypeDefinitionFile(gadgetId, definition.typeDefinitions);

      return definition;
    } catch (err) {
      throw this.createError(
        'RPC_SOURCE_PARSE_ERROR',
        `Failed to parse source code for gadget "${gadgetId}": ${(err as Error).message}`,
        { details: { gadgetId }, recoverable: true, suggestedAction: 'Fix source code syntax errors' },
      );
    }
  }

  /**
   * Regenerate the RPC interface from the gadget's on-disk source files.
   * Reads the server source file, re-parses, and updates the cache.
   * Triggered by file change watchers (< 2s).
   *
   * Requirements: 9.4
   */
  async regenerate(gadgetId: string): Promise<RPCInterfaceDefinition> {
    const sourcePath = path.join(this.baseDir, gadgetId, 'src');
    const serverFile = path.join(sourcePath, 'server.ts');

    if (!fs.existsSync(serverFile)) {
      throw this.createError(
        'RPC_GENERATION_FAILED',
        `Server source file not found for gadget "${gadgetId}" at ${serverFile}`,
        { details: { gadgetId, path: serverFile }, recoverable: true, suggestedAction: 'Create server.ts' },
      );
    }

    const sourceCode = fs.readFileSync(serverFile, 'utf-8');
    const definition = this.generate(gadgetId, sourceCode);

    // Notify listener if registered
    if (this.onRegenerate) {
      this.onRegenerate(gadgetId, definition);
    }

    return definition;
  }

  /**
   * Validate an RPC call against the interface definition using Zod schemas.
   * Returns null if validation passes, or a structured error with all mismatches.
   *
   * Requirements: 9.5
   */
  validate(gadgetId: string, method: string, args: unknown[]): RPCValidationError | null {
    const cached = this.cache.get(gadgetId);
    if (!cached) {
      throw this.createError(
        'RPC_VALIDATION_FAILED',
        `No RPC interface cached for gadget "${gadgetId}". Call generate() first.`,
        { details: { gadgetId }, recoverable: true, suggestedAction: 'Call generate() or regenerate()' },
      );
    }

    const methodDef = cached.definition.methods.find((m) => m.name === method);
    if (!methodDef) {
      return {
        method,
        mismatches: [],
        missingParams: [`Method "${method}" does not exist on gadget "${gadgetId}"`],
      };
    }

    const schemas = cached.schemas.get(method);
    if (!schemas) {
      return null; // No schema = no validation
    }

    const mismatches: { parameter: string; expected: string; received: string }[] = [];
    const missingParams: string[] = [];

    // Check for missing required parameters
    for (let i = 0; i < methodDef.parameters.length; i++) {
      const param = methodDef.parameters[i];
      const arg = i < args.length ? args[i] : undefined;

      if (param.required && (arg === undefined || arg === null) && i >= args.length) {
        missingParams.push(param.name);
        continue;
      }

      // Validate type with Zod schema
      if (i < args.length && schemas[i]) {
        const result = schemas[i].safeParse(arg);
        if (!result.success) {
          mismatches.push({
            parameter: param.name,
            expected: param.type,
            received: typeof arg,
          });
        }
      }
    }

    if (mismatches.length === 0 && missingParams.length === 0) {
      return null; // Validation passed
    }

    return { method, mismatches, missingParams };
  }

  /**
   * Get the TypeScript .d.ts type definitions for a gadget's RPC interface.
   *
   * Requirements: 9.3
   */
  getTypeDefinitions(gadgetId: string): string {
    const cached = this.cache.get(gadgetId);
    if (cached) {
      return cached.definition.typeDefinitions;
    }

    // Try to read from disk
    const dtsPath = path.join(this.baseDir, gadgetId, 'src', 'rpc.d.ts');
    if (fs.existsSync(dtsPath)) {
      return fs.readFileSync(dtsPath, 'utf-8');
    }

    return '';
  }

  // ─── File Watching ──────────────────────────────────────────────

  /**
   * Start watching a gadget's source files for changes.
   * On change, regenerate the RPC interface (< 2s target).
   *
   * Requirements: 9.4
   */
  watchGadget(gadgetId: string): void {
    // Stop any existing watcher
    this.unwatchGadget(gadgetId);

    const sourcePath = path.join(this.baseDir, gadgetId, 'src');
    if (!fs.existsSync(sourcePath)) return;

    try {
      // Dynamic import of chokidar (available as dependency)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const chokidar = require('chokidar');
      const watcher = chokidar.watch(path.join(sourcePath, '**/*.ts'), {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 50,
        },
      });

      let regenerateTimeout: ReturnType<typeof setTimeout> | null = null;

      const handleChange = (): void => {
        // Debounce: wait 300ms of no changes before regenerating
        if (regenerateTimeout) clearTimeout(regenerateTimeout);
        regenerateTimeout = setTimeout(() => {
          this.regenerate(gadgetId).catch(() => {
            // Silently fail on regeneration errors during watch
            // (source may be in a transient broken state during editing)
          });
        }, 300);
      };

      watcher.on('change', handleChange);
      watcher.on('add', handleChange);
      watcher.on('unlink', handleChange);

      this.watchers.set(gadgetId, watcher);
    } catch {
      // chokidar not available — gracefully degrade
    }
  }

  /**
   * Stop watching a gadget's source files.
   */
  unwatchGadget(gadgetId: string): void {
    const watcher = this.watchers.get(gadgetId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(gadgetId);
    }
  }

  /**
   * Stop all file watchers. Called during shutdown.
   */
  unwatchAll(): void {
    for (const [gadgetId] of this.watchers) {
      this.unwatchGadget(gadgetId);
    }
  }

  /**
   * Get a cached RPC interface definition (if available).
   */
  getCachedDefinition(gadgetId: string): RPCInterfaceDefinition | null {
    return this.cache.get(gadgetId)?.definition ?? null;
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Parse TypeScript source code and extract exported async functions as RPC methods.
   * Uses the TypeScript compiler API to analyze the AST.
   */
  private parseSourceCode(sourceCode: string): RPCMethod[] {
    const methods: RPCMethod[] = [];

    // createSourceFile() recovers from malformed input, so reject syntax errors
    // before traversing an AST that may contain synthesized or missing names.
    const syntaxCheck = ts.transpileModule(sourceCode, {
      fileName: 'server.ts',
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    });
    const syntaxDiagnostics = (syntaxCheck.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );

    if (syntaxDiagnostics.length > 0) {
      const messages = syntaxDiagnostics.map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        if (!diagnostic.file || diagnostic.start === undefined) {
          return `TS${diagnostic.code}: ${message}`;
        }

        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `${diagnostic.file.fileName}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
      });
      throw new Error(`Invalid TypeScript syntax: ${messages.join('; ')}`);
    }

    // Create a source file from the syntax-checked code.
    const sourceFile = ts.createSourceFile(
      'server.ts',
      sourceCode,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );

    const assertSupportedParameterBindings = (
      params: ts.NodeArray<ts.ParameterDeclaration>,
    ): void => {
      for (const param of params) {
        if (!ts.isIdentifier(param.name) || param.name.text.length === 0) {
          const binding = param.name.getText(sourceFile).trim() || '<missing>';
          throw new Error(
            `Unsupported RPC parameter binding "${binding}"; RPC parameters must use named identifiers`,
          );
        }
      }
    };

    // Walk the AST looking for exported async function declarations
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && this.isExportedAsyncFunction(node)) {
        assertSupportedParameterBindings(node.parameters);
        const method = this.extractMethodFromFunction(node, sourceFile);
        if (method) {
          methods.push(method);
        }
      }

      // Also handle `export const fn = async (...) => { ... }`
      if (ts.isVariableStatement(node) && this.hasExportModifier(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isVariableDeclaration(decl) &&
            decl.initializer &&
            this.isAsyncArrowOrFunction(decl.initializer)
          ) {
            if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
              assertSupportedParameterBindings(decl.initializer.parameters);
            }
            const method = this.extractMethodFromVariableDecl(decl, sourceFile);
            if (method) {
              methods.push(method);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return methods;
  }

  /**
   * Check if a function declaration is exported and async.
   */
  private isExportedAsyncFunction(node: ts.FunctionDeclaration): boolean {
    if (!node.name) return false; // Skip anonymous functions

    const modifiers = ts.getModifiers(node);
    if (!modifiers) return false;

    const hasExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const hasAsync = modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

    return hasExport && hasAsync;
  }

  /**
   * Check if a variable statement has an export modifier.
   */
  private hasExportModifier(node: ts.VariableStatement): boolean {
    const modifiers = ts.getModifiers(node);
    if (!modifiers) return false;
    return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  /**
   * Check if an expression is an async arrow function or async function expression.
   */
  private isAsyncArrowOrFunction(node: ts.Expression): boolean {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const modifiers = ts.getModifiers(node as ts.ArrowFunction | ts.FunctionExpression);
      if (modifiers) {
        return modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      }
      // Check the async keyword flag for arrow functions
      if (ts.isArrowFunction(node)) {
        return !!(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
      }
    }
    return false;
  }

  /**
   * Extract an RPCMethod from a function declaration.
   */
  private extractMethodFromFunction(
    funcDecl: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
  ): RPCMethod | null {
    if (!funcDecl.name) return null;

    const name = funcDecl.name.text;
    const parameters = this.extractParameters(funcDecl.parameters, sourceFile);
    const returnType = resolveReturnType(funcDecl, sourceFile);
    const description = extractDescription(funcDecl, sourceFile);

    return { name, parameters, returnType, description };
  }

  /**
   * Extract an RPCMethod from an exported const variable declaration with async initializer.
   */
  private extractMethodFromVariableDecl(
    decl: ts.VariableDeclaration,
    sourceFile: ts.SourceFile,
  ): RPCMethod | null {
    if (!ts.isIdentifier(decl.name)) return null;

    const name = decl.name.text;
    const initializer = decl.initializer;
    if (!initializer) return null;

    let parameters: RPCParameter[] = [];
    let returnType = 'unknown';

    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      parameters = this.extractParameters(initializer.parameters, sourceFile);

      if (initializer.type) {
        const typeText = typeNodeToString(initializer.type, sourceFile);
        const promiseMatch = typeText.match(/^Promise<(.+)>$/);
        returnType = promiseMatch ? promiseMatch[1] : typeText;
      }
    }

    return { name, parameters, returnType };
  }

  /**
   * Extract parameter definitions from a function's parameter list.
   */
  private extractParameters(
    params: ts.NodeArray<ts.ParameterDeclaration>,
    sourceFile: ts.SourceFile,
  ): RPCParameter[] {
    return params.map((param) => {
      const name = ts.isIdentifier(param.name) ? param.name.text : param.name.getText(sourceFile);
      const type = param.type ? typeNodeToString(param.type, sourceFile) : 'unknown';
      const required = !param.questionToken && !param.initializer;

      return { name, type, required };
    });
  }

  /**
   * Get the next version number for a gadget's RPC interface.
   */
  private getNextVersion(gadgetId: string): number {
    const cached = this.cache.get(gadgetId);
    return cached ? cached.definition.version + 1 : 1;
  }

  /**
   * Write the .d.ts type definition file to the gadget's source directory.
   */
  private writeTypeDefinitionFile(gadgetId: string, typeDefinitions: string): void {
    const dtsPath = path.join(this.baseDir, gadgetId, 'src', 'rpc.d.ts');
    const dtsDir = path.dirname(dtsPath);

    try {
      if (fs.existsSync(dtsDir)) {
        fs.writeFileSync(dtsPath, typeDefinitions, 'utf-8');
      }
    } catch {
      // Non-fatal: can't write .d.ts file (directory may not exist yet)
    }
  }

  /**
   * Create a structured SubsystemError for the RPC generator.
   */
  private createError(
    code: 'RPC_GENERATION_FAILED' | 'RPC_VALIDATION_FAILED' | 'RPC_SOURCE_PARSE_ERROR',
    message: string,
    options?: { details?: Record<string, unknown>; recoverable?: boolean; suggestedAction?: string },
  ): SubsystemError {
    return createSubsystemError('rpc_generator', code, message, {
      details: options?.details,
      recoverable: options?.recoverable ?? false,
      suggestedAction: options?.suggestedAction,
    });
  }
}
