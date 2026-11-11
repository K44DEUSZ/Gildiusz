import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { setImmediate } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { sealLatestDeletionProof, importLatestDeletionProof } from "../scripts/backup-proof.mjs";
import { acquireLock } from "../dist/storage/lock.js";
import { initializeRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import {
  upgradeRulesDeletionLifecycle,
  snapshotRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";
import { assertSourcePreparationComplete } from "../dist/storage/recovery/lease.js";
import {
  createSnapshot,
  createSnapshotWithSourceLease,
} from "../dist/storage/recovery/snapshot.js";
import { withRecoverySourceLease } from "../dist/storage/recovery/source-lease.js";
import { createColdRecoveryPair, verifyRecoveryCapture } from "../scripts/recovery-capture.mjs";
import {
  restoreColdRecoveryTarget,
  planColdRecoveryFinalization,
  applyColdRecoveryFinalization,
} from "../scripts/recovery-finalize.mjs";
import { assertRestoreStartupAllowed } from "../dist/storage/recovery/lease.js";
import * as oldRuntime from "./fixtures/recovery/stable-2a-guards.mjs";

const guildId = "100000000000000001",
  ownerId = "100000000000000002";
function removeSyntheticSource(f) {
  assert.equal(dirname(resolve(f.root)), resolve(tmpdir()));
  assert.equal(resolve(f.dataRoot), join(resolve(f.root), "source"));
  rmSync(f.dataRoot, { recursive: true });
}
async function fixture(t, web = false) {
  const root = mkdtempSync(join(tmpdir(), "gld-final-")),
    dataRoot = join(root, "source"),
    manual = join(root, "manual"),
    key = randomBytes(32);
  for (const path of [root, dataRoot, manual]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const guild = {
    guildId,
    ownerId,
    databasePath: join(dataRoot, "guilds", guildId, "gildiusz.sqlite"),
    configPath: join(dataRoot, "configuration.json"),
  };
  const store = new Store(guild.databasePath, guildId);
  for (const path of [dirname(dirname(guild.databasePath)), dirname(guild.databasePath)])
    chmodSync(path, 0o700);
  store.close();
  writeFileSync(guild.configPath, "{}", { mode: 0o600 });
  await initializeRulesDeletionJournal({ dataRoot, installations: [guild] });
  await upgradeRulesDeletionLifecycle({ dataRoot, installations: [guild] });
  const options = {
    dataRoot,
    guilds: [guild],
    outputPath: join(manual, "snapshot.gldbak"),
    capturePath: join(manual, "capture.gldcapture"),
    challenge: randomUUID(),
    key,
  };
  if (web) {
    options.webDatabasePath = join(root, "web.sqlite");
    const db = new DatabaseSync(options.webDatabasePath);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY,token TEXT); CREATE TABLE oauth_states(id TEXT); CREATE TABLE preview_config(user_id TEXT,guild_id TEXT,body TEXT)",
    );
    db.close();
  }
  t.after(() => {
    key.fill(0);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dataRoot, manual, key, guild, options };
}

test("cold v2 pair owns one compound source boundary and retains canonical identity", async (t) => {
  const f = await fixture(t),
    result = await createColdRecoveryPair(f.options);
  const verified = verifyRecoveryCapture({
    path: f.options.capturePath,
    key: f.key,
    requirements: result.verificationRequirements,
  });
  assert.equal(verified.capture.format, 2);
  assert.equal(verified.capture.coldPair.active[0].ownerId, ownerId);
  assert.equal(verified.capture.coldPair.active[0].public, false);
  assert.equal(verified.capture.coldPair.active[0].through, 0);
  assert.equal(verified.capture.coldPair.active[0].epoch, verified.capture.journal.active[0].epoch);
  assert.equal(result.sourceRemainsSealed, true);
  assert.equal(result.cryptographicProofOfNoLaterWrites, false);
  assert.throws(() => assertSourcePreparationComplete(f.dataRoot), /sealed/);
  await assert.rejects(
    snapshotRulesDeletionLifecycle({ dataRoot: f.dataRoot, installations: [f.guild] }),
    /sealed/,
  );
  await assert.rejects(
    createSnapshot({ ...f.options, outputPath: join(f.manual, "later.gldbak") }),
    /sealed/,
  );
});

test("actual stable2a startup guard rejects the compatibility fence, including partial dual-marker creation", async (t) => {
  const f = await fixture(t);
  oldRuntime.assertSourcePreparationComplete(f.dataRoot);
  await createColdRecoveryPair(f.options);
  assert.throws(
    () => oldRuntime.assertSourcePreparationComplete(f.dataRoot),
    /source preparation is incomplete/,
  );
  assert.equal(
    readFileSync(join(f.dataRoot, "source-preparation.json"), "utf8"),
    readFileSync(join(f.dataRoot, "source-cold-pair.json"), "utf8"),
  );
  rmSync(join(f.dataRoot, "source-cold-pair.json"));
  assert.throws(
    () => oldRuntime.assertSourcePreparationComplete(f.dataRoot),
    /source preparation is incomplete/,
  );
  await assert.rejects(
    snapshotRulesDeletionLifecycle({ dataRoot: f.dataRoot, installations: [f.guild] }),
    /sealed/,
  );
});

test("forged, released and mismatched source capabilities never authorize snapshot writes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createSnapshotWithSourceLease(f.options, {}), /compound/);
  let released;
  await withRecoverySourceLease(f.options, async (lease) => {
    released = lease;
    await assert.rejects(
      createSnapshotWithSourceLease({ ...f.options, dataRoot: f.manual }, lease),
      /mismatch/,
    );
  });
  await assert.rejects(createSnapshotWithSourceLease(f.options, released), /compound/);
  assert.equal(existsSync(f.options.outputPath), false);
});

test("owned snapshot detaches mutable caller configuration before native awaits", async (t) => {
  const f = await fixture(t),
    other = join(f.dataRoot, "unleased.json");
  writeFileSync(other, '{"unleased":true}', { mode: 0o600 });
  await withRecoverySourceLease(f.options, async (lease) => {
    const promise = createSnapshotWithSourceLease(f.options, lease);
    setImmediate(() => {
      f.guild.configPath = other;
      f.guild.ownerId = "100000000000000009";
    });
    const manifest = await promise;
    assert.equal(manifest.guilds[0].ownerId, ownerId);
    const file = manifest.files.find(
      (file) => file.kind === "configuration" && file.guildId === guildId,
    );
    assert.notEqual(
      file.sha256,
      (await import("node:crypto")).createHash("sha256").update(readFileSync(other)).digest("hex"),
    );
  });
});

test("a snapshot released during its native await cannot publish an archive", async (t) => {
  const f = await fixture(t);
  let pending;
  await withRecoverySourceLease(f.options, async (lease) => {
    pending = createSnapshotWithSourceLease(f.options, lease);
    pending.catch(() => {});
  });
  await assert.rejects(pending, /compound/);
  assert.equal(existsSync(f.options.outputPath), false);
});

test("a live guild lease or SQLite web writer prevents the cold pair before sealing", async (t) => {
  const f = await fixture(t, true),
    release = await acquireLock(f.guild.databasePath, { createTarget: false });
  await assert.rejects(createColdRecoveryPair(f.options));
  assert.equal(existsSync(join(f.dataRoot, "source-cold-pair.json")), false);
  await release();
  const web = new DatabaseSync(f.options.webDatabasePath);
  try {
    web.exec("BEGIN IMMEDIATE");
    await assert.rejects(createColdRecoveryPair(f.options), /locked/);
    assert.equal(existsSync(join(f.dataRoot, "source-cold-pair.json")), false);
  } finally {
    web.exec("ROLLBACK");
    web.close();
  }
  assert.equal(existsSync(f.options.outputPath), false);
});

test("cold pair can copy a quiescent web database while SQLite enforces its writer fence", async (t) => {
  const f = await fixture(t, true),
    result = await createColdRecoveryPair(f.options);
  assert.ok(readFileSync(f.options.outputPath).length);
  assert.equal(result.sourceRemainsSealed, true);
  assert.equal(
    readFileSync(f.options.webDatabasePath + ".source-cold-pair.json", "utf8"),
    readFileSync(join(f.dataRoot, "source-cold-pair.json"), "utf8"),
  );
});

test("controlled cold restore plans without target writes then rebases the actual new physical installation", async (t) => {
  const f = await fixture(t, true),
    sourceWeb = new DatabaseSync(f.options.webDatabasePath);
  sourceWeb.exec(
    "INSERT INTO sessions VALUES('session','private session token'); INSERT INTO oauth_states VALUES('oauth');",
  );
  sourceWeb
    .prepare("INSERT INTO preview_config VALUES(?,?,'saved personal preview')")
    .run(ownerId, guildId);
  sourceWeb.close();
  const capture = await createColdRecoveryPair(f.options),
    options = {
      archivePath: f.options.outputPath,
      capturePath: f.options.capturePath,
      targetRoot: join(f.root, "restored"),
      requirements: capture.verificationRequirements,
      key: f.key,
    };
  removeSyntheticSource(f);
  assert.equal((await restoreColdRecoveryTarget(options)).activationAllowed, false);
  const targetWebPeer = join(options.targetRoot, "web/web.sqlite.restore-quarantine.json");
  assert.equal(existsSync(targetWebPeer), true);
  assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
  const planned = await planColdRecoveryFinalization(options);
  assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
  const result = await applyColdRecoveryFinalization({
    ...options,
    plan: planned.plan,
    approve: planned.sha256,
  });
  assert.equal(result.activationAllowed, true);
  assert.equal(result.automaticResume, false);
  assert.doesNotThrow(() => assertRestoreStartupAllowed(options.targetRoot));
  assert.equal(existsSync(targetWebPeer), false);
  const targetWeb = new DatabaseSync(join(options.targetRoot, "web/web.sqlite"), {
    readOnly: true,
  });
  try {
    for (const table of ["sessions", "oauth_states", "preview_config"])
      assert.equal(targetWeb.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0);
  } finally {
    targetWeb.close();
  }
  const snapshot = await snapshotRulesDeletionLifecycle({
    dataRoot: options.targetRoot,
    installations: [
      { guildId, databasePath: join(options.targetRoot, planned.plan.guilds[0].databasePath) },
    ],
  });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.sourceId, capture.sourceId);
  assert.equal(snapshot.sequence, capture.sequence + 1);
  assert.notEqual(snapshot.active[0].epoch, planned.plan.guilds[0].original.epoch);
  assert.equal(
    (
      await applyColdRecoveryFinalization({
        ...options,
        plan: planned.plan,
        approve: planned.sha256,
      })
    ).activationAllowed,
    true,
  );
});

