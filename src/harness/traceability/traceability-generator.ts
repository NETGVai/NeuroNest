/**
 * Traceability matrix generator.
 *
 * Parses spec artifacts (requirements.md, design.md, tasks.md) to produce
 * a complete mapping from requirements to implementations/tests and from
 * design properties (1–52) to their corresponding property-test tasks.
 *
 * Requirements: 33.1–33.9
 */

import type {
  RequirementId,
  PropertyId,
  CoverageKind,
  RequirementCoverage,
  PropertyTestMapping,
  TraceabilityMatrix,
  TraceabilityConfig,
  RequirementGroup,
} from './types.js';

/**
 * Parsed property entry extracted from a design document.
 */
export interface ParsedProperty {
  readonly id: PropertyId;
  readonly title: string;
  readonly validatesRequirements: readonly RequirementId[];
}

/**
 * Parsed task entry with requirement and property references.
 */
export interface ParsedTask {
  readonly taskId: string;
  readonly description: string;
  readonly requirements: readonly RequirementId[];
  readonly propertyId: PropertyId | null;
  readonly coverageKind: CoverageKind;
  readonly artifactLink: string;
}

// ─── Requirement ID Utilities ────────────────────────────────────────────

/**
 * Expands a requirement range string like "3.1–3.7" or "33.1" into individual IDs.
 */
export function expandRequirementRange(range: string): RequirementId[] {
  const trimmed = range.trim();

  // Single requirement: "3.1"
  const singleMatch = trimmed.match(/^(\d+)\.(\d+)$/);
  if (singleMatch) {
    return [trimmed];
  }

  // Range: "3.1–3.7" or "3.1-3.7"
  const rangeMatch = trimmed.match(/^(\d+)\.(\d+)[–-](\d+)\.(\d+)$/);
  if (rangeMatch) {
    const [, startGroup, startCriteria, endGroup, endCriteria] = rangeMatch;
    const sg = parseInt(startGroup!, 10);
    const sc = parseInt(startCriteria!, 10);
    const eg = parseInt(endGroup!, 10);
    const ec = parseInt(endCriteria!, 10);

    const ids: RequirementId[] = [];
    if (sg === eg) {
      for (let i = sc; i <= ec; i++) {
        ids.push(`${sg}.${i}`);
      }
    } else {
      // Cross-group ranges are not expected in this spec but handle gracefully
      ids.push(`${sg}.${sc}`);
      ids.push(`${eg}.${ec}`);
    }
    return ids;
  }

  return [trimmed];
}

/**
 * Parses a comma-separated requirement list like "3.1–3.7, 28.4–28.6, 33.1, 34.4"
 * into individual requirement IDs.
 */
export function parseRequirementList(text: string): RequirementId[] {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  const ids: RequirementId[] = [];
  for (const part of parts) {
    ids.push(...expandRequirementRange(part));
  }
  return ids;
}

// ─── Design Document Parsing ─────────────────────────────────────────────

/**
 * Parses property definitions from a design.md content string.
 * Expects format: ### Property N: Title\n...\n**Validates: Requirements X.Y–X.Z, ...**
 */
export function parsePropertiesFromDesign(designContent: string): ParsedProperty[] {
  const properties: ParsedProperty[] = [];
  const propertyRegex = /^### Property (\d+): (.+)$/gm;
  const validatesRegex = /\*\*Validates: Requirements (.+?)\*\*/g;

  let match: RegExpExecArray | null;
  while ((match = propertyRegex.exec(designContent)) !== null) {
    const id = parseInt(match[1]!, 10);
    const title = match[2]!.trim();

    // Find the Validates line after this property header
    const startIdx = match.index + match[0].length;
    const nextPropertyIdx = designContent.indexOf('### Property', startIdx);
    const section = nextPropertyIdx > -1
      ? designContent.slice(startIdx, nextPropertyIdx)
      : designContent.slice(startIdx);

    const validatesMatch = /\*\*Validates: Requirements (.+?)\*\*/.exec(section);
    const validatesRequirements = validatesMatch
      ? parseRequirementList(validatesMatch[1]!)
      : [];

    properties.push({ id, title, validatesRequirements });
  }

  return properties;
}

// ─── Tasks Document Parsing ──────────────────────────────────────────────

/**
 * Infers the coverage kind from a task description.
 */
export function inferCoverageKind(description: string): CoverageKind {
  const lower = description.toLowerCase();
  if (lower.includes('property test') || lower.includes('property-test')) {
    return 'property-test';
  }
  if (lower.includes('integration test') || lower.includes('integration')) {
    return 'integration-test';
  }
  if (lower.includes('snapshot')) {
    return 'snapshot-test';
  }
  if (lower.includes('conformance')) {
    return 'conformance-test';
  }
  if (lower.includes('stress') || lower.includes('performance') || lower.includes('benchmark')) {
    return 'stress-test';
  }
  if (lower.includes('accessibility')) {
    return 'accessibility-test';
  }
  if (lower.includes('unit test') || lower.includes('test')) {
    return 'unit-test';
  }
  return 'implementation';
}

