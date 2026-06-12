/**
 * Editor core — Monaco editor initialization and lifecycle management.
 * Handles creating, disposing, and resizing the Monaco editor instance.
 * Manages model switching for multi-tab support.
 */

import type {
  CursorPosition,
  EditorConfig,
  EditorCoreEvent,
  EditorCoreListener,
  FileState,
  LanguageId,
  TabId,
} from './types';
import { DEFAULT_EDITOR_CONFIG } from './types';

/**
 * Minimal Monaco type stubs for compilation.
 * The actual Monaco API is loaded at runtime via the Monaco loader.
 */
interface MonacoEditorInstance {
  dispose(): void;
  getValue(): string;
  setValue(value: string): void;
  getModel(): MonacoModel | null;
  setModel(model: MonacoModel | null): void;
  layout(dimension?: { width: number; height: number }): void;
  focus(): void;
  getPosition(): { lineNumber: number; column: number } | null;
  getScrollTop(): number;
  setScrollTop(scrollTop: number): void;
  onDidChangeModelContent(listener: () => void): MonacoDisposable;
  onDidChangeCursorPosition(listener: (e: { position: { lineNumber: number; column: number } }) => void): MonacoDisposable;
  onDidFocusEditorWidget(listener: () => void): MonacoDisposable;
  onDidBlurEditorWidget(listener: () => void): MonacoDisposable;
  updateOptions(options: Record<string, unknown>): void;
  revealLineInCenter(line: number): void;
}

interface MonacoModel {
  dispose(): void;
  getValue(): string;
  setValue(value: string): void;
  uri: { path: string };
}

interface MonacoDisposable {
  dispose(): void;
}

interface MonacoAPI {
  editor: {
    create(container: HTMLElement, options: Record<string, unknown>): MonacoEditorInstance;
    createModel(value: string, language: string, uri?: unknown): MonacoModel;
    setTheme(theme: string): void;
  };
  Uri: {
    file(path: string): unknown;
  };
}

/**
 * EditorCore manages the Monaco editor instance lifecycle.
 * Supports model switching for multi-tab editing and handles resize events.
 */
export class EditorCore {
  private editor: MonacoEditorInstance | null = null;
  private monaco: MonacoAPI | null = null;
  private container: HTMLElement | null = null;
  private editorContainer: HTMLElement | null = null;
  private models: Map<TabId, MonacoModel> = new Map();
  private disposables: MonacoDisposable[] = [];
  private listeners: Set<EditorCoreListener> = new Set();
  private config: EditorConfig;
  private activeFileId: TabId | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private isDisposed = false;

  constructor(config?: Partial<EditorConfig>) {
    this.config = { ...DEFAULT_EDITOR_CONFIG, ...config };
  }

  /**
   * Mounts the editor core into the provided container.
   * Creates the DOM structure and initializes Monaco.
   */
  async mount(container: HTMLElement): Promise<void> {
    this.container = container;

    // Create the editor container element
    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'editor-core-container';
    Object.assign(this.editorContainer.style, {
      flex: '1',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      position: 'relative',
    });
    this.container.appendChild(this.editorContainer);

    // Load Monaco and create editor
    await this.initializeMonaco();
    this.setupResizeObserver();
  }

  /**
   * Disposes the editor instance, all models, and cleans up resources.
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    // Cleanup resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Dispose event listeners
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];

    // Dispose all models
    const models = Array.from(this.models.values());
    for (const model of models) {
      model.dispose();
    }
    this.models.clear();

    // Dispose editor
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }

    // Remove DOM
    if (this.editorContainer && this.container) {
      this.container.removeChild(this.editorContainer);
    }
    this.editorContainer = null;
    this.container = null;
    this.listeners.clear();
  }

  /**
   * Opens a file in the editor by creating/switching to its model.
   */
  openFile(fileState: FileState): void {
    const tabId = fileState.filePath;

    // Create model if it doesn't exist
    if (!this.models.has(tabId)) {
      this.createModel(tabId, fileState.content, fileState.language);
    }

    this.switchToModel(tabId);

    // Restore cursor and scroll position
    if (fileState.cursorLine > 0 && this.editor) {
      this.editor.revealLineInCenter(fileState.cursorLine);
    }
    if (fileState.scrollTop > 0 && this.editor) {
      this.editor.setScrollTop(fileState.scrollTop);
    }
  }

  /**
   * Closes the model associated with a file and disposes it.
   */
  closeFile(tabId: TabId): void {
    const model = this.models.get(tabId);
    if (model) {
      model.dispose();
      this.models.delete(tabId);
    }

    if (this.activeFileId === tabId) {
      this.activeFileId = null;
      if (this.editor) {
        this.editor.setModel(null);
      }
    }
  }

  /**
   * Switches the editor to display the model for the specified tab.
   */
  switchToModel(tabId: TabId): void {
    const model = this.models.get(tabId);
    if (!model || !this.editor) return;

    this.activeFileId = tabId;
    this.editor.setModel(model);
  }

  /**
   * Returns the current content of the active editor buffer.
   */
  getContent(): string | null {
    if (!this.editor) return null;
    return this.editor.getValue();
  }

  /**
   * Returns the content of a specific file model.
   */
  getFileContent(tabId: TabId): string | null {
    const model = this.models.get(tabId);
    return model ? model.getValue() : null;
  }

