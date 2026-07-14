/**
 * WaveformVisualizer — Real-time waveform visualization during voice recording.
 *
 * Renders a canvas-based waveform animation that displays audio level (RMS)
 * values as they arrive from the main process. Provides a clear visual
 * indicator that recording is active with a stop button.
 *
 * Uses Vanilla JS + DOM manipulation (no React/Vue) per project renderer patterns.
 *
 * Requirements: 18.3
 */

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the waveform visualizer */
export interface WaveformVisualizerConfig {
  /** Width of the waveform canvas in pixels (default: 200) */
  width: number;
  /** Height of the waveform canvas in pixels (default: 40) */
  height: number;
  /** Number of bars to display in the waveform (default: 24) */
  barCount: number;
  /** Color of active waveform bars (default: '#ef4444' — red for recording) */
  barColor: string;
  /** Color of inactive/background bars (default: '#374151') */
  barBackgroundColor: string;
  /** Gap between bars in pixels (default: 2) */
  barGap: number;
}

/** Callback when stop button is clicked */
export type StopCallback = () => void;

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_WAVEFORM_CONFIG: WaveformVisualizerConfig = {
  width: 200,
  height: 40,
  barCount: 24,
  barColor: '#ef4444',
  barBackgroundColor: '#374151',
  barGap: 2,
};

/** CSS styles for the waveform container */
export const WAVEFORM_STYLES = `
.voice-waveform-container {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--bg-secondary, #1f2937);
  border: 1px solid var(--border-color, #374151);
  animation: voice-waveform-pulse 2s ease-in-out infinite;
}

.voice-waveform-container[data-hidden="true"] {
  display: none;
}

.voice-waveform-canvas {
  display: block;
}

.voice-waveform-stop-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: #ef4444;
  border: none;
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
}

.voice-waveform-stop-btn:hover {
  background: #dc2626;
}

.voice-waveform-stop-btn::after {
  content: '';
  display: block;
  width: 10px;
  height: 10px;
  background: white;
  border-radius: 2px;
}

.voice-waveform-recording-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
  animation: voice-recording-blink 1s ease-in-out infinite;
}

@keyframes voice-recording-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

@keyframes voice-waveform-pulse {
  0%, 100% { border-color: var(--border-color, #374151); }
  50% { border-color: #ef4444; }
}
`;

// ─── WaveformVisualizer Class ───────────────────────────────────

/**
 * Canvas-based waveform visualizer for voice recording feedback.
 *
 * Renders an animated bar chart of audio levels, providing visual
 * feedback that the microphone is active and capturing audio.
 *
 * Usage:
 *   const viz = new WaveformVisualizer();
 *   container.appendChild(viz.getElement());
 *   viz.show();
 *   viz.pushLevel(0.5); // Audio level from main process
 *   viz.hide();
 */
export class WaveformVisualizer {
  private config: WaveformVisualizerConfig;
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private stopButton: HTMLButtonElement;
  private recordingDot: HTMLElement;
  private levels: number[] = [];
  private animationFrame: number | null = null;
  private stopCallback: StopCallback | null = null;
  private stylesInjected = false;

  constructor(config?: Partial<WaveformVisualizerConfig>) {
    this.config = { ...DEFAULT_WAVEFORM_CONFIG, ...config };
    this.levels = new Array(this.config.barCount).fill(0);

    // Create container element
    this.container = document.createElement('div');
    this.container.className = 'voice-waveform-container';
    this.container.setAttribute('data-hidden', 'true');
    this.container.setAttribute('role', 'status');
    this.container.setAttribute('aria-label', 'Voice recording active');

    // Recording indicator dot
    this.recordingDot = document.createElement('div');
    this.recordingDot.className = 'voice-waveform-recording-indicator';
    this.recordingDot.setAttribute('aria-hidden', 'true');
    this.container.appendChild(this.recordingDot);

    // Canvas for waveform bars
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'voice-waveform-canvas';
    this.canvas.width = this.config.width;
    this.canvas.height = this.config.height;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d');

    // Stop button
    this.stopButton = document.createElement('button');
    this.stopButton.className = 'voice-waveform-stop-btn';
    this.stopButton.setAttribute('aria-label', 'Stop recording');
    this.stopButton.setAttribute('title', 'Stop recording');
    this.stopButton.addEventListener('click', () => {
      this.stopCallback?.();
    });
    this.container.appendChild(this.stopButton);

    this.injectStyles();
  }

