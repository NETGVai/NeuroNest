/**
 * Renderer mentions module — barrel export.
 *
 * Provides the complete renderer-side @-mentions integration:
 * - MentionIpcClient: IPC communication with main process
 * - MentionAutocompleteDropdown: Autocomplete dropdown UI
 * - MentionChipContainer: Clickable chip rendering
 * - MentionContextInjector: Token budget enforcement and context injection
 *
 * Requirements: 14.2, 14.3, 14.5, 14.7
 */

export {
  MentionIpcClient,
  getMentionIpcClient,
  resetMentionIpcClient,
  type MentionType,
  type MentionSuggestionItem,
  type ResolveMentionPayload,
  type ResolvedMentionContent,
  type ListMentionablesPayload,
} from './mention-ipc-client';

export {
  MentionAutocompleteDropdown,
  MENTION_DROPDOWN_STYLES,
  MENTION_TYPE_ICONS,
  MAX_VISIBLE_ITEMS,
  SUGGESTION_DEBOUNCE_MS,
  type MentionDropdownConfig,
  type MentionSelectCallback,
  type MentionDismissCallback,
} from './mention-autocomplete-dropdown';

export {
  MentionChipContainer,
  createMentionChip,
  MENTION_CHIP_STYLES,
  type MentionChipData,
  type ChipClickCallback,
  type ChipRemoveCallback,
} from './mention-chip';

export {
  MentionContextInjector,
  getMentionContextInjector,
  resetMentionContextInjector,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MENTION_BUDGET_FRACTION,
  BLOCK_START_MARKER,
  BLOCK_END_MARKER,
  type MentionInjectorConfig,
  type InjectedMention,
  type InjectionResult,
} from './mention-context-injector';
