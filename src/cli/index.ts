/**
 * CLI mode entry point.
 *
 * Starts a readline-based REPL without opening any GUI window.
 * Detects --cli flag, supports slash-command detection (/ prefix),
 * and provides a clean exit via Ctrl+C or /exit.
 *
 * Requirements: 1.2, 1.10, 1.11, 1.13
 */

import { getLaunchMode } from '../main/launch-mode.js';
import { createCLIRenderer, type CLIRenderer } from './cli-renderer.js';

const PROMPT = '> ';

/** Return true when the input looks like a slash command. */
export function isSlashCommand(input: string): boolean {
  return input.startsWith('/');
}

/** Parse a slash command string into its name and arguments. */
export function parseSlashCommand(input: string): { name: string; args: string[] } {
  const trimmed = input.slice(1).trim();
  const parts = trimmed.split(/\s+/);
  return { name: parts[0] ?? '', args: parts.slice(1) };
}

/**
 * Run the REPL loop. Exported so tests can drive it with a custom renderer.
 * Returns when the user exits.
 */
export async function runREPL(renderer: CLIRenderer): Promise<void> {
  renderer.printSystem('NeuroNest — The AI Coding SuperAgent (CLI Mode)');
  renderer.printSystem('Type a message, use /commands, or /exit to quit.\n');

  let running = true;

  while (running) {
    const line = await renderer.readLine(PROMPT);

    // EOF (e.g. piped input ended)
    if (line === null) {
      running = false;
      break;
    }

    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (isSlashCommand(trimmed)) {
      const { name, args } = parseSlashCommand(trimmed);

      if (name === 'exit' || name === 'quit') {
        renderer.printSystem('Goodbye.');
        running = false;
        break;
      }

      if (name === 'help') {
        renderer.printSystem('Available commands:');
        renderer.printSystem('  /help   — Show this help message');
        renderer.printSystem('  /exit   — Exit the CLI');
        continue;
      }

      // Placeholder: forward to CommandSystem once wired
      renderer.printSystem(`[command] /${name} ${args.join(' ')}`.trimEnd());
      continue;
    }

    // Placeholder: forward to active SuperAgent once wired
    renderer.printAgent(`[echo] ${trimmed}`);
  }

  renderer.close();
}

/**
 * Main entry point — only starts the REPL when --cli is present.
 * Called directly via `node dist/cli/index.js --cli`.
 */
async function main(): Promise<void> {
  const mode = getLaunchMode();

  if (mode !== 'cli') {
    process.stderr.write(
      'This entry point is for CLI mode only. Launch with --cli flag.\n',
    );
    process.exitCode = 1;
    return;
  }

  const renderer = createCLIRenderer();

  // Graceful Ctrl+C handling
  process.on('SIGINT', () => {
    renderer.printSystem('\nInterrupted. Goodbye.');
    renderer.close();
    process.exit(0);
  });

  await runREPL(renderer);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
