//
// Renders a `DiffStreamFrame` into a DOM element using the existing
// chat-message component patterns. The outer container is a
// `.message-body` peer alongside the existing markdown content (mirrors
// Phase 2's media renderer placement). Pure DOM construction —
// `document.createElement` only; no IPC, no fetch, no network access.
//
// Validates: Requirements 3.3, 3.4, 3.8, 3.10, 3.11

import type { DiffStreamFrame } from './types';

export interface DiffRenderer {
  /**
   * Render a `DiffStreamFrame` into a DOM element. Reuses the chat-
   * message component patterns:
   *   - Outer container is a `.message-body` peer alongside the
   *     existing markdown content (mirrors Phase 2's media renderer
   *     placement) (Req 3.8).
   *   - Each line is a styled `<div>` with class `nn-diff-line` plus
   *     one of `nn-diff-added` (green) / `nn-diff-removed` (red) /
   *     `nn-diff-context` (Req 3.3).
   *   - Header bar shows "<n> lines changed" and, when
   *     `frame.toolName === 'editSpec'` and `frame.headingPath` is
   *     set, the heading-path label above the diff (Req 3.4, 3.11).
   *   - On `frame.cancelled`, a `.nn-diff-cancelled` indicator is
   *     appended at the bottom of the frame (Req 3.10).
   */
  render(frame: DiffStreamFrame): HTMLElement;
}

/**
 * Implementation of `DiffRenderer`. Stateless — every call to `render`
 * builds a fresh DOM element from the provided frame. Callers (the
 * chat-message component) are responsible for replacing the previous
 * frame's element when a new frame arrives.
 */
export const DiffRenderer: DiffRenderer = {
  render(frame: DiffStreamFrame): HTMLElement {
    const container = document.createElement('div');
    container.className = 'message-body nn-diff-stream';
    container.setAttribute('data-tool-call-id', frame.toolCallId);
    container.setAttribute('data-tool-name', frame.toolName);
    if (frame.stable) {
      container.setAttribute('data-stable', 'true');
    }

    // Heading-path label for editSpec (Req 3.11). Rendered ABOVE the
    // header bar so the path the agent is editing is the first thing
    // the reader sees, mirroring the Phase 1 HeadingEditTool's pre-
    // resolution chrome.
    if (frame.toolName === 'editSpec' && frame.headingPath) {
      const headingLabel = document.createElement('div');
      headingLabel.className = 'nn-diff-heading-path';
      headingLabel.textContent = frame.headingPath;
      container.appendChild(headingLabel);
    }

    // Header bar: "<n> lines changed" (Req 3.4).
    const header = document.createElement('div');
    header.className = 'nn-diff-header';
    const counter = document.createElement('span');
    counter.className = 'nn-diff-lines-changed';
    counter.textContent = `${frame.linesChanged} lines changed`;
    header.appendChild(counter);
    container.appendChild(header);

    // Diff body: one <div> per line with classes nn-diff-line plus one
    // of nn-diff-added / nn-diff-removed / nn-diff-context (Req 3.3).
    const body = document.createElement('div');
    body.className = 'nn-diff-body';
    for (const line of frame.lines) {
      const lineEl = document.createElement('div');
      lineEl.className = `nn-diff-line nn-diff-${line.kind}`;
      lineEl.textContent = line.text;
      body.appendChild(lineEl);
    }
    container.appendChild(body);

    // Cancellation indicator appended at the bottom (Req 3.10). The
    // partial diff above is retained — `frame.lines` already reflects
    // whatever was accumulated before the cancellation.
    if (frame.cancelled) {
      const cancelled = document.createElement('div');
      cancelled.className = 'nn-diff-cancelled';
      cancelled.textContent = 'Cancelled';
      container.appendChild(cancelled);
    }

    return container;
  },
};
