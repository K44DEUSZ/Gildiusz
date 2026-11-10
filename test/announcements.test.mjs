import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Store } from "../dist/storage/store.js";
import { JobStore, JobError } from "../dist/core/jobs/store.js";
import { AnnouncementService, AnnouncementError } from "../dist/modules/announcements/service.js";
import {
  normalizeSchedule,
  nextOccurrences,
  resolveLocalDateTime,
} from "../dist/modules/announcements/schedule.js";

const guildId = "100000000000000001",
  actorId = "100000000000000002",
  otherActor = "100000000000000003",
  channelId = "100000000000000004",
  roleId = "100000000000000005";
const instant = (value) => Date.parse(value);
const code = (expected) => (error) => error instanceof AnnouncementError && error.code === expected;

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-announcements-")),
    path = join(directory, "guild.sqlite");
  let now = instant("2026-11-09T12:00:00Z"),
    policy = async () => {};
  const stores = [],
    requests = [];
  const open = () => {
    const store = new Store(path, guildId);
    const jobs = new JobStore(store.db, () => now);
    const service = new AnnouncementService(jobs, {
      ...options,
      guildId,
      clock: () => now,
      authorize: async (request) => {
        requests.push(request);
        await policy(request);
      },
    });
    stores.push(store);
    return { store, jobs, service };
  };
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* Restarted fixture. */
      }
    }
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-announcements-")
    )
      throw Error("Unexpected test directory.");
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...open(),
    open,
    requests,
    now: () => now,
    setNow: (value) => {
      now = value;
    },
    setPolicy: (value) => {
      policy = value;
    },
    draft: (extra = {}) => ({
      channelId,
      content: "Spotykamy się wieczorem.",
      schedule: { kind: "once", at: now + 60000 },
      ...extra,
    }),
  };
}

test("an incomplete durable draft never schedules work and can be completed after restart", async (t) => {
  const f = fixture(t),
    input = f.draft({ channelId: "", content: "", saveAsDraft: true }),
    saved = await f.service.create(actorId, "save-draft", input);
  assert.equal(saved.announcement.status, "draft");
  assert.equal(saved.job, null);
  assert.equal(f.jobs.list().length, 0);
  f.store.close();
  const restarted = f.open();
  const restored = await restarted.service.get(actorId, saved.announcement.id);
  assert.equal(restored.status, "draft");
  await assert.rejects(
    restarted.service.resume(actorId, "resume-empty", restored.id, restored.revision),
    code("invalid_input"),
  );
  assert.equal(restarted.jobs.list().length, 0);
  const draft = f.draft({
    content: "",
    card: { title: "Wieczorem", description: "Przegląd projektów.", color: 0x5865f2 },
    links: [{ label: "Szczegóły", url: "https://example.com/spotkanie" }],
  });
  const planned = await restarted.service.update(
    actorId,
    "publish-draft",
    restored.id,
    restored.revision,
    draft,
  );
  assert.equal(planned.announcement.status, "scheduled");
  assert.equal(planned.job.state, "pending");
  assert.deepEqual(planned.announcement.card, draft.card);
  assert.deepEqual(planned.announcement.links, draft.links);
  const replay = await restarted.service.update(
    actorId,
    "publish-draft",
    restored.id,
    restored.revision,
    draft,
  );
  assert.equal(replay.job.id, planned.job.id);
  assert.equal(restarted.jobs.list().length, 1);
});

test("card preview, persisted roundtrip and a no-ping test use the same presentation", async (t) => {
  const f = fixture(t),
    input = f.draft({
      content: "@everyone",
      roleIds: [roleId],
      mentionEveryone: true,
      card: { title: "Projekt", description: "Opis **projektu**.", color: 0xffaa00 },
      links: [{ label: "Zobacz", url: "https://example.com" }],
    }),
    preview = await f.service.previewMessage(actorId, input),
    saved = await f.service.create(actorId, "create-card", input),
    queued = await f.service.test(
      actorId,
      "test-card",
      saved.announcement.id,
      saved.announcement.revision,
    ),
    lease = f.jobs.claim({ types: ["announcement.send"] })[0],
    prepared = await f.service.prepare(lease);
  assert.equal(lease.id, queued.job.id);
  assert.deepEqual(preview.card, saved.announcement.card);
  assert.deepEqual(preview.links, [{ label: "Zobacz", url: "https://example.com/" }]);
  assert.deepEqual(prepared.card, preview.card);
  assert.deepEqual(prepared.links, preview.links);
  assert.deepEqual(prepared.roleIds, []);
  assert.equal(prepared.mentionEveryone, false);
  assert.match(prepared.content, /^Próba ogłoszenia/);
  assert.equal(saved.announcement.publishedCount, 0);
});

test("invalid cards, unsafe link schemes and image URLs cannot enter durable storage", async (t) => {
  const f = fixture(t);
  const invalid = [
    { content: "", links: [{ label: "Tylko link", url: "https://example.com" }] },
    { card: { title: "", description: "", color: 0 } },
    { card: { title: "x".repeat(257), description: "", color: 0 } },
    { card: { title: "Tytuł", description: "x".repeat(4097), color: 0 } },
    { card: { title: "Tytuł", description: "Opis", color: 0x1000000 } },
    {
      card: {
        title: "Tytuł",
        description: "Opis",
        color: 0,
        imageAssetId: "https://localhost/image.png",
      },
    },
    {
      card: {
        title: "Tytuł",
        description: "Opis",
        color: 0,
        imageURL: "https://example.com/a.png",
      },
    },
    { links: [{ label: "Otwórz", url: "javascript:alert(1)" }] },
    { links: [{ label: "Otwórz", url: "http://example.com" }] },
    { links: [{ label: "Otwórz", url: "https://u:p@example.com" }] },
    { links: [{ label: "Otwórz", url: "https://example.com/\n" }] },
    { links: Array.from({ length: 6 }, () => ({ label: "Otwórz", url: "https://example.com" })) },
  ];
  for (let i = 0; i < invalid.length; i++)
    await assert.rejects(
      f.service.create(actorId, `invalid-card-${i}`, f.draft(invalid[i])),
      code("invalid_input"),
    );
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM announcements").get().count, 0);
  assert.equal(f.jobs.list().length, 0);
});

