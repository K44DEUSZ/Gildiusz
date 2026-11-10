import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import { createPreviewWorker, previewActorId, previewGuildIds } from "../dist/preview/main.js";
import { controlOperationPath } from "../dist/contracts/index.js";
import { controlSignature } from "../dist/contracts/node.js";
import { startControlServer } from "../dist/control/server.js";

process.env.GILDIUSZ_PREVIEW_WORKER = "1";
delete process.env.PUBLIC_INSTALLS;
const token = () => randomBytes(32).toString("base64url");

test("controlled assets use isolated real files and a larger body limit only on exact upload routes", async (t) => {
  const f = await fixture(t);
  const image = new PhotonImage(new Uint8Array(randomBytes(200 * 200 * 4)), 200, 200),
    data = Buffer.from(image.get_bytes());
  image.free();
  assert.ok(data.length > 49152);
  const requestId = randomUUID(),
    uploaded = await f.data(
      "announcements.assets.upload",
      { mediaType: "image/png", dataBase64: data.toString("base64") },
      { requestId },
    );
  const read = await f.data("announcements.assets.read", {}, { objectId: uploaded.asset.id });
  assert.deepEqual(Buffer.from(read.dataBase64, "base64"), data);
  const replay = await f.data(
    "announcements.assets.upload",
    { mediaType: "image/png", dataBase64: data.toString("base64") },
    { requestId },
  );
  assert.deepEqual(replay.asset, uploaded.asset);
  assert.equal((await f.call("settings.read", { padding: "x".repeat(50000) })).status, 413);
  assert.equal(
    (
      await f.call(
        "announcements.assets.read",
        {},
        { objectId: uploaded.asset.id, guildId: previewGuildIds[1] },
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.call("announcements.assets.read", {}, { objectId: uploaded.asset.id, scope: token() }))
      .status,
    404,
  );
  assert.equal(
    (
      await f.call(
        "announcements.assets.read",
        {},
        { objectId: uploaded.asset.id, actor: "900000000000000002" },
      )
    ).status,
    401,
  );
  await f.restart();
  const restored = await f.data("announcements.assets.read", {}, { objectId: uploaded.asset.id });
  assert.deepEqual(Buffer.from(restored.dataBase64, "base64"), data);
});

test("announcement removal is scoped, CAS protected and durably replayable after restart", async (t) => {
  const f = await fixture(t),
    saved = await f.data(
      "announcements.create",
      {
        channelId: "",
        content: "Szkic do usunięcia",
        saveAsDraft: true,
        schedule: { kind: "once", at: f.now() + 60000 },
      },
      { requestId: "remove-create" },
    );
  const id = saved.announcement.id,
    payload = { revision: saved.announcement.revision };
  assert.equal(
    (
      await f.call("announcements.remove", payload, {
        objectId: id,
        requestId: "foreign-remove",
        scope: token(),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        "announcements.remove",
        { revision: payload.revision + 1 },
        { objectId: id, requestId: "stale-remove" },
      )
    ).status,
    409,
  );
  const removed = await f.data("announcements.remove", payload, {
    objectId: id,
    requestId: "remove-receipt",
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.announcementId, id);
  assert.equal((await f.call("announcements.read", {}, { objectId: id })).status, 404);
  assert.deepEqual((await f.data("announcements.list")).announcements, []);
  await f.restart();
  assert.deepEqual(
    await f.data("announcements.remove", payload, { objectId: id, requestId: "remove-receipt" }),
    removed,
  );
  assert.equal(
    (await f.call("announcements.remove", payload, { objectId: id, requestId: "second-remove" }))
      .status,
    404,
  );
});

function post(origin, key, path, body, headers = {}) {
  const raw = JSON.stringify(body),
    time = String(Date.now()),
    nonce = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(path, origin),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
          "x-gildiusz-time": time,
          "x-gildiusz-nonce": nonce,
          "x-gildiusz-signature": controlSignature(key, "POST", path, time, nonce, raw),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(raw);
  });
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-preview-"));
  const key = token(),
    scope = token();
  let now = Date.parse("2026-11-09T12:00:00Z"),
    worker;
  const start = async () =>
    (worker = await createPreviewWorker({
      ...options,
      key,
      port: 0,
      dataDir: directory,
      clock: () => now,
      autoStart: options.autoStart ?? false,
    }));
  await start();
  t.after(async () => {
    await worker.close();
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-preview-")
    )
      throw Error("Unexpected test directory.");
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (operation, payload = {}, extra = {}) => {
    const guildId = extra.guildId ?? previewGuildIds[0];
    const path = controlOperationPath(operation, guildId, extra.objectId);
    return post(
      worker.origin,
      extra.key ?? key,
      path,
      {
        schemaVersion: 1,
        actor: extra.actor ?? previewActorId,
        accessToken: extra.scope ?? scope,
        ...(extra.requestId ? { requestId: extra.requestId } : {}),
        payload,
      },
      extra.headers,
    );
  };
  return {
    key,
    scope,
    directory,
    call,
    worker: () => worker,
    now: () => now,
    setNow: (value) => {
      now = value;
    },
    restart: async () => {
      await worker.close();
      await start();
    },
    data: async (operation, payload = {}, extra = {}) => {
      const result = await call(operation, payload, extra);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.schemaVersion, 1);
      assert.equal(result.body.data.preview, true);
      return result.body.data;
    },
  };
}
async function setup(f, extra = {}) {
  return f.data("settings.read", {}, extra);
}
async function create(f, requestId = "create-one", extra = {}, input = {}) {
  const snapshot = await setup(f, extra);
  return f.data(
    "announcements.create",
    {
      content: "Wieczorem robimy przegląd projektów.",
      channelId: snapshot.resources.channels[0].id,
      schedule: { kind: "once", at: f.now() + 60000 },
      ...input,
    },
    { ...extra, requestId },
  );
}
function noInternalJobFields(value) {
  for (const key of ["payload", "result", "leaseToken", "nonce"])
    assert.equal(Object.hasOwn(value, key), false, key);
}
function publicData(value) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) noInternalJobFields(value);
  for (const entry of Object.values(value)) publicData(entry);
}

