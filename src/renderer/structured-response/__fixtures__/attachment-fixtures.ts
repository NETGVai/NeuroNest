/**
 * Deterministic attachment block fixtures.
 *
 * Covers all attachment states, media types,
 * alternative text, and multi-attachment scenarios.
 *
 * Requirements: 22.1-22.2, 22.8
 */

import type { AttachmentBlockV1 } from '../../../harness/contracts/response-composition';
import type { GalleryFixtureSet } from './types';
import { FIXTURE_AUTHORITIES, makeBlockBase, makeFixture } from './fixture-helpers';

type AttachmentState = 'processing' | 'ready' | 'unavailable' | 'failed' | 'redacted';

function attachmentBlock(params: {
  entityId: string;
  attachments: Array<{
    attachmentId: string;
    displayName: string;
    mediaType: string;
    state: AttachmentState;
    alternativeText?: string;
    detailIdentity?: string;
  }>;
  status?: 'pending' | 'ready' | 'streaming' | 'stale' | 'unavailable' | 'terminal';
}): AttachmentBlockV1 {
  return {
    ...makeBlockBase({
      kind: 'attachment',
      entityId: params.entityId,
      role: 'evidence',
      status: params.status ?? 'ready',
      authority: FIXTURE_AUTHORITIES.session,
    }),
    kind: 'attachment',
    content: {
      attachments: params.attachments.map((a) => ({
        attachmentId: a.attachmentId,
        displayName: a.displayName,
        mediaType: a.mediaType,
        state: a.state,
        ...(a.alternativeText !== undefined && { alternativeText: a.alternativeText }),
        ...(a.detailIdentity !== undefined && { detailIdentity: a.detailIdentity }),
      })),
    },
  };
}

export const attachmentFixtures: GalleryFixtureSet = {
  kind: 'attachment',
  contractVersion: 1,
  fixtures: [
    makeFixture({
      id: 'attachment-image-ready',
      description: 'Ready image attachment with alternative text',
      block: attachmentBlock({
        entityId: 'attach-img-001',
        attachments: [
          {
            attachmentId: 'att-img-001',
            displayName: 'architecture-diagram.png',
            mediaType: 'image/png',
            state: 'ready',
            alternativeText: 'System architecture diagram showing component relationships',
            detailIdentity: 'detail-img-001',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'attachment-processing',
      description: 'Attachment currently being processed',
      lifecycle: 'streaming',
      block: attachmentBlock({
        entityId: 'attach-proc-001',
        attachments: [
          {
            attachmentId: 'att-proc-001',
            displayName: 'large-dataset.csv',
            mediaType: 'text/csv',
            state: 'processing',
          },
        ],
        status: 'pending',
      }),
    }),
    makeFixture({
      id: 'attachment-failed',
      description: 'Attachment that failed to process',
      lifecycle: 'failed',
      block: attachmentBlock({
        entityId: 'attach-fail-001',
        attachments: [
          {
            attachmentId: 'att-fail-001',
            displayName: 'corrupted-file.bin',
            mediaType: 'application/octet-stream',
            state: 'failed',
          },
        ],
        status: 'terminal',
      }),
    }),
    makeFixture({
      id: 'attachment-redacted',
      description: 'Attachment with redacted content',
      block: attachmentBlock({
        entityId: 'attach-redact-001',
        attachments: [
          {
            attachmentId: 'att-redact-001',
            displayName: 'credentials-backup',
            mediaType: 'application/json',
            state: 'redacted',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'attachment-unavailable',
      description: 'Attachment that is no longer available',
      block: attachmentBlock({
        entityId: 'attach-unavail-001',
        attachments: [
          {
            attachmentId: 'att-unavail-001',
            displayName: 'expired-upload.pdf',
            mediaType: 'application/pdf',
            state: 'unavailable',
          },
        ],
        status: 'unavailable',
      }),
    }),
    makeFixture({
      id: 'attachment-multiple',
      description: 'Multiple attachments in various states',
      block: attachmentBlock({
        entityId: 'attach-multi-001',
        attachments: [
          {
            attachmentId: 'att-multi-001',
            displayName: 'screenshot.png',
            mediaType: 'image/png',
            state: 'ready',
            alternativeText: 'Screenshot of the current UI state',
            detailIdentity: 'detail-multi-001',
          },
          {
            attachmentId: 'att-multi-002',
            displayName: 'error-log.txt',
            mediaType: 'text/plain',
            state: 'ready',
            detailIdentity: 'detail-multi-002',
          },
          {
            attachmentId: 'att-multi-003',
            displayName: 'video-recording.mp4',
            mediaType: 'video/mp4',
            state: 'processing',
          },
        ],
      }),
    }),
    makeFixture({
      id: 'attachment-mermaid-diagram',
      description: 'Mermaid diagram attachment',
      block: attachmentBlock({
        entityId: 'attach-mermaid-001',
        attachments: [
          {
            attachmentId: 'att-mermaid-001',
            displayName: 'flow-diagram',
            mediaType: 'text/x-mermaid',
            state: 'ready',
            alternativeText: 'Flowchart showing the event processing pipeline from ingress to rendering',
          },
        ],
      }),
    }),
  ],
};
