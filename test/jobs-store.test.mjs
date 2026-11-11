import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { JobStore, JobError } from "../dist/core/jobs/store.js";
import { Store } from "../dist/storage/store.js";
import { migrate } from "../dist/storage/migrations.js";

const guildId = "100000000000000001";
const input = (key, extra = {}) => ({
  guildId,
  type: "announcement.send",
  payload: { content: "Próba" },
  dueAt: 1000,
  dedupeKey: key,
  ...extra,
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-jobs-"));
  const path = join(directory, "guild.sqlite");
  const stores = [];
  let now = 1000;
  const open = () => {
    const store = new Store(path, guildId);
    stores.push(store);
    return { store, jobs: new JobStore(store.db, () => now) };
  };
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* Already closed for a restart test. */
      }
    }
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-jobs-")
    )
      throw Error("Unexpected test directory.");
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    open,
    setNow: (value) => {
      now = value;
    },
    ...open(),
  };
}

const code = (expected) => (error) => error instanceof JobError && error.code === expected;

test("queue observation excludes future work, cooldowns, expiry and known deliveries without changing stored state", (t) => {
  const f = fixture(t);
  const lease = (key) => {
    f.jobs.enqueue(input(key, { type: key }));
    return f.jobs.claim({ types: [key] })[0];
  };
  const retry = lease("ready-retry");
  f.jobs.retry(retry.id, retry.leaseToken, { at: 9000, error: "retry" });
  const cooldown = lease("cooldown");
  f.jobs.beginAttempt(cooldown.id, cooldown.leaseToken);
  f.jobs.retry(cooldown.id, cooldown.leaseToken, {
    at: 11000,
    error: "rate_limited",
    rateLimited: true,
  });
  const failed = lease("failed");
  f.jobs.fail(failed.id, failed.leaseToken, "failed");
  const unknown = lease("unknown");
  f.jobs.unknown(unknown.id, unknown.leaseToken, "uncertain");
  const succeeded = lease("succeeded");
  f.jobs.complete(succeeded.id, succeeded.leaseToken);
  const running = lease("running");
  const receipt = lease("late-receipt-observation");
  f.jobs.beginAttempt(receipt.id, receipt.leaseToken);
  const uncertain = f.jobs.unknown(receipt.id, receipt.leaseToken, "uncertain");
  f.jobs.reconcile(receipt.id, uncertain.revision, {
    outcome: "retry",
    at: 1000,
    notDelivered: true,
  });
  f.jobs.recordReceipt(receipt.id, receipt.leaseToken, { messageId: "confirmed" });
  const cancelled = f.jobs.enqueue(input("cancelled-observation"));
  f.jobs.cancel(cancelled.id);
  const expired = f.jobs.enqueue(input("expired-observation", { expiresAt: 1100 }));
  f.jobs.enqueue(input("future-observation", { dueAt: 12000 }));
  f.jobs.enqueue(input("due-observation", { dueAt: 8000 }));
  f.setNow(10000);
  const before = f.jobs.list({ limit: 100 }, { includeRetired: true }),
    attempts = f.store.db.prepare("SELECT * FROM delivery_attempts ORDER BY id").all(),
    changes = f.store.db.prepare("SELECT total_changes() AS n").get().n;
  assert.deepEqual(f.jobs.observeQueue(guildId), {
    due: 2,
    deferredRetries: 1,
    running: 1,
    unknown: 1,
    oldestOverdueMs: 2000,
  });
  assert.deepEqual(f.jobs.list({ limit: 100 }, { includeRetired: true }), before);
  assert.deepEqual(
    f.store.db.prepare("SELECT * FROM delivery_attempts ORDER BY id").all(),
    attempts,
  );
  assert.equal(f.store.db.prepare("SELECT total_changes() AS n").get().n, changes);
  assert.equal(f.jobs.get(expired.id).state, "pending");
  assert.equal(f.jobs.get(running.id).state, "running");
  assert.deepEqual(f.jobs.observeQueue("100000000000000099"), {
    due: 0,
    deferredRetries: 0,
    running: 0,
    unknown: 0,
    oldestOverdueMs: null,
  });
});

