import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { backup } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { CaseService, CaseError } from "../dist/modules/cases/service.js";
import { MeetingService, MeetingError } from "../dist/modules/meetings/service.js";
import { AnnouncementService } from "../dist/modules/announcements/service.js";
import { pruneDomainData } from "../dist/storage/domain-retention.js";

const day = 86400000,
  guildId = "900000000000000001",
  actor = "900000000000000002",
  member = "900000000000000003",
  channelId = "900000000000000004",
  nextChannel = "900000000000000005",
  messageId = "900000000000000006";
function fixture(t) {
  const store = new Store(":memory:", guildId);
  let now = Date.parse("2026-11-09T12:00:00Z");
  const jobs = new JobStore(store.db, () => now),
    cases = new CaseService(jobs, {
      guildId,
      clock: () => now,
      authorize: ({ actorId }) => ({
        member: {
          guildId,
          userId: actorId,
          owner: true,
          manageGuild: false,
          roleIds: [],
          pending: false,
          timedOut: false,
          isBot: false,
        },
        policy: { guildId },
      }),
    }),
    meetings = new MeetingService(jobs, {
      guildId,
      clock: () => now,
      authorize: () => {},
      eligible: () => true,
    });
  t.after(() => store.close());
  return {
    store,
    jobs,
    cases,
    meetings,
    now: () => now,
    advance: (ms) => (now += ms),
    prune: (options) => pruneDomainData(jobs, guildId, { now, ...options }),
    draft: (extra = {}) => ({
      title: "Prywatny temat spotkania",
      description: "Opis spotkania do usunięcia",
      capacity: 4,
      startsAt: now + 60 * day,
      endsAt: now + 60 * day + 3600000,
      channelId,
      visibility: "private",
      invitedUserIds: [member],
      ...extra,
    }),
  };
}
const caseDraft = {
  kind: "report",
  title: "Temat wyłącznie prywatnej sprawy",
  content: "Pierwotna treść prywatnej sprawy",
};
async function closedCase(f, key = "case-create") {
  const created = await f.cases.create(actor, key, caseDraft),
    replied = await f.cases.reply(actor, `${key}-reply`, created.case.id, 1, "Odpowiedź prywatna"),
    noted = await f.cases.note(
      actor,
      `${key}-note`,
      created.case.id,
      replied.case.revision,
      "Notatka wewnętrzna",
    );
  return f.cases.transition(actor, `${key}-close`, created.case.id, noted.case.revision, {
    status: "closed",
    reason: "Prywatny powód zamknięcia",
  });
}
function dumpText(f) {
  return f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'")
    .all()
    .map(({ name }) => JSON.stringify(f.store.db.prepare(`SELECT * FROM ${name}`).all()))
    .join("\n");
}

