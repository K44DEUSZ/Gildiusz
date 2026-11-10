import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { backupV2Fixture } from "./backup-v2-fixture.mjs";
import { BackupCatalog } from "../scripts/backup-catalog.mjs";
import { collectForOffsiteAck } from "../scripts/backup-collector.mjs";
import {
  prepareBeforeUpgrade,
  importOffsiteAck,
  verifyUpgradeCheckpoint,
} from "../scripts/backup-scheduler.mjs";
import {
  sealOffsiteAck,
  verifyOffsiteAck,
  readOffsiteFile,
  writeOffsiteFile,
} from "../scripts/backup-offsite.mjs";
import { snapshotRulesDeletionLifecycle } from "../dist/storage/rules-deletion-lifecycle.js";
import {
  beginUpgrade,
  pendingUpgrade,
  advanceUpgrade,
  authorizePreparedUpgrade,
  acquireUpgradePause,
  releaseAwaitingUpgrade,
} from "../scripts/hosting.mjs";

const fail = (code) => (error) => error.code === code;

test("ordinary preparation resumes the identical old release while waiting; a later source change cannot activate or change checkpoint identity", async (t) => {
  const f = await fixture(t),
    root = join(f.root, "available-host"),
    previous = "a".repeat(40),
    oldRelease = join(root, "releases", previous);
  mkdirSync(oldRelease, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "shared"), { mode: 0o700 });
  symlinkSync(oldRelease, join(root, "current"), process.platform === "win32" ? "junction" : "dir");
  writeOffsiteFile(
    join(root, "shared", "offsite-location.json"),
    Buffer.from(JSON.stringify({ format: 1, locationId: f.stage.transfer.destinationLocationId })),
  );
  let pending = beginUpgrade(
      root,
      f.options.targetRevision,
      previous,
      f.stage.transfer.destinationLocationId,
    ),
    resumes = 0,
    activations = 0;
  pending = advanceUpgrade(root, pending, {
    upgradeId: f.options.upgradeId,
    state: "awaiting_offsite",
    backupId: f.manifest.id,
    sha256: f.expected.sha256,
  });
  const resume = () => {
    resumes++;
    assert.equal(realpathSync(join(root, "current")), realpathSync(oldRelease));
  };
  const firstId = pending.backupId,
    firstUpgrade = pending.upgradeId;
  assert.equal(await releaseAwaitingUpgrade(root, pending, resume), true);
  assert.equal(existsSync(join(root, "shared", "paused")), false);
  assert.equal(resumes, 1);
  assert.equal(pendingUpgrade(root).state, "awaiting_offsite");
  const collected = await f.collect();
  await importOffsiteAck({ ...f.options, envelope: collected.ack });
  pending = acquireUpgradePause(root, pendingUpgrade(root));
  await assert.rejects(
    (async () => {
      await authorizePreparedUpgrade(root, f.options.targetRevision, () =>
        verifyUpgradeCheckpoint({
          ...f.options,
          sourceSnapshot: async () => ({
            ...(await f.options.sourceSnapshot()),
            sequence: f.stage.transfer.proof.sequence + 1,
          }),
        }),
      );
      activations++;
    })(),
    fail("offsite_source_changed"),
  );
  await releaseAwaitingUpgrade(root, pending, resume);
  assert.equal(resumes, 2);
  assert.equal(activations, 0);
  assert.equal(pendingUpgrade(root).backupId, firstId);
  assert.equal(pendingUpgrade(root).upgradeId, firstUpgrade);
  writeFileSync(join(root, "shared", "paused"), "Foreign pause.\n", { mode: 0o600 });
  assert.throws(
    () => acquireUpgradePause(root, pendingUpgrade(root)),
    /pause or PC identity changed/,
  );
  assert.equal(readFileSync(join(root, "shared", "paused"), "utf8"), "Foreign pause.\n");
});
async function fixture(t) {
  const f = await backupV2Fixture(t),
    pc = new BackupCatalog({ root: join(f.root, "independent-pc"), clock: () => f.now }),
    locationId = (await pc.read()).locationId,
    sealed = await f.seal(),
    upgradeId = randomUUID(),
    targetRevision = "b".repeat(40);
  const stage = await prepareBeforeUpgrade({
    catalog: f.catalog,
    archivePath: f.options.outputPath,
    manifest: f.manifest,
    key: f.key,
    upgradeId,
    targetRevision,
    latestProof: sealed.envelope,
    proofRequirements: sealed.proofRequirements,
    destinationLocationId: locationId,
  });
  const options = {
    catalog: f.catalog,
    id: f.manifest.id,
    key: f.key,
    upgradeId,
    targetRevision,
    destinationLocationId: locationId,
    sourceSnapshot: () =>
      snapshotRulesDeletionLifecycle({
        dataRoot: f.dataRoot,
        installations: f.installations,
        now: f.now,
      }),
  };
  return {
    ...f,
    base: f,
    pc,
    sealed,
    stage,
    options,
    collect: (extra) =>
      collectForOffsiteAck({
        catalog: pc,
        transfer: stage.transfer,
        envelope: sealed.envelope,
        existingArchivePath: f.options.outputPath,
        key: f.key,
        ...extra,
      }),
  };
}

