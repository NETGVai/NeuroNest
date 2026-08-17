/**
 * Actor Reference V1
 *
 * Identifies the actor (user, system, agent, or service) responsible for
 * producing an event or command.
 *
 * Requirements: 3.2, 34.2
 */

import { z } from 'zod';
import { IdentifierSchema } from './primitives';

export const ActorKindSchema = z.enum(['user', 'system', 'agent', 'service']);

export const ActorRefSchema = z.object({
  kind: ActorKindSchema,
  id: IdentifierSchema,
  displayName: z.string().optional(),
  schemaVersion: z.literal(1),
}).passthrough();

export type ActorRef = z.infer<typeof ActorRefSchema>;
export type ActorKind = z.infer<typeof ActorKindSchema>;
