import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createPreviewWorker, previewActorId, previewGuildIds } from "../dist/preview/main.js";
import { controlOperationPath } from "../dist/contracts/index.js";
import { controlSignature } from "../dist/contracts/node.js";
import { allowedCaseStatuses } from "../dist/modules/cases/service.js";

process.env.GILDIUSZ_PREVIEW_WORKER = "1";
delete process.env.PUBLIC_INSTALLS;
const token = () => randomBytes(32).toString("base64url");
function publicData(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!["payload", "result", "leaseToken", "nonce"].includes(key), key);
    publicData(item);
  }
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-preview-community-")),
    key = token(),
    scope = token();
  let now = Date.parse("2026-11-09T12:00:00Z"),
    worker;
  const start = async () =>
    (worker = await createPreviewWorker({
      key,
      port: 0,
      dataDir: directory,
      clock: () => now,
      autoStart: false,
    }));
  await start();
  t.after(async () => {
    await worker.close();
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-preview-community-")
    )
      throw Error("Unexpected test directory.");
    rmSync(directory, { recursive: true, force: true });
  });
  async function call(operation, payload = {}, extra = {}) {
    const path = controlOperationPath(
      operation,
      extra.guildId ?? previewGuildIds[0],
      extra.objectId,
    );
    const raw = JSON.stringify({
      schemaVersion: 1,
      actor: extra.actor ?? previewActorId,
      accessToken: extra.scope ?? scope,
      ...(extra.requestId ? { requestId: "preview_" + extra.requestId } : {}),
      payload,
    });
    const time = String(Date.now()),
      nonce = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        new URL(path, worker.origin),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(raw),
            "x-gildiusz-time": time,
            "x-gildiusz-nonce": nonce,
            "x-gildiusz-signature": controlSignature(key, "POST", path, time, nonce, raw),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            try {
              resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      request.end(raw);
    });
  }
  async function data(operation, payload = {}, extra = {}) {
    const response = await call(operation, payload, extra);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.schemaVersion, 1);
    assert.equal(response.body.data.preview, true);
    publicData(response.body.data);
    return response.body.data;
  }
  async function meeting(input = {}, extra = {}) {
    const snapshot = await data("settings.read", {}, extra);
    const draft = {
      title: "Wspólna praca",
      description: "Wieczorne spotkanie projektu.",
      capacity: 3,
      startsAt: now + 3600000,
      endsAt: now + 7200000,
      channelId: snapshot.resources.channels[0].id,
      visibility: "public",
      organizerParticipates: false,
      reminderMinutes: [30, 10],
      room: { kind: "none" },
      ...input,
    };
    return {
      draft,
      ...(await data("meetings.create", draft, { requestId: "create-meeting", ...extra })),
    };
  }
  async function createCase(input = {}, extra = {}) {
    const draft = {
      kind: "report",
      title: "Sprawa z projektu",
      content: "Prywatny opis sprawy.",
      ...input,
    };
    return {
      draft,
      ...(await data("cases.create", draft, { requestId: "create-case", ...extra })),
    };
  }
  function db(work, extra = {}) {
    const hash = createHash("sha256")
      .update(extra.scope ?? scope)
      .digest("hex");
    const store = new DatabaseSync(
      join(directory, hash, `${extra.guildId ?? previewGuildIds[0]}.sqlite`),
    );
    try {
      store.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      return work(store);
    } finally {
      store.close();
    }
  }
  return {
    data,
    call,
    meeting,
    createCase,
    db,
    key,
    scope,
    directory,
    worker: () => worker,
    now: () => now,
    setNow: (value) => {
      now = value;
    },
    restart: async () => {
      await worker.close();
      await start();
    },
    drain: async () => {
      let total = 0;
      for (let i = 0; i < 30; i++) {
        const count = await worker.tick();
        total += count;
        if (!count) return total;
      }
      throw Error("Preview did not drain bounded local work.");
    },
  };
}

