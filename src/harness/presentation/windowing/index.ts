/**
 * Bounded Timeline Windowing Module
 *
 * Provides bounded rendering with Semantic_Anchor control, reader-owned
 * scroll behavior, and projected-order keyboard navigation for the
 * harness Chat_Interface.
 *
 * Requirements: 35.7–35.10, 35.22–35.23, 42.9, 47.2–47.8, 47.17
 */

export {
  SemanticAnchorSchema,
  WindowingBoundsSchema,
  type SemanticAnchor,
  type WindowingBounds,
  type ProjectedNodeDescriptor,
  type WindowedRange,
  type AnchorResolutionResult,
  type ReaderScrollMode,
  type PageRequest,
  type PageDirection,
  type AnchorUnavailableState,
} from './types';

export {
  WindowedTimelineEngine,
} from './windowed-timeline-engine';

export {
  SemanticAnchorController,
  type ViewportMeasurement,
} from './semantic-anchor-controller';

export {
  ReaderScrollController,
  type ScrollPositionProvider,
} from './reader-scroll-controller';

export {
  ProjectedKeyboardNavigator,
  type PageRequestHandler,
} from './projected-keyboard-navigator';
