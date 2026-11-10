import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { acquireLock } from "../dist/storage/lock.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import {
  initializeRulesDeletionJournal,
  drainRulesDeletionOutbox,
} from "../dist/storage/rules-deletion-journal.js";
import {
  recordRulesDeletion,
  rulesDeletionState,
  rulesDeletionRetentionMs,
} from "../dist/modules/server-rules/deletion-outbox.js";
import {
  openRulesDeletionLifecycle,
  pruneRulesDeletionLifecycle,
  rulesDeletionInstallationKey,
  sealRulesDeletionLifecycleSnapshot,
  snapshotRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";

const A = "100000000000000001",
  B = "200000000000000001",
  C = "300000000000000001",
  day = 86400000;
const code = (v) => (error) => error.code === v;
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-lifecycle-")),
    dataRoot = join(directory, "data");
  mkdirSync(dataRoot, { mode: 0o700 });
  const f = {
    directory,
    dataRoot,
    now: Date.parse("2026-11-10T12:00:00Z"),
    canonical: [],
    stores: new Map(),
    leases: new Map(),
    owned: false,
    forget: false,
  };
  f.path = (gid) => join(dataRoot, "guilds", gid, "gildiusz.sqlite");
  f.create = async (gid, canonical = true) => {
    const store = new Store(f.path(gid), gid);
    chmodSync(join(dataRoot, "guilds"), 0o700);
    chmodSync(dirname(store.path), 0o700);
    f.stores.set(gid, store);
    if (canonical && !f.canonical.some((i) => i.guildId === gid))
      f.canonical.push({ guildId: gid, databasePath: store.path });
    if (f.owned && !f.leases.has(gid))
      f.leases.set(gid, await acquireLock(store.path, { createTarget: false }));
    return store;
  };
  await f.create(A);
  await f.create(B);
  const initial = await initializeRulesDeletionJournal({
    dataRoot,
    installations: f.canonical,
    now: f.now,
  });
  f.initial = initial;
  f.rootRelease = await acquireDataRootLease(dataRoot);
  f.owned = true;
  for (const [gid, s] of f.stores)
    f.leases.set(gid, await acquireLock(s.path, { createTarget: false }));
  f.ownership = {
    assertHeld() {
      if (!f.owned) throw Object.assign(Error("writer_active"), { code: "writer_active" });
    },
    assertGuildLease(gid, path) {
      assert.equal(path, f.path(gid));
      if (!f.leases.has(gid))
        throw Object.assign(Error("guild_lease_required"), { code: "guild_lease_required" });
    },
    assertQuiescent() {
      assert.equal(f.owned, true);
    },
  };
  f.port = () =>
    openRulesDeletionLifecycle({
      dataRoot,
      clock: () => f.now,
      ownership: f.ownership,
      readCanonicalInstallations: () => f.canonical,
      mayForgetRetired: () => f.forget,
    });
  f.journal = () =>
    JSON.parse(readFileSync(join(dataRoot, "rules-acceptance-deletions", "journal.json"), "utf8"));
  f.jobs = () =>
    [...f.stores].map(([guildId, store]) => ({ guildId, jobs: new JobStore(store.db) }));
  f.add = (gid, id = randomUUID()) => {
    const db = f.stores.get(gid).db;
    new JobStore(db).transaction(() => {
      recordRulesDeletion(db, gid, id, f.now, f.now + rulesDeletionRetentionMs);
      db.prepare("INSERT INTO server_rules_retired_acceptances VALUES(?,?,?,?)").run(
        gid,
        id,
        f.now,
        f.now + rulesDeletionRetentionMs,
      );
    });
    return id;
  };
  f.admit = (gid, extra = {}) =>
    f.port().admitPristine({
      guildId: gid,
      store: f.stores.get(gid),
      operationId: extra.operationId ?? randomUUID(),
      checkFence: () => true,
      ...extra,
    });
  f.close = (gid) => {
    const store = f.stores.get(gid);
    store?.close();
    f.stores.delete(gid);
  };
  f.pending = (gid, phase = "committed") => {
    const stat = lstatSync(f.path(gid), { bigint: true }),
      value = {
        format: 1,
        guildId: gid,
        removedAt: f.now - 30 * day,
        phase,
        public: true,
        databasePath: f.path(gid),
        databaseIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
        assetNames: [],
      };
    mkdirSync(join(dataRoot, "uninstall-retention"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dataRoot, "uninstall-retention", gid + ".pending.json"),
      JSON.stringify(value),
      { mode: 0o600 },
    );
    return value;
  };
  f.deleteFiles = (gid, pending) => {
    for (const suffix of ["-wal", "-shm", ""]) {
      try {
        unlinkSync(f.path(gid) + suffix);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    pending.phase = "registry_done";
    writeFileSync(
      join(dataRoot, "uninstall-retention", gid + ".pending.json"),
      JSON.stringify(pending),
    );
    writeFileSync(
      join(dataRoot, "uninstall-retention", gid + ".deleted.json"),
      JSON.stringify({
        format: 1,
        guildId: gid,
        removedAt: pending.removedAt,
        purgedAt: f.now,
        outcome: "purged",
      }),
      { mode: 0o600 },
    );
    f.canonical = f.canonical.filter((i) => i.guildId !== gid);
  };
  f.retire = async (gid) => {
    const active = f.journal().active.find((i) => i.guildId === gid),
      operationId = randomUUID(),
      pending = f.pending(gid);
    f.close(gid);
    await f.port().prepareRetirement({ guildId: gid, expectedEpoch: active.epoch, operationId });
    f.deleteFiles(gid, pending);
    await f.port().confirmRetired({ guildId: gid, expectedEpoch: active.epoch, operationId });
    return { epoch: active.epoch, operationId, pending, purgedAt: f.now };
  };
  f.release = async () => {
    for (const gid of [...f.stores.keys()]) f.close(gid);
    for (const release of f.leases.values()) await release();
    f.leases.clear();
    if (f.owned) {
      f.owned = false;
      await f.rootRelease();
    }
  };
  t.after(async () => {
    await f.release();
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}

test("explicit upgrade guards old readers before journal2 and preserves all source/coverage/UUID state", async (t) => {
  const f = await fixture(t),
    id = f.add(A);
  await drainRulesDeletionOutbox({ dataRoot: f.dataRoot, stores: f.jobs(), now: f.now });
  const before = f.journal();
  let sawGuard = false;
  await f.port().upgradeFormat1({
    checkFence: () => true,
    checkpoint(stage) {
      if (stage === "policy_durable") {
        sawGuard = true;
        assert.equal(f.journal().format, 1);
        assert.equal(
          JSON.parse(readFileSync(join(f.dataRoot, "uninstall-retention", "source-policy.json")))
            .sourceId,
          before.sourceId,
        );
      }
    },
  });
  assert.equal(sawGuard, true);
  const j = f.journal();
  assert.equal(j.format, 2);
  assert.equal(j.sourceId, before.sourceId);
  assert.equal(j.coveredFrom, before.coveredFrom);
  assert.equal(j.createdAt, before.createdAt);
  assert.deepEqual(j.entries, before.entries);
  assert.ok(j.entries.some((e) => e.acceptanceId === id));
  const snapshot = await f.port().snapshot();
  assert.equal(snapshot.complete, true);
  const sequence = snapshot.sequence;
  await f.port().snapshot();
  assert.equal(f.journal().sequence, sequence);
  assert.equal((await f.port().sealSnapshot()).sequence, sequence + 1);
  await assert.rejects(
    drainRulesDeletionOutbox({ dataRoot: f.dataRoot, stores: f.jobs(), now: f.now }),
    /journal/,
  );
});
test("upgrade crash at policy, intent or one DB seed is replay-safe and never gives an incomplete source a complete snapshot", async (t) => {
  for (const stage of ["policy_durable", "intents_durable", "db_seeded"]) {
    const f = await fixture(t);
    let crashed = false;
    await assert.rejects(
      f.port().upgradeFormat1({
        checkFence: () => true,
        checkpoint(actual) {
          if (actual === stage && !crashed) {
            crashed = true;
            throw Error("fixture crash");
          }
        },
      }),
      /fixture crash/,
    );
    if (stage === "policy_durable") {
      assert.equal(f.journal().format, 1);
      await f.port().upgradeFormat1({ checkFence: () => true });
    } else {
      assert.equal((await f.port().snapshot()).complete, false);
      await f.port().recoverPending({ checkFence: () => true });
    }
    assert.equal((await f.port().snapshot()).complete, true);
    assert.equal(f.journal().active.length, 2);
    assert.equal(f.journal().sourceId, f.initial.sourceId);
  }
});
test("pristine admission has one durable intent/seed/active epoch across both crash boundaries and revoked fences", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  await f.create(C);
  const operationId = randomUUID(),
    before = f.journal();
  await assert.rejects(
    f.admit(C, {
      operationId,
      checkpoint(stage) {
        if (stage === "intent_durable") throw Error("intent crash");
      },
    }),
    /intent crash/,
  );
  const intent = f.journal().admitting[0];
  assert.equal(
    f.stores
      .get(C)
      .db.prepare("SELECT 1 FROM resources WHERE key=?")
      .get(rulesDeletionInstallationKey),
    undefined,
  );
  assert.equal((await f.port().snapshot()).complete, false);
  await assert.rejects(
    f.admit(C, {
      operationId,
      checkpoint(stage) {
        if (stage === "db_seeded") throw Error("seed crash");
      },
    }),
    /seed crash/,
  );
  assert.equal(f.journal().admitting[0].epoch, intent.epoch);
  await f.port().recoverPending({ checkFence: () => true });
  assert.equal(f.journal().active.find((a) => a.guildId === C).epoch, intent.epoch);
  assert.equal(f.journal().coveredFrom, before.coveredFrom);
  assert.equal((await f.port().snapshot()).complete, true);
  const replay = await f.admit(C);
  assert.equal(replay.epoch, intent.epoch);
});
test("non-pristine, foreign identities, untracked inventory, missing lease and obsolete fences never seed or activate", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  await f.create(C);
  const db = f.stores.get(C).db;
  db.prepare("INSERT INTO events VALUES(?,0,'fixture','member','old',NULL,NULL)").run(randomUUID());
  await assert.rejects(f.admit(C), code("not_pristine"));
  assert.equal(f.journal().admitting.length, 0);
  db.exec("DELETE FROM events");
  await assert.rejects(f.admit(C, { checkFence: () => false }), code("operation_obsolete"));
  const held = f.leases.get(C);
  f.leases.delete(C);
  await assert.rejects(f.admit(C), code("guild_lease_required"));
  f.leases.set(C, held);
  db.prepare("UPDATE guild_identity SET guild=?").run(B);
  await assert.rejects(f.admit(C));
  assert.equal(
    f.journal().active.some((a) => a.guildId === C),
    false,
  );
});
test("retire binds the old inode/epoch/pending journal and requires durable matching whole-guild evidence", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  const id = f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  const active = f.journal().active.find((a) => a.guildId === A),
    operationId = randomUUID(),
    pending = f.pending(A);
  f.close(A);
  await f.port().prepareRetirement({ guildId: A, expectedEpoch: active.epoch, operationId });
  await assert.rejects(
    f.port().confirmRetired({ guildId: A, expectedEpoch: active.epoch, operationId }),
  );
  assert.equal((await f.port().snapshot()).complete, false);
  f.deleteFiles(A, pending);
  await f.port().confirmRetired({ guildId: A, expectedEpoch: active.epoch, operationId });
  const scope = await f.port().snapshot();
  assert.equal(scope.complete, true);
  assert.deepEqual(
    scope.active.map((a) => a.guildId),
    [B],
  );
  assert.deepEqual(scope.guildIds, [A, B]);
  assert.equal(scope.retired[0].outcome, "purged");
  assert.ok(scope.entries.some((e) => e.acceptanceId === id));
  const before = f.journal();
  await f.port().confirmRetired({ guildId: A, expectedEpoch: active.epoch, operationId });
  assert.deepEqual(f.journal(), before);
});
test("rejoin uses a new epoch and a retained counter floor, while stale retire callbacks cannot close the new installation", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  const oldId = f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  f.now++;
  const old = await f.retire(A);
  f.now++;
  await f.create(A);
  const admission = await f.admit(A);
  assert.notEqual(admission.epoch, old.epoch);
  assert.equal(admission.baseSequence, 1);
  assert.equal(rulesDeletionState(f.stores.get(A).db, A).sequence, 1);
  const id = f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  const scope = await f.port().snapshot();
  assert.equal(scope.complete, true);
  assert.deepEqual(
    scope.entries.filter((e) => e.guildId === A).map((e) => e.sequence),
    [1, 2],
  );
  assert.ok(scope.entries.some((e) => e.acceptanceId === oldId));
  assert.ok(scope.entries.some((e) => e.acceptanceId === id));
  await assert.rejects(
    f.port().confirmRetired({ guildId: A, expectedEpoch: old.epoch, operationId: old.operationId }),
    code("operation_obsolete"),
  );
});
test("hard35 removes IDs and terminal guild state atomically with a monotonic GID-free global gap", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  const old = await f.retire(A);
  f.now += 35 * day;
  const result = await f.port().pruneExpired();
  assert.equal(result.blocked, true);
  const j = f.journal();
  assert.equal(j.retired.length, 0);
  assert.equal(j.entries.length, 0);
  assert.equal(JSON.stringify(j).includes(A), false);
  assert.equal(j.globalGap.unsafeBefore, old.purgedAt);
  assert.equal(result.expiredRetired.length, 1);
  assert.equal(result.expiredRetired[0].guildId, A);
  assert.equal(result.sequence, j.sequence);
  assert.equal(result.sourceId, j.sourceId);
  assert.equal(j.sourceId, f.initial.sourceId);
  assert.equal(j.coveredFrom, f.initial.coveredFrom);
  assert.equal((await f.port().snapshot()).complete, false);
  f.now++;
  await f.create(A);
  const admitted = await f.admit(A);
  assert.equal(admitted.baseSequence, 0);
  assert.equal(f.journal().globalGap.unsafeBefore, old.purgedAt);
  await assert.rejects(f.port().sealSnapshot(), code("source_incomplete"));
});
test("zero inventory keeps the source header and can be complete only after trusted terminal retirement", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  await f.retire(A);
  f.now++;
  await f.retire(B);
  f.now += 35 * day;
  f.forget = true;
  const result = await f.port().pruneExpired();
  assert.equal(result.blocked, false);
  const scope = await f.port().snapshot();
  assert.deepEqual(scope.guildIds, []);
  assert.deepEqual(scope.active, []);
  assert.deepEqual(scope.retired, []);
  assert.equal(scope.complete, true);
  assert.equal(scope.sourceId, f.initial.sourceId);
});
test("missing/conflicting downgrade guard and unverified legacy gap refuse enrollment, while valid journal2 TTL still runs", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  const path = join(f.dataRoot, "uninstall-retention", "source-policy.json"),
    guard = readFileSync(path);
  unlinkSync(path);
  await assert.rejects(f.port().pruneExpired(), code("source_policy_missing"));
  writeFileSync(path, guard);
  const value = JSON.parse(guard);
  value.sourceId = randomUUID();
  writeFileSync(path, JSON.stringify(value));
  await assert.rejects(f.port().snapshot(), code("source_policy_conflict"));
  writeFileSync(path, guard);
  const id = f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  writeFileSync(join(f.dataRoot, "uninstall-retention", "source-gap.json"), "unverified");
  assert.equal((await f.port().snapshot()).complete, false);
  await assert.rejects(f.port().sealSnapshot(), code("legacy_retention_gap"));
  f.now += 35 * day;
  const result = await f.port().pruneExpired();
  assert.equal(result.blocked, true);
  assert.equal(JSON.stringify(f.journal()).includes(id), false);
  assert.equal(
    readFileSync(join(f.dataRoot, "uninstall-retention", "source-gap.json"), "utf8"),
    "unverified",
  );
});
test("quiescent snapshot refuses a live writer and does not bump status; root-only TTL helper needs no missing DB", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  await assert.rejects(
    snapshotRulesDeletionLifecycle({
      dataRoot: f.dataRoot,
      installations: f.canonical,
      now: f.now,
    }),
    code("writer_active"),
  );
  await f.release();
  const before = f.journal().sequence,
    scope = await snapshotRulesDeletionLifecycle({
      dataRoot: f.dataRoot,
      installations: f.canonical,
      now: f.now,
    });
  assert.equal(scope.sequence, before);
  const sealed = await sealRulesDeletionLifecycleSnapshot(
    { dataRoot: f.dataRoot, installations: f.canonical, now: f.now },
    (view, root) => ({ view, root }),
  );
  assert.equal(sealed.view.sequence, before + 1);
  const result = await pruneRulesDeletionLifecycle({ dataRoot: f.dataRoot, now: f.now });
  assert.equal(result.scopesRemoved, 0);
});