test("every durable finalization boundary stays guarded and replays the exact plan", async (t) => {
  const phases = [
    "intent_durable",
    "preparation_guard_durable",
    "history_durable:" + guildId,
    "guild_ready:" + guildId,
    "web_ready",
    "lineage_history_durable",
    "database_swapped:guilds/" + guildId + "/gildiusz.sqlite",
    "database_swapped:web/web.sqlite",
    "registry_written:guilds.json",
    "source_policy_durable",
    "source_journal_durable",
    "final_receipt_durable",
    "staging_history_cleaned",
    "preparation_guard_retired",
    "web_quarantine_retired",
    "quarantine_retired",
  ];
  for (const phase of phases)
    await t.test(phase, async (t) => {
      const f = await fixture(t, true),
        capture = await createColdRecoveryPair(f.options),
        options = {
          archivePath: f.options.outputPath,
          capturePath: f.options.capturePath,
          targetRoot: join(f.root, "restored"),
          requirements: capture.verificationRequirements,
          key: f.key,
        };
      removeSyntheticSource(f);
      await restoreColdRecoveryTarget(options);
      const planned = await planColdRecoveryFinalization(options);
      let stopped = false;
      await assert.rejects(
        applyColdRecoveryFinalization({
          ...options,
          plan: planned.plan,
          approve: planned.sha256,
          onStage(name) {
            if (name === phase) {
              stopped = true;
              throw new Error("injected crash");
            }
          },
        }),
        /injected crash/,
      );
      assert.equal(stopped, true);
      if (phase !== "quarantine_retired")
        assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
      assert.equal(
        (
          await applyColdRecoveryFinalization({
            ...options,
            plan: planned.plan,
            approve: planned.sha256,
          })
        ).activationAllowed,
        true,
      );
      const scope = await snapshotRulesDeletionLifecycle({
        dataRoot: options.targetRoot,
        installations: [
          { guildId, databasePath: join(options.targetRoot, planned.plan.guilds[0].databasePath) },
        ],
      });
      assert.equal(scope.complete, true);
      assert.equal(scope.sourceId, capture.sourceId);
      assert.equal(scope.sequence, capture.sequence + 1);
    });
});

