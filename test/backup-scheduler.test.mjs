import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createSnapshot } from "../dist/storage/recovery/index.js";
import { BackupCatalog } from "../scripts/backup-catalog.mjs";
import {
  captureStoppedBackup,
  hostingLifecycle,
  planDailyBackup,
  registerBeforeUpgrade,
  runDailyBackup,
  withHostingBackupLock,
} from "../scripts/backup-scheduler.mjs";
import { sealLatestDeletionLedger } from "../scripts/backup-ledger.mjs";
import { backupFixture } from "./backup-fixture.mjs";
import { backupV2Fixture } from "./backup-v2-fixture.mjs";

test("daily scheduling uses UTC date, coalesces repeated ticks and never queues a missed-day backlog", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  const rows = [{ id: "yesterday", state: "verified", createdAt: now - 1 }];
  assert.equal(planDailyBackup(rows, now).due, true);
  assert.equal(planDailyBackup(rows, now).nextUtcDayAt, now + 86400000);
  rows.push({ id: "today", state: "verified", createdAt: now });
  assert.equal(planDailyBackup(rows, now).due, false);
  assert.equal(planDailyBackup(rows, now + 20 * 86400000).due, true);
});

test("preflight precedes owned pause, snapshot and fresh ledger are sealed before resume", async () => {
  const calls = [];
  const result = await captureStoppedBackup({
    outputPath: "fixture",
    snapshotPort: {
      preflight: () => calls.push("preflight"),
      create: () => {
        calls.push("snapshot");
        return { id: "fixture" };
      },
      sealLatestLedger: () => {
        calls.push("ledger");
        return { envelope: new Uint8Array() };
      },
    },
    lifecyclePort: {
      pause: () => {
        calls.push("pause");
        return { owned: true, release: () => calls.push("release") };
      },
      stop: () => calls.push("stop"),
      resume: () => calls.push("resume"),
    },
  });
  assert.equal(result.manifest.id, "fixture");
  assert.deepEqual(calls, [
    "preflight",
    "pause",
    "stop",
    "snapshot",
    "ledger",
    "release",
    "resume",
  ]);
});