test("queue overdue age begins after the retry eligibility time, rather than the original due time", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("age-retry"));
  const [leased] = f.jobs.claim();
  f.jobs.retry(leased.id, leased.leaseToken, { at: 5000, error: "backoff", rateLimited: true });
  f.setNow(4999);
  assert.deepEqual(f.jobs.observeQueue(guildId), {
    due: 0,
    deferredRetries: 1,
    running: 0,
    unknown: 0,
    oldestOverdueMs: null,
  });
  f.setNow(5000);
  assert.equal(f.jobs.observeQueue(guildId).oldestOverdueMs, 0);
  f.setNow(5500);
  assert.equal(f.jobs.observeQueue(guildId).oldestOverdueMs, 500);
  assert.throws(() => f.jobs.observeQueue(guildId, NaN), code("invalid_input"));
});

test("late receipts retain the old delivery fact without taking over the job", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("late-receipt"));
  const [lease] = f.jobs.claim();
  f.jobs.beginAttempt(lease.id, lease.leaseToken, { nonce: "one", channelId: "channel" });
  const unknown = f.jobs.unknown(lease.id, lease.leaseToken, "timeout");
  const receipt = f.jobs.recordReceipt(lease.id, lease.leaseToken, { messageId: "message-late" });
  assert.equal(receipt.messageId, "message-late");
  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.error, "late_confirmation");
  assert.deepEqual(f.jobs.get(lease.id), unknown);
  assert.deepEqual(
    f.jobs.recordReceipt(lease.id, lease.leaseToken, { messageId: "message-late" }),
    receipt,
  );
  assert.throws(
    () => f.jobs.recordReceipt(lease.id, lease.leaseToken, { messageId: "different" }),
    code("state_conflict"),
  );
  assert.throws(
    () =>
      f.jobs.reconcile(lease.id, unknown.revision, {
        outcome: "retry",
        notDelivered: true,
        at: 2000,
      }),
    code("state_conflict"),
  );
  assert.deepEqual(f.jobs.claim(), []);
});

test("receipt before lease recovery cannot make the already delivered job retryable", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("late-before-recover"));
  const [lease] = f.jobs.claim({ leaseMs: 100 });
  f.jobs.beginAttempt(lease.id, lease.leaseToken);
  f.setNow(1100);
  assert.throws(() => f.jobs.complete(lease.id, lease.leaseToken), code("stale_lease"));
  f.jobs.recordReceipt(lease.id, lease.leaseToken, { messageId: "already-delivered" });
  assert.deepEqual(f.jobs.recover(), { unknown: 1, requeued: 0, expired: 0 });
  assert.equal(f.jobs.get(lease.id).state, "unknown");
  assert.deepEqual(f.jobs.claim(), []);
});

test("old receipts cannot overwrite a newer lease and prevent a subsequent send", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("receipt-new-owner"));
  const [old] = f.jobs.claim();
  f.jobs.beginAttempt(old.id, old.leaseToken);
  const unknown = f.jobs.unknown(old.id, old.leaseToken, "timeout");
  f.jobs.reconcile(old.id, unknown.revision, { outcome: "retry", notDelivered: true, at: 1000 });
  const [next] = f.jobs.claim();
  const before = f.jobs.get(next.id);
  f.jobs.recordReceipt(old.id, old.leaseToken, { messageId: "old-message" });
  assert.deepEqual(f.jobs.get(next.id), before);
  assert.throws(() => f.jobs.beginAttempt(next.id, next.leaseToken), code("state_conflict"));
  f.jobs.retry(next.id, next.leaseToken, { at: 2000, error: "late_receipt_found" });
  assert.equal(f.jobs.get(next.id).state, "unknown");
  assert.equal(f.jobs.attempts(next.id).length, 1);
  assert.deepEqual(f.jobs.claim(), []);
});

test("a receipt cannot be fabricated for work that never began delivery", (t) => {
  const { jobs } = fixture(t);
  jobs.enqueue(input("unsent-receipt"));
  const [lease] = jobs.claim();
  assert.throws(
    () => jobs.recordReceipt(lease.id, lease.leaseToken, { messageId: "fake" }),
    code("state_conflict"),
  );
  assert.equal(jobs.attempts(lease.id).length, 0);
  assert.equal(jobs.get(lease.id).state, "running");
});

test("a late receipt prevents a manually queued retry from being claimed", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("receipt-before-retry"));
  const [lease] = f.jobs.claim();
  f.jobs.beginAttempt(lease.id, lease.leaseToken);
  const unknown = f.jobs.unknown(lease.id, lease.leaseToken, "timeout");
  f.jobs.reconcile(lease.id, unknown.revision, { outcome: "retry", notDelivered: true, at: 5000 });
  f.jobs.recordReceipt(lease.id, lease.leaseToken, { messageId: "delivered-late" });
  f.setNow(5000);
  assert.deepEqual(f.jobs.claim(), []);
  assert.equal(f.jobs.get(lease.id).state, "unknown");
  assert.equal(f.jobs.attempts(lease.id).length, 1);
});