test("image validation and synchronous binding failure roll back presentation, schedule and cancelled jobs", async (t) => {
  let rejectBinding = false;
  const assetId = "00000000-0000-4000-8000-000000000001",
    checked = [];
  const f = fixture(t, {
      validateAsset: async (id) => checked.push(id),
      onSaved: () => {
        if (rejectBinding) throw Error("asset_expired");
      },
    }),
    saved = await f.service.create(actorId, "create", f.draft()),
    input = f.draft({ card: { title: "Obraz", description: "", color: 0, imageAssetId: assetId } });
  rejectBinding = true;
  await assert.rejects(
    f.service.update(
      actorId,
      "edit-card",
      saved.announcement.id,
      saved.announcement.revision,
      input,
    ),
    /asset_expired/,
  );
  const current = await f.service.get(actorId, saved.announcement.id);
  assert.equal(current.revision, saved.announcement.revision);
  assert.equal(current.card, null);
  assert.equal(f.jobs.get(saved.job.id).state, "pending");
  rejectBinding = false;
  const updated = await f.service.update(actorId, "edit-card", current.id, current.revision, input);
  assert.equal(updated.announcement.card.imageAssetId, assetId);
  assert.equal(checked.length, 2);
  assert.equal(f.jobs.get(saved.job.id).state, "cancelled");
  assert.equal(
    f.store.db
      .prepare("SELECT presentation FROM announcements WHERE id=?")
      .get(current.id)
      .presentation.includes("data:"),
    false,
  );
});

test("card announcements keep uncertain delivery durable and do not schedule a backlog after restart", async (t) => {
  const f = fixture(t),
    input = f.draft({
      schedule: { kind: "now" },
      card: { title: "Ogłoszenie", description: "Treść.", color: 0 },
    }),
    saved = await f.service.create(actorId, "create", input),
    lease = f.jobs.claim()[0];
  f.jobs.beginAttempt(lease.id, lease.leaseToken, { channelId });
  f.jobs.unknown(lease.id, lease.leaseToken, "discord_delivery_unconfirmed");
  f.store.close();
  const restarted = f.open();
  f.setNow(f.now() + 3600000);
  const restored = await restarted.service.get(actorId, saved.announcement.id);
  assert.equal(restarted.jobs.get(saved.job.id).state, "unknown");
  assert.equal(restored.activeJobId, saved.job.id);
  assert.equal(restored.publishedCount, 0);
  assert.deepEqual(restored.card, input.card);
  assert.equal(restarted.jobs.claim().length, 0);
});

test("resuming a complete draft plans work, while cancelling a draft preserves its final status", async (t) => {
  const f = fixture(t),
    input = f.draft({
      saveAsDraft: true,
      content: "",
      card: { title: "Gotowe", description: "Opis.", color: 0 },
    }),
    first = await f.service.create(actorId, "draft-one", input);
  assert.equal(first.announcement.status, "draft");
  assert.equal(first.job, null);
  const resumed = await f.service.resume(
    actorId,
    "resume-draft",
    first.announcement.id,
    first.announcement.revision,
  );
  assert.equal(resumed.announcement.status, "scheduled");
  assert.equal(resumed.job.state, "pending");
  const second = await f.service.create(actorId, "draft-two", input),
    cancelled = await f.service.cancel(
      actorId,
      "cancel-draft",
      second.announcement.id,
      second.announcement.revision,
    );
  assert.equal(cancelled.announcement.status, "cancelled");
  assert.equal(cancelled.job, null);
  assert.equal((await f.service.get(actorId, second.announcement.id)).status, "cancelled");
});

test("legacy text-only records receive an empty presentation without changing their schedule", async (t) => {
  const f = fixture(t),
    saved = await f.service.create(actorId, "legacy", f.draft());
  f.store.db
    .prepare("UPDATE announcements SET presentation='{}' WHERE id=?")
    .run(saved.announcement.id);
  const current = await f.service.get(actorId, saved.announcement.id);
  assert.equal(current.card, null);
  assert.deepEqual(current.links, []);
  assert.deepEqual(current.schedule, saved.announcement.schedule);
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 2);
});

test("missing assets block publication while transient storage trouble stays retryable before an attempt", async (t) => {
  for (const reason of [
    "asset_not_found",
    "asset_expired",
    "invalid_asset",
    "asset_storage_unavailable",
    "asset_busy",
  ])
    await t.test(reason, async (t) => {
      let fail = false;
      const f = fixture(t, {
          validateAsset: async () => {
            if (fail) throw Object.assign(Error(reason), { code: reason });
          },
        }),
        saved = await f.service.create(
          actorId,
          "image",
          f.draft({
            schedule: { kind: "now" },
            card: {
              title: "Obraz",
              description: "",
              color: 0,
              imageAssetId: "00000000-0000-4000-8000-000000000001",
            },
          }),
        ),
        lease = f.jobs.claim()[0],
        permanent = ["asset_not_found", "asset_expired", "invalid_asset"].includes(reason);
      fail = true;
      await assert.rejects(
        f.service.prepare(lease),
        (error) => error.code === (permanent ? "asset_unavailable" : reason),
      );
      const current = await f.service.get(actorId, saved.announcement.id);
      assert.equal(current.status, permanent ? "blocked" : "scheduled");
      assert.equal(current.blockedReason, permanent ? "asset_unavailable" : null);
      assert.equal(f.jobs.attempts(lease.id).length, 0);
    });
});