/**
 * Parses tasks from a tasks.md content string.
 * Returns parsed task entries with requirement references and property IDs.
 */
export function parseTasksFromTasksDoc(tasksContent: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  // Match task lines like "  - [x] 1.5 Write the property test for..."
  const taskRegex = /^ {2,}- \[[ x~-]\] (\d+\.\d+) (.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = taskRegex.exec(tasksContent)) !== null) {
    const taskId = match[1]!;
    const description = match[2]!.trim();

    // Get the content between this task and the next task (for sub-lines)
    const startIdx = match.index + match[0].length;
    const nextTaskMatch = tasksContent.slice(startIdx).match(/\n {2,}- \[[ x~-]\] \d+\.\d+/);
    const endIdx = nextTaskMatch
      ? startIdx + nextTaskMatch.index!
      : tasksContent.length;
    const taskBlock = tasksContent.slice(startIdx, endIdx);

    // Extract requirement references from _Requirements: ..._ lines
    const reqMatch = taskBlock.match(/_Requirements: (.+?)_/);
    const requirements = reqMatch ? parseRequirementList(reqMatch[1]!) : [];

    // Extract Validates lines for property tests
    const validatesMatch = taskBlock.match(/\*\*Validates: Requirements (.+?)\*\*/);
    if (validatesMatch) {
      const validatedReqs = parseRequirementList(validatesMatch[1]!);
      for (const r of validatedReqs) {
        if (!requirements.includes(r)) {
          requirements.push(r);
        }
      }
    }

    // Extract property ID from **Property N: ...** lines
    const propertyMatch = taskBlock.match(/\*\*Property (\d+):/);
    const propertyId = propertyMatch ? parseInt(propertyMatch[1]!, 10) : null;

    const coverageKind = inferCoverageKind(description);
    const artifactLink = `tasks.md#${taskId}`;

    tasks.push({
      taskId,
      description,
      requirements,
      propertyId,
      coverageKind,
      artifactLink,
    });
  }

  return tasks;
}

// ─── Matrix Generation ───────────────────────────────────────────────────

/**
 * Generates all individual requirement IDs from a TraceabilityConfig.
 */
export function generateAllRequirementIds(config: TraceabilityConfig): RequirementId[] {
  const ids: RequirementId[] = [];
  for (const group of config.requirementGroups) {
    for (let i = 1; i <= group.criteriaCount; i++) {
      ids.push(`${group.groupId}.${i}`);
    }
  }
  return ids;
}

/**
 * Builds the complete traceability matrix from parsed design properties
 * and task entries.
 */
export function buildTraceabilityMatrix(
  config: TraceabilityConfig,
  parsedProperties: readonly ParsedProperty[],
  parsedTasks: readonly ParsedTask[],
): TraceabilityMatrix {
  // Build requirement coverage map
  const allReqIds = generateAllRequirementIds(config);
  const reqCoverageMap = new Map<RequirementId, RequirementCoverage>();

  for (const reqId of allReqIds) {
    reqCoverageMap.set(reqId, {
      requirementId: reqId,
      taskIds: [],
      coverageKinds: [],
      artifactLinks: [],
    });
  }

  // Populate from parsed tasks
  for (const task of parsedTasks) {
    for (const reqId of task.requirements) {
      const existing = reqCoverageMap.get(reqId);
      if (existing) {
        const mutable = existing as unknown as {
          taskIds: string[];
          coverageKinds: CoverageKind[];
          artifactLinks: string[];
        };
        if (!mutable.taskIds.includes(task.taskId)) {
          mutable.taskIds.push(task.taskId);
        }
        if (!mutable.coverageKinds.includes(task.coverageKind)) {
          mutable.coverageKinds.push(task.coverageKind);
        }
        if (!mutable.artifactLinks.includes(task.artifactLink)) {
          mutable.artifactLinks.push(task.artifactLink);
        }
      }
    }
  }

  // Build property-to-test mappings
  const propertyMappings: PropertyTestMapping[] = [];

  for (const prop of parsedProperties) {
    // Find the task that tests this property
    const matchingTask = parsedTasks.find((t) => t.propertyId === prop.id);

    propertyMappings.push({
      propertyId: prop.id,
      title: prop.title,
      taskId: matchingTask?.taskId ?? '',
      testArtifact: matchingTask?.artifactLink ?? '',
      validatesRequirements: prop.validatesRequirements,
    });
  }

  return {
    requirements: Array.from(reqCoverageMap.values()),
    properties: propertyMappings,
  };
}

/**
 * Generates the full traceability matrix from raw document content and config.
 */
export function generateTraceabilityMatrix(
  config: TraceabilityConfig,
  designContent: string,
  tasksContent: string,
): TraceabilityMatrix {
  const parsedProperties = parsePropertiesFromDesign(designContent);
  const parsedTasks = parseTasksFromTasksDoc(tasksContent);
  return buildTraceabilityMatrix(config, parsedProperties, parsedTasks);
}