test("changed approval, target bytes, purge scope and source fence never authorize activation", async (t) => {
  for (const variant of ["approval", "target", "scope", "source-fence"])
    await t.test(variant, async (t) => {
      const f = await fixture(t),
        capture = await createColdRecoveryPair(f.options),
        options = {
          archivePath: f.options.outputPath,
          capturePath: f.options.capturePath,
          targetRoot: join(f.root, "restored"),
          requirements: capture.verificationRequirements,
          key: f.key,
        };
      await restoreColdRecoveryTarget(options);
      const planned = await planColdRecoveryFinalization(options);
      if (variant === "target")
        writeFileSync(
          join(options.targetRoot, "configuration", guildId + ".json"),
          '{"changed":true}',
          { mode: 0o600 },
        );
      if (variant === "scope") planned.plan.removed.push("configuration/" + guildId + ".json");
      if (variant === "source-fence") rmSync(join(f.dataRoot, "source-cold-pair.json"));
      const approve =
        variant === "approval"
          ? "0".repeat(64)
          : variant === "scope"
            ? (await import("../dist/storage/recovery/finalize.js")).digest(
                JSON.stringify(planned.plan),
              )
            : planned.sha256;
      await assert.rejects(
        applyColdRecoveryFinalization({ ...options, plan: planned.plan, approve }),
      );
      assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
      assert.equal(existsSync(join(options.targetRoot, "recovery-finalization")), false);
    });
});

