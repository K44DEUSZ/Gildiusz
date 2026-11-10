import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID, createDecipheriv, createCipheriv, hkdfSync } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  linkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { ServerRulesRetention } from "../dist/modules/server-rules/retention.js";
import {
  recordRulesDeletion,
  pendingRulesDeletions,
  rulesDeletionState,
  expireRulesDeletions,
  rulesDeletionRetentionMs,
} from "../dist/modules/server-rules/deletion-outbox.js";
import {
  initializeRulesDeletionJournal,
  drainRulesDeletionOutbox,
  pruneRulesDeletionJournal,
} from "../dist/storage/rules-deletion-journal.js";
import {
  openRulesDeletionLifecycle,
  upgradeRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import { acquireLock } from "../dist/storage/lock.js";
import {
  sealLatestDeletionProof,
  verifyLatestDeletionProof,
  importLatestDeletionProof,
  sealLatestDeletionLedger,
  verifyLatestDeletionLedger,
} from "../scripts/backup-ledger.mjs";

const A = "100000000000000001",
  B = "200000000000000001",
  user = "100000000000000003",
  day = 86400000;
const code = (v) => (error) => error.code === v;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-proof-")),
    dataRoot = join(directory, "data"),
    key = randomBytes(32);
  mkdirSync(dataRoot, { mode: 0o700 });
  const installations = [A, B].map((guildId) => ({
    guildId,
    databasePath: join(dataRoot, "guilds", guildId, "gildiusz.sqlite"),
  }));
  const stores = installations.map((i) => new Store(i.databasePath, i.guildId));
  for (const i of installations) {
    chmodSync(join(dataRoot, "guilds"), 0o700);
    chmodSync(join(dataRoot, "guilds", i.guildId), 0o700);
  }
  const f = {
    directory,
    dataRoot,
    key,
    installations,
    stores,
    now: Date.parse("2026-11-10T12:00:00Z"),
    jobs() {
      return f.stores.map((s, i) => ({
        guildId: installations[i].guildId,
        jobs: new JobStore(s.db, { clock: () => f.now }),
      }));
    },
    reopen() {
      for (const s of f.stores) s.db.close();
      f.stores = installations.map((i) => new Store(i.databasePath, i.guildId));
    },
    init() {
      return initializeRulesDeletionJournal({ dataRoot, installations, now: f.now });
    },
    async drain(extra = {}) {
      if (f.journal().format !== 2)
        return drainRulesDeletionOutbox({ dataRoot, stores: f.jobs(), now: f.now, ...extra });
      const release = await acquireDataRootLease(dataRoot),
        held = new Map();
      let owned = true;
      try {
        for (const i of installations)
          held.set(i.guildId, await acquireLock(i.databasePath, { createTarget: false }));
        const port = openRulesDeletionLifecycle({
          dataRoot,
          clock: () => f.now,
          readCanonicalInstallations: () => installations,
          ownership: {
            assertHeld() {
              assert.equal(owned, true);
            },
            assertGuildLease(guildId) {
              assert.equal(held.has(guildId), true);
            },
            assertQuiescent() {
              assert.equal(owned, true);
            },
          },
        });
        return await port.drainActiveOutbox({ stores: f.jobs(), ...extra });
      } finally {
        owned = false;
        for (const stop of held.values()) await stop();
        await release();
      }
    },
    async seal(extra = {}) {
      const path = join(dataRoot, "rules-acceptance-deletions", "journal.json");
      if (existsSync(path) && f.journal().format === 1)
        await upgradeRulesDeletionLifecycle({ dataRoot, installations, now: f.now });
      return sealLatestDeletionProof({
        dataRoot,
        installations,
        key,
        now: f.now,
        notBefore: f.now,
        challenge: randomUUID(),
        ...extra,
      });
    },
    verify(envelope, extra = {}) {
      return verifyLatestDeletionProof({ envelope, key, now: f.now, maxAgeMs: 60000, ...extra });
    },
    import(envelope, extra = {}) {
      return importLatestDeletionProof({
        directory: join(directory, "offsite"),
        envelope,
        key,
        now: f.now,
        maxAgeMs: 60000,
        retirementEvidence: {
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
        },
        ...extra,
      });
    },
    add(index = 0, id = randomUUID(), retiredAt = f.now) {
      const db = f.stores[index].db;
      new JobStore(db).transaction(() =>
        recordRulesDeletion(
          db,
          installations[index].guildId,
          id,
          retiredAt,
          retiredAt + rulesDeletionRetentionMs,
        ),
      );
      return id;
    },
    journal() {
      return JSON.parse(
        readFileSync(join(dataRoot, "rules-acceptance-deletions", "journal.json"), "utf8"),
      );
    },
  };
  t.after(() => {
    for (const s of f.stores) {
      try {
        s.db.close();
      } catch {
        /* A fixture may already have closed a source to emulate a process exit. */
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}
function seedAcceptance(f, index = 0) {
  const db = f.stores[index].db,
    guild = f.installations[index].guildId,
    id = randomUUID(),
    version = randomUUID();
  db.prepare("INSERT INTO server_rules_versions VALUES(?,?,1,'{}','hash','retired',?,?)").run(
    guild,
    version,
    f.now,
    user,
  );
  db.prepare("INSERT INTO server_rules_memberships VALUES(?,?,?,?,NULL,?)").run(
    guild,
    user,
    f.now - 40 * day,
    f.now - 30 * day,
    f.now,
  );
  db.prepare(
    "INSERT INTO server_rules_acceptances VALUES(?,?,?,?,?,?,?,'button','blocked',NULL,NULL,NULL)",
  ).run(guild, id, user, f.now - 40 * day, version, "100000000000000004", f.now - 40 * day);
  return id;
}
function forge(envelope, key, change) {
  const header = envelope.subarray(0, 36),
    derived = Buffer.from(
      hkdfSync("sha256", key, header.subarray(8, 24), "gildiusz-latest-deletion-proof-v2", 32),
    );
  try {
    const decipher = createDecipheriv("aes-256-gcm", derived, header.subarray(24));
    decipher.setAAD(header);
    decipher.setAuthTag(envelope.subarray(-16));
    const body = JSON.parse(
      Buffer.concat([decipher.update(envelope.subarray(36, -16)), decipher.final()]),
    );
    change(body);
    const cipher = createCipheriv("aes-256-gcm", derived, header.subarray(24));
    cipher.setAAD(header);
    return Buffer.concat([
      header,
      cipher.update(JSON.stringify(body)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  } finally {
    derived.fill(0);
  }
}

test("schema13 backfills a real schema12 fence without modifying its original lifetime", async (t) => {
  const f = fixture(t),
    id = randomUUID(),
    db = f.stores[0].db;
  db.exec(
    "DROP TABLE server_rules_deletion_outbox;DROP TABLE server_rules_deletion_state;DELETE FROM schema_migrations WHERE version=13",
  );
  db.prepare("INSERT INTO server_rules_retired_acceptances VALUES(?,?,?,?)").run(
    A,
    id,
    f.now - day,
    f.now + 34 * day,
  );
  f.reopen();
  const row = pendingRulesDeletions(f.stores[0].db, A)[0];
  assert.deepEqual(row, {
    guildId: A,
    acceptanceId: id,
    retiredAt: f.now - day,
    expiresAt: f.now + 34 * day,
    sequence: 1,
  });
  await f.init();
  await assert.rejects(f.seal(), code("source_incomplete"));
  await f.drain();
  const proof = f.verify((await f.seal()).envelope).proof;
  assert.equal(proof.acceptances[0].acceptanceId, id);
  assert.equal(proof.coveredFrom, f.now); // Earlier coverage is deliberately not invented on upgrade.
});
test("erasure/outbox is atomic; crash before journal and after fsync/ACK restarts idempotently across two WAL databases", async (t) => {
  const f = fixture(t);
  await f.init();
  const a = seedAcceptance(f, 0),
    b = seedAcceptance(f, 1),
    jobs = f.jobs();
  f.stores[0].db.exec(
    "CREATE TEMP TRIGGER reject_erasure BEFORE DELETE ON server_rules_acceptances BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
  );
  assert.throws(
    () => new ServerRulesRetention(jobs[0].jobs, { guildId: A, clock: () => f.now }).prune(),
    /fixture rollback/,
  );
  assert.equal(pendingRulesDeletions(f.stores[0].db, A).length, 0);
  assert.equal(
    f.stores[0].db.prepare("SELECT COUNT(*) n FROM server_rules_acceptances").get().n,
    1,
  );
  f.stores[0].db.exec("DROP TRIGGER reject_erasure");
  for (const { guildId, jobs: store } of jobs)
    assert.equal(
      new ServerRulesRetention(store, { guildId, clock: () => f.now }).prune().acceptancesRemoved,
      1,
    );
  await assert.rejects(f.seal(), code("source_incomplete"));
  await assert.rejects(
    f.drain({
      checkpoint() {
        throw new Error("crash after fsync");
      },
    }),
    /crash after fsync/,
  );
  assert.equal(f.journal().entries.length, 2);
  assert.equal(rulesDeletionState(f.stores[0].db, A).journaledThrough, 0);
  await assert.rejects(f.seal(), code("source_incomplete"));
  f.reopen();
  assert.deepEqual(await f.drain(), { written: 0, acknowledged: 2, pending: false });
  assert.deepEqual(await f.drain(), { written: 0, acknowledged: 0, pending: false });
  const result = f.verify((await f.seal()).envelope);
  assert.deepEqual(result.proof.acceptances.map((e) => e.acceptanceId).sort(), [a, b].sort());
  assert.deepEqual(result.proof.guildIds, [A, B]);
  assert.equal(JSON.stringify(f.journal()).includes(user), false);
  assert.equal(JSON.stringify(result.proof).includes(user), false);
});
test("missing journal, inventory omission, wrong guild, active root/perDB writers and quarantine cannot be complete", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.seal(), code("source_unavailable"));
  const release = await acquireDataRootLease(f.dataRoot);
  try {
    await assert.rejects(f.init(), code("writer_active"));
  } finally {
    await release();
  }
  await f.init();
  await assert.rejects(f.seal({ installations: [f.installations[0]] }), code("source_incomplete"));
  const dbRelease = await acquireLock(f.installations[1].databasePath, { createTarget: false });
  try {
    await assert.rejects(f.seal(), code("writer_active"));
  } finally {
    await dbRelease();
  }
  const db = f.stores[0].db;
  db.prepare("INSERT INTO server_rules_deletion_state VALUES(?,0,0,NULL)").run(B);
  await assert.rejects(f.seal(), code("source_incomplete"));
  db.prepare("DELETE FROM server_rules_deletion_state WHERE guild_id=?").run(B);
  writeFileSync(join(f.dataRoot, "restore-quarantine.json"), "{}");
  await assert.rejects(f.seal(), /quarantined/);
});
test("unexported expiry removes UUID while leaving a permanent incomplete gap, acknowledged proof expires after35d", async (t) => {
  const f = fixture(t);
  await f.init();
  const id = f.add();
  f.now += 35 * day;
  assert.equal(expireRulesDeletions(f.stores[0].db, A, f.now), 1);
  assert.equal(JSON.stringify(rulesDeletionState(f.stores[0].db, A)).includes(id), false);
  assert.equal(
    f.stores[0].db.prepare("SELECT COUNT(*) n FROM server_rules_deletion_outbox").get().n,
    0,
  );
  await assert.rejects(f.seal(), code("source_incomplete"));
  await assert.rejects(f.drain(), code("source_gap"));
});
test("acknowledged decisions expire without extending UUID lifetime on replay", async (t) => {
  const f = fixture(t);
  await f.init();
  const id = f.add();
  await f.drain();
  const original = f.journal().entries[0];
  f.now += day;
  await f.drain();
  assert.deepEqual(f.journal().entries[0], original);
  f.now += 34 * day;
  expireRulesDeletions(f.stores[0].db, A, f.now);
  const proof = f.verify((await f.seal()).envelope).proof;
  assert.equal(proof.acceptances.length, 0);
  assert.equal(JSON.stringify(f.journal()).includes(id), false);
});

test("a proof sealed just before a decision's35day deadline cannot verify or import at the exact expiry", async (t) => {
  const f = fixture(t);
  await f.init();
  f.add();
  await f.drain();
  f.now += 35 * day - 1;
  const sealed = await f.seal();
  assert.equal(sealed.meta.expiresAt, f.now + 1);
  assert.equal(f.verify(sealed.envelope).proof.acceptances.length, 1);
  const imported = await f.import(sealed.envelope);
  f.now++;
  assert.throws(() => f.verify(sealed.envelope), code("expired_decision"));
  await assert.rejects(f.import(sealed.envelope), code("expired_decision"));
  const latest = await f.seal();
  assert.equal(f.verify(latest.envelope).proof.acceptances.length, 0);
  await f.import(latest.envelope);
  assert.equal(
    readdirSync(join(f.directory, "offsite")).includes(imported.file.split(/[\\/]/).at(-1)),
    false,
  );
  assert.deepEqual(
    readdirSync(join(f.directory, "offsite")).filter((name) => name.endsWith(".gldproof")),
    [`deletion-proof-${latest.meta.id}.gldproof`],
  );
  await assert.rejects(f.import(sealed.envelope), code("expired_decision"));
});

test("default import clock is refreshed across lock acquisition instead of admitting a decision expired during await", async (t) => {
  const f = fixture(t);
  await f.init();
  f.add();
  await f.drain();
  f.now += 35 * day - 1;
  const sealed = await f.seal(),
    originalClock = Date.now;
  let clock = f.now;
  Date.now = () => clock;
  try {
    const pending = f.import(sealed.envelope, { now: undefined });
    clock++;
    await assert.rejects(pending, code("expired_decision"));
    assert.equal(
      readdirSync(join(f.directory, "offsite")).some((name) => name.endsWith(".gldproof")),
      false,
    );
  } finally {
    Date.now = originalClock;
  }
});
test("v2 verifies freshness/challenge/source/sequence and rejects tamper, wrong key, domain mixing and member IDs", async (t) => {
  const f = fixture(t);
  await f.init();
  f.add();
  await f.drain();
  const challenge = randomUUID(),
    v1 = await sealLatestDeletionLedger({ dataRoot: f.dataRoot, key: f.key, now: f.now }),
    sealed = await f.seal({ challenge });
  const verify = (envelope, extra = {}) =>
    f.verify(envelope, {
      challenge,
      expectedSourceId: sealed.meta.sourceId,
      minSequence: sealed.meta.sequence,
      ...extra,
    });
  assert.equal(verify(sealed.envelope).proof.complete, true);
  const altered = Buffer.from(sealed.envelope);
  altered[40] ^= 1;
  assert.throws(() => verify(altered), code("authentication_failed"));
  assert.throws(
    () => verify(sealed.envelope, { key: randomBytes(32) }),
    code("authentication_failed"),
  );
  assert.throws(() => verify(sealed.envelope, { forbiddenKeys: [f.key] }), code("invalid_key"));
  assert.throws(
    () => verify(sealed.envelope, { challenge: randomUUID() }),
    code("challenge_mismatch"),
  );
  assert.throws(
    () => verify(sealed.envelope, { expectedSourceId: randomUUID() }),
    code("source_changed"),
  );
  assert.throws(
    () => verify(sealed.envelope, { minSequence: sealed.meta.sequence + 1 }),
    code("rollback_detected"),
  );
  assert.throws(() => verify(sealed.envelope, { now: f.now + 60001 }), code("stale_proof"));
  for (const change of [
    (b) => (b.acceptances[0].acceptanceId = user),
    (b) => (b.acceptances[0].userId = user),
    (b) => b.acceptances.push({ ...b.acceptances[0] }),
    (b) => (b.complete = false),
  ])
    assert.throws(() => verify(forge(sealed.envelope, f.key, change)), code("invalid_proof"));
  await assert.rejects(
    sealLatestDeletionLedger({ dataRoot: f.dataRoot, key: f.key, now: f.now }),
    code("source_requires_v2"),
  );
  assert.throws(() => verify(v1.envelope), code("invalid_envelope"));
  assert.throws(
    () =>
      verifyLatestDeletionLedger({
        envelope: sealed.envelope,
        key: f.key,
        now: f.now,
        maxAgeMs: 60000,
      }),
    code("invalid_envelope"),
  );
});
test("import is durable, replay-stable, antirollback and rejects authenticated shrink/conflicts/source replacement", async (t) => {
  const f = fixture(t);
  await f.init();
  f.add();
  await f.drain();
  const first = await f.seal();
  const imported = await f.import(first.envelope);
  assert.equal(imported.replay, false);
  const collision = forge(first.envelope, f.key, (body) => {
    body.sequence++;
  });
  await assert.rejects(f.import(collision), code("id_collision"));
  assert.equal((await f.import(first.envelope)).replay, true);
  assert.equal(
    readdirSync(join(f.directory, "offsite")).filter((n) => n.endsWith(".gldproof")).length,
    1,
  );
  // Simulate crash after envelope fsync but before index commit: imported orphan is still reconciled.
  unlinkSync(join(f.directory, "offsite", "latest-proof.json"));
  assert.equal((await f.import(first.envelope)).replay, true);
  const shrink = forge(first.envelope, f.key, (b) => {
    b.id = randomUUID();
    b.sequence++;
    b.acceptances = [];
  });
  await assert.rejects(f.import(shrink), code("proof_shrink"));
  const replaced = forge(first.envelope, f.key, (b) => {
    b.id = randomUUID();
    b.sequence++;
    b.sourceId = randomUUID();
  });
  await assert.rejects(f.import(replaced), code("source_changed"));
  f.now++;
  f.add(1);
  await f.drain();
  const second = await f.seal();
  await f.import(second.envelope);
  await assert.rejects(f.import(first.envelope), code("rollback_detected"));
  assert.equal(
    readdirSync(join(f.directory, "offsite")).filter((n) => n.endsWith(".gldproof")).length,
    1,
  );
  assert.equal(
    readFileSync(imported.file.replace(first.meta.id, second.meta.id)).equals(second.envelope),
    true,
  );
});
test("a crash after one guild ACK replays the other guild without duplicate decisions or age changes", async (t) => {
  const f = fixture(t);
  await f.init();
  const sameId = randomUUID();
  f.add(0, sameId);
  f.add(1, sameId);
  f.stores[1].db.exec(
    "CREATE TEMP TRIGGER fail_ack BEFORE UPDATE OF journaled_at ON server_rules_deletion_outbox BEGIN SELECT RAISE(ABORT,'fixture ACK crash'); END",
  );
  await assert.rejects(f.drain(), /fixture ACK crash/);
  assert.equal(rulesDeletionState(f.stores[0].db, A).journaledThrough, 1);
  assert.equal(rulesDeletionState(f.stores[1].db, B).journaledThrough, 0);
  const original = f.journal().entries;
  f.reopen();
  assert.deepEqual(await f.drain(), { written: 0, acknowledged: 1, pending: false });
  assert.deepEqual(f.journal().entries, original);
  assert.equal(f.verify((await f.seal()).envelope).proof.acceptances.length, 2);
});
test("expired journal UUIDs are pruned even when an unacknowledged gap or missing database prevents a latest proof", async (t) => {
  const f = fixture(t);
  await f.init();
  const id = f.add();
  await assert.rejects(
    f.drain({
      checkpoint() {
        throw Error("lost ACK");
      },
    }),
    /lost ACK/,
  );
  f.now += 35 * day;
  expireRulesDeletions(f.stores[0].db, A, f.now);
  assert.equal(await pruneRulesDeletionJournal({ dataRoot: f.dataRoot, now: f.now }), 1);
  assert.equal(JSON.stringify(f.journal()).includes(id), false);
  await assert.rejects(f.seal(), code("source_incomplete"));
});
test("missing acknowledged source cannot bootstrap a new empty history and caller buffer mutation cannot corrupt import", async (t) => {
  const f = fixture(t);
  await f.init();
  f.add();
  await f.drain();
  const sealed = await f.seal();
  const bytes = Buffer.from(sealed.envelope),
    pending = f.import(bytes);
  bytes.fill(0);
  const imported = await pending;
  assert.equal(readFileSync(imported.file).equals(sealed.envelope), true);
  unlinkSync(join(f.dataRoot, "rules-acceptance-deletions", "journal.json"));
  await assert.rejects(f.init(), code("source_missing_history"));
  await assert.rejects(f.seal(), code("source_unavailable"));
});
test("missing source entries and uncommitted SQLite work cannot be ACKed or declared complete", async (t) => {
  const f = fixture(t);
  await f.init();
  f.add();
  await f.drain();
  const path = join(f.dataRoot, "rules-acceptance-deletions", "journal.json"),
    journal = f.journal();
  journal.entries = [];
  writeFileSync(path, JSON.stringify(journal));
  await assert.rejects(f.seal(), code("source_incomplete"));
  f.stores[0].db.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(f.drain(), code("uncommitted_source"));
  } finally {
    f.stores[0].db.exec("ROLLBACK");
  }
});
test("journal and import reject hardlinks and source path escape", async (t) => {
  const f = fixture(t);
  await f.init();
  await assert.rejects(
    f.seal({
      installations: [{ guildId: A, databasePath: join(f.dataRoot, "..", "outside.sqlite") }],
    }),
    code("invalid_inventory"),
  );
  const path = join(f.dataRoot, "rules-acceptance-deletions", "journal.json"),
    other = join(f.directory, "alias.json");
  linkSync(path, other);
  await assert.rejects(f.drain(), /unlinked files/);
  unlinkSync(other);
  const sealed = await f.seal();
  await f.import(sealed.envelope);
  const p = join(f.directory, "offsite", `deletion-proof-${sealed.meta.id}.gldproof`);
  linkSync(p, other);
  await assert.rejects(f.import(sealed.envelope), code("operator_block"));
});

test("crashed plaintext journal staging files are removed under lock but unknown files and linked staging files are preserved", async (t) => {
  const f = fixture(t);
  await f.init();
  const directory = join(f.dataRoot, "rules-acceptance-deletions"),
    id = randomUUID(),
    temp = join(directory, randomUUID() + ".tmp");
  writeFileSync(temp, JSON.stringify({ acceptanceId: id }), { mode: 0o600 });
  await pruneRulesDeletionJournal({ dataRoot: f.dataRoot, now: f.now });
  assert.equal(readdirSync(directory).includes(temp.split(/[\\/]/).at(-1)), false);
  const unknown = join(directory, "operator.txt");
  writeFileSync(unknown, "keep");
  await assert.rejects(f.drain(), code("operator_block"));
  assert.equal(readFileSync(unknown, "utf8"), "keep");
  unlinkSync(unknown);
  writeFileSync(temp, "linked", { mode: 0o600 });
  const alias = join(f.directory, "linked.json");
  linkSync(temp, alias);
  await assert.rejects(f.drain(), /unlinked files/);
  assert.equal(readFileSync(temp, "utf8"), "linked");
});
test(
  "POSIX symlink journal directory is rejected",
  { skip: process.platform === "win32" ? "POSIX symlink permissions fixture" : false },
  async (t) => {
    const f = fixture(t),
      outside = join(f.directory, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(f.dataRoot, "rules-acceptance-deletions"));
    await assert.rejects(f.init(), /Unsafe recovery directory/);
  },
);

test(
  "POSIX journal and import parent entries are fsynced before ACK",
  { skip: process.platform === "win32" ? "POSIX directory fsync syscall fixture" : false },
  (t) => {
    const f = fixture(t);
    for (const store of f.stores) store.db.close();
    const fsShim = `import * as fs from 'node:fs';export * from 'node:fs';
    export function openSync(path,...args){const fd=fs.openSync(path,...args);globalThis.__proofFds.set(fd,String(path));return fd;}
    export function closeSync(fd){globalThis.__proofFds.delete(fd);return fs.closeSync(fd);}
    export function fsyncSync(fd){fs.fsyncSync(fd);globalThis.__proofSyncs.push(globalThis.__proofFds.get(fd));}`;
    const shimUrl = "data:text/javascript," + encodeURIComponent(fsShim),
      source = `
    import assert from 'node:assert/strict';import{registerHooks}from'node:module';import{join}from'node:path';import{randomBytes,randomUUID}from'node:crypto';
    globalThis.__proofFds=new Map();globalThis.__proofSyncs=[];
    const shim=${JSON.stringify(shimUrl)};
    registerHooks({resolve(specifier,context,next){return specifier==='node:fs'&&context.parentURL!==shim?{url:shim,shortCircuit:true}:next(specifier,context)}});
    const {Store}=await import(${JSON.stringify(new URL("../dist/storage/store.js", import.meta.url).href)});
    const {JobStore}=await import(${JSON.stringify(new URL("../dist/core/jobs/store.js", import.meta.url).href)});
    const {recordRulesDeletion,rulesDeletionState}=await import(${JSON.stringify(new URL("../dist/modules/server-rules/deletion-outbox.js", import.meta.url).href)});
    const {initializeRulesDeletionJournal,drainRulesDeletionOutbox}=await import(${JSON.stringify(new URL("../dist/storage/rules-deletion-journal.js", import.meta.url).href)});
    const {upgradeRulesDeletionLifecycle}=await import(${JSON.stringify(new URL("../dist/storage/rules-deletion-lifecycle.js", import.meta.url).href)});
    const {sealLatestDeletionProof,importLatestDeletionProof}=await import(${JSON.stringify(new URL("../scripts/backup-proof.mjs", import.meta.url).href)});
    const installations=${JSON.stringify(f.installations)},root=${JSON.stringify(f.dataRoot)},now=${f.now},stores=installations.map(i=>new Store(i.databasePath,i.guildId));
    try {
      await initializeRulesDeletionJournal({dataRoot:root,installations,now});
      assert.ok(globalThis.__proofSyncs.includes(root),'new journal entry must survive dataRoot powerloss');
      const jobs=stores.map((s,i)=>({guildId:installations[i].guildId,jobs:new JobStore(s.db)}));
      jobs[0].jobs.transaction(()=>recordRulesDeletion(stores[0].db,installations[0].guildId,randomUUID(),now,now+${35 * day}));
      await drainRulesDeletionOutbox({dataRoot:root,stores:jobs,now,checkpoint(){
        assert.equal(rulesDeletionState(stores[0].db,installations[0].guildId).journaledThrough,0);
        assert.ok(globalThis.__proofSyncs.includes(join(root,'rules-acceptance-deletions')));
        assert.ok(globalThis.__proofSyncs.includes(root));
      }});
      await upgradeRulesDeletionLifecycle({dataRoot:root,installations,now});
      const key=randomBytes(32),sealed=await sealLatestDeletionProof({dataRoot:root,installations,key,now,notBefore:now,challenge:randomUUID()});
      const parent=${JSON.stringify(f.directory)},directory=join(parent,'new-parent','new-offsite');globalThis.__proofSyncs=[];
      await importLatestDeletionProof({directory,envelope:sealed.envelope,key,now,maxAgeMs:60000});
      assert.ok(globalThis.__proofSyncs.includes(parent),'new parent entry durable');
      assert.ok(globalThis.__proofSyncs.includes(join(parent,'new-parent')),'new import entry durable');
      assert.ok(globalThis.__proofSyncs.includes(directory),'encrypted envelope and index durable');
    } finally {for(const store of stores)store.db.close();}
  `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
  },
);
