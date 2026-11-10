import {
  ActivityError,
  type ActivityAdministratorFacts,
  type ActivityPolicy,
  type ActivityState,
  type ActivityVisibility,
} from "./types.js";
import {
  activityAdd,
  activityId,
  activityInteger,
  activityKey,
  fresh,
  nextActivityState,
  normalizeActivityPolicy,
  requireAdministrator,
} from "./policy.js";

export function createActivityState(guildId: string): ActivityState {
  return {
    guildId: activityId(guildId),
    revision: 0,
    settingsRevision: 0,
    generation: 0,
    enabled: false,
    visibility: "administrators",
    policy: null,
    period: null,
    enabledAt: null,
    observationEpoch: null,
    observationStartedAt: null,
    voiceHighWatermark: null,
    voice: null,
    totals: {},
    daily: {},
    lastMessageAt: {},
    messageReceipts: {},
  };
}
function settingsGuard(
  state: ActivityState,
  actor: ActivityAdministratorFacts,
  revision: number,
  now: number,
): void {
  activityInteger(now);
  requireAdministrator(state.guildId, actor, now);
  if (activityInteger(revision) !== state.settingsRevision)
    throw new ActivityError("revision_conflict");
}
export function configureActivity(
  state: ActivityState,
  actor: ActivityAdministratorFacts,
  revision: number,
  policy: ActivityPolicy,
  visibility: ActivityVisibility,
  now: number,
): ActivityState {
  settingsGuard(state, actor, revision, now);
  if (!["administrators", "members"].includes(visibility))
    throw new ActivityError("invalid_visibility");
  const normalized = normalizeActivityPolicy(policy);
  if (state.period && normalized.timeZone !== state.period.timeZone)
    throw new ActivityError("period_change_pending");
  const next = nextActivityState(state);
  next.policy = normalized;
  next.visibility = visibility;
  next.settingsRevision = activityAdd(state.settingsRevision, 1);
  next.generation = activityAdd(state.generation, 1);
  next.enabled = false;
  next.enabledAt = null;
  next.observationEpoch = null;
  next.observationStartedAt = null;
  next.voiceHighWatermark = null;
  next.voice = null;
  return next;
}
/** Pure simulation gate. A future persistent adapter must separately satisfy production readiness. */
export function startActivity(
  state: ActivityState,
  actor: ActivityAdministratorFacts,
  revision: number,
  input: {
    periodId: string;
    epoch: string;
    notice: { guildId: string; settingsRevision: number; confirmed: boolean; observedAt: number };
  },
  now: number,
): ActivityState {
  settingsGuard(state, actor, revision, now);
  if (!state.policy) throw new ActivityError("not_configured");
  if (
    !input ||
    input.notice?.guildId !== state.guildId ||
    input.notice.confirmed !== true ||
    input.notice.settingsRevision !== state.settingsRevision ||
    !fresh(input.notice.observedAt, now, state.policy.factMaxAgeMs)
  )
    throw new ActivityError("notice_unconfirmed");
  const periodId = activityKey(input.periodId),
    epoch = activityKey(input.epoch);
  if (state.period && state.period.id !== periodId)
    throw new ActivityError("period_change_pending");
  const next = nextActivityState(state);
  next.settingsRevision = activityAdd(state.settingsRevision, 1);
  next.generation = activityAdd(state.generation, 1);
  next.enabled = true;
  next.enabledAt = now;
  next.period ??= { id: periodId, startedAt: now, timeZone: state.policy.timeZone };
  next.observationEpoch = epoch;
  next.observationStartedAt = now;
  next.voiceHighWatermark = { epoch, sequence: 0 };
  next.voice = null;
  return next;
}
export function stopActivity(
  state: ActivityState,
  actor: ActivityAdministratorFacts,
  revision: number,
  now: number,
): ActivityState {
  settingsGuard(state, actor, revision, now);
  const next = nextActivityState(state);
  next.settingsRevision = activityAdd(state.settingsRevision, 1);
  next.generation = activityAdd(state.generation, 1);
  next.enabled = false;
  next.enabledAt = null;
  next.observationEpoch = null;
  next.observationStartedAt = null;
  next.voiceHighWatermark = null;
  next.voice = null;
  return next;
}
/** Trusted lifecycle input: disconnect, shutdown and lease loss never settle an uncertain tail. */
export function suspendActivityObservation(
  state: ActivityState,
  expectedRevision: number,
): ActivityState {
  if (activityInteger(expectedRevision) !== state.revision)
    throw new ActivityError("revision_conflict");
  const next = nextActivityState(state);
  next.observationEpoch = null;
  next.observationStartedAt = null;
  next.voice = null;
  return next;
}
export function beginActivityObservation(
  state: ActivityState,
  expectedRevision: number,
  input: { guildId: string; epoch: string; observedAt: number; connected: boolean },
  now: number,
): ActivityState {
  if (activityInteger(expectedRevision) !== state.revision)
    throw new ActivityError("revision_conflict");
  if (!state.enabled || !state.policy || !state.period) throw new ActivityError("disabled");
  if (input.guildId !== state.guildId) throw new ActivityError("guild_mismatch");
  if (input.connected !== true || !fresh(input.observedAt, now, state.policy.factMaxAgeMs))
    throw new ActivityError("observation_unconfirmed");
  const next = nextActivityState(state);
  const epoch = activityKey(input.epoch);
  next.observationEpoch = epoch;
  next.observationStartedAt = now;
  if (state.voiceHighWatermark?.epoch !== epoch) next.voiceHighWatermark = { epoch, sequence: 0 };
  next.voice = null;
  return next;
}