test("expired admission cannot seed SQLite or revive scope before prune writes its blocker", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  await f.create(C);
  const operationId = randomUUID();
  await assert.rejects(
    f.admit(C, {
      operationId,
      checkpoint(stage) {
        if (stage === "intent_durable") throw Error("crash");
      },
    }),
    /crash/,
  );
  f.now += 35 * day;
  await assert.rejects(f.admit(C, { operationId }), code("lifecycle_expired"));
  assert.equal(
    f.stores
      .get(C)
      .db.prepare("SELECT 1 FROM resources WHERE key=?")
      .get(rulesDeletionInstallationKey),
    undefined,
  );
  const result = await f.port().pruneExpired();
  assert.equal(result.blocked, true);
  assert.equal(f.journal().admitting.length, 0);
  assert.equal(f.journal().globalGap.reason, "admission_expired");
});
test("expired retirement cannot be confirmed with a late proof and consecutive cleanup keeps unsafeBefore monotonic", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  const scope = f.journal().active.find((r) => r.guildId === A),
    operationId = randomUUID(),
    pending = f.pending(A);
  f.close(A);
  await f.port().prepareRetirement({ guildId: A, expectedEpoch: scope.epoch, operationId });
  f.now += day;
  const b = await f.retire(B);
  f.now += 34 * day;
  f.deleteFiles(A, pending);
  await assert.rejects(
    f.port().confirmRetired({ guildId: A, expectedEpoch: scope.epoch, operationId }),
    code("lifecycle_expired"),
  );
  await f.port().pruneExpired();
  const first = f.journal().globalGap.unsafeBefore;
  f.now += day;
  await f.port().pruneExpired();
  assert.ok(f.journal().globalGap.unsafeBefore >= first);
  assert.equal(f.journal().globalGap.unsafeBefore, b.purgedAt);
});
test("a live rejoin keeps its newer UUID/counter when the older terminal scope reaches its deadline", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  const retired = await f.retire(A);
  f.now += day;
  await f.create(A);
  await f.admit(A);
  const id = f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  f.now = retired.purgedAt + 35 * day;
  f.forget = true;
  await f.port().pruneExpired();
  const j = f.journal();
  assert.equal(j.retired.length, 0);
  assert.ok(j.entries.some((e) => e.acceptanceId === id));
  assert.equal(j.active.find((a) => a.guildId === A).through, 2);
  assert.equal((await f.port().snapshot()).complete, true);
});

