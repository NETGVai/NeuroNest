/**
 * CapabilityRegistry — Capability-driven provider registration.
 *
 * Registers providers (diagnostics, navigation, symbols, signature help,
 * rename, code actions, formatting, etc.) only when advertised by the server.
 * Non-advertised capabilities result in disabled/unavailable actions.
 *
 * Requirements: 3.3, 3.4
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * LSP server capabilities as advertised during initialization.
 * Maps to the standard ServerCapabilities from the LSP protocol.
 */
export interface ServerCapabilities {
  /** Diagnostics support (typically always present) */
  diagnosticsProvider?: boolean;
  /** Hover information */
  hoverProvider?: boolean;
  /** Code completion */
  completionProvider?: CompletionOptions;
  /** Go to definition */
  definitionProvider?: boolean;
  /** Go to declaration */
  declarationProvider?: boolean;
  /** Go to type definition */
  typeDefinitionProvider?: boolean;
  /** Find references */
  referencesProvider?: boolean;
  /** Document symbols (outline) */
  documentSymbolProvider?: boolean;
  /** Workspace symbols (global search) */
  workspaceSymbolProvider?: boolean;
  /** Signature help */
  signatureHelpProvider?: SignatureHelpOptions;
  /** Rename support */
  renameProvider?: boolean | RenameOptions;
  /** Code actions (quickfix, refactor, etc.) */
  codeActionProvider?: boolean | CodeActionOptions;
  /** Document formatting */
  documentFormattingProvider?: boolean;
  /** Document range formatting */
  documentRangeFormattingProvider?: boolean;
  /** On-type formatting */
  documentOnTypeFormattingProvider?: OnTypeFormattingOptions;
  /** Code lens */
  codeLensProvider?: CodeLensOptions;
  /** Document links */
  documentLinkProvider?: boolean;
  /** Folding ranges */
  foldingRangeProvider?: boolean;
  /** Selection ranges */
  selectionRangeProvider?: boolean;
  /** Inlay hints */
  inlayHintProvider?: boolean;
  /** Semantic tokens */
  semanticTokensProvider?: boolean;
}

/** Completion provider options */
export interface CompletionOptions {
  triggerCharacters?: string[];
  resolveProvider?: boolean;
}

/** Signature help options */
export interface SignatureHelpOptions {
  triggerCharacters?: string[];
  retriggerCharacters?: string[];
}

/** Rename options */
export interface RenameOptions {
  prepareProvider?: boolean;
}

/** Code action options */
export interface CodeActionOptions {
  codeActionKinds?: string[];
  resolveProvider?: boolean;
}

/** On-type formatting options */
export interface OnTypeFormattingOptions {
  firstTriggerCharacter: string;
  moreTriggerCharacter?: string[];
}

/** Code lens options */
export interface CodeLensOptions {
  resolveProvider?: boolean;
}

/** Standard capability identifiers */
export type CapabilityId =
  | 'diagnostics'
  | 'hover'
  | 'completion'
  | 'definition'
  | 'declaration'
  | 'typeDefinition'
  | 'references'
  | 'documentSymbols'
  | 'workspaceSymbols'
  | 'signatureHelp'
  | 'rename'
  | 'codeActions'
  | 'formatting'
  | 'rangeFormatting'
  | 'onTypeFormatting'
  | 'codeLens'
  | 'documentLinks'
  | 'foldingRanges'
  | 'selectionRanges'
  | 'inlayHints'
  | 'semanticTokens';

/** Registration state for a single capability */
export interface CapabilityRegistration {
  id: CapabilityId;
  available: boolean;
  options?: unknown;
  registeredAt: number | null;
}

// ─── CapabilityRegistry ─────────────────────────────────────────

/**
 * CapabilityRegistry — Manages advertised server capabilities.
 *
 * Tracks which capabilities a language server advertises and controls
 * provider registration. Only registers providers for advertised capabilities.
 *
 * Requirements: 3.3, 3.4
 */
export class CapabilityRegistry {
  private registrations: Map<CapabilityId, CapabilityRegistration> = new Map();

  constructor() {
    // Initialize all capabilities as unavailable
    this.initializeDefaults();
  }

  // ─── Initialization ─────────────────────────────────────────────

  /**
   * Initialize all capabilities to unavailable state.
   */
  private initializeDefaults(): void {
    const allCapabilities: CapabilityId[] = [
      'diagnostics',
      'hover',
      'completion',
      'definition',
      'declaration',
      'typeDefinition',
      'references',
      'documentSymbols',
      'workspaceSymbols',
      'signatureHelp',
      'rename',
      'codeActions',
      'formatting',
      'rangeFormatting',
      'onTypeFormatting',
      'codeLens',
      'documentLinks',
      'foldingRanges',
      'selectionRanges',
      'inlayHints',
      'semanticTokens',
    ];

    for (const id of allCapabilities) {
      this.registrations.set(id, {
        id,
        available: false,
        options: undefined,
        registeredAt: null,
      });
    }
  }

