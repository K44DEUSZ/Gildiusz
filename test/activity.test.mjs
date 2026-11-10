import assert from "node:assert/strict";
import test from "node:test";
import {
  ActivityError,
  activityPointUnits,
  activityProductionReadiness,
  createActivityState,
  normalizeActivityPolicy,
  configureActivity,
  startActivity,
  stopActivity,
  suspendActivityObservation,
  beginActivityObservation,
  awardActivityMessage,
  observeActivityVoice,
  readActivityRanking,
  activityRankFor,
  localActivityDate,
} from "../dist/modules/activity/index.js";

const { structuredClone } = globalThis;

const guild = "100000000000000001",
  otherGuild = "200000000000000001";
const owner = "100000000000000002",
  a = "100000000000000003",
  b = "100000000000000004",
  c = "100000000000000005";
const text = "100000000000000010",
  secondText = "100000000000000011",
  voice = "100000000000000012";
const parent = "100000000000000013",
  thread = "100000000000000014",
  excluded = "100000000000000015";
const now = Date.parse("2026-11-10T12:00:00Z"),
  joinedAt = Date.parse("2026-01-01T00:00:00Z");
const error = (code) => (value) => value instanceof ActivityError && value.code === code;
// Explicit local fixture policy. These numbers are not a product configuration or an approved retention period.
const policy = (patch = {}) => ({
  messageWeight: 2,
  voiceWeight: 1,
  messageCooldownMs: 60000,
  maxMessagesPerDay: 100,
  maxVoiceMsPerDay: 7200000,
  messageDelayMs: 120000,
  factMaxAgeMs: 15000,
  maxVoiceGapMs: 45000,
  clockSkewMs: 5000,
  minVoiceHumans: 2,
  selfMuteCounts: true,
  textChannelIds: [text, secondText],
  threadParentIds: [],
  voiceChannelIds: [voice],
  excludedChannelIds: [excluded],
  excludedMemberIds: [],
  timeZone: "Europe/Warsaw",
  ranks: [
    { id: "start", name: "Początek", thresholdPoints: 0 },
    { id: "regular", name: "Bywalec", thresholdPoints: 10 },
  ],
  ...patch,
});
const member = (id = a, at = now, patch = {}) => ({
  guildId: guild,
  userId: id,
  joinedAt,
  observedAt: at,
  present: true,
  bot: false,
  pending: false,
  timedOut: false,
  excluded: false,
  ...patch,
});
const admin = (at = now, patch = {}) => ({
  ...member(owner, at),
  owner: true,
  manageGuild: false,
  ...patch,
});
const channel = (id = text, at = now, patch = {}) => ({
  guildId: guild,
  channelId: id,
  observedAt: at,
  kind: "text",
  parentIds: [],
  ancestryComplete: true,
  viewable: true,
  connectable: true,
  excluded: false,
  technical: false,
  afk: false,
  ...patch,
});
const snowflake = (at, sequence = 0) =>
  (((BigInt(at) - 1420070400000n) << 22n) + BigInt(sequence)).toString();
const event = (state, at = now + 1000, patch = {}) => ({
  guildId: guild,
  messageId: snowflake(at),
  userId: a,
  channelId: text,
  createdAt: at,
  settingsRevision: state.settingsRevision,
  generation: state.generation,
  observationEpoch: state.observationEpoch,
  source: "create",
  webhook: false,
  system: false,
  filter: "allowed",
  ...patch,
});
function start(state, at = now, epoch = "epoch_one") {
  return startActivity(
    state,
    admin(at),
    state.settingsRevision,
    {
      periodId: "period_one",
      epoch,
      notice: {
        guildId: guild,
        settingsRevision: state.settingsRevision,
        confirmed: true,
        observedAt: at,
      },
    },
    at,
  );
}
function configured(patch = {}, visibility = "administrators", at = now) {
  return configureActivity(createActivityState(guild), admin(at), 0, policy(patch), visibility, at);
}
const enabled = (patch = {}, visibility = "administrators", at = now) =>
  start(configured(patch, visibility, at), at);