test("failed preflight never stops a worker and a changed pause never resumes one", async () => {
  const calls = [];
  const lifecyclePort = {
    pause: () => ({
      owned: true,
      release: () => {
        throw Error("changed operator pause");
      },
    }),
    stop: () => calls.push("stop"),
    resume: () => calls.push("resume"),
  };
  await assert.rejects(
    captureStoppedBackup({
      outputPath: "fixture",
      lifecyclePort,
      snapshotPort: {
        preflight: () => {
          throw Error("missing separate key");
        },
      },
    }),
    /missing separate key/,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(
    captureStoppedBackup({
      outputPath: "fixture",
      lifecyclePort,
      snapshotPort: { preflight() {}, create() {}, sealLatestLedger() {} },
    }),
    /changed operator pause/,
  );
  assert.deepEqual(calls, ["stop"]);
});

test("an already paused installation is copied without owning or removing the operator pause", async (t) => {
  const f = await backupFixture(t),
    shared = join(f.root, "shared");
  mkdirSync(shared, { mode: 0o700 });
  const pause = join(shared, "paused");
  writeFileSync(pause, "manual pause", { mode: 0o600 });
  const actual = hostingLifecycle(f.root);
  let resumed = false;
  await captureStoppedBackup({
    outputPath: "fixture",
    snapshotPort: {
      preflight() {},
      create() {
        return f.manifest;
      },
      sealLatestLedger() {
        return { envelope: f.latestLedger };
      },
    },
    lifecyclePort: {
      pause: actual.pause,
      stop() {},
      resume() {
        resumed = true;
      },
    },
  });
  assert.equal(resumed, false);
  assert.equal(readFileSync(pause, "utf8"), "manual pause");
});

test("daily durable capture resumes after sealing and is idempotent across scheduler restart", async (t) => {
  const f = await backupFixture(t);
  let stopped = false,
    snapshots = 0;
  const snapshotPort = {
    preflight() {},
    async create({ outputPath }) {
      assert.equal(stopped, true);
      snapshots++;
      return createSnapshot({ ...f.options, outputPath });
    },
    async sealLatestLedger() {
      assert.equal(stopped, true);
      return sealLatestDeletionLedger({ dataRoot: f.dataRoot, key: f.key });
    },
  };
  const lifecyclePort = {
    pause: () => ({ owned: true, release() {} }),
    stop() {
      stopped = true;
    },
    resume() {
      stopped = false;
    },
  };
  const result = await runDailyBackup({
    catalog: f.catalog,
    snapshotPort,
    lifecyclePort,
    key: f.key,
  });
  assert.equal(stopped, false);
  assert.equal(result.state, "verified");
  assert.equal(result.offsiteSuccess, false); // A host-local copy is not proof of a PC transfer.
  assert.equal(result.needsOffsite, true);
  const restarted = new BackupCatalog({ root: f.catalog.root });
  assert.equal(
    (await runDailyBackup({ catalog: restarted, snapshotPort, lifecyclePort, key: f.key })).state,
    "not_due",
  );
  assert.equal(snapshots, 1);
  assert.equal((await restarted.inspectLocation()).complete, true);
});

test("before-upgrade registration authenticates exact snapshot, target and fresh ledger without setting PC acknowledgement", async (t) => {
  const f = await backupFixture(t),
    upgradeId = randomUUID(),
    targetRevision = "b".repeat(40);
  const registered = await registerBeforeUpgrade({
    catalog: f.catalog,
    archivePath: f.options.outputPath,
    manifest: f.manifest,
    upgradeId,
    targetRevision,
    key: f.key,
    latestLedger: f.latestLedger,
  });
  assert.equal(registered.entry.checkpoint.upgradeId, upgradeId);
  assert.equal(registered.entry.checkpoint.revision, targetRevision);
  assert.equal(registered.entry.checkpoint.healthyAt, null);
  assert.equal(registered.entry.checkpoint.offsiteAck, null);
});

test("the real child CLI reads only fixture private env and returns minimal checkpoint identity before healthy acknowledgement", async (t) => {
  const f = await backupV2Fixture(t),
    upgradeId = randomUUID(),
    targetRevision = "b".repeat(40);
  const capture = join(f.catalog.captures, `${upgradeId}.gldbak`);
  copyFileSync(f.options.outputPath, capture);
  const envPath = join(f.root, "operator.env");
  const values = {
    BACKUP_ENCRYPTION_KEY: f.key.toString("base64url"),
    DISCORD_GUILD_ID: f.options.guilds[0].guildId,
    OWNER_USER_ID: f.options.guilds[0].ownerId,
    CONFIG_PATH: f.options.guilds[0].configPath,
    DATABASE_PATH: f.options.guilds[0].databasePath,
    HEALTH_PATH: join(f.dataRoot, "health.json"),
  };
  writeFileSync(
    envPath,
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n"),
    { mode: 0o600 },
  );
  const script = resolve("scripts/backup-scheduler.mjs");
  const result = spawnSync(
    process.execPath,
    [
      `--env-file=${envPath}`,
      script,
      "register-before-upgrade",
      f.catalog.root,
      "--archive",
      capture,
      "--target-revision",
      targetRevision,
      "--upgrade-id",
      upgradeId,
    ],
    {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      encoding: "utf8",
      input: JSON.stringify(f.manifest),
      timeout: 15000,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(summary).sort(), ["checkpoint", "id", "sha256"]);
  assert.equal(summary.id, f.manifest.id);
  assert.ok(!result.stdout.includes(values.BACKUP_ENCRYPTION_KEY));
  assert.ok(!result.stdout.includes(values.DISCORD_GUILD_ID));
  assert.equal(existsSync(capture), false);
  const healthy = spawnSync(
    process.execPath,
    [
      script,
      "mark-healthy",
      f.catalog.root,
      "--id",
      summary.id,
      "--sha256",
      summary.sha256,
      "--target-revision",
      targetRevision,
      "--upgrade-id",
      upgradeId,
    ],
    {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    },
  );
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).checkpoint.offsiteAck, null);
});

test(
  "Linux daily and installer share the same real kernel deployment lock",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await backupFixture(t);
    mkdirSync(join(f.root, "shared"), { mode: 0o700 });
    await withHostingBackupLock(f.root, async (fence) => {
      fence();
      await assert.rejects(
        withHostingBackupLock(f.root, async () => {}),
        /deployment_busy/,
      );
    });
    await withHostingBackupLock(f.root, async (fence) => fence());
  },
);

test("operator status and rotation CLI keep the retention alarm while an unmatched archive remains", async (t) => {
  const f = await backupFixture(t),
    orphan = join(f.catalog.archives, `${randomUUID()}.gldbak`);
  writeFileSync(orphan, "unverified", { mode: 0o600 });
  for (const command of ["status", "rotate"]) {
    const child = spawnSync(
      process.execPath,
      [resolve("scripts/backup-scheduler.mjs"), command, f.catalog.root],
      {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).state, "retention_blocked");
    assert.equal(readFileSync(orphan, "utf8"), "unverified");
  }
});

test(
  "Linux manual install CLI cannot pass the daily lock or reach even a mocked network adapter",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await backupFixture(t);
    mkdirSync(join(f.root, "shared"), { mode: 0o700 });
    const marker = join(f.root, "network-attempt"),
      preload = join(f.root, "deny-network.mjs");
    writeFileSync(
      preload,
      `import{writeFileSync}from'node:fs';globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(marker)},'attempt');throw Error('fixture_network_denied');};`,
      { mode: 0o600 },
    );
    const invoke = () =>
      spawnSync(
        process.execPath,
        [resolve("scripts/hosting.mjs"), "install", f.root, "b".repeat(40)],
        {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
    await withHostingBackupLock(f.root, async () => {
      const blocked = invoke();
      assert.equal(blocked.status, 1);
      assert.equal(existsSync(marker), false);
    });
    const unblocked = invoke();
    assert.equal(unblocked.status, 1);
    assert.equal(readFileSync(marker, "utf8"), "attempt");
  },
);