test("caller mutations after approval cannot change deletion, retention or shared database scope", async (t) => {
  const f = await fixture(t, true),
    capture = await createColdRecoveryPair(f.options),
    options = {
      archivePath: f.options.outputPath,
      capturePath: f.options.capturePath,
      targetRoot: join(f.root, "restored"),
      requirements: capture.verificationRequirements,
      key: f.key,
    };
  removeSyntheticSource(f);
  await restoreColdRecoveryTarget(options);
  const planned = await planColdRecoveryFinalization(options),
    original = globalThis.structuredClone(planned.plan),
    originalRequirements = globalThis.structuredClone(options.requirements);
  const result = await applyColdRecoveryFinalization({
    ...options,
    plan: planned.plan,
    approve: planned.sha256,
    onStage(name) {
      if (name === "intent_durable") {
        planned.plan.removed.push(`configuration/${guildId}.json`);
        planned.plan.guilds[0].history.entries.push({ unapproved: true });
        planned.plan.shared[0].after = "0".repeat(64);
        options.requirements.proof.expectedSourceId = randomUUID();
      }
    },
  });
  assert.equal(result.activationAllowed, true);
  assert.equal(existsSync(join(options.targetRoot, "configuration", guildId + ".json")), true);
  assert.equal(
    (
      await applyColdRecoveryFinalization({
        ...options,
        requirements: originalRequirements,
        plan: original,
        approve: planned.sha256,
      })
    ).activationAllowed,
    true,
  );
});