test("receipt for an older send never replaces a newer owner's completed result", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("receipt-after-new-result"));
  const [old] = f.jobs.claim();
  f.jobs.beginAttempt(old.id, old.leaseToken);
  const unknown = f.jobs.unknown(old.id, old.leaseToken, "timeout");
  f.jobs.reconcile(old.id, unknown.revision, { outcome: "retry", notDelivered: true, at: 1000 });
  const [next] = f.jobs.claim();
  f.jobs.beginAttempt(next.id, next.leaseToken);
  const done = f.jobs.complete(next.id, next.leaseToken, {
    messageId: "new-message",
    result: { generation: 2 },
  });
  f.jobs.recordReceipt(old.id, old.leaseToken, { messageId: "old-message" });
  assert.deepEqual(f.jobs.get(next.id), done);
  assert.deepEqual(
    f.jobs.attempts(next.id).map((attempt) => attempt.messageId),
    ["old-message", "new-message"],
  );
  assert.deepEqual(f.jobs.claim(), []);
});

test("module migrations preserve version 2 and existing guild resources across restart", (t) => {
  const f = fixture(t);
  f.store.putResource("channel.example", "channel", "100000000000000002", { name: "test" });
  f.jobs.enqueue(input("retained"));
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE version=1 AND name='durable-jobs'",
      )
      .get().count,
    1,
  );
  f.store.close();
  const next = f.open();
  assert.equal(next.store.resource("channel.example").id, "100000000000000002");
  assert.equal(next.jobs.list()[0].dedupeKey, "retained");
  assert.equal(next.store.db.prepare("PRAGMA user_version").get().user_version, 2);
});

test("migration ledger rejects changed migrations and future versions without applying work", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    db.prepare("UPDATE schema_migrations SET checksum='changed'").run();
    assert.throws(() => migrate(db), /migration was changed/);
    db.prepare("DELETE FROM schema_migrations").run();
    db.prepare("INSERT INTO schema_migrations VALUES (999,'future','future',1)").run();
    assert.throws(() => migrate(db), /newer application/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 1);
  } finally {
    db.close();
  }
});

test("enqueue deduplicates canonical payloads and rejects changed commands or guild ownership", (t) => {
  const { jobs } = fixture(t);
  const created = jobs.enqueue(input("one", { payload: { a: 1, b: 2 } }));
  assert.equal(jobs.enqueue(input("one", { payload: { b: 2, a: 1 } })).id, created.id);
  assert.throws(
    () => jobs.enqueue(input("one", { payload: { a: 2, b: 2 } })),
    code("dedupe_conflict"),
  );
  assert.throws(() => jobs.enqueue(input("two", { id: created.id })), code("dedupe_conflict"));
  assert.throws(
    () => jobs.enqueue(input("three", { guildId: "100000000000000003" })),
    code("guild_conflict"),
  );
  assert.equal(jobs.list().length, 1);
});

test("idempotent domain changes and jobs commit once and roll back together on error", (t) => {
  const { store, jobs } = fixture(t);
  let calls = 0;
  const create = () => {
    calls++;
    store.putResource("domain.one", "object", "one", {});
    return { job: jobs.enqueue(input("once")).id };
  };
  const saved = jobs.idempotent("create", "request", { a: 1, b: 2 }, create);
  assert.deepEqual(jobs.idempotent("create", "request", { b: 2, a: 1 }, create), saved);
  assert.equal(calls, 1);
  assert.throws(
    () => jobs.idempotent("create", "request", { a: 9 }, create),
    code("idempotency_conflict"),
  );
  assert.throws(
    () =>
      jobs.idempotent("create", "rollback", {}, () => {
        store.putResource("domain.failed", "object", "failed", {});
        jobs.enqueue(input("failed"));
        throw Error("domain failure");
      }),
    /domain failure/,
  );
  assert.equal(store.resource("domain.failed"), undefined);
  assert.equal(jobs.list().length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get().count, 1);
});

