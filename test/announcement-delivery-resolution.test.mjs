import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import {
  deliveryAttemptsFingerprint,
  publicManualDeliveryResolution,
  readManualDeliveryResolution,
} from "../dist/core/jobs/manual-delivery.js";
import { AnnouncementService } from "../dist/modules/announcements/service.js";
import { AnnouncementDeliveryResolution } from "../dist/modules/announcements/delivery-resolution.js";
import { pruneDomainData } from "../dist/storage/domain-retention.js";

const guildId = "100000000000000001",
  actorId = "200000000000000001",
  botId = "200000000000000002",
  channelId = "300000000000000001",
  messageId = "400000000000000001",
  otherMessage = "400000000000000002";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gld-resolution-")),
    path = join(root, "guild.sqlite");
  const f = {
    now: Date.parse("2026-11-11T12:00:00Z"),
    auditFailure: false,
    fetchFailure: null,
    afterFetch: null,
    auth: async () => {},
    fetches: 0,
  };
  const store = new Store(path, guildId),
    jobs = new JobStore(store.db, () => f.now);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const announcements = new AnnouncementService(jobs, {
    guildId,
    clock: () => f.now,
    authorize: async () => {},
  });
  const resolutions = new AnnouncementDeliveryResolution(jobs, {
    guildId,
    botId,
    clock: () => f.now,
    authorize: (...args) => f.auth(...args),
    fetchMessage: async (requestedChannelId, requestedMessageId) => {
      f.fetches++;
      if (f.fetchFailure) throw f.fetchFailure;
      await f.afterFetch?.();
      return {
        id: requestedMessageId,
        channelId: requestedChannelId,
        authorId: botId,
        webhook: false,
        content: "Ogłoszenie",
        createdAt: f.now,
        fingerprint: "a".repeat(64),
        ...f.message,
      };
    },
    audit: (id, resolution) => {
      if (f.auditFailure) throw Error("audit_failed");
      store.event("announcement-delivery-resolution", id, JSON.stringify(resolution));
    },
  });
  const created = await announcements.create(actorId, randomUUID(), {
    channelId,
    content: "Ogłoszenie",
    schedule: { kind: "now" },
  });
  const [lease] = jobs.claim();
  jobs.beginAttempt(lease.id, lease.leaseToken, { channelId, nonce: "attempt" });
  jobs.unknown(lease.id, lease.leaseToken, "lost_ack");
  Object.assign(f, { store, jobs, announcements, resolutions, created, lease });
  f.input = (decision = "human_confirmed_message") => {
    const attempts = jobs.attempts(lease.id);
    return {
      jobId: lease.id,
      jobRevision: jobs.get(lease.id).revision,
      announcementRevision: Number(
        store.db
          .prepare("SELECT revision FROM announcements WHERE id=?")
          .get(created.announcement.id).revision,
      ),
      attemptIds: attempts.map((entry) => entry.id),
      attemptsFingerprint: deliveryAttemptsFingerprint(attempts),
      decisions: attempts
        .filter((entry) => ["sending", "unknown"].includes(entry.state))
        .map((entry) => ({
          attemptId: entry.id,
          decision,
          ...(decision === "human_confirmed_message"
            ? {
                messageUrl: `https://discord.com/channels/${guildId}/${entry.channelId}/${messageId}`,
              }
            : {}),
        })),
    };
  };
  f.snapshot = () =>
    JSON.stringify(
      [
        "jobs",
        "delivery_attempts",
        "announcements",
        "schedules",
        "announcement_job_receipts",
        "idempotency_keys",
        "events",
      ].map((name) => store.db.prepare(`SELECT * FROM ${name}`).all()),
    );
  f.preview = (input = f.input()) => resolutions.preview(actorId, created.announcement.id, input);
  f.apply = (inspection, requestId = randomUUID()) =>
    resolutions.resolve(actorId, requestId, created.announcement.id, {
      ...inspection.decision,
      confirmed: true,
    });
  f.count = () =>
    Number(
      store.db
        .prepare("SELECT published_count FROM schedules WHERE announcement_id=?")
        .get(created.announcement.id).published_count,
    );
  return f;
}

