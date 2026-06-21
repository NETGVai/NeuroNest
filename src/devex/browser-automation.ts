/**
 * BrowserAutomation — Headless browser automation for UI verification.
 *
 * Provides screenshot capture, visual comparison via pixel diff, and
 * basic browser interactions (click, type, scroll, wait-for-element)
 * for verifying agent-generated web UI code against intent.
 *
 * Uses Playwright for headless Chromium when available, with a graceful
 * fallback that reports unavailability without crashing.
 *
 * Key behaviors:
 * - navigateTo() launches headless browser and loads target URL
 * - captureScreenshot() captures viewport or full-page screenshots
 * - compareScreenshots() performs pixel-level diff with configurable threshold
 * - executeScript() enables DOM interactions (click, type, scroll, waitForElement)
 * - Resources (browser, pages) are cleaned up after verification or timeout
 * - Graceful degradation when Playwright is not installed
 *
 * Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Interfaces ─────────────────────────────────────────────────

export interface BrowserAutomationConfig {
  /** Timeout in milliseconds for page navigation (default: 30000) */
  navigationTimeoutMs: number;
  /** Timeout in milliseconds for overall verification (default: 60000) */
  verificationTimeoutMs: number;
  /** Viewport width in pixels (default: 1280) */
  viewportWidth: number;
  /** Viewport height in pixels (default: 720) */
  viewportHeight: number;
  /** Whether to capture full page or just viewport (default: false) */
  fullPage: boolean;
  /** Directory to store screenshots (default: '.neuronest/screenshots/') */
  screenshotDir: string;
  /** Similarity threshold 0.0–1.0; below this is a mismatch (default: 0.95) */
  similarityThreshold: number;
  /** Whether to generate diff images on mismatch (default: true) */
  generateDiffImage: boolean;
}

export interface ScreenshotResult {
  /** Absolute path to the captured screenshot file */
  filePath: string;
  /** Width of the captured image in pixels */
  width: number;
  /** Height of the captured image in pixels */
  height: number;
  /** Timestamp of capture in ISO format */
  capturedAt: string;
  /** URL that was screenshotted */
  url: string;
  /** Raw pixel buffer (RGBA) for comparison, or null if not retained */
  buffer: Buffer | null;
}

export interface ComparisonResult {
  /** Similarity score between 0.0 (completely different) and 1.0 (identical) */
  similarity: number;
  /** Whether the comparison passed the configured threshold */
  passed: boolean;
  /** Number of pixels that differ between the two images */
  diffPixelCount: number;
  /** Total number of pixels compared */
  totalPixels: number;
  /** Path to the diff visualization image, or null if not generated */
  diffImagePath: string | null;
  /** Description of the discrepancy if comparison failed */
  discrepancy: string | null;
}

export interface BrowserInteraction {
  type: 'click' | 'type' | 'scroll' | 'wait-for-element';
  /** CSS selector for the target element */
  selector: string;
  /** Value for 'type' interactions */
  value?: string;
  /** Scroll direction and amount for 'scroll' interactions */
  scrollDelta?: { x: number; y: number };
  /** Timeout in ms for 'wait-for-element' (default: 5000) */
  timeout?: number;
}

export interface ScriptExecutionResult {
  success: boolean;
  /** Return value from the interaction or script */
  result: unknown;
  /** Error message if the interaction failed */
  error: string | null;
  /** Duration of the interaction in milliseconds */
  durationMs: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CONFIG: BrowserAutomationConfig = {
  navigationTimeoutMs: 30_000,
  verificationTimeoutMs: 60_000,
  viewportWidth: 1280,
  viewportHeight: 720,
  fullPage: false,
  screenshotDir: '.neuronest/screenshots/',
  similarityThreshold: 0.95,
  generateDiffImage: true,
};

/** Pixel difference threshold per channel (0–255) to consider pixels different */
const PIXEL_DIFF_TOLERANCE = 10;

// ─── Playwright Type Abstractions ───────────────────────────────

/**
 * Minimal type interfaces for Playwright to avoid hard dependency.
 * These mirror the subset of Playwright API we use.
 */
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  evaluate(fn: string | ((...args: unknown[]) => unknown), ...args: unknown[]): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launch(options?: { headless?: boolean }): Promise<PlaywrightBrowser>;
}

