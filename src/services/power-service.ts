/**
 * PowerService — On-demand specialized context loaded by keyword activation.
 *
 * Powers are installable packages that provide domain-specific documentation,
 * MCP server tool definitions, and workflow guides. They are keyword-activated:
 * when a user's message contains keywords matching an installed power's domain,
 * that power is activated and its context is loaded into the system prompt.
 *
 * Only activated powers contribute to the prompt context — non-activated powers
 * contribute zero tokens, keeping context focused and within limits.
 *
 * Power packages are stored in `.neuronest/powers/` as directories containing:
 * - `power.json` — metadata (name, description, keywords, MCP server config)
 * - `docs/` — domain-specific documentation (Markdown files)
 * - `guides/` — workflow/steering guides (Markdown files)
 *
 * Feature-gated via `production_ux_powers` — all methods return empty/no-op
 * when the flag is disabled.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Interfaces ─────────────────────────────────────────────────

/** MCP server tool definition within a power package */
export interface PowerMCPTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP server configuration for a power */
export interface PowerMCPServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tools: PowerMCPTool[];
}

/** Workflow guide bundled with a power */
export interface PowerGuide {
  name: string;
  filePath: string;
  content: string;
}

/** Definition of an installable power package */
export interface PowerDefinition {
  /** Unique name identifier for the power */
  name: string;
  /** Human-readable description */
  description: string;
  /** Keywords that trigger activation when found in user messages */
  keywords: string[];
  /** Optional MCP server tools provided by this power */
  mcpServers?: PowerMCPServer[];
  /** Optional workflow/steering guides */
  guides?: PowerGuide[];
  /** Domain-specific documentation content */
  documentation?: string;
  /** Filesystem path to the power's root directory */
  rootPath: string;
}

/** Result of keyword-based activation scan */
export interface PowerActivationResult {
  /** Powers that were activated by the message */
  activated: PowerDefinition[];
  /** Combined context string for injection into system prompt */
  context: string;
}

// ─── Internal Types ─────────────────────────────────────────────

/** Raw power.json manifest structure */
interface PowerManifest {
  name: string;
  description: string;
  keywords: string[];
  mcpServers?: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    tools: Array<{
      name: string;
      description: string;
      inputSchema?: Record<string, unknown>;
    }>;
  }>;
}

// ─── Constants ──────────────────────────────────────────────────

const POWERS_DIR = '.neuronest/powers';

// ─── PowerService Implementation ────────────────────────────────

export class PowerService {
  private readonly featureGate: FeatureGateSystem;
  private readonly projectDir: string;
  private installedPowers: PowerDefinition[] = [];

  constructor(projectDir: string, featureGate: FeatureGateSystem) {
    this.projectDir = projectDir;
    this.featureGate = featureGate;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Load all installed power packages from `.neuronest/powers/` directory.
   *
   * Reads each subdirectory for a `power.json` manifest, then loads associated
   * documentation and guides. Invalid or malformed packages are skipped.
   *
   * Returns an empty array when the feature gate is disabled or the
   * powers directory does not exist.
   *
   * Requirement 19.1: Support installable power packages.
   */
  loadInstalled(): PowerDefinition[] {
    if (!this.isEnabled()) return [];

    const powersDir = path.join(this.projectDir, POWERS_DIR);

    if (!fs.existsSync(powersDir)) {
      this.installedPowers = [];
      return [];
    }

    const entries = fs.readdirSync(powersDir, { withFileTypes: true });
    const loaded: PowerDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      try {
        const powerDir = path.join(powersDir, entry.name);
        const definition = this.loadPowerFromDirectory(powerDir);
        if (definition) {
          loaded.push(definition);
        }
      } catch {
        // Skip malformed power packages — don't break the entire system
      }
    }

    this.installedPowers = loaded;
    return [...loaded];
  }