test("savepoints compose with an existing Store transaction and do not commit its outer work", (t) => {
  const { store, jobs } = fixture(t);
  assert.throws(
    () =>
      store.transaction(() => {
        jobs.idempotent("outer", "one", {}, () => ({ id: jobs.enqueue(input("outer")).id }));
        throw Error("outer rollback");
      }),
    /outer rollback/,
  );
  assert.equal(jobs.list().length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get().count, 0);
  store.transaction(() => {
    assert.throws(
      () =>
        jobs.transaction(() => {
          jobs.enqueue(input("inner"));
          throw Error("inner rollback");
        }),
      /inner rollback/,
    );
    jobs.enqueue(input("kept"));
  });
  assert.deepEqual(
    jobs.list().map((job) => job.dedupeKey),
    ["kept"],
  );
});

test("future work survives a real database close and is not claimed early", (t) => {
  const f = fixture(t);
  const planned = f.jobs.enqueue(
    input("future", { dueAt: 5000, expiresAt: 9000, generation: 4, objectId: "notice" }),
  );
  f.store.close();
  const { jobs } = f.open();
  assert.equal(jobs.claim().length, 0);
  f.setNow(5000);
  const [lease] = jobs.claim();
  assert.equal(lease.id, planned.id);
  assert.equal(lease.generation, 4);
  assert.equal(lease.objectId, "notice");
  assert.equal(lease.expiresAt, 9000);
  assert.equal(lease.attempts, 1);
});

test("expired pre-send leases can be reclaimed and fence every action from the old worker", (t) => {
  const f = fixture(t);
  const queued = f.jobs.enqueue(input("lease"));
  const [old] = f.jobs.claim({ leaseMs: 100 });
  f.setNow(1100);
  assert.deepEqual(f.jobs.recover(), { requeued: 1, unknown: 0, expired: 0 });
  const [next] = f.jobs.claim({ leaseMs: 100 });
  assert.notEqual(old.leaseToken, next.leaseToken);
  for (const action of [
    () => f.jobs.renew(old.id, old.leaseToken),
    () => f.jobs.beginAttempt(old.id, old.leaseToken),
    () => f.jobs.complete(old.id, old.leaseToken),
    () => f.jobs.retry(old.id, old.leaseToken, { at: 1200, error: "late" }),
    () => f.jobs.fail(old.id, old.leaseToken, "late"),
    () => f.jobs.unknown(old.id, old.leaseToken, "late"),
  ])
    assert.throws(action, code("stale_lease"));
  f.jobs.complete(next.id, next.leaseToken, { result: { ok: true } });
  assert.equal(f.jobs.get(queued.id).state, "succeeded");
});

test("a lease is stale at its exact expiry even before recovery", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("expired-token"));
  const [lease] = f.jobs.claim({ leaseMs: 100 });
  f.setNow(1100);
  assert.throws(() => f.jobs.complete(lease.id, lease.leaseToken), code("stale_lease"));
  assert.throws(() => f.jobs.beginAttempt(lease.id, lease.leaseToken), code("stale_lease"));
});

test("lease renewal protects long work and never shortens the current lease", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("long"));
  const [lease] = f.jobs.claim({ leaseMs: 100 });
  f.setNow(1050);
  assert.equal(f.jobs.renew(lease.id, lease.leaseToken, 10).leaseUntil, 1100);
  assert.equal(f.jobs.renew(lease.id, lease.leaseToken, 300).leaseUntil, 1350);
  f.setNow(1101);
  assert.equal(f.jobs.recover().requeued, 0);
  assert.equal(f.jobs.get(lease.id).state, "running");
});

test("a crash after beginning a send becomes unknown and never auto-retries", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("uncertain"));
  const [lease] = f.jobs.claim({ leaseMs: 100 });
  const sent = f.jobs.beginAttempt(lease.id, lease.leaseToken, {
    nonce: "nonce-one",
    channelId: "channel",
  });
  f.store.close();
  f.setNow(1200);
  const { jobs } = f.open();
  assert.deepEqual(jobs.recover(), { requeued: 0, unknown: 1, expired: 0 });
  assert.equal(jobs.get(lease.id).state, "unknown");
  assert.equal(jobs.attempts(lease.id)[0].id, sent.id);
  assert.equal(jobs.attempts(lease.id)[0].state, "unknown");
  f.setNow(1000000);
  assert.deepEqual(jobs.claim(), []);
  assert.equal(jobs.get(lease.id).state, "unknown");
});

