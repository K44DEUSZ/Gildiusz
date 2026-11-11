import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { backupV2Fixture } from "./backup-v2-fixture.mjs";
import { createSnapshot } from "../dist/storage/recovery/index.js";
import { snapshotRulesDeletionLifecycle } from "../dist/storage/rules-deletion-lifecycle.js";
import { BackupCatalog } from "../scripts/backup-catalog.mjs";
import { collectArchive, collectForOffsiteAck } from "../scripts/backup-collector.mjs";
import { readDeletionState } from "../scripts/backup-deletion-state.mjs";
import {
  prepareBeforeUpgrade,
  importOffsiteAck,
  verifyUpgradeCheckpoint,
  runDailyBackup,
  hostingLifecycle,
  planDailyBackup,
  withHostingBackupLock,
} from "../scripts/backup-scheduler.mjs";
import {
  beginUpgrade,
  advanceUpgrade,
  releaseAwaitingUpgrade,
  pendingUpgrade,
} from "../scripts/hosting.mjs";
import { writeOffsiteFile } from "../scripts/backup-offsite.mjs";
import { sealLatestDeletionProof } from "../scripts/backup-proof.mjs";

const day = 86400000;
async function hostFor(
  f,
  {
    state = "awaiting_offsite",
    holdPause = false,
    upgradeId = randomUUID(),
    pcId = randomUUID(),
  } = {},
) {
  const root = join(f.root, "hosting"),
    shared = join(root, "shared"),
    release = join(root, "releases", "a".repeat(40));
  mkdirSync(shared, { recursive: true, mode: 0o700 });
  mkdirSync(release, { recursive: true, mode: 0o700 });
  symlinkSync(release, join(root, "current"), process.platform === "win32" ? "junction" : "dir");
  writeOffsiteFile(
    join(shared, "offsite-location.json"),
    Buffer.from(JSON.stringify({ format: 1, locationId: pcId })),
  );
  let pending = beginUpgrade(root, "b".repeat(40), "a".repeat(40), pcId);
  pending = advanceUpgrade(root, pending, {
    upgradeId,
    backupId: f.manifest.id,
    sha256: f.expected.sha256,
    holdPause,
    state: "awaiting_offsite",
  });
  if (!holdPause) await releaseAwaitingUpgrade(root, pending, () => {});
  if (state !== pending.state) pending = advanceUpgrade(root, pending, { state });
  return { root, shared, pending, file: join(shared, "pending-upgrade.json") };
}
function ports(f, host) {
  const calls = { preflight: 0, snapshot: 0, seal: 0, pause: 0, stop: 0, resume: 0 };
  const lifecycle = hostingLifecycle(host.root, () => {});
  return {
    calls,
    lifecyclePort: {
      ...lifecycle,
      pause() {
        calls.pause++;
        return lifecycle.pause();
      },
      stop() {
        calls.stop++;
      },
      resume() {
        calls.resume++;
      },
    },
    snapshotPort: {
      preflight() {
        calls.preflight++;
      },
      create({ outputPath }) {
        calls.snapshot++;
        return createSnapshot({ ...f.options, outputPath });
      },
      async sealLatestProof() {
        calls.seal++;
        f.now = Math.max(f.now, Date.now());
        const notBefore = f.now,
          challenge = randomUUID();
        const value = await sealLatestDeletionProof({
          dataRoot: f.dataRoot,
          installations: f.installations,
          key: f.key,
          now: f.now,
          notBefore,
          challenge,
        });
        return {
          ...value,
          proofRequirements: {
            expectedSourceId: value.meta.sourceId,
            minSequence: value.meta.sequence,
            notBefore,
            challenge,
          },
        };
      },
    },
  };
}
const journalPath = (f) => join(f.dataRoot, "rules-acceptance-deletions", "journal.json");
const noCalls = (calls) =>
  assert.deepEqual(calls, { preflight: 0, snapshot: 0, seal: 0, pause: 0, stop: 0, resume: 0 });