test("a valid signed guild receipt cannot impersonate the Web database slot", async (t) => {
  const f = await fixture(t, true),
    web = new DatabaseSync(f.options.webDatabasePath);
  web.prepare("INSERT INTO preview_config VALUES(?,?,'private preview')").run(ownerId, guildId);
  web.close();
  const capture = await createColdRecoveryPair(f.options),
    options = {
      archivePath: f.options.outputPath,
      capturePath: f.options.capturePath,
      targetRoot: join(f.root, "restored"),
      requirements: capture.verificationRequirements,
      key: f.key,
    };
  removeSyntheticSource(f);
  await restoreColdRecoveryTarget(options);
  const planned = await planColdRecoveryFinalization(options);
  await assert.rejects(
    applyColdRecoveryFinalization({
      ...options,
      plan: planned.plan,
      approve: planned.sha256,
      onStage(name) {
        if (name === "web_ready")
          writeFileSync(
            join(options.targetRoot, "recovery-finalization/web.ready.json"),
            readFileSync(
              join(options.targetRoot, `recovery-finalization/guild-${guildId}.ready.json`),
            ),
            { mode: 0o600 },
          );
      },
    }),
    /slot_mismatch/,
  );
  assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
});

test("an own partial pre-intent temporary replays while an unrelated pre-intent file blocks", async (t) => {
  for (const own of [true, false])
    await t.test(own ? "owned partial atomic write" : "unknown residue", async (t) => {
      const f = await fixture(t),
        capture = await createColdRecoveryPair(f.options),
        options = {
          archivePath: f.options.outputPath,
          capturePath: f.options.capturePath,
          targetRoot: join(f.root, "restored"),
          requirements: capture.verificationRequirements,
          key: f.key,
        };
      removeSyntheticSource(f);
      await restoreColdRecoveryTarget(options);
      const planned = await planColdRecoveryFinalization(options),
        directory = join(options.targetRoot, "recovery-finalization");
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(
        join(directory, own ? "intent.json.recovery-tmp" : "unrelated.txt"),
        "partial",
        { mode: 0o600 },
      );
      if (own)
        assert.equal(
          (
            await applyColdRecoveryFinalization({
              ...options,
              plan: planned.plan,
              approve: planned.sha256,
            })
          ).activationAllowed,
          true,
        );
      else {
        await assert.rejects(
          applyColdRecoveryFinalization({
            ...options,
            plan: planned.plan,
            approve: planned.sha256,
          }),
          /unknown_pre_intent_file/,
        );
        assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
      }
    });
});

