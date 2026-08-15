/**
 * Editor Model Store and Group State subsystem.
 *
 * Public API for canonical Editor_Model ownership and independent group view state.
 */

export { EditorModelStore } from './editor-model-store';
export type { ModelFactory, ModelLifecycleListener } from './editor-model-store';
export { EditorGroupStateManager, createDefaultViewState } from './editor-group-state';
export { canonicalizeUri } from './uri-canonicalization';
export { TabMetadataService, getLanguageIcon } from './tab-metadata-service';
export type { TabMetadata, DiagnosticsRegistry, ChangeSetRegistry, ModelRecordSource } from './tab-metadata-service';
export { RenameCoordinator } from './rename-coordinator';
export type {
  RenameLifecycleEvent,
  RenameLifecycleEventType,
  RenameLifecycleListener,
  RenameResult,
  DiagnosticsReferenceUpdater,
  ContextItemReferenceUpdater,
  ChangeSetReferenceUpdater,
  PathReservationService,
} from './rename-coordinator';
export { DivergenceDetector } from './divergence-detector';
export type {
  DivergenceType,
  DivergenceRecord,
  ResolutionAction,
  DivergenceResolution,
  ResolutionResult,
  FileMetadata,
  FileMetadataSource,
  EditorStateSource,
  DivergenceListener,
} from './divergence-detector';
export type {
  EditorModelRecord,
  EditorGroupDescriptor,
  ITextModel,
  ModelLifecycleEvent,
  ModelLifecycleEventType,
  ViewState,
  GroupTab,
} from './types';
export { EditorLayoutManager, computeSlots, getDefaultArrangement, getValidArrangements, MAX_GROUPS, MIN_GROUPS } from './editor-layout-manager';
export type {
  ArrangementType,
  LayoutSlot,
  LayoutTransitionResult,
  LayoutState,
} from './editor-layout-manager';
export { TabCommandService, TAB_COMMANDS } from './tab-command-service';
export type {
  TabEntry,
  ClosedTabRecord,
  TabCommand,
  TabCommandResult,
} from './tab-command-service';
export { NavigationService } from './navigation-service';
export type {
  NavigationSurfaceType,
  NavigationEntry,
  NavigationResult,
  NavigationFocusHandler,
} from './navigation-service';
export { SessionRestoreService } from './session-restore-service';
export type {
  PersistedGroupState,
  PersistedSessionState,
  SessionRestoreResult,
  SessionStorageAdapter,
} from './session-restore-service';
export { MissingFileHandler } from './missing-file-handler';
export type {
  MissingFileRecoveryAction,
  MissingFileState,
  MissingFileListener,
  FileExistenceChecker,
  FileLocator,
  CheckpointRestorer,
  TabRemover,
} from './missing-file-handler';