test("an uncertain send can be reconciled as delivered with a revision check", (t) => {
  const { jobs } = fixture(t);
  jobs.enqueue(input("ack-lost"));
  const [lease] = jobs.claim();
  jobs.beginAttempt(lease.id, lease.leaseToken, { nonce: "stable" });
  const unknown = jobs.unknown(lease.id, lease.leaseToken, "response_timeout");
  assert.throws(
    () => jobs.reconcile(lease.id, unknown.revision - 1, { outcome: "succeeded" }),
    code("revision_conflict"),
  );
  const saved = jobs.reconcile(lease.id, unknown.revision, {
    outcome: "succeeded",
    messageId: "message",
    result: { found: true },
  });
  assert.equal(saved.messageId, "message");
  assert.equal(saved.state, "succeeded");
  assert.equal(jobs.attempts(lease.id)[0].messageId, "message");
  assert.deepEqual(jobs.claim(), []);
});

test("uncertain work requires affirmative non-delivery before another attempt", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("not-delivered"));
  const [lease] = f.jobs.claim();
  f.jobs.beginAttempt(lease.id, lease.leaseToken);
  const unknown = f.jobs.unknown(lease.id, lease.leaseToken, "connection_lost");
  assert.throws(
    () =>
      f.jobs.reconcile(lease.id, unknown.revision, {
        outcome: "retry",
        notDelivered: false,
        at: 2000,
      }),
    code("invalid_input"),
  );
  const safe = f.jobs.reconcile(lease.id, unknown.revision, {
    outcome: "retry",
    notDelivered: true,
    at: 2000,
  });
  assert.equal(safe.state, "retry");
  assert.equal(f.jobs.attempts(lease.id)[0].error, "confirmed_not_delivered");
  assert.deepEqual(f.jobs.claim(), []);
  f.setNow(2000);
  assert.equal(f.jobs.claim()[0].attempts, 2);
});

test("cancellation before sending is final and invalidates a claimed worker", (t) => {
  const { jobs } = fixture(t);
  const pending = jobs.enqueue(input("pending"));
  assert.equal(jobs.cancel(pending.id).state, "cancelled");
  jobs.enqueue(input("claimed"));
  const [lease] = jobs.claim();
  assert.equal(jobs.cancel(lease.id).state, "cancelled");
  assert.throws(() => jobs.beginAttempt(lease.id, lease.leaseToken), code("stale_lease"));
  assert.deepEqual(jobs.claim(), []);
});

test("cancellation after a send starts remains explicit and preserves a successful result", (t) => {
  const { jobs } = fixture(t);
  jobs.enqueue(input("in-flight"));
  const [lease] = jobs.claim();
  jobs.beginAttempt(lease.id, lease.leaseToken);
  const requested = jobs.cancel(lease.id);
  assert.equal(requested.state, "running");
  assert.equal(requested.cancelRequested, true);
  const done = jobs.complete(lease.id, lease.leaseToken, { messageId: "already-sent" });
  assert.equal(done.state, "succeeded");
  assert.equal(done.cancelRequested, true);
  assert.equal(done.messageId, "already-sent");
});

test("cancelled unknown work does not resume after confirmed non-delivery", (t) => {
  const { jobs } = fixture(t);
  jobs.enqueue(input("cancel-unknown"));
  const [lease] = jobs.claim();
  jobs.beginAttempt(lease.id, lease.leaseToken);
  jobs.unknown(lease.id, lease.leaseToken, "timeout");
  const cancelled = jobs.cancel(lease.id);
  assert.equal(cancelled.state, "unknown");
  assert.equal(
    jobs.reconcile(lease.id, cancelled.revision, { outcome: "retry", notDelivered: true, at: 2000 })
      .state,
    "cancelled",
  );
  assert.deepEqual(jobs.claim(), []);
});

