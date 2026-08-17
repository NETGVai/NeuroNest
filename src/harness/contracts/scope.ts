/**
 * Scope Descriptor V1
 *
 * Defines the user, workspace, project, session, agent, and owner boundaries
 * attached to a resource or operation.
 *
 * Requirements: 3.2, 34.1
 */

import { z } from 'zod';
import { IdentifierSchema } from './primitives';

export const ScopeDescriptorV1Schema = z.object({
  userId: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema.optional(),
  projectId: IdentifierSchema.optional(),
  sessionId: IdentifierSchema.optional(),
  agentId: IdentifierSchema.optional(),
  ownerId: IdentifierSchema.optional(),
  schemaVersion: z.literal(1),
}).passthrough();

export type ScopeDescriptorV1 = z.infer<typeof ScopeDescriptorV1Schema>;