test("pre-open classification refuses a missing or replaced active DB before Store could recreate it", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  f.close(A);
  const replacement = join(f.directory, "replacement.sqlite");
  copyFileSync(f.path(A), replacement);
  unlinkSync(f.path(A));
  await assert.rejects(
    f.port().classifyBeforeOpen({ guildId: A, databasePath: f.path(A) }),
    code("installation_file_missing"),
  );
  renameSync(replacement, f.path(A));
  await assert.rejects(
    f.port().classifyBeforeOpen({ guildId: A, databasePath: f.path(A) }),
    code("installation_file_changed"),
  );
});
test("an active epoch cannot silently accept an older counter snapshot", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  f.stores
    .get(A)
    .db.exec(
      "DELETE FROM server_rules_deletion_outbox;DELETE FROM server_rules_retired_acceptances;UPDATE server_rules_deletion_state SET sequence=0,journaled_through=0",
    );
  await assert.rejects(f.admit(A), code("source_gap"));
  assert.equal((await f.port().snapshot()).complete, false);
});

test("outbox expiry during journal fsync cannot ACK a now-expired UUID in either journal format", async (t) => {
  for (const format of [1, 2]) {
    const f = await fixture(t);
    if (format === 2) await f.port().upgradeFormat1({ checkFence: () => true });
    f.add(A);
    f.now += 35 * day - 1;
    const original = Date.now;
    Date.now = () => f.now;
    try {
      const checkpoint = () => {
        f.now++;
      };
      await assert.rejects(
        format === 2
          ? f.port().drainActiveOutbox({ stores: f.jobs(), checkpoint })
          : drainRulesDeletionOutbox({ dataRoot: f.dataRoot, stores: f.jobs(), checkpoint }),
        code("source_changed"),
      );
      assert.equal(rulesDeletionState(f.stores.get(A).db, A).journaledThrough, 0);
    } finally {
      Date.now = original;
    }
  }
});