test("preview requires its explicit environment and rejects public installation mode before opening storage", async () => {
  for (const [enabled, publicInstalls] of [
    ["0", "0"],
    ["1", "1"],
    ["1", "true"],
  ]) {
    process.env.GILDIUSZ_PREVIEW_WORKER = enabled;
    process.env.PUBLIC_INSTALLS = publicInstalls;
    await assert.rejects(
      createPreviewWorker({ key: token(), port: 0 }),
      /isolated local environment/,
    );
  }
  process.env.GILDIUSZ_PREVIEW_WORKER = "1";
  delete process.env.PUBLIC_INSTALLS;
  await assert.rejects(createPreviewWorker({ key: "short", port: 0 }), /control key/);
  assert.throws(() => startControlServer(token(), 0, async () => ({})), /configuration/);
});

test("HTTP is loopback-only, versioned and signed, with a fixed synthetic identity", async (t) => {
  const f = await fixture(t);
  assert.equal(f.worker().server.address().address, "127.0.0.1");
  const result = await f.call("guilds.list");
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.data.guilds.map((guild) => guild.id),
    previewGuildIds,
  );
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["access-control-allow-origin"], undefined);
  assert.equal((await f.call("guilds.list", {}, { key: token() })).status, 401);
  assert.equal((await f.call("guilds.list", {}, { actor: "123456789012345678" })).status, 401);
  assert.equal((await f.call("guilds.list", {}, { scope: "not-a-session-scope" })).status, 401);
  assert.equal((await f.call("settings.read", {}, { guildId: "123456789012345678" })).status, 404);
  assert.equal((await post(f.worker().origin, f.key, "/guilds", {})).status, 404);
  const incompatible = await post(f.worker().origin, f.key, "/v1/guilds", {
    schemaVersion: 99,
    actor: previewActorId,
    accessToken: f.scope,
    payload: {},
  });
  assert.equal(incompatible.status, 426);
});

