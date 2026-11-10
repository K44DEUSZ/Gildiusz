import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID, createDecipheriv, createCipheriv, hkdfSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { createSnapshot, restoreSnapshot } from "../dist/storage/recovery/snapshot.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import { acquireLock } from "../dist/storage/lock.js";
import { hashFile } from "../dist/storage/recovery/files.js";
import { reconcileRulesDeletionEntries } from "../dist/storage/recovery/deletions.js";
import {
  recordRulesDeletion,
  rulesDeletionRetentionMs,
} from "../dist/modules/server-rules/deletion-outbox.js";
import {
  initializeRulesDeletionJournal,
  drainRulesDeletionOutbox,
} from "../dist/storage/rules-deletion-journal.js";
import { sealLatestDeletionProof } from "../scripts/backup-proof.mjs";
import { reconcileRestoredDeletionData } from "../scripts/recovery-deletions.mjs";
import { recoveryCommand } from "../scripts/recovery.mjs";

const A = "100000000000000001",
  B = "200000000000000001",
  owner = "100000000000000002",
  user = "100000000000000003",
  role = "100000000000000004",
  day = 86400000;
const code = (value) => (error) => error.code === value;
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
function snapshotTree(root) {
  const values = {};
  const walk = (path) => {
    for (const name of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, name.name);
      if (name.isDirectory()) walk(p);
      else values[relative(root, p)] = hashFile(p);
    }
  };
  walk(root);
  return values;
}
function dbAt(f, index = 0, readOnly = false) {
  return new DatabaseSync(join(f.target, "guilds", [A, B][index], "gildiusz.sqlite"), { readOnly });
}
function seed(db, guild, id, base, extraCohort = false) {
  const versions = [randomUUID(), randomUUID()],
    oldJoin = base - 50 * day,
    newJoin = base - 10000;
  db.prepare("INSERT INTO server_rules_settings VALUES(?,0,1,1,NULL,?)").run(guild, versions[0]);
  for (const version of versions)
    db.prepare("INSERT INTO server_rules_versions VALUES(?,?,1,'{}','hash','active',?,?)").run(
      guild,
      version,
      base - 40 * day,
      owner,
    );
  db.prepare("INSERT INTO server_rules_memberships VALUES(?,?,?,?,NULL,?)").run(
    guild,
    user,
    oldJoin,
    base - 31 * day,
    base,
  );
  db.prepare("INSERT INTO server_rules_memberships VALUES(?,?,?,NULL,NULL,?)").run(
    guild,
    user,
    newJoin,
    base,
  );
  const jobs = new JobStore(db),
    ids = [];
  for (const [payload, dedupe] of [
    [{ versionId: versions[0], acceptanceId: id }, "linked"],
    [{ versionId: versions[0], acceptanceId: id }, "unlinked"],
    [{}, `cached-${id}`],
  ]) {
    const job = jobs.enqueue({
      guildId: guild,
      type: "server-rules.grant-role",
      objectId: versions[0],
      generation: 1,
      dueAt: base - 2 * day,
      payload,
      dedupeKey: `fixture:${guild}:${dedupe}`,
    });
    ids.push(job.id);
    db.prepare("UPDATE jobs SET state='unknown',result=?,last_error=? WHERE id=?").run(
      JSON.stringify({ acceptanceId: id, userId: user }),
      id,
      job.id,
    );
    db.prepare("INSERT INTO delivery_attempts VALUES(?,?,1,?,'unknown',?,?,NULL,?,?,?,NULL)").run(
      randomUUID(),
      job.id,
      randomUUID(),
      id,
      role,
      id,
      JSON.stringify({ acceptanceId: id, userId: user }),
      base - 2 * day,
    );
  }
  db.prepare(
    "INSERT INTO server_rules_acceptances VALUES(?,?,?,?,?,?,?,'button','unknown',?,NULL,NULL)",
  ).run(guild, id, user, oldJoin, versions[0], role, base - 40 * day, ids[0]);
  const newId = randomUUID();
  db.prepare(
    "INSERT INTO server_rules_acceptances VALUES(?,?,?,?,?,?,?,'button','already_present',NULL,?,NULL)",
  ).run(guild, newId, user, newJoin, versions[0], role, base - 5000, base - 5000);
  let otherOldId = null;
  if (extraCohort) {
    otherOldId = randomUUID();
    db.prepare(
      "INSERT INTO server_rules_acceptances VALUES(?,?,?,?,?,?,?,'button','already_present',NULL,?,NULL)",
    ).run(guild, otherOldId, user, oldJoin, versions[1], role, base - 40 * day, base - 40 * day);
  }
  db.prepare("INSERT INTO idempotency_keys VALUES(?,?,?, ?,?)").run(
    `fixture:${guild}:cache`,
    randomUUID(),
    "hash",
    JSON.stringify({ acceptance: { id, userId: user }, nested: [{ id }] }),
    base,
  );
  return { oldJoin, newJoin, newId, otherOldId, jobIds: ids };
}
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-restored-deletions-")),
    dataRoot = join(directory, "source"),
    target = join(directory, "target"),
    key = randomBytes(32),
    base = Date.now(),
    id = randomUUID();
  mkdirSync(dataRoot, { mode: 0o700 });
  mkdirSync(join(dataRoot, "configuration"), { mode: 0o700 });
  const installations = [A, B].map((guildId) => ({
      guildId,
      ownerId: owner,
      public: false,
      databasePath: join(dataRoot, "guilds", guildId, "gildiusz.sqlite"),
      configPath: join(dataRoot, "configuration", guildId + ".json"),
    })),
    stores = installations.map((i) => new Store(i.databasePath, i.guildId));
  chmodSync(join(dataRoot, "guilds"), 0o700);
  for (const i of installations) {
    chmodSync(join(dataRoot, "guilds", i.guildId), 0o700);
    writeFileSync(i.configPath, "{}", { mode: 0o600 });
  }
  const rows = stores.map((s, index) =>
    seed(s.db, installations[index].guildId, id, base, index === 0 && options.extraCohort),
  );
  t.after(() => {
    for (const s of stores) {
      try {
        s.db.close();
      } catch {
        /* Fixture may close source deliberately. */
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await initializeRulesDeletionJournal({ dataRoot, installations, now: base - 1000 });
  const archivePath = join(directory, "archive.gldbak"),
    manifest = await createSnapshot({
      dataRoot,
      guilds: installations,
      outputPath: archivePath,
      key,
    });
  const now = Date.now() + (options.wallClock ? 0 : 1000),
    challenge = randomUUID(),
    jobs = new JobStore(stores[0].db);
  jobs.transaction(() => {
    recordRulesDeletion(stores[0].db, A, id, now, now + rulesDeletionRetentionMs);
    stores[0].db
      .prepare("INSERT INTO server_rules_retired_acceptances VALUES(?,?,?,?)")
      .run(A, id, now, now + rulesDeletionRetentionMs);
    stores[0].db
      .prepare("DELETE FROM server_rules_acceptances WHERE guild_id=? AND id=?")
      .run(A, id);
  });
  await drainRulesDeletionOutbox({
    dataRoot,
    stores: stores.map((s, i) => ({ guildId: installations[i].guildId, jobs: new JobStore(s.db) })),
    now,
  });
  const sealed = await sealLatestDeletionProof({
    dataRoot,
    installations,
    key,
    now,
    notBefore: now,
    challenge,
  });
  await restoreSnapshot({ archivePath, targetRoot: target, key, now });
  const f = {
    directory,
    dataRoot,
    target,
    key,
    stores,
    installations,
    manifest,
    id,
    rows,
    now,
    sealed,
    requirements: {
      archivePath,
      expectedSourceId: sealed.meta.sourceId,
      minSequence: sealed.meta.sequence,
      notBefore: now,
      challenge,
      maxAgeMs: 60000,
    },
    options(extra = {}) {
      return {
        targetRoot: target,
        latestProofEnvelope: sealed.envelope,
        key,
        proofRequirements: f.requirements,
        expectedBackupId: manifest.id,
        now: f.now,
        ...extra,
      };
    },
    run(extra = {}) {
      return reconcileRestoredDeletionData(f.options(extra));
    },
  };
  return f;
}

test("authenticated two-guild dry run is the default and leaves every target byte, cohort and quarantine marker unchanged", async (t) => {
  const f = await fixture(t),
    before = snapshotTree(f.target),
    report = await f.run();
  assert.equal(report.state, "planned");
  assert.equal(report.dryRun, true);
  assert.equal(report.totals.acceptancesRemoved, 1);
  assert.equal(report.totals.jobsScrubbed, 3);
  assert.equal(report.totals.attemptsScrubbed, 3);
  assert.equal(report.totals.cacheEntriesScrubbed, 1);
  assert.equal(report.totals.membershipsRemoved, 1);
  assert.equal(JSON.stringify(report).includes(user), false);
  assert.equal(report.activationAllowed, false);
  assert.equal(report.quarantinePreserved, true);
  assert.deepEqual(snapshotTree(f.target), before);
});
test("apply scrubs exact acceptance, all three grant references and caches, preserves unknown/new join/other guild, and reruns with zero changes", async (t) => {
  const f = await fixture(t),
    bBefore = hashFile(join(f.target, "guilds", B, "gildiusz.sqlite")),
    marker = readFileSync(join(f.target, "restore-quarantine.json"));
  const result = await f.run({ dryRun: false });
  assert.equal(result.state, "reconciled");
  assert.equal(result.totals.acceptancesRemoved, 1);
  const db = dbAt(f);
  try {
    assert.equal(
      db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.id),
      undefined,
    );
    assert.ok(db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.rows[0].newId));
    assert.equal(
      db.prepare("SELECT 1 FROM server_rules_memberships WHERE joined_at=?").get(f.rows[0].oldJoin),
      undefined,
    );
    assert.ok(
      db.prepare("SELECT 1 FROM server_rules_memberships WHERE joined_at=?").get(f.rows[0].newJoin),
    );
    for (const job of db.prepare("SELECT * FROM jobs").all()) {
      assert.equal(job.state, "unknown");
      assert.equal(job.payload, "{}");
      assert.equal(job.result, null);
      assert.equal(job.last_error, "retention_unresolved");
      assert.equal(job.cancel_requested, 1);
      assert.equal(String(job.dedupe_key).includes(f.id), false);
    }
    for (const attempt of db.prepare("SELECT * FROM delivery_attempts").all()) {
      assert.equal(attempt.state, "unknown");
      assert.equal(attempt.error, "retention_unresolved");
      assert.equal(attempt.result, null);
      assert.equal(attempt.nonce, null);
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM job_history_retired").get().n, 3);
    assert.equal(
      String(db.prepare("SELECT result FROM idempotency_keys").get().result).includes(f.id),
      false,
    );
    const fence = db.prepare("SELECT * FROM server_rules_retired_acceptances").get();
    assert.equal(fence.retired_at, f.now);
    assert.equal(fence.expires_at, f.now + 35 * day);
    assert.equal(
      db.prepare("SELECT enabled,active_version_id FROM server_rules_settings").get().enabled,
      0,
    );
  } finally {
    db.close();
  }
  assert.deepEqual(hashFile(join(f.target, "guilds", B, "gildiusz.sqlite")), bBefore);
  assert.equal(readFileSync(join(f.target, "restore-quarantine.json")).equals(marker), true);
  const before = snapshotTree(f.target),
    again = await f.run({ dryRun: false });
  assert.equal(
    Object.values(again.totals).every((n) => n === 0),
    true,
  );
  assert.deepEqual(snapshotTree(f.target), before);
});
test("a cohort with another retained acceptance and a newer join both survive exact-UUID reconciliation", async (t) => {
  const f = await fixture(t, { extraCohort: true });
  await f.run({ dryRun: false });
  const db = dbAt(f);
  try {
    assert.ok(
      db.prepare("SELECT 1 FROM server_rules_memberships WHERE joined_at=?").get(f.rows[0].oldJoin),
    );
    assert.ok(
      db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.rows[0].otherOldId),
    );
    assert.ok(db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.rows[0].newId));
  } finally {
    db.close();
  }
});
test("proof authentication/pins/freshness and authenticated original archive are mandatory before target changes", async (t) => {
  const f = await fixture(t),
    before = snapshotTree(f.target),
    bad = Buffer.from(f.sealed.envelope);
  bad[40] ^= 1;
  for (const extra of [
    { latestProofEnvelope: bad },
    { key: randomBytes(32) },
    { proofRequirements: { ...f.requirements, expectedSourceId: randomUUID() } },
    { proofRequirements: { ...f.requirements, minSequence: f.sealed.meta.sequence + 1 } },
    { proofRequirements: { ...f.requirements, challenge: randomUUID() } },
    { proofRequirements: { ...f.requirements, archivePath: undefined } },
    { now: f.now + 60000 },
  ])
    await assert.rejects(f.run(extra));
  const bytes = readFileSync(f.requirements.archivePath);
  bytes[60] ^= 1;
  writeFileSync(f.requirements.archivePath, bytes);
  await assert.rejects(f.run(), /authenticat|corrupt|Unsupported/);
  assert.deepEqual(snapshotTree(f.target), before);
});
test("plaintext manifest, backupId and marker substitutions cannot authorize erasure", async (t) => {
  const f = await fixture(t),
    before = snapshotTree(f.target);
  await assert.rejects(f.run({ expectedBackupId: randomUUID() }), code("backup_mismatch"));
  const path = join(f.target, "restore-manifest.json"),
    original = readFileSync(path),
    value = JSON.parse(original);
  value.createdAt--;
  writeFileSync(path, JSON.stringify(value));
  await assert.rejects(f.run(), code("target_manifest_mismatch"));
  writeFileSync(path, original);
  const markerPath = join(f.target, "restore-quarantine.json"),
    originalMarker = readFileSync(markerPath),
    marker = JSON.parse(originalMarker);
  marker.automaticResume = true;
  writeFileSync(markerPath, JSON.stringify(marker));
  await assert.rejects(f.run(), code("target_not_quarantined"));
  writeFileSync(markerPath, originalMarker);
  assert.deepEqual(snapshotTree(f.target), before);
});