test("an old validation callback cannot block the announcement owned by a newer lease", async (t) => {
  let fail = false,
    newer;
  const f = fixture(t, {
      validateAsset: async () => {
        if (fail) throw Object.assign(Error("gone"), { code: "asset_not_found" });
      },
    }),
    saved = await f.service.create(
      actorId,
      "image",
      f.draft({
        schedule: { kind: "now" },
        card: {
          title: "Obraz",
          description: "",
          color: 0,
          imageAssetId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    ),
    lease = f.jobs.claim({ leaseMs: 1 })[0];
  f.setPolicy(async (request) => {
    if (request.operation !== "deliver") return;
    f.setNow(f.now() + 2);
    f.jobs.recover();
    newer = f.jobs.claim()[0];
    fail = true;
  });
  await assert.rejects(f.service.prepare(lease), code("asset_unavailable"));
  assert.notEqual(newer.leaseToken, lease.leaseToken);
  assert.equal(f.jobs.get(lease.id).leaseToken, newer.leaseToken);
  assert.equal((await f.service.get(actorId, saved.announcement.id)).status, "scheduled");
});

test("five daily dates use the first valid spring instant, rather than shifting the missing minute", () => {
  const schedule = normalizeSchedule(
    { kind: "daily", time: "02:30", startDate: "2026-03-28" },
    instant("2026-03-27T00:00:00Z"),
  );
  const occurrences = nextOccurrences(schedule, instant("2026-03-27T23:00:00Z"));
  assert.equal(occurrences.length, 5);
  assert.deepEqual(
    occurrences.slice(0, 3).map((entry) => new Date(entry.at).toISOString()),
    ["2026-03-28T01:30:00.000Z", "2026-03-29T01:00:00.000Z", "2026-03-30T00:30:00.000Z"],
  );
  assert.equal(occurrences[1].localTime, "2026-03-29T03:00");
  assert.equal(occurrences[1].adjusted, true);
  assert.equal(occurrences[0].timeZone, "Europe/Warsaw");
});

test("autumn overlap runs the earlier occurrence exactly once", () => {
  const schedule = normalizeSchedule(
    { kind: "daily", time: "02:30", startDate: "2026-10-25" },
    instant("2026-10-24T00:00:00Z"),
  );
  const dates = nextOccurrences(schedule, instant("2026-10-24T23:00:00Z"));
  assert.equal(dates[0].at, instant("2026-10-25T00:30:00Z"));
  assert.equal(dates[1].at, instant("2026-10-26T01:30:00Z"));
  assert.equal(
    nextOccurrences(schedule, instant("2026-10-25T00:45:00Z"))[0].at,
    instant("2026-10-26T01:30:00Z"),
  );
  assert.equal(resolveLocalDateTime("2026-10-25", "02:30", "Europe/Warsaw").at, dates[0].at);
});

test("the same resolver supports non-hour gaps and an entirely skipped local date", () => {
  assert.equal(
    resolveLocalDateTime("2026-10-04", "02:15", "Australia/Lord_Howe").localTime,
    "2026-10-04T02:30",
  );
  const skipped = resolveLocalDateTime("2011-12-30", "12:00", "Pacific/Apia");
  assert.equal(skipped.localTime, "2011-12-31T00:00");
  assert.equal(skipped.adjusted, true);
  const schedule = normalizeSchedule(
    { kind: "daily", time: "00:00", timeZone: "Pacific/Apia", startDate: "2011-12-30" },
    instant("2011-12-29T00:00:00Z"),
  );
  const dates = nextOccurrences(schedule, instant("2011-12-29T23:00:00Z"));
  assert.equal(new Set(dates.map((entry) => entry.at)).size, 5);
});

test("weekly dates respect ISO weekdays, local date bounds and the requested maximum", () => {
  const schedule = normalizeSchedule(
    {
      kind: "weekly",
      time: "18:00",
      weekdays: [5, 1],
      timeZone: "Europe/Warsaw",
      startDate: "2026-11-09",
      endDate: "2026-11-20",
      maxOccurrences: 3,
    },
    instant("2026-11-09T00:00:00Z"),
  );
  const dates = nextOccurrences(schedule, instant("2026-11-09T00:00:00Z"));
  assert.deepEqual(
    dates.map((entry) => entry.localDate),
    ["2026-11-09", "2026-11-13", "2026-11-16"],
  );
  assert.deepEqual(schedule.weekdays, [1, 5]);
  assert.deepEqual(nextOccurrences(schedule, instant("2026-11-21T00:00:00Z")), []);
});

test("invalid calendar definitions and unknown fields are rejected before scheduling", () => {
  const now = instant("2026-11-09T00:00:00Z");
  for (const schedule of [
    { kind: "daily", time: "24:00" },
    { kind: "daily", time: "02:30", timeZone: "+01:00" },
    { kind: "daily", time: "12:00", timeZone: "Unknown/Timezone" },
    { kind: "daily", time: "12:00", startDate: "2026-02-30" },
    { kind: "weekly", time: "12:00", weekdays: [1, 1] },
    { kind: "weekly", time: "12:00", weekdays: [0] },
    { kind: "daily", time: "12:00", startDate: "2026-11-20", endDate: "2026-11-19" },
    { kind: "daily", time: "12:00", cron: "* * * * *" },
    { kind: "once", at: Number.NaN },
    { kind: "once", at: now, unknown: true },
  ])
    assert.throws(() => normalizeSchedule(schedule, now), code("invalid_input"));
});

test("send-now resolves only after asynchronous authorization and replays a stable marker", async (t) => {
  const f = fixture(t);
  const requestedAt = f.now(),
    input = f.draft({ schedule: { kind: "now" } });
  f.setPolicy(async (request) => {
    if (request.operation === "create") {
      await Promise.resolve();
      f.setNow(f.now() + 500);
    }
  });
  const created = await f.service.create(actorId, "send-now", input);
  assert.deepEqual(created.announcement.schedule, { kind: "once", at: requestedAt + 500 });
  assert.equal(created.job.dueAt, requestedAt + 500);
  assert.equal(created.job.createdAt, requestedAt + 500);
  assert.equal(created.job.expiresAt, requestedAt + 500 + 600000);
  assert.equal(f.jobs.claim().length, 1);
  f.setNow(f.now() + 60000);
  assert.deepEqual(await f.service.create(actorId, "send-now", input), created);
  assert.equal(f.jobs.list().length, 1);
  await assert.rejects(
    f.service.create(actorId, "send-now", { ...input, content: "Inna treść" }),
    (error) => error instanceof JobError && error.code === "idempotency_conflict",
  );
});

test("send-now survives restart, is claimed within ten minutes and expires at its exact deadline", async (t) => {
  const f = fixture(t);
  const input = f.draft({ schedule: { kind: "now" } });
  const first = await f.service.create(actorId, "send-first", input);
  const expiring = await f.service.create(actorId, "send-expiring", input);
  f.store.close();
  const reopened = f.open();
  f.setNow(first.job.dueAt + 600000 - 1);
  const leases = reopened.jobs.claim();
  assert.equal(leases.length, 2);
  const lease = leases.find((job) => job.id === first.job.id);
  await reopened.service.prepare(lease);
  reopened.jobs.complete(lease.id, lease.leaseToken, { messageId: "delivered-within-grace" });
  const due = leases.find((job) => job.id === expiring.job.id);
  f.setNow(first.job.dueAt + 600000);
  await assert.rejects(reopened.service.prepare(due), code("expired"));
  reopened.jobs.expire(due.id, due.leaseToken, "deadline");
  reopened.service.sync();
  assert.equal((await reopened.service.get(actorId, first.announcement.id)).status, "completed");
  assert.equal((await reopened.service.get(actorId, expiring.announcement.id)).status, "expired");
  assert.deepEqual(await reopened.service.create(actorId, "send-first", input), first);
  assert.equal(reopened.jobs.list().length, 2);
});

test("send-now tolerates milliseconds spent inside the commit without padding a future date", async (t) => {
  const f = fixture(t);
  let now = f.now(),
    calls = 0;
  const service = new AnnouncementService(f.jobs, {
    guildId,
    clock: () => now + calls++,
    authorize: async () => {},
  });
  const saved = await service.create(
    actorId,
    "clock-ticks",
    f.draft({ schedule: { kind: "now" } }),
  );
  assert.equal(saved.job.dueAt, saved.announcement.createdAt);
  assert.ok(saved.job.dueAt < now + calls);
  assert.equal(saved.job.expiresAt, saved.job.dueAt + 600000);
  assert.equal(normalizeSchedule({ kind: "now" }, now).at, now);
  await assert.rejects(
    service.update(
      actorId,
      "edit-now",
      saved.announcement.id,
      1,
      f.draft({ schedule: { kind: "now" } }),
    ),
    code("invalid_input"),
  );
  assert.throws(() => normalizeSchedule({ kind: "now", at: now }, now), code("invalid_input"));
});

test("creating a rule and its queued publication is atomic, durable and replayable", async (t) => {
  const f = fixture(t);
  const input = f.draft({ roleIds: [roleId] });
  const first = await f.service.create(actorId, "create", input);
  assert.equal(first.announcement.revision, 1);
  assert.equal(first.job.objectId, first.announcement.id);
  assert.deepEqual(first.job.payload, { announcementId: first.announcement.id, generation: 1 });
  assert.equal(first.job.expiresAt, first.job.dueAt + 600000);
  assert.deepEqual(await f.service.create(actorId, "create", input), first);
  await assert.rejects(
    f.service.create(actorId, "create", { ...input, content: "Inny tekst" }),
    (error) => error instanceof JobError && error.code === "idempotency_conflict",
  );
  f.store.close();
  const next = f.open();
  assert.equal((await next.service.get(actorId, first.announcement.id)).activeJobId, first.job.id);
  assert.equal(next.jobs.list().length, 1);
});

test("creation limits roll back the rule, queue and request record together", async (t) => {
  const f = fixture(t, { maxAnnouncements: 1 });
  const first = await f.service.create(actorId, "first", f.draft());
  await assert.rejects(f.service.create(actorId, "second", f.draft()), code("limit_exceeded"));
  assert.equal((await f.service.list(actorId)).length, 1);
  assert.equal(f.jobs.list().length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get().count, 1);
  assert.equal(
    (await f.service.cancel(actorId, "cancel", first.announcement.id, 1)).announcement.status,
    "cancelled",
  );
  assert.ok(await f.service.create(actorId, "second", f.draft()));
});

test("updates reject stale revisions and invalidate the prior generation without partial edits", async (t) => {
  const f = fixture(t);
  const original = await f.service.create(actorId, "create", f.draft());
  const update = f.draft({
    content: "Nowy termin",
    schedule: { kind: "once", at: f.now() + 120000 },
  });
  const changed = await f.service.update(actorId, "update", original.announcement.id, 1, update);
  assert.equal(changed.announcement.revision, 2);
  assert.equal(changed.announcement.generation, 2);
  assert.equal(f.jobs.get(original.job.id).state, "cancelled");
  assert.equal(changed.job.dueAt, f.now() + 120000);
  assert.deepEqual(
    await f.service.update(actorId, "update", original.announcement.id, 1, update),
    changed,
  );
  await assert.rejects(
    f.service.update(actorId, "stale", original.announcement.id, 1, f.draft()),
    code("revision_conflict"),
  );
  assert.equal(f.jobs.list().length, 2);
});

test("selected mentions require explicit authorization and the execution rechecks current authority", async (t) => {
  const f = fixture(t);
  f.setPolicy((request) => {
    if (request.mentionEveryone) throw new AnnouncementError("permission_revoked");
  });
  await assert.rejects(
    f.service.create(actorId, "everyone", f.draft({ mentionEveryone: true })),
    code("permission_revoked"),
  );
  assert.equal(f.jobs.list().length, 0);
  const saved = await f.service.create(
    actorId,
    "role",
    f.draft({ roleIds: [roleId], schedule: { kind: "once", at: f.now() } }),
  );
  const [lease] = f.jobs.claim();
  const prepared = await f.service.prepare(lease);
  assert.equal(prepared.content, `<@&${roleId}>\nSpotykamy się wieczorem.`);
  assert.deepEqual(prepared.roleIds, [roleId]);
  f.setPolicy(() => {
    throw new AnnouncementError("permission_revoked");
  });
  await assert.rejects(f.service.prepare(lease), code("permission_revoked"));
  assert.equal(
    f.store.db.prepare("SELECT status FROM announcements WHERE id=?").get(saved.announcement.id)
      .status,
    "blocked",
  );
});

test("test publications recheck their requester and never mention configured recipients", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "create",
    f.draft({
      roleIds: [roleId],
      mentionEveryone: true,
      content: "@everyone oraz <@&100000000000000005>",
    }),
  );
  const queued = await f.service.test(otherActor, "test", saved.announcement.id, 1);
  assert.equal(queued.job.payload.actorId, otherActor);
  const [lease] = f.jobs.claim();
  const prepared = await f.service.prepare(lease);
  assert.equal(prepared.test, true);
  assert.match(prepared.content, /^Próba ogłoszenia\n\n/);
  assert.deepEqual(prepared.roleIds, []);
  assert.equal(prepared.mentionEveryone, false);
  assert.equal(f.requests.at(-1).actorId, otherActor);
  assert.deepEqual(f.requests.at(-1).roleIds, []);
  f.jobs.complete(lease.id, lease.leaseToken, { messageId: "test-message" });
  f.service.sync();
  assert.equal((await f.service.get(actorId, saved.announcement.id)).publishedCount, 0);
});

test("test request replay does not consume another rate slot", async (t) => {
  const f = fixture(t, { maxTestsPerMinute: 1 });
  const saved = await f.service.create(actorId, "create", f.draft());
  const first = await f.service.test(actorId, "test-one", saved.announcement.id);
  assert.deepEqual(await f.service.test(actorId, "test-one", saved.announcement.id), first);
  await assert.rejects(
    f.service.test(actorId, "test-two", saved.announcement.id),
    code("limit_exceeded"),
  );
  f.setNow(f.now() + 60000);
  assert.ok(await f.service.test(actorId, "test-two", saved.announcement.id));
});

test("pausing cancels pending work and resuming skips every occurrence missed while paused", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "create",
    f.draft({ schedule: { kind: "daily", time: "18:00" } }),
  );
  const paused = await f.service.pause(actorId, "pause", saved.announcement.id, 1);
  assert.equal(paused.announcement.status, "paused");
  assert.equal(f.jobs.get(saved.job.id).state, "cancelled");
  f.setNow(instant("2026-11-20T17:05:00Z"));
  const resumed = await f.service.resume(
    otherActor,
    "resume",
    saved.announcement.id,
    paused.announcement.revision,
  );
  assert.equal(resumed.announcement.actorId, otherActor);
  assert.equal(resumed.job.dueAt, instant("2026-11-21T17:00:00Z"));
  assert.equal(resumed.job.generation, 3);
});

