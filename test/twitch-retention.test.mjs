import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JobStore } from "../dist/core/jobs/store.js";
import { TwitchHubStore } from "../dist/modules/twitch/store.js";
import { TwitchDispatcher } from "../dist/modules/twitch/dispatcher.js";
import {
  TwitchHistoryRetention,
  twitchHistoryRetentionMs,
} from "../dist/modules/twitch/retention.js";

const guildId = "900000000000000001",
  actorId = "900000000000000002",
  channelId = "900000000000000003";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const draft = () => ({
  broadcasterId: "12345",
  channelId,
  template: "{name} {title} {url}",
  roleIds: [],
  mentionEveryone: false,
  enabled: true,
});
async function fixture(t) {
  const db = new DatabaseSync(":memory:"),
    jobDb = new DatabaseSync(":memory:"),
    f = { now: Date.parse("2026-11-12T12:00:00Z"), available: true, resolverCalls: 0 };
  const hub = new TwitchHubStore(db, { clock: () => f.now, authorize: async () => {} }),
    jobs = new JobStore(jobDb, () => f.now),
    binding = await hub.createBinding(guildId, actorId, "create-binding", draft());
  hub.registerSubscription(binding.broadcasterId, "subscription-one");
  const event = (id, extra = {}) => ({
    id,
    bodyHash: digest(id),
    messageType: "notification",
    subscriptionId: "subscription-one",
    subscriptionType: "stream.online",
    subscriptionVersion: "1",
    subscriptionStatus: "enabled",
    broadcasterId: binding.broadcasterId,
    streamId: "stream-one",
    streamType: "live",
    startedAt: f.now,
    ...extra,
  });
  const challenge = event("challenge", {
    messageType: "webhook_callback_verification",
    challenge: "exact-challenge-response",
  });
  hub.accept(challenge);
  const retention = new TwitchHistoryRetention(db, {
    clock: () => f.now,
    resolveJobStore: (requestedGuild) => {
      f.resolverCalls++;
      return f.available && requestedGuild === guildId ? jobs : undefined;
    },
  });
  const fanout = (streamId, { state = "queued", jobState = "succeeded", at = f.now } = {}) => {
    const input = {
      guildId,
      type: "twitch.send",
      objectId: binding.id,
      generation: binding.generation,
      dueAt: at,
      dedupeKey: `twitch:${digest(JSON.stringify({ bindingId: binding.id, streamId }))}`,
      payload: {
        guildId,
        bindingId: binding.id,
        generation: binding.generation,
        actorId,
        channelId,
        roleIds: [],
        mentionEveryone: false,
        content: "Private execution text",
        stream: { id: streamId, title: "Private stream title" },
      },
    };
    const entry = hub.prepareFanout(binding, streamId, input);
    let job;
    if (state === "queued") {
      job = jobs.enqueue(input);
      jobDb
        .prepare("UPDATE jobs SET state=?,updated_at=?,lease_token=?,lease_until=? WHERE id=?")
        .run(
          jobState,
          at,
          jobState === "running" ? randomUUID() : null,
          jobState === "running" ? at + 60000 : null,
          job.id,
        );
      hub.completeFanout(entry.id, "queued", job.id);
    } else if (state === "skipped") hub.completeFanout(entry.id, "skipped", "private-reason");
    db.prepare("UPDATE twitch_fanout SET updated_at=? WHERE id=?").run(at, entry.id);
    return { entry, job, input };
  };
  t.after(() => {
    db.close();
    jobDb.close();
  });
  return Object.assign(f, { db, jobDb, hub, jobs, binding, retention, event, challenge, fanout });
}

