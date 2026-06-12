/**
 * Terminal core — manages the xterm.js terminal instance.
 * Handles terminal initialization, rendering, resize, and data flow.
 * Uses vanilla DOM for the terminal container.
 */

import type { TerminalConfig } from './types';
import { DEFAULT_TERMINAL_CONFIG } from './types';

/** Callback for data written by the user into the terminal. */
export type TerminalDataCallback = (data: string) => void;

/** Callback for terminal resize events. */
export type TerminalResizeCallback = (cols: number, rows: number) => void;

/**
 * Minimal terminal emulator core.
 * In production, this wraps xterm.js. For the decomposed architecture,
 * we implement a lightweight fallback that renders data into a pre element
 * when xterm.js is not available (build-time dependency).
 */
export class TerminalCore {
  private container: HTMLElement | null = null;
  private outputElement: HTMLPreElement | null = null;
  private config: TerminalConfig;
  private dataCallback: TerminalDataCallback | null = null;
  private resizeCallback: TerminalResizeCallback | null = null;
  private cols = 80;
  private rows = 24;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(config?: Partial<TerminalConfig>) {
    this.config = { ...DEFAULT_TERMINAL_CONFIG, ...config };
  }

  /** Mount the terminal into a DOM container. */
  mount(container: HTMLElement): void {
    this.container = container;

    // Create terminal output element
    this.outputElement = document.createElement('pre');
    Object.assign(this.outputElement.style, {
      width: '100%',
      height: '100%',
      margin: '0',
      padding: '8px',
      overflow: 'auto',
      backgroundColor: this.config.theme.background,
      color: this.config.theme.foreground,
      fontFamily: this.config.fontFamily,
      fontSize: `${this.config.fontSize}px`,
      lineHeight: `${this.config.lineHeight}`,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      boxSizing: 'border-box',
      outline: 'none',
    });
    this.outputElement.tabIndex = 0;
    this.outputElement.setAttribute('role', 'log');
    this.outputElement.setAttribute('aria-label', 'Terminal output');

    container.appendChild(this.outputElement);

    // Handle keyboard input
    this.keydownHandler = this.handleKeydown.bind(this);
    this.outputElement.addEventListener('keydown', this.keydownHandler);

    // Observe resize for dynamic cols/rows
    this.resizeObserver = new ResizeObserver(() => {
      this.recalculateDimensions();
    });
    this.resizeObserver.observe(container);

    this.recalculateDimensions();
  }

  /** Unmount the terminal and clean up resources. */
  unmount(): void {
    if (this.keydownHandler && this.outputElement) {
      this.outputElement.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.container) {
      this.container.innerHTML = '';
    }

    this.outputElement = null;
    this.container = null;
  }

  /** Write data (from pty) to the terminal display. */
  write(data: string): void {
    if (!this.outputElement) return;

    // Append text content (basic rendering — strips ANSI for now)
    const cleaned = stripAnsiCodes(data);
    this.outputElement.textContent += cleaned;

    // Auto-scroll to bottom
    this.outputElement.scrollTop = this.outputElement.scrollHeight;
  }

  /** Clear the terminal display. */
  clear(): void {
    if (this.outputElement) {
      this.outputElement.textContent = '';
    }
  }

  /** Focus the terminal element. */
  focus(): void {
    this.outputElement?.focus();
  }

  /** Set the callback for user-typed data. */
  onData(callback: TerminalDataCallback): void {
    this.dataCallback = callback;
  }

  /** Set the callback for terminal resize events. */
  onResize(callback: TerminalResizeCallback): void {
    this.resizeCallback = callback;
  }

  /** Get current terminal dimensions. */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  /** Update terminal configuration. */
  setConfig(config: Partial<TerminalConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.outputElement) {
      Object.assign(this.outputElement.style, {
        backgroundColor: this.config.theme.background,
        color: this.config.theme.foreground,
        fontFamily: this.config.fontFamily,
        fontSize: `${this.config.fontSize}px`,
        lineHeight: `${this.config.lineHeight}`,
      });
    }
    this.recalculateDimensions();
  }

  /** Handle keyboard events and forward input to pty. */
  private handleKeydown(e: KeyboardEvent): void {
    // Prevent default to avoid scrolling/navigation for terminal keys
    if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab') {
      e.preventDefault();
    }

    let data: string | null = null;

    if (e.key === 'Enter') {
      data = '\r';
    } else if (e.key === 'Backspace') {
      data = '\x7f';
    } else if (e.key === 'Tab') {
      data = '\t';
    } else if (e.key === 'Escape') {
      data = '\x1b';
    } else if (e.ctrlKey && e.key.length === 1) {
      // Ctrl+letter → control character
      const code = e.key.toLowerCase().charCodeAt(0) - 96;
      if (code > 0 && code < 27) {
        data = String.fromCharCode(code);
        e.preventDefault();
      }
    } else if (e.key === 'ArrowUp') {
      data = '\x1b[A';
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      data = '\x1b[B';
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      data = '\x1b[C';
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      data = '\x1b[D';
      e.preventDefault();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      data = e.key;
    }

    if (data !== null && this.dataCallback) {
      this.dataCallback(data);
    }
  }

  /** Recalculate terminal cols/rows based on container size. */
  private recalculateDimensions(): void {
    if (!this.container) return;

    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // Estimate character dimensions based on font size
    const charWidth = this.config.fontSize * 0.6;
    const charHeight = this.config.fontSize * this.config.lineHeight;

    const padding = 16; // 8px on each side
    const newCols = Math.max(1, Math.floor((rect.width - padding) / charWidth));
    const newRows = Math.max(1, Math.floor((rect.height - padding) / charHeight));

    if (newCols !== this.cols || newRows !== this.rows) {
      this.cols = newCols;
      this.rows = newRows;
      if (this.resizeCallback) {
        this.resizeCallback(this.cols, this.rows);
      }
    }
  }
}

/**
 * Strip ANSI escape codes from a string for plain-text rendering.
 * In a full xterm.js integration, this would not be needed.
 */
function stripAnsiCodes(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