for (const holdPause of [false, true]) {
  test(`UTC rollover preserves a prepared signed PC checkpoint while daily is deferred, holdPause=${holdPause}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-10T23:59:30Z") });
    const f = await backupV2Fixture(t),
      pc = new BackupCatalog({ root: join(f.root, "independent-pc"), clock: () => f.now }),
      pcId = (await pc.read()).locationId,
      sealed = await f.seal(),
      upgradeId = randomUUID(),
      stage = await prepareBeforeUpgrade({
        catalog: f.catalog,
        archivePath: f.options.outputPath,
        manifest: f.manifest,
        key: f.key,
        upgradeId,
        targetRevision: "b".repeat(40),
        destinationLocationId: pcId,
        latestProof: sealed.envelope,
        proofRequirements: sealed.proofRequirements,
      });
    const options = {
      catalog: f.catalog,
      id: f.manifest.id,
      upgradeId,
      targetRevision: "b".repeat(40),
      destinationLocationId: pcId,
      key: f.key,
      sourceSnapshot: () =>
        snapshotRulesDeletionLifecycle({
          dataRoot: f.dataRoot,
          installations: f.installations,
          now: f.now,
        }),
    };
    const collected = await collectForOffsiteAck({
      catalog: pc,
      transfer: stage.transfer,
      envelope: sealed.envelope,
      existingArchivePath: f.options.outputPath,
      key: f.key,
    });
    assert.equal(
      (await importOffsiteAck({ ...options, envelope: collected.ack })).offsiteSuccess,
      true,
    );
    const host = await hostFor(f, { holdPause, upgradeId, pcId }),
      hooks = ports(f, host),
      proofPath = join(
        f.catalog.root,
        "deletion-ledger",
        `deletion-proof-${sealed.meta.id}.gldproof`,
      ),
      pending = readFileSync(host.file),
      proof = readFileSync(proofPath),
      source = readFileSync(journalPath(f));
    t.mock.timers.tick(60000);
    f.now = Date.now();
    assert.equal(planDailyBackup((await f.catalog.read()).entries, f.now).due, true);
    const result = await runDailyBackup({ catalog: f.catalog, key: f.key, ...hooks });
    assert.equal(result.state, "deferred_pending_upgrade");
    assert.equal(result.offsiteSuccess, false);
    noCalls(hooks.calls);
    assert.deepEqual(readFileSync(host.file), pending);
    assert.deepEqual(readFileSync(proofPath), proof);
    assert.deepEqual(readFileSync(journalPath(f)), source);
    assert.equal((await f.catalog.read()).entries.length, 1);
    assert.equal(existsSync(join(host.shared, "paused")), holdPause);
    assert.equal((await verifyUpgradeCheckpoint(options)).offsiteSuccess, true);
  });
}

test("every pending phase defers due and not-due capture without changing its pause or source", async (t) => {
  for (const state of ["preparing", "awaiting_offsite", "activating", "failed"])
    for (const holdPause of [false, true])
      for (const due of [false, true])
        await t.test(`${state} hold=${holdPause} due=${due}`, async (t) => {
          const f = await backupV2Fixture(t),
            sealed = await f.seal();
          await collectArchive({ ...f.request(sealed), reason: "daily" });
          const host = await hostFor(f, { state, holdPause }),
            hooks = ports(f, host),
            pending = readFileSync(host.file),
            source = readFileSync(journalPath(f));
          if (due) f.now += day;
          assert.equal(planDailyBackup((await f.catalog.read()).entries, f.now).due, due);
          assert.equal(
            (await runDailyBackup({ catalog: f.catalog, key: f.key, ...hooks })).state,
            "deferred_pending_upgrade",
          );
          noCalls(hooks.calls);
          assert.deepEqual(readFileSync(host.file), pending);
          assert.deepEqual(readFileSync(journalPath(f)), source);
          assert.equal(existsSync(join(host.shared, "paused")), holdPause);
        });
});

test("malformed and linked pending state is operator-blocked before any source or ledger effect", async (t) => {
  for (const variant of ["malformed", "foreign-fields", "hardlink", "dangling-link"])
    await t.test(variant, async (t) => {
      const f = await backupV2Fixture(t),
        host = await hostFor(f),
        hooks = ports(f, host),
        source = readFileSync(journalPath(f));
      if (variant === "malformed")
        writeFileSync(host.file, "PRIVATE_FIXTURE_INVALID_JSON", { mode: 0o600 });
      if (variant === "foreign-fields")
        writeFileSync(host.file, JSON.stringify({ ...host.pending, untrusted: true }), {
          mode: 0o600,
        });
      if (variant === "hardlink") linkSync(host.file, join(host.shared, "second-link"));
      if (variant === "dangling-link") {
        unlinkSync(host.file);
        try {
          symlinkSync(
            join(host.shared, "missing-target"),
            host.file,
            process.platform === "win32" ? "junction" : "file",
          );
        } catch (error) {
          if (["EPERM", "EACCES"].includes(error.code)) {
            t.skip("Creating a fixture symlink is unavailable.");
            return;
          }
          throw error;
        }
      }
      await assert.rejects(
        runDailyBackup({ catalog: f.catalog, key: f.key, ...hooks }),
        (error) => error.code === "backup_pending_reconciliation_required",
      );
      noCalls(hooks.calls);
      assert.deepEqual(readFileSync(journalPath(f)), source);
      assert.equal(existsSync(join(f.catalog.root, "deletion-ledger")), false);
    });
});

test("pending cannot extend archive or proof payload retention beyond 35 days", async (t) => {
  const f = await backupV2Fixture(t),
    sealed = await f.seal();
  await collectArchive({ ...f.request(sealed), reason: "daily" });
  const host = await hostFor(f, { holdPause: true }),
    hooks = ports(f, host),
    source = readFileSync(journalPath(f)),
    pending = readFileSync(host.file),
    proofPath = join(
      f.catalog.root,
      "deletion-ledger",
      `deletion-proof-${sealed.meta.id}.gldproof`,
    );
  f.now += 36 * day;
  const result = await runDailyBackup({ catalog: f.catalog, key: f.key, ...hooks });
  assert.equal(result.state, "deferred_pending_upgrade");
  assert.equal(result.retentionBlocked, true);
  assert.equal(existsSync(proofPath), false);
  const watermark = readDeletionState({
    directory: join(f.catalog.root, "deletion-ledger"),
    key: f.key,
    now: f.now,
  });
  assert.ok(watermark.globalGap);
  assert.equal(JSON.stringify(watermark).includes(f.guildId), false);
  const rotation = await f.catalog.applyRotation(await f.catalog.planRotation());
  assert.deepEqual(rotation.removed, [f.manifest.id]);
  assert.equal(existsSync(f.catalog.archivePath(f.manifest.id)), false);
  noCalls(hooks.calls);
  assert.deepEqual(readFileSync(journalPath(f)), source);
  assert.deepEqual(readFileSync(host.file), pending);
  assert.equal(existsSync(join(host.shared, "paused")), true);
});

test("deferred daily does not mark unknown archives as ready or remove their bytes", async (t) => {
  const f = await backupV2Fixture(t),
    host = await hostFor(f),
    hooks = ports(f, host),
    orphan = join(f.catalog.archives, randomUUID() + ".gldbak");
  writeFileSync(orphan, "unverified-copy", { mode: 0o600 });
  const result = await runDailyBackup({ catalog: f.catalog, key: f.key, ...hooks });
  assert.equal(result.state, "deferred_pending_upgrade");
  const rotation = await f.catalog.applyRotation(await f.catalog.planRotation());
  assert.equal(rotation.state, "retention_blocked");
  assert.deepEqual(rotation.removed, []);
  assert.equal(readFileSync(orphan, "utf8"), "unverified-copy");
  noCalls(hooks.calls);
});

test("normal daily resumes only after the installer has explicitly removed pending state", async (t) => {
  const f = await backupV2Fixture(t),
    host = await hostFor(f),
    hooks = ports(f, host),
    pending = readFileSync(host.file);
  assert.equal(
    (await runDailyBackup({ catalog: f.catalog, key: f.key, ...hooks })).state,
    "deferred_pending_upgrade",
  );
  assert.deepEqual(readFileSync(host.file), pending);
  noCalls(hooks.calls);
  // The fixture models the installer's completed state transition, never daily deleting its own guard.
  unlinkSync(host.file);
  assert.equal(pendingUpgrade(host.root), null);
  f.now = Date.now();
  const result = await runDailyBackup({ catalog: f.catalog, key: f.key, ...hooks });
  assert.equal(result.state, "verified");
  assert.equal(result.offsiteSuccess, false);
  assert.deepEqual(hooks.calls, {
    preflight: 1,
    snapshot: 1,
    seal: 1,
    pause: 1,
    stop: 1,
    resume: 1,
  });
  assert.equal(existsSync(host.file), false);
  assert.equal(existsSync(join(host.shared, "paused")), false);
});

test(
  "Linux CLI defers under the installation lock and retains the retention alarm",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await backupV2Fixture(t),
      host = await hostFor(f),
      operator = join(f.root, "operator.env"),
      orphan = join(f.catalog.archives, randomUUID() + ".gldbak");
    writeFileSync(orphan, "unverified-copy", { mode: 0o600 });
    writeFileSync(
      operator,
      `BACKUP_ENCRYPTION_KEY=${f.key.toString("base64url")}\nBACKUP_HOSTING_ROOT=${JSON.stringify(host.root)}\n`,
      { mode: 0o600 },
    );
    const invoke = () =>
      spawnSync(
        process.execPath,
        [
          "--env-file=" + operator,
          resolve("scripts/backup-scheduler.mjs"),
          "run-daily",
          f.catalog.root,
        ],
        {
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          encoding: "utf8",
          timeout: 10000,
        },
      );
    const pending = readFileSync(host.file),
      source = readFileSync(journalPath(f));
    await withHostingBackupLock(host.root, async () => {
      const blocked = invoke();
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /backup_deployment_busy/);
    });
    const deferred = invoke();
    assert.equal(deferred.status, 0, deferred.stderr);
    const summary = JSON.parse(deferred.stdout);
    assert.equal(summary.state, "retention_blocked");
    assert.equal(summary.backupState, "deferred_pending_upgrade");
    assert.equal(summary.removed, 0);
    assert.ok(summary.blocked > 0);
    assert.equal(existsSync(join(host.shared, "logs")), false);
    assert.deepEqual(readFileSync(host.file), pending);
    assert.deepEqual(readFileSync(journalPath(f)), source);
    assert.equal(readFileSync(orphan, "utf8"), "unverified-copy");
    assert.equal(
      deferred.stdout.includes(f.key.toString("base64url")) ||
        deferred.stderr.includes(f.key.toString("base64url")),
      false,
    );
  },
);