const message = (state, at = now + 1000, e = {}, m = {}, ch = {}) =>
  awardActivityMessage(
    state,
    event(state, at, e),
    member(e.userId ?? a, at, m),
    channel(e.channelId ?? text, at, ch),
    at,
  );
const participant = (id, at, m = {}, ch = {}, flags = {}) => ({
  member: member(id, at, m),
  channel: channel(voice, at, { kind: "voice", ...ch }),
  selfMute: false,
  selfDeaf: false,
  serverDeaf: false,
  ...flags,
});
const snapshot = (state, at, monotonicMs, sequence, people = [a, b], patch = {}) => ({
  guildId: guild,
  settingsRevision: state.settingsRevision,
  generation: state.generation,
  observationEpoch: state.observationEpoch,
  wallTime: at,
  monotonicMs,
  sequence,
  connected: true,
  complete: true,
  continuous: true,
  participants: people.map((id) => participant(id, at)),
  ...patch,
});
function voicePair(state, duration = 30000, first = now, patch = {}) {
  const baseline = observeActivityVoice(state, snapshot(state, first, 0, 1), first).state;
  return observeActivityVoice(
    baseline,
    snapshot(baseline, first + duration, duration, 2, [a, b], patch),
    first + duration,
  );
}

test("activity is OFF and planned without an implicit policy, persistent collector or metadata tracking", () => {
  const state = createActivityState(guild),
    before = structuredClone(state);
  assert.equal(state.enabled, false);
  assert.equal(state.visibility, "administrators");
  assert.equal(activityProductionReadiness.availability, "planned");
  assert.equal(activityProductionReadiness.persistentCollectionAllowed, false);
  for (const decision of [
    "retention",
    "individual_erasure_and_restore",
    "membership_return_and_opt_out",
  ])
    assert.ok(activityProductionReadiness.pending.includes(decision));
  assert.equal(message(state).state, state);
  assert.equal(observeActivityVoice(state, snapshot(state, now, 0, 1), now).state, state);
  assert.deepEqual(state, before);
});

test("explicit policy and notice are required, while missing numeric choices never receive defaults", () => {
  const state = configured(),
    input = {
      periodId: "period_one",
      epoch: "one",
      notice: {
        guildId: guild,
        settingsRevision: state.settingsRevision,
        observedAt: now,
        confirmed: false,
      },
    };
  assert.throws(
    () => startActivity(state, admin(), state.settingsRevision, input, now),
    error("notice_unconfirmed"),
  );
  const missing = policy();
  delete missing.messageWeight;
  assert.throws(() => normalizeActivityPolicy(missing));
  for (const value of [-1, NaN, Infinity, "2", 0.5])
    assert.throws(() => normalizeActivityPolicy(policy({ messageWeight: value })));
  assert.throws(
    () => normalizeActivityPolicy(policy({ timeZone: "Not/AZone" })),
    error("invalid_timezone"),
  );
  assert.throws(
    () => normalizeActivityPolicy({ ...policy(), roleId: voice }),
    error("invalid_policy"),
  );
});

test("configuration requires fresh administrator authority and CAS without changing input on failure", () => {
  const state = configured(),
    before = structuredClone(state);
  for (const actor of [
    admin(now, { owner: false, manageGuild: false }),
    admin(now, { observedAt: now - 15001 }),
    admin(now, { pending: true }),
    admin(now, { bot: true }),
    admin(now, { timedOut: true }),
    admin(now, { present: null }),
  ])
    assert.throws(
      () => configureActivity(state, actor, state.settingsRevision, policy(), "members", now),
      error("permission_revoked"),
    );
  assert.throws(
    () => configureActivity(state, admin(), 0, policy(), "members", now),
    error("revision_conflict"),
  );
  assert.deepEqual(state, before);
});

