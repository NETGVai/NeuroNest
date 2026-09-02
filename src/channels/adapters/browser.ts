// ─── Browser Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for headless browser automation
// using Puppeteer. Supports opening URLs, taking screenshots, clicking
// elements, extracting text, and navigation. Bidirectional: inbound
// triggers via commands; outbound delivers operation results.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.9

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Browser adapter configuration.
 *
 * - browserPath: optional path to a Chromium/Chrome binary.
 *   If omitted, Puppeteer's bundled Chromium is used.
 * - headless: whether to launch in headless mode (default: true)
 * - defaultTimeout: navigation/action timeout in ms (default: 30000)
 */
export const BrowserConfigSchema = z.object({
  /** Path to the browser executable (optional — uses bundled Chromium if omitted) */
  browserPath: z.string().optional(),
  /** Run in headless mode (default: true) */
  headless: z.boolean().optional().default(true),
  /** Default timeout for navigation and actions in ms (default: 30000) */
  defaultTimeout: z.number().int().positive().optional().default(30000),
});

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported browser command actions (REQ 10.9) */
type BrowserAction =
  | 'open'
  | 'screenshot'
  | 'click'
  | 'extract-text'
  | 'navigate'
  | 'type'
  | 'evaluate';

/** Parsed command structure */
interface BrowserCommand {
  action: BrowserAction;
  url?: string | undefined;
  selector?: string | undefined;
  text?: string | undefined;
  script?: string | undefined;
  fullPage?: boolean | undefined;
  waitFor?: string | undefined;
  direction?: 'back' | 'forward' | 'reload' | undefined;
}

// ─── Puppeteer dynamic types ────────────────────────────────────
// We use dynamic import to avoid hard failure if puppeteer is not installed.

interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
}

interface PuppeteerPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  screenshot(options?: { encoding?: string; fullPage?: boolean }): Promise<string | Buffer>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  $eval(selector: string, fn: (el: Element) => string): Promise<string>;
  $$eval(selector: string, fn: (els: Element[]) => string): Promise<string>;
  evaluate(fn: () => string): Promise<string>;
  type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
  goBack(options?: { waitUntil?: string }): Promise<unknown>;
  goForward(options?: { waitUntil?: string }): Promise<unknown>;
  reload(options?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  close(): Promise<void>;
  setDefaultTimeout(timeout: number): void;
  setDefaultNavigationTimeout(timeout: number): void;
}

// ─── Browser Adapter ────────────────────────────────────────────

