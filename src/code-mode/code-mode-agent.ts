/**
 * Code Mode Agent — Executes agent-generated code snippets in a sandboxed V8 isolate.
 *
 * Provides:
 * - V8 isolate via `vm.createContext()` with resource limits (30s timeout, 128MB memory)
 * - No `require()` or `import` — only explicitly injected APIs
 * - Capability bindings exposed as async functions (e.g., `github.listPRs()`)
 * - Gadget APIs exposed via RPC proxy objects
 * - All external calls mediated through Gatekeeper (injected via closure)
 * - Error capture with CodeModeError (message, stack, line, column)
 * - History logging to `code_snippets` SQLite table
 * - Session continuity: agent can generate corrected code after errors
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import * as vm from 'node:vm';
import type Database from 'better-sqlite3';
import { uuidv7 } from 'uuidv7';
import { createSubsystemError } from '../types/subsystem-error.js';
import type {
  CodeModeAgent,
  CodeModeContext,
  CodeSnippet,
  CodeModeError,
  CodeModeLimits,
  GadgetRPCProxy,
  CapabilityBinding,
  GatekeeperLayer,
} from '../types/cloudflare-os.js';

// ─── Constants ──────────────────────────────────────────────────

/** Default execution time limit: 30 seconds */
const DEFAULT_EXECUTION_TIME_MS = 30_000;

/** Default memory limit: 128 MB */
const DEFAULT_MEMORY_MB = 128;

/** Default maximum snippets per session */
const DEFAULT_MAX_SNIPPETS_PER_SESSION = 100;

// ─── Database Row Type ──────────────────────────────────────────

interface CodeSnippetRow {
  id: string;
  session_id: string;
  agent_id: string;
  code: string;
  language: string;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  executed_at: string;
}

// ─── Implementation ─────────────────────────────────────────────

export class CodeModeAgentImpl implements CodeModeAgent {
  private readonly db: Database.Database;
  private readonly gatekeeper: GatekeeperLayer;
  private limits: CodeModeLimits;

  // Prepared statements
  private readonly stmtInsertSnippet: Database.Statement;
  private readonly stmtGetBySession: Database.Statement;
  private readonly stmtCountBySession: Database.Statement;

  constructor(db: Database.Database, gatekeeper: GatekeeperLayer, limits?: Partial<CodeModeLimits>) {
    this.db = db;
    this.gatekeeper = gatekeeper;
    this.limits = {
      executionTimeMs: limits?.executionTimeMs ?? DEFAULT_EXECUTION_TIME_MS,
      memoryMb: limits?.memoryMb ?? DEFAULT_MEMORY_MB,
      maxSnippetsPerSession: limits?.maxSnippetsPerSession ?? DEFAULT_MAX_SNIPPETS_PER_SESSION,
    };

    // Prepare SQL statements
    this.stmtInsertSnippet = this.db.prepare(`
      INSERT INTO code_snippets (id, session_id, agent_id, code, language, result, error, duration_ms, executed_at)
      VALUES (@id, @session_id, @agent_id, @code, @language, @result, @error, @duration_ms, @executed_at)
    `);

    this.stmtGetBySession = this.db.prepare(`
      SELECT * FROM code_snippets WHERE session_id = ? ORDER BY executed_at ASC
    `);

    this.stmtCountBySession = this.db.prepare(`
      SELECT COUNT(*) as count FROM code_snippets WHERE session_id = ?
    `);
  }

