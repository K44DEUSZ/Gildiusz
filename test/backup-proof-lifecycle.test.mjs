import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import { acquireLock } from "../dist/storage/lock.js";
import { initializeRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import {
  openRulesDeletionLifecycle,
  upgradeRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";
import { recordRulesDeletion } from "../dist/modules/server-rules/deletion-outbox.js";
import {
  importLatestDeletionProof,
  pruneImportedDeletionProofs,
  sealLatestDeletionProof,
  verifyLatestDeletionProof,
} from "../scripts/backup-proof.mjs";
import {
  retireSourceDeletionLedgers,
  sealLatestDeletionLedger,
} from "../scripts/backup-ledger.mjs";
import { readDeletionState } from "../scripts/backup-deletion-state.mjs";

const A = "100000000000000001",
  B = "200000000000000001",
  day = 86400000;
const fails = (code) => (error) => error.code === code;
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-proof-lifecycle-")),
    dataRoot = join(root, "data"),
    key = randomBytes(32),
    stores = new Map();
  mkdirSync(dataRoot, { mode: 0o700 });
  const f = {
    root,
    dataRoot,
    key,
    stores,
    now: Date.parse("2026-11-10T12:00:00Z"),
    installations: [],
  };
  f.path = (gid) => join(dataRoot, "guilds", gid, "gildiusz.sqlite");
  f.journal = () =>
    JSON.parse(readFileSync(join(dataRoot, "rules-acceptance-deletions", "journal.json"), "utf8"));
  f.create = (gid) => {
    const store = new Store(f.path(gid), gid);
    chmodSync(join(dataRoot, "guilds"), 0o700);
    chmodSync(dirname(store.path), 0o700);
    stores.set(gid, store);
    f.installations.push({ guildId: gid, databasePath: store.path });
    return store;
  };
  f.create(A);
  f.create(B);
  await initializeRulesDeletionJournal({ dataRoot, installations: f.installations, now: f.now });
  await upgradeRulesDeletionLifecycle({ dataRoot, installations: f.installations, now: f.now });
  f.owned = async (work) => {
    const release = await acquireDataRootLease(dataRoot),
      held = new Map();
    let owned = true;
    try {
      for (const i of f.installations)
        held.set(i.guildId, await acquireLock(i.databasePath, { createTarget: false }));
      const port = openRulesDeletionLifecycle({
        dataRoot,
        clock: () => f.now,
        readCanonicalInstallations: () => f.installations,
        ownership: {
          assertHeld() {
            assert.equal(owned, true);
          },
          assertGuildLease(gid) {
            assert.equal(held.has(gid), true);
          },
          assertQuiescent() {
            assert.equal(owned, true);
          },
        },
      });
      return await work(port);
    } finally {
      owned = false;
      for (const stop of held.values()) await stop();
      await release();
    }
  };
  f.add = (gid) => {
    const id = randomUUID(),
      store = stores.get(gid);
    new JobStore(store.db).transaction(() =>
      recordRulesDeletion(store.db, gid, id, f.now, f.now + 35 * day),
    );
    return id;
  };
  f.drain = () =>
    f.owned((port) =>
      port.drainActiveOutbox({
        stores: [...stores].map(([guildId, store]) => ({ guildId, jobs: new JobStore(store.db) })),
      }),
    );
  f.retire = (gid) =>
    f.owned(async (port) => {
      const row = f.journal().active.find((e) => e.guildId === gid),
        operationId = randomUUID(),
        stat = lstatSync(f.path(gid), { bigint: true });
      const pending = {
        format: 1,
        guildId: gid,
        removedAt: f.now - 30 * day,
        phase: "committed",
        public: true,
        databasePath: f.path(gid),
        databaseIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
        assetNames: [],
      };
      mkdirSync(join(dataRoot, "uninstall-retention"), { recursive: true, mode: 0o700 });
      const pendingPath = join(dataRoot, "uninstall-retention", `${gid}.pending.json`);
      writeFileSync(pendingPath, JSON.stringify(pending), { mode: 0o600 });
      stores.get(gid).close();
      stores.delete(gid);
      await port.prepareRetirement({ guildId: gid, expectedEpoch: row.epoch, operationId });
      for (const suffix of ["-wal", "-shm", ""])
        try {
          unlinkSync(f.path(gid) + suffix);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      pending.phase = "registry_done";
      writeFileSync(pendingPath, JSON.stringify(pending));
      const decision = {
        format: 1,
        guildId: gid,
        removedAt: pending.removedAt,
        purgedAt: f.now,
        outcome: "purged",
      };
      writeFileSync(
        join(dataRoot, "uninstall-retention", `${gid}.deleted.json`),
        JSON.stringify(decision),
        { mode: 0o600 },
      );
      f.installations = f.installations.filter((i) => i.guildId !== gid);
      await port.confirmRetired({ guildId: gid, expectedEpoch: row.epoch, operationId });
      unlinkSync(pendingPath);
      return decision;
    });
  f.seal = () =>
    sealLatestDeletionProof({
      dataRoot,
      installations: f.installations,
      key,
      now: f.now,
      notBefore: f.now,
      challenge: randomUUID(),
    });
  f.verify = (sealed) =>
    verifyLatestDeletionProof({ envelope: sealed.envelope, key, now: f.now, maxAgeMs: 60000 });
  f.evidence = () => ({
    knownLocationIds: ["host", "pc"],
    maxLocationAgeMs: 60000,
    canonicalInventory: { verifiedAt: f.now, complete: true, unknown: 0, untracked: 0 },
    locations: ["host", "pc"].map((id) => ({
      id,
      verifiedAt: f.now,
      complete: true,
      unknown: 0,
      inProgress: 0,
      copies: [],
    })),
  });
  f.import = (sealed) =>
    importLatestDeletionProof({
      directory: join(root, "offsite"),
      envelope: sealed.envelope,
      key,
      now: f.now,
      maxAgeMs: 60000,
      retirementEvidence: f.evidence(),
    });
  t.after(() => {
    for (const store of stores.values()) store.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test("authoritative active plus retired coverage signs active IDs only and retains retired acceptance UUIDs", async (t) => {
  const f = await fixture(t),
    aBefore = f.stores.get(A).db.prepare("SELECT * FROM guild_identity").all(),
    id = f.add(B);
  await f.drain();
  const retired = await f.retire(B),
    proof = f.verify(await f.seal()).proof;
  assert.deepEqual(proof.guildIds, [A]);
  assert.deepEqual(proof.guilds, [retired]);
  assert.equal(proof.acceptances[0].acceptanceId, id);
  assert.equal(proof.acceptances[0].guildId, B);
  assert.deepEqual(f.stores.get(A).db.prepare("SELECT * FROM guild_identity").all(), aBefore);
  await assert.rejects(
    sealLatestDeletionLedger({ dataRoot: f.dataRoot, key: f.key, now: f.now }),
    fails("source_requires_v2"),
  );
});

test("loss of the committed encrypted head cannot accept a higher complete source without physical inventory evidence", async (t) => {
  const f = await fixture(t),
    id = f.add(B);
  await f.drain();
  const first = await f.import(await f.seal()),
    directory = join(f.root, "offsite");
  unlinkSync(first.file);
  unlinkSync(join(directory, "latest-proof.json"));
  f.now++;
  const next = await f.seal();
  await assert.rejects(
    importLatestDeletionProof({
      directory,
      envelope: next.envelope,
      key: f.key,
      now: f.now,
      maxAgeMs: 60000,
    }),
    fails("operator_block"),
  );
  const state = readDeletionState({ directory, key: f.key, now: f.now });
  assert.equal(state.minSequence, first.meta.sequence);
  assert.equal(state.globalGap.reason, "source_gap");
  assert.equal(existsSync(join(directory, `deletion-proof-${next.meta.id}.gldproof`)), false);
  const marker = readFileSync(join(directory, "deletion-watermark.json"), "utf8");
  for (const value of [A, B, id]) assert.equal(marker.includes(value), false);
  await f.import(next);
  assert.equal(readDeletionState({ directory, key: f.key, now: f.now }).globalGap, null);
});

test("complete empty latest retains source and counter after safe hard35 retirement", async (t) => {
  const f = await fixture(t);
  await f.retire(B);
  await f.retire(A);
  const first = await f.seal();
  await f.import(first);
  const original = f.journal();
  f.now += 35 * day;
  const result = await retireSourceDeletionLedgers({
    dataRoot: f.dataRoot,
    key: f.key,
    now: f.now,
    ...f.evidence(),
  });
  assert.equal(result.state, "retired");
  assert.equal(result.retiredCount, 2);
  const latest = await f.seal(),
    proof = f.verify(latest).proof;
  assert.deepEqual(proof.guildIds, []);
  assert.deepEqual(proof.guilds, []);
  assert.deepEqual(proof.acceptances, []);
  assert.equal(proof.sourceId, original.sourceId);
  assert.equal(proof.coveredFrom, original.coveredFrom);
  assert.ok(proof.sequence > first.meta.sequence);
  await f.import(latest);
  const state = readDeletionState({ directory: join(f.root, "offsite"), key: f.key, now: f.now });
  assert.equal(state.minSequence, proof.sequence);
  assert.equal(state.globalGap, null);
  assert.deepEqual(
    readdirSync(join(f.root, "offsite")).filter((n) => n.endsWith(".gldproof")),
    [`deletion-proof-${latest.meta.id}.gldproof`],
  );
});

test("offline inventory cannot extend terminal identifiers; source and offsite retain only global blockers", async (t) => {
  const f = await fixture(t),
    id = f.add(B);
  await f.drain();
  await f.retire(B);
  await f.retire(A);
  const old = await f.seal();
  await f.import(old);
  f.now += 35 * day;
  const result = await retireSourceDeletionLedgers({
    dataRoot: f.dataRoot,
    key: f.key,
    now: f.now,
  });
  assert.equal(result.state, "operator_block");
  assert.equal(result.retiredCount, 2);
  const journal = JSON.stringify(f.journal());
  for (const text of [A, B, id]) assert.equal(journal.includes(text), false);
  assert.equal(f.journal().globalGap !== null, true);
  await assert.rejects(f.seal(), fails("source_incomplete"));
  const pc = await pruneImportedDeletionProofs({
    directory: join(f.root, "offsite"),
    key: f.key,
    now: f.now,
  });
  assert.equal(pc.blocked, true);
  assert.equal(pc.removed, 1);
  const state = readFileSync(join(f.root, "offsite", "deletion-watermark.json"), "utf8");
  for (const text of [A, B, id]) assert.equal(state.includes(text), false);
  await assert.rejects(
    sealLatestDeletionLedger({ dataRoot: f.dataRoot, key: f.key, now: f.now }),
    fails("source_requires_v2"),
  );
});

test("rejoin and a second genuine purge supersede the tuple without renewing the original UUID lifetime", async (t) => {
  const f = await fixture(t),
    id = f.add(B);
  await f.drain();
  const firstTuple = await f.retire(B),
    first = await f.seal();
  await f.import(first);
  const original = f.verify(first).proof.acceptances.find((e) => e.acceptanceId === id);
  f.now++;
  f.create(B);
  await f.owned((port) =>
    port.admitPristine({
      guildId: B,
      store: f.stores.get(B),
      operationId: randomUUID(),
      checkFence: () => true,
    }),
  );
  const newer = f.add(B);
  await f.drain();
  const rejoined = f.verify(await f.seal()).proof;
  assert.deepEqual(rejoined.guildIds, [A, B]);
  f.now += 30 * day;
  const nextTuple = await f.retire(B);
  assert.equal(nextTuple.removedAt >= firstTuple.purgedAt, true);
  assert.equal(nextTuple.purgedAt > firstTuple.purgedAt, true);
  const next = await f.seal(),
    proof = f.verify(next).proof;
  assert.deepEqual(proof.guilds, [nextTuple]);
  assert.deepEqual(
    proof.acceptances.find((e) => e.acceptanceId === id),
    original,
  );
  assert.ok(proof.acceptances.find((e) => e.acceptanceId === newer).sequence > original.sequence);
  await f.import(next);
  assert.equal(
    existsSync(join(f.root, "offsite", `deletion-proof-${first.meta.id}.gldproof`)),
    false,
  );
});