test("exact30-day minimization preserves inbox reply/hash, terminal stream fences and schemas", async (t) => {
  const f = await fixture(t),
    event = f.event("online");
  f.hub.accept(event);
  f.hub.finishEvent(event.id);
  const queued = f.fanout("stream-one"),
    skipped = f.fanout("skipped-stream", { state: "skipped" });
  const schemas = f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    inbox = f.db
      .prepare("SELECT id,body_hash,received_at,state,response FROM twitch_inbox ORDER BY id")
      .all(),
    fanouts = f.db
      .prepare(
        "SELECT id,binding_id,stream_id,state,job_id,updated_at FROM twitch_fanout ORDER BY id",
      )
      .all(),
    bindings = f.db.prepare("SELECT * FROM twitch_bindings").all(),
    mutations = f.db.prepare("SELECT * FROM twitch_mutations").all();
  f.now += twitchHistoryRetentionMs - 1;
  assert.equal(f.retention.prune().inboxMinimized, 0);
  f.now++;
  const result = f.retention.prune();
  assert.equal(result.inboxMinimized, 2);
  assert.equal(result.fanoutMinimized, 2);
  assert.ok(result.scanned <= 100);
  assert.deepEqual(
    f.db
      .prepare("SELECT id,body_hash,received_at,state,response FROM twitch_inbox ORDER BY id")
      .all(),
    inbox,
  );
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT id,binding_id,stream_id,state,job_id,updated_at FROM twitch_fanout ORDER BY id",
      )
      .all(),
    fanouts,
  );
  assert.deepEqual(f.db.prepare("SELECT * FROM twitch_bindings").all(), bindings);
  assert.deepEqual(f.db.prepare("SELECT * FROM twitch_mutations").all(), mutations);
  assert.deepEqual(f.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(), schemas);
  assert.ok(
    f.db
      .prepare("SELECT envelope,last_error FROM twitch_inbox")
      .all()
      .every((row) => row.envelope === "{}" && row.last_error === null),
  );
  assert.ok(
    f.db
      .prepare("SELECT job,reason FROM twitch_fanout")
      .all()
      .every((row) => row.job === "{}" && row.reason === null),
  );
  assert.deepEqual(f.hub.accept(f.challenge), {
    status: 200,
    body: "exact-challenge-response",
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  assert.deepEqual(f.hub.accept(event), { status: 204, body: "" });
  assert.throws(
    () => f.hub.accept({ ...event, bodyHash: digest("changed") }),
    (error) => error.code === "message_collision",
  );
  assert.equal(f.hub.prepareFanout(f.binding, "stream-one", queued.input).id, queued.entry.id);
  assert.equal(
    f.hub.prepareFanout(f.binding, "skipped-stream", skipped.input).id,
    skipped.entry.id,
  );
  assert.equal(f.retention.prune().fanoutMinimized, 0);
  assert.deepEqual(f.hub.retention, { inboxMs: null, fanoutMs: null });
});

test("pending inbox/fanout and queued pending, running, retry or UNKNOWN work remain untouched", async (t) => {
  const f = await fixture(t);
  f.hub.accept(f.event("pending-inbox"));
  const records = [f.fanout("pending-fanout", { state: "pending" })];
  for (const jobState of ["pending", "running", "retry", "unknown"])
    records.push(f.fanout(jobState, { jobState }));
  const before = records.map(({ entry }) =>
      f.db.prepare("SELECT * FROM twitch_fanout WHERE id=?").get(entry.id),
    ),
    pending = f.db.prepare("SELECT * FROM twitch_inbox WHERE id='pending-inbox'").get();
  f.now += twitchHistoryRetentionMs + 1;
  const result = f.retention.prune();
  assert.equal(result.fanoutMinimized, 0);
  assert.equal(result.deferredFanout, 4);
  assert.deepEqual(
    records.map(({ entry }) =>
      f.db.prepare("SELECT * FROM twitch_fanout WHERE id=?").get(entry.id),
    ),
    before,
  );
  assert.deepEqual(
    f.db.prepare("SELECT * FROM twitch_inbox WHERE id='pending-inbox'").get(),
    pending,
  );
});

test("queued history requires an available same-guild same-object terminal job old enough", async (t) => {
  const f = await fixture(t),
    records = [];
  for (const state of ["succeeded", "failed", "cancelled", "expired"])
    records.push(f.fanout(state, { jobState: state }));
  const recent = f.fanout("recent"),
    missing = f.fanout("missing"),
    wrongScope = f.fanout("wrong-scope");
  f.jobDb.prepare("DELETE FROM jobs WHERE id=?").run(missing.job.id);
  f.jobDb
    .prepare("UPDATE jobs SET guild_id=? WHERE id=?")
    .run("900000000000000009", wrongScope.job.id);
  f.now += twitchHistoryRetentionMs;
  f.jobDb.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(f.now, recent.job.id);
  f.available = false;
  assert.equal(f.retention.prune().fanoutMinimized, 0);
  f.available = true;
  const result = f.retention.prune();
  assert.equal(result.fanoutMinimized, 4);
  assert.equal(result.deferredFanout, 3);
  for (const { entry } of records)
    assert.equal(f.db.prepare("SELECT job FROM twitch_fanout WHERE id=?").get(entry.id).job, "{}");
  for (const { entry } of [recent, missing, wrongScope])
    assert.notEqual(
      f.db.prepare("SELECT job FROM twitch_fanout WHERE id=?").get(entry.id).job,
      "{}",
    );
});

