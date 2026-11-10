import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { TwitchHubStore } from "../dist/modules/twitch/store.js";
import { EventSubReceiver } from "../dist/modules/twitch/webhook.js";
import { TwitchDispatcher } from "../dist/modules/twitch/dispatcher.js";
import { TwitchError } from "../dist/modules/twitch/types.js";
import { JobStore } from "../dist/core/jobs/store.js";

const guildA = "100000000000000001",
  guildB = "100000000000000002",
  actor = "200000000000000001",
  channelA = "300000000000000001",
  channelB = "300000000000000002",
  roleA = "400000000000000001",
  roleB = "400000000000000002",
  broadcaster = "1337",
  secret = "test-secret-".repeat(5),
  initialNow = Date.parse("2026-11-09T12:00:00Z");
const fails = (code) => (error) => error instanceof TwitchError && error.code === code;
const input = (channelId = channelA, roleIds = [roleA]) => ({
  broadcasterId: broadcaster,
  channelId,
  roleIds,
  mentionEveryone: false,
  enabled: true,
  template: "{name} nadaje: {title}\n{category}\n{url}",
});
const stream = (now = initialNow, extra = {}) => ({
  id: "stream-one",
  broadcasterId: broadcaster,
  login: "twitchexample",
  displayName: "Twórca",
  title: "Tytuł z API",
  category: "Science & Technology",
  thumbnailUrl:
    "https://static-cdn.jtvnw.net/previews-ttv/live_user-twitchexample-{width}x{height}.jpg",
  startedAt: now - 1000,
  ...extra,
});

function body(kind = "notification", extra = {}) {
  return {
    subscription: {
      id: "subscription-one",
      type: "stream.online",
      version: "1",
      status:
        kind === "notification"
          ? "enabled"
          : kind === "revocation"
            ? "authorization_revoked"
            : "webhook_callback_verification_pending",
      condition: { broadcaster_user_id: broadcaster },
    },
    ...(kind === "notification"
      ? {
          event: {
            id: "stream-one",
            broadcaster_user_id: broadcaster,
            broadcaster_user_login: "untrusted_event_login",
            broadcaster_user_name: "Nie używaj mnie",
            type: "live",
            started_at: new Date(initialNow - 1000).toISOString(),
          },
        }
      : kind === "webhook_callback_verification"
        ? { challenge: "challenge-value" }
        : {}),
    ...extra,
  };
}
function request(
  payload,
  kind = "notification",
  { id = "message-one", at = initialNow, rawBody, headers = {} } = {},
) {
  const timestamp = typeof at === "string" ? at : new Date(at).toISOString();
  const raw = rawBody ?? Buffer.from(JSON.stringify(payload));
  return {
    rawBody: raw,
    headers: {
      "Twitch-Eventsub-Message-Id": id,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Type": kind,
      "Twitch-Eventsub-Message-Signature": `sha256=${createHmac("sha256", secret).update(id).update(timestamp).update(raw).digest("hex")}`,
      "Twitch-Eventsub-Subscription-Type": payload.subscription.type,
      "Twitch-Eventsub-Subscription-Version": payload.subscription.version,
      ...headers,
    },
  };
}
function fixture(t, options = {}) {
  let now = initialNow,
    policy = async () => {},
    live = stream();
  const requests = [],
    calls = [],
    handles = [],
    queues = new Map();
  const authorize = async (value) => {
    requests.push(value);
    await policy(value);
  };
  const open = () => {
    const db = new DatabaseSync(options.path ?? ":memory:");
    handles.push(db);
    return new TwitchHubStore(db, { authorize, clock: () => now, retention: options.retention });
  };
  let hub = open();
  const queue = (guildId) => {
    if (!queues.has(guildId)) {
      const db = new DatabaseSync(":memory:");
      handles.push(db);
      queues.set(guildId, new JobStore(db, () => now));
    }
    return queues.get(guildId);
  };
  const receiver = () => new EventSubReceiver({ secret, store: hub, clock: () => now });
  const ready = async (guildId = guildA, draft = input()) => {
    const binding = await hub.createBinding(guildId, actor, `create-${guildId}`, draft);
    if (!hub.source(broadcaster).subscriptionId) {
      hub.registerSubscription(broadcaster, "subscription-one");
      assert.equal(
        receiver().receive(
          request(body("webhook_callback_verification"), "webhook_callback_verification", {
            id: "challenge-one",
            at: now,
          }),
        ).status,
        200,
      );
    }
    return binding;
  };
  const dispatcher = (extra = {}) =>
    new TwitchDispatcher({
      store: hub,
      authorize,
      lookupLive: async (id) => {
        calls.push(id);
        return live;
      },
      enqueue: (job) => queue(job.guildId).enqueue(job),
      ...extra,
    });
  t.after(() => {
    for (const db of handles) {
      try {
        db.close();
      } catch {
        /* Already closed for restart. */
      }
    }
  });
  return {
    get hub() {
      return hub;
    },
    ready,
    receiver,
    dispatcher,
    queue,
    requests,
    calls,
    setNow(value) {
      now = value;
    },
    setPolicy(value) {
      policy = value;
    },
    setLive(value) {
      live = value;
    },
    reopen() {
      hub.db.close();
      hub = open();
      return hub;
    },
    online(id = "message-one", payload = body()) {
      return receiver().receive(request(payload, "notification", { id, at: now }));
    },
  };
}