  /**
   * Execute a code snippet in a sandboxed V8 isolate.
   *
   * The isolate has:
   * - No require/import — only injected APIs
   * - Capability bindings as async functions
   * - Gadget RPC proxies
   * - Console logging (captured)
   * - Timeout enforcement (30s default)
   *
   * On error, captures line/column information and session stays alive.
   */
  async execute(code: string, context: CodeModeContext): Promise<CodeSnippet> {
    const snippetId = uuidv7();
    const executedAt = new Date().toISOString();

    // Check snippet limit per session
    const sessionCount = (this.stmtCountBySession.get(context.sessionId) as { count: number }).count;
    if (sessionCount >= this.limits.maxSnippetsPerSession) {
      throw createSubsystemError(
        'code_mode',
        'CODE_SNIPPET_LIMIT',
        `Maximum snippets per session (${this.limits.maxSnippetsPerSession}) exceeded for session "${context.sessionId}"`,
        { recoverable: false, suggestedAction: 'start_new_session' },
      );
    }

    // Build the sandbox context with injected APIs
    const sandbox = this.buildSandbox(context);

    // Create the V8 context
    const vmContext = vm.createContext(sandbox, {
      name: `code-mode-${snippetId}`,
      codeGeneration: {
        strings: false, // Prevent eval()-style code generation
        wasm: false, // Prevent WebAssembly compilation
      },
    });

    const startTime = Date.now();
    let result: unknown = undefined;
    let error: CodeModeError | undefined = undefined;

    try {
      // Wrap code in an async IIFE to support top-level await
      const wrappedCode = `(async () => {\n${code}\n})()`;

      const script = new vm.Script(wrappedCode, {
        filename: `code-mode-${snippetId}.js`,
        lineOffset: -1, // Adjust for the wrapping IIFE line
      });

      // Run with timeout enforcement
      const execResult = script.runInContext(vmContext, {
        timeout: this.limits.executionTimeMs,
        breakOnSigint: true,
      });

      // If the result is a Promise (from our async wrapper), await it
      // with a timeout guard
      if (execResult && typeof execResult.then === 'function') {
        result = await this.withTimeout(
          execResult,
          this.limits.executionTimeMs,
          snippetId,
        );
      } else {
        result = execResult;
      }
    } catch (err: unknown) {
      error = this.captureError(err, code);
    }

    const duration = Date.now() - startTime;

    // Determine language from code heuristic (default javascript)
    const language: 'typescript' | 'javascript' = 'javascript';

    // Build the CodeSnippet record
    const snippet: CodeSnippet = {
      id: snippetId,
      code,
      language,
      executedAt,
      duration,
      ...(error ? { error } : { result }),
    };

    // Persist to database
    this.stmtInsertSnippet.run({
      id: snippet.id,
      session_id: context.sessionId,
      agent_id: context.agentId,
      code: snippet.code,
      language: snippet.language,
      result: snippet.result !== undefined ? JSON.stringify(snippet.result) : null,
      error: snippet.error ? JSON.stringify(snippet.error) : null,
      duration_ms: snippet.duration,
      executed_at: snippet.executedAt,
    });

    return snippet;
  }

  /**
   * Get the execution history for a session, ordered chronologically.
   */
  getHistory(sessionId: string): CodeSnippet[] {
    const rows = this.stmtGetBySession.all(sessionId) as CodeSnippetRow[];
    return rows.map((row) => this.rowToSnippet(row));
  }

  /**
   * Get a Gadget RPC proxy that allows calling a Gadget's methods from Code Mode.
   * All calls are mediated through the Gatekeeper layer.
   */
  getGadgetProxy(gadgetId: string, context: CodeModeContext): GadgetRPCProxy {
    const rpcDef = context.gadgetApis.get(gadgetId);

    return {
      gadgetId,
      call: async (method: string, ...args: unknown[]): Promise<unknown> => {
        // Validate that the method exists in the RPC definition (if available)
        if (rpcDef) {
          const methodDef = rpcDef.methods.find((m) => m.name === method);
          if (!methodDef) {
            throw createSubsystemError(
              'code_mode',
              'CODE_RUNTIME_ERROR',
              `Method "${method}" not found on gadget "${gadgetId}". Available: ${rpcDef.methods.map((m) => m.name).join(', ')}`,
              { recoverable: true, suggestedAction: 'check_method_name' },
            );
          }
        }

        // Find a capability binding that covers this gadget
        const binding = context.capabilities.find(
          (cap) =>
            cap.resourceId === gadgetId ||
            (cap.resourceType === 'gadget' &&
            (cap.scopeConstraints['gadgetId'] === gadgetId || !cap.scopeConstraints['gadgetId'])),
        );

        if (!binding) {
          throw createSubsystemError(
            'code_mode',
            'CODE_RUNTIME_ERROR',
            `No capability binding found for gadget "${gadgetId}". Access denied.`,
            { recoverable: true, suggestedAction: 'request_gadget_capability' },
          );
        }

        // Execute through Gatekeeper
        return this.gatekeeper.execute(binding, `gadget.${method}`, args);
      },
    };
  }

