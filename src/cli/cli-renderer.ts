/**
 * Minimal CLI renderer interface.
 *
 * Displays messages to stdout and reads user input from stdin.
 * Acts as a placeholder for the full Pi_TUI integration that will
 * come later. Satisfies Requirements 1.2, 1.10.
 */

import * as readline from 'node:readline';

export interface CLIRenderer {
  /** Display a system/info message to the terminal. */
  printSystem(message: string): void;
  /** Display an agent response to the terminal. */
  printAgent(message: string): void;
  /** Display an error message to the terminal. */
  printError(message: string): void;
  /** Read a single line of user input. Resolves null on EOF. */
  readLine(prompt: string): Promise<string | null>;
  /** Tear down the renderer and release stdin/stdout. */
  close(): void;
}

/**
 * Create a readline-backed CLI renderer that writes to stdout/stderr
 * and reads from stdin.
 */
export function createCLIRenderer(): CLIRenderer {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  let closed = false;

  return {
    printSystem(message: string): void {
      if (!closed) {
        process.stdout.write(`\x1b[90m${message}\x1b[0m\n`);
      }
    },

    printAgent(message: string): void {
      if (!closed) {
        process.stdout.write(`\x1b[36m${message}\x1b[0m\n`);
      }
    },

    printError(message: string): void {
      if (!closed) {
        process.stderr.write(`\x1b[31m${message}\x1b[0m\n`);
      }
    },

    readLine(prompt: string): Promise<string | null> {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer));
        rl.once('close', () => resolve(null));
      });
    },

    close(): void {
      if (!closed) {
        closed = true;
        rl.close();
      }
    },
  };
}