  /**
   * Get all currently loaded installed powers.
   */
  getInstalled(): PowerDefinition[] {
    return [...this.installedPowers];
  }

  /**
   * Scan a user message for keyword matches and activate matching powers.
   *
   * A power is activated if at least one of its keywords appears in the
   * user message (case-insensitive word boundary matching). Only activated
   * powers have their context loaded into the prompt.
   *
   * Returns the activation result with the combined context string and
   * the list of activated powers.
   *
   * Requirements: 19.2, 19.4
   */
  activateByMessage(userMessage: string): PowerActivationResult {
    if (!this.isEnabled()) {
      return { activated: [], context: '' };
    }

    const activated: PowerDefinition[] = [];

    for (const power of this.installedPowers) {
      if (this.matchesKeywords(power.keywords, userMessage)) {
        activated.push(power);
      }
    }

    const context = this.buildContext(activated);
    return { activated, context };
  }

  /**
   * Manually activate a specific power by name.
   *
   * Returns the power's context string, or empty string if the power
   * is not found or the feature gate is disabled.
   */
  activateByName(powerName: string): string {
    if (!this.isEnabled()) return '';

    const power = this.installedPowers.find((p) => p.name === powerName);
    if (!power) return '';

    return this.buildContext([power]);
  }

  /**
   * Get the context string for a set of activated powers.
   *
   * This is the string that gets injected into the SystemPromptBuilder's
   * `powerContext` field. Non-activated powers contribute zero tokens.
   *
   * Requirement 19.4: Only load activated powers into context.
   */
  buildContext(powers: PowerDefinition[]): string {
    if (powers.length === 0) return '';

    const sections: string[] = [];

    for (const power of powers) {
      const parts: string[] = [];

      // Power header
      parts.push(`### ${power.name}\n${power.description}`);

      // Documentation
      if (power.documentation) {
        parts.push(`#### Documentation\n${power.documentation}`);
      }

      // MCP tools
      if (power.mcpServers && power.mcpServers.length > 0) {
        const toolLines: string[] = [];
        for (const server of power.mcpServers) {
          for (const tool of server.tools) {
            toolLines.push(`- **${tool.name}**: ${tool.description}`);
          }
        }
        if (toolLines.length > 0) {
          parts.push(`#### Available Tools\n${toolLines.join('\n')}`);
        }
      }

      // Guides
      if (power.guides && power.guides.length > 0) {
        const guideContent = power.guides
          .map((g) => `#### ${g.name}\n${g.content}`)
          .join('\n\n');
        parts.push(guideContent);
      }

      sections.push(parts.join('\n\n'));
    }

    return sections.join('\n\n---\n\n');
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Check if the feature gate is enabled.
   */
  private isEnabled(): boolean {
    return this.featureGate.isEnabled('production_ux_powers');
  }

  /**
   * Load a power definition from a directory containing a `power.json` manifest.
   *
   * Returns null if the manifest is invalid or missing.
   */
  private loadPowerFromDirectory(powerDir: string): PowerDefinition | null {
    const manifestPath = path.join(powerDir, 'power.json');

    if (!fs.existsSync(manifestPath)) return null;

    const rawContent = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(rawContent) as unknown;

    if (!this.isValidManifest(manifest)) return null;

    const validManifest = manifest as PowerManifest;

    // Load documentation from docs/ directory
    const documentation = this.loadDocumentation(powerDir);

    // Load guides from guides/ directory
    const guides = this.loadGuides(powerDir);

    // Map MCP servers
    const mcpServers: PowerMCPServer[] | undefined = validManifest.mcpServers?.map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      tools: server.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));

