/**
 * Deterministic diff block fixtures.
 *
 * Covers file and structured-record diffs, all diff states,
 * and various change patterns.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { DiffBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type DiffType = 'file' | 'structured_record';
type DiffState = 'proposed' | 'staged' | 'applied' | 'rejected' | 'stale' | 'conflicted' | 'unavailable';

function diffBlock(params: {
  entityId: string;
  diffId: string;
  diffType: DiffType;
  state: DiffState;
  summary: string;
  additions: number;
  deletions: number;
  changes: Array<{
    changeId: string;
    label: string;
    previousValue?: string;
    proposedValue?: string;
  }>;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): DiffBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'diff',
      entityId: params.entityId,
      role: 'primary',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.filesystem,
    }),
    kind: 'diff',
    content: {
      diffId: params.diffId,
      diffType: params.diffType,
      state: params.state,
      summary: params.summary,
      additions: params.additions,
      deletions: params.deletions,
      changes: params.changes,
    },
  };
}

export const diffFixtures: GalleryFixtureSet = {
  kind: 'diff',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'diff-file-proposed',
      description: 'Proposed file diff with additions and deletions',
      authorityState: 'pending',
      block: diffBlock({
        entityId: 'diff-file-001',
        diffId: 'diff-file-prop-001',
        diffType: 'file',
        state: 'proposed',
        summary: 'Add input validation to handler',
        additions: 12,
        deletions: 3,
        changes: [
          {
            changeId: 'chg-001',
            label: 'Added validation import',
            proposedValue: "import { validate } from './validation';",
          },
          {
            changeId: 'chg-002',
            label: 'Replace raw access with validated input',
            previousValue: 'const data = req.body;',
            proposedValue: 'const data = validate(req.body, schema);',
          },
          {
            changeId: 'chg-003',
            label: 'Added error handler',
            proposedValue: 'if (!data.valid) return res.status(400).json(data.errors);',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'diff-file-applied',
      description: 'File diff that has been applied by authority',
      authorityState: 'confirmed',
      block: diffBlock({
        entityId: 'diff-file-applied-001',
        diffId: 'diff-file-applied-001',
        diffType: 'file',
        state: 'applied',
        summary: 'Fix typo in configuration',
        additions: 1,
        deletions: 1,
        changes: [
          {
            changeId: 'chg-applied-001',
            label: 'Fixed spelling',
            previousValue: 'enalbe: true',
            proposedValue: 'enable: true',
          },
        ],
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'diff-file-rejected',
      description: 'File diff rejected by user',
      authorityState: 'rejected',
      block: diffBlock({
        entityId: 'diff-file-rej-001',
        diffId: 'diff-file-rej-001',
        diffType: 'file',
        state: 'rejected',
        summary: 'Proposed formatting changes',
        additions: 8,
        deletions: 8,
        changes: [
          {
            changeId: 'chg-rej-001',
            label: 'Reformat imports',
            previousValue: "import {a,b,c} from './mod';",
            proposedValue: "import { a, b, c } from './mod';",
          },
        ],
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'diff-file-conflicted',
      description: 'File diff in conflicted state',
      block: diffBlock({
        entityId: 'diff-file-conf-001',
        diffId: 'diff-file-conf-001',
        diffType: 'file',
        state: 'conflicted',
        summary: 'Conflicting changes detected in target file',
        additions: 5,
        deletions: 2,
        changes: [
          {
            changeId: 'chg-conf-001',
            label: 'Context has changed since proposal',
            previousValue: 'const version = 2;',
            proposedValue: 'const version = 3;',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'diff-file-stale',
      description: 'File diff that has become stale',
      authorityState: 'expired',
      block: diffBlock({
        entityId: 'diff-file-stale-001',
        diffId: 'diff-file-stale-001',
        diffType: 'file',
        state: 'stale',
        summary: 'Outdated proposed change',
        additions: 2,
        deletions: 1,
        changes: [
          {
            changeId: 'chg-stale-001',
            label: 'Update version number',
            previousValue: '1.0.0',
            proposedValue: '1.1.0',
          },
        ],
        status: 'stale',
      }),
    }),
    makeFixture({
      id: 'diff-structured-record-proposed',
      description: 'Structured record diff with field-level changes',
      block: diffBlock({
        entityId: 'diff-record-001',
        diffId: 'diff-record-prop-001',
        diffType: 'structured_record',
        state: 'proposed',
        summary: 'Update configuration record fields',
        additions: 2,
        deletions: 0,
        changes: [
          {
            changeId: 'chg-rec-001',
            label: 'timeout field',
            previousValue: '30000',
            proposedValue: '60000',
          },
          {
            changeId: 'chg-rec-002',
            label: 'retries field',
            previousValue: '3',
            proposedValue: '5',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'diff-unavailable',
      description: 'Diff that is unavailable',
      authorityState: 'unavailable',
      block: diffBlock({
        entityId: 'diff-unavail-001',
        diffId: 'diff-unavail-001',
        diffType: 'file',
        state: 'unavailable',
        summary: 'Diff content is not available',
        additions: 0,
        deletions: 0,
        changes: [],
        status: 'unavailable',
      }),
    }),
  ],
};
