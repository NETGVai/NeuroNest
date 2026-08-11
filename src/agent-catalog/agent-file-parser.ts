import { createHash } from 'node:crypto';

/** The six sections that form an imported agent's complete system prompt. */
export const REQUIRED_AGENT_SECTION_NAMES = [
  'Identity',
  'Core Mission',
  'Critical Rules',
  'Technical Deliverables',
  'Workflow Process',
  'Success Metrics',
] as const;

export type AgentSectionName = (typeof REQUIRED_AGENT_SECTION_NAMES)[number];
export type ParseStatus = 'success' | 'recovered' | 'failed';
export type StructuralCriterionName =
  | 'exactCount'
  | 'exactNames'
  | 'headingLevels'
  | 'uniqueness'
  | 'order'
  | 'nonWhitespaceContent';

export interface SourceRange {
  /** UTF-16 offsets into sourceText, suitable for String.slice. */
  readonly start: number;
  readonly end: number;
  /** UTF-8 byte offsets into sourceBytes. */
  readonly startByte: number;
  readonly endByte: number;
}

export interface FrontmatterField {
  readonly name: string;
  /** Exact text after the first colon, including whitespace and quotes. */
  readonly rawValue: string;
  /** Scalar value used by the compatibility importer. */
  readonly value: string;
  readonly line: number;
  readonly range: SourceRange;
  readonly valueRange: SourceRange;
}

export interface FrontmatterSnapshot {
  readonly present: boolean;
  /** True when both delimiters were found, even if recoverable field diagnostics exist. */
  readonly parseable: boolean;
  /** Exact UTF-8 bytes from the opening delimiter through its closing line ending. */
  readonly rawBytes: Uint8Array;
  readonly rawText: string;
  readonly range: SourceRange;
  readonly contentRange: SourceRange;
  readonly orderedFields: readonly FrontmatterField[];
  /** Last-value view retained for backward compatibility; orderedFields is authoritative. */
  readonly values: Readonly<Record<string, string>>;
  readonly identityDigest: string;
}

export interface HeadingToken {
  readonly level: number;
  readonly name: string;
  readonly raw: string;
  readonly line: number;
  readonly range: SourceRange;
  readonly canonicalSectionName: AgentSectionName | null;
}

export interface ExtractedAgentSection {
  readonly name: AgentSectionName;
  readonly heading: HeadingToken;
  readonly rawContent: string;
  readonly content: string;
  readonly bodyRange: SourceRange;
}

export interface ParserDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: SourceRange;
  /** True only when parsing may proceed using retained source evidence. */
  readonly recoverable: boolean;
}

export interface StructuralCriterionResult {
  readonly criterion: StructuralCriterionName;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface StructuralFinding {
  readonly code: string;
  readonly criterion: StructuralCriterionName;
  readonly message: string;
  readonly classification: 'blocking' | 'informational';
}

export interface StructuralValidation {
  readonly complete: true;
  readonly strictValid: boolean;
  readonly criteria: Readonly<Record<StructuralCriterionName, StructuralCriterionResult>>;
  readonly findings: readonly StructuralFinding[];
}

export interface ExtractionOverrideEvidence {
  readonly applied: boolean;
  readonly code: 'Extraction_Override';
  readonly recoveredSections: readonly AgentSectionName[];
  readonly reason: string;
}

export interface RecoverableParseFinding {
  readonly code: 'Recoverable_Parse_Finding';
  readonly diagnosticCode: string;
  readonly message: string;
}

export interface AgentFileParseResult {
  readonly sourceText: string;
  readonly sourceBytes: Uint8Array;
  readonly frontmatter: FrontmatterSnapshot;
  readonly body: string;
  readonly bodyRange: SourceRange;
  readonly headings: readonly HeadingToken[];
  /** Every required key is present; null means that section could not be extracted. */
  readonly sections: Readonly<Record<AgentSectionName, ExtractedAgentSection | null>>;
  /** Every required key is present; null means non-whitespace content was unavailable. */
  readonly sectionContents: Readonly<Record<AgentSectionName, string | null>>;
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly structural: StructuralValidation;
  readonly extractionComplete: boolean;
  readonly systemPrompt: string | null;
  readonly extractionOverride: ExtractionOverrideEvidence;
  readonly recoverableParseFindings: readonly RecoverableParseFinding[];
  readonly status: ParseStatus;
}

interface SourceLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly endWithBreak: number;
  readonly number: number;
}

const EMPTY_RANGE_OFFSETS = { start: 0, end: 0 };
const SECTION_NAME_BY_LOWER = new Map<string, AgentSectionName>(
  REQUIRED_AGENT_SECTION_NAMES.map((name) => [name.toLowerCase(), name]),
);