test("a message awards integer units once, without retaining text, hashes, raw events or avatar data", () => {
  const state = enabled(),
    before = structuredClone(state),
    first = message(state);
  assert.equal(first.pointsUnits, 2 * activityPointUnits);
  assert.equal(first.state.totals[a].messageCount, 1);
  assert.deepEqual(state, before);
  assert.deepEqual(Object.keys(first.state.messageReceipts[snowflake(now + 1000)]).sort(), [
    "createdAt",
    "pointsUnits",
  ]);
  assert.equal(message(first.state).reason, "duplicate");
  assert.throws(
    () => message(state, now + 1000, { content: "PRIVATE MESSAGE CONTENT" }),
    error("invalid_event"),
  );
  assert.equal(JSON.stringify(first.state).includes("PRIVATE MESSAGE CONTENT"), false);
  assert.equal(JSON.stringify(first.state).includes("contentHash"), false);
});

test("cooldown is shared across channels and survives OFF/ON, with no reward for late or forged historical events", () => {
  let state = message(enabled()).state;
  assert.equal(message(state, now + 2000, { channelId: secondText }).reason, "cooldown");
  const late = event(state, now + 1000);
  assert.equal(
    awardActivityMessage(
      state,
      late,
      member(a, now + 122000),
      channel(text, now + 122000),
      now + 122000,
    ).reason,
    "outside_observation",
  );
  assert.throws(
    () => message(state, now + 2000, { createdAt: now + 1000 }),
    error("invalid_event_time"),
  );
  state = stopActivity(state, admin(now + 3000), state.settingsRevision, now + 3000);
  state = start(state, now + 4000, "epoch_two");
  assert.equal(message(state, now + 5000).reason, "cooldown");
  assert.equal(message(state, now + 61000).reason, "awarded");
  assert.equal(
    awardActivityMessage(
      state,
      late,
      member(a, now + 61000),
      channel(text, now + 61000),
      now + 61000,
    ).pointsUnits,
    0,
  );
});

test("bots, webhook/system/history/edit events, filter uncertainty, pending and excluded channels cannot earn points", () => {
  const state = enabled();
  for (const patch of [
    { source: "edit" },
    { source: "delete" },
    { source: "history" },
    { webhook: true },
    { system: true },
    { filter: "blocked" },
    { filter: "unknown" },
  ])
    assert.equal(message(state, now + 1000, patch).pointsUnits, 0);
  for (const patch of [
    { bot: true },
    { pending: true },
    { pending: null },
    { timedOut: true },
    { present: false },
    { present: null },
    { excluded: true },
    { observedAt: now - 20000 },
  ])
    assert.equal(message(state, now + 1000, {}, patch).pointsUnits, 0);
  for (const patch of [
    { technical: true },
    { afk: true },
    { excluded: true },
    { ancestryComplete: false },
    { viewable: null },
    { parentIds: [excluded] },
  ])
    assert.equal(message(state, now + 1000, {}, {}, patch).pointsUnits, 0);
  assert.deepEqual(state.totals, {});
});

test("threads require an explicit parent opt-in and inherit excluded ancestors", () => {
  assert.equal(
    message(
      enabled(),
      now + 1000,
      { channelId: thread },
      {},
      { kind: "thread", parentIds: [parent] },
    ).reason,
    "outside_scope",
  );
  const state = enabled({ threadParentIds: [parent] });
  assert.equal(
    message(state, now + 1000, { channelId: thread }, {}, { kind: "thread", parentIds: [parent] })
      .reason,
    "awarded",
  );
  assert.equal(
    message(
      state,
      now + 1000,
      { channelId: thread },
      {},
      { kind: "thread", parentIds: [parent, excluded] },
    ).pointsUnits,
    0,
  );
});

test("daily message caps are evaluated from current counters in each pure commit, including a race for the last award", () => {
  let current = enabled({ maxMessagesPerDay: 1 });
  const before = current,
    first = message(before),
    competing = message(before, now + 61000);
  const commit = (expectedRevision, next) => {
    if (expectedRevision !== current.revision) return false;
    current = next;
    return true;
  };
  assert.equal(commit(before.revision, first.state), true);
  assert.equal(commit(before.revision, competing.state), false);
  assert.equal(message(current, now + 61000).reason, "daily_limit");
  assert.equal(current.totals[a].messageCount, 1);
});

