import {
  ActivityError,
  type ActivityAdministratorFacts,
  type ActivityChannelFacts,
  type ActivityMemberFacts,
  type ActivityPolicy,
  type ActivityState,
} from "./types.js";

export const activityPointUnits = 60000;
export const activityPendingDecisions = Object.freeze([
  "retention",
  "membership_return_and_opt_out",
  "individual_erasure_and_restore",
  "notice_and_legal_basis",
  "adjustment_audit_retention",
  "adapter_completeness_and_resource_budget",
]);
export const activityProductionReadiness = Object.freeze({
  availability: "planned" as const,
  persistentCollectionAllowed: false as const,
  pending: activityPendingDecisions,
});

export function activityId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value))
    throw new ActivityError("invalid_id");
  return value;
}
export function activityInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new ActivityError("invalid_number");
  return value as number;
}
export function activityKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new ActivityError("invalid_key");
  return value;
}
export function activityAdd(a: number, b: number): number {
  return activityInteger(activityInteger(a) + activityInteger(b));
}
export function activityMultiply(a: number, b: number): number {
  return activityInteger(activityInteger(a) * activityInteger(b));
}
export function fresh(observedAt: number, now: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(observedAt) &&
    Number.isSafeInteger(now) &&
    observedAt >= 0 &&
    observedAt <= now &&
    now - observedAt <= maximum
  );
}
const ids = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 1000) throw new ActivityError("invalid_scope");
  const result = value.map(activityId);
  if (new Set(result).size !== result.length) throw new ActivityError("invalid_scope");
  return result;
};
export function normalizeActivityPolicy(value: ActivityPolicy): ActivityPolicy {
  const numeric = {
    messageWeight: [0, 100],
    voiceWeight: [0, 100],
    messageCooldownMs: [1, 86400000],
    maxMessagesPerDay: [0, 10000],
    maxVoiceMsPerDay: [0, 86400000],
    messageDelayMs: [0, 120000],
    factMaxAgeMs: [1, 60000],
    maxVoiceGapMs: [1, 120000],
    clockSkewMs: [0, 60000],
    minVoiceHumans: [2, 100],
  } as const;
  const lists = [
    "textChannelIds",
    "threadParentIds",
    "voiceChannelIds",
    "excludedChannelIds",
    "excludedMemberIds",
  ] as const;
  const keys = [...Object.keys(numeric), ...lists, "selfMuteCounts", "timeZone", "ranks"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ActivityError("invalid_policy");
  for (const [key, [minimum, maximum]] of Object.entries(numeric))
    activityInteger(value[key as keyof typeof numeric], minimum, maximum);
  for (const key of lists) ids(value[key]);
  if (
    typeof value.selfMuteCounts !== "boolean" ||
    typeof value.timeZone !== "string" ||
    !value.timeZone ||
    value.timeZone.length > 100
  )
    throw new ActivityError("invalid_policy");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format(0);
  } catch {
    throw new ActivityError("invalid_timezone");
  }
  if (!Array.isArray(value.ranks) || value.ranks.length > 25)
    throw new ActivityError("invalid_ranks");
  const rankIds = new Set<string>(),
    names = new Set<string>();
  let previous = -1;
  const ranks = value.ranks.map((rank) => {
    if (!rank || Object.keys(rank).some((key) => !["id", "name", "thresholdPoints"].includes(key)))
      throw new ActivityError("invalid_ranks");
    const id = activityKey(rank.id),
      thresholdPoints = activityInteger(rank.thresholdPoints, 0, 1000000);
    if (
      typeof rank.name !== "string" ||
      !rank.name.trim() ||
      rank.name.length > 40 ||
      /[\p{Cc}<@#>`*_[\]]/u.test(rank.name) ||
      thresholdPoints <= previous
    )
      throw new ActivityError("invalid_ranks");
    const name = rank.name.trim(),
      key = name.normalize("NFKC").toLowerCase();
    if (rankIds.has(id) || names.has(key)) throw new ActivityError("invalid_ranks");
    rankIds.add(id);
    names.add(key);
    previous = thresholdPoints;
    return { id, name, thresholdPoints };
  });
  return { ...structuredClone(value), ranks };
}
export function memberCurrent(
  guildId: string,
  member: ActivityMemberFacts,
  now: number,
  age: number,
): boolean {
  if (!member || member.guildId !== guildId) throw new ActivityError("guild_mismatch");
  activityId(member.userId);
  return (
    fresh(member.observedAt, now, age) &&
    Number.isSafeInteger(member.joinedAt) &&
    member.joinedAt > 0 &&
    member.joinedAt <= member.observedAt &&
    member.present === true &&
    member.bot === false &&
    member.pending === false &&
    member.timedOut === false
  );
}
export function memberEligible(
  guildId: string,
  member: ActivityMemberFacts,
  now: number,
  age: number,
): boolean {
  return memberCurrent(guildId, member, now, age) && member.excluded === false;
}
export function requireAdministrator(
  guildId: string,
  actor: ActivityAdministratorFacts,
  now: number,
): void {
  if (
    !memberCurrent(guildId, actor, now, 15000) ||
    (actor.owner !== true && actor.manageGuild !== true)
  )
    throw new ActivityError("permission_revoked");
}
export function channelEligible(
  state: ActivityState,
  channel: ActivityChannelFacts,
  now: number,
): boolean {
  const policy = state.policy!;
  if (!channel || channel.guildId !== state.guildId) throw new ActivityError("guild_mismatch");
  activityId(channel.channelId);
  if (
    !fresh(channel.observedAt, now, policy.factMaxAgeMs) ||
    channel.ancestryComplete !== true ||
    !Array.isArray(channel.parentIds) ||
    channel.viewable !== true ||
    channel.excluded !== false ||
    channel.technical !== false ||
    channel.afk !== false
  )
    return false;
  channel.parentIds.forEach(activityId);
  return ![channel.channelId, ...channel.parentIds].some((id) =>
    policy.excludedChannelIds.includes(id),
  );
}
export function localActivityDate(at: number, timeZone: string): string {
  activityInteger(at);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  return ["year", "month", "day"]
    .map((key) => parts.find((part) => part.type === key)!.value)
    .join("-");
}
export function sameMembership(state: ActivityState, member: ActivityMemberFacts): boolean {
  return !state.totals[member.userId] || state.totals[member.userId].joinedAt === member.joinedAt;
}
export function nextActivityState(state: ActivityState): ActivityState {
  const next = structuredClone(state);
  next.revision = activityAdd(state.revision, 1);
  return next;
}