test("authenticated proof still needs every manifest guild and coverage beginning before the original backup", async (t) => {
  const f = await fixture(t),
    before = snapshotTree(f.target);
  const scoped = forge(f.sealed.envelope, f.key, (body) => {
    body.guildIds = [A];
  });
  await assert.rejects(f.run({ latestProofEnvelope: scoped }), code("proof_scope_missing"));
  const late = forge(f.sealed.envelope, f.key, (body) => {
    body.coveredFrom = f.manifest.createdAt + 1;
  });
  await assert.rejects(f.run({ latestProofEnvelope: late }), code("proof_coverage_missing"));
  await assert.rejects(
    f.run({ proofRequirements: { ...f.requirements, notBefore: f.manifest.createdAt - 1 } }),
    code("proof_coverage_missing"),
  );
  assert.deepEqual(snapshotTree(f.target), before);
});
test("live root/perDB leases, unsafe linked targets, altered schema and reenabled rules fail before erasure", async (t) => {
  const f = await fixture(t);
  let release = await acquireDataRootLease(f.target);
  try {
    await assert.rejects(f.run({ dryRun: false }), code("writer_active"));
  } finally {
    await release();
  }
  const path = join(f.target, "guilds", A, "gildiusz.sqlite");
  release = await acquireLock(path, { createTarget: false });
  try {
    await assert.rejects(f.run({ dryRun: false }), code("writer_active"));
  } finally {
    await release();
  }
  const alias = join(f.directory, "alias.sqlite");
  linkSync(path, alias);
  await assert.rejects(f.run(), /unlinked files/);
  rmSync(alias);
  const db = dbAt(f);
  try {
    db.exec("UPDATE server_rules_settings SET enabled=1");
    await assert.rejects(f.run({ dryRun: false }), code("target_not_quarantined"));
    db.exec("UPDATE server_rules_settings SET enabled=0");
    db.exec("UPDATE jobs SET state='retry'");
    await assert.rejects(f.run({ dryRun: false }), code("target_not_quarantined"));
    db.exec("UPDATE jobs SET state='unknown'");
    db.exec("ALTER TABLE jobs ADD COLUMN injected TEXT");
  } finally {
    db.close();
  }
  await assert.rejects(f.run(), code("target_schema_changed"));
});

