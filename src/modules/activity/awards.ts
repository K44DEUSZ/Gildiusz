import { type ActivityMemberFacts, type ActivityState } from "./types.js";
import { activityAdd, activityInteger, activityMultiply } from "./policy.js";

/** The caller mutates only its freshly cloned transition value, never the input snapshot. */
export function addActivityAward(
  state: ActivityState,
  member: ActivityMemberFacts,
  date: string,
  input: { messageCount: number; voiceMs: number; pointsUnits: number },
  at: number,
): void {
  const prior = state.totals[member.userId] ?? {
    userId: member.userId,
    joinedAt: member.joinedAt,
    pointsUnits: 0,
    messageCount: 0,
    voiceMs: 0,
    revision: 0,
    lastActivityAt: 0,
  };
  const key = `${member.userId}:${date}`,
    daily = state.daily[key] ?? { messageCount: 0, voiceMs: 0 };
  const pointsUnits = activityAdd(prior.pointsUnits, input.pointsUnits);
  state.totals[member.userId] = {
    ...prior,
    pointsUnits,
    messageCount: activityAdd(prior.messageCount, input.messageCount),
    voiceMs: activityAdd(prior.voiceMs, input.voiceMs),
    revision: activityAdd(prior.revision, 1),
    lastActivityAt: Math.max(prior.lastActivityAt, activityInteger(at)),
  };
  state.daily[key] = {
    messageCount: activityAdd(daily.messageCount, input.messageCount),
    voiceMs: activityAdd(daily.voiceMs, input.voiceMs),
  };
}
export function weightedVoiceUnits(durationMs: number, weight: number): number {
  return activityMultiply(durationMs, weight);
}