test("foreign guild/member/channel facts cannot affect another guild", () => {
  const state = enabled(),
    untouched = createActivityState(otherGuild),
    before = structuredClone(state);
  assert.throws(() => message(state, now + 1000, { guildId: otherGuild }), error("guild_mismatch"));
  assert.throws(
    () => message(state, now + 1000, {}, { guildId: otherGuild }),
    error("guild_mismatch"),
  );
  assert.throws(
    () => message(state, now + 1000, {}, {}, { guildId: otherGuild }),
    error("guild_mismatch"),
  );
  assert.throws(() => message(state, now + 1000, {}, { userId: b }), error("fact_mismatch"));
  assert.deepEqual(state, before);
  assert.deepEqual(untouched.totals, {});
});

test("a rejoin cannot revive an old membership or silently choose an unapproved score-transfer policy", () => {
  const state = message(enabled()).state;
  const nextJoin = now + 2000;
  assert.equal(
    message(state, now + 61000, {}, { joinedAt: nextJoin }).reason,
    "membership_return_policy_pending",
  );
  assert.equal(message(enabled(), now + 1000, {}, { joinedAt: now + 2000 }).pointsUnits, 0);
  assert.deepEqual(
    readActivityRanking(
      state,
      admin(now + 61000),
      [member(a, now + 61000, { joinedAt: nextJoin })],
      now + 61000,
    ),
    [],
  );
});

test("confirmed two-human voice endpoints give exact proportional units without audio or a Discord role effect", () => {
  const result = voicePair(enabled());
  assert.equal(result.pointsUnits, activityPointUnits);
  assert.equal(result.state.totals[a].pointsUnits, activityPointUnits / 2);
  assert.equal(result.state.totals[a].voiceMs, 30000);
  assert.deepEqual(Object.keys(result.state.voice.members[a]).sort(), ["channelId", "joinedAt"]);
  assert.equal(JSON.stringify(result.state).includes("roleId"), false);
  assert.equal(JSON.stringify(result.state).includes("audio"), false);
});

test("solo, bot company, AFK/deaf/Stage/technical/unknown presence and duplicate roster rows never establish a qualifying interval", () => {
  const state = enabled(),
    end = now + 30000;
  const cases = [
    [participant(a, now)],
    [participant(a, now), participant(b, now, { bot: true })],
    [participant(a, now), participant(b, now, {}, { afk: true })],
    [participant(a, now), participant(b, now, {}, { kind: "stage" })],
    [participant(a, now), participant(b, now, {}, { technical: true })],
    [participant(a, now), participant(b, now, { present: null })],
    [participant(a, now), participant(b, now, {}, {}, { selfDeaf: true })],
    [participant(a, now), participant(b, now, {}, {}, { serverDeaf: true })],
  ];
  for (const participants of cases) {
    const first = observeActivityVoice(
      state,
      snapshot(state, now, 0, 1, [], { participants }),
      now,
    ).state;
    assert.equal(observeActivityVoice(first, snapshot(first, end, 30000, 2), end).pointsUnits, 0);
  }
  assert.throws(
    () => observeActivityVoice(state, snapshot(state, now, 0, 1, [a, a]), now),
    error("invalid_snapshot"),
  );
});

test("selfMute is an explicit policy choice, while unknown flags remain ineligible", () => {
  for (const [choice, expected] of [
    [true, activityPointUnits],
    [false, 0],
  ]) {
    const state = enabled({ selfMuteCounts: choice });
    const get = (at) => [
      participant(a, at, {}, {}, { selfMute: true }),
      participant(b, at, {}, {}, { selfMute: true }),
    ];
    const first = observeActivityVoice(
      state,
      snapshot(state, now, 0, 1, [], { participants: get(now) }),
      now,
    ).state;
    assert.equal(
      observeActivityVoice(
        first,
        snapshot(first, now + 30000, 30000, 2, [], { participants: get(now + 30000) }),
        now + 30000,
      ).pointsUnits,
      expected,
    );
  }
});

