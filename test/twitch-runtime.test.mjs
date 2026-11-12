import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ChannelType,
  DiscordjsError,
  GuildChannelManager,
  PermissionFlagsBits as P,
  PermissionsBitField,
  RateLimitError,
} from "discord.js";
import { TwitchRuntime } from "../dist/bot/twitch-runtime.js";
import { ModuleSettingsStore } from "../dist/core/modules/settings.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { JobRunner } from "../dist/core/jobs/runner.js";
import { memberFacts } from "../dist/bot/module-permissions.js";
import { ControlError } from "../dist/contracts/index.js";

const guildA = "100000000000000001",
  guildB = "100000000000000002",
  adminId = "200000000000000001",
  userId = "200000000000000002",
  botId = "200000000000000003",
  ownerId = "200000000000000004",
  channelA = "300000000000000001",
  channelB = "300000000000000002",
  roleId = "400000000000000001",
  broadcaster = "1337";
const initialNow = Date.parse("2026-11-09T12:00:00Z"),
  secret = "runtime-twitch-signing-secret-".repeat(2);
const configuration = {
  clientId: "runtime-client",
  clientSecret: "private-runtime-client-secret",
  webhookSecret: secret,
  callbackUrl: "https://gildiusz.example.test/eventsub",
};
const json = (body, status = 200) => new globalThis.Response(JSON.stringify(body), { status });
const fails = (status, code) => (error) =>
  error instanceof ControlError && error.status === status && error.code === code;
const draft = (channelId = channelA, extra = {}) => ({
  broadcasterId: broadcaster,
  channelId,
  template: "{name} nadaje: {title}\n{url}",
  roleIds: [roleId],
  mentionEveryone: false,
  enabled: true,
  ...extra,
});

