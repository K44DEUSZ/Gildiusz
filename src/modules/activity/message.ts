import {
  ActivityError,
  type ActivityChannelFacts,
  type ActivityMemberFacts,
  type ActivityMessage,
  type ActivityState,
  type ActivityTransition,
} from "./types.js";
import {
  activityId,
  activityInteger,
  activityMultiply,
  activityPointUnits,
  channelEligible,
  localActivityDate,
  memberEligible,
  nextActivityState,
  sameMembership,
} from "./policy.js";
import { addActivityAward } from "./awards.js";

export function awardActivityMessage(
  state: ActivityState,
  event: ActivityMessage,
  member: ActivityMemberFacts,
  channel: ActivityChannelFacts,
  now: number,
): ActivityTransition {
  const skip = (reason: string): ActivityTransition => ({ state, reason, pointsUnits: 0 });
  if (!event || event.guildId !== state.guildId) throw new ActivityError("guild_mismatch");
  activityInteger(now);
  if (!state.enabled || !state.policy || !state.period) return skip("disabled");
  const policy = state.policy;
  if (policy.messageWeight === 0 || policy.maxMessagesPerDay === 0) return skip("source_disabled");
  if (
    event.settingsRevision !== state.settingsRevision ||
    event.generation !== state.generation ||
    !state.observationEpoch ||
    event.observationEpoch !== state.observationEpoch
  )
    return skip("stale_observation");
  const keys = [
    "guildId",
    "messageId",
    "userId",
    "channelId",
    "createdAt",
    "settingsRevision",
    "generation",
    "observationEpoch",
    "source",
    "webhook",
    "system",
    "filter",
  ];
  if (!event || Object.keys(event).some((key) => !keys.includes(key)))
    throw new ActivityError("invalid_event");
  activityId(event.messageId);
  activityId(event.userId);
  activityId(event.channelId);
  activityInteger(event.createdAt);
  const snowflakeTime = Number((BigInt(event.messageId) >> 22n) + 1420070400000n);
  if (event.createdAt !== snowflakeTime) throw new ActivityError("invalid_event_time");
  if (
    event.source !== "create" ||
    event.webhook !== false ||
    event.system !== false ||
    event.filter !== "allowed"
  )
    return skip("ineligible_event");
  if (
    event.createdAt > now ||
    now - event.createdAt > policy.messageDelayMs ||
    event.createdAt <
      Math.max(state.enabledAt!, state.period.startedAt, state.observationStartedAt!)
  )
    return skip("outside_observation");
  if (event.userId !== member.userId || event.channelId !== channel.channelId)
    throw new ActivityError("fact_mismatch");
  if (
    !memberEligible(state.guildId, member, now, policy.factMaxAgeMs) ||
    policy.excludedMemberIds.includes(member.userId) ||
    event.createdAt < member.joinedAt ||
    !channelEligible(state, channel, now)
  )
    return skip("ineligible_member_or_channel");
  if (!sameMembership(state, member)) return skip("membership_return_policy_pending");
  if (
    channel.kind === "text"
      ? !policy.textChannelIds.includes(channel.channelId)
      : channel.kind !== "thread" || !policy.threadParentIds.includes(channel.parentIds[0])
  )
    return skip("outside_scope");
  if (state.messageReceipts[event.messageId]) return skip("duplicate");
  const prior = state.lastMessageAt[member.userId];
  if (prior !== undefined && event.createdAt - prior < policy.messageCooldownMs)
    return skip("cooldown");
  const date = localActivityDate(event.createdAt, state.period.timeZone),
    daily = state.daily[`${member.userId}:${date}`];
  if ((daily?.messageCount ?? 0) >= policy.maxMessagesPerDay) return skip("daily_limit");
  const pointsUnits = activityMultiply(policy.messageWeight, activityPointUnits),
    next = nextActivityState(state);
  addActivityAward(
    next,
    member,
    date,
    { messageCount: 1, voiceMs: 0, pointsUnits },
    event.createdAt,
  );
  next.lastMessageAt[member.userId] = event.createdAt;
  next.messageReceipts[event.messageId] = { createdAt: event.createdAt, pointsUnits };
  return { state: next, reason: "awarded", pointsUnits };
}