function byteOffset(sourceText: string, characterOffset: number): number {
  return Buffer.byteLength(sourceText.slice(0, characterOffset), 'utf8');
}

function makeRange(sourceText: string, start: number, end: number): SourceRange {
  return Object.freeze({
    start,
    end,
    startByte: byteOffset(sourceText, start),
    endByte: byteOffset(sourceText, end),
  });
}

function scanLines(sourceText: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let number = 1;

  while (start < sourceText.length) {
    let end = start;
    while (end < sourceText.length && sourceText[end] !== '\n' && sourceText[end] !== '\r') {
      end += 1;
    }

    let endWithBreak = end;
    if (sourceText[endWithBreak] === '\r' && sourceText[endWithBreak + 1] === '\n') {
      endWithBreak += 2;
    } else if (sourceText[endWithBreak] === '\r' || sourceText[endWithBreak] === '\n') {
      endWithBreak += 1;
    }

    lines.push({ text: sourceText.slice(start, end), start, end, endWithBreak, number });
    start = endWithBreak;
    number += 1;
  }

  if (sourceText.length === 0 || start === sourceText.length) {
    lines.push({ text: '', start, end: start, endWithBreak: start, number });
  }

  return lines;
}

function decodeScalar(rawValue: string): { value: string; diagnostic?: string } {
  const trimmed = rawValue.trim();
  if (trimmed.length < 2) {
    return { value: trimmed };
  }

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    if (trimmed.at(-1) !== quote) {
      return { value: trimmed.slice(1), diagnostic: 'Quoted frontmatter value is not terminated' };
    }
    return { value: trimmed.slice(1, -1) };
  }

  return { value: trimmed };
}

function canonicalSectionName(name: string): AgentSectionName | null {
  return SECTION_NAME_BY_LOWER.get(name.trim().toLowerCase()) ?? null;
}

