import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { acquireLock } from "../dist/storage/lock.js";
import { initializeRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import {
  openRulesDeletionLifecycle,
  readRulesDeletionLifecycleJournal,
  upgradeRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";
import {
  recordRulesDeletion,
  rulesDeletionRetentionMs,
} from "../dist/modules/server-rules/deletion-outbox.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import { createSnapshot } from "../dist/storage/recovery/snapshot.js";
import { encryptArchive } from "../dist/storage/recovery/archive.js";
import { createRecoveryCapture, verifyRecoveryCapture } from "../scripts/recovery-capture.mjs";
import { recoveryCommand } from "../scripts/recovery.mjs";

const guildId = "100000000000000001",
  ownerId = "100000000000000002";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gld-capture-")),
    dataRoot = join(root, "source"),
    manual = join(root, "manual"),
    key = randomBytes(32);
  for (const path of [dataRoot, manual, join(dataRoot, "configuration")])
    mkdirSync(path, { mode: 0o700 });
  const installation = {
    guildId,
    ownerId,
    public: false,
    databasePath: join(dataRoot, "guilds", guildId, "gildiusz.sqlite"),
    configPath: join(dataRoot, "configuration", guildId + ".json"),
  };
  const store = new Store(installation.databasePath, guildId);
  chmodSync(join(dataRoot, "guilds"), 0o700);
  chmodSync(dirname(store.path), 0o700);
  writeFileSync(installation.configPath, "{}", { mode: 0o600 });
  await initializeRulesDeletionJournal({ dataRoot, installations: [installation] });
  await upgradeRulesDeletionLifecycle({ dataRoot, installations: [installation] });
  const archivePath = join(manual, "snapshot.gldbak"),
    outputPath = join(manual, "journal.gldcapture");
  const backup = await createSnapshot({
    dataRoot,
    guilds: [installation],
    key,
    outputPath: archivePath,
  });
  store.close();
  t.after(() => {
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dataRoot,
    manual,
    key,
    archivePath,
    outputPath,
    backup,
    installations: [installation],
    challenge: randomUUID(),
  };
}
function requirements(f, receipt) {
  return {
    backupId: f.backup.id,
    archiveSha256: f.archiveHash,
    proof: {
      expectedSourceId: receipt.sourceId,
      minSequence: receipt.sequence,
      notBefore: receipt.createdAt,
      challenge: f.challenge,
      maxAgeMs: 86400000,
    },
  };
}
async function capture(f) {
  const result = await createRecoveryCapture(f);
  // Independent operator receipt pins are retained before the source is removed.
  const { createHash } = await import("node:crypto");
  f.archiveHash = createHash("sha256").update(readFileSync(f.archivePath)).digest("hex");
  return { result, pins: requirements(f, result) };
}

test("manual capture binds a full format2 journal to its proof and exact backup after source loss", async (t) => {
  const f = await fixture(t),
    { result, pins } = await capture(f);
  const sourceJournal = JSON.parse(
    readFileSync(join(f.dataRoot, "rules-acceptance-deletions/journal.json")),
  );
  assert.equal(result.activationAllowed, false);
  assert.equal(result.writesAfterCaptureExcluded, false);
  assert.equal(result.automaticBackupScheduled, false);
  assert.ok(!readFileSync(f.outputPath).includes(Buffer.from(sourceJournal.sourceId)));
  rmSync(f.dataRoot, { recursive: true });
  const verified = verifyRecoveryCapture({ path: f.outputPath, key: f.key, requirements: pins });
  assert.deepEqual(verified.capture.journal, sourceJournal);
  assert.equal(verified.capture.journal.active[0].epoch, sourceJournal.active[0].epoch);
  assert.equal(verified.meta.sequence, result.sequence);
  assert.equal(existsSync(f.dataRoot), false);
  assert.deepEqual(readdirSync(f.manual).sort(), ["journal.gldcapture", "snapshot.gldbak"]);
});

test("capture refuses the wrong source, watermark, challenge, backup and stale evidence", async (t) => {
  const f = await fixture(t),
    { result, pins } = await capture(f);
  for (const [change, code] of [
    [{ proof: { ...pins.proof, expectedSourceId: randomUUID() } }, "source_changed"],
    [{ proof: { ...pins.proof, minSequence: result.sequence + 1 } }, "rollback_detected"],
    [{ proof: { ...pins.proof, challenge: randomUUID() } }, "challenge_mismatch"],
    [{ backupId: randomUUID() }, "capture_archive_mismatch"],
    [{ archiveSha256: "0".repeat(64) }, "capture_archive_mismatch"],
  ])
    assert.throws(
      () =>
        verifyRecoveryCapture({
          path: f.outputPath,
          key: f.key,
          requirements: { ...pins, ...change },
        }),
      (e) => e.code === code,
    );
  assert.throws(
    () =>
      verifyRecoveryCapture({
        path: f.outputPath,
        key: f.key,
        requirements: pins,
        now: result.createdAt + 86400000,
      }),
    (e) => e.code === "stale_proof",
  );
  assert.throws(
    () =>
      verifyRecoveryCapture({
        path: f.outputPath,
        key: f.key,
        requirements: { ...pins, proof: { minSequence: result.sequence } },
      }),
    (e) => e.code === "independent_capture_requirements_required",
  );
  assert.deepEqual(readdirSync(f.manual).sort(), ["journal.gldcapture", "snapshot.gldbak"]);
});

test("authentication and journal/proof consistency are checked before trusting captured epochs", async (t) => {
  const f = await fixture(t),
    { pins } = await capture(f),
    original = readFileSync(f.outputPath);
  assert.throws(
    () => verifyRecoveryCapture({ path: f.outputPath, key: randomBytes(32), requirements: pins }),
    /authentication failed/,
  );
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  writeFileSync(f.outputPath, changed);
  assert.throws(
    () => verifyRecoveryCapture({ path: f.outputPath, key: f.key, requirements: pins }),
    /authentication failed/,
  );
  writeFileSync(f.outputPath, original);
  const value = verifyRecoveryCapture({
    path: f.outputPath,
    key: f.key,
    requirements: pins,
  }).capture;
  value.journal.sequence++;
  const wrong = join(f.manual, "inconsistent.gldcapture");
  encryptArchive(wrong, value, [], f.key);
  assert.throws(
    () => verifyRecoveryCapture({ path: wrong, key: f.key, requirements: pins }),
    (e) => e.code === "capture_journal_proof_mismatch",
  );
  assert.ok(!readdirSync(f.manual).some((name) => name.startsWith(".capture-")));
});

test("active source writer, existing output and descendant output fail closed", async (t) => {
  const f = await fixture(t),
    release = await acquireDataRootLease(f.dataRoot);
  try {
    await assert.rejects(createRecoveryCapture(f), (e) => e.code === "writer_active");
  } finally {
    await release();
  }
  assert.equal(existsSync(f.outputPath), false);
  await assert.rejects(
    createRecoveryCapture({ ...f, outputPath: join(f.dataRoot, "..fake/capture") }),
    (e) => e.code === "capture_output_inside_source",
  );
  assert.equal(existsSync(join(f.dataRoot, "..fake")), false);
  const { pins } = await capture(f),
    before = readFileSync(f.outputPath);
  await assert.rejects(
    createRecoveryCapture(f),
    (e) => e.code === "capture_output_exists_or_unsafe",
  );
  assert.deepEqual(readFileSync(f.outputPath), before);
  verifyRecoveryCapture({ path: f.outputPath, key: f.key, requirements: pins });
});

test("manual command creation and verification use configured inventory and expose no journal contents", async (t) => {
  const f = await fixture(t),
    values = {
      DISCORD_GUILD_ID: guildId,
      OWNER_USER_ID: ownerId,
      DATABASE_PATH: f.installations[0].databasePath,
      CONFIG_PATH: f.installations[0].configPath,
      HEALTH_PATH: join(f.dataRoot, "health.json"),
      BACKUP_ENCRYPTION_KEY: f.key.toString("base64url"),
    };
  const created = await recoveryCommand(
    "capture",
    { archive: f.archivePath, output: f.outputPath, challenge: f.challenge },
    values,
  );
  const { createHash } = await import("node:crypto");
  f.archiveHash = createHash("sha256").update(readFileSync(f.archivePath)).digest("hex");
  const requirementPath = join(f.manual, "requirements.json");
  writeFileSync(requirementPath, JSON.stringify(requirements(f, created)), { mode: 0o600 });
  rmSync(f.dataRoot, { recursive: true });
  const result = await recoveryCommand(
    "verify-capture",
    { capture: f.outputPath, requirements: requirementPath },
    { BACKUP_ENCRYPTION_KEY: values.BACKUP_ENCRYPTION_KEY },
  );
  assert.equal(result.state, "manual_recovery_capture_verified");
  assert.equal(result.activeGuilds, 1);
  assert.equal(result.activationAllowed, false);
  assert.equal(result.writesAfterCaptureExcluded, false);
  assert.equal(result.journal, undefined);
  assert.equal(result.key, undefined);
  assert.equal(result.proof, undefined);
});

test("a captured retired guild retains its last epoch, counter floor and acceptance deletions", async (t) => {
  const f = await fixture(t),
    installation = f.installations[0],
    releaseRoot = await acquireDataRootLease(f.dataRoot),
    releaseGuild = await acquireLock(installation.databasePath, { createTarget: false });
  let store;
  try {
    let canonical = f.installations;
    const port = openRulesDeletionLifecycle({
      dataRoot: f.dataRoot,
      readCanonicalInstallations: () => canonical,
      ownership: {
        assertHeld() {},
        assertQuiescent() {},
        assertGuildLease(gid, path) {
          assert.equal(gid, guildId);
          assert.equal(path, installation.databasePath);
        },
      },
    });
    store = new Store(installation.databasePath, guildId);
    const jobs = new JobStore(store.db),
      acceptanceId = randomUUID(),
      retiredAt = Date.now();
    jobs.transaction(() => {
      recordRulesDeletion(
        store.db,
        guildId,
        acceptanceId,
        retiredAt,
        retiredAt + rulesDeletionRetentionMs,
      );
      store.db
        .prepare("INSERT INTO server_rules_retired_acceptances VALUES(?,?,?,?)")
        .run(guildId, acceptanceId, retiredAt, retiredAt + rulesDeletionRetentionMs);
    });
    await port.drainActiveOutbox({ stores: [{ guildId, jobs }] });
    const active = readRulesDeletionLifecycleJournal(f.dataRoot).active[0],
      identity = lstatSync(installation.databasePath, { bigint: true }),
      operationId = randomUUID(),
      pending = {
        format: 1,
        guildId,
        removedAt: retiredAt - 30 * 86400000,
        phase: "committed",
        public: false,
        databasePath: installation.databasePath,
        databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) },
        assetNames: [],
      },
      retentionRoot = join(f.dataRoot, "uninstall-retention"),
      pendingPath = join(retentionRoot, guildId + ".pending.json");
    mkdirSync(retentionRoot, { recursive: true, mode: 0o700 });
    writeFileSync(pendingPath, JSON.stringify(pending), { mode: 0o600 });
    store.close();
    store = undefined;
    await port.prepareRetirement({ guildId, expectedEpoch: active.epoch, operationId });
    for (const suffix of ["-wal", "-shm", ""]) {
      const path = installation.databasePath + suffix;
      if (existsSync(path)) rmSync(path);
    }
    pending.phase = "registry_done";
    writeFileSync(pendingPath, JSON.stringify(pending));
    writeFileSync(
      join(retentionRoot, guildId + ".deleted.json"),
      JSON.stringify({
        format: 1,
        guildId,
        removedAt: pending.removedAt,
        purgedAt: Date.now(),
        outcome: "purged",
      }),
      { mode: 0o600 },
    );
    canonical = [];
    await port.confirmRetired({ guildId, expectedEpoch: active.epoch, operationId });
    f.installations = [];
    f.acceptanceId = acceptanceId;
    f.retiredEpoch = active.epoch;
  } finally {
    store?.close();
    await releaseGuild();
    await releaseRoot();
  }
  const { pins } = await capture(f),
    original = readRulesDeletionLifecycleJournal(f.dataRoot);
  rmSync(f.dataRoot, { recursive: true });
  const { capture: value } = verifyRecoveryCapture({
    path: f.outputPath,
    key: f.key,
    requirements: pins,
  });
  assert.deepEqual(value.journal, original);
  assert.equal(value.journal.active.length, 0);
  assert.equal(value.journal.retired[0].lastEpoch, f.retiredEpoch);
  assert.equal(value.journal.retired[0].through, 1);
  assert.equal(value.journal.entries[0].acceptanceId, f.acceptanceId);
});