test("community capabilities expose real local domains, scoped settings and no future modules", async (t) => {
  const f = await fixture(t),
    view = await f.data("capabilities.read");
  for (const key of ["meetings", "cases"]) {
    assert.equal(view.moduleSettings.enabled[key], true);
    assert.equal(view.modules.find((item) => item.key === key).status, "enabled");
  }
  assert.equal(view.moduleSettings.cases.retentionMs, 90 * 86400000);
  assert.ok(
    view.resources.channels.some(
      (channel) =>
        channel.id === view.moduleSettings.cases.categoryId && channel.kind === "category",
    ),
  );
  assert.ok(
    view.resources.channels.some(
      (channel) =>
        channel.id === view.moduleSettings.cases.suggestionChannelId && channel.kind === "text",
    ),
  );
  assert.equal(
    view.modules.some((item) => item.key === "music"),
    false,
  );
  for (const key of ["twitch", "integrations"])
    assert.equal(view.modules.find((item) => item.key === key).availability, "planned");
  for (const operation of [
    "meetings.preview",
    "meetings.create",
    "meetings.join",
    "meetings.complete",
    "cases.create",
    "cases.note",
    "cases.notes",
    "cases.approve",
    "cases.vote",
  ])
    assert.ok(view.permissions.includes(operation), operation);
  assert.ok(view.permissions.includes("announcements.remove"));
});

test("meeting preview uses shared DST resolution and list/read/create are durable domain operations", async (t) => {
  const f = await fixture(t);
  const spring = await f.data("meetings.preview", {
    date: "2027-03-28",
    time: "02:30",
    timeZone: "Europe/Warsaw",
  });
  assert.equal(spring.at, Date.parse("2027-03-28T01:00:00Z"));
  assert.equal(spring.adjusted, true);
  const autumn = await f.data("meetings.preview", {
    date: "2027-10-31",
    time: "02:30",
    timeZone: "Europe/Warsaw",
  });
  assert.equal(autumn.at, Date.parse("2027-10-31T00:30:00Z"));
  const created = await f.meeting();
  assert.equal(created.meeting.organizerId, previewActorId);
  assert.equal(created.meeting.confirmedCount, 0);
  assert.equal((await f.data("meetings.list")).meetings[0].id, created.meeting.id);
  const detail = await f.data("meetings.read", {}, { objectId: created.meeting.id });
  assert.equal(detail.meeting.id, created.meeting.id);
  assert.deepEqual(detail.participants, []);
  for (const operation of ["meetings.update", "meetings.join", "meetings.start", "meetings.cancel"])
    assert.ok(detail.allowedOperations.includes(operation));
  assert.ok(detail.jobs.every((job) => job.objectId === created.meeting.id));
  assert.equal(
    (await f.data("meetings.create", created.draft, { requestId: "create-meeting" })).meeting.id,
    created.meeting.id,
  );
});

test("meeting enrollment replays once, leaves, rejoins at a later queue sequence and CAS protects edits", async (t) => {
  const f = await fixture(t),
    created = await f.meeting({ capacity: 1 });
  const first = await f.data(
    "meetings.join",
    {},
    { objectId: created.meeting.id, requestId: "join" },
  );
  assert.equal(first.meeting.confirmedCount, 1);
  assert.equal(first.meeting.full, true);
  assert.equal(first.participants[0].userId, previewActorId);
  const replay = await f.data(
    "meetings.join",
    {},
    { objectId: created.meeting.id, requestId: "join" },
  );
  assert.equal(replay.participants.length, 1);
  assert.equal(replay.meeting.participantVersion, first.meeting.participantVersion);
  await f.data("meetings.leave", {}, { objectId: created.meeting.id, requestId: "leave" });
  const again = await f.data(
    "meetings.join",
    {},
    { objectId: created.meeting.id, requestId: "rejoin" },
  );
  assert.ok(again.participants[0].sequence > first.participants[0].sequence);
  const updated = await f.data(
    "meetings.update",
    { revision: created.meeting.revision, draft: { ...created.draft, title: "Nowy temat" } },
    { objectId: created.meeting.id, requestId: "edit" },
  );
  assert.equal(updated.meeting.title, "Nowy temat");
  assert.equal(
    (
      await f.call(
        "meetings.update",
        { revision: created.meeting.revision, draft: created.draft },
        { objectId: created.meeting.id, requestId: "stale" },
      )
    ).status,
    409,
  );
});

