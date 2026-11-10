import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { URL, URLSearchParams } from "node:url";
import { TwitchHubStore } from "../dist/modules/twitch/store.js";
import { EventSubReceiver, webhookSecretRef } from "../dist/modules/twitch/webhook.js";
import { TwitchProvider, TwitchProviderError } from "../dist/modules/twitch/provider.js";

const guildA = "100000000000000001",
  guildB = "100000000000000002",
  actorId = "200000000000000001",
  channelId = "300000000000000001";
const broadcaster = "1337",
  callback = "https://gildiusz.example.test/twitch/eventsub",
  secret = "synthetic-webhook-secret-".repeat(3),
  clientId = "synthetic-client",
  clientSecret = "synthetic-client-secret-private",
  initialNow = Date.parse("2026-11-09T12:00:00Z");
const json = (body, status = 200, headers = {}) =>
  new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const code = (expected) => (error) =>
  error instanceof TwitchProviderError && error.code === expected;
const binding = () => ({
  broadcasterId: broadcaster,
  channelId,
  template: "{name}: {title}\n{url}",
  roleIds: [],
  mentionEveryone: false,
  enabled: true,
});

function fixture(t, options = {}) {
  let now = initialNow,
    tokenNumber = 0,
    subscriptionNumber = 0,
    postMode = "normal",
    interceptor = async () => undefined;
  const db = new DatabaseSync(":memory:"),
    hub = new TwitchHubStore(db, { authorize: async () => {}, clock: () => now });
  const calls = [],
    waits = [],
    subscriptions = new Map(),
    tokens = new Map(),
    providers = [];
  const challenge = (
    subscription,
    {
      messageId = `challenge-${subscription.id}`,
      signingSecret = secret,
      receiverSecret = signingSecret,
      broadcasterId = subscription.condition.broadcaster_user_id,
      callbackUrl = subscription.transport.callback,
    } = {},
  ) => {
    const sent = new Date(now).toISOString();
    const body = {
      challenge: `answer-${subscription.id}`,
      subscription: {
        ...subscription,
        condition: { broadcaster_user_id: broadcasterId },
        transport: { method: "webhook", callback: callbackUrl },
        status: "webhook_callback_verification_pending",
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    return new EventSubReceiver({ store: hub, secret: receiverSecret, clock: () => now }).receive({
      rawBody,
      headers: {
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": sent,
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        "Twitch-Eventsub-Subscription-Type": "stream.online",
        "Twitch-Eventsub-Subscription-Version": "1",
        "Twitch-Eventsub-Message-Signature": `sha256=${createHmac("sha256", signingSecret).update(messageId).update(sent).update(rawBody).digest("hex")}`,
      },
    });
  };
  const transport = async (input, init) => {
    const url = new URL(String(input)),
      method = init.method ?? "GET";
    assert.ok(["https://id.twitch.tv", "https://api.twitch.tv"].includes(url.origin));
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    assert.ok(!url.href.includes(clientSecret));
    assert.ok(!url.href.includes(secret));
    const call = { url, method, init };
    calls.push(call);
    const intercepted = await interceptor(call);
    if (intercepted !== undefined) return intercepted;
    if (url.pathname === "/oauth2/token") {
      assert.equal(url.search, "");
      assert.equal(method, "POST");
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("client_id"), clientId);
      assert.equal(form.get("client_secret"), clientSecret);
      assert.equal(form.get("grant_type"), "client_credentials");
      const value = `synthetic-token-${++tokenNumber}`,
        ttl = options.ttlSeconds ?? 7200;
      tokens.set(value, now + ttl * 1000);
      return json({ access_token: value, expires_in: ttl, token_type: "bearer" });
    }
    if (url.pathname === "/oauth2/validate") {
      assert.equal(url.search, "");
      const value = init.headers.Authorization.slice("OAuth ".length),
        expiresAt = tokens.get(value);
      if (!expiresAt || expiresAt <= now) return json({}, 401);
      return json({
        client_id: clientId,
        user_id: null,
        login: null,
        scopes: [],
        expires_in: Math.floor((expiresAt - now) / 1000),
      });
    }
    assert.equal(init.headers["Client-Id"], clientId);
    assert.match(init.headers.Authorization, /^Bearer synthetic-token-/);
    if (url.pathname === "/helix/streams")
      return json({
        data: [
          {
            id: "stream-one",
            user_id: url.searchParams.get("user_id"),
            user_login: "twitchexample",
            user_name: "Twórca",
            title: "Aktualny tytuł",
            game_name: "Science & Technology",
            thumbnail_url:
              "https://static-cdn.jtvnw.net/previews-ttv/live_user-example-{width}x{height}.jpg",
            started_at: new Date(now - 1000).toISOString(),
            type: "live",
          },
        ],
      });
    assert.equal(url.pathname, "/helix/eventsub/subscriptions");
    if (method === "GET") {
      assert.equal(url.searchParams.get("type"), "stream.online");
      return json({ data: [...subscriptions.values()], pagination: {} });
    }
    if (method === "DELETE") {
      const deleted = subscriptions.delete(url.searchParams.get("id"));
      return deleted ? new globalThis.Response(null, { status: 204 }) : json({}, 404);
    }
    const request = JSON.parse(init.body);
    assert.equal(request.type, "stream.online");
    assert.equal(request.version, "1");
    assert.equal(request.transport.secret, options.webhookSecret ?? secret);
    assert.ok(
      hub
        .subscriptionIntents()
        .some(
          (value) => value.callbackUrl === request.transport.callback && value.attemptedAt === now,
        ),
    );
    const subscription = {
      id: `subscription-${++subscriptionNumber}`,
      type: request.type,
      version: request.version,
      condition: request.condition,
      transport: { method: "webhook", callback: request.transport.callback },
      status: "webhook_callback_verification_pending",
    };
    subscriptions.set(subscription.id, subscription);
    if (postMode === "challenge-first") {
      assert.equal(
        challenge(subscription, { signingSecret: options.webhookSecret ?? secret }).status,
        200,
      );
      subscription.status = "enabled";
      return json(
        { data: [{ ...subscription, status: "webhook_callback_verification_pending" }] },
        202,
      );
    }
    if (postMode === "lost-response")
      throw Error(`upstream secret should never escape: ${clientSecret}`);
    return json({ data: [subscription] }, 202);
  };
  const provider = (extra = {}) => {
    const value = new TwitchProvider({
      store: hub,
      clientId,
      clientSecret,
      webhookSecret: options.webhookSecret ?? secret,
      callbackUrl: callback,
      fetch: transport,
      clock: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      ...extra,
    });
    providers.push(value);
    return value;
  };
  t.after(() => {
    for (const value of providers) value.close();
    db.close();
  });
  return {
    hub,
    db,
    calls,
    waits,
    subscriptions,
    challenge,
    provider,
    ready: async (guildId = guildA) =>
      hub.createBinding(guildId, actorId, `create-${guildId}`, binding()),
    setNow(value) {
      now = value;
    },
    now: () => now,
    setPostMode(value) {
      postMode = value;
    },
    intercept(value) {
      interceptor = value;
    },
    count(path, method) {
      return calls.filter(
        (value) => value.url.pathname === path && (!method || value.method === method),
      ).length;
    },
  };
}

test("app tokens stay private, use form bodies and singleflight, validate initially/hourly and refresh before expiry", async (t) => {
  const f = fixture(t),
    provider = f.provider();
  const streams = await Promise.all(
    Array.from({ length: 12 }, () => provider.getLive(broadcaster)),
  );
  assert.ok(streams.every((value) => value.title === "Aktualny tytuł"));
  assert.equal(f.count("/oauth2/token"), 1);
  assert.equal(f.count("/oauth2/validate"), 1);
  assert.equal(JSON.stringify(provider), "{}");
  const dbText = JSON.stringify(f.db.prepare("SELECT sql FROM sqlite_master").all());
  assert.ok(!dbText.includes(clientSecret));
  f.setNow(initialNow + 3600000);
  await provider.getLive(broadcaster);
  assert.equal(f.count("/oauth2/token"), 1);
  assert.equal(f.count("/oauth2/validate"), 2);
  f.setNow(initialNow + 7200000 - 50000);
  await provider.getLive(broadcaster);
  assert.equal(f.count("/oauth2/token"), 2);
});

test("creator lookup uses the official Users API and never guesses foreign or missing identities", async (t) => {
  const f = fixture(t),
    provider = f.provider();
  let users = [
    {
      id: broadcaster,
      login: "twitchexample",
      display_name: "Twórca",
      email: "private@ignored.example",
    },
  ];
  f.intercept(async ({ url, method }) => {
    if (url.pathname === "/helix/users") {
      assert.equal(method, "GET");
      assert.equal(url.searchParams.get("login"), "twitchexample");
      return json({ data: users });
    }
  });
  assert.deepEqual(await provider.lookupBroadcaster("TwitchExample"), {
    id: broadcaster,
    login: "twitchexample",
    displayName: "Twórca",
  });
  const before = f.calls.length;
  for (const login of ["https://twitch.tv/twitchexample", "bad name", "x&login=other", ""])
    await assert.rejects(
      () => provider.lookupBroadcaster(login),
      (error) => error.code === "invalid_input",
    );
  assert.equal(f.calls.length, before);
  users = [];
  assert.equal(await provider.lookupBroadcaster("twitchexample"), null);
  for (const value of [
    [{ id: broadcaster, login: "another", display_name: "Obcy" }],
    [{ id: "not-id", login: "twitchexample", display_name: "Twórca" }],
    [{ id: broadcaster, login: "twitchexample" }],
  ]) {
    users = value;
    await assert.rejects(
      () => provider.lookupBroadcaster("twitchexample"),
      code("invalid_response"),
    );
  }
});

test("401 invalidates only the used app token and retries authentication once", async (t) => {
  const f = fixture(t),
    provider = f.provider();
  let rejected = false;
  f.intercept(async ({ url }) => {
    if (url.pathname === "/helix/streams" && !rejected) {
      rejected = true;
      return json({}, 401);
    }
  });
  await provider.getLive(broadcaster);
  assert.equal(f.count("/oauth2/token"), 2);
  assert.equal(f.count("/helix/streams"), 2);
  f.intercept(async ({ url }) =>
    url.pathname === "/helix/streams" ? json({ message: clientSecret }, 401) : undefined,
  );
  await assert.rejects(
    () => provider.getLive(broadcaster),
    (error) => code("unauthorized")(error) && !String(error).includes(clientSecret),
  );
});

test("rate limit reset and Retry-After are bounded and do not trigger premature API retries", async (t) => {
  const f = fixture(t),
    provider = f.provider({ maxWaitMs: 5000 });
  let limited = false;
  f.intercept(async ({ url }) => {
    if (url.pathname === "/helix/streams" && !limited) {
      limited = true;
      return json({}, 429, {
        "Retry-After": "2",
        "Ratelimit-Reset": String((initialNow + 3000) / 1000),
      });
    }
  });
  await provider.getLive(broadcaster);
  assert.deepEqual(f.waits, [3000]);
  f.intercept(async ({ url }) =>
    url.pathname === "/helix/streams" ? json({}, 429, { "Retry-After": "3600" }) : undefined,
  );
  await assert.rejects(
    () => provider.getLive(broadcaster),
    (error) => code("rate_limited")(error) && error.retryAt === f.now() + 3600000,
  );
  const before = f.calls.length;
  await assert.rejects(() => provider.getLive(broadcaster), code("rate_limited"));
  assert.equal(f.calls.length, before);
});

test("timeouts and redirects never leak credentials or escape the fixed Twitch API hosts", async (t) => {
  const f = fixture(t),
    provider = f.provider({ timeoutMs: 20, retries: 0 });
  f.intercept(async ({ url }) => {
    if (url.pathname === "/helix/streams") return new Promise(() => {});
  });
  await assert.rejects(() => provider.getLive(broadcaster), code("timeout"));
  f.intercept(async ({ url }) =>
    url.pathname === "/helix/streams"
      ? new globalThis.Response(null, {
          status: 302,
          headers: { Location: `https://attacker.example/?secret=${clientSecret}` },
        })
      : undefined,
  );
  await assert.rejects(
    () => provider.getLive(broadcaster),
    (error) => code("invalid_response")(error) && !String(error).includes(clientSecret),
  );
  assert.ok(
    f.calls.every((value) => ["id.twitch.tv", "api.twitch.tv"].includes(value.url.hostname)),
  );
  assert.throws(
    () => f.provider({ callbackUrl: "http://localhost/twitch" }),
    code("invalid_configuration"),
  );
  assert.throws(
    () => f.provider({ callbackUrl: "https://example.test/twitch?secret=bad" }),
    code("invalid_configuration"),
  );
});

test("a challenge before the create response consumes its durable intent and cannot be downgraded", async (t) => {
  const f = fixture(t);
  await f.ready();
  f.setPostMode("challenge-first");
  const provider = f.provider();
  const result = await provider.reconcile();
  assert.equal(result.created, 1);
  assert.deepEqual(result.errors, []);
  const source = f.hub.source(broadcaster),
    [intent] = f.hub.subscriptionIntents();
  assert.equal(source.status, "enabled");
  assert.equal(source.subscriptionId, "subscription-1");
  assert.equal(intent.state, "confirmed");
  assert.equal(intent.subscriptionId, source.subscriptionId);
  assert.equal(intent.secretRef, webhookSecretRef(secret));
  assert.equal(new URL(intent.callbackUrl).searchParams.get("gildiusz_intent"), intent.id);
  assert.ok(!JSON.stringify(intent).includes(secret));
  assert.ok(!JSON.stringify(intent).includes(clientSecret));
  await provider.reconcile();
  assert.equal(f.count("/helix/eventsub/subscriptions", "POST"), 1);
});

test("a lost create response is reconciled by listing, never by a second POST", async (t) => {
  const f = fixture(t);
  await f.ready();
  f.setPostMode("lost-response");
  const first = f.provider();
  const result = await first.reconcile();
  assert.equal(result.errors[0].code, "ambiguous_create");
  assert.equal(f.hub.subscriptionIntents()[0].state, "pending");
  assert.equal(f.hub.source(broadcaster).subscriptionId, null);
  first.close();
  const restarted = f.provider();
  const recovered = await restarted.reconcile();
  assert.equal(recovered.adopted, 1);
  assert.deepEqual(recovered.errors, []);
  assert.equal(f.count("/helix/eventsub/subscriptions", "POST"), 1);
  assert.equal(f.hub.source(broadcaster).subscriptionId, "subscription-1");
  assert.equal(f.challenge(f.subscriptions.get("subscription-1")).status, 200);
  assert.equal(f.hub.source(broadcaster).status, "enabled");
});

test("EventSub POST server errors remain ambiguous while explicit rate rejection can be deferred safely", async (t) => {
  const f = fixture(t);
  await f.ready();
  const provider = f.provider();
  f.intercept(async ({ url, method }) =>
    url.pathname === "/helix/eventsub/subscriptions" && method === "POST"
      ? json({ message: clientSecret }, 503)
      : undefined,
  );
  const first = await provider.reconcile();
  assert.equal(first.errors[0].code, "ambiguous_create");
  assert.equal(f.count("/helix/eventsub/subscriptions", "POST"), 1);
  assert.equal((await provider.reconcile()).pending, 1);
  assert.equal(f.count("/helix/eventsub/subscriptions", "POST"), 1);
  const limited = fixture(t);
  await limited.ready();
  const limitedProvider = limited.provider({ maxWaitMs: 0 });
  limited.intercept(async ({ url, method }) =>
    url.pathname === "/helix/eventsub/subscriptions" && method === "POST"
      ? json({}, 429, { "Retry-After": "60" })
      : undefined,
  );
  const result = await limitedProvider.reconcile();
  assert.equal(result.errors[0].code, "rate_limited");
  assert.equal(limited.hub.subscriptionIntents()[0].attemptedAt, null);
  assert.equal(limited.hub.subscriptionIntents()[0].retryAt, initialNow + 60000);
  await assert.rejects(() => limitedProvider.reconcile(), code("rate_limited"));
  limited.setNow(initialNow + 60000);
  limited.intercept(async () => undefined);
  assert.equal((await limitedProvider.reconcile()).created, 1);
});

test("an ambiguous create absent from the list waits for intent expiry before another create", async (t) => {
  const f = fixture(t);
  await f.ready();
  f.setPostMode("lost-response");
  const provider = f.provider();
  await provider.reconcile();
  f.subscriptions.clear();
  assert.equal((await provider.reconcile()).pending, 1);
  assert.equal(f.count("/helix/eventsub/subscriptions", "POST"), 1);
  f.setNow(initialNow + 600001);
  f.setPostMode("normal");
  await provider.reconcile();
  assert.equal(f.count("/helix/eventsub/subscriptions", "POST"), 2);
  assert.equal(f.hub.subscriptionIntents().filter((value) => value.state === "expired").length, 1);
});

test("unknown challenges require a live, attempted, single-use matching broadcaster/callback/key intent", async (t) => {
  const f = fixture(t);
  await f.ready();
  const intent = f.hub.beginSubscriptionIntent(broadcaster, callback, webhookSecretRef(secret));
  const subscription = {
    id: "early",
    type: "stream.online",
    version: "1",
    condition: { broadcaster_user_id: broadcaster },
    transport: { method: "webhook", callback: intent.callbackUrl },
  };
  assert.equal(f.challenge(subscription, { messageId: "not-attempted" }).status, 409);
  f.hub.markSubscriptionAttempt(intent.id);
  assert.equal(
    f.challenge(subscription, { messageId: "wrong-broadcaster", broadcasterId: "999" }).status,
    409,
  );
  assert.equal(
    f.challenge(subscription, {
      messageId: "wrong-callback",
      callbackUrl: `${callback}?gildiusz_intent=wrong`,
    }).status,
    409,
  );
  const otherSecret = "different-valid-signing-key-".repeat(2);
  assert.equal(
    f.challenge(subscription, {
      messageId: "wrong-key",
      signingSecret: otherSecret,
      receiverSecret: otherSecret,
    }).status,
    409,
  );
  assert.equal(f.challenge(subscription, { messageId: "accepted" }).status, 200);
  assert.equal(
    f.challenge({ ...subscription, id: "another-id" }, { messageId: "second-adoption" }).status,
    409,
  );
  assert.equal(f.hub.sources().length, 1);
  assert.equal(f.hub.source(broadcaster).subscriptionId, "early");
  const expired = fixture(t);
  await expired.ready();
  const old = expired.hub.beginSubscriptionIntent(broadcaster, callback, webhookSecretRef(secret));
  expired.hub.markSubscriptionAttempt(old.id);
  expired.setNow(initialNow + 600001);
  assert.equal(
    expired.challenge({
      ...subscription,
      transport: { method: "webhook", callback: old.callbackUrl },
    }).status,
    409,
  );
  const inactive = fixture(t),
    memberBinding = await inactive.ready();
  const prepared = inactive.hub.beginSubscriptionIntent(
    broadcaster,
    callback,
    webhookSecretRef(secret),
  );
  inactive.hub.markSubscriptionAttempt(prepared.id);
  await inactive.hub.removeBinding(
    guildA,
    actorId,
    "disconnect-before-challenge",
    memberBinding.id,
    memberBinding.revision,
  );
  assert.equal(
    inactive.challenge({
      ...subscription,
      transport: { method: "webhook", callback: prepared.callbackUrl },
    }).status,
    409,
  );
  assert.equal(inactive.hub.source(broadcaster).subscriptionId, null);
  const failed = fixture(t);
  await failed.ready();
  const durable = failed.hub.beginSubscriptionIntent(
    broadcaster,
    callback,
    webhookSecretRef(secret),
  );
  failed.hub.markSubscriptionAttempt(durable.id);
  failed.db.exec("DROP TABLE twitch_inbox");
  assert.equal(
    failed.challenge({
      ...subscription,
      transport: { method: "webhook", callback: durable.callbackUrl },
    }).status,
    503,
  );
  assert.equal(failed.hub.source(broadcaster).subscriptionId, null);
  assert.equal(failed.hub.subscriptionIntents()[0].state, "pending");
});

test("only an empty Streams result proves offline; incomplete or foreign live metadata stays retryable", async (t) => {
  const f = fixture(t),
    provider = f.provider();
  f.intercept(async ({ url }) =>
    url.pathname === "/helix/streams" ? json({ data: [] }) : undefined,
  );
  assert.equal(await provider.getLive(broadcaster), null);
  for (const data of [
    { type: "" },
    {
      type: "live",
      id: "s",
      user_id: "999",
      user_login: "example",
      user_name: "Example",
      title: "T",
      game_name: "C",
      thumbnail_url: "https://static-cdn.jtvnw.net/x.jpg",
      started_at: new Date(initialNow).toISOString(),
    },
  ]) {
    f.intercept(async ({ url }) =>
      url.pathname === "/helix/streams" ? json({ data: [data] }) : undefined,
    );
    await assert.rejects(() => provider.getLive(broadcaster), code("invalid_response"));
  }
});

test("one shared source survives one guild disconnect and deletes only its owned subscription after the last", async (t) => {
  const f = fixture(t),
    a = await f.ready(),
    b = await f.ready(guildB);
  f.setPostMode("challenge-first");
  const provider = f.provider();
  await provider.reconcile();
  f.subscriptions.set("foreign", {
    id: "foreign",
    type: "stream.online",
    version: "1",
    status: "enabled",
    condition: { broadcaster_user_id: broadcaster },
    transport: { method: "webhook", callback: "https://another-app.example.test/callback" },
  });
  await f.hub.removeBinding(guildA, actorId, "remove-a", a.id, a.revision);
  await provider.reconcile();
  assert.equal(f.count("/helix/eventsub/subscriptions", "DELETE"), 0);
  await f.hub.removeBinding(guildB, actorId, "remove-b", b.id, b.revision);
  await provider.reconcile();
  assert.equal(f.count("/helix/eventsub/subscriptions", "DELETE"), 1);
  assert.ok(f.subscriptions.has("foreign"));
  assert.equal(f.hub.source(broadcaster).status, "revoked");
});

test("a stale delete cannot revoke a newer registered source", async (t) => {
  const f = fixture(t);
  await f.ready();
  f.setPostMode("challenge-first");
  const first = f.provider();
  await first.reconcile();
  first.close();
  const replacementSecret = "replacement-signing-key-".repeat(3);
  f.intercept(async ({ url, method }) => {
    if (url.pathname === "/helix/eventsub/subscriptions" && method === "DELETE") {
      f.hub.registerSubscription(broadcaster, "newer-current");
      f.subscriptions.delete("subscription-1");
      return new globalThis.Response(null, { status: 204 });
    }
  });
  const replacement = f.provider({ webhookSecret: replacementSecret });
  await replacement.reconcile();
  assert.equal(f.hub.source(broadcaster).subscriptionId, "newer-current");
  assert.equal(f.hub.source(broadcaster).status, "pending");
  assert.equal(f.count("/helix/eventsub/subscriptions", "POST"), 1);
});

test("a stale subscription list cannot replace a source adopted while the list was in flight", async (t) => {
  const f = fixture(t);
  await f.ready();
  const provider = f.provider();
  await provider.reconcile();
  f.intercept(async ({ url, method }) => {
    if (url.pathname === "/helix/eventsub/subscriptions" && method === "GET") {
      f.hub.registerSubscription(broadcaster, "adopted-during-list");
      return json({ data: [], pagination: {} });
    }
  });
  const result = await provider.reconcile();
  assert.equal(result.pending, 1);
  assert.equal(f.hub.source(broadcaster).subscriptionId, "adopted-during-list");
  assert.equal(f.hub.source(broadcaster).status, "pending");
  assert.equal(f.count("/helix/eventsub/subscriptions", "POST"), 1);
});

test("signing key rotation replaces only the old owned subscription and confirms the new intent", async (t) => {
  const f = fixture(t);
  await f.ready();
  f.setPostMode("challenge-first");
  const original = f.provider();
  await original.reconcile();
  original.close();
  const key = "new-provider-signing-secret-".repeat(3);
  f.intercept(async ({ url, method, init }) => {
    if (url.pathname === "/helix/eventsub/subscriptions" && method === "POST") {
      const request = JSON.parse(init.body);
      assert.equal(request.transport.secret, key);
      const value = {
        id: "rotated-subscription",
        type: "stream.online",
        version: "1",
        status: "enabled",
        condition: request.condition,
        transport: { method: "webhook", callback: request.transport.callback },
      };
      f.subscriptions.set(value.id, value);
      assert.equal(f.challenge(value, { signingSecret: key, receiverSecret: key }).status, 200);
      return json({ data: [value] }, 202);
    }
  });
  const replacement = f.provider({ webhookSecret: key });
  const result = await replacement.reconcile();
  assert.deepEqual(result.errors, []);
  assert.equal(result.created, 1);
  assert.equal(result.deleted, 1);
  assert.equal(f.hub.source(broadcaster).subscriptionId, "rotated-subscription");
  assert.equal(f.hub.source(broadcaster).status, "enabled");
  assert.ok(!f.subscriptions.has("subscription-1"));
  assert.equal(
    f.hub.subscriptionIntents().find((value) => value.subscriptionId === "rotated-subscription")
      .secretRef,
    webhookSecretRef(key),
  );
});

test("pagination stays bounded and no transport body can redirect provider requests", async (t) => {
  const f = fixture(t),
    provider = f.provider();
  let page = 0;
  f.intercept(async ({ url }) => {
    if (url.pathname === "/helix/eventsub/subscriptions") {
      page++;
      assert.equal(url.origin, "https://api.twitch.tv");
      return json({ data: [], pagination: { cursor: "https://attacker.example/private" } });
    }
  });
  await assert.rejects(() => provider.reconcile(), code("invalid_response"));
  assert.equal(page, 2);
  assert.equal(
    f.calls
      .filter((value) => value.url.pathname === "/helix/eventsub/subscriptions")[1]
      .url.searchParams.get("after"),
    "https://attacker.example/private",
  );
});

test("migration2 upgrades the existing hub without changing schema1 or storing credentials", async (t) => {
  const f = fixture(t);
  await f.ready();
  const oldChecksum = f.db
    .prepare("SELECT checksum FROM twitch_hub_migrations WHERE version=1")
    .get().checksum;
  f.db.exec(
    "DROP TABLE twitch_subscription_intents; DELETE FROM twitch_hub_migrations WHERE version=2",
  );
  const upgraded = new TwitchHubStore(f.db, { authorize: async () => {}, clock: () => initialNow });
  assert.equal(upgraded.sources().length, 1);
  assert.equal(
    f.db.prepare("SELECT checksum FROM twitch_hub_migrations WHERE version=1").get().checksum,
    oldChecksum,
  );
  assert.deepEqual(
    f.db
      .prepare("SELECT version FROM twitch_hub_migrations ORDER BY version")
      .all()
      .map((value) => value.version),
    [1, 2],
  );
  const provider = f.provider();
  await provider.reconcile();
  for (const table of ["twitch_subscription_intents", "twitch_sources", "twitch_inbox"]) {
    const value = JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all());
    assert.ok(!value.includes(clientSecret));
    assert.ok(!value.includes(secret));
    assert.ok(!value.includes("synthetic-token"));
  }
});
