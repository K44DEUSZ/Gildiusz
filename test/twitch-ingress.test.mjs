import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createTwitchIngress } from "../dist/modules/twitch/server.js";
import { EventSubReceiver } from "../dist/modules/twitch/webhook.js";
import { TwitchHubStore } from "../dist/modules/twitch/store.js";
import {
  normalizeTwitchProxyHeaders,
  twitchProxyHeaders,
  twitchProxyPayload,
} from "../dist/contracts/twitch-proxy.js";
import { twitchProxySignature } from "../dist/contracts/node.js";

const now = Date.parse("2026-11-09T12:00:00Z"),
  proxySecret = "private-next-to-bot-key-".repeat(2),
  eventSecret = "independent-eventsub-key-".repeat(2);
const twitchHeaders = {
  "Twitch-Eventsub-Message-Id": "message-one",
  "Twitch-Eventsub-Message-Timestamp": new Date(now).toISOString(),
  "Twitch-Eventsub-Message-Type": "notification",
  "Twitch-Eventsub-Subscription-Type": "stream.online",
  "Twitch-Eventsub-Subscription-Version": "1",
  "Twitch-Eventsub-Message-Signature": "sha256=" + "a".repeat(64),
};
function signed(
  rawBody = Buffer.from("{}"),
  headers = twitchHeaders,
  time = String(now),
  nonce = randomBytes(16).toString("hex"),
) {
  return {
    rawBody,
    headers: {
      ...headers,
      [twitchProxyHeaders.time]: time,
      [twitchProxyHeaders.nonce]: nonce,
      [twitchProxyHeaders.signature]: twitchProxySignature(
        proxySecret,
        time,
        nonce,
        headers,
        rawBody,
      ),
    },
  };
}
function send(
  port,
  { rawBody, headers },
  { path = "/eventsub", method = "POST", chunked = false, extraHeaders = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...headers,
          ...extraHeaders,
          ...(chunked ? {} : { "Content-Length": rawBody.byteLength }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(rawBody);
  });
}
async function start(t, options = {}) {
  const ingress = createTwitchIngress({
    proxySecret,
    forbiddenSecrets: [eventSecret, "unrelated-control-key"],
    port: 0,
    allowEphemeralPort: true,
    clock: () => now,
    ...options,
  });
  assert.equal(ingress.address(), null);
  const address = await ingress.listen();
  assert.equal(address.address, "127.0.0.1");
  t.after(() => ingress.close());
  return { ingress, port: address.port };
}