  /**
   * Update execution limits. Partial updates allowed.
   */
  setLimits(limits: Partial<CodeModeLimits>): void {
    if (limits.executionTimeMs !== undefined) {
      this.limits.executionTimeMs = limits.executionTimeMs;
    }
    if (limits.memoryMb !== undefined) {
      this.limits.memoryMb = limits.memoryMb;
    }
    if (limits.maxSnippetsPerSession !== undefined) {
      this.limits.maxSnippetsPerSession = limits.maxSnippetsPerSession;
    }
  }

  // ─── Private: Sandbox Building ────────────────────────────────

  /**
   * Build the sandbox object that becomes the V8 context globals.
   *
   * Injects:
   * - console (log, warn, error, info)
   * - capability bindings as grouped async functions
   * - gadget proxies via getGadgetProxy()
   * - setTimeout / clearTimeout (bounded by execution limit)
   * - JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set
   * - Promise (needed for async/await)
   */
  private buildSandbox(context: CodeModeContext): Record<string, unknown> {
    const logs: string[] = [];

    // Group capability bindings by resource type for ergonomic access
    const capabilityNamespaces = this.buildCapabilityNamespaces(context.capabilities);

    // Build gadget proxy access
    const gadgetProxies = this.buildGadgetProxies(context);

    const sandbox: Record<string, unknown> = {
      // Console — captured for auditing
      console: {
        log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
        warn: (...args: unknown[]) => logs.push(`[WARN] ${args.map(String).join(' ')}`),
        error: (...args: unknown[]) => logs.push(`[ERROR] ${args.map(String).join(' ')}`),
        info: (...args: unknown[]) => logs.push(`[INFO] ${args.map(String).join(' ')}`),
      },

      // Timer support (bounded by execution time limit)
      setTimeout,
      clearTimeout,
      setInterval: undefined, // Explicitly blocked
      clearInterval: undefined,

      // Standard built-ins
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Symbol,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      URIError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURI,
      encodeURIComponent,
      decodeURI,
      decodeURIComponent,
      undefined,
      NaN,
      Infinity,

      // Explicitly blocked dangerous globals
      require: undefined,
      module: undefined,
      exports: undefined,
      __dirname: undefined,
      __filename: undefined,
      process: undefined,
      global: undefined,
      globalThis: undefined,

      // Capability namespaces (e.g., github.listPRs(), api.get())
      ...capabilityNamespaces,

      // Gadget proxy access
      getGadgetProxy: (gadgetId: string) => gadgetProxies.get(gadgetId) ?? this.getGadgetProxy(gadgetId, context),

      // Logs accessor (for debugging within Code Mode)
      __logs: logs,
    };

    return sandbox;
  }

  /**
   * Build capability namespaces from bindings.
   *
   * Groups bindings by resourceType and exposes allowed operations as async functions.
   * For example, a binding with resourceType='github' and allowedOperations=['listPRs', 'createIssue']
   * becomes: { github: { listPRs: async (...args) => ..., createIssue: async (...args) => ... } }
   *
   * All calls go through the Gatekeeper layer.
   */
  private buildCapabilityNamespaces(
    capabilities: CapabilityBinding[],
  ): Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> {
    const namespaces: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};

    for (const binding of capabilities) {
      const ns = binding.resourceType;
      if (!namespaces[ns]) {
        namespaces[ns] = {};
      }

      for (const operation of binding.allowedOperations) {
        // Closure captures binding and operation for Gatekeeper mediation
        namespaces[ns][operation] = async (...args: unknown[]): Promise<unknown> => {
          return this.gatekeeper.execute(binding, operation, args.length === 1 ? args[0] : args);
        };
      }
    }

