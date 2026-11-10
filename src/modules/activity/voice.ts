import {
  ActivityError,
  type ActivityState,
  type ActivityTransition,
  type ActivityVoiceAnchor,
  type ActivityVoiceParticipant,
  type ActivityVoiceSnapshot,
} from "./types.js";
import {
  activityAdd,
  activityInteger,
  channelEligible,
  fresh,
  localActivityDate,
  memberEligible,
  nextActivityState,
  sameMembership,
} from "./policy.js";
import { addActivityAward, weightedVoiceUnits } from "./awards.js";

function qualified(
  state: ActivityState,
  sample: ActivityVoiceSnapshot,
  now: number,
): Record<string, ActivityVoiceParticipant> {
  const policy = state.policy!,
    byChannel = new Map<string, ActivityVoiceParticipant[]>(),
    seen = new Set<string>();
  if (!Array.isArray(sample.participants) || sample.participants.length > 1000)
    throw new ActivityError("invalid_snapshot");
  for (const participant of sample.participants) {
    const { member, channel } = participant;
    if (seen.has(member.userId)) throw new ActivityError("invalid_snapshot");
    seen.add(member.userId);
    if (
      !memberEligible(state.guildId, member, now, policy.factMaxAgeMs) ||
      !channelEligible(state, channel, now) ||
      member.observedAt > sample.wallTime ||
      channel.observedAt > sample.wallTime ||
      !sameMembership(state, member) ||
      policy.excludedMemberIds.includes(member.userId) ||
      channel.kind !== "voice" ||
      channel.connectable !== true ||
      !policy.voiceChannelIds.includes(channel.channelId) ||
      participant.selfDeaf !== false ||
      participant.serverDeaf !== false ||
      (policy.selfMuteCounts
        ? ![true, false].includes(participant.selfMute as boolean)
        : participant.selfMute !== false)
    )
      continue;
    const people = byChannel.get(channel.channelId) ?? [];
    people.push(participant);
    byChannel.set(channel.channelId, people);
  }
  return Object.fromEntries(
    [...byChannel.values()]
      .filter((people) => people.length >= policy.minVoiceHumans)
      .flatMap((people) => people.map((participant) => [participant.member.userId, participant])),
  );
}
function daySegments(
  start: number,
  end: number,
  duration: number,
  zone: string,
): { date: string; duration: number }[] {
  const first = localActivityDate(start, zone),
    last = localActivityDate(end, zone);
  if (first === last) return [{ date: first, duration }];
  let low = start,
    high = end;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localActivityDate(middle, zone) === first) low = middle;
    else high = middle;
  }
  // Monotonic duration is authoritative. Wall time only assigns its portions to local dates.
  const before = Math.floor(duration * ((high - start) / (end - start)));
  return [
    { date: first, duration: before },
    { date: last, duration: duration - before },
  ];
}
export function observeActivityVoice(
  state: ActivityState,
  sample: ActivityVoiceSnapshot,
  now: number,
): ActivityTransition {
  const skip = (reason: string): ActivityTransition => ({ state, reason, pointsUnits: 0 });
  if (!sample || sample.guildId !== state.guildId) throw new ActivityError("guild_mismatch");
  activityInteger(now);
  if (!state.enabled || !state.policy || !state.period) return skip("disabled");
  const policy = state.policy;
  if (policy.voiceWeight === 0 || policy.maxVoiceMsPerDay === 0) return skip("source_disabled");
  if (
    sample.generation !== state.generation ||
    sample.settingsRevision !== state.settingsRevision ||
    !state.observationEpoch ||
    sample.observationEpoch !== state.observationEpoch
  )
    return skip("stale_observation");
  activityInteger(sample.sequence, 1);
  activityInteger(sample.wallTime);
  activityInteger(sample.monotonicMs);
  const previous = state.voice;
  if (
    state.voiceHighWatermark?.epoch === sample.observationEpoch &&
    sample.sequence <= state.voiceHighWatermark.sequence
  )
    return skip("stale_sequence");
  const next = nextActivityState(state);
  next.voiceHighWatermark = { epoch: sample.observationEpoch, sequence: sample.sequence };
  if (
    sample.connected !== true ||
    sample.complete !== true ||
    !fresh(sample.wallTime, now, policy.factMaxAgeMs) ||
    sample.wallTime < state.observationStartedAt!
  ) {
    next.voice = null;
    return { state: next, reason: "unconfirmed_snapshot", pointsUnits: 0 };
  }
  const current = qualified(state, sample, now);
  const anchor: ActivityVoiceAnchor = {
    sequence: sample.sequence,
    wallTime: sample.wallTime,
    monotonicMs: sample.monotonicMs,
    members: Object.fromEntries(
      Object.entries(current).map(([id, participant]) => [
        id,
        { joinedAt: participant.member.joinedAt, channelId: participant.channel.channelId },
      ]),
    ),
  };
  next.voice = anchor;
  if (!previous) return { state: next, reason: "baseline", pointsUnits: 0 };
  const duration = sample.monotonicMs - previous.monotonicMs,
    wallDuration = sample.wallTime - previous.wallTime;
  if (
    sample.continuous !== true ||
    sample.sequence !== previous.sequence + 1 ||
    duration <= 0 ||
    duration > policy.maxVoiceGapMs ||
    wallDuration < 0 ||
    Math.abs(duration - wallDuration) > policy.clockSkewMs
  )
    return { state: next, reason: "uncertain_interval", pointsUnits: 0 };
  let pointsUnits = 0;
  for (const [id, participant] of Object.entries(current)) {
    const prior = previous.members[id];
    if (
      !prior ||
      prior.joinedAt !== participant.member.joinedAt ||
      prior.channelId !== participant.channel.channelId
    )
      continue;
    for (const segment of daySegments(
      previous.wallTime,
      sample.wallTime,
      duration,
      state.period.timeZone,
    )) {
      const key = `${id}:${segment.date}`,
        used = next.daily[key]?.voiceMs ?? 0;
      const granted = Math.max(0, Math.min(segment.duration, policy.maxVoiceMsPerDay - used));
      if (!granted) continue;
      const units = weightedVoiceUnits(granted, policy.voiceWeight);
      addActivityAward(
        next,
        participant.member,
        segment.date,
        { messageCount: 0, voiceMs: granted, pointsUnits: units },
        sample.wallTime,
      );
      pointsUnits = activityAdd(pointsUnits, units);
    }
  }
  return { state: next, reason: pointsUnits ? "awarded" : "no_qualified_interval", pointsUnits };
}
