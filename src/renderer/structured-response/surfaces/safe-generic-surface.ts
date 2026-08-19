/**
 * Inert fallback presentation for unsupported or malformed response content.
 *
 * The surface deliberately accepts only explicitly permitted presentation
 * fields. It never inspects raw response content, block kinds, render intents,
 * links, actions, or authority payloads. All untrusted text enters the DOM via
 * `textContent` and is bounded before an element is created.
 *
 * Requirements: 2.4, 2.6, 20.1–20.3, 20.8, 22.1, 22.6
 */

import type { ResponseBlockStatus } from '../../../harness/contracts/response-composition';

export type SafeGenericFallbackScope = 'block' | 'composition';

/**
 * Callers must copy only authority-permitted values into these fields. Unknown
 * is intentional: this is the final non-throwing boundary for malformed input.
 */
export interface SafeGenericSurfaceInput {
  readonly scope?: unknown;
  readonly status?: unknown;
  readonly permittedSummary?: unknown;
  readonly permittedContent?: unknown;
  readonly correlationId?: unknown;
}

export interface SafeGenericSurfaceOptions {
  readonly maxSummaryCharacters?: number;
  readonly maxContentCharacters?: number;
}

export interface SafeGenericSurfaceHandle {
  readonly element: HTMLElement;
  readonly scope: SafeGenericFallbackScope;
  readonly status: ResponseBlockStatus;
  readonly actions: readonly never[];
  dispose(): void;
}

export const SAFE_GENERIC_SUMMARY_CHARACTER_LIMIT = 512;
export const SAFE_GENERIC_CONTENT_CHARACTER_LIMIT = 4_096;
export const SAFE_GENERIC_CORRELATION_CHARACTER_LIMIT = 128;

const NO_ACTIONS: readonly never[] = Object.freeze([]);

const STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  ready: 'Ready',
  streaming: 'Streaming',
  stale: 'Stale',
  unavailable: 'Unavailable',
  terminal: 'Terminal',
} satisfies Readonly<Record<ResponseBlockStatus, string>>);

const VALID_STATUSES = new Set<ResponseBlockStatus>(
  Object.keys(STATUS_LABELS) as ResponseBlockStatus[],
);

function readOwnDataProperty(value: unknown, key: keyof SafeGenericSurfaceInput): unknown {
  try {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    // Proxies and hostile property descriptors must not escape the UI boundary.
    return undefined;
  }
}

function resolveScope(value: unknown): SafeGenericFallbackScope {
  return value === 'block' ? 'block' : 'composition';
}

function resolveStatus(value: unknown): ResponseBlockStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value as ResponseBlockStatus)
    ? value as ResponseBlockStatus
    : 'unavailable';
}

function resolveBound(value: unknown, fallback: number, absoluteMaximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fallback;
  }
  return Math.min(value, absoluteMaximum);
}

function boundText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function safeCorrelationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SAFE_GENERIC_CORRELATION_CHARACTER_LIMIT ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    return 'unavailable';
  }
  return value;
}

function appendLabeledText(
  parent: HTMLElement,
  className: string,
  label: string,
  value: string,
): void {
  const row = document.createElement('p');
  row.className = className;

  const labelElement = document.createElement('span');
  labelElement.className = `${className}__label`;
  labelElement.textContent = `${label}: `;

  const valueElement = document.createElement('span');
  valueElement.className = `${className}__value`;
  valueElement.textContent = value;

  row.append(labelElement, valueElement);
  parent.appendChild(row);
}

/**
 * Render a bounded, actionless fallback. This function is total for arbitrary
 * JavaScript values, including cyclic objects, accessors, and hostile proxies.
 */
export function renderSafeGenericSurface(
  input: unknown,
  options: SafeGenericSurfaceOptions = {},
): SafeGenericSurfaceHandle {
  const scope = resolveScope(readOwnDataProperty(input, 'scope'));
  const status = resolveStatus(readOwnDataProperty(input, 'status'));
  const correlationId = safeCorrelationId(readOwnDataProperty(input, 'correlationId'));
  const summaryLimit = resolveBound(
    options.maxSummaryCharacters,
    SAFE_GENERIC_SUMMARY_CHARACTER_LIMIT,
    SAFE_GENERIC_SUMMARY_CHARACTER_LIMIT,
  );
  const contentLimit = resolveBound(
    options.maxContentCharacters,
    SAFE_GENERIC_CONTENT_CHARACTER_LIMIT,
    SAFE_GENERIC_CONTENT_CHARACTER_LIMIT,
  );
  const summary = boundText(readOwnDataProperty(input, 'permittedSummary'), summaryLimit);
  const contentValue = readOwnDataProperty(input, 'permittedContent');
  const content = boundText(contentValue, contentLimit);

  const root = document.createElement('section');
  root.className = 'nn-safe-generic-surface';
  root.dataset.fallbackScope = scope;
  root.dataset.status = status;
  root.setAttribute('role', 'group');

  const scopeLabel = scope === 'block' ? 'Response block unavailable' : 'Response unavailable';
  const statusLabel = STATUS_LABELS[status];
  root.setAttribute(
    'aria-label',
    `${scopeLabel}. Status: ${statusLabel}. Correlation: ${correlationId}.`,
  );

  const heading = document.createElement('h3');
  heading.className = 'nn-safe-generic-surface__title';
  heading.textContent = scopeLabel;
  root.appendChild(heading);

  appendLabeledText(root, 'nn-safe-generic-surface__status', 'Status', statusLabel);

  if (summary !== undefined) {
    const summaryElement = document.createElement('p');
    summaryElement.className = 'nn-safe-generic-surface__summary';
    summaryElement.textContent = summary;
    root.appendChild(summaryElement);
  }

  const contentElement = document.createElement('div');
  contentElement.className = 'nn-safe-generic-surface__content';
  contentElement.textContent = content ?? (contentValue === undefined ? '' : 'Content unavailable.');
  if (contentElement.textContent !== '') {
    root.appendChild(contentElement);
  }

  appendLabeledText(
    root,
    'nn-safe-generic-surface__correlation',
    'Correlation',
    correlationId,
  );

  let disposed = false;
  return Object.freeze({
    element: root,
    scope,
    status,
    actions: NO_ACTIONS,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      root.remove();
      root.replaceChildren();
    },
  });
}

/** Closed surface adapter used by the response registry in later tasks. */
export const SafeGenericSurface = Object.freeze({
  render: renderSafeGenericSurface,
});