function parseFrontmatter(
  sourceText: string,
  sourceBytes: Uint8Array,
  lines: readonly SourceLine[],
): { snapshot: FrontmatterSnapshot; bodyStart: number; diagnostics: ParserDiagnostic[] } {
  const diagnostics: ParserDiagnostic[] = [];
  const firstLine = lines[0];
  const hasBom = sourceText.charCodeAt(0) === 0xfeff;
  const delimiterText = hasBom ? firstLine?.text.slice(1) : firstLine?.text;

  if (!firstLine || delimiterText !== '---') {
    const range = makeRange(sourceText, EMPTY_RANGE_OFFSETS.start, EMPTY_RANGE_OFFSETS.end);
    diagnostics.push(Object.freeze({
      code: 'FRONTMATTER_MISSING',
      message: 'YAML frontmatter must begin with an exact --- delimiter',
      range,
      recoverable: false,
    }));
    return {
      snapshot: Object.freeze({
        present: false,
        parseable: false,
        rawBytes: new Uint8Array(),
        rawText: '',
        range,
        contentRange: range,
        orderedFields: Object.freeze([]),
        values: Object.freeze({}),
        identityDigest: createHash('sha256').update(new Uint8Array()).digest('hex'),
      }),
      bodyStart: 0,
      diagnostics,
    };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.text === '---');
  if (closingIndex < 0) {
    const range = makeRange(sourceText, firstLine.start, sourceText.length);
    diagnostics.push(Object.freeze({
      code: 'FRONTMATTER_UNTERMINATED',
      message: 'YAML frontmatter has no closing --- delimiter',
      range,
      recoverable: false,
    }));
    const rawBytes = Uint8Array.from(sourceBytes.subarray(range.startByte, range.endByte));
    return {
      snapshot: Object.freeze({
        present: true,
        parseable: false,
        rawBytes,
        rawText: sourceText.slice(range.start, range.end),
        range,
        contentRange: makeRange(sourceText, firstLine.endWithBreak, sourceText.length),
        orderedFields: Object.freeze([]),
        values: Object.freeze({}),
        identityDigest: createHash('sha256').update(rawBytes).digest('hex'),
      }),
      // Continue heading discovery even though frontmatter itself is unrecoverable.
      bodyStart: firstLine.endWithBreak,
      diagnostics,
    };
  }

  const closingLine = lines[closingIndex]!;
  const frontmatterRange = makeRange(sourceText, firstLine.start, closingLine.endWithBreak);
  const contentRange = makeRange(sourceText, firstLine.endWithBreak, closingLine.start);
  const rawBytes = Uint8Array.from(
    sourceBytes.subarray(frontmatterRange.startByte, frontmatterRange.endByte),
  );
  const orderedFields: FrontmatterField[] = [];
  const values: Record<string, string> = {};
  const seenNames = new Set<string>();

  for (const line of lines.slice(1, closingIndex)) {
    if (line.text.trim() === '' || line.text.trimStart().startsWith('#')) {
      continue;
    }

    const colonIndex = line.text.indexOf(':');
    if (colonIndex <= 0) {
      diagnostics.push(Object.freeze({
        code: 'FRONTMATTER_LINE_UNPARSED',
        message: `Frontmatter line ${line.number} is not a key-value field`,
        range: makeRange(sourceText, line.start, line.end),
        recoverable: true,
      }));
      continue;
    }

    const name = line.text.slice(0, colonIndex).trim();
    if (!name) {
      diagnostics.push(Object.freeze({
        code: 'FRONTMATTER_FIELD_NAME_EMPTY',
        message: `Frontmatter line ${line.number} has an empty field name`,
        range: makeRange(sourceText, line.start, line.end),
        recoverable: true,
      }));
      continue;
    }

    const valueStart = line.start + colonIndex + 1;
    const rawValue = line.text.slice(colonIndex + 1);
    const decoded = decodeScalar(rawValue);
    if (decoded.diagnostic) {
      diagnostics.push(Object.freeze({
        code: 'FRONTMATTER_VALUE_MALFORMED',
        message: `${decoded.diagnostic} on line ${line.number}`,
        range: makeRange(sourceText, valueStart, line.end),
        recoverable: true,
      }));
    }
    if (seenNames.has(name)) {
      diagnostics.push(Object.freeze({
        code: 'FRONTMATTER_FIELD_DUPLICATE',
        message: `Frontmatter field ${name} occurs more than once`,
        range: makeRange(sourceText, line.start, line.end),
        recoverable: true,
      }));
    }

    seenNames.add(name);
    values[name] = decoded.value;
    orderedFields.push(Object.freeze({
      name,
      rawValue,
      value: decoded.value,
      line: line.number,
      range: makeRange(sourceText, line.start, line.end),
      valueRange: makeRange(sourceText, valueStart, line.end),
    }));
  }

  return {
    snapshot: Object.freeze({
      present: true,
      parseable: true,
      rawBytes,
      rawText: sourceText.slice(frontmatterRange.start, frontmatterRange.end),
      range: frontmatterRange,
      contentRange,
      orderedFields: Object.freeze(orderedFields),
      values: Object.freeze(values),
      identityDigest: createHash('sha256').update(rawBytes).digest('hex'),
    }),
    bodyStart: closingLine.endWithBreak,
    diagnostics,
  };
}