test("voice requires full continuous snapshots at both ends and does not backfill gaps or clock jumps", () => {
  const state = enabled(),
    first = observeActivityVoice(state, snapshot(state, now, 0, 1), now).state;
  for (const [wall, mono, patch] of [
    [30000, 30000, { connected: null }],
    [30000, 30000, { complete: false }],
    [30000, 30000, { continuous: false }],
    [46000, 46000, {}],
    [30000, 0, {}],
    [40000, 30000, {}],
    [10000, 30000, {}],
  ]) {
    const result = observeActivityVoice(
      first,
      snapshot(first, now + wall, mono, 2, [a, b], patch),
      now + wall,
    );
    assert.equal(result.pointsUnits, 0);
    assert.deepEqual(result.state.totals, {});
  }
  const noFirst = observeActivityVoice(
    state,
    snapshot(state, now, 0, 1, [a, b], { complete: false }),
    now,
  ).state;
  assert.equal(
    observeActivityVoice(noFirst, snapshot(noFirst, now + 30000, 30000, 2), now + 30000).reason,
    "baseline",
  );
});

test("reordered voice callbacks cannot replace the current anchor; reconnect starts a new epoch without offline credit", () => {
  let state = voicePair(enabled()).state;
  const stale = snapshot(state, now + 1000, 1000, 1);
  assert.equal(observeActivityVoice(state, stale, now + 30000).state, state);
  const old = snapshot(state, now + 40000, 40000, 3);
  state = suspendActivityObservation(state, state.revision);
  assert.equal(observeActivityVoice(state, old, now + 40000).pointsUnits, 0);
  state = beginActivityObservation(
    state,
    state.revision,
    { guildId: guild, epoch: "after_restart", observedAt: now + 600000, connected: true },
    now + 600000,
  );
  assert.equal(observeActivityVoice(state, old, now + 600000).state, state);
  const baseline = observeActivityVoice(
    state,
    snapshot(state, now + 600000, 0, 1),
    now + 600000,
  ).state;
  const result = observeActivityVoice(
    baseline,
    snapshot(baseline, now + 630000, 30000, 2),
    now + 630000,
  );
  assert.equal(result.state.totals[a].voiceMs, 60000);
});

test("voice membership/channel changes cannot bridge an interval, and daily caps grant only its remaining duration", () => {
  const state = enabled({ maxVoiceMsPerDay: 15000 }),
    result = voicePair(state);
  assert.equal(result.state.totals[a].voiceMs, 15000);
  const baseline = observeActivityVoice(enabled(), snapshot(enabled(), now, 0, 1), now).state;
  const participants = [
    participant(a, now + 30000, { joinedAt: now + 1000 }),
    participant(b, now + 30000),
  ];
  const changed = observeActivityVoice(
    baseline,
    snapshot(baseline, now + 30000, 30000, 2, [], { participants }),
    now + 30000,
  );
  assert.equal(changed.state.totals[a], undefined);
  assert.equal(changed.state.totals[b].voiceMs, 30000);
  assert.equal(
    observeActivityVoice(result.state, snapshot(result.state, now + 45000, 45000, 3), now + 45000)
      .pointsUnits,
    0,
  );
});

test("local midnight splits monotonic voice duration into each day's cap, including a DST transition day", () => {
  const boundary = Date.parse("2026-10-25T23:00:00Z"),
    startAt = boundary - 15000;
  const state = enabled({ maxVoiceMsPerDay: 20000 }, "administrators", startAt);
  const first = observeActivityVoice(state, snapshot(state, startAt, 0, 1), startAt).state;
  const result = observeActivityVoice(
    first,
    snapshot(first, boundary + 15000, 30000, 2),
    boundary + 15000,
  );
  assert.equal(result.state.daily[`${a}:2026-10-25`].voiceMs, 15000);
  assert.equal(result.state.daily[`${a}:2026-10-26`].voiceMs, 15000);
  assert.equal(
    localActivityDate(Date.parse("2026-10-25T00:30:00Z"), "Europe/Warsaw"),
    "2026-10-25",
  );
  assert.equal(
    localActivityDate(Date.parse("2026-10-25T01:30:00Z"), "Europe/Warsaw"),
    "2026-10-25",
  );
});