  /**
   * Returns the current cursor position.
   */
  getCursorPosition(): CursorPosition | null {
    if (!this.editor) return null;
    const pos = this.editor.getPosition();
    if (!pos) return null;
    return { line: pos.lineNumber, column: pos.column };
  }

  /**
   * Returns the current scroll top value.
   */
  getScrollTop(): number {
    return this.editor?.getScrollTop() ?? 0;
  }

  /**
   * Focuses the editor widget.
   */
  focus(): void {
    this.editor?.focus();
  }

  /**
   * Triggers a layout recalculation (call after container resize).
   */
  layout(): void {
    if (!this.editor || !this.editorContainer) return;

    const rect = this.editorContainer.getBoundingClientRect();
    this.editor.layout({ width: rect.width, height: rect.height });
  }

  /**
   * Updates editor options at runtime.
   */
  updateConfig(config: Partial<EditorConfig>): void {
    this.config = { ...this.config, ...config };

    if (this.editor) {
      this.editor.updateOptions(this.mapConfigToMonacoOptions(this.config));
    }

    if (config.theme && this.monaco) {
      this.monaco.editor.setTheme(config.theme);
    }
  }

  /**
   * Registers a listener for editor core events.
   */
  on(listener: EditorCoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns whether the editor has been initialized.
   */
  isReady(): boolean {
    return this.editor !== null && !this.isDisposed;
  }

  /**
   * Initializes the Monaco editor instance.
   * Attempts to load Monaco from the global scope or a CDN loader.
   */
  private async initializeMonaco(): Promise<void> {
    this.monaco = await this.loadMonaco();
    if (!this.monaco || !this.editorContainer) return;

    this.editor = this.monaco.editor.create(this.editorContainer, {
      ...this.mapConfigToMonacoOptions(this.config),
      automaticLayout: false,
      value: '',
      language: 'plaintext',
    });

    this.monaco.editor.setTheme(this.config.theme);
    this.attachEditorListeners();
  }

  /**
   * Loads the Monaco API from the global scope.
   * In production, Monaco is typically loaded via a script tag or the AMD loader.
   */
  private async loadMonaco(): Promise<MonacoAPI | null> {
    // Check if Monaco is already available globally
    const win = window as unknown as Record<string, unknown>;
    if (win.monaco) {
      return win.monaco as unknown as MonacoAPI;
    }

    // Attempt to load via require (AMD loader pattern)
    if (typeof win.require === 'function') {
      return new Promise<MonacoAPI | null>((resolve) => {
        try {
          (win.require as (deps: string[], cb: (monaco: MonacoAPI) => void) => void)(
            ['vs/editor/editor.main'],
            (monaco: MonacoAPI) => resolve(monaco),
          );
        } catch {
          resolve(null);
        }
      });
    }

    return null;
  }

  /**
   * Creates a Monaco model for a file.
   */
  private createModel(tabId: TabId, content: string, language: LanguageId): void {
    if (!this.monaco) return;

    const uri = this.monaco.Uri.file(tabId);
    const model = this.monaco.editor.createModel(content, language, uri);
    this.models.set(tabId, model);
  }

  /**
   * Attaches event listeners to the editor instance.
   */
  private attachEditorListeners(): void {
    if (!this.editor) return;

    // Content change
    const contentDisposable = this.editor.onDidChangeModelContent(() => {
      if (this.activeFileId && this.editor) {
        this.emit({
          type: 'content-changed',
          filePath: this.activeFileId,
          content: this.editor.getValue(),
        });
      }
    });
    this.disposables.push(contentDisposable);

    // Cursor position change
    const cursorDisposable = this.editor.onDidChangeCursorPosition((e) => {
      this.emit({
        type: 'cursor-changed',
        position: { line: e.position.lineNumber, column: e.position.column },
      });
    });
    this.disposables.push(cursorDisposable);

    // Focus
    const focusDisposable = this.editor.onDidFocusEditorWidget(() => {
      this.emit({ type: 'focus' });
    });
    this.disposables.push(focusDisposable);

    // Blur
    const blurDisposable = this.editor.onDidBlurEditorWidget(() => {
      this.emit({ type: 'blur' });
    });
    this.disposables.push(blurDisposable);
  }

  /**
   * Sets up a ResizeObserver to handle container resizing.
   */
  private setupResizeObserver(): void {
    if (!this.editorContainer) return;

    this.resizeObserver = new ResizeObserver(() => {
      this.layout();
    });
    this.resizeObserver.observe(this.editorContainer);
  }

  /**
   * Maps our EditorConfig to Monaco-compatible options.
   */
  private mapConfigToMonacoOptions(config: EditorConfig): Record<string, unknown> {
    return {
      fontSize: config.fontSize,
      tabSize: config.tabSize,
      insertSpaces: config.insertSpaces,
      wordWrap: config.wordWrap,
      wordWrapColumn: config.wordWrapColumn,
      minimap: { enabled: config.minimap },
      lineNumbers: config.lineNumbers,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true },
      padding: { top: 8 },
    };
  }

  private emit(event: EditorCoreEvent): void {
    const listeners = Array.from(this.listeners);
    for (const listener of listeners) {
      listener(event);
    }
  }
}