test("cancelling an in-flight send preserves the late successful publication in history", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "create",
    f.draft({ schedule: { kind: "once", at: f.now() } }),
  );
  const [lease] = f.jobs.claim();
  f.jobs.beginAttempt(lease.id, lease.leaseToken);
  const cancelled = await f.service.cancel(actorId, "cancel", saved.announcement.id, 1);
  assert.equal(cancelled.announcement.status, "cancelled");
  assert.equal(f.jobs.get(lease.id).cancelRequested, true);
  f.jobs.complete(lease.id, lease.leaseToken, { messageId: "sent-after-cancel" });
  f.service.sync();
  const current = await f.service.get(actorId, saved.announcement.id);
  assert.equal(current.status, "cancelled");
  assert.equal(current.lastMessageId, "sent-after-cancel");
  assert.equal(current.publishedCount, 1);
  assert.equal(current.activeJobId, null);
  assert.equal(f.service.sync(), 0);
});

test("a long outage schedules only the latest still-valid cycle and then returns to the calendar", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "create",
    f.draft({ schedule: { kind: "daily", time: "18:00" } }),
  );
  f.setNow(instant("2026-11-20T17:05:00Z"));
  f.service.sync();
  const [lease] = f.jobs.claim();
  assert.equal(lease.dueAt, instant("2026-11-20T17:00:00Z"));
  assert.equal(f.jobs.list().length, 2);
  assert.equal(f.jobs.get(saved.job.id).state, "expired");
  f.jobs.complete(lease.id, lease.leaseToken, { messageId: "catch-up" });
  f.service.sync();
  const next = await f.service.get(actorId, saved.announcement.id);
  assert.equal(next.nextDueAt, instant("2026-11-21T17:00:00Z"));
  assert.equal(next.publishedCount, 1);
  assert.equal(f.jobs.list().length, 3);
  assert.equal(f.service.sync(), 0);
});