test("proxy canonical encoding signs exact bytes and only canonical official headers", () => {
  const body = Buffer.from('{"treść":"ą"}\n'),
    input = signed(body);
  const normalized = normalizeTwitchProxyHeaders({
    ...twitchHeaders,
    Cookie: "private",
    Authorization: "do-not-forward",
  });
  assert.equal(Object.hasOwn(normalized, "Cookie"), false);
  assert.deepEqual(
    Object.keys(normalized),
    Object.keys(twitchHeaders).map((name) => name.toLowerCase()),
  );
  const payload = twitchProxyPayload(
    input.headers[twitchProxyHeaders.time],
    input.headers[twitchProxyHeaders.nonce],
    normalized,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(
    input.headers[twitchProxyHeaders.signature],
    createHmac("sha256", proxySecret).update(payload).digest("hex"),
  );
  assert.equal(
    twitchProxySignature(
      proxySecret,
      String(now),
      input.headers[twitchProxyHeaders.nonce],
      normalized,
      body,
    ),
    input.headers[twitchProxyHeaders.signature],
  );
  assert.throws(
    () => normalizeTwitchProxyHeaders({ ...twitchHeaders, "twitch-eventsub-message-id": "second" }),
    TypeError,
  );
  assert.throws(
    () => normalizeTwitchProxyHeaders({ "twitch-eventsub-message-id": ["one"] }),
    TypeError,
  );
  assert.throws(
    () => normalizeTwitchProxyHeaders({ "twitch-eventsub-message-id": "bad\r\nvalue" }),
    TypeError,
  );
  assert.throws(
    () => twitchProxySignature("short", String(now), "a".repeat(32), {}, body),
    TypeError,
  );
});

test("private ingress validates keys and binds only loopback on explicit start", async (t) => {
  assert.throws(() =>
    createTwitchIngress({ proxySecret, forbiddenSecrets: [proxySecret], port: 35472 }),
  );
  assert.throws(() => createTwitchIngress({ proxySecret, port: 0 }));
  assert.throws(() => createTwitchIngress({ proxySecret, port: 80 }));
  let calls = 0;
  const { port } = await start(t, {
    receiver: {
      receive(input) {
        calls++;
        assert.deepEqual(
          Object.keys(input.headers).sort(),
          Object.keys(twitchHeaders)
            .map((name) => name.toLowerCase())
            .sort(),
        );
        assert.deepEqual(input.rawBody, Buffer.from('  {"x":1}\n'));
        return { status: 204, body: "" };
      },
    },
  });
  const input = signed(Buffer.from('  {"x":1}\n'));
  input.headers.Cookie = "private-session";
  input.headers.Authorization = "Bearer private";
  const result = await send(port, input);
  assert.equal(result.status, 204);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(calls, 1);
});

test("body/header tampering, stale or future proxy time and nonce replay never reach receiver", async (t) => {
  let calls = 0;
  const { port } = await start(t, {
    receiver: {
      receive() {
        calls++;
        return { status: 204, body: "" };
      },
    },
  });
  const original = signed();
  assert.equal((await send(port, original)).status, 204);
  assert.equal((await send(port, original)).status, 401);
  const bodyTamper = signed();
  bodyTamper.rawBody = Buffer.from("{} ");
  assert.equal((await send(port, bodyTamper)).status, 401);
  const headerTamper = signed();
  headerTamper.headers["Twitch-Eventsub-Message-Type"] = "revocation";
  assert.equal((await send(port, headerTamper)).status, 401);
  for (const time of [now - 30001, now + 30001])
    assert.equal(
      (await send(port, signed(Buffer.from("{}"), twitchHeaders, String(time)))).status,
      401,
    );
  const duplicate = signed();
  duplicate.headers["Twitch-Eventsub-Message-Id"] = ["message-one", "message-two"];
  assert.equal((await send(port, duplicate)).status, 400);
  assert.equal(calls, 1);
});

test("ingress path and method are exact and unsupported routes never acknowledge", async (t) => {
  let calls = 0;
  const { port } = await start(t, {
    receiver: {
      receive() {
        calls++;
        return { status: 204, body: "" };
      },
    },
  });
  for (const options of [
    { method: "GET" },
    { path: "/" },
    { path: "/eventsub?unexpected=1" },
    { path: "/eventsub/" },
  ])
    assert.equal((await send(port, signed(), options)).status, 404);
  assert.equal(calls, 0);
});

test("missing receiver, receiver failure and malformed reply return unavailable", async (t) => {
  for (const receiver of [
    undefined,
    {
      receive() {
        throw new Error("private database details");
      },
    },
    {
      receive() {
        return { status: 204 };
      },
    },
  ]) {
    const { port } = await start(t, { receiver });
    const result = await send(port, signed());
    assert.equal(result.status, 503);
    assert.equal(result.body, "");
  }
});

test("actual EventSub ack follows durable inbox commit and a failed database cannot ack", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = new TwitchHubStore(db, { authorize: () => {}, clock: () => now });
  await store.createBinding("100000000000000001", "200000000000000001", "create", {
    broadcasterId: "1337",
    channelId: "300000000000000001",
    template: "{url}",
    roleIds: [],
    mentionEveryone: false,
    enabled: true,
  });
  store.registerSubscription("1337", "subscription-one");
  const receiver = new EventSubReceiver({ secret: eventSecret, store, clock: () => now });
  const { port } = await start(t, { receiver });
  const challengeBody = Buffer.from(
    JSON.stringify({
      subscription: {
        id: "subscription-one",
        type: "stream.online",
        version: "1",
        status: "webhook_callback_verification_pending",
        condition: { broadcaster_user_id: "1337" },
      },
      challenge: "proof-of-callback",
    }),
  );
  const challengeHeaders = {
    ...twitchHeaders,
    "Twitch-Eventsub-Message-Id": "challenge-one",
    "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
    "Twitch-Eventsub-Message-Signature":
      "sha256=" +
      createHmac("sha256", eventSecret)
        .update("challenge-one")
        .update(new Date(now).toISOString())
        .update(challengeBody)
        .digest("hex"),
  };
  const challenge = await send(port, signed(challengeBody, challengeHeaders));
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body, "proof-of-callback");
  assert.equal(store.source("1337").status, "enabled");
  const event = {
    subscription: {
      id: "subscription-one",
      type: "stream.online",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "1337" },
    },
    event: {
      id: "stream-one",
      broadcaster_user_id: "1337",
      type: "live",
      started_at: new Date(now - 1000).toISOString(),
    },
  };
  const rawBody = Buffer.from(JSON.stringify(event)),
    headers = {
      ...twitchHeaders,
      "Twitch-Eventsub-Message-Signature":
        "sha256=" +
        createHmac("sha256", eventSecret)
          .update("message-one")
          .update(new Date(now).toISOString())
          .update(rawBody)
          .digest("hex"),
    };
  assert.equal((await send(port, signed(rawBody, headers))).status, 204);
  assert.equal(store.pending().length, 1);
  assert.equal(store.pending()[0].id, "message-one");
  assert.equal((await send(port, signed(rawBody, headers))).status, 204);
  assert.equal(store.pending().length, 1);
  const failed = await start(t, {
    receiver: new EventSubReceiver({
      secret: eventSecret,
      store: {
        accept() {
          throw new Error("disk full");
        },
      },
      clock: () => now,
    }),
  });
  assert.equal((await send(failed.port, signed(rawBody, headers))).status, 503);
});