test("synthetic resources enable integrated local domains while future modules stay unavailable", async (t) => {
  const f = await fixture(t);
  const first = await setup(f),
    second = await setup(f, { guildId: previewGuildIds[1] });
  assert.equal(first.moduleSettings.enabled.announcements, true);
  assert.equal(first.moduleSettings.enabled.meetings, true);
  assert.equal(first.moduleSettings.enabled.cases, true);
  assert.equal(first.moduleSettings.enabled.music, false);
  assert.equal(
    first.capabilities.modules.some((module) => module.key === "music"),
    false,
  );
  assert.equal(
    first.capabilities.modules.find((module) => module.key === "announcements").status,
    "enabled",
  );
  assert.equal(
    first.capabilities.modules.find((module) => module.key === "meetings").status,
    "enabled",
  );
  assert.ok(first.resources.channels.every((channel) => /^\d{18}$/.test(channel.id)));
  assert.ok(first.resources.roles.every((role) => /^\d{18}$/.test(role.id)));
  assert.notEqual(first.resources.channels[0].id, second.resources.channels[0].id);
  const unavailable = await f.call(
    "settings.save",
    {
      scope: "modules",
      settings: {
        ...first.moduleSettings,
        enabled: { ...first.moduleSettings.enabled, music: true },
      },
    },
    { requestId: "enable-future" },
  );
  assert.equal(unavailable.status, 409);
  const foreignRole = await f.call(
    "settings.save",
    {
      scope: "modules",
      settings: {
        ...first.moduleSettings,
        announcementManagerRoleIds: [second.resources.roles[0].id],
      },
    },
    { requestId: "foreign-role" },
  );
  assert.equal(foreignRole.status, 400);
});

test("capabilities supplies the complete editor contract with implemented permissions and mention hints", async (t) => {
  const f = await fixture(t),
    settings = await setup(f);
  const view = await f.data("capabilities.read");
  assert.deepEqual(view.resources, settings.resources);
  assert.deepEqual(view.moduleSettings, settings.moduleSettings);
  assert.deepEqual(view.modules, settings.capabilities.modules);
  for (const operation of [
    "capabilities.read",
    "settings.read",
    "settings.save",
    "announcements.list",
    "announcements.read",
    "announcements.create",
    "announcements.update",
    "announcements.preview",
    "announcements.test",
    "announcements.pause",
    "announcements.resume",
    "announcements.cancel",
    "meetings.list",
    "meetings.read",
    "meetings.create",
    "meetings.update",
    "meetings.preview",
    "meetings.join",
    "meetings.leave",
    "meetings.start",
    "meetings.complete",
    "meetings.cancel",
    "cases.list",
    "cases.read",
    "cases.create",
    "cases.reply",
    "cases.notes",
    "cases.note",
    "cases.assign",
    "cases.transition",
    "cases.approve",
    "cases.vote",
  ])
    assert.ok(view.permissions.includes(operation), operation);
  assert.equal(new Set(view.permissions).size, view.permissions.length);
  assert.ok(view.permissions.includes("announcements.remove"));
  assert.ok(
    !view.permissions.some(
      (operation) =>
        operation.startsWith("twitch.") ||
        operation.startsWith("music.") ||
        operation.startsWith("integrations."),
    ),
  );
  assert.deepEqual(view.mentionPermissions, {
    roleIds: settings.resources.roles.map((role) => role.id),
    everyone: true,
  });
  publicData(view);
  const saved = await f.data(
    "settings.save",
    {
      scope: "modules",
      settings: {
        ...settings.moduleSettings,
        timeZone: "Europe/London",
        announcementManagerRoleIds: [settings.resources.roles[0].id],
      },
    },
    { requestId: "editor-settings" },
  );
  const updated = await f.data("capabilities.read");
  assert.deepEqual(updated.moduleSettings, saved.moduleSettings);
  assert.equal(updated.moduleSettings.timeZone, "Europe/London");
});

