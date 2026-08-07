// ─── Trello Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for Trello via its REST API.
// Supports creating cards, moving cards between lists, listing boards,
// and adding comments. Polls for webhook-registered changes to emit
// inbound messages when board activity occurs.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.2, REQ 7.5

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema ──────────────────────────────────────────────

/**
 * Zod schema for Trello adapter configuration.
 * Requires an API key and token for REST API authentication.
 */
export const TrelloConfigSchema = z.object({
  /** Trello API key from https://trello.com/app-key */
  apiKey: z.string().min(1),
  /** Trello API token generated via the authorize endpoint */
  token: z.string().min(1),
  /** Optional polling interval in milliseconds (default: 30000 = 30s) */
  pollingIntervalMs: z.number().int().min(5000).default(30000),
  /** Optional board IDs to monitor for changes; if empty, monitors all accessible boards */
  watchBoardIds: z.array(z.string()).default([]),
});

/** Inferred config type from TrelloConfigSchema. */
export type TrelloConfig = z.infer<typeof TrelloConfigSchema>;

// ─── Trello API Types ───────────────────────────────────────────

interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  closed: boolean;
}

interface TrelloList {
  id: string;
  name: string;
  idBoard: string;
  closed: boolean;
}

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idBoard: string;
  url: string;
  closed: boolean;
}

interface TrelloAction {
  id: string;
  type: string;
  date: string;
  memberCreator?: { fullName?: string; username?: string };
  data?: {
    text?: string;
    card?: { id: string; name: string };
    board?: { id: string; name: string };
    list?: { id: string; name: string };
    listBefore?: { id: string; name: string };
    listAfter?: { id: string; name: string };
  };
}

// ─── Command Parsing ────────────────────────────────────────────

interface TrelloCommand {
  action: 'create-card' | 'move-card' | 'list-boards' | 'add-comment' | 'list-cards' | 'list-lists';
  params: Record<string, string>;
}

// ─── Trello Adapter ─────────────────────────────────────────────