test("human association counts once, pauses work and survives genuine late ACK without manufacturing a transport confirmation", async (t) => {
  const f = await fixture(t),
    before = f.snapshot(),
    preview = await f.preview();
  assert.equal(f.snapshot(), before);
  assert.equal(preview.decision.decisions[0].messageFingerprint, "a".repeat(64));
  const requestId = randomUUID(),
    result = await f.apply(preview, requestId);
  assert.equal(result.resolved, true);
  assert.equal(f.count(), 1);
  const job = f.jobs.get(f.lease.id),
    attempt = f.jobs.attempts(job.id)[0];
  assert.equal(job.state, "unknown");
  assert.equal(job.cancelRequested, true);
  assert.equal(job.messageId, null);
  assert.equal(attempt.state, "unknown");
  assert.equal(attempt.messageId, null);
  assert.equal(readManualDeliveryResolution(job.result).actorId, actorId);
  assert.equal(
    readManualDeliveryResolution(attempt.result).decisions[0].decision,
    "human_confirmed_message",
  );
  const scheduled = f.store.db
    .prepare(
      "SELECT a.status,s.active_job_id FROM announcements a JOIN schedules s ON s.announcement_id=a.id WHERE a.id=?",
    )
    .get(f.created.announcement.id);
  assert.equal(scheduled.status, "paused");
  assert.equal(scheduled.active_job_id, null);
  assert.deepEqual(await f.apply(preview, requestId), result);
  assert.equal(f.count(), 1);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) n FROM events WHERE kind='announcement-delivery-resolution'")
      .get().n,
    1,
  );
  f.jobs.recordReceipt(job.id, f.lease.leaseToken, { messageId, result: { actual: true } });
  const late = f.jobs.attempts(job.id)[0];
  assert.equal(late.messageId, messageId);
  assert.equal(late.state, "succeeded");
  assert.equal(readManualDeliveryResolution(late.result).actorId, actorId);
  assert.deepEqual(late.result.receiptResult, { actual: true });
  assert.equal(f.resolutions.syncReceipts(), 0);
  assert.equal(f.count(), 1);
  assert.deepEqual(
    publicManualDeliveryResolution(f.jobs.get(job.id).result, f.jobs.attempts(job.id))
      .conflictingMessageIds,
    [],
  );
  assert.equal(f.jobs.claim().length, 0);
});

test("closing without confirmation preserves UNKNOWN; later actual confirmation counts once and preserves its separate evidence", async (t) => {
  const f = await fixture(t),
    preview = await f.preview(f.input("closed_unconfirmed"));
  assert.equal(f.fetches, 0);
  await f.apply(preview);
  assert.equal(f.count(), 0);
  f.jobs.recordReceipt(f.lease.id, f.lease.leaseToken, { messageId: otherMessage });
  assert.equal(f.resolutions.syncReceipts(), 1);
  assert.equal(f.resolutions.syncReceipts(), 0);
  assert.equal(f.count(), 1);
  assert.equal(f.jobs.get(f.lease.id).state, "unknown");
  assert.equal(
    readManualDeliveryResolution(f.jobs.attempts(f.lease.id)[0].result).decisions[0].decision,
    "closed_unconfirmed",
  );
  const view = publicManualDeliveryResolution(
    f.jobs.get(f.lease.id).result,
    f.jobs.attempts(f.lease.id),
  );
  assert.deepEqual(view.recordedMessageIds, [otherMessage]);
  assert.equal(view.decisions[0].linkedMessage, undefined);
});

test("foreign URLs, authors, webhook messages, altered previews and network failures never modify the database", async (t) => {
  const f = await fixture(t),
    base = f.input(),
    before = f.snapshot();
  for (const url of [
    base.decisions[0].messageUrl.replace(guildId, "100000000000000099"),
    base.decisions[0].messageUrl.replace(channelId, "300000000000000099"),
    base.decisions[0].messageUrl.replace("discord.com", "example.com"),
    base.decisions[0].messageUrl + "?redirect=1",
  ]) {
    await assert.rejects(
      f.preview({ ...base, decisions: [{ ...base.decisions[0], messageUrl: url }] }),
    );
    assert.equal(f.snapshot(), before);
  }
  for (const message of [
    { authorId: actorId },
    { webhook: true },
    { channelId: "300000000000000099" },
    { createdAt: f.now - 6000 },
  ]) {
    f.message = message;
    await assert.rejects(f.preview());
    assert.equal(f.snapshot(), before);
  }
  f.message = undefined;
  const preview = await f.preview();
  f.message = { fingerprint: "b".repeat(64) };
  await assert.rejects(f.apply(preview), (error) => error.code === "message_changed");
  assert.equal(f.snapshot(), before);
  f.message = undefined;
  for (const failure of [
    Object.assign(Error("missing"), { status: 404 }),
    Object.assign(Error("limited"), { status: 429 }),
    Error("timeout"),
  ]) {
    f.fetchFailure = failure;
    await assert.rejects(f.preview());
    assert.equal(f.snapshot(), before);
  }
});