test("changing weights stops observation, preserves earlier points/cooldown, and cannot silently change a period timezone", () => {
  let state = message(enabled()).state;
  const old = event(state, now + 61000);
  state = configureActivity(
    state,
    admin(now + 60000),
    state.settingsRevision,
    policy({ messageWeight: 5 }),
    "administrators",
    now + 60000,
  );
  assert.equal(state.enabled, false);
  assert.equal(state.voice, null);
  state = start(state, now + 60000, "new_policy");
  assert.equal(
    awardActivityMessage(
      state,
      old,
      member(a, now + 61000),
      channel(text, now + 61000),
      now + 61000,
    ).pointsUnits,
    0,
  );
  const result = message(state, now + 61000);
  assert.equal(result.state.totals[a].pointsUnits, 7 * activityPointUnits);
  assert.throws(
    () =>
      configureActivity(
        state,
        admin(now + 60000),
        state.settingsRevision,
        policy({ timeZone: "UTC" }),
        "members",
        now + 60000,
      ),
    error("period_change_pending"),
  );
});

test("zero source weights and empty scopes create no dedupe, voice checkpoints or totals", () => {
  const state = enabled({ messageWeight: 0, voiceWeight: 0 });
  assert.equal(message(state).state, state);
  assert.equal(observeActivityVoice(state, snapshot(state, now, 0, 1), now).state, state);
  assert.equal(message(enabled({ textChannelIds: [] })).pointsUnits, 0);
  assert.deepEqual(state.messageReceipts, {});
  assert.deepEqual(state.totals, {});
  assert.equal(state.voice, null);
});

test("ranking is admin-only by default, explicit member visibility stops at OFF, and unknown/departed people stay hidden", () => {
  let state = message(enabled()).state;
  assert.throws(
    () =>
      readActivityRanking(
        state,
        { ...member(b, now + 1000), owner: false, manageGuild: false },
        [member(a, now + 1000)],
        now + 1000,
      ),
    error("permission_revoked"),
  );
  state = message(enabled({}, "members")).state;
  const reader = { ...member(b, now + 1000), owner: false, manageGuild: false };
  assert.equal(readActivityRanking(state, reader, [member(a, now + 1000)], now + 1000).length, 1);
  assert.deepEqual(
    readActivityRanking(state, reader, [member(a, now + 1000, { present: null })], now + 1000),
    [],
  );
  assert.deepEqual(
    readActivityRanking(state, reader, [member(a, now + 1000, { present: false })], now + 1000),
    [],
  );
  state = stopActivity(state, admin(now + 1000), state.settingsRevision, now + 1000);
  assert.throws(
    () => readActivityRanking(state, reader, [member(a, now + 1000)], now + 1000),
    error("permission_revoked"),
  );
  assert.equal(
    readActivityRanking(state, admin(now + 1000), [member(a, now + 1000)], now + 1000).length,
    1,
  );
});

test("custom ranks are labels with exact thresholds and ties share a position without any role assignment", () => {
  let state = enabled();
  for (const id of [a, b])
    state = message(state, now + 1000, {
      userId: id,
      messageId: snowflake(now + 1000, Number(id.slice(-1))),
    }).state;
  state = message(state, now + 1000, { userId: c, messageId: snowflake(now + 1000, 10) }).state;
  state = message(state, now + 61000, { userId: a }).state;
  state = message(state, now + 61000, { userId: b, messageId: snowflake(now + 61000, 1) }).state;
  const result = readActivityRanking(
    state,
    admin(now + 61000),
    [a, b, c].map((id) => member(id, now + 61000)),
    now + 61000,
  );
  assert.deepEqual(
    result.map((entry) => entry.position),
    [1, 1, 3],
  );
  assert.equal(activityRankFor(state, 10 * activityPointUnits - 1).id, "start");
  const rank = activityRankFor(state, 10 * activityPointUnits);
  rank.name = "Changed externally";
  assert.equal(state.policy.ranks[1].name, "Bywalec");
  for (const ranks of [
    [
      { id: "x", name: "A", thresholdPoints: 10 },
      { id: "y", name: "B", thresholdPoints: 10 },
    ],
    [{ id: "x", name: "<@everyone>", thresholdPoints: 0 }],
  ])
    assert.throws(() => normalizeActivityPolicy(policy({ ranks })), error("invalid_ranks"));
});

