/**
 * Pattern Detector — Identifies design patterns and anti-patterns in source files.
 *
 * Detects known design patterns (Singleton, Factory, Observer, React Hook) via
 * regex-based AST analysis, and anti-patterns (God Object, High Coupling) via
 * metrics from DependencyNode data.
 *
 * Uses existing tree-sitter parsers when available; falls back to regex-based
 * detection on raw file content. Files without available grammars are skipped.
 *
 * Requirements: 5.1 (AST-based pattern detection within 15s for <1500 files),
 *               5.2 (detect Singleton, Factory, Observer, React Hook),
 *               5.3 (detect God Object, High Coupling; combined reporting),
 *               5.6 (use existing tree-sitter infrastructure),
 *               5.7 (skip files without grammar, report skipped count)
 */
import * as fs from 'fs';
import type {
  DependencyGraph,
  DependencyNode,
  PatternDetectionResult,
  PatternMatch,
  DesignPattern,
  AntiPattern,
} from './types.js';

// ─── Tree-sitter type placeholders ──────────────────────────────────────────

/**
 * Minimal tree-sitter parser interface.
 * When actual tree-sitter parsers are available, they implement this interface.
 */
export interface TreeSitterParser {
  parse(content: string): TreeSitterTree;
}

export interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

export interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
}

// ─── Pattern Detection Regexes ──────────────────────────────────────────────

/**
 * Singleton detection patterns:
 * - Private constructor with static getInstance method
 * - Module-level instance variable with exported accessor
 */