test("a cache key or grant pointing at a different live acceptance blocks before any partial erasure", async (t) => {
  const f = await fixture(t),
    db = dbAt(f);
  try {
    db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
      JSON.stringify({ acceptanceId: f.rows[0].newId }),
      f.rows[0].jobIds[0],
    );
    await assert.rejects(f.run({ dryRun: false }), code("invalid_job_association"));
    assert.ok(db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.id));
    db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
      JSON.stringify({ acceptanceId: f.id }),
      f.rows[0].jobIds[0],
    );
    db.prepare("UPDATE idempotency_keys SET scope=?").run(`unsafe:${f.id}`);
    await assert.rejects(f.run({ dryRun: false }), code("unsupported_cache_key"));
    assert.ok(db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.id));
  } finally {
    db.close();
  }
});
test("a whole-guild deletion is a separate blocker and does not perform a partial rules cleanup", async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.dataRoot, "uninstall-retention"), { mode: 0o700 });
  writeFileSync(
    join(f.dataRoot, "uninstall-retention", A + ".deleted.json"),
    JSON.stringify({
      format: 1,
      guildId: A,
      removedAt: f.manifest.createdAt,
      purgedAt: f.now,
      outcome: "purged",
    }),
    { mode: 0o600 },
  );
  const challenge = randomUUID(),
    sealed = await sealLatestDeletionProof({
      dataRoot: f.dataRoot,
      installations: f.installations,
      key: f.key,
      now: f.now,
      notBefore: f.now,
      challenge,
    }),
    before = snapshotTree(f.target);
  const report = await f.run({
    dryRun: false,
    latestProofEnvelope: sealed.envelope,
    proofRequirements: { ...f.requirements, minSequence: sealed.meta.sequence, challenge },
  });
  assert.equal(report.state, "blocked");
  assert.deepEqual(report.blockers, [
    { code: "guild_deletion_requires_reconciliation", guildId: A },
  ]);
  assert.deepEqual(snapshotTree(f.target), before);
});
test("per-database transaction rollback and a crash between guild commits are idempotent without reviving unknown work", async (t) => {
  const f = await fixture(t),
    db = dbAt(f),
    entry = {
      guildId: A,
      acceptanceId: f.id,
      retiredAt: f.now,
      expiresAt: f.now + 35 * day,
      sequence: 1,
    };
  try {
    const before = db.prepare("SELECT total_changes() n").get().n;
    assert.throws(
      () =>
        reconcileRulesDeletionEntries(db, {
          guildId: A,
          entries: [entry],
          now: f.now,
          dryRun: false,
          beforeCommit() {
            throw Error("fixture crash");
          },
        }),
      /fixture crash/,
    );
    assert.ok(db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.id));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM server_rules_retired_acceptances").get().n, 0);
    assert.ok(db.prepare("SELECT total_changes() n").get().n > before);
    reconcileRulesDeletionEntries(db, { guildId: A, entries: [entry], now: f.now, dryRun: false });
  } finally {
    db.close();
  }
  const again = await f.run({ dryRun: false });
  assert.equal(again.totals.acceptancesRemoved, 0);
  assert.equal(again.totals.jobsScrubbed, 0);
  assert.equal(again.activationAllowed, false);
});

