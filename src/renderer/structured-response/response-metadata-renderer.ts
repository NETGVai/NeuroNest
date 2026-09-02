/** Metadata rendering shared by static and projection-driven chat shells. */

export const METADATA_CSS_CLASS = 'nn-structured-chat-shell__metadata';
export const METADATA_FIELD_CSS_CLASS = `${METADATA_CSS_CLASS}__field`;
export const METADATA_SEPARATOR_CSS_CLASS = `${METADATA_CSS_CLASS}__separator`;

export interface ChatMetadata {
  readonly agent?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly channel?: string;
  readonly branch?: string;
  readonly timestamp?: string;
}

const METADATA_FIELD_ORDER: ReadonlyArray<keyof ChatMetadata> = [
  'agent',
  'model',
  'provider',
  'channel',
  'branch',
  'timestamp',
];

function metadataFieldDisplayValue(field: keyof ChatMetadata, raw: string): string {
  return field === 'branch' ? `branch: ${raw}` : raw;
}

export function renderMetadata(metadata: ChatMetadata): HTMLElement | null {
  const entries: Array<{ field: keyof ChatMetadata; value: string }> = [];
  for (const field of METADATA_FIELD_ORDER) {
    const raw = metadata[field];
    if (typeof raw === 'string' && raw.length > 0) {
      entries.push({ field, value: raw });
    }
  }
  if (entries.length === 0) return null;

  const element = document.createElement('div');
  element.className = METADATA_CSS_CLASS;
  element.setAttribute('role', 'note');
  element.setAttribute('aria-label', 'Message metadata');
  element.style.display = 'flex';
  element.style.flexWrap = 'wrap';
  element.style.minWidth = '0';
  element.style.maxWidth = '100%';

  entries.forEach((entry, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = METADATA_SEPARATOR_CSS_CLASS;
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = ' · ';
      element.appendChild(separator);
    }

    const fieldElement =
      entry.field === 'timestamp'
        ? document.createElement('time')
        : document.createElement('span');
    fieldElement.className = `${METADATA_FIELD_CSS_CLASS} ${METADATA_FIELD_CSS_CLASS}--${entry.field}`;
    fieldElement.dataset['field'] = entry.field;
    fieldElement.style.minWidth = '0';
    fieldElement.style.maxWidth = '100%';
    if (entry.field === 'timestamp') {
      (fieldElement as HTMLTimeElement).dateTime = entry.value;
    }
    fieldElement.textContent = metadataFieldDisplayValue(entry.field, entry.value);
    element.appendChild(fieldElement);
  });

  return element;
}

/** Preserve the compact passthrough metadata shape used by projection nodes. */
export function renderProjectedAssistantMetadata(
  node: Readonly<Record<string, unknown>>,
): HTMLElement | null {
  const fields = ['agent', 'provider', 'model']
    .map((name) => node[name])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (fields.length === 0) return null;

  const element = document.createElement('div');
  element.className = METADATA_CSS_CLASS;
  element.style.minWidth = '0';
  element.style.maxWidth = '100%';
  element.style.overflowWrap = 'anywhere';

  fields.forEach((text, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = METADATA_SEPARATOR_CSS_CLASS;
      separator.textContent = ' · ';
      separator.setAttribute('aria-hidden', 'true');
      element.appendChild(separator);
    }
    const field = document.createElement('span');
    field.className = METADATA_FIELD_CSS_CLASS;
    field.textContent = text;
    element.appendChild(field);
  });

  return element;
}