test("rule creation replays atomically and rejects a reused request with different content", async (t) => {
  const f = await fixture(t);
  const first = await create(f);
  noInternalJobFields(first.job);
  assert.deepEqual(await create(f), first);
  const changed = await create(f, "create-other");
  const conflict = await f.call(
    "announcements.create",
    {
      content: "Inna treść",
      channelId: first.announcement.channelId,
      schedule: first.announcement.schedule,
    },
    { requestId: "create-one" },
  );
  assert.equal(conflict.status, 409);
  const history = await f.data("jobs.list", { announcementId: first.announcement.id });
  assert.deepEqual(
    history.jobs.map((job) => job.id),
    [first.job.id],
  );
  assert.notEqual(first.announcement.id, changed.announcement.id);
  history.jobs.forEach(noInternalJobFields);
});

test("schedule-only preview converts a missing Warsaw time and returns five recurring dates", async (t) => {
  const f = await fixture(t);
  f.setNow(Date.parse("2026-03-27T00:00:00Z"));
  const once = await f.data("announcements.preview", {
    schedule: { kind: "once", date: "2026-03-29", time: "02:30", timeZone: "Europe/Warsaw" },
  });
  assert.equal(once.schedule.at, Date.parse("2026-03-29T01:00:00Z"));
  assert.equal(once.occurrences[0].localTime, "2026-03-29T03:00");
  assert.equal(once.occurrences[0].adjusted, true);
  const recurring = await f.data("announcements.preview", {
    schedule: { kind: "weekly", time: "18:00", weekdays: [1, 5], timeZone: "Europe/Warsaw" },
  });
  assert.equal(recurring.occurrences.length, 5);
  assert.equal((await f.data("announcements.list")).announcements.length, 0);
});

test("test publications finish through the shared runner and reveal only their scoped history", async (t) => {
  const f = await fixture(t);
  const first = await create(f),
    second = await create(f, "second-rule");
  const tested = await f.data(
    "announcements.test",
    { revision: first.announcement.revision },
    { objectId: first.announcement.id, requestId: "test-first" },
  );
  assert.equal(tested.job.state, "pending");
  noInternalJobFields(tested.job);
  assert.equal(await f.worker().tick(), 1);
  const delivered = await f.data(
    "jobs.read",
    { announcementId: first.announcement.id },
    { objectId: tested.job.id },
  );
  assert.equal(delivered.job.state, "succeeded");
  assert.match(delivered.job.messageId, /^preview-/);
  assert.equal(delivered.attempts.length, 1);
  noInternalJobFields(delivered.job);
  delivered.attempts.forEach(noInternalJobFields);
  const own = await f.data("deliveries.list", { announcementId: first.announcement.id });
  const other = await f.data("deliveries.list", { announcementId: second.announcement.id });
  assert.equal(own.deliveries.length, 1);
  assert.equal(other.deliveries.length, 0);
  const mismatched = await f.call(
    "jobs.read",
    { announcementId: second.announcement.id },
    { objectId: tested.job.id },
  );
  assert.equal(mismatched.status, 404);
  assert.equal(
    (await f.data("announcements.read", {}, { objectId: first.announcement.id })).announcement
      .publishedCount,
    0,
  );
});