test("restored waitlisted demo actor is promoted by the real domain and receives one local receipt", async (t) => {
  const f = await fixture(t),
    created = await f.meeting({ capacity: 1 });
  await f.data("meetings.join", {}, { objectId: created.meeting.id, requestId: "join" });
  // Test-only recovery state. The normal demo never invents additional members.
  f.db((db) => {
    db.prepare(
      "UPDATE meeting_participants SET state='waitlisted' WHERE meeting_id=? AND user_id=?",
    ).run(created.meeting.id, previewActorId);
    db.prepare("UPDATE meetings SET participant_version=participant_version+1 WHERE id=?").run(
      created.meeting.id,
    );
  });
  await f.restart();
  const before = await f.data("meetings.read", {}, { objectId: created.meeting.id });
  assert.equal(before.participants[0].state, "waitlisted");
  const promoted = await f.data(
    "meetings.update",
    { revision: before.meeting.revision, draft: { ...created.draft, capacity: 2 } },
    { objectId: created.meeting.id, requestId: "space" },
  );
  assert.equal(promoted.participants[0].state, "confirmed");
  assert.equal(promoted.meeting.waitlistedCount, 0);
  await f.drain();
  const detail = await f.data("meetings.read", {}, { objectId: created.meeting.id });
  const jobs = detail.jobs.filter((job) => job.type === "meeting.promoted");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, "succeeded");
});

test("manual start and completion only simulate owned rooms with scoped restart-safe receipts", async (t) => {
  const f = await fixture(t),
    settings = await f.data("settings.read");
  const created = await f.meeting({
    room: { kind: "create", categoryId: settings.moduleSettings.cases.categoryId },
  });
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw Error("Unexpected external request");
  };
  try {
    await f.data(
      "meetings.start",
      { revision: created.meeting.revision },
      { objectId: created.meeting.id, requestId: "start" },
    );
    await f.restart();
    await f.drain();
    const active = await f.data("meetings.read", {}, { objectId: created.meeting.id });
    assert.equal(active.meeting.state, "active");
    assert.equal(active.meeting.roomCreatedByBot, true);
    assert.match(active.meeting.roomChannelId, /^8\d{17}$/);
    const resource = f.db((db) =>
      db
        .prepare("SELECT * FROM resources WHERE key=?")
        .get(`preview.meeting.${created.meeting.id}`),
    );
    assert.equal(JSON.parse(resource.baseline).simulated, true);
    await f.data(
      "meetings.complete",
      { revision: active.meeting.revision },
      { objectId: created.meeting.id, requestId: "finish" },
    );
    await f.drain();
    const finished = await f.data("meetings.read", {}, { objectId: created.meeting.id });
    assert.equal(finished.meeting.state, "completed");
    assert.ok(!finished.allowedOperations.includes("meetings.join"));
    assert.equal(
      f.db(
        (db) =>
          JSON.parse(
            db.prepare("SELECT baseline FROM resources WHERE key=?").get(resource.key).baseline,
          ).cleaned,
      ),
      true,
    );
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private cases keep notes separate, use scoped local targets and preserve no-retention policy", async (t) => {
  const f = await fixture(t),
    created = await f.createCase();
  assert.equal(created.case.visibility, "private");
  assert.equal(
    (await f.data("cases.create", created.draft, { requestId: "create-case" })).case.id,
    created.case.id,
  );
  const replied = await f.data(
    "cases.reply",
    { revision: created.case.revision, content: "Odpowiedź autora" },
    { objectId: created.case.id, requestId: "reply" },
  );
  const noted = await f.data(
    "cases.note",
    { revision: replied.case.revision, content: "Notatka tylko dla obsługi" },
    { objectId: created.case.id, requestId: "note" },
  );
  assert.equal(noted.job, null);
  await f.data(
    "cases.note",
    { revision: replied.case.revision, content: "Notatka tylko dla obsługi" },
    { objectId: created.case.id, requestId: "note" },
  );
  const detail = await f.data("cases.read", {}, { objectId: created.case.id });
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].content, "Odpowiedź autora");
  assert.ok(!JSON.stringify(detail).includes("Notatka tylko dla obsługi"));
  const notes = await f.data("cases.notes", {}, { objectId: created.case.id });
  assert.equal(notes.notes.length, 1);
  assert.equal(notes.notes[0].content, "Notatka tylko dla obsługi");
  assert.deepEqual(detail.allowedStatuses, allowedCaseStatuses("report", detail.case.status));
  const assigned = await f.data(
    "cases.assign",
    { revision: detail.case.revision, assigneeId: previewActorId },
    { objectId: created.case.id, requestId: "assign" },
  );
  const closed = await f.data(
    "cases.transition",
    { revision: assigned.case.revision, status: "closed" },
    { objectId: created.case.id, requestId: "close" },
  );
  assert.equal(closed.case.retentionAt, null);
  await f.drain();
  const history = await f.data("cases.read", {}, { objectId: created.case.id });
  const resource = f.db((db) =>
    db
      .prepare("SELECT * FROM resources WHERE key=?")
      .get(`preview.case.private.${created.case.id}`),
  );
  const baseline = JSON.parse(resource.baseline);
  assert.equal(baseline.scope, createHash("sha256").update(f.scope).digest("hex"));
  assert.equal(baseline.visibility, "private");
  assert.equal(baseline.simulated, true);
  assert.ok(history.deliveries.every((delivery) => delivery.channelId === resource.id));
  assert.equal(history.deliveries.length, 4);
});

