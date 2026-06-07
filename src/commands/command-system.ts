/**
 * Command System — Slash command dispatch, autocomplete, extensibility.
 *
 * Implements register, unregister, list, execute, autocomplete, getHelp
 * with "/" prefix detection and autocomplete based on registered command names.
 *
 * Requirements: 16.1, 16.11, 16.12, 16.13
 */

// ─── Types ──────────────────────────────────────────────────────

export interface CommandContext {
  sessionId: string;
  agentId?: string;
  [key: string]: unknown;
}

export interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface CommandSuggestion {
  name: string;
  description: string;
  usage: string;
}

export interface CommandDefinition {
  id: string;
  name: string; // e.g. "commit"
  description: string;
  usage: string; // e.g. "/commit [message]"
  execute: (args: string[], context: CommandContext) => Promise<CommandResult>;
}

// ─── CommandSystem ──────────────────────────────────────────────

export class CommandSystem {
  private commands = new Map<string, CommandDefinition>();

  /** Register a command. Throws if id is already registered. */
  register(command: CommandDefinition): void {
    if (!command.id || command.id.length === 0) {
      throw new Error('Command id is required');
    }
    if (!command.name || command.name.length === 0) {
      throw new Error('Command name is required');
    }
    if (this.commands.has(command.id)) {
      throw new Error(`Command already registered: ${command.id}`);
    }
    this.commands.set(command.id, command);
  }

  /** Unregister a command by id. */
  unregister(commandId: string): void {
    this.commands.delete(commandId);
  }

  /** List all registered commands. */
  list(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  /**
   * Execute a command string. Detects "/" prefix, parses command name and args.
   * Returns an error result if the command is not found.
   */
  async execute(commandStr: string, context: CommandContext): Promise<CommandResult> {
    const parsed = this.parseCommand(commandStr);
    if (!parsed) {
      return {
        success: false,
        output: '',
        error: 'Invalid command format. Type /help to see all available commands.',
      };
    }

    const { name, args } = parsed;

    // Find command by name
    const command = this.findByName(name);
    if (!command) {
      return {
        success: false,
        output: '',
        error: `Unknown command: /${name}. Type /help to see all available commands.`,
      };
    }

    try {
      return await command.execute(args, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: message };
    }
  }

  /**
   * Autocomplete based on partial input. Matches against registered command names.
   * The partial string may or may not start with "/".
   */
  autocomplete(partial: string): CommandSuggestion[] {
    const query = partial.startsWith('/') ? partial.slice(1) : partial;
    const lower = query.toLowerCase();

    return Array.from(this.commands.values())
      .filter((cmd) => cmd.name.toLowerCase().startsWith(lower))
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        usage: cmd.usage,
      }));
  }

  /** Get help text for a command by id. */
  getHelp(commandId: string): string {
    const command = this.commands.get(commandId);
    if (!command) {
      return `Unknown command: ${commandId}`;
    }
    return `/${command.name} — ${command.description}\nUsage: ${command.usage}`;
  }

  // ── Private helpers ─────────────────────────────────────────

  private parseCommand(commandStr: string): { name: string; args: string[] } | null {
    const trimmed = commandStr.trim();
    if (!trimmed.startsWith('/')) {
      return null;
    }

    const parts = trimmed.slice(1).split(/\s+/);
    const name = parts[0] ?? '';
    if (name.length === 0) return null;

    return { name, args: parts.slice(1) };
  }

  private findByName(name: string): CommandDefinition | null {
    const lower = name.toLowerCase();
    for (const cmd of this.commands.values()) {
      if (cmd.name.toLowerCase() === lower) {
        return cmd;
      }
    }
    return null;
  }
}