test("announcement details scope both jobs and deliveries to the requested object and redact internals", async (t) => {
  const f = await fixture(t),
    first = await create(f),
    second = await create(f, "other-announcement");
  const firstTest = await f.data(
    "announcements.test",
    { revision: first.announcement.revision },
    { objectId: first.announcement.id, requestId: "first-test" },
  );
  const secondTest = await f.data(
    "announcements.test",
    { revision: second.announcement.revision },
    { objectId: second.announcement.id, requestId: "second-test" },
  );
  await f.worker().tick();
  await f.worker().tick();
  const left = await f.data("announcements.read", {}, { objectId: first.announcement.id });
  const right = await f.data("announcements.read", {}, { objectId: second.announcement.id });
  for (const [view, target, scheduled, trial, foreign] of [
    [left, first.announcement.id, first.job.id, firstTest.job.id, secondTest.job.id],
    [right, second.announcement.id, second.job.id, secondTest.job.id, firstTest.job.id],
  ]) {
    assert.equal(view.announcement.id, target);
    assert.deepEqual(new Set(view.jobs.map((job) => job.id)), new Set([scheduled, trial]));
    assert.ok(view.jobs.every((job) => job.objectId === target && job.id !== foreign));
    assert.equal(view.deliveries.length, 1);
    assert.equal(view.deliveries[0].jobId, trial);
    assert.equal(view.deliveries[0].state, "succeeded");
    assert.match(view.deliveries[0].messageId, /^preview-/);
    publicData(view);
  }
  for (const [operation, extra, arrayKey] of [
    ["jobs.read", { objectId: firstTest.job.id }, "attempts"],
    ["deliveries.list", {}, "deliveries"],
  ]) {
    const view = await f.data(operation, { announcementId: first.announcement.id }, extra);
    assert.equal(view[arrayKey].length, 1);
    assert.equal(view[arrayKey][0].jobId, firstTest.job.id);
    publicData(view);
  }
  const mutation = await f.data(
    "announcements.pause",
    { revision: left.announcement.revision },
    { objectId: first.announcement.id, requestId: "pause-after-test" },
  );
  publicData(mutation);
});

test("session scopes and guild databases cannot read or change one another's objects", async (t) => {
  const f = await fixture(t),
    otherScope = token();
  const first = await create(f);
  for (const extra of [{ scope: otherScope }, { guildId: previewGuildIds[1] }]) {
    assert.equal((await f.data("announcements.list", {}, extra)).announcements.length, 0);
    assert.equal(
      (await f.call("announcements.read", {}, { ...extra, objectId: first.announcement.id }))
        .status,
      404,
    );
    assert.equal(
      (
        await f.call(
          "announcements.cancel",
          { revision: 1 },
          { ...extra, objectId: first.announcement.id, requestId: "cross-cancel" },
        )
      ).status,
      404,
    );
    assert.equal((await f.call("jobs.read", {}, { ...extra, objectId: first.job.id })).status, 404);
  }
  const second = await create(f, "create-one", { scope: otherScope });
  assert.notEqual(second.announcement.id, first.announcement.id);
  assert.equal((await f.data("announcements.list")).announcements.length, 1);
});

test("restart restores queued rules for each session and simulates delivery without any Discord request", async (t) => {
  const f = await fixture(t),
    otherScope = token();
  const first = await create(f),
    second = await create(f, "create-other", { scope: otherScope });
  await f.restart();
  f.setNow(f.now() + 60000);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw Error("Unexpected network");
  };
  try {
    await f.worker().tick();
    await f.worker().tick();
    const left = await f.data("announcements.read", {}, { objectId: first.announcement.id });
    const right = await f.data(
      "announcements.read",
      {},
      { scope: otherScope, objectId: second.announcement.id },
    );
    assert.equal(left.announcement.status, "completed");
    assert.equal(right.announcement.status, "completed");
    assert.equal(left.announcement.publishedCount, 1);
    assert.equal(right.announcement.publishedCount, 1);
    assert.match(left.announcement.lastMessageId, /^preview-/);
    assert.notEqual(left.announcement.lastMessageId, right.announcement.lastMessageId);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired sessions are closed and removed before enforcing the cap, including after restart", async (t) => {
  const f = await fixture(t, { maxSessions: 1, sessionTtlMs: 1000 });
  const first = await create(f);
  assert.equal((await f.call("guilds.list", {}, { scope: token() })).status, 429);
  await f.restart();
  f.setNow(f.now() + 1000);
  const other = token();
  assert.equal((await f.call("guilds.list", {}, { scope: other })).status, 200);
  assert.equal(readdirSync(f.directory).filter((name) => /^[a-f0-9]{64}$/.test(name)).length, 0);
  assert.equal(
    (await f.call("announcements.read", {}, { scope: other, objectId: first.announcement.id }))
      .status,
    404,
  );
  assert.equal((await f.call("guilds.list")).status, 429);
  f.setNow(f.now() + 1000);
  assert.equal((await f.data("announcements.list")).announcements.length, 0);
});

