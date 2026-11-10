import {
  ActivityError,
  type ActivityAdministratorFacts,
  type ActivityMemberFacts,
  type ActivityRank,
  type ActivityState,
  type ActivityTotal,
} from "./types.js";
import {
  activityInteger,
  activityMultiply,
  activityPointUnits,
  memberCurrent,
  memberEligible,
} from "./policy.js";

export function activityRankFor(state: ActivityState, pointsUnits: number): ActivityRank | null {
  activityInteger(pointsUnits);
  const rank = state.policy?.ranks
    .filter((rank) => activityMultiply(rank.thresholdPoints, activityPointUnits) <= pointsUnits)
    .at(-1);
  return rank ? { ...rank } : null;
}
export function readActivityRanking(
  state: ActivityState,
  actor: ActivityAdministratorFacts,
  members: readonly ActivityMemberFacts[],
  now: number,
  limit = 20,
): (ActivityTotal & { position: number; rank: ActivityRank | null })[] {
  activityInteger(now);
  activityInteger(limit, 1, 100);
  const age = state.policy?.factMaxAgeMs ?? 15000;
  if (!memberCurrent(state.guildId, actor, now, Math.min(age, 15000)))
    throw new ActivityError("permission_revoked");
  const admin = actor.owner === true || actor.manageGuild === true;
  if (!admin && (!state.enabled || state.visibility !== "members"))
    throw new ActivityError("permission_revoked");
  const facts = new Map<string, ActivityMemberFacts>();
  for (const member of members) {
    if (facts.has(member.userId)) throw new ActivityError("invalid_snapshot");
    if (memberEligible(state.guildId, member, now, age)) facts.set(member.userId, member);
  }
  const sorted = Object.values(state.totals)
    .filter(
      (total) =>
        facts.get(total.userId)?.joinedAt === total.joinedAt &&
        !state.policy?.excludedMemberIds.includes(total.userId),
    )
    .sort((a, b) => b.pointsUnits - a.pointsUnits || a.userId.localeCompare(b.userId));
  let position = 0,
    last = -1;
  return sorted.slice(0, limit).map((total, index) => {
    if (total.pointsUnits !== last) position = index + 1;
    last = total.pointsUnits;
    return { ...total, position, rank: activityRankFor(state, total.pointsUnits) };
  });
}