export class TrelloAdapter extends BaseChannelAdapter {
  readonly channelId = 'trello';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Trello',
    emoji: '📌',
    description: 'Kanban boards',
    actionTags: ['create card', 'move card', 'list boards', 'add comment'],
    sortOrder: 1016,
  };

  readonly configSchema = TrelloConfigSchema;

  /** Validated config stored after connect. */
  private config: TrelloConfig | null = null;

  /** Polling timer reference. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Tracks the last action IDs per board for deduplication. */
  private lastActionIds = new Map<string, string>();

  /** Base URL for the Trello REST API. */
  private readonly baseUrl = 'https://api.trello.com/1';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Trello adapter requires an API key and token.\n\n' +
        'Config format: { apiKey: "...", token: "...", pollingIntervalMs?: 30000, watchBoardIds?: [] }\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify credentials by fetching the member's profile
    try {
      const member = await this.apiGet('/members/me');
      if (!member || !member.id) {
        return this.authFailed('Invalid API key or token — could not retrieve member profile');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('401') || errMsg.includes('unauthorized') || errMsg.includes('Unauthorized')) {
        return this.authFailed(`Invalid API key or token: ${errMsg}`);
      }
      return {
        success: false,
        message: `Failed to connect to Trello API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Start polling for board activity
    this.startPolling();

    this.connected = true;
    this.log('info', 'Connected', { channelId: 'trello' });

    return {
      success: true,
      message: 'Trello adapter connected successfully',
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.lastActionIds.clear();
    this.config = null;
    this.connected = false;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Trello adapter is not connected' };
    }

    // Parse the outbound message as a structured command
    const command = this.parseCommand(message.content);
    if (!command) {
      // If not a recognized command, treat as a comment on a card (if `to` is a card ID)
      if (message.to && message.to.length > 0) {
        return this.addComment(message.to, message.content);
      }
      return { success: false, message: 'Could not parse Trello command from message content' };
    }

    try {
      const result = await this.executeCommand(command, message.to);
      return { success: true, message: result };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Command execution failed', { error: errMsg, command: command.action });
      return { success: false, message: `Trello command failed: ${errMsg}` };
    }
  }

  // ─── Private: API Helpers ─────────────────────────────────────

  /**
   * Make a GET request to the Trello API with auth params.
   */
  private async apiGet(path: string, params?: Record<string, string>): Promise<any> {
    if (!this.config) throw new Error('Not configured');

    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('key', this.config.apiKey);
    url.searchParams.set('token', this.config.token);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Make a POST request to the Trello API with auth params.
   */
  private async apiPost(path: string, body?: Record<string, string>): Promise<any> {
    if (!this.config) throw new Error('Not configured');

    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('key', this.config.apiKey);
    url.searchParams.set('token', this.config.token);

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), init);

    if (!response.ok) {
      throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Make a PUT request to the Trello API with auth params.
   */
  private async apiPut(path: string, body?: Record<string, string>): Promise<any> {
    if (!this.config) throw new Error('Not configured');

    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('key', this.config.apiKey);
    url.searchParams.set('token', this.config.token);

    const init: RequestInit = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), init);

    if (!response.ok) {
      throw new Error(`Trello API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  // ─── Private: Command Parsing ─────────────────────────────────

  /**
   * Parse an outbound message content string into a structured Trello command.
   * Supports natural-language-like and structured formats:
   *
   * - "create-card: <name> | list: <listId> | desc: <description>"
   * - "move-card: <cardId> | to: <listId>"
   * - "list-boards"
   * - "list-lists: <boardId>"
   * - "list-cards: <listId>"
   * - "add-comment: <text> | card: <cardId>"
   */
  private parseCommand(content: string): TrelloCommand | null {
    const trimmed = content.trim().toLowerCase();

    // list-boards (no params)
    if (trimmed === 'list-boards' || trimmed === 'list boards') {
      return { action: 'list-boards', params: {} };
    }

    // Parse pipe-delimited key: value pairs
    const parts = content.split('|').map((p) => p.trim());
    if (parts.length === 0) return null;

    const first = parts[0]!;
    const params: Record<string, string> = {};

    // Extract action from first segment
    const colonIdx = first.indexOf(':');
    if (colonIdx === -1) {
      // Check for simple action words
      if (trimmed.startsWith('list-lists') || trimmed.startsWith('list lists')) {
        const rest = content.replace(/^list[- ]lists:?\s*/i, '').trim();
        if (rest) params['boardId'] = rest;
        return { action: 'list-lists', params };
      }
      if (trimmed.startsWith('list-cards') || trimmed.startsWith('list cards')) {
        const rest = content.replace(/^list[- ]cards:?\s*/i, '').trim();
        if (rest) params['listId'] = rest;
        return { action: 'list-cards', params };
      }
      return null;
    }

    const actionStr = first.slice(0, colonIdx).trim().toLowerCase();
    const actionValue = first.slice(colonIdx + 1).trim();

    // Parse remaining params
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]!;
      const partColonIdx = part.indexOf(':');
      if (partColonIdx !== -1) {
        const key = part.slice(0, partColonIdx).trim().toLowerCase();
        const value = part.slice(partColonIdx + 1).trim();
        params[key] = value;
      }
    }

    switch (actionStr) {
      case 'create-card':
      case 'create card':
        params['name'] = actionValue;
        return { action: 'create-card', params };

      case 'move-card':
      case 'move card':
        params['cardId'] = actionValue;
        return { action: 'move-card', params };

      case 'list-boards':
      case 'list boards':
        return { action: 'list-boards', params };

      case 'list-lists':
      case 'list lists':
        params['boardId'] = actionValue;
        return { action: 'list-lists', params };

      case 'list-cards':
      case 'list cards':
        params['listId'] = actionValue;
        return { action: 'list-cards', params };

      case 'add-comment':
      case 'add comment':
        params['text'] = actionValue;
        return { action: 'add-comment', params };

      default:
        return null;
    }
  }

  // ─── Private: Command Execution ───────────────────────────────

  /**
   * Execute a parsed Trello command and return a human-readable result.
   */
  private async executeCommand(command: TrelloCommand, to?: string): Promise<string> {
    switch (command.action) {
      case 'create-card':
        return this.createCard(command.params);
      case 'move-card':
        return this.moveCard(command.params);
      case 'list-boards':
        return this.listBoards();
      case 'list-lists':
        return this.listLists(command.params);
      case 'list-cards':
        return this.listCards(command.params);
      case 'add-comment':
        return this.addCommentFromCommand(command.params, to);
      default:
        throw new Error(`Unknown Trello command: ${command.action}`);
    }
  }

  /**
   * Create a card on a specified list.
   */
  private async createCard(params: Record<string, string>): Promise<string> {
    const name = params['name'];
    const listId = params['list'] ?? params['listid'] ?? params['idlist'];

    if (!name) throw new Error('Card name is required (create-card: <name>)');
    if (!listId) throw new Error('List ID is required (list: <listId>)');

    const body: Record<string, string> = { name, idList: listId };
    if (params['desc'] ?? params['description']) {
      body['desc'] = (params['desc'] ?? params['description'])!;
    }

    const card: TrelloCard = await this.apiPost('/cards', body);
    return `Card created: "${card.name}" (${card.id}) — ${card.url}`;
  }

  /**
   * Move a card to a different list.
   */
  private async moveCard(params: Record<string, string>): Promise<string> {
    const cardId = params['cardId'] ?? params['cardid'] ?? params['card'];
    const listId = params['to'] ?? params['list'] ?? params['listid'] ?? params['idlist'];

    if (!cardId) throw new Error('Card ID is required (move-card: <cardId>)');
    if (!listId) throw new Error('Destination list ID is required (to: <listId>)');

    const card: TrelloCard = await this.apiPut(`/cards/${cardId}`, { idList: listId });
    return `Card "${card.name}" moved to list ${card.idList}`;
  }

  /**
   * List all open boards accessible to the authenticated user.
   */
  private async listBoards(): Promise<string> {
    const boards: TrelloBoard[] = await this.apiGet('/members/me/boards', {
      filter: 'open',
      fields: 'name,url',
    });

    if (boards.length === 0) {
      return 'No open boards found.';
    }

    const lines = boards.map((b) => `• ${b.name} (${b.id})`);
    return `Open boards (${boards.length}):\n${lines.join('\n')}`;
  }

  /**
   * List all open lists on a board.
   */
  private async listLists(params: Record<string, string>): Promise<string> {
    const boardId = params['boardId'] ?? params['boardid'] ?? params['board'];
    if (!boardId) throw new Error('Board ID is required (list-lists: <boardId>)');

    const lists: TrelloList[] = await this.apiGet(`/boards/${boardId}/lists`, {
      filter: 'open',
      fields: 'name',
    });

    if (lists.length === 0) {
      return 'No open lists found on this board.';
    }

    const lines = lists.map((l) => `• ${l.name} (${l.id})`);
    return `Lists (${lists.length}):\n${lines.join('\n')}`;
  }

  /**
   * List cards on a specific list.
   */
  private async listCards(params: Record<string, string>): Promise<string> {
    const listId = params['listId'] ?? params['listid'] ?? params['list'];
    if (!listId) throw new Error('List ID is required (list-cards: <listId>)');

    const cards: TrelloCard[] = await this.apiGet(`/lists/${listId}/cards`, {
      fields: 'name,desc,url',
    });

    if (cards.length === 0) {
      return 'No cards found on this list.';
    }

    const lines = cards.map((c) => `• ${c.name} (${c.id})`);
    return `Cards (${cards.length}):\n${lines.join('\n')}`;
  }

  /**
   * Add a comment to a card (from send() when `to` is a card ID).
   */
  private async addComment(cardId: string, text: string): Promise<SendResult> {
    try {
      await this.apiPost(`/cards/${cardId}/actions/comments`, { text });
      return { success: true, message: `Comment added to card ${cardId}` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to add comment: ${errMsg}` };
    }
  }

  /**
   * Add a comment to a card (from a parsed command).
   */
  private async addCommentFromCommand(params: Record<string, string>, to?: string): Promise<string> {
    const text = params['text'];
    const cardId = params['card'] ?? params['cardid'] ?? params['cardId'] ?? to;

    if (!text) throw new Error('Comment text is required (add-comment: <text>)');
    if (!cardId) throw new Error('Card ID is required (card: <cardId>)');

    await this.apiPost(`/cards/${cardId}/actions/comments`, { text });
    return `Comment added to card ${cardId}`;
  }

  // ─── Private: Polling ─────────────────────────────────────────

  /**
   * Start polling for board activity to emit inbound messages.
   */
  private startPolling(): void {
    if (!this.config) return;

    const intervalMs = this.config.pollingIntervalMs;

    // Initial poll to set baseline (don't emit for existing actions)
    this.initializePolling().catch((err) => {
      this.log('warn', 'Initial polling setup failed', { error: String(err) });
    });

    this.pollTimer = setInterval(() => {
      this.pollForChanges().catch((err) => {
        this.log('warn', 'Polling cycle failed', { error: String(err) });
      });
    }, intervalMs);
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
   * Initialize polling by recording the latest action IDs without emitting.
   */
  private async initializePolling(): Promise<void> {
    const boardIds = await this.getBoardIdsToWatch();

    for (const boardId of boardIds) {
      try {
        const actions: TrelloAction[] = await this.apiGet(`/boards/${boardId}/actions`, {
          limit: '1',
          fields: 'id',
        });
        if (actions.length > 0) {
          this.lastActionIds.set(boardId, actions[0]!.id);
        }
      } catch {
        // Non-fatal — will pick up from whatever state on next poll
      }
    }
  }

  /**
   * Poll boards for new actions and emit inbound messages.
   */
  private async pollForChanges(): Promise<void> {
    if (!this.connected || !this.ctx) return;

    const boardIds = await this.getBoardIdsToWatch();

    for (const boardId of boardIds) {
      try {
        const sinceId = this.lastActionIds.get(boardId);
        const params: Record<string, string> = {
          limit: '10',
          fields: 'id,type,date,memberCreator,data',
        };
        if (sinceId) {
          params['since'] = sinceId;
        }

        const actions: TrelloAction[] = await this.apiGet(`/boards/${boardId}/actions`, params);

        if (actions.length === 0) continue;

        // Actions are returned newest-first; emit oldest-first for chronological order
        const newActions = sinceId
          ? actions.filter((a) => a.id !== sinceId).reverse()
          : actions.reverse();

        for (const action of newActions) {
          const content = this.formatActionAsInbound(action);
          if (content) {
            const from = action.memberCreator?.username ?? action.memberCreator?.fullName ?? 'trello';
            this.emitInbound(from, content);
          }
        }

        // Update last action ID to the newest
        if (actions[0]) {
          this.lastActionIds.set(boardId, actions[0].id);
        }
      } catch (err: unknown) {
        this.log('warn', `Polling failed for board ${boardId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Get the list of board IDs to monitor.
   * Uses configured watchBoardIds if provided, otherwise fetches all open boards.
   */
  private async getBoardIdsToWatch(): Promise<string[]> {
    if (!this.config) return [];

    if (this.config.watchBoardIds.length > 0) {
      return this.config.watchBoardIds;
    }

    // Fetch all open boards
    try {
      const boards: TrelloBoard[] = await this.apiGet('/members/me/boards', {
        filter: 'open',
        fields: 'id',
      });
      return boards.map((b) => b.id);
    } catch {
      return [];
    }
  }

  /**
   * Format a Trello action into a human-readable inbound message string.
   * Returns null for action types we don't want to surface.
   */
  private formatActionAsInbound(action: TrelloAction): string | null {
    const data = action.data;
    if (!data) return null;

    switch (action.type) {
      case 'createCard':
        return `Card created: "${data.card?.name ?? 'unknown'}" on list "${data.list?.name ?? 'unknown'}" (board: ${data.board?.name ?? 'unknown'})`;

      case 'updateCard':
        if (data.listBefore && data.listAfter) {
          return `Card "${data.card?.name ?? 'unknown'}" moved from "${data.listBefore.name}" to "${data.listAfter.name}" (board: ${data.board?.name ?? 'unknown'})`;
        }
        return `Card "${data.card?.name ?? 'unknown'}" updated (board: ${data.board?.name ?? 'unknown'})`;

      case 'commentCard':
        return `Comment on "${data.card?.name ?? 'unknown'}": ${data.text ?? '(no text)'}`;

      case 'addMemberToCard':
        return `Member added to card "${data.card?.name ?? 'unknown'}" (board: ${data.board?.name ?? 'unknown'})`;

      case 'deleteCard':
        return `Card deleted from board "${data.board?.name ?? 'unknown'}"`;

      default:
        // Ignore other action types to avoid noise
        return null;
    }
  }
}