test("arithmetic overflow fails atomically instead of partially changing totals or creating a receipt", () => {
  const state = enabled();
  state.totals[a] = {
    userId: a,
    joinedAt,
    pointsUnits: Number.MAX_SAFE_INTEGER - 1,
    messageCount: 0,
    voiceMs: 0,
    revision: 0,
    lastActivityAt: now,
  };
  const before = structuredClone(state);
  assert.throws(() => message(state), error("invalid_number"));
  assert.deepEqual(state, before);
});

test("measurement opt-out does not remove an administrator's authority to stop or configure the module", () => {
  const state = enabled(),
    actor = admin(now + 1000, { excluded: true });
  const stopped = stopActivity(state, actor, state.settingsRevision, now + 1000);
  assert.equal(stopped.enabled, false);
  const configured = configureActivity(
    stopped,
    actor,
    stopped.settingsRevision,
    policy(),
    "members",
    now + 1000,
  );
  assert.equal(configured.visibility, "members");
});

test("voice evidence obtained after a snapshot's timestamp cannot be borrowed to prove its earlier endpoint", () => {
  const state = enabled();
  const first = observeActivityVoice(state, snapshot(state, now, 0, 1), now).state;
  const participants = [participant(a, now + 31000), participant(b, now + 31000)];
  const result = observeActivityVoice(
    first,
    snapshot(first, now + 30000, 30000, 2, [], { participants }),
    now + 31000,
  );
  assert.equal(result.pointsUnits, 0);
  assert.deepEqual(result.state.totals, {});
});

test("a missing voice sequence and a channel move cannot bridge a qualified interval", () => {
  const state = enabled({ voiceChannelIds: [voice, secondText] });
  const first = observeActivityVoice(state, snapshot(state, now, 0, 1), now).state;
  assert.equal(
    observeActivityVoice(first, snapshot(first, now + 30000, 30000, 3), now + 30000).pointsUnits,
    0,
  );
  const participants = [a, b].map((id) =>
    participant(id, now + 30000, {}, { channelId: secondText }),
  );
  assert.equal(
    observeActivityVoice(
      first,
      snapshot(first, now + 30000, 30000, 2, [], { participants }),
      now + 30000,
    ).pointsUnits,
    0,
  );
});

test("an old lifecycle callback cannot switch a newer epoch or restore measurement after OFF", () => {
  let state = enabled();
  const oldRevision = state.revision;
  state = suspendActivityObservation(state, state.revision);
  assert.throws(
    () =>
      beginActivityObservation(
        state,
        oldRevision,
        { guildId: guild, epoch: "old", observedAt: now, connected: true },
        now,
      ),
    error("revision_conflict"),
  );
  const off = stopActivity(state, admin(), state.settingsRevision, now);
  assert.throws(
    () =>
      beginActivityObservation(
        off,
        off.revision,
        { guildId: guild, epoch: "old", observedAt: now, connected: true },
        now,
      ),
    error("disabled"),
  );
  assert.deepEqual(off.totals, {});
});

test("DST clock skips and repeated local hours never add an hour or reset the same day's cap", () => {
  for (const instant of ["2026-03-29T00:59:45Z", "2026-10-25T00:59:45Z"]) {
    const at = Date.parse(instant),
      state = enabled({ maxVoiceMsPerDay: 20000 }, "administrators", at);
    const first = observeActivityVoice(state, snapshot(state, at, 0, 1), at).state;
    const second = observeActivityVoice(
      first,
      snapshot(first, at + 30000, 30000, 2),
      at + 30000,
    ).state;
    assert.equal(second.totals[a].voiceMs, 20000);
    const result = observeActivityVoice(second, snapshot(second, at + 60000, 60000, 3), at + 60000);
    assert.equal(result.pointsUnits, 0);
    assert.equal(
      Object.keys(result.state.daily).filter((key) => key.startsWith(a + ":")).length,
      1,
    );
  }
});

