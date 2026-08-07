// ─── 1Password Adapter ───────────────────────────────────────────
// Full ChannelAdapter implementation for 1Password credential
// management using either the 1Password Connect API (REST) or
// the `op` CLI. Supports retrieving credentials, listing vaults,
// and creating items. Bidirectional: inbound triggers via polling
// or external webhook; outbound delivers secret values or confirmation.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.8

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for 1Password adapter configuration.
 * Supports two modes:
 * 1. Connect API mode: requires connectHost + token
 * 2. CLI mode: requires opCliPath (path to the `op` binary)
 *
 * If both are provided, Connect API takes precedence.
 */
export const OnePasswordConfigSchema = z
  .object({
    /** 1Password Connect server host URL (e.g., http://localhost:8080) */
    connectHost: z.string().url().optional(),
    /** 1Password Connect API token */
    token: z.string().min(1).optional(),
    /** Path to the `op` CLI binary (e.g., /usr/local/bin/op) */
    opCliPath: z.string().optional(),
  })
  .refine(
    (data) => (data.connectHost && data.token) || data.opCliPath,
    {
      message:
        'Either connectHost + token (Connect API mode) or opCliPath (CLI mode) must be provided',
    },
  );

export type OnePasswordConfig = z.infer<typeof OnePasswordConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported 1Password command actions (REQ 10.8) */
type OnePasswordAction =
  | 'get-item'
  | 'list-vaults'
  | 'list-items'
  | 'create-item'
  | 'get-field';

/** Parsed command structure */
interface OnePasswordCommand {
  action: OnePasswordAction;
  vaultId?: string | undefined;
  itemId?: string | undefined;
  itemTitle?: string | undefined;
  fieldLabel?: string | undefined;
  category?: string | undefined;
  fields?: Array<{ label: string; value: string; type?: string }> | undefined;
}

/** 1Password vault summary */
interface OPVault {
  id: string;
  name: string;
}

/** 1Password item summary */
interface OPItemSummary {
  id: string;
  title: string;
  category: string;
  vault: { id: string; name?: string };
}

/** 1Password item detail with fields */
interface OPItemDetail {
  id: string;
  title: string;
  category: string;
  vault: { id: string; name?: string };
  fields?: Array<{
    id: string;
    label: string;
    value: string;
    type: string;
    purpose?: string;
  }>;
}

// ─── 1Password Adapter ──────────────────────────────────────────