const PRIVATE_CONSTRUCTOR_RE = /private\s+constructor\s*\(/;
const GET_INSTANCE_RE = /static\s+getInstance\s*\(/;
const MODULE_SINGLETON_RE = /(?:let|const)\s+\w*[Ii]nstance\b.*?(?:new\s+\w+|null)/;
const EXPORT_GET_INSTANCE_RE = /export\s+(?:function|const)\s+getInstance/;

/**
 * Factory detection patterns:
 * - Functions with switch/if that return new instances of different types
 */
const FACTORY_FUNCTION_RE = /(?:function\s+\w*[Ff]actory\w*|function\s+create\w+|(?:const|let)\s+\w*[Ff]actory\w*\s*=|(?:const|let)\s+create\w+\s*=)/;
const SWITCH_RETURN_NEW_RE = /switch\s*\([^)]*\)\s*\{[\s\S]*?(?:case\s+[^:]+:[\s\S]*?return\s+new\s+\w+)[\s\S]*?(?:case\s+[^:]+:[\s\S]*?return\s+new\s+\w+)/;
const IF_RETURN_NEW_RE = /(?:if|else\s+if)\s*\([^)]*\)\s*\{?\s*return\s+new\s+\w+/g;

/**
 * Observer detection patterns:
 * - Classes with on/off/emit methods
 * - EventEmitter extension or import
 * - addEventListener/removeEventListener usage
 */
const ON_OFF_EMIT_RE = /(?:\.on|\.off|\.emit|\.addListener|\.removeListener)\s*\(/g;
const EVENT_EMITTER_RE = /(?:extends\s+EventEmitter|require\s*\(\s*['"]events['"]\s*\)|import\s+.*?from\s+['"]events['"])/;
const ADD_EVENT_LISTENER_RE = /addEventListener\s*\(/;

/**
 * React Hook detection patterns:
 * - Exported functions starting with "use"
 * - Contains calls to built-in React hooks
 */
const EXPORT_USE_FUNCTION_RE = /export\s+(?:default\s+)?(?:function|const)\s+(use[A-Z]\w*)/g;
const REACT_HOOK_CALLS_RE = /(?:useState|useEffect|useRef|useMemo|useCallback|useReducer|useContext|useLayoutEffect|useImperativeHandle|useDebugValue)\s*\(/;

// ─── Supported extensions for pattern detection (regex-based) ────────────────

const REGEX_SUPPORTED_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
]);

// ─── PatternDetector Class ───────────────────────────────────────────────────

export class PatternDetector {
  /**
   * Detect design patterns and anti-patterns across all files in the dependency graph.
   *
   * @param graph - The dependency graph containing all file nodes
   * @param treeSitterParsers - Map of file extension to tree-sitter parser (optional)
   * @returns PatternDetectionResult with patterns, anti-patterns, skipped files, and summary
   */
  async detectPatterns(
    graph: DependencyGraph,
    treeSitterParsers: Map<string, TreeSitterParser> = new Map()
  ): Promise<PatternDetectionResult> {
    const patterns: PatternMatch[] = [];
    const antiPatterns: PatternMatch[] = [];
    const skippedFiles: string[] = [];
    const summary: Record<string, number> = {};

    for (const [fileId, node] of graph.nodes) {
      // --- Anti-pattern detection (metrics-based, no AST needed) ---
      const nodeAntiPatterns = this.detectAntiPatterns(node);
      if (nodeAntiPatterns.length > 0) {
        antiPatterns.push(...nodeAntiPatterns);
      }

      // --- Design pattern detection (content-based) ---
      const ext = node.extension.toLowerCase();

      // Check if we can analyze this file (either tree-sitter or regex fallback)
      const hasTreeSitter = treeSitterParsers.has(ext);
      const hasRegexSupport = REGEX_SUPPORTED_EXTENSIONS.has(ext);

      if (!hasTreeSitter && !hasRegexSupport) {
        skippedFiles.push(fileId);
        continue;
      }

      // Read file content
      let content: string;
      try {
        content = fs.readFileSync(node.filePath, 'utf-8');
      } catch {
        skippedFiles.push(fileId);
        continue;
      }

      // If tree-sitter is available, use it; otherwise fall back to regex
      if (hasTreeSitter) {
        const parser = treeSitterParsers.get(ext)!;
        try {
          const tree = parser.parse(content);
          const matches = this.detectPatternsFromAST(tree, node);
          patterns.push(...matches);
        } catch {
          // Tree-sitter parse failed, fall back to regex
          const matches = this.detectPatternsFromRegex(content, node);
          patterns.push(...matches);
        }
      } else {
        const matches = this.detectPatternsFromRegex(content, node);
        patterns.push(...matches);
      }
    }

    // Build summary counts
    for (const match of patterns) {
      summary[match.patternType] = (summary[match.patternType] || 0) + 1;
    }
    for (const match of antiPatterns) {
      summary[match.patternType] = (summary[match.patternType] || 0) + 1;
    }

    return { patterns, antiPatterns, skippedFiles, summary };
  }

  // ─── Anti-pattern Detection (metrics-based) ─────────────────────────────────

  /**
   * Detect anti-patterns for a single node based on its metrics.
   * When a file triggers multiple anti-patterns, they are combined into
   * a single entry with combined evidence.
   */
  private detectAntiPatterns(node: DependencyNode): PatternMatch[] {
    const isGodObject = this.isGodObject(node);
    const isHighCoupling = this.isHighCoupling(node);

    if (isGodObject && isHighCoupling) {
      // Combined: report once with both tags in evidence
      return [{
        fileId: node.id,
        filePath: node.filePath,
        patternType: 'god-object' as AntiPattern,
        confidence: 0.9,
        evidence: `God Object (${node.lineCount} lines, ${node.exportCount} exports) + High Coupling (${node.importCount} imports)`,
      }];
    }

    const results: PatternMatch[] = [];

    if (isGodObject) {
      results.push(this.buildGodObjectMatch(node));
    }

    if (isHighCoupling) {
      results.push(this.buildHighCouplingMatch(node));
    }

    return results;
  }

  /**
   * God Object: file has more than 500 lines AND more than 20 exported members.
   */
  detectGodObject(node: DependencyNode): PatternMatch | null {
    if (this.isGodObject(node)) {
      return this.buildGodObjectMatch(node);
    }
    return null;
  }

  /**
   * High Coupling: file has more than 15 import statements (fan-out > 15).
   */
  detectHighCoupling(node: DependencyNode): PatternMatch | null {
    if (this.isHighCoupling(node)) {
      return this.buildHighCouplingMatch(node);
    }
    return null;
  }

  private isGodObject(node: DependencyNode): boolean {
    return node.lineCount > 500 && node.exportCount > 20;
  }

  private isHighCoupling(node: DependencyNode): boolean {
    return node.importCount > 15;
  }

  private buildGodObjectMatch(node: DependencyNode): PatternMatch {
    return {
      fileId: node.id,
      filePath: node.filePath,
      patternType: 'god-object' as AntiPattern,
      confidence: 0.9,
      evidence: `File has ${node.lineCount} lines and ${node.exportCount} exports (thresholds: >500 lines, >20 exports)`,
    };
  }

  private buildHighCouplingMatch(node: DependencyNode): PatternMatch {
    return {
      fileId: node.id,
      filePath: node.filePath,
      patternType: 'high-coupling' as AntiPattern,
      confidence: 0.85,
      evidence: `File has ${node.importCount} imports (threshold: >15)`,
    };
  }

  // ─── Design Pattern Detection (AST-based with tree-sitter) ─────────────────

  /**
   * Detect patterns using tree-sitter AST.
   */
  private detectPatternsFromAST(tree: TreeSitterTree, node: DependencyNode): PatternMatch[] {
    const results: PatternMatch[] = [];

    const singleton = this.detectSingleton(tree, node);
    if (singleton) results.push(singleton);

    const factory = this.detectFactory(tree, node);
    if (factory) results.push(factory);

    const observer = this.detectObserver(tree, node);
    if (observer) results.push(observer);

    const hooks = this.detectReactHook(tree, node);
    results.push(...hooks);

    return results;
  }

  /**
   * Detect Singleton pattern from AST.
   * Looks for: private constructor + static getInstance() method.
   */
  private detectSingleton(tree: TreeSitterTree, node: DependencyNode): PatternMatch | null {
    const content = this.getNodeText(tree.rootNode);
    return this.detectSingletonFromContent(content, node);
  }

  /**
   * Detect Factory pattern from AST.
   * Looks for: functions with switch/if returning new instances.
   */
  private detectFactory(tree: TreeSitterTree, node: DependencyNode): PatternMatch | null {
    const content = this.getNodeText(tree.rootNode);
    return this.detectFactoryFromContent(content, node);
  }

  /**
   * Detect Observer pattern from AST.
   * Looks for: on/off/emit methods, EventEmitter, addEventListener.
   */
  private detectObserver(tree: TreeSitterTree, node: DependencyNode): PatternMatch | null {
    const content = this.getNodeText(tree.rootNode);
    return this.detectObserverFromContent(content, node);
  }

  /**
   * Detect React Hook patterns from AST.
   * Looks for: exported functions starting with "use" that call built-in hooks.
   */
  private detectReactHook(tree: TreeSitterTree, node: DependencyNode): PatternMatch[] {
    const content = this.getNodeText(tree.rootNode);
    return this.detectReactHookFromContent(content, node);
  }

  private getNodeText(astNode: TreeSitterNode): string {
    return astNode.text;
  }

  // ─── Design Pattern Detection (Regex-based fallback) ───────────────────────

  /**
   * Detect all design patterns using regex-based content analysis.
   */
  private detectPatternsFromRegex(content: string, node: DependencyNode): PatternMatch[] {
    const results: PatternMatch[] = [];

    const singleton = this.detectSingletonFromContent(content, node);
    if (singleton) results.push(singleton);

    const factory = this.detectFactoryFromContent(content, node);
    if (factory) results.push(factory);

    const observer = this.detectObserverFromContent(content, node);
    if (observer) results.push(observer);

    const hooks = this.detectReactHookFromContent(content, node);
    results.push(...hooks);

    return results;
  }

  /**
   * Detect Singleton pattern from file content.
   *
   * Patterns:
   * 1. Private constructor + static getInstance() method
   * 2. Module-level instance variable + exported getInstance function
   */
  private detectSingletonFromContent(content: string, node: DependencyNode): PatternMatch | null {
    const hasPrivateConstructor = PRIVATE_CONSTRUCTOR_RE.test(content);
    const hasGetInstance = GET_INSTANCE_RE.test(content);

    if (hasPrivateConstructor && hasGetInstance) {
      return {
        fileId: node.id,
        filePath: node.filePath,
        patternType: 'singleton' as DesignPattern,
        confidence: 0.9,
        evidence: 'Class with private constructor and static getInstance() method',
      };
    }

    const hasModuleSingleton = MODULE_SINGLETON_RE.test(content);
    const hasExportGetInstance = EXPORT_GET_INSTANCE_RE.test(content);

    if (hasModuleSingleton && hasExportGetInstance) {
      return {
        fileId: node.id,
        filePath: node.filePath,
        patternType: 'singleton' as DesignPattern,
        confidence: 0.75,
        evidence: 'Module-level instance with exported getInstance accessor',
      };
    }

    return null;
  }

  /**
   * Detect Factory pattern from file content.
   *
   * Patterns:
   * 1. Function named *factory* or create* with switch/if returning new instances
   * 2. Switch/if blocks returning new instances of different types (≥2 branches)
   */
  private detectFactoryFromContent(content: string, node: DependencyNode): PatternMatch | null {
    // Check for factory-named function
    const hasFactoryName = FACTORY_FUNCTION_RE.test(content);

    // Check for switch with multiple return new
    const hasSwitchNew = SWITCH_RETURN_NEW_RE.test(content);

    if (hasFactoryName && hasSwitchNew) {
      return {
        fileId: node.id,
        filePath: node.filePath,
        patternType: 'factory' as DesignPattern,
        confidence: 0.9,
        evidence: 'Factory function with switch statement returning different instance types',
      };
    }

    // Check for if/else if with multiple return new (need at least 2 matches)
    if (hasFactoryName) {
      const ifMatches = content.match(IF_RETURN_NEW_RE);
      if (ifMatches && ifMatches.length >= 2) {
        return {
          fileId: node.id,
          filePath: node.filePath,
          patternType: 'factory' as DesignPattern,
          confidence: 0.8,
          evidence: `Factory function with ${ifMatches.length} conditional branches returning new instances`,
        };
      }
    }

    // Even without factory name, a switch returning many new instances suggests factory
    if (hasSwitchNew) {
      return {
        fileId: node.id,
        filePath: node.filePath,
        patternType: 'factory' as DesignPattern,
        confidence: 0.7,
        evidence: 'Switch statement returning multiple different instance types',
      };
    }

    return null;
  }

  /**
   * Detect Observer pattern from file content.
   *
   * Patterns:
   * 1. EventEmitter import/extension
   * 2. Class/object with on/off/emit methods (at least 2 of 3)
   * 3. addEventListener usage combined with event handling methods
   */
  private detectObserverFromContent(content: string, node: DependencyNode): PatternMatch | null {
    // Check for EventEmitter pattern
    if (EVENT_EMITTER_RE.test(content)) {
      return {
        fileId: node.id,
        filePath: node.filePath,
        patternType: 'observer' as DesignPattern,
        confidence: 0.9,
        evidence: 'Uses EventEmitter (extends or imports from events module)',
      };
    }

    // Check for on/off/emit pattern (need at least 3 occurrences)
    const eventMethodMatches = content.match(ON_OFF_EMIT_RE);
    if (eventMethodMatches && eventMethodMatches.length >= 3) {
      return {
        fileId: node.id,
        filePath: node.filePath,
        patternType: 'observer' as DesignPattern,
        confidence: 0.75,
        evidence: `Observer pattern with ${eventMethodMatches.length} event method calls (.on/.off/.emit)`,
      };
    }

    // Check for addEventListener pattern
    if (ADD_EVENT_LISTENER_RE.test(content)) {
      const listenerMatches = content.match(/addEventListener\s*\(/g);
      if (listenerMatches && listenerMatches.length >= 2) {
        return {
          fileId: node.id,
          filePath: node.filePath,
          patternType: 'observer' as DesignPattern,
          confidence: 0.7,
          evidence: `Observer pattern with ${listenerMatches.length} addEventListener calls`,
        };
      }
    }

    return null;
  }

  /**
   * Detect React Hook patterns from file content.
   *
   * Pattern: Exported function starting with "use" that calls built-in React hooks
   * (useState, useEffect, useRef, useMemo, useCallback, etc.)
   */
  private detectReactHookFromContent(content: string, node: DependencyNode): PatternMatch[] {
    const results: PatternMatch[] = [];

    // Check if file contains React hook calls at all
    if (!REACT_HOOK_CALLS_RE.test(content)) {
      return results;
    }

    // Find exported use* functions
    const regex = new RegExp(EXPORT_USE_FUNCTION_RE.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const hookName = match[1];
      results.push({
        fileId: node.id,
        filePath: node.filePath,
        patternType: 'react-hook' as DesignPattern,
        confidence: 0.9,
        evidence: `Custom React hook: ${hookName}`,
      });
    }

    return results;
  }
}