test("restore-time departure retention advances captured counters and the unchanged independent watermark", async (t) => {
  const f = await fixture(t),
    now = Date.now(),
    oldJoin = now - 50 * 86400000,
    newJoin = now - 86400000,
    version = randomUUID(),
    oldAcceptance = randomUUID(),
    currentAcceptance = randomUUID(),
    store = new Store(f.guild.databasePath, guildId);
  const jobs = new JobStore(store.db),
    grant = jobs.enqueue({
      guildId,
      type: "server-rules.grant-role",
      payload: { acceptanceId: oldAcceptance, userId: ownerId },
      dueAt: now,
      dedupeKey: "old-grant",
    });
  store.db.prepare("UPDATE jobs SET state='unknown' WHERE id=?").run(grant.id);
  store.db
    .prepare("INSERT INTO server_rules_versions VALUES(?,?,1,'{}','hash','active',?,?)")
    .run(guildId, version, now - 60 * 86400000, ownerId);
  store.db
    .prepare("INSERT INTO server_rules_settings VALUES(?,1,1,1,NULL,?)")
    .run(guildId, version);
  store.db
    .prepare("INSERT INTO server_rules_memberships VALUES(?,?,?,?,NULL,?)")
    .run(guildId, ownerId, oldJoin, now - 31 * 86400000, now);
  store.db
    .prepare("INSERT INTO server_rules_memberships VALUES(?,?,?,NULL,NULL,?)")
    .run(guildId, ownerId, newJoin, now);
  store.db
    .prepare(
      "INSERT INTO server_rules_acceptances VALUES(?,?,?,?,?,?,?,'button','unknown',?,NULL,NULL)",
    )
    .run(guildId, oldAcceptance, ownerId, oldJoin, version, ownerId, oldJoin + 1000, grant.id);
  store.db
    .prepare(
      "INSERT INTO server_rules_acceptances VALUES(?,?,?,?,?,?,?,'button','confirmed',NULL,?,NULL)",
    )
    .run(
      guildId,
      currentAcceptance,
      ownerId,
      newJoin,
      version,
      ownerId,
      newJoin + 1000,
      newJoin + 1000,
    );
  store.close();
  const capture = await createColdRecoveryPair(f.options),
    verified = verifyRecoveryCapture({
      path: f.options.capturePath,
      key: f.key,
      requirements: capture.verificationRequirements,
    }),
    directory = join(f.root, "independent-catalog"),
    oldEnvelope = Buffer.from(verified.capture.proof, "base64");
  await importLatestDeletionProof({
    directory,
    envelope: oldEnvelope,
    key: f.key,
    ...capture.verificationRequirements.proof,
  });
  removeSyntheticSource(f);
  const options = {
    archivePath: f.options.outputPath,
    capturePath: f.options.capturePath,
    targetRoot: join(f.root, "restored"),
    requirements: capture.verificationRequirements,
    key: f.key,
  };
  await restoreColdRecoveryTarget(options);
  const planned = await planColdRecoveryFinalization(options);
  assert.equal(planned.plan.guilds[0].original.through, 0);
  assert.equal(planned.plan.guilds[0].history.through, 1);
  await assert.rejects(
    applyColdRecoveryFinalization({
      ...options,
      plan: planned.plan,
      approve: planned.sha256,
      onStage(name) {
        if (name === "staging_history_cleaned") throw new Error("crash after own history cleanup");
      },
    }),
    /crash after own history cleanup/,
  );
  assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
  assert.equal(
    existsSync(join(options.targetRoot, `recovery-finalization/guild-${guildId}.history.json`)),
    false,
  );
  assert.equal(
    existsSync(join(options.targetRoot, "recovery-finalization/lineage-ready.json")),
    false,
  );
  const durableHistory = JSON.parse(
    readFileSync(join(options.targetRoot, "rules-acceptance-deletions/journal.json"), "utf8"),
  );
  assert.ok(durableHistory.entries.some((entry) => entry.acceptanceId === oldAcceptance));
  await applyColdRecoveryFinalization({ ...options, plan: planned.plan, approve: planned.sha256 });
  const databasePath = join(options.targetRoot, planned.plan.guilds[0].databasePath),
    db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(oldAcceptance),
      undefined,
    );
    assert.ok(
      db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(currentAcceptance),
    );
    assert.equal(db.prepare("SELECT state FROM jobs WHERE id=?").get(grant.id).state, "unknown");
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT payload FROM jobs WHERE id=?").get(grant.id).payload),
      {},
    );
    const state = db
      .prepare("SELECT * FROM server_rules_deletion_state WHERE guild_id=?")
      .get(guildId);
    assert.equal(state.sequence, 1);
    assert.equal(state.journaled_through, 1);
  } finally {
    db.close();
  }
  const fresh = await sealLatestDeletionProof({
    dataRoot: options.targetRoot,
    installations: [{ guildId, databasePath }],
    key: f.key,
    notBefore: Date.now(),
    challenge: randomUUID(),
  });
  await importLatestDeletionProof({
    directory,
    envelope: fresh.envelope,
    key: f.key,
    expectedSourceId: capture.sourceId,
    minSequence: capture.sequence,
    notBefore: capture.createdAt,
    challenge: fresh.meta.challenge,
    maxAgeMs: 86400000,
  });
  await assert.rejects(
    importLatestDeletionProof({
      directory,
      envelope: oldEnvelope,
      key: f.key,
      ...capture.verificationRequirements.proof,
    }),
    /rollback/,
  );
  const journalPath = join(options.targetRoot, "rules-acceptance-deletions/journal.json"),
    advanced = readFileSync(journalPath),
    registry = readFileSync(join(options.targetRoot, "guilds.json"));
  await assert.rejects(
    applyColdRecoveryFinalization({ ...options, plan: planned.plan, approve: planned.sha256 }),
    /advanced/,
  );
  assert.deepEqual(readFileSync(journalPath), advanced);
  assert.deepEqual(readFileSync(join(options.targetRoot, "guilds.json")), registry);
});

