/**
 * SARIFSerializer — converts SecurityScanner findings to/from SARIF v2.1.0 JSON.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

import * as fs from 'node:fs';
import type { ScanFinding, Severity } from './types';

// ─── SARIF v2.1.0 Interfaces ───────────────────────────────────

export interface SARIFDocument {
  version: '2.1.0';
  $schema: string;
  runs: SARIFRun[];
}

export interface SARIFRun {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri: string;
      rules: SARIFRuleDescriptor[];
    };
  };
  results: SARIFResult[];
}

export interface SARIFRuleDescriptor {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SARIFLevel };
  properties?: Record<string, unknown>;
}

export type SARIFLevel = 'none' | 'note' | 'warning' | 'error';

export interface SARIFResult {
  ruleId: string;
  message: { text: string };
  level: SARIFLevel;
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; startColumn: number };
    };
  }>;
  properties?: Record<string, unknown>;
}

// ─── Constants ──────────────────────────────────────────────────

const SARIF_SCHEMA =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json';

const TOOL_NAME = 'NeuroNest SecurityScanner';
const TOOL_INFO_URI = 'https://github.com/neuronest/neuronest';

// ─── SARIFSerializer ────────────────────────────────────────────

export class SARIFSerializer {
  /** Severity → SARIF level mapping */
  private static readonly SEVERITY_MAP: Record<Severity, SARIFLevel> = {
    low: 'note',
    medium: 'warning',
    high: 'error',
    critical: 'error',
  };

  /** SARIF level → Severity reverse mapping (default; lossy for high vs critical) */
  private static readonly LEVEL_TO_SEVERITY: Record<SARIFLevel, Severity> = {
    none: 'low',
    note: 'low',
    warning: 'medium',
    error: 'high',
  };

  /**
   * Serialize findings to a SARIF v2.1.0 document.
   *
   * Stores extra ScanFinding fields (severity, category, remediation) in
   * result `properties` bags so that `deserialize` can reconstruct them
   * losslessly (the level mapping is lossy for high vs critical).
   */
  static serialize(findings: ScanFinding[], appVersion: string): SARIFDocument {
    // Build deduplicated rules array from findings
    const rulesMap = new Map<string, SARIFRuleDescriptor>();
    for (const f of findings) {
      if (!rulesMap.has(f.ruleId)) {
        rulesMap.set(f.ruleId, {
          id: f.ruleId,
          name: f.ruleName,
          shortDescription: { text: f.description },
          defaultConfiguration: {
            level: SARIFSerializer.SEVERITY_MAP[f.severity],
          },
          properties: {
            category: f.category,
          },
        });
      }
    }

    // Build results array
    const results: SARIFResult[] = findings.map((f) => ({
      ruleId: f.ruleId,
      message: { text: f.description },
      level: SARIFSerializer.SEVERITY_MAP[f.severity],
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.filePath },
            region: { startLine: f.line, startColumn: f.column },
          },
        },
      ],
      properties: {
        severity: f.severity,
        category: f.category,
        remediation: f.remediation,
      },
    }));

    return {
      version: '2.1.0',
      $schema: SARIF_SCHEMA,
      runs: [
        {
          tool: {
            driver: {
              name: TOOL_NAME,
              version: appVersion,
              informationUri: TOOL_INFO_URI,
              rules: Array.from(rulesMap.values()),
            },
          },
          results,
        },
      ],
    };
  }

  /**
   * Deserialize a SARIF document back to ScanFinding[].
   *
   * Extracts fields from SARIF results and their properties bags.
   * Falls back to reverse-mapping the SARIF level when the original
   * severity is not stored in properties.
   */
  static deserialize(sarif: SARIFDocument): ScanFinding[] {
    const findings: ScanFinding[] = [];

    for (const run of sarif.runs ?? []) {
      // Build a lookup from ruleId → rule descriptor for ruleName / category
      const rulesById = new Map<string, SARIFRuleDescriptor>();
      for (const rule of run.tool?.driver?.rules ?? []) {
        rulesById.set(rule.id, rule);
      }

      for (const result of run.results ?? []) {
        const loc = result.locations?.[0]?.physicalLocation;
        const props = (result.properties ?? {}) as Record<string, string>;
        const rule = rulesById.get(result.ruleId);
        const ruleProps = (rule?.properties ?? {}) as Record<string, string>;

        // Resolve severity: prefer stored original, fall back to level mapping
        const severity: Severity =
          isValidSeverity(props.severity)
            ? props.severity
            : SARIFSerializer.LEVEL_TO_SEVERITY[result.level] ?? 'low';

        findings.push({
          ruleId: result.ruleId ?? '',
          ruleName: rule?.name ?? result.ruleId ?? '',
          filePath: loc?.artifactLocation?.uri ?? '',
          line: loc?.region?.startLine ?? 0,
          column: loc?.region?.startColumn ?? 0,
          severity,
          category: props.category ?? ruleProps.category ?? '',
          description: result.message?.text ?? '',
          remediation: props.remediation ?? '',
        });
      }
    }

    return findings;
  }

  /**
   * Write a SARIF document to disk as formatted JSON.
   */
  static async writeToFile(sarif: SARIFDocument, filePath: string): Promise<void> {
    await fs.promises.writeFile(filePath, JSON.stringify(sarif, null, 2), 'utf-8');
  }
}

// ─── Helpers ────────────────────────────────────────────────────

const VALID_SEVERITIES = new Set<string>(['low', 'medium', 'high', 'critical']);

function isValidSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && VALID_SEVERITIES.has(value);
}