test("status snapshot is read-only when a crashed journal staging file needs maintenance", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  const path = join(f.dataRoot, "rules-acceptance-deletions", randomUUID() + ".tmp"),
    before = readFileSync(join(f.dataRoot, "rules-acceptance-deletions", "journal.json"));
  writeFileSync(path, "orphan", { mode: 0o600 });
  await assert.rejects(f.port().snapshot(), code("journal_staging_pending"));
  assert.equal(readFileSync(path, "utf8"), "orphan");
  assert.equal(
    readFileSync(join(f.dataRoot, "rules-acceptance-deletions", "journal.json")).equals(before),
    true,
  );
  await f.port().pruneExpired();
  assert.equal((await f.port().snapshot()).complete, true);
});
test("global gap resolution is explicit, preserves source/coverage and rechecks current canonical inventory", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  await f.retire(A);
  f.now += 35 * day;
  await f.port().pruneExpired();
  const before = f.journal();
  assert.equal((await f.port().resolveGlobalGap()).resolved, false);
  assert.equal((await f.port().resolveGlobalGap({ mayResolve: () => false })).resolved, false);
  assert.deepEqual(f.journal(), before);
  const canonical = f.canonical;
  f.canonical = [];
  assert.equal((await f.port().resolveGlobalGap({ mayResolve: () => true })).resolved, false);
  f.canonical = canonical;
  const result = await f.port().resolveGlobalGap({ mayResolve: () => true });
  assert.equal(result.resolved, true);
  assert.equal(f.journal().sequence, before.sequence + 1);
  assert.equal(f.journal().sourceId, before.sourceId);
  assert.equal(f.journal().coveredFrom, before.coveredFrom);
  assert.equal(f.journal().globalGap, null);
});
test("a legal crash before ACK recovers by draining before the active-ready check", async (t) => {
  const f = await fixture(t);
  await f.port().upgradeFormat1({ checkFence: () => true });
  f.add(A);
  await assert.rejects(
    f.port().drainActiveOutbox({
      stores: f.jobs(),
      checkpoint() {
        throw Error("ACK crash");
      },
    }),
    /ACK crash/,
  );
  await assert.rejects(f.admit(A), code("source_gap"));
  assert.deepEqual(await f.port().drainActiveOutbox({ stores: f.jobs() }), {
    written: 0,
    acknowledged: 1,
    pending: false,
  });
  assert.equal((await f.admit(A)).state, "active");
  assert.equal((await f.port().snapshot()).complete, true);
});