// ─── BrowserAutomation Class ────────────────────────────────────

export class BrowserAutomation {
  private config: BrowserAutomationConfig;
  private browser: PlaywrightBrowser | null = null;
  private page: PlaywrightPage | null = null;
  private playwrightAvailable: boolean | null = null;
  private currentUrl: string | null = null;
  private verificationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<BrowserAutomationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Check if Playwright is available in the environment.
   * Caches the result after first check.
   */
  isAvailable(): boolean {
    if (this.playwrightAvailable !== null) {
      return this.playwrightAvailable;
    }
    this.playwrightAvailable = this.checkPlaywrightAvailability();
    return this.playwrightAvailable;
  }

  /**
   * Navigate to a URL, launching a headless browser if needed.
   * Returns true on successful navigation, false if browser is unavailable.
   *
   * Requirements: 29.1
   */
  async navigateTo(url: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await this.ensureBrowser();

      if (!this.page) {
        return false;
      }

      await this.page.goto(url, {
        timeout: this.config.navigationTimeoutMs,
        waitUntil: 'networkidle',
      });

      this.currentUrl = url;
      this.startVerificationTimeout();
      return true;
    } catch (error) {
      // Navigation failure — return false rather than throw
      return false;
    }
  }

  /**
   * Capture a screenshot of the current page.
   * Returns the ScreenshotResult with file path and metadata, or null if unavailable.
   *
   * Requirements: 29.1
   */
  async captureScreenshot(filename?: string): Promise<ScreenshotResult | null> {
    if (!this.page || !this.currentUrl) {
      return null;
    }

    const screenshotDir = path.resolve(this.config.screenshotDir);
    fs.mkdirSync(screenshotDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resolvedFilename = filename ?? `screenshot-${timestamp}.png`;
    const filePath = path.join(screenshotDir, resolvedFilename);

    try {
      const buffer = await this.page.screenshot({
        path: filePath,
        fullPage: this.config.fullPage,
      });

      return {
        filePath,
        width: this.config.viewportWidth,
        height: this.config.viewportHeight,
        capturedAt: new Date().toISOString(),
        url: this.currentUrl,
        buffer,
      };
    } catch {
      return null;
    }
  }

  /**
   * Compare two screenshots using pixel-level diff.
   * Returns a ComparisonResult with similarity score and optional diff image.
   *
   * The comparison uses per-channel RGBA tolerance to account for
   * minor rendering differences across platforms.
   *
   * Requirements: 29.2, 29.3
   */
  compareScreenshots(
    actual: ScreenshotResult,
    reference: ScreenshotResult,
  ): ComparisonResult {
    // If buffers are not available, attempt to read from files
    const actualBuffer = actual.buffer ?? this.readImageBuffer(actual.filePath);
    const referenceBuffer = reference.buffer ?? this.readImageBuffer(reference.filePath);

    if (!actualBuffer || !referenceBuffer) {
      return {
        similarity: 0,
        passed: false,
        diffPixelCount: 0,
        totalPixels: 0,
        diffImagePath: null,
        discrepancy: 'Unable to read screenshot buffers for comparison',
      };
    }

    // Perform pixel-level comparison on raw RGBA buffers
    const result = this.pixelDiff(actualBuffer, referenceBuffer);

    const passed = result.similarity >= this.config.similarityThreshold;

    let diffImagePath: string | null = null;
    if (!passed && this.config.generateDiffImage) {
      diffImagePath = this.generateDiff(
        actualBuffer,
        referenceBuffer,
        result.totalPixels,
      );
    }

    return {
      similarity: result.similarity,
      passed,
      diffPixelCount: result.diffPixelCount,
      totalPixels: result.totalPixels,
      diffImagePath,
      discrepancy: passed
        ? null
        : `Visual mismatch: ${(result.similarity * 100).toFixed(1)}% similar (threshold: ${(this.config.similarityThreshold * 100).toFixed(1)}%). ${result.diffPixelCount} pixels differ out of ${result.totalPixels}.`,
    };
  }

  /**
   * Execute a browser interaction (click, type, scroll, wait-for-element).
   * Provides basic DOM interactions for verifying interactive components.
   *
   * Requirements: 29.4
   */
  async executeScript(interaction: BrowserInteraction): Promise<ScriptExecutionResult> {
    if (!this.page) {
      return {
        success: false,
        result: null,
        error: 'No browser page available. Call navigateTo() first.',
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      let result: unknown = null;

      switch (interaction.type) {
        case 'click':
          await this.page.click(interaction.selector, {
            timeout: interaction.timeout ?? 5000,
          });
          result = { clicked: interaction.selector };
          break;

        case 'type':
          await this.page.fill(interaction.selector, interaction.value ?? '', {
            timeout: interaction.timeout ?? 5000,
          });
          result = { typed: interaction.value, into: interaction.selector };
          break;

        case 'scroll': {
          const delta = interaction.scrollDelta ?? { x: 0, y: 300 };
          await this.page.evaluate(
            `window.scrollBy(${delta.x}, ${delta.y})`,
          );
          result = { scrolled: delta };
          break;
        }

        case 'wait-for-element':
          await this.page.waitForSelector(interaction.selector, {
            timeout: interaction.timeout ?? 5000,
          });
          result = { found: interaction.selector };
          break;

        default:
          return {
            success: false,
            result: null,
            error: `Unknown interaction type: ${(interaction as BrowserInteraction).type}`,
            durationMs: Date.now() - startTime,
          };
      }

      return {
        success: true,
        result,
        error: null,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        result: null,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Terminate the browser instance and release all resources.
   * Safe to call multiple times.
   *
   * Requirements: 29.5
   */
  async cleanup(): Promise<void> {
    this.clearVerificationTimeout();

    if (this.page) {
      try {
        await this.page.close();
      } catch {
        // Ignore close errors
      }
      this.page = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Ignore close errors
      }
      this.browser = null;
    }

    this.currentUrl = null;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): BrowserAutomationConfig {
    return { ...this.config };
  }

  /**
   * Update configuration. Does not affect an already-running browser session.
   */
  updateConfig(update: Partial<BrowserAutomationConfig>): void {
    this.config = { ...this.config, ...update };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Check if Playwright is available by attempting dynamic require.
   * Returns false gracefully if not installed.
   */
  private checkPlaywrightAvailability(): boolean {
    try {
      // Dynamic require to avoid hard dependency
      require.resolve('playwright-core');
      return true;
    } catch {
      try {
        require.resolve('playwright');
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Ensure browser and page are initialized.
   * Lazily launches headless Chromium via Playwright.
   */
  private async ensureBrowser(): Promise<void> {
    if (this.browser && this.page) {
      return;
    }

    let chromium: PlaywrightChromium;
    try {
      // Try playwright-core first (lighter, no bundled browsers)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pw = require('playwright-core');
      chromium = pw.chromium;
    } catch {
      try {
        // Fall back to full playwright package
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pw = require('playwright');
        chromium = pw.chromium;
      } catch {
        this.playwrightAvailable = false;
        return;
      }
    }

    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage();
    await this.page.setViewportSize({
      width: this.config.viewportWidth,
      height: this.config.viewportHeight,
    });
  }

  /**
   * Start the overall verification timeout. When it fires, resources are cleaned up.
   *
   * Requirements: 29.5
   */
  private startVerificationTimeout(): void {
    this.clearVerificationTimeout();
    this.verificationTimer = setTimeout(() => {
      void this.cleanup();
    }, this.config.verificationTimeoutMs);
  }

  /**
   * Clear the verification timeout timer.
   */
  private clearVerificationTimeout(): void {
    if (this.verificationTimer) {
      clearTimeout(this.verificationTimer);
      this.verificationTimer = null;
    }
  }

  /**
   * Read a raw image buffer from a file path.
   * Returns null if the file cannot be read.
   */
  private readImageBuffer(filePath: string): Buffer | null {
    try {
      return fs.readFileSync(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Perform pixel-level comparison of two RGBA buffers.
   * Accounts for minor rendering differences using a per-channel tolerance.
   *
   * For PNG files (which have headers), this compares the raw bytes directly.
   * For raw RGBA buffers (from Playwright), compares 4 bytes per pixel.
   */
  private pixelDiff(
    actual: Buffer,
    reference: Buffer,
  ): { similarity: number; diffPixelCount: number; totalPixels: number } {
    // Use the smaller buffer length to determine comparison range
    const compareLength = Math.min(actual.length, reference.length);

    // Determine total pixels (4 bytes per pixel in RGBA)
    const totalPixels = Math.floor(compareLength / 4);

    if (totalPixels === 0) {
      // Empty buffers are considered identical
      return { similarity: 1.0, diffPixelCount: 0, totalPixels: 0 };
    }

    let diffPixelCount = 0;

    for (let i = 0; i < totalPixels; i++) {
      const offset = i * 4;

      // Compare each RGBA channel with tolerance
      const rDiff = Math.abs(actual[offset] - reference[offset]);
      const gDiff = Math.abs(actual[offset + 1] - reference[offset + 1]);
      const bDiff = Math.abs(actual[offset + 2] - reference[offset + 2]);
      const aDiff = Math.abs(actual[offset + 3] - reference[offset + 3]);

      if (
        rDiff > PIXEL_DIFF_TOLERANCE ||
        gDiff > PIXEL_DIFF_TOLERANCE ||
        bDiff > PIXEL_DIFF_TOLERANCE ||
        aDiff > PIXEL_DIFF_TOLERANCE
      ) {
        diffPixelCount++;
      }
    }

    // Account for size difference as additional diff pixels
    if (actual.length !== reference.length) {
      const extraPixels = Math.abs(actual.length - reference.length) / 4;
      diffPixelCount += Math.floor(extraPixels);
    }

    const effectiveTotal = Math.max(
      totalPixels,
      Math.floor(Math.max(actual.length, reference.length) / 4),
    );

    const similarity =
      effectiveTotal > 0 ? 1 - diffPixelCount / effectiveTotal : 1.0;

    return {
      similarity: Math.max(0, Math.min(1, similarity)),
      diffPixelCount,
      totalPixels: effectiveTotal,
    };
  }

  /**
   * Generate a diff visualization image (raw RGBA buffer) and save it to disk.
   * Diff pixels are highlighted in red (255, 0, 0, 255).
   * Returns the file path to the diff image, or null on failure.
   */
  private generateDiff(
    actual: Buffer,
    reference: Buffer,
    _totalPixels: number,
  ): string | null {
    try {
      const screenshotDir = path.resolve(this.config.screenshotDir);
      fs.mkdirSync(screenshotDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const diffPath = path.join(screenshotDir, `diff-${timestamp}.raw`);

      const compareLength = Math.min(actual.length, reference.length);
      const diffBuffer = Buffer.alloc(compareLength);

      for (let i = 0; i < compareLength; i += 4) {
        const rDiff = Math.abs(actual[i] - reference[i]);
        const gDiff = Math.abs(actual[i + 1] - reference[i + 1]);
        const bDiff = Math.abs(actual[i + 2] - reference[i + 2]);
        const aDiff = Math.abs(actual[i + 3] - reference[i + 3]);

        if (
          rDiff > PIXEL_DIFF_TOLERANCE ||
          gDiff > PIXEL_DIFF_TOLERANCE ||
          bDiff > PIXEL_DIFF_TOLERANCE ||
          aDiff > PIXEL_DIFF_TOLERANCE
        ) {
          // Highlight diff pixels in red
          diffBuffer[i] = 255;     // R
          diffBuffer[i + 1] = 0;   // G
          diffBuffer[i + 2] = 0;   // B
          diffBuffer[i + 3] = 255; // A
        } else {
          // Dimmed original pixel for non-diff areas
          diffBuffer[i] = Math.floor(actual[i] * 0.3);
          diffBuffer[i + 1] = Math.floor(actual[i + 1] * 0.3);
          diffBuffer[i + 2] = Math.floor(actual[i + 2] * 0.3);
          diffBuffer[i + 3] = 255;
        }
      }

      fs.writeFileSync(diffPath, diffBuffer);
      return diffPath;
    } catch {
      return null;
    }
  }
}