export class OnePasswordAdapter extends BaseChannelAdapter {
  readonly channelId = '1password';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: '1Password',
    emoji: '🔐',
    description: 'Credential retrieval and vault management',
    actionTags: ['get credential', 'list vaults', 'create item', 'search'],
    sortOrder: 1050,
  };

  readonly configSchema = OnePasswordConfigSchema;

  private config: OnePasswordConfig | null = null;
  private mode: 'connect-api' | 'cli' = 'connect-api';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        '1Password adapter requires either Connect API credentials or CLI path.\n\n' +
        'Option 1 — Connect API:\n' +
        '  1. Deploy 1Password Connect server\n' +
        '  2. Provide connectHost (e.g., http://localhost:8080)\n' +
        '  3. Provide token (Connect API bearer token)\n\n' +
        'Option 2 — CLI:\n' +
        '  1. Install the `op` CLI (https://1password.com/downloads/command-line)\n' +
        '  2. Sign in: `op signin`\n' +
        '  3. Provide opCliPath (e.g., /usr/local/bin/op)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Determine mode: Connect API takes precedence
    if (this.config.connectHost && this.config.token) {
      this.mode = 'connect-api';
    } else {
      this.mode = 'cli';
    }

    // Verify connectivity
    try {
      const verifyResult = await this.verifyConnection();
      if (!verifyResult.success) {
        return verifyResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to 1Password: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected to 1Password', { mode: this.mode });

    return {
      success: true,
      message: `1Password connected successfully (${this.mode} mode)`,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: '1Password adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      return { success: false, message: 'Could not parse 1Password command. Supported actions: get-item, list-vaults, list-items, create-item, get-field' };
    }

    // Execute the parsed command (REQ 10.8)
    try {
      switch (command.action) {
        case 'get-item':
          return this.getItem(command.vaultId, command.itemId ?? command.itemTitle ?? '');

        case 'list-vaults':
          return this.listVaults();

        case 'list-items':
          return this.listItems(command.vaultId);

        case 'create-item':
          return this.createItem(
            command.vaultId ?? '',
            command.itemTitle ?? 'Untitled',
            command.category ?? 'login',
            command.fields ?? [],
          );

        case 'get-field':
          return this.getField(
            command.vaultId,
            command.itemId ?? command.itemTitle ?? '',
            command.fieldLabel ?? 'password',
          );

        default:
          return { success: false, message: `Unknown 1Password action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `1Password operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Connection verification ─────────────────────────

  /**
   * Verify connectivity by listing vaults (a lightweight operation
   * that confirms both auth and network access).
   */
  private async verifyConnection(): Promise<ConnectResult> {
    if (this.mode === 'connect-api') {
      return this.verifyConnectApi();
    }
    return this.verifyCli();
  }

  /**
   * Verify Connect API connectivity by calling GET /v1/vaults.
   */
  private async verifyConnectApi(): Promise<ConnectResult> {
    const response = await this.connectApiFetch('/v1/vaults');
    if (!response.ok) {
      if (response.status === 401) {
        return this.authFailed('Invalid or expired Connect API token.');
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `1Password Connect API error (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }
    return { success: true, message: 'Connect API verified' };
  }

  /**
   * Verify CLI connectivity by running `op vault list --format=json`.
   */
  private async verifyCli(): Promise<ConnectResult> {
    try {
      const cliPath = this.config!.opCliPath!;
      await execFileAsync(cliPath, ['vault', 'list', '--format=json']);
      return { success: true, message: 'CLI verified' };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('not signed in') || errMsg.includes('authorization')) {
        return this.authFailed('op CLI is not signed in. Run `op signin` first.');
      }
      if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
        return this.sdkMissing('op (1Password CLI)');
      }
      return {
        success: false,
        message: `1Password CLI error: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }
  }

  // ─── Private: Operations (REQ 10.8) ───────────────────────────

  /**
   * Retrieve a specific item from a vault.
   */
  private async getItem(vaultId: string | undefined, itemRef: string): Promise<SendResult> {
    if (!itemRef) {
      return { success: false, message: 'Item ID or title is required for get-item' };
    }

    if (this.mode === 'connect-api') {
      // Connect API: GET /v1/vaults/{vaultId}/items/{itemId}
      // If no vaultId, try searching across vaults
      if (vaultId) {
        const response = await this.connectApiFetch(`/v1/vaults/${vaultId}/items/${itemRef}`);
        if (!response.ok) {
          if (response.status === 404) {
            return { success: false, message: `Item not found: ${itemRef}` };
          }
          const errorBody = await response.text();
          return { success: false, message: `Get item failed: ${errorBody}` };
        }
        const item = (await response.json()) as OPItemDetail;
        return { success: true, message: this.formatItemDetail(item) };
      }
      // No vault specified — search by title across all vaults
      return this.searchItem(itemRef);
    }

    // CLI mode: op item get <itemRef> [--vault <vaultId>] --format=json
    const args = ['item', 'get', itemRef, '--format=json'];
    if (vaultId) {
      args.push('--vault', vaultId);
    }
    const result = await this.runCli(args);
    if (!result.success) return result;

    return { success: true, message: result.message };
  }

  /**
   * List all accessible vaults.
   */
  private async listVaults(): Promise<SendResult> {
    if (this.mode === 'connect-api') {
      const response = await this.connectApiFetch('/v1/vaults');
      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, message: `List vaults failed: ${errorBody}` };
      }
      const vaults = (await response.json()) as OPVault[];
      return {
        success: true,
        message: JSON.stringify({
          action: 'list-vaults',
          count: vaults.length,
          vaults: vaults.map((v) => ({ id: v.id, name: v.name })),
        }, null, 2),
      };
    }

    // CLI mode
    const result = await this.runCli(['vault', 'list', '--format=json']);
    if (!result.success) return result;

    return { success: true, message: result.message };
  }

  /**
   * List items in a vault (or all vaults if none specified).
   */
  private async listItems(vaultId?: string): Promise<SendResult> {
    if (this.mode === 'connect-api') {
      if (!vaultId) {
        return { success: false, message: 'Vault ID is required for list-items in Connect API mode' };
      }
      const response = await this.connectApiFetch(`/v1/vaults/${vaultId}/items`);
      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, message: `List items failed: ${errorBody}` };
      }
      const items = (await response.json()) as OPItemSummary[];
      return {
        success: true,
        message: JSON.stringify({
          action: 'list-items',
          vaultId,
          count: items.length,
          items: items.map((i) => ({ id: i.id, title: i.title, category: i.category })),
        }, null, 2),
      };
    }

    // CLI mode
    const args = ['item', 'list', '--format=json'];
    if (vaultId) {
      args.push('--vault', vaultId);
    }
    const result = await this.runCli(args);
    if (!result.success) return result;

    return { success: true, message: result.message };
  }

  /**
   * Create a new item in a vault.
   */
  private async createItem(
    vaultId: string,
    title: string,
    category: string,
    fields: Array<{ label: string; value: string; type?: string }>,
  ): Promise<SendResult> {
    if (!vaultId) {
      return { success: false, message: 'Vault ID is required for create-item' };
    }

    if (this.mode === 'connect-api') {
      const body = {
        vault: { id: vaultId },
        title,
        category: category.toUpperCase(),
        fields: fields.map((f) => ({
          label: f.label,
          value: f.value,
          type: f.type ?? 'STRING',
          purpose: f.label.toLowerCase() === 'password' ? 'PASSWORD' : '',
        })),
      };

      const response = await this.connectApiFetch(`/v1/vaults/${vaultId}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, message: `Create item failed: ${errorBody}` };
      }

      const item = (await response.json()) as OPItemDetail;
      return {
        success: true,
        message: JSON.stringify({
          action: 'create-item',
          id: item.id,
          title: item.title,
          category: item.category,
          vault: item.vault,
        }, null, 2),
      };
    }

    // CLI mode: op item create --category <cat> --title <title> --vault <vault> [fields...]
    const args = [
      'item',
      'create',
      '--category',
      category,
      '--title',
      title,
      '--vault',
      vaultId,
      '--format=json',
    ];

    // Add fields as key=value assignments
    for (const field of fields) {
      args.push(`${field.label}=${field.value}`);
    }

    const result = await this.runCli(args);
    if (!result.success) return result;

    return { success: true, message: result.message };
  }

  /**
   * Get a specific field value from an item.
   */
  private async getField(
    vaultId: string | undefined,
    itemRef: string,
    fieldLabel: string,
  ): Promise<SendResult> {
    if (!itemRef) {
      return { success: false, message: 'Item ID or title is required for get-field' };
    }

    if (this.mode === 'connect-api') {
      // First get the full item, then extract the field
      const itemResult = await this.getItem(vaultId, itemRef);
      if (!itemResult.success) return itemResult;

      try {
        const itemData = JSON.parse(itemResult.message) as OPItemDetail;
        const field = itemData.fields?.find(
          (f) => f.label.toLowerCase() === fieldLabel.toLowerCase(),
        );

        if (!field) {
          return { success: false, message: `Field "${fieldLabel}" not found in item "${itemRef}"` };
        }

        return {
          success: true,
          message: JSON.stringify({
            action: 'get-field',
            itemId: itemData.id,
            itemTitle: itemData.title,
            fieldLabel: field.label,
            fieldValue: field.value,
            fieldType: field.type,
          }, null, 2),
        };
      } catch {
        return { success: false, message: 'Failed to parse item data for field extraction' };
      }
    }

    // CLI mode: op item get <itemRef> --fields label=<fieldLabel> --vault <vaultId> --format=json
    const args = ['item', 'get', itemRef, '--fields', `label=${fieldLabel}`, '--format=json'];
    if (vaultId) {
      args.push('--vault', vaultId);
    }
    const result = await this.runCli(args);
    if (!result.success) return result;

    return { success: true, message: result.message };
  }

  /**
   * Search for an item by title across all vaults (Connect API).
   */
  private async searchItem(title: string): Promise<SendResult> {
    // The Connect API doesn't have a direct search endpoint,
    // so we list vaults and search items in each.
    const vaultsResponse = await this.connectApiFetch('/v1/vaults');
    if (!vaultsResponse.ok) {
      return { success: false, message: 'Failed to list vaults for item search' };
    }

    const vaults = (await vaultsResponse.json()) as OPVault[];

    for (const vault of vaults) {
      const itemsResponse = await this.connectApiFetch(
        `/v1/vaults/${vault.id}/items?filter=title eq "${title}"`,
      );
      if (!itemsResponse.ok) continue;

      const items = (await itemsResponse.json()) as OPItemSummary[];
      if (items.length > 0 && items[0]) {
        // Found a match — get full details
        const detailResponse = await this.connectApiFetch(
          `/v1/vaults/${vault.id}/items/${items[0].id}`,
        );
        if (detailResponse.ok) {
          const item = (await detailResponse.json()) as OPItemDetail;
          return { success: true, message: this.formatItemDetail(item) };
        }
      }
    }

    return { success: false, message: `Item not found: ${title}` };
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured 1Password command.
   * Supports JSON-format commands and natural language patterns:
   * - "get item <ref> [from vault <vaultId>]"
   * - "list vaults"
   * - "list items [in vault <vaultId>]"
   * - "create item <title> in vault <vaultId> [category <cat>]"
   * - "get field <label> from <itemRef> [in vault <vaultId>]"
   * - "get password for <itemRef>"
   */
  private parseCommand(content: string): OnePasswordCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as OnePasswordCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "list vaults"
    if (/^list\s+vaults?$/i.test(lower)) {
      return { action: 'list-vaults' };
    }

    // Pattern: "list items [in vault <vaultId>]"
    const listItemsMatch = lower.match(/^list\s+items?(?:\s+(?:in\s+)?vault\s+(\S+))?$/i);
    if (listItemsMatch) {
      return { action: 'list-items', vaultId: listItemsMatch[1] || undefined };
    }

    // Pattern: "get password for <itemRef> [from vault <vaultId>]"
    const getPasswordMatch = content.match(
      /^get\s+password\s+(?:for\s+)?(.+?)(?:\s+(?:from|in)\s+vault\s+(\S+))?$/i,
    );
    if (getPasswordMatch && getPasswordMatch[1]) {
      return {
        action: 'get-field',
        itemId: getPasswordMatch[1].trim(),
        fieldLabel: 'password',
        vaultId: getPasswordMatch[2] || undefined,
      };
    }

    // Pattern: "get field <label> from <itemRef> [in vault <vaultId>]"
    const getFieldMatch = content.match(
      /^get\s+field\s+(\S+)\s+from\s+(.+?)(?:\s+(?:in|from)\s+vault\s+(\S+))?$/i,
    );
    if (getFieldMatch && getFieldMatch[1] && getFieldMatch[2]) {
      return {
        action: 'get-field',
        fieldLabel: getFieldMatch[1],
        itemId: getFieldMatch[2].trim(),
        vaultId: getFieldMatch[3] || undefined,
      };
    }

    // Pattern: "get item <ref> [from vault <vaultId>]"
    const getItemMatch = content.match(
      /^get\s+(?:item\s+)?(.+?)(?:\s+(?:from|in)\s+vault\s+(\S+))?$/i,
    );
    if (getItemMatch && getItemMatch[1] && !lower.startsWith('get field') && !lower.startsWith('get password')) {
      return {
        action: 'get-item',
        itemId: getItemMatch[1].trim(),
        vaultId: getItemMatch[2] || undefined,
      };
    }

    // Pattern: "create item <title> in vault <vaultId> [category <cat>]"
    const createMatch = content.match(
      /^create\s+item\s+(.+?)\s+in\s+vault\s+(\S+)(?:\s+category\s+(\S+))?$/i,
    );
    if (createMatch && createMatch[1] && createMatch[2]) {
      return {
        action: 'create-item',
        itemTitle: createMatch[1].trim(),
        vaultId: createMatch[2],
        category: createMatch[3] || 'login',
        fields: [],
      };
    }

    return null;
  }

  // ─── Private: Helpers ─────────────────────────────────────────

  /**
   * Format an item detail object into a JSON response string.
   */
  private formatItemDetail(item: OPItemDetail): string {
    return JSON.stringify({
      action: 'get-item',
      id: item.id,
      title: item.title,
      category: item.category,
      vault: item.vault,
      fields: item.fields?.map((f) => ({
        label: f.label,
        value: f.value,
        type: f.type,
        purpose: f.purpose,
      })),
    }, null, 2);
  }

  /**
   * Make an authenticated request to the 1Password Connect API.
   */
  private async connectApiFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!this.config?.connectHost || !this.config.token) {
      throw new Error('1Password Connect API is not configured');
    }

    const baseUrl = this.config.connectHost.replace(/\/$/, '');
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }

  /**
   * Execute a 1Password CLI command and return the result.
   */
  private async runCli(args: string[]): Promise<SendResult> {
    if (!this.config?.opCliPath) {
      return { success: false, message: 'op CLI path is not configured' };
    }

    try {
      const { stdout } = await execFileAsync(this.config.opCliPath, args, {
        timeout: 30000,
        env: { ...process.env },
      });

      // Try to parse and re-format JSON output
      try {
        const parsed = JSON.parse(stdout);
        return { success: true, message: JSON.stringify(parsed, null, 2) };
      } catch {
        // Return raw output if not JSON
        return { success: true, message: stdout.trim() };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'CLI command failed', { args, error: errMsg });
      return { success: false, message: `1Password CLI error: ${errMsg}` };
    }
  }
}
