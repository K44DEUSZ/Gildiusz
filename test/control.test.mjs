import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/storage/store.js";
import { SettingsService } from "../dist/settings.js";
import { publicConfig, readControlConfiguration } from "../dist/control/configuration.js";
import { parseConfiguration, validateBindings } from "../dist/control/contracts.js";
import { startControlServer, controlSignature } from "../dist/control/server.js";
import { PublicInstallations } from "../dist/control/installations.js";
import { relay } from "../scripts/control-relay.mjs";

const guild = "100000000000000001",
  owner = "100000000000000002";

test("the SSH relay cannot execute commands or reach another host, path or HTTP method", async () => {
  const request = {
    method: "POST",
    path: "/guilds/" + guild,
    headers: { "x-gildiusz-time": "1000000000000" },
    body: "{}",
  };
  let observed;
  assert.deepEqual(
    await relay(request, async (url, options) => {
      observed = { url, options };
      return { status: 403, json: async () => ({ error: "denied" }) };
    }),
    { status: 403, body: { error: "denied" } },
  );
  assert.equal(observed.url, "http://127.0.0.1:35471/guilds/" + guild);
  assert.equal(observed.options.redirect, "error");
  for (const patch of [
    { path: "https://example.org/" },
    { path: "/guilds/../secrets" },
    { method: "GET" },
    { headers: { Authorization: "unexpected" } },
    { body: "x".repeat(49153) },
  ])
    await assert.rejects(relay({ ...request, ...patch }));
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-control-")),
    store = new Store(join(directory, "db.sqlite"), guild),
    config = publicConfig(),
    settings = new SettingsService(store, config, guild);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    config,
    settings,
    read: (managed = false) => readControlConfiguration(store, config, settings, guild, managed),
  };
}
test("public installations are isolated, durable and start with all modules disabled", (t) => {
  const f = fixture(t),
    registry = new PublicInstallations(join(f.directory, "guilds"));
  const first = registry.add(guild, owner),
    second = registry.add("100000000000000003", owner);
  assert.notEqual(first.databasePath, second.databasePath);
  assert.equal(new PublicInstallations(join(f.directory, "guilds")).values().length, 2);
  assert.throws(() => registry.add("../escape", owner));
  assert.deepEqual(f.read().modules, {
    rooms: false,
    reactions: false,
    files: false,
    reports: false,
  });
  assert.deepEqual(f.read().files.channelIds, []);
});
test("migration reads existing bindings without writes and web/Discord share conflict protection", (t) => {
  const f = fixture(t);
  for (const [key, kind, id] of [
    ["channel.join", "channel", "100000000000000004"],
    ["category.rooms", "category", "100000000000000005"],
    ["channel.moderation", "channel", "100000000000000006"],
    ["channel.forum", "channel", "100000000000000007"],
  ])
    f.store.putResource(key, kind, id, {});
  const legacy = f.read(true),
    before = f.store.resources();
  assert.equal(legacy.rooms.entryChannelId, before.find((row) => row.key === "channel.join").id);
  assert.equal(legacy.files.includeRooms, true);
  assert.equal(legacy.files.channelIds.includes("100000000000000007"), true);
  assert.equal(legacy.files.channelIds.includes("100000000000000006"), false);
  assert.equal(f.store.controlConfiguration(guild), undefined);
  const current = f.settings.read();
  f.store.saveControlConfiguration(
    guild,
    legacy,
    { ...current.values, maximum: 7, emptySeconds: 47 },
    0,
    owner,
  );
  assert.equal(f.read(true).rooms.idleSeconds, 47);
  assert.equal(f.read(true).rooms.maxRooms, 7);
  f.settings.update({ maximum: 9 }, 1, owner);
  assert.equal(f.read(true).revision, 2);
  assert.equal(f.read(true).rooms.maxRooms, 9);
  assert.throws(
    () => f.store.saveControlConfiguration(guild, legacy, current.values, 1, owner),
    /conflict/,
  );
  assert.deepEqual(f.store.resources(), before);
  assert.equal(f.settings.read().values.maximum, 9);
});
test("configuration rejects excess limits, unknown fields, inaccessible channels and elevated roles", (t) => {
  const f = fixture(t),
    value = f.read();
  assert.throws(() => parseConfiguration({ ...value, rooms: { ...value.rooms, maxRooms: 46 } }));
  assert.throws(() => parseConfiguration({ ...value, arbitrary: true }));
  assert.throws(() => parseConfiguration({ ...value, rooms: { ...value.rooms, idleSeconds: 0 } }));
  value.modules.reactions = true;
  value.reactions = {
    channelId: "100000000000000008",
    choices: [{ emoji: "💻", roleId: "100000000000000009" }],
  };
  assert.ok(
    validateBindings(value, {
      channels: [
        {
          id: value.reactions.channelId,
          kind: "text",
          name: "roles",
          accessible: true,
          uses: ["files"],
        },
      ],
      roles: [
        { id: value.reactions.choices[0].roleId, name: "admin", color: "#fff", assignable: false },
      ],
    }).length >= 2,
  );
});
test("private API binds loopback, rejects wrong signatures, stale requests and replayed nonces", async (t) => {
  const key = randomBytes(32).toString("base64url");
  let calls = 0;
  const server = await startControlServer(key, 35479, async () => {
    calls++;
    return { ok: true };
  });
  t.after(() => server.close());
  assert.equal(server.address().address, "127.0.0.1");
  const body = JSON.stringify({ actor: owner }),
    nonce = randomBytes(16).toString("hex"),
    time = Date.now().toString();
  const headers = {
    "X-Gildiusz-Time": time,
    "X-Gildiusz-Nonce": nonce,
    "X-Gildiusz-Signature": controlSignature(key, "POST", "/guilds", time, nonce, body),
  };
  const send = (patch = {}) =>
    globalThis.fetch("http://127.0.0.1:35479/guilds", {
      method: "POST",
      body,
      headers: { ...headers, ...patch },
    });
  assert.equal((await send({ "X-Gildiusz-Signature": "0".repeat(64) })).status, 401);
  assert.equal((await send({ "X-Gildiusz-Time": "1000000000000" })).status, 401);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 401);
  assert.equal(calls, 1);
});