test("source-local verification cannot activate; actual second catalogue receipt survives restart with the same archive and upgrade", async (t) => {
  const f = await fixture(t);
  assert.equal(f.stage.localVerificationSucceeded, true);
  assert.equal(f.stage.offsiteSuccess, false);
  assert.equal(f.stage.entry.checkpoint.offsiteAck, null);
  await assert.rejects(verifyUpgradeCheckpoint(f.options), fail("offsite_ack_required"));
  const collected = await f.collect();
  assert.equal(collected.offsiteSuccess, false);
  assert.equal(collected.localVerificationSucceeded, true);
  assert.deepEqual(
    readFileSync(f.pc.archivePath(f.manifest.id)),
    readFileSync(f.options.catalog.archivePath(f.manifest.id)),
  );
  assert.equal((await f.pc.inspectLocation()).complete, true);
  const imported = await importOffsiteAck({ ...f.options, envelope: collected.ack });
  assert.equal(imported.offsiteSuccess, true);
  assert.equal(imported.id, f.manifest.id);
  assert.equal(imported.checkpoint.upgradeId, f.stage.transfer.upgradeId);
  assert.equal(imported.checkpoint.healthyAt, null);
  const restarted = new BackupCatalog({ root: f.options.catalog.root, clock: () => f.base.now });
  assert.equal(
    (await verifyUpgradeCheckpoint({ ...f.options, catalog: restarted })).offsiteSuccess,
    true,
  );
  assert.equal(
    (await importOffsiteAck({ ...f.options, catalog: restarted, envelope: collected.ack })).id,
    f.manifest.id,
  );
  assert.equal((await restarted.read()).entries.length, 1);
  assert.equal((await f.pc.read()).entries.length, 1);
});

test("only the pinned independent catalogue can issue a matching PC receipt", async (t) => {
  const f = await fixture(t);
  for (const catalog of [f.options.catalog, new BackupCatalog({ root: join(f.root, "foreign") })])
    await assert.rejects(f.collect({ catalog }), fail("offsite_location_mismatch"));
  const collected = await f.collect(),
    before = await f.options.catalog.read();
  const bytes = Buffer.from(collected.ack);
  bytes[bytes.length - 5] ^= 1;
  for (const extra of [
    { envelope: bytes },
    { key: randomBytes(32), envelope: collected.ack },
    { destinationLocationId: randomUUID(), envelope: collected.ack },
    { upgradeId: randomUUID(), envelope: collected.ack },
    { targetRevision: "c".repeat(40), envelope: collected.ack },
  ])
    await assert.rejects(importOffsiteAck({ ...f.options, ...extra }));
  assert.equal((await f.options.catalog.read()).entries[0].checkpoint.offsiteAck, null);
  assert.deepEqual((await f.options.catalog.read()).entries, before.entries);
});

test("signed receipt cannot substitute archive SHA, source, sequence or challenge, even when the sender knows the test key", async (t) => {
  const f = await fixture(t),
    collected = await f.collect();
  for (const change of [
    (transfer) => {
      transfer.backup.sha256 = "c".repeat(64);
    },
    (transfer) => {
      transfer.proof.sourceId = randomUUID();
    },
    (transfer) => {
      transfer.proof.sequence++;
    },
    (transfer) => {
      transfer.proof.challenge = randomUUID();
    },
    (transfer) => {
      transfer.proof.sha256 = "d".repeat(64);
    },
  ]) {
    const transfer = globalThis.structuredClone(f.stage.transfer);
    change(transfer);
    const ack = sealOffsiteAck({ transfer, key: f.key, verifiedAt: f.base.now, now: f.base.now });
    await assert.rejects(
      importOffsiteAck({ ...f.options, envelope: ack }),
      fail("offsite_ack_mismatch"),
    );
  }
  await importOffsiteAck({ ...f.options, envelope: collected.ack });
  assert.equal((await verifyUpgradeCheckpoint(f.options)).offsiteSuccess, true);
});