test("suggestion approval, reason policy and voting use current shared domain settings", async (t) => {
  const f = await fixture(t),
    settings = await f.data("settings.read");
  await f.data(
    "settings.save",
    {
      scope: "modules",
      settings: {
        ...settings.moduleSettings,
        cases: {
          ...settings.moduleSettings.cases,
          reasonRequiredStatuses: ["accepted", "rejected"],
        },
      },
    },
    { requestId: "reasons" },
  );
  const created = await f.createCase({ kind: "suggestion", title: "Nowy pomysł" });
  assert.equal(
    (
      await f.call(
        "cases.vote",
        { value: 1 },
        { objectId: created.case.id, requestId: "private-vote" },
      )
    ).status,
    409,
  );
  const approved = await f.data(
    "cases.approve",
    { revision: created.case.revision },
    { objectId: created.case.id, requestId: "approve" },
  );
  assert.equal(approved.case.visibility, "public");
  const voted = await f.data(
    "cases.vote",
    { value: 1 },
    { objectId: created.case.id, requestId: "vote" },
  );
  assert.equal(voted.votes.total, 1);
  assert.equal(voted.ownVote, 1);
  assert.deepEqual(
    await f.data("cases.vote", { value: 1 }, { objectId: created.case.id, requestId: "vote" }),
    voted,
  );
  const view = await f.data("cases.read", {}, { objectId: created.case.id });
  assert.equal(
    (
      await f.call(
        "cases.transition",
        { revision: view.case.revision, status: "accepted" },
        { objectId: created.case.id, requestId: "no-reason" },
      )
    ).status,
    400,
  );
  const accepted = await f.data(
    "cases.transition",
    { revision: view.case.revision, status: "accepted", reason: "Włączamy do projektu." },
    { objectId: created.case.id, requestId: "accepted" },
  );
  assert.equal(accepted.case.status, "accepted");
  assert.equal(
    (
      await f.call(
        "cases.vote",
        { value: null },
        { objectId: created.case.id, requestId: "closed-vote" },
      )
    ).status,
    409,
  );
  await f.drain();
  const history = await f.data("cases.read", {}, { objectId: created.case.id });
  assert.ok(
    history.deliveries.every(
      (delivery) => delivery.channelId === settings.moduleSettings.cases.suggestionChannelId,
    ),
  );
  assert.equal(history.deliveries.length, 2);
});

test("sessions and guilds cannot read, mutate, note or inspect each other's community objects", async (t) => {
  const f = await fixture(t),
    meeting = await f.meeting(),
    created = await f.createCase();
  for (const extra of [{ scope: token() }, { guildId: previewGuildIds[1] }]) {
    assert.deepEqual((await f.data("meetings.list", {}, extra)).meetings, []);
    assert.deepEqual((await f.data("cases.list", {}, extra)).cases, []);
    for (const operation of ["meetings.read", "meetings.cancel"])
      assert.equal(
        (
          await f.call(
            operation,
            { ...(operation.endsWith("cancel") ? { revision: 1 } : {}) },
            { ...extra, objectId: meeting.meeting.id, requestId: "cross-meeting" },
          )
        ).status,
        404,
      );
    for (const operation of ["cases.read", "cases.notes", "cases.note"])
      assert.equal(
        (
          await f.call(
            operation,
            operation === "cases.note" ? { revision: 1, content: "Nie wolno" } : {},
            { ...extra, objectId: created.case.id, requestId: "cross-case" },
          )
        ).status,
        404,
      );
    assert.equal(
      (await f.call("jobs.read", {}, { ...extra, objectId: created.job.id })).status,
      404,
    );
  }
  assert.equal((await f.call("meetings.list", {}, { actor: "100000000000000999" })).status, 401);
  assert.equal(
    (
      await f.call(
        "cases.assign",
        { revision: created.case.revision, assigneeId: "100000000000000999" },
        { objectId: created.case.id, requestId: "fake-staff" },
      )
    ).status,
    403,
  );
});