test("the actual CLI accepts capture flags, rejects duplicates and verifies after source removal", async (t) => {
  const f = await fixture(t),
    base = Object.fromEntries(
      ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]]),
    ),
    credentials = { BACKUP_ENCRYPTION_KEY: f.key.toString("base64url") },
    env = {
      ...base,
      ...credentials,
      DISCORD_GUILD_ID: guildId,
      OWNER_USER_ID: ownerId,
      DATABASE_PATH: f.installations[0].databasePath,
      CONFIG_PATH: f.installations[0].configPath,
      HEALTH_PATH: join(f.dataRoot, "health.json"),
    },
    run = (args, values = env) =>
      spawnSync(process.execPath, ["scripts/recovery.mjs", ...args], {
        cwd: process.cwd(),
        env: values,
        encoding: "utf8",
        timeout: 20000,
      }),
    flags = ["--archive", f.archivePath, "--output", f.outputPath, "--challenge", f.challenge];
  const rejected = run(["capture", ...flags, "--challenge", f.challenge]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Invalid recovery options/);
  assert.equal(existsSync(f.outputPath), false);
  const created = run(["capture", ...flags]);
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout),
    { createHash } = await import("node:crypto");
  f.archiveHash = createHash("sha256").update(readFileSync(f.archivePath)).digest("hex");
  const requirementsPath = join(f.manual, "requirements.json");
  writeFileSync(requirementsPath, JSON.stringify(requirements(f, receipt)), { mode: 0o600 });
  rmSync(f.dataRoot, { recursive: true });
  const verified = run(
    ["verify-capture", "--capture", f.outputPath, "--requirements", requirementsPath],
    { ...base, ...credentials },
  );
  assert.equal(verified.status, 0, verified.stderr);
  const value = JSON.parse(verified.stdout);
  assert.equal(value.state, "manual_recovery_capture_verified");
  assert.equal(value.activationAllowed, false);
  for (const output of [created.stdout, verified.stdout]) {
    assert.ok(!output.includes(credentials.BACKUP_ENCRYPTION_KEY));
    assert.ok(!output.includes('"journal"'));
    assert.ok(!output.includes('"proof"'));
    assert.ok(!output.includes('"epoch"'));
  }
});

test("read-only verification refuses absent input without creating directories or scratch", async (t) => {
  const f = await fixture(t),
    { pins } = await capture(f),
    absent = join(f.root, "absent");
  assert.throws(() =>
    verifyRecoveryCapture({
      path: join(absent, "capture.gldcapture"),
      key: f.key,
      requirements: pins,
    }),
  );
  assert.equal(existsSync(absent), false);
  assert.throws(() =>
    verifyRecoveryCapture({ path: f.outputPath, key: "invalid", requirements: pins }),
  );
  assert.ok(!readdirSync(f.manual).some((name) => name.startsWith(".capture-")));
});