test("unsigned missing-bridge marker blocks upgrade and latest by presence but never suppresses owned TTL", async (t) => {
  const f = await fixture(t),
    path = join(f.dataRoot, "uninstall-retention", "source-gap-unverified.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "unverified and deliberately not JSON", { mode: 0o600 });
  await assert.rejects(
    f.port().upgradeFormat1({ checkFence: () => true }),
    code("unverified_retention_gap"),
  );
  assert.equal(f.journal().format, 1);
  unlinkSync(path);
  await f.port().upgradeFormat1({ checkFence: () => true });
  const id = f.add(A);
  await f.port().drainActiveOutbox({ stores: f.jobs() });
  await f.retire(A);
  const marker = {
    format: 1,
    kind: "gildiusz-retention-source-gap-unverified",
    blockedSince: f.now,
    unsafeBefore: f.now,
    reason: "lifecycle_unavailable",
  };
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
  assert.ok((await f.port().snapshot()).blockers.includes("unverified_retention_gap"));
  await assert.rejects(f.port().sealSnapshot(), code("unverified_retention_gap"));
  await assert.rejects(
    f.port().resolveGlobalGap({ mayResolve: () => true }),
    code("unverified_retention_gap"),
  );
  f.now += 35 * day;
  const result = await f.port().pruneExpired();
  assert.equal(result.blocked, true);
  assert.equal(JSON.stringify(f.journal()).includes(id), false);
  assert.equal(f.journal().retired.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(path)), marker);
});