for (const uncertain of [
  { connected: false },
  { connected: null },
  { complete: false },
  { complete: null },
])
  test(`a nullable voice anchor cannot erase the epoch sequence fence after ${JSON.stringify(uncertain)}`, () => {
    let state = enabled();
    const first = snapshot(state, now, 0, 1);
    state = observeActivityVoice(state, first, now).state;
    const second = snapshot(state, now + 1000, 1000, 2);
    state = observeActivityVoice(state, second, now + 1000).state;
    assert.equal(state.totals[a].voiceMs, 1000);
    state = observeActivityVoice(
      state,
      snapshot(state, now + 2000, 2000, 3, [a, b], uncertain),
      now + 2000,
    ).state;
    assert.equal(state.voice, null);
    assert.equal(state.voiceHighWatermark.sequence, 3);
    const beforeReplay = state;
    for (const stale of [first, second]) {
      const result = observeActivityVoice(state, stale, now + 3000);
      assert.equal(result.reason, "stale_sequence");
      assert.equal(result.pointsUnits, 0);
      assert.equal(result.state, beforeReplay);
    }
    state = observeActivityVoice(state, snapshot(state, now + 4000, 4000, 4), now + 4000).state;
    assert.equal(
      state.totals[a].voiceMs,
      1000,
      "the first certain snapshot is only a new baseline",
    );
    state = observeActivityVoice(state, snapshot(state, now + 5000, 5000, 5), now + 5000).state;
    assert.equal(state.totals[a].voiceMs, 2000);
    assert.equal(state.voiceHighWatermark.sequence, 5);
  });

test("suspending and re-entering the same epoch preserves its watermark; only a new epoch restarts sequence numbers", () => {
  let state = enabled();
  const first = snapshot(state, now, 0, 1);
  state = observeActivityVoice(state, first, now).state;
  const second = snapshot(state, now + 1000, 1000, 2);
  state = observeActivityVoice(state, second, now + 1000).state;
  state = suspendActivityObservation(state, state.revision);
  assert.equal(state.voiceHighWatermark.sequence, 2);
  const sameEpoch = first.observationEpoch;
  state = beginActivityObservation(
    state,
    state.revision,
    { guildId: guild, epoch: sameEpoch, observedAt: now + 2000, connected: true },
    now + 2000,
  );
  for (const replay of [first, second])
    assert.equal(observeActivityVoice(state, replay, now + 3000).reason, "stale_sequence");
  state = observeActivityVoice(state, snapshot(state, now + 3000, 3000, 3), now + 3000).state;
  state = observeActivityVoice(state, snapshot(state, now + 4000, 4000, 4), now + 4000).state;
  assert.equal(state.totals[a].voiceMs, 2000);
  state = suspendActivityObservation(state, state.revision);
  state = beginActivityObservation(
    state,
    state.revision,
    { guildId: guild, epoch: "actually_new_epoch", observedAt: now + 5000, connected: true },
    now + 5000,
  );
  assert.equal(state.voiceHighWatermark.sequence, 0);
  assert.equal(observeActivityVoice(state, { ...second, sequence: 9999 }, now + 5000).state, state);
  state = observeActivityVoice(state, snapshot(state, now + 6000, 0, 1), now + 6000).state;
  state = observeActivityVoice(state, snapshot(state, now + 7000, 1000, 2), now + 7000).state;
  assert.equal(state.totals[a].voiceMs, 3000);
});

test("a new settings generation can start its own sequence without admitting any earlier generation's replay", () => {
  let state = enabled();
  state = observeActivityVoice(state, snapshot(state, now, 0, 1), now).state;
  const old = snapshot(state, now + 1000, 1000, 2);
  state = observeActivityVoice(state, old, now + 1000).state;
  state = configureActivity(
    state,
    admin(now + 2000),
    state.settingsRevision,
    policy(),
    "administrators",
    now + 2000,
  );
  state = start(state, now + 3000);
  assert.equal(state.voiceHighWatermark.sequence, 0);
  assert.equal(observeActivityVoice(state, old, now + 3000).state, state);
  state = observeActivityVoice(state, snapshot(state, now + 3000, 0, 1), now + 3000).state;
  state = observeActivityVoice(state, snapshot(state, now + 4000, 1000, 2), now + 4000).state;
  assert.equal(state.totals[a].voiceMs, 2000);
});
