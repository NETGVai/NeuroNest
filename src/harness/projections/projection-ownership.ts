/**
 * Projection ownership guard for the structured-response migration.
 *
 * This module is deliberately independent from the legacy event adapter so the
 * adapter can normalize ingress without acquiring persistence or canonical
 * projection capabilities. A guard is scoped to one session/branch/turn and
 * makes rejected ownership or mutation attempts side-effect free.
 *
 * Requirements: 21.1, 21.2, 21.6, 21.9, 21.12
 */

export const PROJECTION_PARTICIPANTS = {
  legacyAdapter: 'LegacyResponseAdapter',
  canonicalProjection: 'CanonicalProjectionService',
  chatPanel: 'ChatPanel',
  chatService: 'ChatService',
  timeline: 'src/timeline',
  richResponseServices: 'rich-response-services',
} as const;

export type ProjectionParticipant =
  (typeof PROJECTION_PARTICIPANTS)[keyof typeof PROJECTION_PARTICIPANTS];

export type ProjectionOwnerState =
  | 'legacy_visible'
  | 'canonical_shadow'
  | 'canonical_cutover'
  | 'canonical_only';

export interface ProjectionOwnershipScope {
  readonly sessionId: string;
  readonly branchId: string;
  readonly turnId: string;
  readonly rolloutEpoch: string;
}

export interface ProjectionParticipantCapabilities {
  readonly emitsNormalizedFacts: boolean;
  readonly emitsRedactedDiagnostics: boolean;
  readonly mayPersistMessageStore: boolean;
  readonly mayPersistSessionStore: boolean;
  readonly mayPersistActionStore: boolean;
  readonly eligibleOwnerStates: readonly ProjectionOwnerState[];
}

const NO_OWNER_STATES: readonly ProjectionOwnerState[] = Object.freeze([]);
const LEGACY_OWNER_STATES: readonly ProjectionOwnerState[] = Object.freeze([
  'legacy_visible',
  'canonical_shadow',
]);
const CANONICAL_OWNER_STATES: readonly ProjectionOwnerState[] = Object.freeze([
  'canonical_cutover',
  'canonical_only',
]);

const PARTICIPANT_CAPABILITIES: Readonly<
  Record<ProjectionParticipant, ProjectionParticipantCapabilities>
> = Object.freeze({
  [PROJECTION_PARTICIPANTS.legacyAdapter]: Object.freeze({
    emitsNormalizedFacts: true,
    emitsRedactedDiagnostics: true,
    mayPersistMessageStore: false,
    mayPersistSessionStore: false,
    mayPersistActionStore: false,
    eligibleOwnerStates: LEGACY_OWNER_STATES,
  }),
  [PROJECTION_PARTICIPANTS.canonicalProjection]: Object.freeze({
    emitsNormalizedFacts: false,
    emitsRedactedDiagnostics: true,
    mayPersistMessageStore: false,
    mayPersistSessionStore: false,
    mayPersistActionStore: false,
    eligibleOwnerStates: CANONICAL_OWNER_STATES,
  }),
  [PROJECTION_PARTICIPANTS.chatPanel]: presentationOnlyCapabilities(),
  [PROJECTION_PARTICIPANTS.chatService]: presentationOnlyCapabilities(),
  [PROJECTION_PARTICIPANTS.timeline]: presentationOnlyCapabilities(),
  [PROJECTION_PARTICIPANTS.richResponseServices]: presentationOnlyCapabilities(),
});

function presentationOnlyCapabilities(): ProjectionParticipantCapabilities {
  return Object.freeze({
    emitsNormalizedFacts: false,
    emitsRedactedDiagnostics: false,
    mayPersistMessageStore: false,
    mayPersistSessionStore: false,
    mayPersistActionStore: false,
    eligibleOwnerStates: NO_OWNER_STATES,
  });
}

export function getProjectionParticipantCapabilities(
  participant: ProjectionParticipant,
): ProjectionParticipantCapabilities {
  return PARTICIPANT_CAPABILITIES[participant];
}

export interface LegacyAdapterEmission<TFact, TDiagnostic> {
  readonly normalizedFacts: readonly TFact[];
  readonly diagnostics: readonly TDiagnostic[];
}

/**
 * Constructs the adapter's outward-facing result without providing any durable
 * store or projection mutation handle. Dedupe/correlation ledgers remain
 * bounded implementation details; normalized facts must be appended by the
 * Session Log authority.
 */