function fixture(t, options = {}) {
  let now = initialNow,
    nextSub = 0,
    runtime;
  const db = new DatabaseSync(":memory:"),
    handles = [db],
    registry = new Map(),
    targets = new Map(),
    installed = new Map(),
    api = [],
    publications = [],
    subscriptions = new Map();
  const providerState = {
    live: true,
    streamId: "stream-one",
    title: "Tytuł z API",
    hook: async () => {},
  };
  for (const [guildId, channelId] of [
    [guildA, channelA],
    [guildB, channelB],
  ]) {
    const guildDb = new DatabaseSync(":memory:"),
      jobs = new JobStore(guildDb, () => now),
      settings = new ModuleSettingsStore(guildDb, guildId, () => now);
    handles.push(guildDb);
    const value = settings.read();
    value.enabled.integrations = true;
    settings.save(value, adminId);
    installed.set(guildId, true);
    const state = {
      admin: true,
      connected: true,
      available: true,
      actorAccess: true,
      botAccess: true,
      actorMention: false,
      botMention: false,
      roleMentionable: true,
      memberError: undefined,
      channelError: undefined,
      postError: undefined,
      afterChannel: async () => {},
    };
    const roles = new Map([
      [guildId, { id: guildId, mentionable: false }],
      [
        roleId,
        {
          id: roleId,
          get mentionable() {
            return state.roleMentionable;
          },
        },
      ],
    ]);
    const person = (id) => ({
      id,
      user: { bot: false },
      roles: { cache: new Map([[guildId, roles.get(guildId)]]) },
      voice: { channelId: null },
      pending: false,
      isCommunicationDisabled: () => false,
      get permissions() {
        return new PermissionsBitField(id === adminId && state.admin ? P.ManageGuild : 0n);
      },
    });
    const members = new Map([
        [adminId, person(adminId)],
        [userId, person(userId)],
      ]),
      me = { id: botId };
    const guild = {
      id: guildId,
      ownerId,
      get available() {
        return state.available;
      },
      async fetch() {
        return this;
      },
      roles: {
        cache: roles,
        async fetch() {
          return roles;
        },
      },
      members: {
        async fetch({ user, force }) {
          assert.equal(force, true);
          if (state.memberError) throw state.memberError;
          return members.get(user);
        },
        async fetchMe() {
          return me;
        },
      },
    };
    const channel = {
      id: channelId,
      guildId,
      type: ChannelType.GuildText,
      permissionsFor(member) {
        return new PermissionsBitField(
          (member.id === botId ? state.botAccess : state.actorAccess)
            ? P.ViewChannel |
                P.SendMessages |
                P.ReadMessageHistory |
                ((member.id === botId ? state.botMention : state.actorMention)
                  ? P.MentionEveryone
                  : 0n)
            : 0n,
        );
      },
    };
    guild.channels = {
      async fetch(id, fetchOptions) {
        assert.equal(fetchOptions.force, true);
        await state.afterChannel();
        if (state.channelError) throw state.channelError;
        return id === channelId ? channel : null;
      },
    };
    const target = {
      context: {
        guild,
        client: { isReady: () => state.connected },
        store: { db: guildDb, event() {} },
      },
      jobs,
      settings,
      state,
      members,
    };
    registry.set(guildId, target);
    targets.set(guildId, target);
  }
  const envelope = (subscription, messageType = "notification", messageId = "event-one") => {
    const sent = new Date(now).toISOString();
    const body = {
      subscription: {
        ...subscription,
        status:
          messageType === "webhook_callback_verification"
            ? "webhook_callback_verification_pending"
            : "enabled",
      },
      ...(messageType === "webhook_callback_verification"
        ? { challenge: "challenge-value" }
        : {
            event: {
              id: providerState.streamId,
              type: "live",
              broadcaster_user_id: broadcaster,
              started_at: new Date(now - 1000).toISOString(),
            },
          }),
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    return {
      rawBody,
      headers: {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": sent,
        "Twitch-Eventsub-Message-Type": messageType,
        "Twitch-Eventsub-Subscription-Type": "stream.online",
        "Twitch-Eventsub-Subscription-Version": "1",
        "Twitch-Eventsub-Message-Signature": `sha256=${createHmac("sha256", secret).update(messageId).update(sent).update(rawBody).digest("hex")}`,
      },
    };
  };
  const rest = {
    options: { retries: options.restRetries ?? 0 },
    async post(route, value) {
      const guildId = route.includes(channelA) ? guildA : guildB,
        state = targets.get(guildId).state;
      publications.push({ route, value });
      if (state.postError) throw state.postError;
      return { id: `50000000000000000${publications.length}` };
    },
  };
  const fetch = async (input, init) => {
    const url = new globalThis.URL(String(input));
    api.push({ url, init });
    assert.ok(["id.twitch.tv", "api.twitch.tv"].includes(url.hostname));
    if (url.pathname === "/oauth2/token")
      return json({
        access_token: "synthetic-application-token",
        expires_in: 7200,
        token_type: "bearer",
      });
    if (url.pathname === "/oauth2/validate")
      return json({
        client_id: configuration.clientId,
        user_id: null,
        login: null,
        expires_in: 7200,
      });
    if (url.pathname === "/helix/users") {
      await providerState.hook();
      return json({
        data: [{ id: broadcaster, login: url.searchParams.get("login"), display_name: "Twórca" }],
      });
    }
    if (url.pathname === "/helix/streams") {
      await providerState.hook();
      return json({
        data: providerState.live
          ? [
              {
                id: providerState.streamId,
                user_id: broadcaster,
                user_login: "example",
                user_name: "Twórca",
                type: "live",
                title: providerState.title,
                game_name: "Science & Technology",
                thumbnail_url:
                  "https://static-cdn.jtvnw.net/previews-ttv/example-{width}x{height}.jpg",
                started_at: new Date(now - 1000).toISOString(),
              },
            ]
          : [],
      });
    }
    assert.equal(url.pathname, "/helix/eventsub/subscriptions");
    if (init.method === "GET") return json({ data: [...subscriptions.values()], pagination: {} });
    if (init.method === "DELETE") {
      subscriptions.delete(url.searchParams.get("id"));
      return new globalThis.Response(null, { status: 204 });
    }
    const inputBody = JSON.parse(init.body),
      value = {
        id: `subscription-${++nextSub}`,
        type: "stream.online",
        version: "1",
        status: "enabled",
        condition: inputBody.condition,
        transport: { method: "webhook", callback: inputBody.transport.callback },
      };
    subscriptions.set(value.id, value);
    assert.equal(
      runtime.receive(envelope(value, "webhook_callback_verification", `challenge-${value.id}`))
        .status,
      200,
    );
    return json({ data: [{ ...value, status: "webhook_callback_verification_pending" }] }, 202);
  };
  runtime = new TwitchRuntime({
    db,
    configuration: options.configured === false ? undefined : configuration,
    publicationRest: rest,
    resolveGuild: (id) => registry.get(id),
    configuredGuildEnabled:
      options.stableResolver === false ? undefined : (id) => installed.get(id),
    fetch,
    clock: () => now,
    providerOptions: { retries: 0 },
  });
  t.after(() => {
    runtime.close();
    for (const handle of handles) handle.close();
  });
  const facts = (guildId = guildA, id = adminId) =>
    memberFacts(targets.get(guildId).context.guild, targets.get(guildId).members.get(id));
  const create = (guildId = guildA, extra = {}, requestId = `create-${guildId}`) =>
    runtime.request(
      facts(guildId),
      "integrations.create",
      draft(guildId === guildA ? channelA : channelB, extra),
      undefined,
      requestId,
    );
  const online = (id = "event-one") =>
    runtime.receive(
      envelope(
        subscriptions.get(runtime.hub.source(broadcaster).subscriptionId),
        "notification",
        id,
      ),
    );
  const run = async (guildId = guildA) => {
    const target = targets.get(guildId),
      runner = new JobRunner(
        () => [{ guildId, store: target.jobs, available: () => true }],
        (job, execution) => runtime.execute(job, execution),
        { clock: () => now, random: () => 0 },
      );
    await runner.tick();

    await runner.stop();
  };
  const moduleEnabled = (guildId, enabled) => {
    const target = targets.get(guildId),
      value = target.settings.read();
    value.enabled.integrations = enabled;
    target.settings.save(value, adminId);
    installed.set(guildId, enabled);
  };
  return {
    runtime,
    targets,
    registry,
    installed,
    api,
    publications,
    subscriptions,
    providerState,
    facts,
    create,
    online,
    run,
    moduleEnabled,
    setNow(value) {
      now = value;
    },
    now: () => now,
  };
}

test("missing operator config and unsafe REST keep integration planned without networking or fake saves", async (t) => {
  for (const options of [{ configured: false }, { restRetries: 3 }]) {
    const f = fixture(t, options);
    assert.equal(f.runtime.capability(guildA).availability, "planned");
    await assert.rejects(() => f.create(), fails(409, "module_unavailable"));
    assert.deepEqual(await f.runtime.pump(), { availability: "planned" });
    assert.equal(f.runtime.receive({ headers: {}, rawBody: Buffer.from("{}") }).status, 503);
    assert.equal(f.api.length, 0);
    assert.equal(f.publications.length, 0);
  }
});

test("only fresh server managers can configure isolated bindings and raw request flags grant no access", async (t) => {
  const f = fixture(t),
    a = await f.create(),
    b = await f.create(guildB);
  const forged = { ...f.facts(guildA, userId), owner: true, manageGuild: true, roleIds: [roleId] };
  for (const id of [a.integration.id, "missing"])
    await assert.rejects(
      () => f.runtime.request(forged, "integrations.read", {}, id),
      fails(403, "permission_revoked"),
    );
  await assert.rejects(
    () => f.runtime.request(f.facts(guildB), "integrations.read", {}, a.integration.id),
    fails(404, "not_found"),
  );
  const listed = await f.runtime.request(f.facts(), "integrations.list", {});
  assert.deepEqual(
    listed.integrations.map((value) => value.integration.id),
    [a.integration.id],
  );
  const view = await f.runtime.request(f.facts(), "integrations.read", {}, a.integration.id);
  assert.ok(!("subscriptionId" in view.source));
  assert.ok(!("activeBindingCount" in view.source));
  assert.ok(!JSON.stringify(view).includes(b.integration.id));
  f.targets.get(guildA).state.admin = false;
  await assert.rejects(
    () => f.runtime.request(f.facts(), "integrations.list", {}),
    fails(403, "permission_revoked"),
  );
});

test("selected channel and explicit role/everyone mentions require current actor and bot access", async (t) => {
  const f = fixture(t),
    state = f.targets.get(guildA).state;
  await assert.rejects(
    () => f.create(guildA, { channelId: channelB }),
    fails(403, "channel_unavailable"),
  );
  await assert.rejects(
    () => f.create(guildA, { roleIds: ["499999999999999999"] }),
    fails(403, "permission_revoked"),
  );
  await assert.rejects(
    () => f.create(guildA, { mentionEveryone: true }),
    fails(403, "permission_revoked"),
  );
  state.roleMentionable = false;
  await assert.rejects(() => f.create(), fails(403, "permission_revoked"));
  state.actorMention = true;
  state.botMention = true;
  await f.create(guildA, { mentionEveryone: true });
  state.botAccess = false;
  await assert.rejects(() => f.create(guildA, {}, "another"), fails(403, "channel_unavailable"));
});

test("shared live events enqueue once per binding and send current metadata through explicit mentions", async (t) => {
  const f = fixture(t),
    a = await f.create();
  await f.create(guildB);
  await f.runtime.pump();
  assert.equal(f.subscriptions.size, 1);
  assert.equal(f.online().status, 204);
  await f.runtime.pump();
  assert.equal(f.targets.get(guildA).jobs.list().length, 1);
  assert.equal(f.targets.get(guildB).jobs.list().length, 1);
  for (const guildId of [guildA, guildB]) {
    const [job] = f.targets.get(guildId).jobs.list();
    assert.deepEqual(job.payload, {
      bindingId: job.objectId,
      generation: job.generation,
      stream: { id: "stream-one" },
    });
  }
  f.providerState.title = "Świeży tytuł przed wysyłką";
  await f.run();
  await f.run(guildB);
  assert.equal(f.publications.length, 2);
  for (const { value } of f.publications) {
    assert.match(value.body.content, /Świeży tytuł/);
    assert.deepEqual(value.body.allowed_mentions, {
      parse: [],
      roles: [roleId],
      users: [],
      replied_user: false,
    });
    assert.equal(value.body.enforce_nonce, true);
  }
  f.online();
  f.online("duplicate-stream-different-message");
  await f.runtime.pump();
  await f.run();
  await f.run(guildB);
  assert.equal(f.publications.length, 2);
  const view = await f.runtime.request(f.facts(), "integrations.read", {}, a.integration.id);
  assert.equal(view.jobs[0].state, "succeeded");
  assert.ok(!("payload" in view.jobs[0]));
  assert.ok(!("leaseToken" in view.jobs[0]));
  assert.ok(!("result" in view.deliveries[0]));
  assert.ok(!("nonce" in view.deliveries[0]));
});

test("a lost Discord result is unknown and provider duplicates do not create another ping", async (t) => {
  const f = fixture(t);
  await f.create();
  await f.runtime.pump();
  f.online();
  await f.runtime.pump();
  f.targets.get(guildA).state.postError = Object.assign(Error("connection lost after acceptance"), {
    code: "ECONNRESET",
  });
  await f.run();
  assert.equal(f.targets.get(guildA).jobs.list()[0].state, "unknown");
  f.online("repeat-after-unknown");
  await f.runtime.pump();
  await f.run();
  assert.equal(f.publications.length, 1);
  assert.equal(f.targets.get(guildA).jobs.list().length, 1);
});

test("current role revocation, offline state and module disable stop queued delivery before an attempt", async (t) => {
  for (const change of ["role", "offline", "module", "uninstalled"]) {
    const f = fixture(t);
    await f.create();
    await f.runtime.pump();
    f.online();
    await f.runtime.pump();
    if (change === "role") f.targets.get(guildA).state.admin = false;
    if (change === "offline") f.providerState.live = false;
    if (change === "module") f.moduleEnabled(guildA, false);
    if (change === "uninstalled") f.installed.set(guildA, false);
    await f.run();
    const job = f.targets.get(guildA).jobs.list()[0];
    assert.ok(["failed", "expired"].includes(job.state));
    assert.equal(f.publications.length, 0);
    assert.equal(f.targets.get(guildA).jobs.attempts(job.id).length, 0);
  }
});

test("binding tests are clearly labelled, never invent a stream, never ping and retain exact idempotency", async (t) => {
  const f = fixture(t),
    created = await f.create();
  f.providerState.live = false;
  const payload = { revision: created.integration.revision };
  const first = await f.runtime.request(
    f.facts(),
    "integrations.test",
    payload,
    created.integration.id,
    "test-one",
  );
  const replay = await f.runtime.request(
    f.facts(),
    "integrations.test",
    payload,
    created.integration.id,
    "test-one",
  );
  assert.equal(first.job.id, replay.job.id);
  assert.equal(f.targets.get(guildA).jobs.list().length, 1);
  await f.run();
  assert.equal(f.publications.length, 1);
  assert.match(f.publications[0].value.body.content, /^Próba powiadomienia Twitch/);
  assert.deepEqual(f.publications[0].value.body.allowed_mentions, {
    parse: [],
    roles: [],
    users: [],
    replied_user: false,
  });
  assert.equal(f.api.length, 0);
  for (const requestId of ["test-two", "test-three"])
    await f.runtime.request(
      f.facts(),
      "integrations.test",
      payload,
      created.integration.id,
      requestId,
    );
  await assert.rejects(
    () =>
      f.runtime.request(
        f.facts(),
        "integrations.test",
        payload,
        created.integration.id,
        "test-four",
      ),
    fails(429, "limit_exceeded"),
  );
});

test("CAS edits cancel obsolete jobs but an old exact replay cannot cancel a newer generation", async (t) => {
  const f = fixture(t),
    first = await f.create();
  await f.runtime.pump();
  f.online();
  await f.runtime.pump();
  const update = {
    revision: first.integration.revision,
    draft: draft(channelA, { template: "Zmienione: {title} {url}" }),
  };
  const second = await f.runtime.request(
    f.facts(),
    "integrations.update",
    update,
    first.integration.id,
    "update-one",
  );
  assert.equal(f.targets.get(guildA).jobs.list()[0].state, "cancelled");
  await assert.rejects(
    () =>
      f.runtime.request(
        f.facts(),
        "integrations.update",
        update,
        first.integration.id,
        "stale-new-id",
      ),
    fails(409, "revision_conflict"),
  );
  const third = await f.runtime.request(
    f.facts(),
    "integrations.update",
    { revision: second.integration.revision, draft: draft() },
    first.integration.id,
    "update-two",
  );
  f.providerState.streamId = "stream-two";
  f.online("new-stream");
  await f.runtime.pump();
  const currentJob = f.targets
    .get(guildA)
    .jobs.list()
    .find((value) => value.generation === third.integration.generation);
  await f.runtime.request(
    f.facts(),
    "integrations.update",
    update,
    first.integration.id,
    "update-one",
  );
  assert.equal(f.targets.get(guildA).jobs.get(currentJob.id).state, "pending");
});

test("one guild disconnect keeps the shared source for another and last disconnect removes it", async (t) => {
  const f = fixture(t),
    a = await f.create(),
    b = await f.create(guildB);
  await f.runtime.pump();
  await f.runtime.request(
    f.facts(),
    "integrations.remove",
    { revision: a.integration.revision },
    a.integration.id,
    "remove-a",
  );
  f.setNow(initialNow + 60001);
  await f.runtime.pump();
  assert.equal(f.subscriptions.size, 1);
  await f.runtime.request(
    f.facts(guildB),
    "integrations.remove",
    { revision: b.integration.revision },
    b.integration.id,
    "remove-b",
  );
  f.setNow(initialNow + 120002);
  await f.runtime.pump();
  assert.equal(f.subscriptions.size, 0);
});

test("unknown guild lifecycle and gateway reconnect preserve subscriptions while delaying delivery", async (t) => {
  const f = fixture(t);
  await f.create();
  await f.runtime.pump();
  const target = f.registry.get(guildA);
  f.registry.delete(guildA);
  f.installed.set(guildA, undefined);
  f.setNow(initialNow + 60001);
  await f.runtime.pump();
  assert.equal(f.subscriptions.size, 1);
  f.online();
  await f.runtime.pump();
  assert.equal(target.jobs.list().length, 0);
  assert.equal(f.runtime.hub.pending().length, 1);
  f.registry.set(guildA, target);
  f.installed.set(guildA, true);
  target.state.connected = false;
  await f.runtime.pump();
  assert.equal(target.jobs.list().length, 0);
  target.state.connected = true;
  await f.runtime.pump();
  assert.equal(target.jobs.list().length, 1);
  await f.run();
  assert.equal(f.publications.length, 1);
});

test("explicit global disable stops fanout and unsubscribes, while disabled-during-await cannot send", async (t) => {
  const f = fixture(t);
  await f.create();
  await f.runtime.pump();
  f.online();
  await f.runtime.pump();
  f.providerState.hook = async () => f.moduleEnabled(guildA, false);
  await f.run();
  assert.equal(f.publications.length, 0);
  f.setNow(initialNow + 60001);
  await f.runtime.pump();
  assert.equal(f.subscriptions.size, 0);
});

test("without a lifecycle resolver temporary absence cannot infer uninstall", async (t) => {
  const f = fixture(t, { stableResolver: false });
  await f.create();
  await f.runtime.pump();
  f.registry.delete(guildA);
  f.setNow(initialNow + 60001);
  await f.runtime.pump();
  assert.equal(f.subscriptions.size, 1);
  assert.equal(f.api.filter((value) => value.init.method === "DELETE").length, 0);
});

test("login lookup refreshes manager authority before and after official API work", async (t) => {
  const f = fixture(t);
  const first = await f.runtime.request(f.facts(), "integrations.lookup", { login: "example" });
  assert.deepEqual(first, {
    broadcaster: { id: broadcaster, login: "example", displayName: "Twórca" },
  });
  assert.equal(f.runtime.hub.sources().length, 0);
  const before = f.api.length;
  await assert.rejects(
    () => f.runtime.request(f.facts(guildA, userId), "integrations.lookup", { login: "example" }),
    fails(403, "permission_revoked"),
  );
  assert.equal(f.api.length, before);
  f.providerState.hook = async () => {
    f.targets.get(guildA).state.admin = false;
  };
  await assert.rejects(
    () => f.runtime.request(f.facts(), "integrations.lookup", { login: "example" }),
    fails(403, "permission_revoked"),
  );
});

test("actual SDK foreign-guild channels reject Twitch bindings before hub, jobs or provider effects", async (t) => {
  const f = fixture(t),
    reads = [],
    manager = {
      guild: { id: guildA },
      client: {
        rest: {
          async get(route) {
            reads.push(route);
            assert.equal(route, `/channels/${channelB}`);
            return { id: channelB, guild_id: guildB, type: ChannelType.GuildText };
          },
        },
      },
    },
    sdkFetch = (id, options) => GuildChannelManager.prototype.fetch.call(manager, id, options);
  await assert.rejects(
    () => sdkFetch(channelB, { force: true }),
    (error) => error instanceof DiscordjsError && error.code === "GuildChannelUnowned",
  );
  f.targets.get(guildA).context.guild.channels.fetch = sdkFetch;
  const databases = [f.runtime.hub.db, ...[...f.targets.values()].map((target) => target.jobs.db)],
    before = databases.map((db) => db.prepare("SELECT total_changes() AS n").get().n);
  await assert.rejects(
    () => f.create(guildA, { channelId: channelB }, "sdk-foreign"),
    fails(403, "channel_unavailable"),
  );
  assert.equal(reads.length, 2);
  assert.deepEqual(
    databases.map((db) => db.prepare("SELECT total_changes() AS n").get().n),
    before,
  );
  for (const table of [
    "twitch_sources",
    "twitch_bindings",
    "twitch_mutations",
    "twitch_inbox",
    "twitch_fanout",
    "twitch_subscription_intents",
  ])
    assert.equal(f.runtime.hub.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  for (const target of f.targets.values()) {
    assert.equal(target.jobs.list().length, 0);
    assert.equal(target.jobs.db.prepare("SELECT COUNT(*) AS n FROM delivery_attempts").get().n, 0);
  }
  assert.equal(f.api.length, 0);
  assert.equal(f.publications.length, 0);
  assert.equal(f.subscriptions.size, 0);
});

test("Twitch channel lookups preserve network and actual SDK rate-limit failures without writes", async (t) => {
  const f = fixture(t),
    databases = [f.runtime.hub.db, ...[...f.targets.values()].map((target) => target.jobs.db)],
    before = databases.map((db) => db.prepare("SELECT total_changes() AS n").get().n);
  for (const failure of [
    Object.assign(Error("temporary network failure"), { code: "ECONNRESET" }),
    new RateLimitError({
      timeToReset: 900,
      retryAfter: 1200,
      sublimitTimeout: 0,
      limit: 1,
      method: "GET",
      hash: "twitch-channel",
      url: `https://discord.com/api/v10/channels/${channelA}`,
      route: "/channels/:id",
      majorParameter: channelA,
      global: false,
      scope: "user",
    }),
  ]) {
    const manager = {
      guild: { id: guildA },
      client: {
        rest: {
          async get() {
            throw failure;
          },
        },
      },
    };
    f.targets.get(guildA).context.guild.channels.fetch = (id, options) =>
      GuildChannelManager.prototype.fetch.call(manager, id, options);
    await assert.rejects(
      () => f.create(guildA, {}, "sdk-transient"),
      (error) => error === failure,
    );
  }
  assert.deepEqual(
    databases.map((db) => db.prepare("SELECT total_changes() AS n").get().n),
    before,
  );
  assert.equal(f.runtime.hub.sources().length, 0);
  assert.equal(f.targets.get(guildA).jobs.list().length, 0);
  assert.equal(f.api.length, 0);
  assert.equal(f.publications.length, 0);
});