test("missed one-time messages expire and overdue cycles outside grace go to the future", async (t) => {
  const f = fixture(t);
  const once = await f.service.create(actorId, "once", f.draft());
  const daily = await f.service.create(
    actorId,
    "daily",
    f.draft({ schedule: { kind: "daily", time: "18:00" } }),
  );
  f.setNow(instant("2026-11-20T17:15:00Z"));
  f.service.sync();
  assert.equal((await f.service.get(actorId, once.announcement.id)).status, "expired");
  assert.equal(
    (await f.service.get(actorId, daily.announcement.id)).nextDueAt,
    instant("2026-11-21T17:00:00Z"),
  );
  assert.deepEqual(f.jobs.claim(), []);
});

test("a crash after recording delivery but before updating the rule is repaired on reopen", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "daily",
    f.draft({ schedule: { kind: "daily", time: "13:00" } }),
  );
  const [lease] = f.jobs.claim();
  f.jobs.beginAttempt(lease.id, lease.leaseToken);
  f.jobs.complete(lease.id, lease.leaseToken, { messageId: "confirmed-before-crash" });
  f.store.close();
  const next = f.open();
  next.service.sync();
  const current = await next.service.get(actorId, saved.announcement.id);
  assert.equal(current.publishedCount, 1);
  assert.equal(current.lastMessageId, "confirmed-before-crash");
  assert.equal(current.nextDueAt, instant("2026-11-10T12:00:00Z"));
  assert.equal(next.service.sync(), 0);
  assert.equal((await next.service.get(actorId, saved.announcement.id)).publishedCount, 1);
});