test("actual process exits during staging, swap and marker retirement replay safely", async (t) => {
  for (const phase of [
    "history_durable:" + guildId,
    "database_swapped:guilds/" + guildId + "/gildiusz.sqlite",
    "preparation_guard_retired",
  ])
    await t.test(phase, async (t) => {
      const f = await fixture(t),
        capture = await createColdRecoveryPair(f.options),
        options = {
          archivePath: f.options.outputPath,
          capturePath: f.options.capturePath,
          targetRoot: join(f.root, "restored"),
          requirements: capture.verificationRequirements,
        };
      removeSyntheticSource(f);
      await restoreColdRecoveryTarget({ ...options, key: f.key });
      const planned = await planColdRecoveryFinalization({ ...options, key: f.key }),
        inputPath = join(f.manual, "fault-input.json");
      writeFileSync(
        inputPath,
        JSON.stringify({ ...options, plan: planned.plan, approve: planned.sha256 }),
        { mode: 0o600 },
      );
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import{readFileSync}from'node:fs';import{applyColdRecoveryFinalization}from'./scripts/recovery-finalize.mjs';const input=JSON.parse(readFileSync(process.env.GLD_FAULT_INPUT,'utf8'));await applyColdRecoveryFinalization({...input,key:process.env.BACKUP_ENCRYPTION_KEY,onStage(name){if(name===process.env.GLD_FAULT_PHASE)process.exit(91)}});`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            GLD_FAULT_INPUT: inputPath,
            GLD_FAULT_PHASE: phase,
            BACKUP_ENCRYPTION_KEY: f.key.toString("base64url"),
          },
        },
      );
      assert.equal(child.status, 91, child.stderr);
      assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
      assert.equal(
        (
          await applyColdRecoveryFinalization({
            ...options,
            key: f.key,
            plan: planned.plan,
            approve: planned.sha256,
          })
        ).activationAllowed,
        true,
      );
    });
});

test("the actual cold CLI prepares, restores, plans and applies without secrets in arguments or output", async (t) => {
  const f = await fixture(t),
    requirementsPath = join(f.manual, "requirements.json"),
    target = join(f.root, "cli-target"),
    planPath = join(f.manual, "plan.json"),
    env = {
      ...process.env,
      BACKUP_ENCRYPTION_KEY: f.key.toString("base64url"),
      DATABASE_PATH: f.guild.databasePath,
      CONFIG_PATH: f.guild.configPath,
      HEALTH_PATH: join(f.dataRoot, "health.json"),
      CONTROL_DATA_DIR: join(f.dataRoot, "public-guilds"),
      GUILDS_PATH: "",
      DISCORD_GUILD_ID: guildId,
      OWNER_USER_ID: ownerId,
      BACKUP_WEB_DATABASE_PATH: "",
      INTEGRATIONS_DATABASE_PATH: "",
    },
    run = (command, flags) => {
      const child = spawnSync(
        process.execPath,
        ["scripts/recovery-finalize.mjs", command, ...flags],
        { cwd: process.cwd(), env, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.equal((child.stdout + child.stderr).includes(env.BACKUP_ENCRYPTION_KEY), false);
      return JSON.parse(child.stdout.trim());
    };
  const prepared = run("prepare", [
    "--archive",
    f.options.outputPath,
    "--capture",
    f.options.capturePath,
    "--challenge",
    f.options.challenge,
  ]);
  writeFileSync(requirementsPath, JSON.stringify(prepared.verificationRequirements), {
    mode: 0o600,
  });
  removeSyntheticSource(f);
  const flags = [
    "--archive",
    f.options.outputPath,
    "--capture",
    f.options.capturePath,
    "--requirements",
    requirementsPath,
    "--target",
    target,
  ];
  assert.equal(run("restore", flags).activationAllowed, false);
  const plan = run("plan", [...flags, "--output", planPath]);
  assert.equal(plan.activationAllowed, false);
  assert.equal(
    run("apply", [...flags, "--plan", planPath, "--approve", plan.sha256]).activationAllowed,
    true,
  );
});

test("CLI validates isolated configuration but cannot bypass an ancestor cold fence with HEALTH_PATH", async (t) => {
  const f = await fixture(t),
    configPath = join(f.manual, "server.json");
  writeFileSync(configPath, readFileSync(join(process.cwd(), "config/server.json")), {
    mode: 0o600,
  });
  await createColdRecoveryPair(f.options);
  const env = {
      ...process.env,
      GUILDS_PATH: "",
      DATABASE_PATH: f.guild.databasePath,
      HEALTH_PATH: join(f.manual, "unrelated-health.json"),
      CONFIG_PATH: configPath,
      DISCORD_GUILD_ID: guildId,
      OWNER_USER_ID: ownerId,
      DISCORD_TOKEN: "",
      DISCORD_CLIENT_ID: "100000000000000003",
    },
    before = readFileSync(f.guild.databasePath),
    output = join(f.manual, "must-not-exist.sqlite"),
    validate = spawnSync(process.execPath, ["dist/cli.js", "validate"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 30000,
    });
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).valid, true);
  const backup = spawnSync(process.execPath, ["dist/cli.js", "backup", "--output", output], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.notEqual(backup.status, 0);
  assert.match(backup.stderr, /sealed/);
  assert.equal(existsSync(output), false);
  assert.deepEqual(readFileSync(f.guild.databasePath), before);
});

test(
  "SIGKILL during staged history retains real leases until their expiry and then replays",
  { timeout: 210000 },
  async (t) => {
    const f = await fixture(t),
      capture = await createColdRecoveryPair(f.options),
      options = {
        archivePath: f.options.outputPath,
        capturePath: f.options.capturePath,
        targetRoot: join(f.root, "restored"),
        requirements: capture.verificationRequirements,
      };
    removeSyntheticSource(f);
    await restoreColdRecoveryTarget({ ...options, key: f.key });
    const planned = await planColdRecoveryFinalization({ ...options, key: f.key }),
      inputPath = join(f.manual, "power-input.json"),
      signalPath = join(f.manual, "power-ready.json");
    writeFileSync(
      inputPath,
      JSON.stringify({ ...options, plan: planned.plan, approve: planned.sha256 }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import{readFileSync,writeFileSync}from'node:fs';import{applyColdRecoveryFinalization}from'./scripts/recovery-finalize.mjs';const input=JSON.parse(readFileSync(process.env.GLD_FAULT_INPUT,'utf8'));await applyColdRecoveryFinalization({...input,key:process.env.BACKUP_ENCRYPTION_KEY,onStage(name){if(name.startsWith('history_durable:')){writeFileSync(process.env.GLD_FAULT_SIGNAL,'ready',{mode:384,flush:true});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}}});`,
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          GLD_FAULT_INPUT: inputPath,
          GLD_FAULT_SIGNAL: signalPath,
          BACKUP_ENCRYPTION_KEY: f.key.toString("base64url"),
        },
      },
    );
    let errors = "";
    child.stderr.on("data", (data) => {
      errors += data.toString();
    });
    const exited = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      for (let attempt = 0; !existsSync(signalPath) && attempt < 1000; attempt++) await delay(20);
      assert.equal(existsSync(signalPath), true, errors);
      child.kill("SIGKILL");
      await exited;
      assert.throws(() => assertRestoreStartupAllowed(options.targetRoot), /quarantined/);
      assert.equal(existsSync(join(options.targetRoot, ".runtime-data.lock")), true);
      await assert.rejects(
        applyColdRecoveryFinalization({
          ...options,
          key: f.key,
          plan: planned.plan,
          approve: planned.sha256,
        }),
        /lock|already/i,
      );
      for (let elapsed = 0; elapsed < 125; elapsed += 25) {
        t.diagnostic(`Waiting for real dead-owner lease expiry: ${elapsed}/125s`);
        await delay(25000);
      }
      assert.equal(
        (
          await applyColdRecoveryFinalization({
            ...options,
            key: f.key,
            plan: planned.plan,
            approve: planned.sha256,
          })
        ).activationAllowed,
        true,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
);