test("restart restores cases, notes, roster and pending local work without any network or raw-field leak", async (t) => {
  const f = await fixture(t),
    meeting = await f.meeting(),
    created = await f.createCase();
  await f.data("meetings.join", {}, { objectId: meeting.meeting.id, requestId: "join" });
  await f.data(
    "cases.note",
    { revision: created.case.revision, content: "Trwała notatka" },
    { objectId: created.case.id, requestId: "note" },
  );
  await f.restart();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw Error("Unexpected network");
  };
  try {
    await f.drain();
    const restored = await f.data("meetings.read", {}, { objectId: meeting.meeting.id });
    assert.equal(restored.participants[0].state, "confirmed");
    assert.equal(restored.meeting.state, "open");
    const detail = await f.data("cases.read", {}, { objectId: created.case.id });
    assert.equal(detail.jobs[0].state, "succeeded");
    assert.ok(!JSON.stringify(detail).includes("Trwała notatka"));
    assert.equal(
      (await f.data("cases.notes", {}, { objectId: created.case.id })).notes[0].content,
      "Trwała notatka",
    );
    assert.equal((await f.data("cases.list")).cases[0].content, undefined);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tampered local ACL or scope evidence cannot authorize a case notification", async (t) => {
  const f = await fixture(t),
    created = await f.createCase();
  f.db((db) => {
    const resource = db
      .prepare("SELECT * FROM resources WHERE key=?")
      .get(`preview.case.private.${created.case.id}`);
    const baseline = {
      ...JSON.parse(resource.baseline),
      scope: "0".repeat(64),
      visibility: "public",
    };
    db.prepare("UPDATE resources SET baseline=? WHERE key=?").run(
      JSON.stringify(baseline),
      resource.key,
    );
  });
  await f.drain();
  const detail = await f.data("cases.read", {}, { objectId: created.case.id });
  assert.equal(detail.jobs[0].state, "failed");
  assert.equal(detail.jobs[0].lastError, "acl_unconfirmed");
  assert.equal(detail.deliveries.length, 0);
});

test("module disables persist after restart and cancel only matching pending domain jobs", async (t) => {
  const f = await fixture(t),
    meeting = await f.meeting(),
    created = await f.createCase();
  const snapshot = await f.data("settings.read");
  await f.data(
    "settings.save",
    {
      scope: "modules",
      settings: {
        ...snapshot.moduleSettings,
        enabled: { ...snapshot.moduleSettings.enabled, meetings: false, cases: false },
      },
    },
    { requestId: "disable" },
  );
  await f.restart();
  const view = await f.data("capabilities.read");
  assert.equal(view.moduleSettings.enabled.meetings, false);
  assert.equal(view.moduleSettings.enabled.cases, false);
  assert.ok(!view.permissions.includes("meetings.create"));
  assert.ok(!view.permissions.includes("cases.create"));
  assert.equal(
    (await f.data("jobs.read", {}, { objectId: created.job.id })).job.state,
    "cancelled",
  );
  const jobs = await f.data("jobs.list", { meetingId: meeting.meeting.id });
  assert.ok(jobs.jobs.every((job) => job.state === "cancelled"));
  assert.equal(await f.worker().tick(), 0);
  const retention = await f.call(
    "settings.save",
    {
      scope: "modules",
      settings: {
        ...view.moduleSettings,
        cases: { ...view.moduleSettings.cases, retentionMs: 86400000 },
      },
    },
    { requestId: randomUUID() },
  );
  assert.equal(retention.status, 200);
  assert.equal((await f.data("settings.read")).moduleSettings.cases.retentionMs, 90 * 86400000);
});