function commandFixture(f) {
  const proof = join(f.directory, "latest-proof.gldproof"),
    requirements = join(f.directory, "proof-requirements.json"),
    { archivePath, ...pins } = f.requirements;
  writeFileSync(proof, f.sealed.envelope, { mode: 0o600 });
  writeFileSync(requirements, JSON.stringify(pins), { mode: 0o600 });
  const options = {
      archive: archivePath,
      target: f.target,
      proof,
      requirements,
      backupId: f.manifest.id,
    },
    env = {
      ...Object.fromEntries(
        ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
          .filter((name) => process.env[name])
          .map((name) => [name, process.env[name]]),
      ),
      BACKUP_ENCRYPTION_KEY: f.key.toString("base64url"),
    },
    cli = (extra = [], environment = env) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../scripts/recovery.mjs", import.meta.url)),
          "reconcile-deletions",
          "--archive",
          options.archive,
          "--target",
          options.target,
          "--proof",
          proof,
          "--requirements",
          requirements,
          "--backup-id",
          options.backupId,
          ...extra,
        ],
        { env: environment, encoding: "utf8", timeout: 10000 },
      );
  return { options, pins, env, cli };
}

test("operator CLI defaults to dry run, requires explicit apply, and repeated apply keeps quarantine and unknown work", async (t) => {
  const f = await fixture(t, { wallClock: true }),
    command = commandFixture(f),
    before = snapshotTree(f.target);
  for (const args of [[], ["--dry-run"]]) {
    const checked = command.cli(args);
    assert.equal(checked.status, 0, checked.stderr);
    const report = JSON.parse(checked.stdout);
    assert.equal(report.state, "planned");
    assert.equal(report.dryRun, true);
    assert.equal(report.totals.acceptancesRemoved, 1);
    assert.equal(report.activationAllowed, false);
    assert.equal(checked.stdout.includes(user), false);
    assert.equal(checked.stdout.includes(command.env.BACKUP_ENCRYPTION_KEY), false);
    assert.deepEqual(snapshotTree(f.target), before);
  }
  const applied = command.cli(["--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).state, "reconciled");
  assert.equal(JSON.parse(applied.stdout).totals.acceptancesRemoved, 1);
  const db = dbAt(f, 0, true);
  try {
    assert.equal(
      db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.id),
      undefined,
    );
    assert.ok(db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(f.rows[0].newId));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='unknown'").get().n, 3);
  } finally {
    db.close();
  }
  const after = snapshotTree(f.target),
    replay = command.cli(["--apply"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(
    Object.values(JSON.parse(replay.stdout).totals).every((n) => n === 0),
    true,
  );
  assert.deepEqual(snapshotTree(f.target), after);
  assert.deepEqual(after["restore-quarantine.json"], before["restore-quarantine.json"]);
});

test("reconcile command API enforces private bounded inputs, exact pins and an independent environment key before any write", async (t) => {
  const f = await fixture(t, { wallClock: true }),
    command = commandFixture(f),
    before = snapshotTree(f.target),
    call = (options = command.options, env = command.env) =>
      recoveryCommand("reconcile-deletions", options, env);
  assert.equal((await call({ ...command.options, dryRun: false })).dryRun, true);
  for (const options of [
    { ...command.options, apply: true, dryRun: true },
    { ...command.options, backupId: undefined },
    { ...command.options, apply: "yes" },
    { ...command.options, key: command.env.BACKUP_ENCRYPTION_KEY },
  ])
    await assert.rejects(call(options));
  await assert.rejects(
    call(command.options, {
      ...command.env,
      DISCORD_TOKEN: command.env.BACKUP_ENCRYPTION_KEY,
    }),
    /independent/,
  );
  writeFileSync(
    command.options.requirements,
    JSON.stringify({ ...command.pins, archivePath: "x" }),
  );
  await assert.rejects(call(), /Invalid deletion proof requirements/);
  writeFileSync(command.options.requirements, Buffer.alloc(4097, 32));
  await assert.rejects(call(), /Invalid private recovery input/);
  writeFileSync(command.options.requirements, JSON.stringify(command.pins));
  writeFileSync(command.options.proof, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(call(), /Invalid private recovery input/);
  writeFileSync(command.options.proof, f.sealed.envelope);
  const alias = join(f.directory, "linked-proof.gldproof");
  linkSync(command.options.proof, alias);
  await assert.rejects(call(), /unlinked files/);
  rmSync(alias);
  const tampered = Buffer.from(f.sealed.envelope);
  tampered[40] ^= 1;
  writeFileSync(command.options.proof, tampered);
  await assert.rejects(call());
  assert.deepEqual(snapshotTree(f.target), before);
});

test("reconcile CLI refuses conflicting, duplicated and key-in-argv flags without erasing data", async (t) => {
  const f = await fixture(t, { wallClock: true }),
    command = commandFixture(f),
    before = snapshotTree(f.target);
  for (const flags of [
    ["--apply", "--dry-run"],
    ["--apply", "--apply"],
    ["--proof", command.options.proof],
    ["--key", "fixture-not-a-key"],
  ]) {
    const result = command.cli(flags);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(command.env.BACKUP_ENCRYPTION_KEY), false);
    assert.deepEqual(snapshotTree(f.target), before);
  }
});

test(
  "reconcile API refuses POSIX group-readable proof and requirements inputs",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, { wallClock: true }),
      command = commandFixture(f),
      before = snapshotTree(f.target);
    for (const path of [
      command.options.archive,
      command.options.proof,
      command.options.requirements,
    ]) {
      chmodSync(path, 0o640);
      await assert.rejects(
        recoveryCommand("reconcile-deletions", command.options, command.env),
        /private/,
      );
      chmodSync(path, 0o600);
    }
    assert.deepEqual(snapshotTree(f.target), before);
  },
);