test("membership loss and a late ACK during lookup are rechecked before any human decision is committed", async (t) => {
  const f = await fixture(t),
    before = f.snapshot();
  let lost = false;
  f.auth = async () => {
    if (lost) throw Object.assign(Error("forbidden"), { code: "permission_revoked" });
  };
  f.afterFetch = async () => {
    lost = true;
  };
  await assert.rejects(f.preview(), (error) => error.code === "permission_revoked");
  assert.equal(f.snapshot(), before);
  lost = false;
  const input = f.input();
  f.afterFetch = async () => {
    f.jobs.recordReceipt(f.lease.id, f.lease.leaseToken, { messageId });
  };
  await assert.rejects(f.preview(input), (error) => error.code === "revision_conflict");
  assert.equal(readManualDeliveryResolution(f.jobs.get(f.lease.id).result), undefined);
  assert.equal(f.count(), 0);
});

test("multiple ambiguous attempts retain individual ACKs and expose conflicts without duplicate counting", async (t) => {
  const f = await fixture(t),
    first = f.lease;
  f.jobs.reconcile(first.id, f.jobs.get(first.id).revision, {
    outcome: "retry",
    notDelivered: true,
    at: f.now,
  });
  const [second] = f.jobs.claim();
  f.jobs.beginAttempt(second.id, second.leaseToken, { channelId });
  f.jobs.unknown(second.id, second.leaseToken, "lost_again");
  // Model retained legacy ambiguity independently of the old trusted retry decision.
  f.store.db
    .prepare("UPDATE delivery_attempts SET state='unknown' WHERE lease_token=?")
    .run(first.leaseToken);
  const input = f.input();
  const before = f.snapshot();
  await assert.rejects(
    f.preview({ ...input, decisions: input.decisions.slice(0, 1) }),
    (error) => error.code === "state_conflict",
  );
  assert.equal(f.snapshot(), before);
  input.decisions[1] = { attemptId: input.decisions[1].attemptId, decision: "closed_unconfirmed" };
  const preview = await f.preview(input);
  assert.equal(preview.hasMultipleAttempts, true);
  await f.apply(preview);
  assert.ok(
    f.jobs
      .attempts(first.id)
      .every((attempt) => attempt.state === "unknown" && attempt.messageId === null),
  );
  f.jobs.recordReceipt(first.id, first.leaseToken, { messageId });
  f.jobs.recordReceipt(first.id, second.leaseToken, { messageId: otherMessage });
  const attempts = f.jobs.attempts(first.id);
  assert.deepEqual(
    attempts.map((attempt) => attempt.messageId),
    [messageId, otherMessage],
  );
  assert.ok(attempts.every((attempt) => readManualDeliveryResolution(attempt.result)));
  const manual = readManualDeliveryResolution(f.jobs.get(first.id).result);
  assert.deepEqual(
    manual.decisions.map((item) => item.decision),
    ["human_confirmed_message", "closed_unconfirmed"],
  );
  assert.equal(manual.decisions[1].linkedMessage, undefined);
  f.resolutions.syncReceipts();
  assert.equal(f.count(), 1);
  const view = publicManualDeliveryResolution(f.jobs.get(first.id).result, attempts);
  assert.deepEqual(view.conflictingMessageIds.sort(), [messageId, otherMessage].sort());
  assert.equal(f.jobs.claim().length, 0);
});

test("conflicting known ACK, stale revision, edited announcement and deleted history fail closed", async (t) => {
  const f = await fixture(t),
    stale = f.input();
  f.jobs.recordReceipt(f.lease.id, f.lease.leaseToken, { messageId: otherMessage });
  await assert.rejects(f.preview(stale), (error) => error.code === "revision_conflict");
  const before = f.snapshot();
  await assert.rejects(f.preview(f.input()), (error) => error.code === "invalid_input");
  assert.equal(f.snapshot(), before);
  await f.announcements.remove(
    actorId,
    randomUUID(),
    f.created.announcement.id,
    f.created.announcement.revision,
  );
  await assert.rejects(f.preview(stale), (error) => error.code === "not_found");
});

