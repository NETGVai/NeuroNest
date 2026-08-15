/**
 * Types for the EditorModelStore and EditorGroupState subsystem.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.9
 */

/** Lifecycle events emitted by EditorModelStore. */
export type ModelLifecycleEventType = 'modelCreated' | 'modelDisposed';

export interface ModelLifecycleEvent {
  type: ModelLifecycleEventType;
  canonicalUri: string;
  documentVersion: number;
  timestamp: number;
}

/** A minimal Monaco text model interface for decoupling from the real Monaco API. */
export interface ITextModel {
  uri: string;
  getValue(): string;
  setValue(value: string): void;
  getVersionId(): number;
  dispose(): void;
  onDidChangeContent(listener: () => void): { dispose(): void };
}

/** Record maintained per canonical URI in the EditorModelStore. */
export interface EditorModelRecord {
  canonicalUri: string;
  model: ITextModel;
  documentVersion: number;
  referenceCount: number;
  disposed: boolean;
}

/** View state for one model in one group. */
export interface ViewState {
  cursorPosition: { lineNumber: number; column: number };
  selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null;
  scrollTop: number;
  scrollLeft: number;
  foldedRegions: number[];
}

/** A tab entry within a group. */
export interface GroupTab {
  canonicalUri: string;
  viewState: ViewState;
}

/** State for a single editor group. */
export interface EditorGroupDescriptor {
  groupId: string;
  tabs: Map<string, ViewState>;
  activeUri: string | null;
}