export function createLegacyAdapterEmission<TFact, TDiagnostic>(
  normalizedFacts: readonly TFact[],
  diagnostics: readonly TDiagnostic[],
): LegacyAdapterEmission<TFact, TDiagnostic> {
  return Object.freeze({
    normalizedFacts: Object.freeze([...normalizedFacts]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

export interface AdapterSurfaceAssertion {
  readonly ok: boolean;
  readonly forbiddenMembers: readonly string[];
}

const FORBIDDEN_ADAPTER_MEMBER = /^(?:messages?|sessions?|actions?|messageStore|sessionStore|actionStore|canonicalNodes|chatNodes|nodeMap|persist.*|save.*|appendMessage|upsertMessage|mutateCanonical.*)$/i;

/**
 * Architecture assertion intended for adapter construction/integration tests.
 * It rejects public or runtime fields that would make the adapter a durable
 * message/session/action store or a direct canonical-node mutator. Bounded
 * delivery/fact/correlation ledgers are intentionally permitted.
 */
export function assertLegacyAdapterSurface(adapter: object): AdapterSurfaceAssertion {
  const members = new Set<string>();
  let current: object | null = adapter;

  while (current && current !== Object.prototype) {
    for (const member of Reflect.ownKeys(current)) {
      if (typeof member === 'string' && member !== 'constructor') {
        members.add(member);
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  const forbiddenMembers = [...members]
    .filter((member) => FORBIDDEN_ADAPTER_MEMBER.test(member))
    .sort();

  return Object.freeze({
    ok: forbiddenMembers.length === 0,
    forbiddenMembers: Object.freeze(forbiddenMembers),
  });
}

export interface ProjectionOwnershipSnapshot {
  readonly scope: ProjectionOwnershipScope;
  readonly state: ProjectionOwnerState;
  readonly activeOwner: ProjectionParticipant;
  readonly ownershipRevision: number;
}

export type ProjectionMutationResult<T> =
  | { readonly accepted: true; readonly value: T }
  | {
      readonly accepted: false;
      readonly reason: 'participant_ineligible' | 'inactive_owner';
      readonly activeOwner: ProjectionParticipant;
    };

export type ProjectionTransitionResult =
  | { readonly accepted: true; readonly changed: boolean; readonly snapshot: ProjectionOwnershipSnapshot }
  | {
      readonly accepted: false;
      readonly reason: 'invalid_transition';
      readonly snapshot: ProjectionOwnershipSnapshot;
    };

const ACTIVE_OWNER: Readonly<Record<ProjectionOwnerState, ProjectionParticipant>> = Object.freeze({
  legacy_visible: PROJECTION_PARTICIPANTS.legacyAdapter,
  canonical_shadow: PROJECTION_PARTICIPANTS.legacyAdapter,
  canonical_cutover: PROJECTION_PARTICIPANTS.canonicalProjection,
  canonical_only: PROJECTION_PARTICIPANTS.canonicalProjection,
});

const ALLOWED_TRANSITIONS: Readonly<Record<ProjectionOwnerState, readonly ProjectionOwnerState[]>> =
  Object.freeze({
    legacy_visible: Object.freeze(['canonical_shadow'] as const),
    canonical_shadow: Object.freeze(['legacy_visible', 'canonical_cutover'] as const),
    canonical_cutover: Object.freeze(['canonical_shadow', 'canonical_only'] as const),
    canonical_only: Object.freeze(['canonical_cutover'] as const),
  });

/**
 * Enforces exactly one projection mutation owner for one rollout scope.
 * Mutation callbacks are never invoked for rejected attempts, making the
 * rejection atomic with respect to Session Log facts and canonical nodes.
 */
export class ProjectionOwnershipGuard {
  private state: ProjectionOwnerState;
  private ownershipRevision = 0;
  private readonly scope: ProjectionOwnershipScope;

  constructor(scope: ProjectionOwnershipScope, initialState: ProjectionOwnerState = 'legacy_visible') {
    this.scope = Object.freeze({ ...scope });
    this.state = initialState;
  }

  snapshot(): ProjectionOwnershipSnapshot {
    return Object.freeze({
      scope: this.scope,
      state: this.state,
      activeOwner: ACTIVE_OWNER[this.state],
      ownershipRevision: this.ownershipRevision,
    });
  }

  canRegisterAsOwner(participant: ProjectionParticipant): boolean {
    const capabilities = getProjectionParticipantCapabilities(participant);
    return capabilities.eligibleOwnerStates.includes(this.state)
      && ACTIVE_OWNER[this.state] === participant;
  }

  attemptMutation<T>(
    participant: ProjectionParticipant,
    mutation: () => T,
  ): ProjectionMutationResult<T> {
    const capabilities = getProjectionParticipantCapabilities(participant);
    if (!capabilities.eligibleOwnerStates.includes(this.state)) {
      return Object.freeze({
        accepted: false,
        reason: 'participant_ineligible',
        activeOwner: ACTIVE_OWNER[this.state],
      });
    }
    if (ACTIVE_OWNER[this.state] !== participant) {
      return Object.freeze({
        accepted: false,
        reason: 'inactive_owner',
        activeOwner: ACTIVE_OWNER[this.state],
      });
    }

    return Object.freeze({ accepted: true, value: mutation() });
  }

  transition(nextState: ProjectionOwnerState): ProjectionTransitionResult {
    if (nextState === this.state) {
      return Object.freeze({ accepted: true, changed: false, snapshot: this.snapshot() });
    }
    if (!ALLOWED_TRANSITIONS[this.state].includes(nextState)) {
      return Object.freeze({
        accepted: false,
        reason: 'invalid_transition',
        snapshot: this.snapshot(),
      });
    }

    this.state = nextState;
    this.ownershipRevision += 1;
    return Object.freeze({ accepted: true, changed: true, snapshot: this.snapshot() });
  }
}