test("module settings use shared validation, revisions and persistent idempotency", async (t) => {
  const f = await fixture(t);
  const first = await setup(f);
  const input = {
    scope: "modules",
    settings: { ...first.moduleSettings, timeZone: "Europe/London" },
  };
  const saved = await f.data("settings.save", input, { requestId: "settings-save" });
  assert.equal(saved.moduleSettings.timeZone, "Europe/London");
  assert.equal(saved.moduleSettings.revision, first.moduleSettings.revision + 1);
  assert.deepEqual(await f.data("settings.save", input, { requestId: "settings-save" }), saved);
  assert.equal((await f.call("settings.save", input, { requestId: "stale-settings" })).status, 409);
  await f.restart();
  assert.equal((await setup(f)).moduleSettings.timeZone, "Europe/London");
  assert.deepEqual(await f.data("settings.save", input, { requestId: "settings-save" }), saved);
});

test("editing, pausing, resuming and cancelling use domain revisions and invalidate old work", async (t) => {
  const f = await fixture(t);
  const created = await create(f);
  const updated = await f.data(
    "announcements.update",
    {
      revision: 1,
      draft: {
        content: "Nowa treść",
        channelId: created.announcement.channelId,
        schedule: created.announcement.schedule,
      },
    },
    { objectId: created.announcement.id, requestId: "update-rule" },
  );
  assert.equal(updated.announcement.generation, 2);
  assert.equal(
    (await f.data("jobs.read", {}, { objectId: created.job.id })).job.state,
    "cancelled",
  );
  const paused = await f.data(
    "announcements.pause",
    { revision: updated.announcement.revision },
    { objectId: created.announcement.id, requestId: "pause-rule" },
  );
  assert.equal(paused.announcement.status, "paused");
  const resumed = await f.data(
    "announcements.resume",
    { revision: paused.announcement.revision },
    { objectId: created.announcement.id, requestId: "resume-rule" },
  );
  assert.equal(resumed.announcement.status, "scheduled");
  const cancelled = await f.data(
    "announcements.cancel",
    { revision: resumed.announcement.revision },
    { objectId: created.announcement.id, requestId: "cancel-rule" },
  );
  assert.equal(cancelled.announcement.status, "cancelled");
  f.setNow(f.now() + 60000);
  assert.equal(await f.worker().tick(), 0);
});

test("the local preview timer processes due work without an explicit manual tick", async (t) => {
  const f = await fixture(t, { autoStart: true, intervalMs: 10 });
  const created = await create(f, "timer-rule", {}, { schedule: { kind: "once", at: f.now() } });
  let job;
  const deadline = Date.now() + 1000;
  do {
    await new Promise((done) => setTimeout(done, 15));
    job = (await f.data("jobs.read", {}, { objectId: created.job.id })).job;
  } while (job.state !== "succeeded" && Date.now() < deadline);
  assert.equal(job.state, "succeeded");
  assert.match(job.messageId, /^preview-/);
});
