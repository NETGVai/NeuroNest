/**
 * Navigation module — Cross-surface navigation, deep links, bidirectional linking,
 * editor-to-chat context bridge, chat entity opening, taskbar selection filtering,
 * and gutter/overview indicators.
 *
 * Requirements: 10.9, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7
 */

export {
  CrossSurfaceLinkRegistry,
  type Surface,
  type LinkRelationship,
  type LinkEndpoint,
  type CrossSurfaceLink,
  type RenameEvent,
  type LinkQuery,
} from './cross-surface-link-registry';

export {
  DeepLinkService,
  type DeepLinkTarget,
  type DeepLinkHistoryEntry,
  type UriAliasResolver,
  type DeepLinkOptions,
} from './deep-link-service';

export {
  BidirectionalNavigator,
  type ResolvedNavigationTarget,
  type BidirectionalNavigationResult,
  type SurfaceNavigationHandler,
} from './bidirectional-navigator';

export {
  EditorToChatBridge,
  type ContextItem,
  type ContextItemKind,
  type SelectionInput,
  type SymbolInput,
  type DiagnosticInput,
  type FileInput,
  type HunkInput,
} from './editor-to-chat-bridge';

export {
  ChatEntityOpener,
  type ChatCitation,
  type CitedEntityKind,
  type OpenCitationResult,
  type ChatScrollState,
  type ChatScrollPreserver,
} from './chat-entity-opener';

export {
  TaskbarSelectionFilter,
  type FilterDecoration,
  type SelectionFilterState,
  type SelectionFilterListener,
  type EntityMetadataSource,
} from './taskbar-selection-filter';

export {
  GutterIndicatorService,
  type GutterIndicator,
  type GutterIndicatorKind,
  type OverviewRulerMark,
  type GutterPreferences,
  type GutterIndicatorListener,
} from './gutter-indicator-service';
