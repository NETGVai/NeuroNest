/**
 * Slack Command Handler — Parse commands, route to agent, return results
 *
 * Handles Slack slash commands, interactive messages, and event subscriptions.
 * Routes incoming commands to the appropriate cloud agent task pipeline.
 *
 * Task 22.2
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface SlackCommand {
  command: string;
  text: string;
  userId: string;
  userName: string;
  channelId: string;
  channelName: string;
  teamId: string;
  teamDomain: string;
  responseUrl: string;
  triggerId: string;
}

export interface SlackResponse {
  response_type: 'in_channel' | 'ephemeral';
  text?: string;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: unknown[];
  [key: string]: unknown;
}

export interface SlackAttachment {
  color?: string;
  title?: string;
  text?: string;
  fields?: { title: string; value: string; short?: boolean }[];
}

export interface SlackHandlerConfig {
  signingSecret: string;
  botToken: string;
  commandPrefix: string;
}

// ─── Signature Verification ─────────────────────────────────────

/**
 * Verify Slack request signature using HMAC-SHA256.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  // Reject requests older than 5 minutes (replay protection)
  const fiveMinutes = 5 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > fiveMinutes) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');
  const computed = `v0=${hmac}`;

  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

// ─── Command Parser ─────────────────────────────────────────────

interface ParsedCommand {
  action: string;
  args: string[];
  flags: Record<string, string>;
}

/**
 * Parse a Slack command text into structured action, args, and flags.
 * Format: /neuronest <action> [args...] [--flag=value...]
 */
export function parseSlackCommand(text: string): ParsedCommand {
  const tokens = text.trim().split(/\s+/);
  const action = tokens[0] || 'help';
  const args: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=');
      if (eqIndex > 0) {
        flags[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      } else {
        flags[token.slice(2)] = 'true';
      }
    } else {
      args.push(token);
    }
  }

  return { action, args, flags };
}

// ─── Slack Command Handler ──────────────────────────────────────

export class SlackHandler {
  private config: SlackHandlerConfig;
  private taskSubmitter: (tenantId: string, type: string, payload: Record<string, unknown>) => Promise<string>;

  constructor(
    config: SlackHandlerConfig,
    taskSubmitter: (tenantId: string, type: string, payload: Record<string, unknown>) => Promise<string>
  ) {
    this.config = config;
    this.taskSubmitter = taskSubmitter;
  }

  /**
   * Handle an incoming slash command request.
   */
  async handleCommand(cmd: SlackCommand): Promise<SlackResponse> {
    const parsed = parseSlackCommand(cmd.text);

    switch (parsed.action) {
      case 'run':
        return this.handleRun(cmd, parsed);
      case 'status':
        return this.handleStatus(cmd, parsed);
      case 'list':
        return this.handleList(cmd);
      case 'help':
      default:
        return this.handleHelp();
    }
  }

  /** /neuronest run <task-type> [...args] */
  private async handleRun(cmd: SlackCommand, parsed: ParsedCommand): Promise<SlackResponse> {
    const taskType = parsed.args[0];
    if (!taskType) {
      return {
        response_type: 'ephemeral',
        text: 'Usage: /neuronest run <task-type> [--param=value...]',
      };
    }

    const taskId = await this.taskSubmitter(cmd.teamId, taskType, {
      source: 'slack',
      channelId: cmd.channelId,
      userId: cmd.userId,
      args: parsed.args.slice(1),
      flags: parsed.flags,
    });

    return {
      response_type: 'in_channel',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Task *${taskType}* submitted by <@${cmd.userId}>`,
          },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Task ID: \`${taskId}\`` }],
        },
      ],
    };
  }

  /** /neuronest status <task-id> */
  private async handleStatus(cmd: SlackCommand, parsed: ParsedCommand): Promise<SlackResponse> {
    const taskId = parsed.args[0];
    if (!taskId) {
      return {
        response_type: 'ephemeral',
        text: 'Usage: /neuronest status <task-id>',
      };
    }

    return {
      response_type: 'ephemeral',
      text: `Checking status of task \`${taskId}\`... (query your cloud dashboard for live updates)`,
    };
  }

  /** /neuronest list */
  private async handleList(cmd: SlackCommand): Promise<SlackResponse> {
    return {
      response_type: 'ephemeral',
      text: 'View active tasks at your NeuroNest Cloud dashboard.',
    };
  }

  /** /neuronest help */
  private handleHelp(): SlackResponse {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*NeuroNest Cloud Agent — Slash Commands*',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              '`/neuronest run <task-type>` — Submit a task',
              '`/neuronest status <task-id>` — Check task status',
              '`/neuronest list` — List active tasks',
              '`/neuronest help` — Show this help',
            ].join('\n'),
          },
        },
      ],
    };
  }
}