function directory(t, close = () => {}) {
  const path = mkdtempSync(join(tmpdir(), "gildiusz-twitch-"));
  t.after(() => {
    close();
    if (
      !resolve(path).startsWith(resolve(tmpdir()) + sep) ||
      !basename(path).startsWith("gildiusz-twitch-")
    )
      throw Error("Unexpected test directory.");
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

test("EventSub validates exact raw bytes, case-insensitive headers and strict challenges before persistence", async (t) => {
  const f = fixture(t);
  await f.hub.createBinding(guildA, actor, "initial-binding", input());
  f.hub.registerSubscription(broadcaster, "subscription-one");
  const challenge = body("webhook_callback_verification");
  const raw = Buffer.from(`  ${JSON.stringify(challenge)}\n`);
  const signed = request(challenge, "webhook_callback_verification", { rawBody: raw });
  const lowerCase = {
    rawBody: signed.rawBody,
    headers: Object.fromEntries(
      Object.entries(signed.headers).map(([key, value]) => [key.toLowerCase(), value]),
    ),
  };
  const first = f.receiver().receive(lowerCase);
  assert.deepEqual(first, {
    status: 200,
    body: "challenge-value",
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  assert.deepEqual(f.receiver().receive(lowerCase), first);
  assert.equal(f.hub.source(broadcaster).status, "enabled");
  assert.equal(f.hub.db.prepare("SELECT COUNT(*) AS n FROM twitch_inbox").get().n, 1);
  assert.equal(
    f.receiver().receive({ ...signed, rawBody: Buffer.from(JSON.stringify(challenge)) }).status,
    403,
  );
  assert.equal(
    f
      .receiver()
      .receive(
        request(
          body("webhook_callback_verification", { challenge: 42 }),
          "webhook_callback_verification",
          { id: "bad-challenge" },
        ),
      ).status,
    400,
  );
  assert.equal(
    f.receiver().receive(
      request(challenge, "webhook_callback_verification", {
        id: "duplicate-header",
        headers: { "twitch-eventsub-message-id": "another" },
      }),
    ).status,
    400,
  );
});

test("freshness excludes old and future messages, and IDs cannot be replayed with different bodies", async (t) => {
  const f = fixture(t);
  await f.ready();
  const rerun = body();
  rerun.event.type = "rerun";
  assert.equal(f.online("non-live-stream", rerun).status, 204);
  assert.equal(
    f.hub.db.prepare("SELECT state FROM twitch_inbox WHERE id='non-live-stream'").get().state,
    "ignored",
  );
  for (const signature of ["sha256=00", `sha256=${"0".repeat(64)}`]) {
    assert.equal(
      f.receiver().receive(
        request(body(), "notification", {
          headers: { "Twitch-Eventsub-Message-Signature": signature },
        }),
      ).status,
      403,
    );
  }
  assert.equal(
    f.receiver().receive(request(body(), "notification", { at: initialNow - 600001 })).status,
    403,
  );
  assert.equal(
    f.receiver().receive(request(body(), "notification", { at: initialNow + 60001 })).status,
    403,
  );
  assert.equal(
    f.receiver().receive(request(body(), "notification", { at: "2026-02-30T12:00:00.123456789Z" }))
      .status,
    400,
  );
  assert.equal(f.online().status, 204);
  assert.equal(f.online().status, 204);
  const changed = body();
  changed.event.id = "stream-other";
  assert.equal(f.online("message-one", changed).status, 409);
  assert.equal(f.hub.pending().length, 1);
  const nanosecond = "2026-11-09T12:00:00.123456789Z";
  assert.equal(
    f.receiver().receive(request(body(), "notification", { id: "nanosecond", at: nanosecond }))
      .status,
    204,
  );
});

test("storage failure returns retryable HTTP status and rolls back source changes before any ack", async (t) => {
  const f = fixture(t);
  await f.hub.createBinding(guildA, actor, "binding", input());
  f.hub.registerSubscription(broadcaster, "subscription-one");
  f.hub.db.exec("DROP TABLE twitch_inbox");
  const response = f
    .receiver()
    .receive(request(body("webhook_callback_verification"), "webhook_callback_verification"));
  assert.equal(response.status, 503);
  assert.equal(f.hub.source(broadcaster).status, "pending");
  const unavailable = new EventSubReceiver({
    secret,
    clock: () => initialNow,
    store: {
      accept() {
        throw Error("backend unavailable");
      },
    },
  });
  assert.equal(unavailable.receive(request(body())).status, 503);
});

test("revocation is durable, ignores obsolete subscriptions and stops pending fanout", async (t) => {
  const f = fixture(t),
    binding = await f.ready();
  f.online();
  const revoked = body("revocation");
  assert.equal(f.receiver().receive(request(revoked, "revocation", { id: "revoke" })).status, 204);
  assert.equal(f.hub.source(broadcaster).status, "revoked");
  assert.equal(f.hub.source(broadcaster).reason, "authorization_revoked");
  await f.dispatcher().drain();
  assert.equal(f.queue(guildA).list().length, 0);
  assert.deepEqual(f.hub.fanouts(binding.id), []);
  f.hub.registerSubscription(broadcaster, "replacement-subscription");
  assert.equal(
    f.receiver().receive(request(revoked, "revocation", { id: "old-revoke" })).status,
    204,
  );
  assert.equal(f.hub.source(broadcaster).status, "pending");
  const unsupported = body();
  unsupported.subscription.type = "stream.offline";
  assert.equal(f.online("ignored-event", unsupported).status, 204);
  assert.equal(
    f.hub.db.prepare("SELECT state FROM twitch_inbox WHERE id='ignored-event'").get().state,
    "ignored",
  );
});

test("binding CRUD is guild-scoped, authorization precedes lookup and updates use durable CAS/idempotency", async (t) => {
  const f = fixture(t),
    a = await f.ready(),
    b = await f.ready(guildB, input(channelB, [roleB]));
  assert.equal(f.hub.source(broadcaster).activeBindingCount, 2);
  assert.equal(f.hub.db.prepare("SELECT COUNT(*) AS n FROM twitch_sources").get().n, 1);
  assert.deepEqual(
    (await f.hub.listBindings(guildA, actor)).map((value) => value.id),
    [a.id],
  );
  await assert.rejects(() => f.hub.getBinding(guildA, actor, b.id), fails("not_found"));
  f.setPolicy(async ({ guildId }) => {
    if (guildId === guildB) throw new TwitchError("permission_revoked");
  });
  for (const id of [b.id, "missing"])
    await assert.rejects(() => f.hub.getBinding(guildB, actor, id), fails("permission_revoked"));
  const draft = { ...input(), template: "{name}: {title}\n{url}" };
  const updated = await f.hub.updateBinding(guildA, actor, "update-one", a.id, a.revision, draft);
  assert.equal(updated.generation, a.generation + 1);
  assert.deepEqual(
    await f.hub.updateBinding(guildA, actor, "update-one", a.id, a.revision, draft),
    updated,
  );
  await assert.rejects(
    () => f.hub.updateBinding(guildA, actor, "stale-update", a.id, a.revision, draft),
    fails("revision_conflict"),
  );
  await assert.rejects(
    () => f.hub.updateBinding(guildA, actor, "update-one", a.id, a.revision, input()),
    fails("idempotency_conflict"),
  );
  const removed = await f.hub.removeBinding(guildA, actor, "remove-one", a.id, updated.revision);
  assert.equal(removed.enabled, false);
  assert.equal(f.hub.source(broadcaster).activeBindingCount, 1);
  assert.equal(f.hub.source(broadcaster).status, "enabled");
  const recreated = await f.hub.createBinding(guildA, actor, "recreate-one", input());
  assert.equal(recreated.id, a.id);
  assert.equal(recreated.generation, removed.generation + 1);
});

test("invalid role IDs, duplicate roles, unsafe templates and unknown fields cannot write a binding", async (t) => {
  const f = fixture(t);
  for (const draft of [
    { ...input(), roleIds: [roleA, roleA] },
    { ...input(), roleIds: ["123"] },
    { ...input(), roleIds: new Array(1) },
    { ...input(), template: "{secret}" },
    { ...input(), administrator: true },
    { ...input(), enabled: "true" },
  ])
    await assert.rejects(
      () => f.hub.createBinding(guildA, actor, "invalid", draft),
      fails("invalid_input"),
    );
  assert.equal(f.hub.db.prepare("SELECT COUNT(*) AS n FROM twitch_bindings").get().n, 0);
});

test("one refreshed stream fans out into isolated per-guild queues and cannot ping again after duplicate/edit", async (t) => {
  const f = fixture(t),
    a = await f.ready(),
    b = await f.ready(guildB, input(channelB, [roleB]));
  assert.equal(f.online().status, 204);
  const dispatcher = f.dispatcher();
  const first = await dispatcher.drain();
  assert.equal(first.queued, 2);
  assert.equal(f.calls.length, 1);
  for (const [guildId, channelId, roleId] of [
    [guildA, channelA, roleA],
    [guildB, channelB, roleB],
  ]) {
    const [job] = f.queue(guildId).list();
    assert.equal(job.guildId, guildId);
    assert.equal(job.type, "twitch.send");
    assert.equal(job.payload.guildId, guildId);
    assert.equal(job.payload.channelId, channelId);
    assert.deepEqual(job.payload.roleIds, [roleId]);
    assert.equal(job.payload.stream.title, "Tytuł z API");
    assert.equal(job.payload.stream.url, "https://www.twitch.tv/twitchexample");
    assert.ok(!job.payload.content.includes("Nie używaj mnie"));
  }
  assert.equal(f.online().status, 204);
  assert.equal(f.online("same-stream-new-event").status, 204);
  await dispatcher.drain();
  f.setNow(initialNow + 1000);
  await f.hub.updateBinding(guildA, actor, "edit-template", a.id, a.revision, {
    ...input(),
    template: "Nowy tekst {url}",
  });
  f.online("same-stream-after-edit");
  await dispatcher.drain();
  assert.equal(f.queue(guildA).list().length, 1);
  assert.equal(f.queue(guildB).list().length, 1);
  assert.equal(f.hub.fanouts(a.id).length, 1);
  assert.equal(f.hub.fanouts(b.id).length, 1);
});

test("one recipient's transient failure does not block another guild and is retried safely", async (t) => {
  const f = fixture(t);
  await f.ready();
  await f.ready(guildB, input(channelB, [roleB]));
  f.online();
  let unavailable = true;
  const dispatcher = f.dispatcher({
    enqueue: (job) => {
      if (job.guildId === guildA && unavailable) throw Error("guild queue unavailable");
      return f.queue(job.guildId).enqueue(job);
    },
  });
  const first = await dispatcher.drain();
  assert.equal(first.queued, 1);
  assert.equal(first.failed, 1);
  assert.equal(f.queue(guildA).list().length, 0);
  assert.equal(f.queue(guildB).list().length, 1);
  unavailable = false;
  await dispatcher.drain();
  assert.equal(f.queue(guildA).list().length, 1);
  assert.equal(f.queue(guildB).list().length, 1);
});

test("offline, replaced and old streams are discarded and API outages keep the durable event pending", async (t) => {
  for (const state of [
    null,
    stream(initialNow, { id: "new-stream" }),
    stream(initialNow, { startedAt: initialNow - 600001 }),
  ]) {
    const f = fixture(t);
    await f.ready();
    f.online();
    f.setLive(state);
    assert.equal((await f.dispatcher().drain()).skipped, 1);
    assert.equal(f.queue(guildA).list().length, 0);
    assert.equal(f.hub.pending().length, 0);
  }
  const stale = fixture(t);
  await stale.ready();
  stale.online();
  stale.setNow(initialNow + 600001);
  await stale.dispatcher().drain();
  assert.equal(stale.calls.length, 0);
  const f = fixture(t);
  await f.ready();
  f.online();
  const outage = f.dispatcher({
    lookupLive: async () => {
      throw Error("provider offline");
    },
  });
  assert.equal((await outage.drain()).failed, 1);
  assert.equal(f.hub.pending().length, 1);
  assert.equal((await f.dispatcher().drain()).queued, 1);
});

test("delivery preparation refreshes metadata and checks current guild, generation, permissions and live state", async (t) => {
  const f = fixture(t),
    binding = await f.ready();
  f.online();
  const dispatcher = f.dispatcher();
  await dispatcher.drain();
  f.setLive(stream(initialNow, { title: "Zmieniony tytuł" }));
  const prepared = await dispatcher.prepareDelivery(
    guildA,
    binding.id,
    binding.generation,
    "stream-one",
  );
  assert.equal(prepared.stream.title, "Zmieniony tytuł");
  assert.equal(
    await dispatcher.prepareDelivery(guildB, binding.id, binding.generation, "stream-one"),
    null,
  );
  f.setPolicy(async ({ operation }) => {
    if (operation === "publish") throw new TwitchError("permission_revoked");
  });
  await assert.rejects(
    () => dispatcher.prepareDelivery(guildA, binding.id, binding.generation, "stream-one"),
    fails("permission_revoked"),
  );
  f.setPolicy(async () => {});
  f.setLive(null);
  assert.equal(
    await dispatcher.prepareDelivery(guildA, binding.id, binding.generation, "stream-one"),
    null,
  );
  f.setLive(stream());
  await f.hub.updateBinding(guildA, actor, "disable-binding", binding.id, binding.revision, {
    ...input(),
    enabled: false,
  });
  assert.equal(
    await dispatcher.prepareDelivery(guildA, binding.id, binding.generation, "stream-one"),
    null,
  );
});

test("an actual process exit after guild enqueue but before hub ledger commit replays the identical job once", async (t) => {
  const handles = [];
  const folder = directory(t, () => {
      for (const db of handles) {
        try {
          db.close();
        } catch {
          /* Closed before process restart. */
        }
      }
    }),
    hubPath = join(folder, "integrations.sqlite"),
    queuePath = join(folder, "guild.sqlite");
  const f = fixture(t, { path: hubPath }),
    binding = await f.ready();
  f.online();
  handles.push(f.hub.db);
  f.hub.db.close();
  const source = (name) => pathToFileURL(resolve(`dist/${name}.js`)).href;
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { TwitchHubStore } from ${JSON.stringify(source("modules/twitch/store"))};
    import { TwitchDispatcher } from ${JSON.stringify(source("modules/twitch/dispatcher"))};
    import { JobStore } from ${JSON.stringify(source("core/jobs/store"))};
    const clock=()=>${initialNow};
    const hub=new TwitchHubStore(new DatabaseSync(process.argv[1]),{clock,authorize:async()=>{}});
    const queue=new JobStore(new DatabaseSync(process.argv[2]),clock);
    await new TwitchDispatcher({store:hub,authorize:async()=>{},lookupLive:async()=>(${JSON.stringify(stream())}),enqueue:job=>{queue.enqueue(job);process.exit(73);}}).drain();
  `;
  const crashed = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, hubPath, queuePath],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(crashed.status, 73, crashed.stderr);
  const db = new DatabaseSync(hubPath),
    queueDb = new DatabaseSync(queuePath);
  handles.push(db, queueDb);
  const hub = new TwitchHubStore(db, { clock: () => initialNow + 1000, authorize: async () => {} }),
    jobs = new JobStore(queueDb, () => initialNow + 1000);
  assert.equal(hub.pending().length, 1);
  assert.equal(hub.fanouts(binding.id)[0].state, "pending");
  assert.equal(jobs.list().length, 1);
  const before = jobs.list()[0];
  const recovered = new TwitchDispatcher({
    store: hub,
    authorize: async () => {},
    lookupLive: async () => stream(initialNow, { title: "Tytuł zmieniony po awarii" }),
    enqueue: (job) => jobs.enqueue(job),
  });
  assert.equal((await recovered.drain()).queued, 1);
  assert.equal(jobs.list().length, 1);
  assert.equal(jobs.list()[0].id, before.id);
  assert.deepEqual(jobs.list()[0].payload, before.payload);
  assert.equal(hub.fanouts(binding.id)[0].state, "queued");
  assert.equal(hub.pending().length, 0);
});

test("integration migrations reject guild databases and changed schemas; retention defaults are explicit and preserve pending work", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  new JobStore(db);
  assert.throws(() => new TwitchHubStore(db, { authorize: async () => {} }), /separate database/);
  const f = fixture(t);
  await f.ready();
  f.online();
  assert.deepEqual(f.hub.retention, { inboxMs: null, fanoutMs: null });
  f.setNow(initialNow + 86400000);
  assert.deepEqual(f.hub.prune(), { inbox: 0, fanout: 0 });
  assert.equal(f.hub.pending().length, 1);
  const finite = fixture(t, { retention: { inboxMs: 600000, fanoutMs: 600000 } });
  await finite.ready();
  finite.online();
  await finite.dispatcher().drain();
  finite.setNow(initialNow + 600001);
  assert.deepEqual(finite.hub.prune(), { inbox: 2, fanout: 1 });
  assert.throws(() => finite.dispatcher({ maxNotificationAgeMs: 600001 }), fails("invalid_input"));
  finite.hub.db.prepare("UPDATE twitch_hub_migrations SET checksum='changed'").run();
  assert.throws(() => new TwitchHubStore(finite.hub.db, { authorize: async () => {} }), /schema/);
});