test("an uncertain publication blocks automatic advancement until its result is reconciled", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "daily",
    f.draft({ schedule: { kind: "daily", time: "13:00" } }),
  );
  const [lease] = f.jobs.claim({ leaseMs: 100 });
  f.jobs.beginAttempt(lease.id, lease.leaseToken);
  f.setNow(instant("2026-11-20T18:00:00Z"));
  f.service.sync();
  assert.equal(f.jobs.get(lease.id).state, "unknown");
  assert.equal((await f.service.get(actorId, saved.announcement.id)).activeJobId, lease.id);
  assert.equal(f.jobs.list().length, 1);
  const unknown = f.jobs.get(lease.id);
  f.jobs.reconcile(lease.id, unknown.revision, { outcome: "succeeded", messageId: "reconciled" });
  f.service.sync();
  assert.equal(
    (await f.service.get(actorId, saved.announcement.id)).nextDueAt,
    instant("2026-11-21T12:00:00Z"),
  );
});

test("publication count stops a cycle and test messages do not count toward that limit", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "daily",
    f.draft({ schedule: { kind: "daily", time: "13:00", maxOccurrences: 2 } }),
  );
  await f.service.test(actorId, "test", saved.announcement.id);
  for (const lease of f.jobs.claim())
    f.jobs.complete(lease.id, lease.leaseToken, {
      messageId: lease.payload.test ? "test" : "first",
    });
  f.service.sync();
  assert.equal((await f.service.get(actorId, saved.announcement.id)).publishedCount, 1);
  f.setNow(instant("2026-11-10T12:00:00Z"));
  const [lease] = f.jobs.claim();
  f.jobs.complete(lease.id, lease.leaseToken, { messageId: "second" });
  f.service.sync();
  const current = await f.service.get(actorId, saved.announcement.id);
  assert.equal(current.publishedCount, 2);
  assert.equal(current.status, "completed");
  assert.equal(current.activeJobId, null);
  assert.deepEqual(f.jobs.claim(), []);
});

test("a late old-generation receipt stops a newly planned job when the count is reached", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "daily",
    f.draft({ schedule: { kind: "daily", time: "13:00", maxOccurrences: 1 } }),
  );
  const [lease] = f.jobs.claim();
  f.jobs.beginAttempt(lease.id, lease.leaseToken);
  const edited = await f.service.update(
    actorId,
    "update",
    saved.announcement.id,
    1,
    f.draft({ schedule: { kind: "daily", time: "14:00", maxOccurrences: 1 } }),
  );
  f.jobs.complete(lease.id, lease.leaseToken, { messageId: "late" });
  f.service.sync();
  assert.equal(f.jobs.get(edited.job.id).state, "cancelled");
  assert.equal((await f.service.get(actorId, saved.announcement.id)).status, "completed");
});

test("generation changes during authorization cannot publish old content or block the new rule", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "once",
    f.draft({ schedule: { kind: "once", at: f.now() } }),
  );
  const [lease] = f.jobs.claim();
  f.setPolicy(async (request) => {
    if (request.operation === "deliver") {
      await f.service.update(
        actorId,
        "edit-during-check",
        saved.announcement.id,
        1,
        f.draft({ content: "Nowsze ogłoszenie" }),
      );
    }
  });
  await assert.rejects(f.service.prepare(lease), code("stale_generation"));
  assert.equal((await f.service.get(actorId, saved.announcement.id)).content, "Nowsze ogłoszenie");
  assert.equal((await f.service.get(actorId, saved.announcement.id)).status, "scheduled");
});

test("transient authorization lookup errors do not permanently block a scheduled rule", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "once",
    f.draft({ schedule: { kind: "once", at: f.now() } }),
  );
  const [lease] = f.jobs.claim();
  f.setPolicy((request) => {
    if (request.operation === "deliver") throw Error("temporary lookup failure");
  });
  await assert.rejects(f.service.prepare(lease), /temporary lookup failure/);
  assert.equal((await f.service.get(actorId, saved.announcement.id)).status, "scheduled");
});

test("a removed publication channel blocks the rule without creating a delivery attempt", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "once",
    f.draft({ schedule: { kind: "once", at: f.now() } }),
  );
  const [lease] = f.jobs.claim();
  f.setPolicy((request) => {
    if (request.operation === "deliver") throw new AnnouncementError("channel_unavailable");
  });
  await assert.rejects(f.service.prepare(lease), code("channel_unavailable"));
  const blocked = await f.service.get(actorId, saved.announcement.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedReason, "channel_unavailable");
  assert.deepEqual(f.jobs.attempts(lease.id), []);
  f.setPolicy((request) => {
    if (request.channelId) throw new AnnouncementError("channel_unavailable");
  });
  const cancelled = await f.service.cancel(
    actorId,
    "cancel",
    saved.announcement.id,
    blocked.revision,
  );
  assert.equal(cancelled.announcement.status, "cancelled");
});

test("write throttling is durable, rolls back changes and permits an idempotent retry", async (t) => {
  const f = fixture(t, { maxWritesPerMinute: 1 });
  const saved = await f.service.create(actorId, "once", f.draft());
  const reopened = f.open();
  await assert.rejects(
    reopened.service.update(
      actorId,
      "update",
      saved.announcement.id,
      1,
      f.draft({ content: "Nowa treść" }),
    ),
    code("limit_exceeded"),
  );
  assert.equal((await f.service.get(actorId, saved.announcement.id)).revision, 1);
  assert.equal(f.jobs.list().length, 1);
  assert.deepEqual(await reopened.service.create(actorId, "once", f.draft()), saved);
  f.setNow(f.now() + 60000);
  const updated = await reopened.service.update(
    actorId,
    "update",
    saved.announcement.id,
    1,
    f.draft({ content: "Nowa treść" }),
  );
  assert.equal(updated.announcement.content, "Nowa treść");
  assert.equal(updated.announcement.revision, 2);
});

test("foreign server objects and cancelled queue entries cannot be prepared", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    actorId,
    "once",
    f.draft({ schedule: { kind: "once", at: f.now() } }),
  );
  const other = new AnnouncementService(f.jobs, {
    guildId: "100000000000000009",
    clock: f.now,
    authorize: () => {},
  });
  await assert.rejects(other.get(actorId, saved.announcement.id), code("not_found"));
  const [lease] = f.jobs.claim();
  f.jobs.cancel(lease.id);
  await assert.rejects(f.service.prepare(lease), code("cancelled"));
});

