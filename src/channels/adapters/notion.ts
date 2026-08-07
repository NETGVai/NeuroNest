// ─── Notion Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for Notion using the Notion API.
// Supports creating pages, querying databases, updating page properties,
// and searching content. Inbound commands are received via polling for
// recent page/database changes or via a configured webhook URL.
//
// Parses inbound content as structured commands with action context
// (page ID, database ID). Responses are formatted as action results.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5, REQ 1.6,
// REQ 4.2, REQ 7.1, REQ 7.2

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Notion adapter configuration.
 * Requires an integration token (internal integration or OAuth token).
 * Optionally accepts a webhook URL for receiving real-time events,
 * or a polling interval for periodically checking for changes.
 */
export const NotionConfigSchema = z.object({
  /** Notion integration token (starts with 'ntn_' or 'secret_') */
  integrationToken: z.string().min(1),
  /** Optional webhook URL for receiving Notion events */
  webhookUrl: z.string().url().optional(),
  /** Polling interval in milliseconds for checking changes (default: 30000ms = 30s) */
  pollingIntervalMs: z.number().int().min(5000).default(30000),
  /** Optional database ID to watch for new entries */
  watchDatabaseId: z.string().optional(),
});

export type NotionConfig = z.infer<typeof NotionConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported Notion command actions */
type NotionAction = 'create-page' | 'query-db' | 'update-property' | 'search';

/** Parsed inbound command structure */
interface NotionCommand {
  action: NotionAction;
  pageId?: string | undefined;
  databaseId?: string | undefined;
  query?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  title?: string | undefined;
  content?: string | undefined;
}

// ─── Notion Adapter ─────────────────────────────────────────────