test("source mutation, missing current proof and exact proof expiry fail closed after a prior valid ACK", async (t) => {
  const f = await fixture(t),
    collected = await f.collect();
  await importOffsiteAck({ ...f.options, envelope: collected.ack });
  for (const patch of [
    { complete: false },
    { sequence: f.stage.transfer.proof.sequence + 1 },
    { sourceId: randomUUID() },
  ])
    await assert.rejects(
      verifyUpgradeCheckpoint({
        ...f.options,
        sourceSnapshot: async () => ({
          ...(await f.options.sourceSnapshot()),
          ...patch,
        }),
      }),
      fail("offsite_source_changed"),
    );
  f.base.now = f.stage.transfer.proof.expiresAt;
  await assert.rejects(verifyUpgradeCheckpoint(f.options), fail("offsite_proof_expired"));
  assert.ok(await f.options.catalog.read()); // Expired checkpoint remains readable for physical rotation.
  f.base.now--;
  unlinkSync(
    join(
      f.options.catalog.root,
      "deletion-ledger",
      `deletion-proof-${f.stage.transfer.proof.id}.gldproof`,
    ),
  );
  await assert.rejects(verifyUpgradeCheckpoint(f.options));
  assert.equal(existsSync(f.options.catalog.archivePath(f.manifest.id)), true);
});

test("PC decoder/abort failure and current-proof replacement never produce a receipt", async (t) => {
  const f = await fixture(t),
    controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(f.collect({ signal: controller.signal }), fail("backup_transfer_aborted"));
  await assert.rejects(f.collect({ key: randomBytes(32) }));
  assert.equal((await f.pc.read()).entries.length, 0);
});

test("receipt files are private bounded physical files and authentication rejects extra fields", async (t) => {
  const f = await fixture(t),
    collected = await f.collect(),
    path = join(f.root, "ack.json");
  writeOffsiteFile(path, collected.ack);
  assert.deepEqual(readOffsiteFile(path), collected.ack);
  const value = JSON.parse(collected.ack);
  value.extra = true;
  assert.throws(
    () =>
      verifyOffsiteAck({
        envelope: Buffer.from(JSON.stringify(value)),
        transfer: f.stage.transfer,
        key: f.key,
        now: f.base.now,
      }),
    fail("invalid_offsite_ack"),
  );
  writeFileSync(path, Buffer.alloc(8193));
  assert.throws(() => readOffsiteFile(path), fail("offsite_file_budget"));
});

test("prepared installation persists across restart, refuses absent ACK and checks the pause again after asynchronous verification", async (t) => {
  const f = await fixture(t),
    root = join(f.root, "hosting");
  mkdirSync(join(root, "shared"), { recursive: true, mode: 0o700 });
  writeOffsiteFile(
    join(root, "shared", "offsite-location.json"),
    Buffer.from(JSON.stringify({ format: 1, locationId: f.stage.transfer.destinationLocationId })),
  );
  const pending = beginUpgrade(
    root,
    f.options.targetRevision,
    "a".repeat(40),
    f.stage.transfer.destinationLocationId,
  );
  advanceUpgrade(root, pending, {
    upgradeId: f.options.upgradeId,
    state: "awaiting_offsite",
    backupId: f.manifest.id,
    sha256: f.expected.sha256,
  });
  const pause = readFileSync(join(root, "shared", "paused")),
    original = pendingUpgrade(root);
  await assert.rejects(
    authorizePreparedUpgrade(root, f.options.targetRevision, () =>
      verifyUpgradeCheckpoint(f.options),
    ),
    fail("offsite_ack_required"),
  );
  assert.deepEqual(pendingUpgrade(root), original);
  assert.deepEqual(readFileSync(join(root, "shared", "paused")), pause);
  const collected = await f.collect();
  await importOffsiteAck({ ...f.options, envelope: collected.ack });
  await assert.rejects(
    authorizePreparedUpgrade(root, f.options.targetRevision, async () => {
      const checked = await verifyUpgradeCheckpoint(f.options);
      writeFileSync(join(root, "shared", "paused"), "Manual pause.\n");
      return checked;
    }),
    /pause or PC identity changed/,
  );
  assert.equal(pendingUpgrade(root).state, "awaiting_offsite");
  writeFileSync(join(root, "shared", "paused"), pause);
  const activated = await authorizePreparedUpgrade(root, f.options.targetRevision, () =>
    verifyUpgradeCheckpoint(f.options),
  );
  assert.equal(activated.state, "activating");
  assert.equal(activated.backupId, original.backupId);
  assert.equal(activated.upgradeId, original.upgradeId);
  assert.deepEqual(readFileSync(join(root, "shared", "paused")), pause);
});