test("invalid content and unsafe mention combinations do not leave partial jobs", async (t) => {
  const f = fixture(t);
  for (const data of [
    f.draft({ content: " " }),
    f.draft({ content: "x".repeat(2001) }),
    f.draft({ roleIds: [roleId, roleId] }),
    f.draft({ channelId: "other/channel" }),
    f.draft({ content: "x".repeat(2000), roleIds: [roleId] }),
  ])
    await assert.rejects(f.service.create(actorId, "invalid", data), code("invalid_input"));
  assert.equal(f.jobs.list().length, 0);
  const saved = await f.service.create(actorId, "valid", f.draft({ content: "x".repeat(2000) }));
  await f.service.test(actorId, "test", saved.announcement.id);
  const [lease] = f.jobs.claim();
  const prepared = await f.service.prepare(lease);
  assert.ok(prepared.content.length <= 2000);
  assert.ok(prepared.content.endsWith("…"));
});

test("explicit removal hides and scrubs a draft with durable exact replay after restart", async (t) => {
  const f = fixture(t),
    input = f.draft({ saveAsDraft: true }),
    saved = await f.service.create(actorId, "create", input);
  const outcome = await f.service.remove(
    actorId,
    "remove",
    saved.announcement.id,
    saved.announcement.revision,
  );
  assert.deepEqual(outcome, {
    removed: true,
    announcementId: saved.announcement.id,
    revision: saved.announcement.revision + 1,
  });
  assert.deepEqual(await f.service.list(actorId), []);
  await assert.rejects(f.service.create(actorId, "create", input), code("not_found"));
  await assert.rejects(f.service.get(actorId, saved.announcement.id), code("not_found"));
  const row = f.store.db
    .prepare("SELECT content,channel_id,presentation,removed_at FROM announcements WHERE id=?")
    .get(saved.announcement.id);
  assert.equal(row.content, "");
  assert.equal(row.channel_id, "");
  assert.deepEqual(JSON.parse(row.presentation), { card: null, links: [] });
  assert.equal(row.removed_at, f.now());
  const restarted = f.open();
  assert.deepEqual(
    await restarted.service.remove(
      actorId,
      "remove",
      saved.announcement.id,
      saved.announcement.revision,
    ),
    outcome,
  );
  await assert.rejects(
    restarted.service.remove(actorId, "another-remove", saved.announcement.id, outcome.revision),
    code("not_found"),
  );
  await assert.rejects(
    restarted.service.remove(actorId, "remove", saved.announcement.id, outcome.revision),
    (error) => error instanceof JobError && error.code === "idempotency_conflict",
  );
  assert.equal(
    f.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE version=10 AND name='announcement-removal'",
      )
      .get().n,
    1,
  );
});

test("remove CAS and current authorization fail without cancelling work or consuming the request", async (t) => {
  const f = fixture(t),
    saved = await f.service.create(actorId, "create", f.draft());
  await assert.rejects(
    f.service.remove(actorId, "stale", saved.announcement.id, saved.announcement.revision + 1),
    code("revision_conflict"),
  );
  assert.equal(f.jobs.get(saved.job.id).state, "pending");
  f.setPolicy((request) => {
    if (request.operation === "remove") throw new AnnouncementError("permission_revoked");
  });
  await assert.rejects(
    f.service.remove(actorId, "denied", saved.announcement.id, saved.announcement.revision),
    code("permission_revoked"),
  );
  assert.equal(
    (await f.service.get(actorId, saved.announcement.id)).content,
    saved.announcement.content,
  );
  f.setPolicy(() => {});
  await f.service.remove(actorId, "allowed", saved.announcement.id, saved.announcement.revision);
  f.setPolicy(() => {
    throw new AnnouncementError("permission_revoked");
  });
  await assert.rejects(
    f.service.remove(actorId, "allowed", saved.announcement.id, saved.announcement.revision),
    code("permission_revoked"),
  );
});

test("remove cancels pending sends across generations and preserves uncertain delivery evidence", async (t) => {
  const f = fixture(t),
    saved = await f.service.create(actorId, "create", f.draft());
  f.setNow(saved.job.dueAt);
  const [old] = f.jobs.claim();
  f.jobs.beginAttempt(old.id, old.leaseToken, { channelId, nonce: "uncertain-send" });
  const changed = await f.service.update(
    actorId,
    "update",
    saved.announcement.id,
    saved.announcement.revision,
    f.draft(),
  );
  const orphan = f.jobs.enqueue({
    guildId,
    type: "announcement.send",
    objectId: saved.announcement.id,
    generation: 0,
    dueAt: f.now() + 60000,
    dedupeKey: "legacy-pending",
    payload: { announcementId: saved.announcement.id, generation: 0 },
  });
  await f.service.remove(actorId, "remove", saved.announcement.id, changed.announcement.revision);
  assert.equal(f.jobs.get(changed.job.id).state, "cancelled");
  assert.equal(f.jobs.get(orphan.id).state, "cancelled");
  assert.equal(f.jobs.get(old.id).state, "running");
  assert.equal(f.jobs.get(old.id).cancelRequested, true);
  assert.equal(f.jobs.attempts(old.id)[0].state, "sending");
  await assert.rejects(
    f.service.prepare(old),
    (error) =>
      error instanceof AnnouncementError &&
      ["expired", "cancelled", "stale_generation"].includes(error.code),
  );
  f.setNow(f.now() + 60000);
  f.service.sync();
  assert.equal(f.jobs.get(old.id).state, "unknown");
  assert.equal(f.jobs.attempts(old.id)[0].state, "unknown");
  assert.deepEqual(await f.service.list(actorId), []);
});

test("a remove authorization gap cannot overwrite a concurrent edit on a second SQLite connection", async (t) => {
  const f = fixture(t),
    saved = await f.service.create(actorId, "create", f.draft());
  let changed = false;
  f.setPolicy(async (request) => {
    assert.equal(f.store.db.isTransaction, false);
    if (request.operation === "remove" && !changed) {
      changed = true;
      await f
        .open()
        .service.update(
          actorId,
          "concurrent",
          saved.announcement.id,
          saved.announcement.revision,
          f.draft({ content: "Nowsza treść" }),
        );
    }
  });
  await assert.rejects(
    f.service.remove(actorId, "remove", saved.announcement.id, saved.announcement.revision),
    code("revision_conflict"),
  );
  assert.equal((await f.service.get(actorId, saved.announcement.id)).content, "Nowsza treść");
});