test("rate-limit delays do not consume ordinary retry budget", (t) => {
  const f = fixture(t);
  f.jobs.enqueue(input("rate-limit", { maxAttempts: 2 }));
  for (let count = 0; count < 2; count++) {
    const [lease] = f.jobs.claim();
    f.jobs.beginAttempt(lease.id, lease.leaseToken);
    const next = f.jobs.retry(lease.id, lease.leaseToken, {
      at: 2000 + count * 1000,
      error: "discord_429",
      rateLimited: true,
    });
    assert.equal(next.failures, 0);
    assert.equal(next.state, "retry");
    assert.deepEqual(f.jobs.claim(), []);
    f.setNow(2000 + count * 1000);
  }
  for (let count = 0; count < 2; count++) {
    const [lease] = f.jobs.claim();
    f.jobs.beginAttempt(lease.id, lease.leaseToken);
    const next = f.jobs.retry(lease.id, lease.leaseToken, {
      at: 4000 + count * 1000,
      error: "known_rejection",
    });
    assert.equal(next.failures, count + 1);
    assert.equal(next.state, count ? "failed" : "retry");
    f.setNow(4000 + count * 1000);
  }
  assert.deepEqual(f.jobs.list()[0].attempts, 4);
  assert.deepEqual(
    f.jobs.attempts(f.jobs.list()[0].id).map((entry) => entry.state),
    ["rate_limited", "rate_limited", "retry", "failed"],
  );
  assert.deepEqual(f.jobs.claim(), []);
});

test("expired deadlines skip unsent jobs but preserve ambiguity of an already started send", (t) => {
  const f = fixture(t);
  const missed = f.jobs.enqueue(input("missed", { expiresAt: 1100 }));
  const inFlight = f.jobs.enqueue(input("sending", { expiresAt: 1500 }));
  const lease = f.jobs.claim().find((entry) => entry.id === inFlight.id);
  f.jobs.beginAttempt(lease.id, lease.leaseToken);
  // The other claimed job has not begun external work.
  f.setNow(1600);
  assert.equal(f.jobs.expire(inFlight.id, lease.leaseToken).state, "unknown");
  assert.equal(f.jobs.get(missed.id).state, "running");
  f.setNow(40000);
  f.jobs.recover();
  assert.equal(f.jobs.get(missed.id).state, "expired");
  assert.equal(f.jobs.get(inFlight.id).state, "unknown");
  const later = f.jobs.enqueue(input("already-late", { expiresAt: 2000 }));
  assert.deepEqual(f.jobs.claim(), []);
  assert.equal(f.jobs.get(later.id).state, "expired");
});

test("attempt creation is idempotent for one lease and rejects a different nonce", (t) => {
  const { jobs } = fixture(t);
  jobs.enqueue(input("begin-twice"));
  const [lease] = jobs.claim();
  const first = jobs.beginAttempt(lease.id, lease.leaseToken, {
    nonce: "same",
    channelId: "channel",
  });
  assert.equal(
    jobs.beginAttempt(lease.id, lease.leaseToken, { nonce: "same", channelId: "channel" }).id,
    first.id,
  );
  assert.throws(
    () => jobs.beginAttempt(lease.id, lease.leaseToken, { nonce: "other", channelId: "channel" }),
    code("state_conflict"),
  );
  assert.equal(jobs.attempts(lease.id).length, 1);
});

test("two independent worker processes claim distinct bounded batches from one database", async (t) => {
  const f = fixture(t);
  for (let count = 0; count < 20; count++) f.jobs.enqueue(input("parallel-" + count));
  const module = pathToFileURL(resolve("dist/core/jobs/store.js")).href;
  const program = `import {DatabaseSync} from 'node:sqlite';import {JobStore} from ${JSON.stringify(module)};
    const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=5000');
    const jobs=new JobStore(db,()=>1000);console.log(JSON.stringify(jobs.claim().map(j=>j.id)));db.close();`;
  const worker = () =>
    new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", program, f.path], {
        windowsHide: true,
      });
      let output = "",
        error = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
      child.on("error", reject);
      child.on("exit", (status) => {
        if (status !== 0) {
          reject(Error(error));
          return;
        }
        try {
          resolveResult(JSON.parse(output));
        } catch (failure) {
          reject(failure);
        }
      });
    });
  const batches = await Promise.all([worker(), worker()]);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [10, 10],
  );
  assert.equal(new Set(batches.flat()).size, 20);
  assert.equal(f.jobs.list({ states: ["running"] }).length, 20);
});

test("invalid payloads and asynchronous transaction work cannot partially persist", (t) => {
  const { jobs, store } = fixture(t);
  for (const payload of [undefined, Number.NaN, new Date(), { secret: undefined }, BigInt(1)])
    assert.throws(() => jobs.enqueue(input("invalid", { payload })), code("invalid_input"));
  assert.throws(
    () =>
      jobs.transaction(() => {
        jobs.enqueue(input("async"));
        return Promise.resolve("not allowed");
      }),
    /synchronous/,
  );
  assert.equal(jobs.list().length, 0);
  assert.equal(store.db.isTransaction, false);
});
