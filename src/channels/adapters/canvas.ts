// ─── Canvas Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for visual workspace/canvas
// operations. Supports creating workspaces, adding elements (shapes,
// text, images, connectors), and exporting canvas content.
// Bidirectional: accepts structured canvas commands inbound and
// returns workspace state/export data outbound.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.15

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Canvas adapter configuration.
 *
 * - defaultWidth: default canvas width in pixels (default: 1920)
 * - defaultHeight: default canvas height in pixels (default: 1080)
 * - maxElements: maximum number of elements per workspace (default: 500)
 * - exportFormat: default export format (default: 'svg')
 */
export const CanvasConfigSchema = z.object({
  /** Default canvas width in pixels */
  defaultWidth: z.number().int().positive().optional().default(1920),
  /** Default canvas height in pixels */
  defaultHeight: z.number().int().positive().optional().default(1080),
  /** Maximum number of elements per workspace */
  maxElements: z.number().int().positive().optional().default(500),
  /** Default export format */
  exportFormat: z.enum(['svg', 'png', 'json']).optional().default('svg'),
});

export type CanvasConfig = z.infer<typeof CanvasConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported canvas command actions (REQ 10.15) */
type CanvasAction = 'create-workspace' | 'add-element' | 'export' | 'list-elements' | 'remove-element' | 'clear';

/** Canvas element types */
type ElementType = 'rectangle' | 'circle' | 'text' | 'image' | 'line' | 'connector' | 'group';

/** A single canvas element */
interface CanvasElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  text?: string;
  src?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  fontSize?: number;
  /** For connectors: source element ID */
  fromId?: string;
  /** For connectors: target element ID */
  toId?: string;
  /** Layer z-index */
  zIndex?: number;
}

/** A canvas workspace */
interface CanvasWorkspace {
  id: string;
  name: string;
  width: number;
  height: number;
  elements: CanvasElement[];
  createdAt: number;
  updatedAt: number;
}

/** Parsed canvas command structure */
interface CanvasCommand {
  action: CanvasAction;
  /** Workspace ID (for operations on existing workspace) */
  workspaceId?: string;
  /** Workspace name (for create-workspace) */
  name?: string;
  /** Canvas dimensions (for create-workspace) */
  width?: number;
  height?: number;
  /** Element to add */
  element?: Partial<CanvasElement>;
  /** Element ID (for remove-element) */
  elementId?: string;
  /** Export format override */
  format?: 'svg' | 'png' | 'json';
}

// ─── Canvas Adapter ─────────────────────────────────────────────

