/**
 * Discord Bot Adapter — Bridge between Discord and cloud agent tasks
 *
 * Handles Discord slash commands, message events, and bot interactions.
 * Routes commands to the task pipeline and delivers results back to channels.
 *
 * Task 22.2
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface DiscordInteraction {
  id: string;
  type: DiscordInteractionType;
  data?: DiscordInteractionData;
  guildId?: string;
  channelId: string;
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
  token: string;
}

export enum DiscordInteractionType {
  PING = 1,
  APPLICATION_COMMAND = 2,
  MESSAGE_COMPONENT = 3,
}

export interface DiscordInteractionData {
  name: string;
  options?: DiscordCommandOption[];
}

export interface DiscordCommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordCommandOption[];
}

export interface DiscordResponse {
  type: DiscordResponseType;
  data?: {
    content?: string;
    embeds?: DiscordEmbed[];
    flags?: number;
  };
}

export enum DiscordResponseType {
  PONG = 1,
  CHANNEL_MESSAGE = 4,
  DEFERRED_CHANNEL_MESSAGE = 5,
  DEFERRED_UPDATE = 6,
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordAdapterConfig {
  applicationId: string;
  publicKey: string;
  botToken: string;
}

// ─── Signature Verification ─────────────────────────────────────

/**
 * Verify Discord interaction signature (Ed25519).
 * Discord uses Ed25519 signature verification on all incoming interactions.
 */
export function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string
): boolean {
  try {
    const message = Buffer.from(timestamp + body);
    const sigBuffer = Buffer.from(signature, 'hex');
    const keyBuffer = Buffer.from(publicKey, 'hex');

    // Use crypto.verify with Ed25519
    return crypto.verify(
      null,  // Ed25519 doesn't use a separate hash algorithm
      message,
      { key: keyBuffer, format: 'der', type: 'spki' },
      sigBuffer
    );
  } catch {
    // If key format is wrong or verification fails, return false
    return false;
  }
}

// ─── Command Router ─────────────────────────────────────────────

export class DiscordAdapter {
  private config: DiscordAdapterConfig;
  private taskSubmitter: (tenantId: string, type: string, payload: Record<string, unknown>) => Promise<string>;

  constructor(
    config: DiscordAdapterConfig,
    taskSubmitter: (tenantId: string, type: string, payload: Record<string, unknown>) => Promise<string>
  ) {
    this.config = config;
    this.taskSubmitter = taskSubmitter;
  }

  /**
   * Handle an incoming Discord interaction.
   */
  async handleInteraction(interaction: DiscordInteraction): Promise<DiscordResponse> {
    // Handle ping (required for Discord webhook verification)
    if (interaction.type === DiscordInteractionType.PING) {
      return { type: DiscordResponseType.PONG };
    }

    // Handle application commands
    if (interaction.type === DiscordInteractionType.APPLICATION_COMMAND && interaction.data) {
      return this.handleCommand(interaction);
    }

    return {
      type: DiscordResponseType.CHANNEL_MESSAGE,
      data: { content: 'Unknown interaction type.', flags: 64 },
    };
  }

  /**
   * Route a slash command to the appropriate handler.
   */
  private async handleCommand(interaction: DiscordInteraction): Promise<DiscordResponse> {
    const commandName = interaction.data?.name;
    const userId = interaction.member?.user?.id || interaction.user?.id || 'unknown';
    const guildId = interaction.guildId || 'dm';

    switch (commandName) {
      case 'neuronest-run':
        return this.handleRun(interaction, userId, guildId);
      case 'neuronest-status':
        return this.handleStatus(interaction);
      case 'neuronest-help':
        return this.handleHelp();
      default:
        return {
          type: DiscordResponseType.CHANNEL_MESSAGE,
          data: { content: `Unknown command: ${commandName}`, flags: 64 },
        };
    }
  }

  /** /neuronest-run <task-type> [params] */
  private async handleRun(
    interaction: DiscordInteraction,
    userId: string,
    guildId: string
  ): Promise<DiscordResponse> {
    const options = interaction.data?.options || [];
    const taskType = options.find(o => o.name === 'task')?.value as string | undefined;

    if (!taskType) {
      return {
        type: DiscordResponseType.CHANNEL_MESSAGE,
        data: { content: 'Please specify a task type.', flags: 64 },
      };
    }

    // Submit task with guild as tenant
    const taskId = await this.taskSubmitter(guildId, taskType, {
      source: 'discord',
      channelId: interaction.channelId,
      userId,
      options: options.filter(o => o.name !== 'task').map(o => ({ name: o.name, value: o.value })),
    });

    return {
      type: DiscordResponseType.CHANNEL_MESSAGE,
      data: {
        embeds: [{
          title: 'Task Submitted',
          description: `Task **${taskType}** has been submitted.`,
          color: 0x5865F2,  // Discord blurple
          fields: [
            { name: 'Task ID', value: `\`${taskId}\``, inline: true },
            { name: 'Submitted by', value: `<@${userId}>`, inline: true },
          ],
          timestamp: new Date().toISOString(),
        }],
      },
    };
  }

  /** /neuronest-status <task-id> */
  private async handleStatus(interaction: DiscordInteraction): Promise<DiscordResponse> {
    const taskId = interaction.data?.options?.find(o => o.name === 'task_id')?.value as string;

    if (!taskId) {
      return {
        type: DiscordResponseType.CHANNEL_MESSAGE,
        data: { content: 'Please provide a task ID.', flags: 64 },
      };
    }

    return {
      type: DiscordResponseType.CHANNEL_MESSAGE,
      data: {
        content: `Checking status of task \`${taskId}\`...`,
        flags: 64,
      },
    };
  }

  /** /neuronest-help */
  private handleHelp(): DiscordResponse {
    return {
      type: DiscordResponseType.CHANNEL_MESSAGE,
      data: {
        embeds: [{
          title: 'NeuroNest Cloud Agent',
          description: 'Available commands:',
          color: 0x5865F2,
          fields: [
            { name: '/neuronest-run', value: 'Submit a task to the cloud agent' },
            { name: '/neuronest-status', value: 'Check status of a submitted task' },
            { name: '/neuronest-help', value: 'Show this help message' },
          ],
        }],
        flags: 64,
      },
    };
  }

  /**
   * Get slash command registration payload for Discord API.
   */
  getCommandRegistrations(): unknown[] {
    return [
      {
        name: 'neuronest-run',
        description: 'Submit a task to NeuroNest Cloud Agent',
        options: [
          {
            name: 'task',
            description: 'The task type to run',
            type: 3,  // STRING
            required: true,
          },
          {
            name: 'params',
            description: 'Additional parameters (JSON)',
            type: 3,  // STRING
            required: false,
          },
        ],
      },
      {
        name: 'neuronest-status',
        description: 'Check status of a cloud agent task',
        options: [
          {
            name: 'task_id',
            description: 'The task ID to check',
            type: 3,  // STRING
            required: true,
          },
        ],
      },
      {
        name: 'neuronest-help',
        description: 'Show NeuroNest Cloud Agent help',
      },
    ];
  }
}