test("private closed case content expires exactly at 90 days without reviving create replay", async (t) => {
  const f = fixture(t),
    closed = await closedCase(f);
  const suggestion = await f.cases.create(actor, "public-idea", {
    kind: "suggestion",
    title: "Publiczny pomysł pozostaje",
    content: "Treść publicznego pomysłu",
  });
  await f.cases.approve(actor, "public-approve", suggestion.case.id, 1);
  const resolved = await f.cases.create(actor, "resolved", { ...caseDraft, kind: "question" });
  await f.cases.transition(actor, "resolved-state", resolved.case.id, 1, { status: "resolved" });
  f.advance(90 * day - 1);
  assert.equal(f.prune().casesRemoved, 0);
  f.advance(1);
  assert.equal(f.prune().casesRemoved, 1);
  assert.equal(f.store.db.prepare("SELECT 1 FROM cases WHERE id=?").get(closed.case.id), undefined);
  await assert.rejects(
    f.cases.get(actor, closed.case.id),
    (e) => e instanceof CaseError && e.code === "not_found",
  );
  await assert.rejects(
    f.cases.create(actor, "case-create", caseDraft),
    (e) => e instanceof CaseError && e.code === "not_found",
  );
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM cases").get().n, 2);
  const text = dumpText(f);
  for (const body of [
    caseDraft.title,
    "Odpowiedź prywatna",
    "Notatka wewnętrzna",
    "Prywatny powód zamknięcia",
  ])
    assert.equal(text.includes(body), body === caseDraft.title); // The separate unresolved question remains.
  assert.equal(text.includes("Treść publicznego pomysłu"), true);
  const receipts = f.store.db
    .prepare("SELECT result FROM idempotency_keys WHERE json_extract(result,'$.retiredCaseId')=?")
    .all(closed.case.id);
  assert.equal(receipts.length, 4);
  assert.ok(
    receipts.every(({ result }) => Object.keys(JSON.parse(result)).join() === "retiredCaseId"),
  );
  assert.equal(f.prune().casesRemoved, 0);
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("meeting retention uses the terminal audit even when a later receipt changes updated_at", async (t) => {
  const f = fixture(t),
    input = f.draft({ startsAt: f.now() + 180 * day, endsAt: f.now() + 180 * day + 3600000 }),
    created = await f.meetings.create(actor, "meeting-create", input);
  await f.meetings.join(member, "join", created.meeting.id);
  const current = await f.meetings.get(actor, created.meeting.id);
  f.jobs.idempotent(`meeting:legacy:${guildId}:${actor}`, "legacy-full-receipt", {}, () => current);
  await f.meetings.transition(
    actor,
    "meeting-cancel",
    current.meeting.id,
    current.meeting.revision,
    "cancel",
  );
  f.advance(89 * day);
  f.store.db
    .prepare("UPDATE meetings SET updated_at=? WHERE id=?")
    .run(f.now(), created.meeting.id);
  assert.equal(f.prune().meetingsRemoved, 0);
  f.advance(day);
  assert.equal(f.prune().meetingsRemoved, 1);
  await assert.rejects(
    f.meetings.get(actor, created.meeting.id),
    (e) => e instanceof MeetingError && e.code === "not_found",
  );
  await assert.rejects(
    f.meetings.create(actor, "meeting-create", input),
    (e) => e instanceof MeetingError && e.code === "not_found",
  );
  for (const table of [
    "meetings",
    "meeting_audit",
    "meeting_participants",
    "meeting_invites",
    "meeting_effect_receipts",
  ])
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  const text = dumpText(f);
  assert.equal(text.includes(input.title), false);
  assert.equal(text.includes(input.description), false);
  assert.equal(
    f.store.db
      .prepare("SELECT result FROM idempotency_keys WHERE request_id='legacy-full-receipt'")
      .get().result,
    JSON.stringify(created.meeting.id),
  );
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("unknown delivery cannot keep private case content beyond 90 days or resend a retired case", async (t) => {
  const f = fixture(t),
    closed = await closedCase(f),
    lease = f.jobs.claim({ types: ["case.notify"], limit: 1 })[0];
  f.jobs.beginAttempt(lease.id, lease.leaseToken, { channelId, nonce: "receipt-nonce" });
  f.jobs.unknown(lease.id, lease.leaseToken, "response_uncertain");
  f.advance(90 * day);
  assert.equal(f.prune().casesRemoved, 1);
  assert.equal(f.jobs.get(lease.id).state, "unknown");
  assert.equal(f.jobs.isHistoryRetired(lease.id), false);
  assert.deepEqual(f.jobs.get(lease.id).payload, { caseId: closed.case.id });
  assert.throws(
    () =>
      f.jobs.reconcile(lease.id, f.jobs.get(lease.id).revision, {
        outcome: "retry",
        notDelivered: true,
        at: f.now(),
      }),
    /state_conflict/,
  );
  assert.throws(
    () =>
      f.jobs.enqueue({
        guildId,
        type: "case.notify",
        objectId: closed.case.id,
        dueAt: f.now(),
        dedupeKey: "new-retired-retry",
        payload: { caseId: closed.case.id },
      }),
    /state_conflict/,
  );
  const receipt = f.jobs.recordReceipt(lease.id, lease.leaseToken, {
    messageId,
    result: { content: "Treść z opóźnionej odpowiedzi transportu" },
  });
  assert.equal(receipt.result, null);
  assert.equal(receipt.messageId, messageId);
  assert.equal(f.jobs.get(lease.id).state, "unknown");
  let targetCalls = 0;
  await assert.rejects(
    f.cases.prepareNotification(lease, () => {
      targetCalls++;
      throw Error("must not reach target");
    }),
    CaseError,
  );
  assert.equal(targetCalls, 0);
  f.jobs.reconcile(lease.id, f.jobs.get(lease.id).revision, {
    outcome: "succeeded",
    messageId,
    result: { content: "Nie wolno odtworzyć pełnej treści przez reconciliation" },
  });
  assert.equal(f.jobs.get(lease.id).result, null);
  assert.equal(dumpText(f).includes("Notatka wewnętrzna"), false);
});

test("a live send defers deletion only until its lease is fenced into unknown", async (t) => {
  const f = fixture(t),
    closed = await closedCase(f);
  f.advance(90 * day);
  const job = f.jobs.enqueue({
      guildId,
      type: "fixture.send",
      objectId: closed.case.id,
      dueAt: f.now(),
      dedupeKey: "running-send",
      payload: { caseId: closed.case.id },
    }),
    lease = f.jobs.claim({ types: ["fixture.send"], leaseMs: 1000 })[0];
  f.jobs.beginAttempt(lease.id, lease.leaseToken, { channelId });
  assert.equal(f.prune().deferredCases, 1);
  assert.ok(f.store.db.prepare("SELECT 1 FROM cases WHERE id=?").get(closed.case.id));
  f.advance(1000);
  assert.equal(f.prune().casesRemoved, 1);
  assert.equal(f.jobs.get(job.id).state, "unknown");
  assert.throws(() => f.jobs.complete(job.id, lease.leaseToken), /stale_lease/);
});

test("30-day terminal history keeps dedupe and positive message proof while hiding and minimizing content", (t) => {
  const f = fixture(t),
    input = {
      guildId,
      type: "fixture.send",
      dueAt: f.now(),
      dedupeKey: "once-only",
      payload: { content: "Pełna treść zadania", actorId: actor },
    },
    job = f.jobs.enqueue(input),
    lease = f.jobs.claim({ types: ["fixture.send"] })[0];
  f.jobs.beginAttempt(job.id, lease.leaseToken, { channelId, nonce: "nonce" });
  f.jobs.complete(job.id, lease.leaseToken, { messageId, result: { content: "Treść odpowiedzi" } });
  f.advance(30 * day - 1);
  assert.equal(f.prune().jobsRetired, 0);
  f.advance(1);
  assert.equal(f.prune().jobsRetired, 1);
  assert.equal(
    f.jobs.list().some((j) => j.id === job.id),
    false,
  );
  assert.equal(
    f.jobs.list({}, { includeRetired: true }).some((j) => j.id === job.id),
    true,
  );
  assert.equal(f.jobs.isHistoryRetired(job.id), true);
  assert.deepEqual(f.jobs.get(job.id).payload, {});
  assert.equal(f.jobs.get(job.id).result, null);
  assert.equal(f.jobs.attempts(job.id)[0].nonce, null);
  assert.equal(f.jobs.attempts(job.id)[0].messageId, messageId);
  assert.equal(f.jobs.attempts(job.id)[0].channelId, channelId);
  assert.equal(f.jobs.enqueue(input).id, job.id);
  assert.equal(f.jobs.claim({ types: ["fixture.send"] }).length, 0);
  assert.equal(dumpText(f).includes("Pełna treść zadania"), false);
  assert.equal(dumpText(f).includes("Treść odpowiedzi"), false);
});

test("a retired meeting publication remains a valid source for later receipt-bound controls cleanup", async (t) => {
  const f = fixture(t),
    draft = f.draft({ visibility: "public" }),
    created = await f.meetings.create(actor, "published-meeting", draft),
    lease = f.jobs
      .claim({ types: ["meeting.publish"], limit: 10 })
      .find((j) => j.objectId === created.meeting.id);
  const receipt = f.jobs.beginAttempt(lease.id, lease.leaseToken, { channelId });
  f.meetings.recordResult(lease, { messageId });
  f.jobs.complete(lease.id, lease.leaseToken, { messageId });
  f.advance(30 * day);
  assert.equal(f.prune().jobsRetired, 1);
  assert.deepEqual(f.jobs.get(lease.id).payload, { meetingId: created.meeting.id });
  const current = await f.meetings.get(actor, created.meeting.id);
  await f.meetings.update(actor, "move-channel", current.meeting.id, current.meeting.revision, {
    ...draft,
    channelId: nextChannel,
  });
  const cleanup = f.jobs.list({ type: "community.meeting-controls-clear" });
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].payload.sourceJobId, lease.id);
  assert.equal(cleanup[0].payload.attemptId, receipt.id);
  assert.equal(cleanup[0].payload.messageId, messageId);
});

test("unknown attempts never retire as ordinary terminal history", (t) => {
  const f = fixture(t),
    first = f.jobs.enqueue({
      guildId,
      type: "fixture.send",
      dueAt: f.now(),
      dedupeKey: "unknown-attempt",
      payload: {},
    }),
    lease = f.jobs.claim({ types: ["fixture.send"] })[0];
  f.jobs.beginAttempt(lease.id, lease.leaseToken, { channelId });
  f.jobs.unknown(lease.id, lease.leaseToken, "uncertain");
  f.store.db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(first.id);
  f.advance(30 * day);
  assert.equal(f.prune().jobsRetired, 0);
  assert.equal(f.jobs.isHistoryRetired(first.id), false);
  assert.equal(f.jobs.attempts(first.id)[0].state, "unknown");
});

test("active schedule and missing announcement accounting retain their job until synchronized", async (t) => {
  const f = fixture(t),
    service = new AnnouncementService(f.jobs, { guildId, clock: f.now, authorize: () => {} }),
    created = await service.create(actor, "accounting", {
      channelId,
      content: "Aktywne ogłoszenie zostaje",
      schedule: { kind: "once", at: f.now() + 1000 },
    });
  f.advance(1000);
  const lease = f.jobs.claim({ types: ["announcement.send"] })[0];
  f.jobs.complete(lease.id, lease.leaseToken, { messageId });
  f.advance(30 * day);
  assert.equal(f.prune().jobsRetired, 0);
  f.store.db
    .prepare("UPDATE schedules SET active_job_id=NULL WHERE announcement_id=?")
    .run(created.announcement.id);
  assert.equal(f.prune().jobsRetired, 0);
  service.sync();
  assert.equal(f.prune().jobsRetired, 1);
  assert.equal(
    f.store.db
      .prepare("SELECT published_count n FROM schedules WHERE announcement_id=?")
      .get(created.announcement.id).n,
    1,
  );
  service.sync();
  assert.equal(
    f.store.db
      .prepare("SELECT published_count n FROM schedules WHERE announcement_id=?")
      .get(created.announcement.id).n,
    1,
  );
  assert.ok((await service.get(actor, created.announcement.id)).content);
});

test("retention is guild-bound, bounded, and rolls back tombstones and cancellations if a content delete fails", async (t) => {
  const f = fixture(t),
    first = await closedCase(f, "first"),
    second = await closedCase(f, "second");
  f.advance(90 * day);
  assert.throws(
    () => pruneDomainData(f.jobs, "900000000000000009", { now: f.now() }),
    /guild mismatch/,
  );
  f.store.db.exec(
    "CREATE TRIGGER reject_retention BEFORE DELETE ON case_messages BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;",
  );
  assert.throws(() => f.prune(), /fixture_failure/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM domain_retired").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM cases").get().n, 2);
  assert.equal(f.jobs.get(first.job.id).state, "pending");
  f.store.db.exec("DROP TRIGGER reject_retention");
  assert.equal(f.prune({ limit: 1 }).casesRemoved, 1);
  assert.equal(f.prune({ limit: 1 }).casesRemoved, 1);
  assert.equal(f.prune().casesRemoved, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM domain_retired").get().n, 2);
  assert.notEqual(first.case.id, second.case.id);
});

test("retirement tombstones and dedupe fences survive a real SQLite backup and reopen", async (t) => {
  const f = fixture(t),
    directory = mkdtempSync(join(tmpdir(), "gildiusz-retention-")),
    path = join(directory, "guild.sqlite"),
    closed = await closedCase(f),
    input = {
      guildId,
      type: "fixture.send",
      dueAt: f.now(),
      dedupeKey: "durable-fence",
      payload: { content: "Stara treść" },
    },
    job = f.jobs.enqueue(input),
    lease = f.jobs.claim({ types: ["fixture.send"] })[0];
  let reopened;
  t.after(() => {
    reopened?.close();
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
        basename(directory).startsWith("gildiusz-retention-"),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  f.jobs.complete(job.id, lease.leaseToken);
  f.advance(90 * day);
  assert.equal(f.prune().casesRemoved, 1);
  await backup(f.store.db, path);
  reopened = new Store(path, guildId);
  const jobs = new JobStore(reopened.db, f.now),
    service = new CaseService(jobs, {
      guildId,
      clock: f.now,
      authorize: () => ({
        member: {
          guildId,
          userId: actor,
          owner: true,
          manageGuild: false,
          roleIds: [],
          pending: false,
          timedOut: false,
          isBot: false,
        },
        policy: { guildId },
      }),
    });
  assert.equal(jobs.isHistoryRetired(job.id), true);
  assert.equal(jobs.enqueue(input).id, job.id);
  assert.equal(jobs.claim({ types: ["fixture.send"] }).length, 0);
  assert.equal(
    reopened.db.prepare("SELECT object_id FROM domain_retired WHERE kind='case'").get().object_id,
    closed.case.id,
  );
  await assert.rejects(
    service.create(actor, "case-create", caseDraft),
    (e) => e instanceof CaseError && e.code === "not_found",
  );
  assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("moving a card finds its exact confirmed source after more than 500 publications", async (t) => {
  const f = fixture(t),
    draft = f.draft({ visibility: "public" }),
    created = await f.meetings.create(actor, "many-publications", draft);
  let currentSource, currentAttempt, currentMessage;
  for (let index = 0; index < 501; index++) {
    const publication = f.jobs.enqueue({
        guildId,
        type: "meeting.publish",
        objectId: created.meeting.id,
        dueAt: f.now(),
        dedupeKey: `many-publish-${index}`,
        payload: { meetingId: created.meeting.id, generation: 1 },
      }),
      publishedMessage = String(900000000000001000n + BigInt(index)),
      attemptId = randomUUID();
    f.store.db
      .prepare("UPDATE jobs SET state='succeeded',message_id=? WHERE id=?")
      .run(publishedMessage, publication.id);
    f.store.db
      .prepare(
        `INSERT INTO delivery_attempts(id,job_id,number,lease_token,state,channel_id,message_id,started_at,finished_at)
      VALUES(?,?,1,?,'succeeded',?,?,?,?)`,
      )
      .run(
        attemptId,
        publication.id,
        `lease-${index}`,
        channelId,
        publishedMessage,
        f.now(),
        f.now(),
      );
    currentSource = publication.id;
    currentAttempt = attemptId;
    currentMessage = publishedMessage;
  }
  f.store.db
    .prepare("UPDATE meetings SET message_id=? WHERE id=?")
    .run(currentMessage, created.meeting.id);
  await f.meetings.update(actor, "move-after-501", created.meeting.id, created.meeting.revision, {
    ...draft,
    channelId: nextChannel,
  });
  const [cleanup, ...others] = f.jobs.list({ type: "community.meeting-controls-clear" });
  assert.equal(others.length, 0);
  assert.equal(cleanup.payload.sourceJobId, currentSource);
  assert.equal(cleanup.payload.attemptId, currentAttempt);
  assert.equal(cleanup.payload.messageId, currentMessage);
  const dueAt = cleanup.dueAt;
  f.advance(1000);
  // A replay keeps its original durable cleanup job and schedule.
  await f.meetings.update(actor, "move-after-501", created.meeting.id, created.meeting.revision, {
    ...draft,
    channelId: nextChannel,
  });
  assert.equal(f.jobs.list({ type: "community.meeting-controls-clear" }).length, 1);
  assert.equal(f.jobs.get(cleanup.id).dueAt, dueAt);
});

test("expired one-minute actor rate counters disappear without resetting the current rate window", async (t) => {
  const f = fixture(t),
    service = new AnnouncementService(f.jobs, { guildId, clock: f.now, authorize: () => {} }),
    draft = {
      channelId,
      content: "Ogłoszenie zachowane",
      schedule: { kind: "once", at: f.now() + day },
    };
  await f.cases.create(actor, "old-counter", caseDraft);
  await service.create(actor, "old-ann-counter", draft);
  f.advance(59999);
  f.prune();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM case_actions").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM announcement_actions").get().n, 1);
  f.advance(1);
  f.prune();
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM case_actions").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM announcement_actions").get().n, 0);
  await f.cases.create(actor, "new-counter", caseDraft);
  await service.create(actor, "new-ann-counter", draft);
  f.prune();
  for (const table of ["case_actions", "announcement_actions"]) {
    const rows = f.store.db.prepare(`SELECT actor_id,created_at FROM ${table}`).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, actor);
    assert.equal(rows[0].created_at, f.now());
  }
});