test("failed removal hooks roll back tombstone, cancellations and idempotency atomically", async (t) => {
  const f = fixture(t, {
      onSaved(value) {
        if (!value.content) throw Error("asset hook unavailable");
      },
    }),
    saved = await f.service.create(actorId, "create", f.draft());
  await assert.rejects(
    f.service.remove(actorId, "remove", saved.announcement.id, saved.announcement.revision),
    /asset hook unavailable/,
  );
  assert.equal(
    (await f.service.get(actorId, saved.announcement.id)).content,
    saved.announcement.content,
  );
  assert.equal(f.jobs.get(saved.job.id).state, "pending");
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE request_id='remove'").get()
      .n,
    0,
  );
});

test("late positive receipts remain recorded after removal without reactivating publication", async (t) => {
  const f = fixture(t),
    saved = await f.service.create(actorId, "create", f.draft());
  f.setNow(saved.job.dueAt);
  const [lease] = f.jobs.claim();
  f.jobs.beginAttempt(lease.id, lease.leaseToken, { channelId, nonce: "late" });
  const removed = await f.service.remove(
    actorId,
    "remove",
    saved.announcement.id,
    saved.announcement.revision,
  );
  f.jobs.recordReceipt(lease.id, lease.leaseToken, { messageId: "900000000000000001" });
  assert.equal(f.jobs.attempts(lease.id)[0].state, "succeeded");
  f.service.sync();
  f.service.sync();
  const row = f.store.db
    .prepare("SELECT revision,removed_at,status FROM announcements WHERE id=?")
    .get(saved.announcement.id);
  assert.equal(row.revision, removed.revision);
  assert.equal(row.status, "cancelled");
  assert.notEqual(row.removed_at, null);
  assert.equal(
    f.store.db
      .prepare("SELECT active_job_id FROM schedules WHERE announcement_id=?")
      .get(saved.announcement.id).active_job_id,
    null,
  );
  assert.deepEqual(await f.service.list(actorId), []);
});

test("cached edit and transition replies cannot reveal a removed announcement", async (t) => {
  const f = fixture(t),
    created = await f.service.create(actorId, "create", f.draft()),
    input = f.draft({ content: "Poufna zmiana" });
  const changed = await f.service.update(
    actorId,
    "edit",
    created.announcement.id,
    created.announcement.revision,
    input,
  );
  const paused = await f.service.pause(
    actorId,
    "pause",
    created.announcement.id,
    changed.announcement.revision,
  );
  const resumed = await f.service.resume(
    actorId,
    "resume",
    created.announcement.id,
    paused.announcement.revision,
  );
  await f.service.remove(actorId, "remove", created.announcement.id, resumed.announcement.revision);
  await assert.rejects(
    f.service.update(
      actorId,
      "edit",
      created.announcement.id,
      created.announcement.revision,
      input,
    ),
    code("not_found"),
  );
  await assert.rejects(
    f.service.pause(actorId, "pause", created.announcement.id, changed.announcement.revision),
    code("not_found"),
  );
  await assert.rejects(
    f.service.resume(actorId, "resume", created.announcement.id, paused.announcement.revision),
    code("not_found"),
  );
});

test("remove scrubs historical create, update and test bodies without changing receipt identity or other rules", async (t) => {
  const f = fixture(t),
    input = f.draft({
      content: "SECRET_CREATE",
      card: { title: "SECRET_TITLE", description: "SECRET_DESCRIPTION", color: 42 },
      links: [{ label: "SECRET_LABEL", url: "https://example.com/private" }],
    });
  const created = await f.service.create(actorId, "scrub-create", input);
  const other = await f.service.create(actorId, "keep-create", f.draft({ content: "KEEP_OTHER" }));
  const changed = await f.service.update(
    actorId,
    "scrub-update",
    created.announcement.id,
    created.announcement.revision,
    { ...input, content: "SECRET_UPDATE" },
  );
  await f.service.test(
    actorId,
    "scrub-test",
    created.announcement.id,
    changed.announcement.revision,
  );
  const before = f.store.db
    .prepare(
      "SELECT * FROM idempotency_keys WHERE json_extract(result,'$.announcement.id')=? ORDER BY request_id",
    )
    .all(created.announcement.id);
  const untouched = f.store.db
    .prepare("SELECT * FROM idempotency_keys WHERE request_id='keep-create'")
    .get();
  assert.equal(before.length, 3);
  const removed = await f.service.remove(
    actorId,
    "scrub-remove",
    created.announcement.id,
    changed.announcement.revision,
  );
  for (const receipt of before) {
    const current = f.store.db
      .prepare("SELECT * FROM idempotency_keys WHERE scope=? AND request_id=?")
      .get(receipt.scope, receipt.request_id);
    assert.equal(current.scope, receipt.scope);
    assert.equal(current.request_id, receipt.request_id);
    assert.equal(current.input_hash, receipt.input_hash);
    assert.equal(current.created_at, receipt.created_at);
    const expected = JSON.parse(receipt.result);
    expected.announcement.content = "";
    expected.announcement.card = null;
    expected.announcement.links = [];
    assert.deepEqual(JSON.parse(current.result), expected);
    assert.ok(!current.result.includes("SECRET_"));
  }
  assert.deepEqual(
    f.store.db.prepare("SELECT * FROM idempotency_keys WHERE request_id='keep-create'").get(),
    untouched,
  );
  assert.equal((await f.service.get(actorId, other.announcement.id)).content, "KEEP_OTHER");
  assert.deepEqual(
    await f.service.remove(
      actorId,
      "scrub-remove",
      created.announcement.id,
      changed.announcement.revision,
    ),
    removed,
  );
  await assert.rejects(f.service.create(actorId, "scrub-create", input), code("not_found"));
});