test("bounded cursors pass minimized and indefinitely unresolved prefixes without starvation", async (t) => {
  const f = await fixture(t);
  f.db.prepare("DELETE FROM twitch_inbox").run();
  for (let index = 0; index < 12; index++) {
    f.db
      .prepare(
        "INSERT INTO twitch_inbox(id,body_hash,envelope,received_at,state,response) VALUES (?,?,?,?,'done',?)",
      )
      .run(
        `a-${String(index).padStart(3, "0")}`,
        digest(String(index)),
        "{}",
        f.now,
        JSON.stringify({ status: 204, body: "" }),
      );
    f.db
      .prepare(
        "INSERT INTO twitch_fanout(id,binding_id,stream_id,state,job,updated_at) VALUES (?,?,?,'queued','{}',?)",
      )
      .run(`a-${String(index).padStart(3, "0")}`, f.binding.id, `prefix-${index}`, f.now);
  }
  const unresolved = f.fanout("unresolved-prefix", { jobState: "unknown" });
  f.db.prepare("UPDATE twitch_fanout SET id='b-unresolved' WHERE id=?").run(unresolved.entry.id);
  f.hub.accept(f.event("z-target"));
  f.hub.finishEvent("z-target");
  const target = f.fanout("target", { state: "skipped" });
  f.db.prepare("UPDATE twitch_fanout SET id='z-target' WHERE id=?").run(target.entry.id);
  f.now += twitchHistoryRetentionMs;
  let inbox = 0,
    fanout = 0;
  for (let index = 0; index < 15; index++) {
    const result = f.retention.prune(2);
    assert.ok(result.scanned <= 2);
    inbox += result.inboxMinimized;
    fanout += result.fanoutMinimized;
  }
  assert.equal(inbox, 1);
  assert.equal(fanout, 1);
  assert.equal(
    f.db.prepare("SELECT envelope FROM twitch_inbox WHERE id='z-target'").get().envelope,
    "{}",
  );
  assert.equal(f.db.prepare("SELECT job FROM twitch_fanout WHERE id='z-target'").get().job, "{}");
  assert.notEqual(
    f.db.prepare("SELECT job FROM twitch_fanout WHERE id='b-unresolved'").get().job,
    "{}",
  );
  assert.equal(f.jobs.get(unresolved.job.id).state, "unknown");
});

test("minimized stream fence blocks another dispatch even for a fresh envelope and live lookup", async (t) => {
  const f = await fixture(t);
  f.fanout("stream-one");
  f.now += twitchHistoryRetentionMs;
  f.retention.prune();
  f.hub.accept(f.event("fresh-redelivery"));
  let enqueues = 0;
  const dispatcher = new TwitchDispatcher({
    store: f.hub,
    authorize: async () => {},
    lookupLive: async () => ({
      id: "stream-one",
      broadcasterId: f.binding.broadcasterId,
      login: "fixture",
      displayName: "Fixture",
      title: "Current title",
      category: "Category",
      thumbnailUrl: "https://static-cdn.jtvnw.net/preview.jpg",
      startedAt: f.now,
    }),
    enqueue: (input) => {
      enqueues++;
      return f.jobs.enqueue(input);
    },
  });
  await dispatcher.drain();
  assert.equal(enqueues, 0);
  assert.equal(f.jobDb.prepare("SELECT COUNT(*) n FROM jobs").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM twitch_fanout").get().n, 1);
});

test("binding mutation replay and removed-generation identity survive history minimization", async (t) => {
  const f = await fixture(t),
    removed = await f.hub.removeBinding(
      guildId,
      actorId,
      "remove-once",
      f.binding.id,
      f.binding.revision,
    );
  f.fanout("old-stream", { state: "skipped" });
  f.now += twitchHistoryRetentionMs;
  const before = f.db.prepare("SELECT * FROM twitch_mutations ORDER BY scope,request_id").all();
  f.retention.prune();
  assert.deepEqual(
    f.db.prepare("SELECT * FROM twitch_mutations ORDER BY scope,request_id").all(),
    before,
  );
  const current = await f.hub.createBinding(guildId, actorId, "recreate", draft());
  assert.equal(current.id, removed.id);
  assert.equal(current.generation, removed.generation + 1);
  assert.deepEqual(
    await f.hub.removeBinding(guildId, actorId, "remove-once", f.binding.id, f.binding.revision),
    removed,
  );
  assert.equal(f.hub.binding(current.id).generation, current.generation);
  assert.equal(f.hub.binding(current.id).removed, false);
  await assert.rejects(
    f.hub.createBinding(guildId, actorId, "recreate", { ...draft(), template: "Changed {url}" }),
    (error) => error.code === "idempotency_conflict",
  );
});

test("closed job-store failures defer, invalid bounds reject, and a fresh pruner is idempotent", async (t) => {
  const f = await fixture(t);
  f.fanout("old");
  f.now += twitchHistoryRetentionMs;
  const unavailable = new TwitchHistoryRetention(f.db, {
    clock: () => f.now,
    resolveJobStore: () => {
      throw Error("closed_store");
    },
  });
  assert.equal(unavailable.prune().deferredFanout, 1);
  for (const limit of [0, 101, 1.5]) assert.throws(() => f.retention.prune(limit), /bounds/);
  assert.equal(f.retention.prune().fanoutMinimized, 1);
  const restarted = new TwitchHistoryRetention(f.db, {
    clock: () => f.now,
    resolveJobStore: () => f.jobs,
  });
  assert.equal(restarted.prune().fanoutMinimized, 0);
  const snapshot = JSON.stringify(f.db.prepare("SELECT * FROM twitch_fanout").all());
  restarted.prune();
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM twitch_fanout").all()), snapshot);
});
