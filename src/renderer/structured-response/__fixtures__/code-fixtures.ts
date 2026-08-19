/**
 * Deterministic code artifact block fixtures.
 *
 * Covers streaming/finalized code, multiple languages,
 * line numbers, and various display configurations.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { CodeBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

function codeBlock(params: {
  entityId: string;
  artifactId: string;
  language: string;
  code: string;
  finalized: boolean;
  displayLabel?: string;
  showLineNumbers?: boolean;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): CodeBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'code',
      entityId: params.entityId,
      role: 'primary',
      status: params.status ?? (params.finalized ? 'ready' : 'streaming'),
      authority: FIXTURE_AUTHORITIES.filesystem,
    }),
    kind: 'code',
    content: {
      artifactId: params.artifactId,
      language: params.language,
      code: params.code,
      finalized: params.finalized,
      ...(params.displayLabel !== undefined && { displayLabel: params.displayLabel }),
      ...(params.showLineNumbers !== undefined && { showLineNumbers: params.showLineNumbers }),
    },
  };
}

export const codeFixtures: GalleryFixtureSet = {
  kind: 'code',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'code-typescript-finalized',
      description: 'Finalized TypeScript code block with line numbers',
      block: codeBlock({
        entityId: 'code-ts-001',
        artifactId: 'artifact-ts-001',
        language: 'typescript',
        code: [
          'interface ResponseBlock {',
          '  readonly stableKey: string;',
          '  readonly kind: ResponseBlockKind;',
          '  readonly role: ResponseBlockRole;',
          '  readonly status: ResponseBlockStatus;',
          '  readonly contentRevision: number;',
          '}',
          '',
          'function parseBlock(raw: unknown): ResponseBlock | null {',
          '  const result = ResponseBlockV1Schema.safeParse(raw);',
          '  return result.success ? result.data : null;',
          '}',
        ].join('\n'),
        finalized: true,
        displayLabel: 'response-block.ts',
        showLineNumbers: true,
      }),
    }),
    makeFixture({
      id: 'code-typescript-streaming',
      description: 'TypeScript code block still streaming',
      lifecycle: 'streaming',
      block: codeBlock({
        entityId: 'code-ts-stream-001',
        artifactId: 'artifact-ts-stream-001',
        language: 'typescript',
        code: 'export class ResponseSurfaceRegistry {\n  private readonly adapters = new Map',
        finalized: false,
        status: 'streaming',
      }),
    }),
    makeFixture({
      id: 'code-python-finalized',
      description: 'Finalized Python code block',
      block: codeBlock({
        entityId: 'code-py-001',
        artifactId: 'artifact-py-001',
        language: 'python',
        code: [
          'def compute_stable_key(session_id: str, branch_id: str, entity_id: str) -> str:',
          '    """Compute a deterministic stable key for a response block."""',
          '    components = [session_id, branch_id, entity_id]',
          '    return ":".join(components)',
        ].join('\n'),
        finalized: true,
        displayLabel: 'stable_key.py',
      }),
    }),
    makeFixture({
      id: 'code-json-finalized',
      description: 'Finalized JSON data code block',
      block: codeBlock({
        entityId: 'code-json-001',
        artifactId: 'artifact-json-001',
        language: 'json',
        code: JSON.stringify(
          {
            schemaVersion: 1,
            compositionId: 'comp-001',
            blocks: [{ kind: 'narrative', status: 'ready' }],
          },
          null,
          2,
        ),
        finalized: true,
        displayLabel: 'composition.json',
        showLineNumbers: true,
      }),
    }),
    makeFixture({
      id: 'code-shell-finalized',
      description: 'Finalized shell/terminal output',
      block: codeBlock({
        entityId: 'code-shell-001',
        artifactId: 'artifact-shell-001',
        language: 'bash',
        code: [
          '$ npm run test -- --run',
          '',
          ' PASS  src/harness/contracts/__tests__/response-composition.test.ts',
          ' PASS  src/renderer/structured-response/__tests__/fixtures.test.ts',
          '',
          'Test Suites:  2 passed, 2 total',
          'Tests:        47 passed, 47 total',
        ].join('\n'),
        finalized: true,
        displayLabel: 'Test output',
      }),
    }),
    makeFixture({
      id: 'code-wide-viewport',
      description: 'Code block in wide viewport without wrapping',
      viewport: 'wide',
      block: codeBlock({
        entityId: 'code-wide-001',
        artifactId: 'artifact-wide-001',
        language: 'typescript',
        code: 'const veryLongVariableName = createSomethingWithManyParameters(firstParameter, secondParameter, thirdParameter, fourthParameter);',
        finalized: true,
        showLineNumbers: true,
      }),
    }),
    makeFixture({
      id: 'code-narrow-viewport',
      description: 'Code block in narrow viewport with overflow containment',
      viewport: 'narrow',
      block: codeBlock({
        entityId: 'code-narrow-001',
        artifactId: 'artifact-narrow-001',
        language: 'typescript',
        code: 'export function processResponse(composition: ResponseCompositionV1): RenderResult {\n  return dispatch(composition.blocks);\n}',
        finalized: true,
      }),
    }),
  ],
};