test("an operator pause is never adopted by an automatic preparation; explicit adoption retains a durable owned pause", async (t) => {
  const f = await fixture(t),
    root = join(f.root, "paused-host");
  mkdirSync(join(root, "shared"), { recursive: true, mode: 0o700 });
  const path = join(root, "shared", "paused");
  writeFileSync(path, "Paused by operator.\n", { mode: 0o600 });
  assert.throws(
    () =>
      beginUpgrade(
        root,
        f.options.targetRevision,
        "a".repeat(40),
        f.stage.transfer.destinationLocationId,
      ),
    /EEXIST/,
  );
  assert.equal(readFileSync(path, "utf8"), "Paused by operator.\n");
  const pending = beginUpgrade(
    root,
    f.options.targetRevision,
    "a".repeat(40),
    f.stage.transfer.destinationLocationId,
    { adoptPause: true },
  );
  assert.equal(pending.state, "preparing");
  assert.equal(readFileSync(path, "utf8"), pending.pause);
  assert.deepEqual(pendingUpgrade(root), pending);
});

test("source revocation during final archive confirmation cannot authorize a previously valid receipt", async (t) => {
  const f = await fixture(t),
    collected = await f.collect();
  await importOffsiteAck({ ...f.options, envelope: collected.ack });
  let calls = 0;
  await assert.rejects(
    verifyUpgradeCheckpoint({
      ...f.options,
      sourceSnapshot: async () => ({
        ...(await f.options.sourceSnapshot()),
        complete: ++calls === 1,
      }),
    }),
    fail("offsite_source_changed"),
  );
});

test(
  "Windows manual FileManager-style files roundtrip through the actual collector and host acknowledgement CLIs",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t),
      envPath = join(f.root, "recovery.env"),
      metadataPath = join(f.root, "transfer.json"),
      proofPath = join(f.root, "proof.gldproof"),
      ackPath = join(f.root, "pc-ack.json");
    writeFileSync(
      envPath,
      Object.entries({
        BACKUP_ENCRYPTION_KEY: f.key.toString("base64url"),
        DISCORD_GUILD_ID: f.installations[0].guildId,
        OWNER_USER_ID: f.base.options.guilds[0].ownerId,
        CONFIG_PATH: f.base.options.guilds[0].configPath,
        DATABASE_PATH: f.installations[0].databasePath,
        HEALTH_PATH: join(f.dataRoot, "health.json"),
      })
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join("\n"),
      { mode: 0o600 },
    );
    writeOffsiteFile(metadataPath, Buffer.from(JSON.stringify(f.stage.transfer)));
    writeFileSync(proofPath, f.sealed.envelope, { mode: 0o600 });
    const command = (script, args) =>
      spawnSync(
        process.execPath,
        [
          `--env-file=${envPath}`,
          fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url)),
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
          env: Object.fromEntries(
            ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
              .filter((k) => process.env[k])
              .map((k) => [k, process.env[k]]),
          ),
        },
      );
    const collected = command("backup-collector", [
      "collect-offsite",
      "--catalog",
      f.pc.root,
      "--archive",
      f.base.options.outputPath,
      "--metadata",
      metadataPath,
      "--proof",
      proofPath,
      "--receipt-output",
      ackPath,
    ]);
    assert.equal(collected.status, 0, collected.stderr);
    assert.equal(JSON.parse(collected.stdout).offsiteSuccess, false);
    assert.equal(JSON.parse(collected.stdout).receiptWritten, true);
    const args = [
      f.options.catalog.root,
      "--id",
      f.manifest.id,
      "--upgrade-id",
      f.options.upgradeId,
      "--target-revision",
      f.options.targetRevision,
      "--pc-location",
      f.stage.transfer.destinationLocationId,
    ];
    const imported = command("backup-scheduler", [
      "import-offsite-ack",
      ...args,
      "--receipt",
      ackPath,
    ]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).offsiteSuccess, true);
    const checked = command("backup-scheduler", ["verify-checkpoint", ...args]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).id, f.manifest.id);
    for (const result of [collected, imported, checked])
      assert.equal((result.stdout + result.stderr).includes(f.key.toString("base64url")), false);
  },
);