export class NotionAdapter extends BaseChannelAdapter {
  readonly channelId = 'notion';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Notion',
    emoji: '📓',
    description: 'All-in-one workspace',
    actionTags: ['create page', 'query database', 'update page', 'search'],
    sortOrder: 1013,
  };

  readonly configSchema = NotionConfigSchema;

  private config: NotionConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime: string | null = null;

  /** Base URL for the Notion API */
  private readonly NOTION_API_BASE = 'https://api.notion.com/v1';

  /** Notion API version header */
  private readonly NOTION_VERSION = '2022-06-28';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Notion adapter requires an integration token.\n\n' +
        'Setup steps:\n' +
        '1. Go to https://www.notion.so/my-integrations\n' +
        '2. Create a new internal integration\n' +
        '3. Copy the integration token\n' +
        '4. Share the target pages/databases with the integration\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify the token by calling the Notion users/me endpoint
    try {
      const response = await this.notionFetch('/users/me');
      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 401) {
          return this.authFailed('Integration token is invalid or expired.');
        }
        return {
          success: false,
          message: `Notion API error (${response.status}): ${errorBody}`,
          error: { code: 'PROVIDER_ERROR', message: errorBody },
        };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to Notion API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Start polling for changes if a database is being watched
    this.startPolling();

    this.connected = true;
    this.log('info', 'Connected', { channelId: 'notion' });

    return {
      success: true,
      message: 'Notion connected successfully',
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;
    this.config = null;
    this.lastPollTime = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Notion adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      // If it's not a structured command, attempt to create a page with the content
      return this.createPage(message.content, message.to);
    }

    // Execute the parsed command
    try {
      switch (command.action) {
        case 'create-page':
          return this.createPage(
            command.content ?? message.content,
            command.databaseId ?? message.to,
            command.title,
          );

        case 'query-db':
          return this.queryDatabase(command.databaseId ?? message.to, command.query);

        case 'update-property':
          return this.updatePageProperties(
            command.pageId ?? message.to,
            command.properties ?? {},
          );

        case 'search':
          return this.searchContent(command.query ?? message.content);

        default:
          return { success: false, message: `Unknown Notion action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Notion operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Notion API operations ─────────────────────────────

  /**
   * Create a new page in a database or as a child of an existing page.
   */
  private async createPage(
    content: string,
    parentId: string,
    title?: string,
  ): Promise<SendResult> {
    const isDatabase = parentId.length === 32 || parentId.includes('-');

    const body: Record<string, unknown> = {
      parent: isDatabase
        ? { database_id: parentId }
        : { page_id: parentId },
      properties: {
        ...(title
          ? { title: { title: [{ text: { content: title } }] } }
          : { title: { title: [{ text: { content: content.slice(0, 100) } }] } }),
      },
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content } }],
          },
        },
      ],
    };

    const response = await this.notionFetch('/pages', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Create page failed: ${errorBody}` };
    }

    const result = (await response.json()) as { id: string };
    return {
      success: true,
      message: `Page created: ${result.id}`,
    };
  }

  /**
   * Query a Notion database with an optional filter query string.
   */
  private async queryDatabase(
    databaseId: string,
    query?: string,
  ): Promise<SendResult> {
    const body: Record<string, unknown> = {
      page_size: 10,
    };

    // If query is provided, use it as a title filter
    if (query) {
      body['filter'] = {
        property: 'title',
        title: { contains: query },
      };
    }

    const response = await this.notionFetch(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Query database failed: ${errorBody}` };
    }

    const result = (await response.json()) as { results?: Array<{ id: string; properties?: Record<string, any> }> };
    const pages = result.results ?? [];
    const summary = pages.map((p) => {
      const titleProp = Object.values(p.properties ?? {}).find(
        (prop: any) => prop.type === 'title',
      ) as any;
      const title = titleProp?.title?.[0]?.plain_text ?? 'Untitled';
      return `- ${title} (${p.id})`;
    });

    return {
      success: true,
      message: `Found ${pages.length} results:\n${summary.join('\n')}`,
    };
  }

  /**
   * Update properties on a Notion page.
   */
  private async updatePageProperties(
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<SendResult> {
    const body = { properties };

    const response = await this.notionFetch(`/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Update page failed: ${errorBody}` };
    }

    return {
      success: true,
      message: `Page ${pageId} updated successfully`,
    };
  }

  /**
   * Search Notion content by query text.
   */
  private async searchContent(query: string): Promise<SendResult> {
    const body = {
      query,
      page_size: 10,
    };

    const response = await this.notionFetch('/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Search failed: ${errorBody}` };
    }

    const result = (await response.json()) as {
      results?: Array<{
        id: string;
        object: string;
        properties?: Record<string, any>;
      }>;
    };
    const items = result.results ?? [];
    const summary = items.map((item) => {
      const titleProp = Object.values(item.properties ?? {}).find(
        (prop: any) => prop.type === 'title',
      ) as any;
      const title = titleProp?.title?.[0]?.plain_text ?? 'Untitled';
      return `- [${item.object}] ${title} (${item.id})`;
    });

    return {
      success: true,
      message: `Search results for "${query}":\n${summary.join('\n')}`,
    };
  }

  // ─── Private: Polling for database changes ──────────────────────

  /**
   * Start polling for changes in the watched database.
   * Emits inbound messages when new pages are detected.
   */
  private startPolling(): void {
    if (!this.config?.watchDatabaseId) return;

    // Set the initial poll time to now
    this.lastPollTime = new Date().toISOString();

    this.pollTimer = setInterval(() => {
      this.pollForChanges().catch((err) => {
        this.log('error', 'Polling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.pollingIntervalMs);
  }

  /**
   * Stop the polling timer.
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll the watched database for pages created or edited since last check.
   * Emits inbound messages for each new/changed page detected.
   */
  private async pollForChanges(): Promise<void> {
    if (!this.config?.watchDatabaseId || !this.lastPollTime) return;

    const body = {
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { after: this.lastPollTime },
      },
      page_size: 10,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    };

    const response = await this.notionFetch(
      `/databases/${this.config.watchDatabaseId}/query`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      this.log('warn', 'Poll query failed', { status: response.status });
      return;
    }

    const result = (await response.json()) as {
      results?: Array<{
        id: string;
        created_by?: { id: string };
        last_edited_by?: { id: string };
        properties?: Record<string, any>;
      }>;
    };
    const pages = result.results ?? [];

    // Update the poll time for next iteration
    this.lastPollTime = new Date().toISOString();

    // Emit inbound messages for each changed page
    for (const page of pages) {
      const editorId = page.last_edited_by?.id ?? page.created_by?.id ?? 'unknown';
      const titleProp = Object.values(page.properties ?? {}).find(
        (prop: any) => prop.type === 'title',
      ) as any;
      const title = titleProp?.title?.[0]?.plain_text ?? 'Untitled';

      // Emit as structured command content with action context
      const commandContent = JSON.stringify({
        action: 'page-updated',
        pageId: page.id,
        databaseId: this.config.watchDatabaseId,
        title,
      });

      this.emitInbound(editorId, commandContent, 'text');
    }
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured Notion command.
   * Supports both JSON-format commands and natural language patterns:
   * - "create page <title>" or "create page in <dbId>: <content>"
   * - "query db <dbId>" or "query db <dbId> <query>"
   * - "update property <pageId> <properties JSON>"
   * - "search <query>"
   */
  private parseCommand(content: string): NotionCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as NotionCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "create page [in <dbId>:] <title/content>"
    const createMatch = lower.match(
      /^create\s+page(?:\s+in\s+([a-f0-9-]+)\s*:)?\s*(.+)$/i,
    );
    if (createMatch) {
      return {
        action: 'create-page',
        databaseId: createMatch[1] || undefined,
        title: createMatch[2]?.trim(),
        content: content.replace(/^create\s+page(?:\s+in\s+[a-f0-9-]+\s*:)?\s*/i, ''),
      };
    }

    // Pattern: "query db <dbId> [filter]"
    const queryMatch = lower.match(/^query\s+db\s+([a-f0-9-]+)\s*(.*)?$/i);
    if (queryMatch) {
      return {
        action: 'query-db',
        databaseId: queryMatch[1],
        query: queryMatch[2]?.trim() || undefined,
      };
    }

    // Pattern: "update property <pageId> <json>"
    const updateMatch = lower.match(/^update\s+property\s+([a-f0-9-]+)\s+(.+)$/i);
    if (updateMatch) {
      let properties: Record<string, unknown> = {};
      try {
        properties = JSON.parse(updateMatch[2]!);
      } catch {
        // If not valid JSON, wrap it as a generic property
        properties = { Status: { select: { name: updateMatch[2]!.trim() } } };
      }
      return {
        action: 'update-property',
        pageId: updateMatch[1],
        properties,
      };
    }

    // Pattern: "search <query>"
    const searchMatch = lower.match(/^search\s+(.+)$/i);
    if (searchMatch) {
      return {
        action: 'search',
        query: searchMatch[1]?.trim(),
      };
    }

    return null;
  }

  // ─── Private: Notion API fetch helper ───────────────────────────

  /**
   * Make an authenticated request to the Notion API.
   * Uses Bearer token auth with the integration token.
   */
  private async notionFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error('Notion adapter is not configured');
    }

    const url = `${this.NOTION_API_BASE}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.integrationToken}`,
      'Notion-Version': this.NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }
}