    return {
      name: validManifest.name,
      description: validManifest.description,
      keywords: validManifest.keywords,
      mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : undefined,
      guides: guides.length > 0 ? guides : undefined,
      documentation: documentation || undefined,
      rootPath: powerDir,
    };
  }

  /**
   * Validate a raw JSON object as a valid power manifest.
   */
  private isValidManifest(raw: unknown): raw is PowerManifest {
    if (!raw || typeof raw !== 'object') return false;

    const obj = raw as Record<string, unknown>;

    if (typeof obj.name !== 'string' || obj.name.trim().length === 0) return false;
    if (typeof obj.description !== 'string') return false;
    if (!Array.isArray(obj.keywords) || obj.keywords.length === 0) return false;

    // All keywords must be non-empty strings
    if (!obj.keywords.every((k: unknown) => typeof k === 'string' && k.trim().length > 0)) {
      return false;
    }

    // Validate MCP servers if present
    if (obj.mcpServers !== undefined) {
      if (!Array.isArray(obj.mcpServers)) return false;

      for (const server of obj.mcpServers) {
        if (!server || typeof server !== 'object') return false;
        if (typeof (server as Record<string, unknown>).name !== 'string') return false;
        if (typeof (server as Record<string, unknown>).command !== 'string') return false;
        if (!Array.isArray((server as Record<string, unknown>).tools)) return false;
      }
    }

    return true;
  }

  /**
   * Load documentation from the `docs/` subdirectory of a power.
   *
   * Reads all `.md` files and concatenates their content.
   * Returns null if no documentation exists.
   */
  private loadDocumentation(powerDir: string): string | null {
    const docsDir = path.join(powerDir, 'docs');

    if (!fs.existsSync(docsDir)) return null;

    const files = fs.readdirSync(docsDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    if (files.length === 0) return null;

    const contents: string[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(docsDir, file), 'utf-8');
        contents.push(content);
      } catch {
        // Skip unreadable files
      }
    }

    return contents.length > 0 ? contents.join('\n\n') : null;
  }

  /**
   * Load workflow guides from the `guides/` subdirectory of a power.
   *
   * Returns an array of PowerGuide objects with name and content.
   */
  private loadGuides(powerDir: string): PowerGuide[] {
    const guidesDir = path.join(powerDir, 'guides');

    if (!fs.existsSync(guidesDir)) return [];

    const files = fs.readdirSync(guidesDir)
      .filter((f) => f.endsWith('.md'))
      .sort();

    const guides: PowerGuide[] = [];
    for (const file of files) {
      try {
        const filePath = path.join(guidesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const name = path.basename(file, '.md');
        guides.push({ name, filePath, content });
      } catch {
        // Skip unreadable files
      }
    }

    return guides;
  }

  /**
   * Check if any of the power's keywords match within the user message.
   *
   * Uses case-insensitive boundary matching to avoid false positives
   * from partial matches (e.g., "react" should not match "reactive" unless
   * "reactive" is also a keyword).
   *
   * For keywords containing only word characters (\w), uses \b word boundaries.
   * For keywords containing non-word characters (like "c++"), uses lookahead/behind
   * for whitespace or string boundaries to ensure the keyword appears as a standalone term.
   *
   * Requirement 19.2: Keyword-based activation.
   */
  private matchesKeywords(keywords: string[], userMessage: string): boolean {
    if (keywords.length === 0 || userMessage.trim().length === 0) return false;

    const messageLower = userMessage.toLowerCase();

    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase().trim();
      if (keywordLower.length === 0) continue;

      const escaped = keywordLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Determine if the keyword contains only word characters
      const isWordOnly = /^\w+$/.test(keywordLower);

      let regex: RegExp;
      if (isWordOnly) {
        // Standard word boundary matching for normal keywords
        regex = new RegExp(`\\b${escaped}\\b`, 'i');
      } else {
        // For keywords with special chars (e.g., "c++"), use boundary assertions
        // that match start/end of string or whitespace
        regex = new RegExp(`(?:^|\\s|(?<=\\b))${escaped}(?:$|\\s|(?=\\b))`, 'i');
      }

      if (regex.test(messageLower)) {
        return true;
      }
    }

    return false;
  }
}