  // ─── Registration ───────────────────────────────────────────────

  /**
   * Register capabilities from the server's initialization response.
   * Only marks capabilities as available when the server advertises them.
   *
   * Requirements: 3.3, 3.4
   */
  registerCapabilities(capabilities: ServerCapabilities): void {
    const now = Date.now();

    this.updateCapability('diagnostics', capabilities.diagnosticsProvider, now);
    this.updateCapability('hover', capabilities.hoverProvider, now);
    this.updateCapability('completion', capabilities.completionProvider, now, capabilities.completionProvider);
    this.updateCapability('definition', capabilities.definitionProvider, now);
    this.updateCapability('declaration', capabilities.declarationProvider, now);
    this.updateCapability('typeDefinition', capabilities.typeDefinitionProvider, now);
    this.updateCapability('references', capabilities.referencesProvider, now);
    this.updateCapability('documentSymbols', capabilities.documentSymbolProvider, now);
    this.updateCapability('workspaceSymbols', capabilities.workspaceSymbolProvider, now);
    this.updateCapability('signatureHelp', capabilities.signatureHelpProvider, now, capabilities.signatureHelpProvider);
    this.updateCapability('rename', capabilities.renameProvider, now, typeof capabilities.renameProvider === 'object' ? capabilities.renameProvider : undefined);
    this.updateCapability('codeActions', capabilities.codeActionProvider, now, typeof capabilities.codeActionProvider === 'object' ? capabilities.codeActionProvider : undefined);
    this.updateCapability('formatting', capabilities.documentFormattingProvider, now);
    this.updateCapability('rangeFormatting', capabilities.documentRangeFormattingProvider, now);
    this.updateCapability('onTypeFormatting', capabilities.documentOnTypeFormattingProvider, now, capabilities.documentOnTypeFormattingProvider);
    this.updateCapability('codeLens', capabilities.codeLensProvider, now, capabilities.codeLensProvider);
    this.updateCapability('documentLinks', capabilities.documentLinkProvider, now);
    this.updateCapability('foldingRanges', capabilities.foldingRangeProvider, now);
    this.updateCapability('selectionRanges', capabilities.selectionRangeProvider, now);
    this.updateCapability('inlayHints', capabilities.inlayHintProvider, now);
    this.updateCapability('semanticTokens', capabilities.semanticTokensProvider, now);
  }

  /**
   * Update a single capability registration.
   */
  private updateCapability(
    id: CapabilityId,
    advertised: unknown,
    timestamp: number,
    options?: unknown,
  ): void {
    const available = advertised !== undefined && advertised !== null && advertised !== false;
    this.registrations.set(id, {
      id,
      available,
      options: available ? options : undefined,
      registeredAt: available ? timestamp : null,
    });
  }

  // ─── Queries ────────────────────────────────────────────────────

  /**
   * Check if a specific capability is available.
   *
   * Requirements: 3.3, 3.4
   */
  isAvailable(id: CapabilityId): boolean {
    return this.registrations.get(id)?.available ?? false;
  }

  /**
   * Get the registration for a specific capability.
   */
  getRegistration(id: CapabilityId): CapabilityRegistration | null {
    return this.registrations.get(id) ?? null;
  }

  /**
   * Get all available capabilities.
   */
  getAvailableCapabilities(): CapabilityId[] {
    const available: CapabilityId[] = [];
    for (const [id, reg] of this.registrations) {
      if (reg.available) {
        available.push(id);
      }
    }
    return available;
  }

  /**
   * Get all unavailable capabilities.
   */
  getUnavailableCapabilities(): CapabilityId[] {
    const unavailable: CapabilityId[] = [];
    for (const [id, reg] of this.registrations) {
      if (!reg.available) {
        unavailable.push(id);
      }
    }
    return unavailable;
  }

  /**
   * Get all registrations as a snapshot.
   */
  getAllRegistrations(): Map<CapabilityId, CapabilityRegistration> {
    return new Map(this.registrations);
  }

  /**
   * Get the capability set as a simple record.
   */
  getCapabilitySet(): Record<CapabilityId, boolean> {
    const set: Partial<Record<CapabilityId, boolean>> = {};
    for (const [id, reg] of this.registrations) {
      set[id] = reg.available;
    }
    return set as Record<CapabilityId, boolean>;
  }

  /**
   * Get options for a specific capability (e.g., trigger characters).
   */
  getOptions<T = unknown>(id: CapabilityId): T | null {
    const reg = this.registrations.get(id);
    if (!reg || !reg.available) return null;
    return (reg.options as T) ?? null;
  }

  // ─── Mutation ───────────────────────────────────────────────────

  /**
   * Unregister all capabilities (e.g., on server shutdown).
   */
  unregisterAll(): void {
    this.initializeDefaults();
  }

  /**
   * Mark a specific capability as unavailable (e.g., dynamic unregistration).
   */
  unregister(id: CapabilityId): void {
    this.registrations.set(id, {
      id,
      available: false,
      options: undefined,
      registeredAt: null,
    });
  }
}