test("audit failure rolls back pause, receipt count, decision metadata and idempotency together", async (t) => {
  const f = await fixture(t),
    preview = await f.preview(),
    before = f.snapshot(),
    requestId = randomUUID();
  f.auditFailure = true;
  await assert.rejects(f.apply(preview, requestId), /audit_failed/);
  assert.equal(f.snapshot(), before);
  f.auditFailure = false;
  await f.apply(preview, requestId);
  assert.equal(f.count(), 1);
  await assert.rejects(
    f.resolutions.resolve(actorId, requestId, f.created.announcement.id, {
      ...preview.decision,
      decisions: preview.decision.decisions.map((item) => ({
        attemptId: item.attemptId,
        decision: "closed_unconfirmed",
      })),
      confirmed: true,
    }),
    (error) => error.code === "idempotency_conflict",
  );
});

test("manual history expires after30 days without reviving work or restoring private metadata through a late receipt", async (t) => {
  const f = await fixture(t),
    preview = await f.preview();
  await f.apply(preview);
  f.now += 30 * 86400000 - 1;
  assert.equal(pruneDomainData(f.jobs, guildId, { now: f.now }).jobsRetired, 0);
  f.now++;
  assert.equal(pruneDomainData(f.jobs, guildId, { now: f.now }).jobsRetired, 1);
  const job = f.jobs.get(f.lease.id),
    attempt = f.jobs.attempts(job.id)[0];
  assert.equal(job.state, "unknown");
  assert.equal(job.cancelRequested, true);
  assert.equal(job.result, null);
  assert.equal(attempt.result, null);
  assert.ok(
    !f.store.db
      .prepare("SELECT result FROM idempotency_keys WHERE scope=?")
      .get(`announcement:delivery:${guildId}`)
      .result.includes(actorId),
  );
  f.jobs.recordReceipt(job.id, f.lease.leaseToken, { messageId, result: { actorId } });
  assert.equal(f.jobs.attempts(job.id)[0].result, null);
  await assert.rejects(f.preview(preview.decision), (error) => error.code === "not_found");
  assert.equal(f.jobs.claim().length, 0);
});

test("two independent links and original channels are preserved per attempt in one atomic decision", async (t) => {
  const f = await fixture(t),
    first = f.lease,
    otherChannel = "300000000000000002";
  f.jobs.reconcile(first.id, f.jobs.get(first.id).revision, {
    outcome: "retry",
    notDelivered: true,
    at: f.now,
  });
  const [second] = f.jobs.claim();
  f.jobs.beginAttempt(second.id, second.leaseToken, { channelId: otherChannel });
  f.jobs.unknown(second.id, second.leaseToken, "lost_again");
  f.store.db
    .prepare("UPDATE delivery_attempts SET state='unknown' WHERE lease_token=?")
    .run(first.leaseToken);
  const input = f.input();
  input.decisions[1].messageUrl = `https://discord.com/channels/${guildId}/${otherChannel}/${otherMessage}`;
  const before = f.snapshot();
  await assert.rejects(
    f.preview({ ...input, decisions: [input.decisions[0], input.decisions[0]] }),
    (error) => error.code === "invalid_input",
  );
  assert.equal(f.snapshot(), before);
  const preview = await f.preview(input);
  assert.deepEqual(
    preview.messages.map((entry) => [entry.channelId, entry.messageId]),
    [
      [channelId, messageId],
      [otherChannel, otherMessage],
    ],
  );
  await f.apply(preview);
  const manual = readManualDeliveryResolution(f.jobs.get(first.id).result);
  assert.deepEqual(
    manual.decisions.map((item) => [
      item.attemptId,
      item.linkedMessage.channelId,
      item.linkedMessage.messageId,
    ]),
    input.decisions.map((item, index) => [
      item.attemptId,
      index ? otherChannel : channelId,
      index ? otherMessage : messageId,
    ]),
  );
  assert.equal(f.count(), 1);
  const preserved = f.snapshot();
  await assert.rejects(f.apply(preview), (error) =>
    ["already_resolved", "revision_conflict"].includes(error.code),
  );
  assert.equal(f.snapshot(), preserved);
});

test("a unique actual ACK can settle untouched UNKNOWN internally without a human association or another send", async (t) => {
  const f = await fixture(t);
  f.jobs.recordReceipt(f.lease.id, f.lease.leaseToken, { messageId });
  assert.equal(f.jobs.get(f.lease.id).state, "unknown");
  assert.equal(f.resolutions.syncReceipts(), 2);
  assert.equal(f.resolutions.syncReceipts(), 0);
  const job = f.jobs.get(f.lease.id);
  assert.equal(job.state, "succeeded");
  assert.equal(job.messageId, messageId);
  assert.equal(readManualDeliveryResolution(job.result), undefined);
  assert.equal(f.count(), 1);
  assert.equal(f.fetches, 0);
});