  /**
   * Get the container DOM element to attach to the page.
   */
  getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Show the waveform visualizer and start the render loop.
   */
  show(): void {
    this.container.setAttribute('data-hidden', 'false');
    this.startRenderLoop();
  }

  /**
   * Hide the waveform visualizer and stop the render loop.
   */
  hide(): void {
    this.container.setAttribute('data-hidden', 'true');
    this.stopRenderLoop();
    this.resetLevels();
  }

  /**
   * Push a new audio level value (RMS 0-1) into the visualizer.
   * Shifts existing values left and adds the new value on the right.
   *
   * @param rms - Audio RMS level between 0 and 1
   */
  pushLevel(rms: number): void {
    const clampedRms = Math.max(0, Math.min(1, rms));
    this.levels.shift();
    this.levels.push(clampedRms);
  }

  /**
   * Register a callback for when the stop button is clicked.
   *
   * @param callback - Called when the user clicks the stop button
   */
  onStop(callback: StopCallback): void {
    this.stopCallback = callback;
  }

  /**
   * Check if the visualizer is currently visible.
   */
  isVisible(): boolean {
    return this.container.getAttribute('data-hidden') === 'false';
  }

  /**
   * Dispose the visualizer — remove from DOM and stop animation.
   */
  dispose(): void {
    this.stopRenderLoop();
    this.container.remove();
    this.stopCallback = null;
  }

  // ─── Internal Methods ─────────────────────────────────────────

  /** Reset all level values to zero */
  private resetLevels(): void {
    this.levels = new Array(this.config.barCount).fill(0);
    this.renderBars();
  }

  /** Start the rendering animation loop */
  private startRenderLoop(): void {
    if (this.animationFrame !== null) return;

    const render = (): void => {
      this.renderBars();
      this.animationFrame = requestAnimationFrame(render);
    };
    this.animationFrame = requestAnimationFrame(render);
  }

  /** Stop the rendering animation loop */
  private stopRenderLoop(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /** Render waveform bars to the canvas */
  private renderBars(): void {
    if (!this.ctx) return;

    const { width, height, barCount, barColor, barBackgroundColor, barGap } = this.config;
    const barWidth = (width - (barCount - 1) * barGap) / barCount;

    // Clear canvas
    this.ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + barGap);
      const level = this.levels[i] ?? 0;

      // Minimum bar height for visual presence
      const minBarHeight = 3;
      const maxBarHeight = height - 4;
      const barHeight = Math.max(minBarHeight, level * maxBarHeight);
      const y = (height - barHeight) / 2;

      // Draw background bar (full height, faded)
      this.ctx.fillStyle = barBackgroundColor;
      this.ctx.fillRect(x, (height - minBarHeight) / 2, barWidth, minBarHeight);

      // Draw active bar (proportional to level)
      this.ctx.fillStyle = barColor;
      this.ctx.fillRect(x, y, barWidth, barHeight);
    }
  }

  /** Inject CSS styles into the document head (once) */
  private injectStyles(): void {
    if (this.stylesInjected) return;
    if (typeof document === 'undefined') return;

    const existingStyle = document.getElementById('voice-waveform-styles');
    if (existingStyle) {
      this.stylesInjected = true;
      return;
    }

    const style = document.createElement('style');
    style.id = 'voice-waveform-styles';
    style.textContent = WAVEFORM_STYLES;
    document.head.appendChild(style);
    this.stylesInjected = true;
  }
}