test("community histories stay object- and module-scoped across jobs and deliveries endpoints", async (t) => {
  const f = await fixture(t),
    firstMeeting = await f.meeting(),
    secondMeeting = await f.meeting({}, { requestId: "second-meeting" });
  const firstCase = await f.createCase(),
    secondCase = await f.createCase({}, { requestId: "second-case" });
  await f.drain();
  for (const [selector, id, other] of [
    ["meetingId", firstMeeting.meeting.id, secondMeeting.meeting.id],
    ["caseId", firstCase.case.id, secondCase.case.id],
  ]) {
    const history = await f.data("jobs.list", { [selector]: id });
    assert.ok(history.jobs.length > 0);
    assert.ok(history.jobs.every((job) => job.objectId === id && job.objectId !== other));
    const deliveries = await f.data("deliveries.list", { [selector]: id });
    assert.ok(
      deliveries.deliveries.every((delivery) =>
        history.jobs.some((job) => job.id === delivery.jobId),
      ),
    );
    assert.equal(
      (await f.call("jobs.read", { [selector]: other }, { objectId: history.jobs[0].id })).status,
      404,
    );
  }
  assert.equal(
    (await f.call("jobs.read", { meetingId: firstCase.case.id }, { objectId: firstCase.job.id }))
      .status,
    404,
  );
});

test("rescheduling and cancellation invalidate prior generations before local workers can deliver", async (t) => {
  const f = await fixture(t),
    created = await f.meeting({ organizerParticipates: true });
  const initial = created.jobs.filter((job) => job.type === "meeting.reminder");
  assert.equal(initial.length, 2);
  const changed = await f.data(
    "meetings.update",
    {
      revision: created.meeting.revision,
      draft: { ...created.draft, startsAt: f.now() + 7200000, endsAt: f.now() + 10800000 },
    },
    { objectId: created.meeting.id, requestId: "reschedule" },
  );
  assert.equal(changed.meeting.generation, created.meeting.generation + 1);
  for (const job of initial)
    assert.equal(
      (await f.data("jobs.read", { meetingId: created.meeting.id }, { objectId: job.id })).job
        .state,
      "cancelled",
    );
  await f.data(
    "meetings.cancel",
    { revision: changed.meeting.revision },
    { objectId: created.meeting.id, requestId: "cancel" },
  );
  await f.restart();
  await f.drain();
  const detail = await f.data("meetings.read", {}, { objectId: created.meeting.id });
  assert.equal(detail.meeting.state, "cancelled");
  assert.ok(!detail.allowedOperations.includes("meetings.join"));
  assert.ok(
    detail.jobs
      .filter((job) => job.type === "meeting.reminder")
      .every((job) => job.state === "cancelled"),
  );
  assert.equal(
    (await f.call("meetings.join", {}, { objectId: created.meeting.id, requestId: "late-join" }))
      .status,
    403,
  );
});

test("foreign resource IDs are rejected before meetings or case configuration can persist", async (t) => {
  const f = await fixture(t),
    own = await f.data("settings.read"),
    other = await f.data("settings.read", {}, { guildId: previewGuildIds[1] });
  const created = await f.meeting();
  assert.equal(
    (
      await f.call(
        "meetings.create",
        { ...created.draft, channelId: other.resources.channels[0].id },
        { requestId: "foreign-meeting" },
      )
    ).status,
    403,
  );
  assert.equal((await f.data("meetings.list")).meetings.length, 1);
  assert.equal(
    (
      await f.call(
        "settings.save",
        {
          scope: "modules",
          settings: {
            ...own.moduleSettings,
            cases: {
              ...own.moduleSettings.cases,
              categoryId: other.moduleSettings.cases.categoryId,
            },
          },
        },
        { requestId: "foreign-cases" },
      )
    ).status,
    400,
  );
  assert.deepEqual((await f.data("settings.read")).moduleSettings, own.moduleSettings);
});

test("private preview invitations use the real audience mutation without inventing other members", async (t) => {
  const f = await fixture(t),
    created = await f.meeting({ visibility: "private", invitedUserIds: [previewActorId] });
  const changed = await f.data(
    "meetings.update",
    { revision: created.meeting.revision, audience: { invitedUserIds: [], allowedRoleIds: [] } },
    { objectId: created.meeting.id, requestId: "audience" },
  );
  assert.deepEqual(changed.meeting.invitedUserIds, []);
  await f.restart();
  assert.deepEqual(
    (await f.data("meetings.read", {}, { objectId: created.meeting.id })).meeting.invitedUserIds,
    [],
  );
  assert.equal(
    (
      await f.call(
        "meetings.create",
        { ...created.draft, invitedUserIds: ["900000000000000099"] },
        { requestId: "not-a-demo-person" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "meetings.update",
        {
          revision: changed.meeting.revision,
          audience: { invitedUserIds: [], allowedRoleIds: [] },
        },
        { objectId: created.meeting.id, requestId: "foreign-audience", scope: token() },
      )
    ).status,
    404,
  );
});