test("declared and streamed bodies are capped before persistence", async (t) => {
  let calls = 0;
  const { port } = await start(t, {
    receiver: {
      receive() {
        calls++;
        return { status: 204, body: "" };
      },
    },
  });
  for (const chunked of [false, true]) {
    const result = await send(port, signed(Buffer.alloc(65537, 32)), { chunked }).catch(
      (error) => ({ error: error.code }),
    );
    assert.ok(result.status === 413 || result.error === "ECONNRESET", JSON.stringify(result));
  }
  assert.equal(calls, 0);
});

test("rate limit returns retry-after without invoking persistence", async (t) => {
  let calls = 0;
  const { port } = await start(t, {
    limits: { requestsPerMinute: 1 },
    receiver: {
      receive() {
        calls++;
        return { status: 204, body: "" };
      },
    },
  });
  assert.equal((await send(port, signed())).status, 204);
  const limited = await send(port, signed());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(calls, 1);
});

test("slow request counts toward concurrency and is closed at the deadline", async (t) => {
  let calls = 0;
  const { port } = await start(t, {
    limits: { activeRequests: 1, timeoutMs: 150 },
    receiver: {
      receive() {
        calls++;
        return { status: 204, body: "" };
      },
    },
  });
  const slow = request({
    host: "127.0.0.1",
    port,
    path: "/eventsub",
    method: "POST",
    headers: { ...signed().headers, "Content-Length": 100 },
  });
  const finished = new Promise((resolve) => {
    slow.on("response", (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    slow.on("error", (error) => resolve(error.code));
  });
  slow.flushHeaders();
  slow.write("{");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await send(port, signed())).status, 429);
  const result = await finished;
  assert.ok(result === 408 || result === "ECONNRESET");
  assert.equal(calls, 0);
});