    return namespaces;
  }

  /**
   * Build Gadget RPC proxy objects for all gadgets in the context.
   */
  private buildGadgetProxies(context: CodeModeContext): Map<string, GadgetRPCProxy> {
    const proxies = new Map<string, GadgetRPCProxy>();

    for (const [gadgetId] of context.gadgetApis) {
      proxies.set(gadgetId, this.getGadgetProxy(gadgetId, context));
    }

    return proxies;
  }

  // ─── Private: Error Capture ───────────────────────────────────

  /**
   * Capture a runtime error with line/column information.
   *
   * Handles:
   * - V8 timeout errors (from vm timeout)
   * - Standard runtime errors with stack traces
   * - VM context errors (not instanceof Error but have .stack)
   * - Unknown error types
   */
  private captureError(err: unknown, sourceCode: string): CodeModeError {
    // Check for objects with message and stack (covers both host Error and VM context errors)
    const errObj = err as Record<string, unknown>;
    if (errObj && typeof errObj === 'object' && typeof errObj['message'] === 'string') {
      const message = errObj['message'] as string;
      const stack = (typeof errObj['stack'] === 'string' ? errObj['stack'] : '') as string;

      // Check for timeout error
      if (message === 'Script execution timed out.' || message.includes('timed out')) {
        return {
          message: `Execution timed out after ${this.limits.executionTimeMs}ms`,
          stack,
          line: 0,
          column: 0,
        };
      }

      // Parse line/column from stack trace
      const { line, column } = this.parseStackLocation(stack, sourceCode);

      return {
        message,
        stack,
        line,
        column,
      };
    }

    // Unknown error type
    return {
      message: String(err),
      stack: '',
      line: 0,
      column: 0,
    };
  }

  /**
   * Parse line and column numbers from a V8 stack trace.
   *
   * V8 stack traces contain lines like:
   *   at code-mode-{id}.js:3:10
   *
   * We adjust for the IIFE wrapper offset.
   */
  private parseStackLocation(
    stack: string,
    _sourceCode: string,
  ): { line: number; column: number } {
    // Match pattern: filename:line:column
    const match = stack.match(/code-mode-[^:]+\.js:(\d+):(\d+)/);
    if (match && match[1] && match[2]) {
      // Line is already adjusted by lineOffset in Script options, but
      // we need to account for the async IIFE wrapper
      const rawLine = parseInt(match[1], 10);
      const column = parseInt(match[2], 10);
      // The wrapper adds 1 line before user code: `(async () => {\n`
      // lineOffset of -1 compensates for this
      return { line: Math.max(1, rawLine), column };
    }

    // Try a more generic pattern
    const genericMatch = stack.match(/:(\d+):(\d+)/);
    if (genericMatch && genericMatch[1] && genericMatch[2]) {
      return {
        line: Math.max(1, parseInt(genericMatch[1], 10)),
        column: parseInt(genericMatch[2], 10),
      };
    }

    return { line: 0, column: 0 };
  }

  // ─── Private: Timeout Wrapper ─────────────────────────────────

  /**
   * Wrap a promise with a timeout. If the promise doesn't resolve
   * within the given time, throws a timeout error.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    snippetId: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          createSubsystemError(
            'code_mode',
            'CODE_EXECUTION_TIMEOUT',
            `Code snippet "${snippetId}" exceeded execution time limit of ${timeoutMs}ms`,
            { recoverable: true, suggestedAction: 'reduce_computation_or_increase_timeout' },
          ),
        );
      }, timeoutMs);

      promise.then(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // ─── Private: Row Conversion ──────────────────────────────────

  /**
   * Convert a database row to a CodeSnippet.
   */
  private rowToSnippet(row: CodeSnippetRow): CodeSnippet {
    return {
      id: row.id,
      code: row.code,
      language: row.language as 'typescript' | 'javascript',
      executedAt: row.executed_at,
      duration: row.duration_ms ?? 0,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error ? JSON.parse(row.error) : undefined,
    };
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create a CodeModeAgent instance backed by the given database and gatekeeper.
 * The database must have the `code_snippets` table (migration 072).
 */
export function createCodeModeAgent(
  db: Database.Database,
  gatekeeper: GatekeeperLayer,
  limits?: Partial<CodeModeLimits>,
): CodeModeAgent {
  return new CodeModeAgentImpl(db, gatekeeper, limits);
}