function parseHeadingTokens(
  sourceText: string,
  lines: readonly SourceLine[],
  bodyStart: number,
): HeadingToken[] {
  const headings: HeadingToken[] = [];

  for (const line of lines) {
    if (line.start < bodyStart) {
      continue;
    }
    const match = /^( {0,3})(#{1,6})(?:[\t ]+|$)(.*)$/.exec(line.text);
    if (!match) {
      continue;
    }

    const rawName = match[3] ?? '';
    const name = rawName.replace(/[\t ]+#+[\t ]*$/, '').trim();
    headings.push(Object.freeze({
      level: match[2]!.length,
      name,
      raw: line.text,
      line: line.number,
      range: makeRange(sourceText, line.start, line.end),
      canonicalSectionName: canonicalSectionName(name),
    }));
  }

  return headings;
}

function extractSections(
  sourceText: string,
  headings: readonly HeadingToken[],
  bodyEnd: number,
): Readonly<Record<AgentSectionName, ExtractedAgentSection | null>> {
  const candidates = headings.filter(
    (heading): heading is HeadingToken & { canonicalSectionName: AgentSectionName } =>
      heading.canonicalSectionName !== null,
  );
  const result = {} as Record<AgentSectionName, ExtractedAgentSection | null>;

  for (const requiredName of REQUIRED_AGENT_SECTION_NAMES) {
    const matching = candidates.filter((heading) => heading.canonicalSectionName === requiredName);
    const extracted = matching.map((heading) => {
      const candidateIndex = candidates.indexOf(heading);
      const contentEnd = candidates[candidateIndex + 1]?.range.start ?? bodyEnd;
      const bodyRange = makeRange(sourceText, heading.range.end, contentEnd);
      return Object.freeze({
        name: requiredName,
        heading,
        rawContent: sourceText.slice(bodyRange.start, bodyRange.end),
        content: sourceText.slice(bodyRange.start, bodyRange.end).trim(),
        bodyRange,
      });
    });

    // Duplicate headings remain a structural finding. Prefer the first usable
    // occurrence so one blank duplicate cannot suppress recoverable extraction.
    result[requiredName] = extracted.find((section) => section.content.length > 0)
      ?? extracted[0]
      ?? null;
  }

  return Object.freeze(result);
}

function criterion(
  criterionName: StructuralCriterionName,
  passed: boolean,
  expected: string,
  actual: string,
): StructuralCriterionResult {
  return Object.freeze({ criterion: criterionName, passed, expected, actual });
}

function validateStructure(
  headings: readonly HeadingToken[],
  sections: Readonly<Record<AgentSectionName, ExtractedAgentSection | null>>,
): Omit<StructuralValidation, 'findings'> & { findings: StructuralFinding[] } {
  const candidates = headings.filter((heading) => heading.canonicalSectionName !== null);
  const candidateNames = candidates.map((heading) => heading.canonicalSectionName!);
  const exactCountPassed = candidates.length === REQUIRED_AGENT_SECTION_NAMES.length;
  const exactNamesPassed = REQUIRED_AGENT_SECTION_NAMES.every((requiredName) =>
    candidates.some((heading) => heading.name === requiredName));
  const headingLevelsPassed = REQUIRED_AGENT_SECTION_NAMES.every((requiredName) => {
    const matching = candidates.filter((heading) => heading.canonicalSectionName === requiredName);
    return matching.length > 0 && matching.every((heading) => heading.level === 2);
  });
  const uniquenessPassed = REQUIRED_AGENT_SECTION_NAMES.every((requiredName) =>
    candidateNames.filter((name) => name === requiredName).length === 1);
  const orderPassed = candidateNames.length === REQUIRED_AGENT_SECTION_NAMES.length
    && candidateNames.every((name, index) => name === REQUIRED_AGENT_SECTION_NAMES[index]);
  const contentPassed = REQUIRED_AGENT_SECTION_NAMES.every((requiredName) =>
    (sections[requiredName]?.content.length ?? 0) > 0);

  const criteria: Readonly<Record<StructuralCriterionName, StructuralCriterionResult>> =
    Object.freeze({
      exactCount: criterion(
        'exactCount',
        exactCountPassed,
        String(REQUIRED_AGENT_SECTION_NAMES.length),
        String(candidates.length),
      ),
      exactNames: criterion(
        'exactNames',
        exactNamesPassed,
        REQUIRED_AGENT_SECTION_NAMES.join(' | '),
        candidates.map((heading) => heading.name).join(' | '),
      ),
      headingLevels: criterion(
        'headingLevels',
        headingLevelsPassed,
        'level 2 for every required section',
        candidates.map((heading) => `${heading.name}:${heading.level}`).join(' | '),
      ),
      uniqueness: criterion(
        'uniqueness',
        uniquenessPassed,
        'one occurrence of every required section',
        REQUIRED_AGENT_SECTION_NAMES.map((name) =>
          `${name}:${candidateNames.filter((candidate) => candidate === name).length}`).join(' | '),
      ),
      order: criterion(
        'order',
        orderPassed,
        REQUIRED_AGENT_SECTION_NAMES.join(' > '),
        candidateNames.join(' > '),
      ),
      nonWhitespaceContent: criterion(
        'nonWhitespaceContent',
        contentPassed,
        'non-whitespace content for every required section',
        REQUIRED_AGENT_SECTION_NAMES.map((name) =>
          `${name}:${sections[name]?.content.length ? 'content' : 'empty'}`).join(' | '),
      ),
    });

  const strictValid = Object.values(criteria).every((result) => result.passed);
  return { complete: true, strictValid, criteria, findings: [] };
}

function createStructuralFindings(
  validation: Omit<StructuralValidation, 'findings'>,
  extractionOverrideApplied: boolean,
): readonly StructuralFinding[] {
  const codes: Record<StructuralCriterionName, string> = {
    exactCount: 'STRUCTURE_EXACT_COUNT',
    exactNames: 'STRUCTURE_EXACT_NAMES',
    headingLevels: 'STRUCTURE_HEADING_LEVELS',
    uniqueness: 'STRUCTURE_UNIQUENESS',
    order: 'STRUCTURE_ORDER',
    nonWhitespaceContent: 'STRUCTURE_NON_WHITESPACE_CONTENT',
  };

  return Object.freeze(
    Object.values(validation.criteria)
      .filter((result) => !result.passed)
      .map((result) => Object.freeze({
        code: codes[result.criterion],
        criterion: result.criterion,
        message: `Expected ${result.expected}; found ${result.actual}`,
        classification: extractionOverrideApplied && result.criterion !== 'nonWhitespaceContent'
          ? 'informational' as const
          : 'blocking' as const,
      })),
  );
}

/**
 * Parses an agent markdown source without discarding source bytes or suppressing
 * structural checks after another check fails.
 */
export function parseAgentFileDocument(source: string | Uint8Array): AgentFileParseResult {
  const sourceBytes = typeof source === 'string'
    ? Uint8Array.from(Buffer.from(source, 'utf8'))
    : Uint8Array.from(source);
  const sourceText = Buffer.from(sourceBytes).toString('utf8');
  const lines = scanLines(sourceText);
  const frontmatterResult = parseFrontmatter(sourceText, sourceBytes, lines);
  const bodyRange = makeRange(sourceText, frontmatterResult.bodyStart, sourceText.length);
  const body = sourceText.slice(bodyRange.start, bodyRange.end);
  const headings = Object.freeze(
    parseHeadingTokens(sourceText, lines, frontmatterResult.bodyStart),
  );
  const sections = extractSections(sourceText, headings, bodyRange.end);
  const sectionContents = {} as Record<AgentSectionName, string | null>;
  const diagnostics = [...frontmatterResult.diagnostics];

  for (const sectionName of REQUIRED_AGENT_SECTION_NAMES) {
    const content = sections[sectionName]?.content ?? '';
    sectionContents[sectionName] = content || null;
    if (!sections[sectionName]) {
      diagnostics.push(Object.freeze({
        code: 'SECTION_MISSING',
        message: `Required section ${sectionName} could not be extracted`,
        range: bodyRange,
        recoverable: false,
      }));
    } else if (!content) {
      diagnostics.push(Object.freeze({
        code: 'SECTION_CONTENT_EMPTY',
        message: `Required section ${sectionName} has no non-whitespace content`,
        range: sections[sectionName]!.bodyRange,
        recoverable: false,
      }));
    }
  }

  const extractionComplete = REQUIRED_AGENT_SECTION_NAMES.every(
    (sectionName) => sectionContents[sectionName] !== null,
  );
  const preliminaryStructure = validateStructure(headings, sections);
  const extractionOverrideApplied = frontmatterResult.snapshot.parseable
    && extractionComplete
    && !preliminaryStructure.strictValid;
  const structural: StructuralValidation = Object.freeze({
    ...preliminaryStructure,
    findings: createStructuralFindings(preliminaryStructure, extractionOverrideApplied),
  });
  const systemPrompt = extractionComplete
    ? REQUIRED_AGENT_SECTION_NAMES.map(
      (sectionName) => `## ${sectionName}\n\n${sectionContents[sectionName]}`,
    ).join('\n\n')
    : null;
  const recoverableParseFindings = frontmatterResult.snapshot.parseable && extractionComplete
    ? diagnostics
      .filter((diagnostic) => diagnostic.recoverable)
      .map((diagnostic) => Object.freeze({
        code: 'Recoverable_Parse_Finding' as const,
        diagnosticCode: diagnostic.code,
        message: diagnostic.message,
      }))
    : [];
  const failed = !frontmatterResult.snapshot.parseable || !extractionComplete;
  const recovered = !failed && (
    extractionOverrideApplied
    || recoverableParseFindings.length > 0
  );

  return Object.freeze({
    sourceText,
    sourceBytes,
    frontmatter: frontmatterResult.snapshot,
    body,
    bodyRange,
    headings,
    sections,
    sectionContents: Object.freeze(sectionContents),
    diagnostics: Object.freeze(diagnostics),
    structural,
    extractionComplete,
    systemPrompt,
    extractionOverride: Object.freeze({
      applied: extractionOverrideApplied,
      code: 'Extraction_Override',
      recoveredSections: extractionComplete
        ? Object.freeze([...REQUIRED_AGENT_SECTION_NAMES])
        : Object.freeze(REQUIRED_AGENT_SECTION_NAMES.filter(
          (sectionName) => sectionContents[sectionName] !== null,
        )),
      reason: extractionOverrideApplied
        ? 'All six required non-whitespace sections were recovered despite strict structural findings'
        : extractionComplete
          ? 'Strict structure is valid; no override is required'
          : 'Not all required non-whitespace sections were recoverable',
    }),
    recoverableParseFindings: Object.freeze(recoverableParseFindings),
    status: failed ? 'failed' : recovered ? 'recovered' : 'success',
  });
}