export class CanvasAdapter extends BaseChannelAdapter {
  readonly channelId = 'canvas';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Canvas',
    emoji: '🎨',
    description: 'Visual workspace for creating diagrams, sketches, and visual content',
    actionTags: ['create workspace', 'add elements', 'export'],
    sortOrder: 1150,
  };

  readonly configSchema = CanvasConfigSchema;

  private config: CanvasConfig | null = null;
  private workspaces = new Map<string, CanvasWorkspace>();
  private nextElementId = 1;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Canvas adapter configuration is invalid.\n\n' +
        'Configuration options:\n' +
        '  - defaultWidth (optional, default: 1920): Default canvas width in pixels\n' +
        '  - defaultHeight (optional, default: 1080): Default canvas height in pixels\n' +
        '  - maxElements (optional, default: 500): Maximum elements per workspace\n' +
        '  - exportFormat (optional, default: "svg"): Default export format (svg, png, json)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;
    this.connected = true;
    this.log('info', 'Canvas adapter connected', {
      defaultWidth: this.config.defaultWidth,
      defaultHeight: this.config.defaultHeight,
      maxElements: this.config.maxElements,
      exportFormat: this.config.exportFormat,
    });

    return {
      success: true,
      message: `Canvas adapter connected (default: ${this.config.defaultWidth}x${this.config.defaultHeight}, format: ${this.config.exportFormat})`,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
    this.workspaces.clear();
    this.nextElementId = 1;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Canvas adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message:
          'Could not parse canvas command. Supported actions: create-workspace, add-element, export, list-elements, remove-element, clear',
      };
    }

    // Execute the parsed command (REQ 10.15)
    try {
      switch (command.action) {
        case 'create-workspace':
          return this.createWorkspace(command);

        case 'add-element':
          return this.addElement(command);

        case 'export':
          return this.exportWorkspace(command);

        case 'list-elements':
          return this.listElements(command);

        case 'remove-element':
          return this.removeElement(command);

        case 'clear':
          return this.clearWorkspace(command);

        default:
          return { success: false, message: `Unknown canvas action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Canvas command failed', { action: command.action, error: errMsg });
      return { success: false, message: `Canvas operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Operations (REQ 10.15) ──────────────────────────

  /**
   * Create a new visual workspace with the given name and dimensions.
   */
  private createWorkspace(command: CanvasCommand): SendResult {
    const id = `workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = command.name ?? 'Untitled Workspace';
    const width = command.width ?? this.config!.defaultWidth;
    const height = command.height ?? this.config!.defaultHeight;

    const workspace: CanvasWorkspace = {
      id,
      name,
      width,
      height,
      elements: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.workspaces.set(id, workspace);

    this.log('info', 'Created canvas workspace', { id, name, width, height });

    // Emit inbound so the AI pipeline can inform the user
    this.emitInbound('canvas-system', JSON.stringify({
      event: 'workspace-created',
      workspaceId: id,
      name,
      width,
      height,
    }), 'text');

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'create-workspace',
          workspaceId: id,
          name,
          width,
          height,
          elements: 0,
        },
        null,
        2,
      ),
    };
  }

  /**
   * Add an element to a workspace. If no workspace ID is specified,
   * uses the most recently created workspace.
   */
  private addElement(command: CanvasCommand): SendResult {
    const workspace = this.resolveWorkspace(command.workspaceId);
    if (!workspace) {
      return {
        success: false,
        message: command.workspaceId
          ? `Workspace "${command.workspaceId}" not found`
          : 'No workspace exists. Create one first with "create-workspace".',
      };
    }

    // Check element limit
    if (workspace.elements.length >= this.config!.maxElements) {
      return {
        success: false,
        message: `Workspace "${workspace.name}" has reached the maximum of ${this.config!.maxElements} elements.`,
      };
    }

    // Build element from command
    const elementId = `el-${this.nextElementId++}`;
    const element: CanvasElement = {
      id: elementId,
      type: (command.element?.type as ElementType) ?? 'rectangle',
      x: command.element?.x ?? 0,
      y: command.element?.y ?? 0,
      width: command.element?.width,
      height: command.element?.height,
      radius: command.element?.radius,
      text: command.element?.text,
      src: command.element?.src,
      fill: command.element?.fill ?? '#ffffff',
      stroke: command.element?.stroke ?? '#000000',
      strokeWidth: command.element?.strokeWidth ?? 1,
      fontSize: command.element?.fontSize,
      fromId: command.element?.fromId,
      toId: command.element?.toId,
      zIndex: command.element?.zIndex ?? workspace.elements.length,
    };

    workspace.elements.push(element);
    workspace.updatedAt = Date.now();

    this.log('info', 'Added canvas element', { workspaceId: workspace.id, elementId, type: element.type });

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'add-element',
          workspaceId: workspace.id,
          element,
          totalElements: workspace.elements.length,
        },
        null,
        2,
      ),
    };
  }

  /**
   * Export the workspace content in the specified format.
   * Supports SVG, JSON, and PNG (as base64 placeholder).
   */
  private exportWorkspace(command: CanvasCommand): SendResult {
    const workspace = this.resolveWorkspace(command.workspaceId);
    if (!workspace) {
      return {
        success: false,
        message: command.workspaceId
          ? `Workspace "${command.workspaceId}" not found`
          : 'No workspace exists. Create one first with "create-workspace".',
      };
    }

    const format = command.format ?? this.config!.exportFormat;

    switch (format) {
      case 'json':
        return {
          success: true,
          message: JSON.stringify(
            {
              action: 'export',
              format: 'json',
              workspaceId: workspace.id,
              name: workspace.name,
              data: workspace,
            },
            null,
            2,
          ),
        };

      case 'svg':
        return {
          success: true,
          message: JSON.stringify(
            {
              action: 'export',
              format: 'svg',
              workspaceId: workspace.id,
              name: workspace.name,
              data: this.renderSvg(workspace),
              mimeType: 'image/svg+xml',
            },
            null,
            2,
          ),
        };

      case 'png':
        // PNG export would require a rendering engine — return SVG with metadata
        return {
          success: true,
          message: JSON.stringify(
            {
              action: 'export',
              format: 'png',
              workspaceId: workspace.id,
              name: workspace.name,
              note: 'PNG export requires a rendering engine. SVG fallback provided.',
              data: this.renderSvg(workspace),
              mimeType: 'image/svg+xml',
            },
            null,
            2,
          ),
        };

      default:
        return { success: false, message: `Unsupported export format: ${format}` };
    }
  }

  /**
   * List all elements in a workspace.
   */
  private listElements(command: CanvasCommand): SendResult {
    const workspace = this.resolveWorkspace(command.workspaceId);
    if (!workspace) {
      return {
        success: false,
        message: command.workspaceId
          ? `Workspace "${command.workspaceId}" not found`
          : 'No workspace exists. Create one first with "create-workspace".',
      };
    }

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'list-elements',
          workspaceId: workspace.id,
          name: workspace.name,
          count: workspace.elements.length,
          elements: workspace.elements.map((el) => ({
            id: el.id,
            type: el.type,
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            text: el.text,
          })),
        },
        null,
        2,
      ),
    };
  }

  /**
   * Remove an element from a workspace by element ID.
   */
  private removeElement(command: CanvasCommand): SendResult {
    const workspace = this.resolveWorkspace(command.workspaceId);
    if (!workspace) {
      return {
        success: false,
        message: command.workspaceId
          ? `Workspace "${command.workspaceId}" not found`
          : 'No workspace exists. Create one first with "create-workspace".',
      };
    }

    if (!command.elementId) {
      return { success: false, message: 'Element ID is required for remove-element action.' };
    }

    const idx = workspace.elements.findIndex((el) => el.id === command.elementId);
    if (idx === -1) {
      return {
        success: false,
        message: `Element "${command.elementId}" not found in workspace "${workspace.name}".`,
      };
    }

    const removed = workspace.elements.splice(idx, 1)[0];
    workspace.updatedAt = Date.now();

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'remove-element',
          workspaceId: workspace.id,
          removedElement: removed,
          remainingElements: workspace.elements.length,
        },
        null,
        2,
      ),
    };
  }

  /**
   * Clear all elements from a workspace.
   */
  private clearWorkspace(command: CanvasCommand): SendResult {
    const workspace = this.resolveWorkspace(command.workspaceId);
    if (!workspace) {
      return {
        success: false,
        message: command.workspaceId
          ? `Workspace "${command.workspaceId}" not found`
          : 'No workspace exists. Create one first with "create-workspace".',
      };
    }

    const removed = workspace.elements.length;
    workspace.elements = [];
    workspace.updatedAt = Date.now();

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'clear',
          workspaceId: workspace.id,
          name: workspace.name,
          removedCount: removed,
        },
        null,
        2,
      ),
    };
  }

  // ─── Private: SVG Rendering ───────────────────────────────────

  /**
   * Render a workspace to SVG string. Converts each element into
   * the appropriate SVG primitive.
   */
  private renderSvg(workspace: CanvasWorkspace): string {
    const elements = workspace.elements
      .slice()
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${workspace.width}" height="${workspace.height}" viewBox="0 0 ${workspace.width} ${workspace.height}">\n`;
    svg += `  <rect width="100%" height="100%" fill="#f8f9fa" />\n`;

    for (const el of elements) {
      switch (el.type) {
        case 'rectangle':
          svg += `  <rect x="${el.x}" y="${el.y}" width="${el.width ?? 100}" height="${el.height ?? 60}" fill="${el.fill ?? '#ffffff'}" stroke="${el.stroke ?? '#000000'}" stroke-width="${el.strokeWidth ?? 1}" />\n`;
          break;

        case 'circle':
          svg += `  <circle cx="${el.x + (el.radius ?? 30)}" cy="${el.y + (el.radius ?? 30)}" r="${el.radius ?? 30}" fill="${el.fill ?? '#ffffff'}" stroke="${el.stroke ?? '#000000'}" stroke-width="${el.strokeWidth ?? 1}" />\n`;
          break;

        case 'text':
          svg += `  <text x="${el.x}" y="${el.y}" font-size="${el.fontSize ?? 16}" fill="${el.fill ?? '#000000'}">${this.escapeXml(el.text ?? '')}</text>\n`;
          break;

        case 'image':
          svg += `  <image x="${el.x}" y="${el.y}" width="${el.width ?? 100}" height="${el.height ?? 100}" href="${this.escapeXml(el.src ?? '')}" />\n`;
          break;

        case 'line':
          svg += `  <line x1="${el.x}" y1="${el.y}" x2="${(el.x) + (el.width ?? 100)}" y2="${(el.y) + (el.height ?? 0)}" stroke="${el.stroke ?? '#000000'}" stroke-width="${el.strokeWidth ?? 1}" />\n`;
          break;

        case 'connector': {
          const fromEl = workspace.elements.find((e) => e.id === el.fromId);
          const toEl = workspace.elements.find((e) => e.id === el.toId);
          if (fromEl && toEl) {
            const x1 = fromEl.x + (fromEl.width ?? 100) / 2;
            const y1 = fromEl.y + (fromEl.height ?? 60) / 2;
            const x2 = toEl.x + (toEl.width ?? 100) / 2;
            const y2 = toEl.y + (toEl.height ?? 60) / 2;
            svg += `  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${el.stroke ?? '#666666'}" stroke-width="${el.strokeWidth ?? 2}" marker-end="url(#arrowhead)" />\n`;
          }
          break;
        }

        case 'group':
          svg += `  <g transform="translate(${el.x},${el.y})"><rect width="${el.width ?? 200}" height="${el.height ?? 150}" fill="none" stroke="${el.stroke ?? '#cccccc'}" stroke-width="1" stroke-dasharray="4" /></g>\n`;
          break;
      }
    }

    svg += '</svg>';
    return svg;
  }

  // ─── Private: Command parsing ─────────────────────────────────

  /**
   * Parse message content into a structured canvas command.
   * Supports JSON-format commands and natural language patterns:
   * - "create workspace <name>" / "new canvas <name>"
   * - "add <type> at <x>,<y>" / "add element <type>"
   * - "export" / "export svg" / "export json"
   * - "list elements"
   * - "remove <elementId>"
   * - "clear" / "clear canvas"
   */
  private parseCommand(content: string): CanvasCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as CanvasCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const trimmed = content.trim();
    const lower = trimmed.toLowerCase();

    // Pattern: "create workspace <name>" / "new canvas <name>" / "create canvas"
    const createMatch = trimmed.match(
      /^(?:create\s+(?:workspace|canvas)|new\s+(?:workspace|canvas))(?:\s+(.+))?$/i,
    );
    if (createMatch) {
      return {
        action: 'create-workspace',
        name: createMatch[1]?.trim() || undefined,
      };
    }

    // Pattern: "add <type> [at <x>,<y>] [<width>x<height>]"
    const addMatch = trimmed.match(
      /^add\s+(?:element\s+)?(\w+)(?:\s+at\s+(\d+)\s*,\s*(\d+))?(?:\s+(\d+)\s*x\s*(\d+))?(?:\s+(.+))?$/i,
    );
    if (addMatch) {
      const type = addMatch[1]!.toLowerCase() as ElementType;
      return {
        action: 'add-element',
        element: {
          type,
          x: addMatch[2] ? parseInt(addMatch[2], 10) : 0,
          y: addMatch[3] ? parseInt(addMatch[3], 10) : 0,
          width: addMatch[4] ? parseInt(addMatch[4], 10) : undefined,
          height: addMatch[5] ? parseInt(addMatch[5], 10) : undefined,
          text: addMatch[6]?.trim() || undefined,
        },
      };
    }

    // Pattern: "export [format]" / "export canvas [as format]"
    const exportMatch = lower.match(
      /^export(?:\s+(?:canvas|workspace))?(?:\s+(?:as\s+)?(\w+))?$/i,
    );
    if (exportMatch) {
      const format = exportMatch[1] as 'svg' | 'png' | 'json' | undefined;
      return {
        action: 'export',
        format: format && ['svg', 'png', 'json'].includes(format) ? format : undefined,
      };
    }

    // Pattern: "list elements" / "show elements"
    if (/^(?:list|show)\s+elements?$/i.test(lower)) {
      return { action: 'list-elements' };
    }

    // Pattern: "remove <elementId>" / "delete <elementId>"
    const removeMatch = trimmed.match(/^(?:remove|delete)\s+(?:element\s+)?(.+)$/i);
    if (removeMatch) {
      return {
        action: 'remove-element',
        elementId: removeMatch[1]!.trim(),
      };
    }

    // Pattern: "clear" / "clear canvas" / "clear workspace"
    if (/^clear(?:\s+(?:canvas|workspace|all))?$/i.test(lower)) {
      return { action: 'clear' };
    }

    return null;
  }

  // ─── Private: Helpers ─────────────────────────────────────────

  /**
   * Resolve a workspace by ID, or return the most recently created one.
   */
  private resolveWorkspace(workspaceId?: string): CanvasWorkspace | null {
    if (workspaceId) {
      return this.workspaces.get(workspaceId) ?? null;
    }

    // Return the most recently created workspace
    let latest: CanvasWorkspace | null = null;
    for (const ws of this.workspaces.values()) {
      if (!latest || ws.createdAt > latest.createdAt) {
        latest = ws;
      }
    }
    return latest;
  }

  /**
   * Escape special XML characters for safe SVG output.
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