export class BrowserAdapter extends BaseChannelAdapter {
  readonly channelId = 'browser';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Browser',
    emoji: '🌐',
    description: 'Headless browser automation for web interaction',
    actionTags: ['open URL', 'screenshot', 'click', 'extract text', 'navigate'],
    sortOrder: 1090,
  };

  readonly configSchema = BrowserConfigSchema;

  private config: BrowserConfig | null = null;
  private browser: PuppeteerBrowser | null = null;
  private page: PuppeteerPage | null = null;
  private puppeteerModule: { launch: (options: Record<string, unknown>) => Promise<PuppeteerBrowser> } | null = null;

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Browser adapter configuration is invalid.\n\n' +
        'Configuration options:\n' +
        '  - browserPath (optional): Path to Chromium/Chrome executable\n' +
        '  - headless (optional, default: true): Run in headless mode\n' +
        '  - defaultTimeout (optional, default: 30000): Timeout in ms\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Attempt to import puppeteer (REQ 1.7 — SDK_MISSING detection)
    try {
      // @ts-ignore -- puppeteer may not be installed; handled by catch
      this.puppeteerModule = await import('puppeteer');
    } catch {
      try {
        // @ts-ignore -- puppeteer-core may not be installed; handled by catch
        this.puppeteerModule = await import('puppeteer-core');
      } catch {
        return this.sdkMissing('puppeteer');
      }
    }

    // Launch browser instance
    try {
      const launchOptions: Record<string, unknown> = {
        headless: this.config.headless !== false ? 'new' : false,
      };

      if (this.config.browserPath) {
        launchOptions.executablePath = this.config.browserPath;
      }

      this.browser = await this.puppeteerModule!.launch(launchOptions);
      this.page = await this.browser.newPage();

      // Set default timeouts
      const timeout = this.config.defaultTimeout ?? 30000;
      this.page.setDefaultTimeout(timeout);
      this.page.setDefaultNavigationTimeout(timeout);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Could not find') || errMsg.includes('Failed to launch')) {
        return {
          success: false,
          message: `Browser executable not found. Provide a valid browserPath or install puppeteer with bundled Chromium.\n\nError: ${errMsg}`,
          error: { code: 'PROVIDER_ERROR', message: errMsg },
        };
      }
      return {
        success: false,
        message: `Failed to launch browser: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Browser adapter connected', {
      headless: this.config.headless,
      browserPath: this.config.browserPath ?? 'bundled',
    });

    return {
      success: true,
      message: 'Browser connected successfully (headless browser ready)',
    };
  }

  async disconnect(): Promise<void> {
    if (this.page) {
      try {
        await this.page.close();
      } catch {
        // Page may already be closed
      }
      this.page = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Browser may already be closed
      }
      this.browser = null;
    }

    this.connected = false;
    this.config = null;
    this.puppeteerModule = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.browser || !this.page) {
      return { success: false, message: 'Browser adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message:
          'Could not parse browser command. Supported actions: open, screenshot, click, extract-text, navigate, type, evaluate',
      };
    }

    // Execute the parsed command (REQ 10.9)
    try {
      switch (command.action) {
        case 'open':
          return await this.openUrl(command.url ?? '');

        case 'screenshot':
          return await this.takeScreenshot(command.fullPage);

        case 'click':
          return await this.clickElement(command.selector ?? '');

        case 'extract-text':
          return await this.extractText(command.selector);

        case 'navigate':
          return await this.navigate(command.direction ?? 'reload');

        case 'type':
          return await this.typeText(command.selector ?? '', command.text ?? '');

        case 'evaluate':
          return await this.evaluateScript(command.script ?? '');

        default:
          return { success: false, message: `Unknown browser action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Browser command failed', { action: command.action, error: errMsg });
      return { success: false, message: `Browser operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Operations (REQ 10.9) ───────────────────────────

  /**
   * Open a URL in the browser page.
   */
  private async openUrl(url: string): Promise<SendResult> {
    if (!url) {
      return { success: false, message: 'URL is required for open action' };
    }

    if (!this.page) {
      return { success: false, message: 'No active browser page' };
    }

    // Ensure URL has a protocol
    const normalizedUrl = url.match(/^https?:\/\//) ? url : `https://${url}`;

    await this.page.goto(normalizedUrl, { waitUntil: 'networkidle2' });

    const title = await this.page.title();
    const currentUrl = this.page.url();

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'open',
          url: currentUrl,
          title,
          status: 'loaded',
        },
        null,
        2,
      ),
    };
  }

  /**
   * Take a screenshot of the current page.
   * Returns the screenshot as a base64-encoded PNG string.
   */
  private async takeScreenshot(fullPage?: boolean): Promise<SendResult> {
    if (!this.page) {
      return { success: false, message: 'No active browser page' };
    }

    const screenshot = await this.page.screenshot({
      encoding: 'base64',
      fullPage: fullPage ?? false,
    });

    const currentUrl = this.page.url();
    const title = await this.page.title();

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'screenshot',
          url: currentUrl,
          title,
          fullPage: fullPage ?? false,
          data: screenshot,
          encoding: 'base64',
          mimeType: 'image/png',
        },
        null,
        2,
      ),
    };
  }

  /**
   * Click an element identified by a CSS selector.
   */
  private async clickElement(selector: string): Promise<SendResult> {
    if (!selector) {
      return { success: false, message: 'CSS selector is required for click action' };
    }

    if (!this.page) {
      return { success: false, message: 'No active browser page' };
    }

    // Wait for the element to appear before clicking
    await this.page.waitForSelector(selector, {
      timeout: this.config?.defaultTimeout ?? 30000,
    });
    await this.page.click(selector);

    const currentUrl = this.page.url();
    const title = await this.page.title();

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'click',
          selector,
          url: currentUrl,
          title,
          status: 'clicked',
        },
        null,
        2,
      ),
    };
  }

  /**
   * Extract text content from the page or a specific element.
   * If no selector is provided, extracts all visible text from the body.
   */
  private async extractText(selector?: string): Promise<SendResult> {
    if (!this.page) {
      return { success: false, message: 'No active browser page' };
    }

    let text: string;

    if (selector) {
      // Wait for selector and extract its text content
      await this.page.waitForSelector(selector, {
        timeout: this.config?.defaultTimeout ?? 30000,
      });
      text = await this.page.$eval(selector, (el: Element) => el.textContent?.trim() ?? '');
    } else {
      // Execute in Puppeteer's page realm without referencing a browser global
      // from the Electron main-process adapter source.
      text = await this.page.$eval(
        'body',
        (element: Element) => (element as HTMLElement).innerText?.trim() ?? '',
      );
    }

    const currentUrl = this.page.url();
    const title = await this.page.title();

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'extract-text',
          selector: selector ?? 'body',
          url: currentUrl,
          title,
          text,
          length: text.length,
        },
        null,
        2,
      ),
    };
  }

  /**
   * Navigate back, forward, or reload the current page.
   */
  private async navigate(direction: 'back' | 'forward' | 'reload'): Promise<SendResult> {
    if (!this.page) {
      return { success: false, message: 'No active browser page' };
    }

    switch (direction) {
      case 'back':
        await this.page.goBack({ waitUntil: 'networkidle2' });
        break;
      case 'forward':
        await this.page.goForward({ waitUntil: 'networkidle2' });
        break;
      case 'reload':
        await this.page.reload({ waitUntil: 'networkidle2' });
        break;
    }

    const currentUrl = this.page.url();
    const title = await this.page.title();

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'navigate',
          direction,
          url: currentUrl,
          title,
          status: 'navigated',
        },
        null,
        2,
      ),
    };
  }

  /**
   * Type text into an element identified by a CSS selector.
   */
  private async typeText(selector: string, text: string): Promise<SendResult> {
    if (!selector) {
      return { success: false, message: 'CSS selector is required for type action' };
    }
    if (!text) {
      return { success: false, message: 'Text content is required for type action' };
    }

    if (!this.page) {
      return { success: false, message: 'No active browser page' };
    }

    await this.page.waitForSelector(selector, {
      timeout: this.config?.defaultTimeout ?? 30000,
    });
    await this.page.type(selector, text, { delay: 50 });

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'type',
          selector,
          text,
          status: 'typed',
        },
        null,
        2,
      ),
    };
  }

  /**
   * Evaluate a JavaScript expression in the page context.
   */
  private async evaluateScript(script: string): Promise<SendResult> {
    if (!script) {
      return { success: false, message: 'Script is required for evaluate action' };
    }

    if (!this.page) {
      return { success: false, message: 'No active browser page' };
    }

    // We use evaluate with a Function constructor to allow arbitrary expressions
    const result = await this.page.evaluate(
      // eslint-disable-next-line no-new-func
      new Function(`return (${script})`) as () => string,
    );

    return {
      success: true,
      message: JSON.stringify(
        {
          action: 'evaluate',
          script,
          result: typeof result === 'object' ? JSON.stringify(result) : String(result),
        },
        null,
        2,
      ),
    };
  }

  // ─── Private: Command parsing ─────────────────────────────────

  /**
   * Parse message content into a structured browser command.
   * Supports JSON-format commands and natural language patterns:
   * - "open <url>"
   * - "screenshot [full]"
   * - "click <selector>"
   * - "extract text [from <selector>]"
   * - "navigate back|forward|reload"
   * - "type <text> into <selector>"
   * - "evaluate <script>"
   */
  private parseCommand(content: string): BrowserCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as BrowserCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const trimmed = content.trim();

    // Pattern: "open <url>"
    const openMatch = trimmed.match(/^(?:open|goto|go\s+to|visit|load)\s+(.+)$/i);
    if (openMatch && openMatch[1]) {
      return { action: 'open', url: openMatch[1].trim() };
    }

    // Pattern: "screenshot [full|fullpage|full page]"
    const screenshotMatch = trimmed.match(
      /^(?:screenshot|capture|snap)(?:\s+(full|fullpage|full\s+page))?$/i,
    );
    if (screenshotMatch) {
      return { action: 'screenshot', fullPage: !!screenshotMatch[1] };
    }

    // Pattern: "click <selector>"
    const clickMatch = trimmed.match(/^click\s+(.+)$/i);
    if (clickMatch && clickMatch[1]) {
      return { action: 'click', selector: clickMatch[1].trim() };
    }

    // Pattern: "extract text [from <selector>]" or "get text [from <selector>]"
    const extractMatch = trimmed.match(
      /^(?:extract|get)\s+text(?:\s+(?:from|of|in)\s+(.+))?$/i,
    );
    if (extractMatch) {
      return { action: 'extract-text', selector: extractMatch[1]?.trim() };
    }

    // Pattern: "navigate back|forward|reload" or just "back|forward|reload"
    const navMatch = trimmed.match(
      /^(?:navigate\s+)?(back|forward|reload|refresh)$/i,
    );
    if (navMatch && navMatch[1]) {
      const dir = navMatch[1].toLowerCase();
      return {
        action: 'navigate',
        direction: dir === 'refresh' ? 'reload' : (dir as 'back' | 'forward' | 'reload'),
      };
    }

    // Pattern: "type <text> into <selector>" or "type <text> in <selector>"
    const typeMatch = trimmed.match(
      /^type\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+(?:into|in|to)\s+(.+)$/i,
    );
    if (typeMatch) {
      const text = typeMatch[1] || typeMatch[2] || typeMatch[3] || '';
      const selector = typeMatch[4] || '';
      return { action: 'type', selector: selector.trim(), text: text.trim() };
    }

    // Pattern: "evaluate <script>" or "eval <script>" or "run <script>"
    const evalMatch = trimmed.match(/^(?:evaluate|eval|run)\s+(.+)$/i);
    if (evalMatch && evalMatch[1]) {
      return { action: 'evaluate', script: evalMatch[1].trim() };
    }

    return null;
  }
}
