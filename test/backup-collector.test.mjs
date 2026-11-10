import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BackupCatalog } from "../scripts/backup-catalog.mjs";
import { collectArchive } from "../scripts/backup-collector.mjs";
import { backupFixture, backdateBackup } from "./backup-fixture.mjs";
import {
  retireSourceDeletionLedgers,
  sealLatestDeletionLedger,
} from "../scripts/backup-ledger.mjs";

function request(f, extra = {}) {
  return {
    catalog: f.catalog,
    expected: f.expected,
    existingArchivePath: f.options.outputPath,
    key: f.key,
    latestLedger: f.latestLedger,
    ...extra,
  };
}
test("a real encrypted SQLite snapshot is acknowledged only after restore dry-run and durable exclusive promotion", async (t) => {
  const f = await backupFixture(t);
  const result = await collectArchive(request(f));
  assert.equal(result.offsiteSuccess, false);
  assert.equal(result.localVerificationSucceeded, true);
  assert.equal(result.ledger.state, "verified");
  assert.equal(result.entry.id, f.manifest.id);
  assert.deepEqual(
    readFileSync(f.catalog.archivePath(f.manifest.id)),
    readFileSync(f.options.outputPath),
  );
  assert.ok(!readdirSync(f.catalog.verification).length);
  assert.ok(!readdirSync(f.catalog.incoming).length);
  assert.equal(existsSync(join(f.catalog.root, "guilds")), false); // No activated restored state.
  const restarted = new BackupCatalog({ root: f.catalog.root });
  const retry = await collectArchive(request(f, { catalog: restarted }));
  assert.equal(retry.replayed, true);
  assert.equal((await restarted.read()).entries.length, 1);
  assert.equal((await restarted.inspectLocation()).complete, true);
});
test("SHA equality cannot replace authenticated restore and a wrong key never creates a verified entry", async (t) => {
  const f = await backupFixture(t);
  await assert.rejects(
    collectArchive(request(f, { key: randomBytes(32) })),
    /backup_collection_failed/,
  );
  assert.equal((await f.catalog.read()).entries.length, 0);
  assert.equal(existsSync(f.catalog.archivePath(f.expected.id)), false);
  assert.equal((await f.catalog.inspectLocation()).complete, false);
  assert.ok(readdirSync(f.catalog.incoming).some((name) => name.endsWith(".part")));
});
test("a corrupted but hash-matching expected file still fails GCM before verification", async (t) => {
  const f = await backupFixture(t);
  const bytes = readFileSync(f.options.outputPath);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(f.options.outputPath, bytes, { mode: 0o600 });
  const expected = { ...f.expected, sha256: createHash("sha256").update(bytes).digest("hex") };
  await assert.rejects(collectArchive(request(f, { expected })), /backup_collection_failed/);
  assert.equal((await f.catalog.read()).entries.length, 0);
});
test("same backup ID with different ciphertext is a conflict and cannot overwrite a confirmed copy", async (t) => {
  const f = await backupFixture(t);
  await collectArchive(request(f));
  const original = readFileSync(f.catalog.archivePath(f.expected.id));
  await assert.rejects(
    collectArchive(request(f, { expected: { ...f.expected, sha256: "b".repeat(64) } })),
    /identity_conflict/,
  );
  assert.deepEqual(readFileSync(f.catalog.archivePath(f.expected.id)), original);
});
test("fresh ledger transport is explicit: a verified archive alone cannot claim complete offsite success", async (t) => {
  const f = await backupFixture(t);
  const result = await collectArchive(request(f, { latestLedger: undefined }));
  assert.equal(result.entry.state, "verified");
  assert.equal(result.offsiteSuccess, false);
  assert.equal(result.ledger.state, "ledger_sync_required");
  const completed = await collectArchive(request(f, { latestLedger: async () => f.latestLedger }));
  assert.equal(completed.replayed, true);
  assert.equal(completed.offsiteSuccess, false);
  assert.equal(completed.localVerificationSucceeded, true);
  assert.equal(completed.ledger.state, "verified");
});
test("injected streams are bounded, aborted and isolated; no default network fetch exists", async (t) => {
  const f = await backupFixture(t);
  let requested = 0;
  const bytes = readFileSync(f.options.outputPath);
  const result = await collectArchive({
    ...request(f),
    existingArchivePath: undefined,
    fetchStream: async ({ expected, signal }) => {
      requested++;
      assert.equal(expected.id, f.expected.id);
      assert.equal(signal.aborted, false);
      return (async function* () {
        yield bytes.subarray(0, 20);
        yield bytes.subarray(20);
      })();
    },
  });
  assert.equal(result.offsiteSuccess, false);
  assert.equal(result.localVerificationSucceeded, true);
  assert.equal(result.ledger.state, "verified");
  assert.equal(requested, 1);
  const other = new BackupCatalog({ root: join(f.root, "other") });
  const controller = new globalThis.AbortController();
  const pending = collectArchive({
    ...request(f, { catalog: other }),
    existingArchivePath: undefined,
    signal: controller.signal,
    fetchStream: async () => ({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) };
      },
    }),
  });
  const timer = setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error) => error.code === "backup_transfer_aborted");
  globalThis.clearTimeout(timer);
  assert.equal((await other.read()).entries.length, 0);
  assert.equal((await other.inspectLocation()).inProgress, 1);
});
test("authenticated IDs, original creation time and maximum age are never silently rewritten by transport", async (t) => {
  const f = await backupFixture(t);
  await assert.rejects(
    collectArchive(request(f, { expected: { ...f.expected, id: randomUUID() } })),
    (error) => error.code === "backup_authenticated_identity_conflict",
  );
  const expiredCatalog = new BackupCatalog({
    root: join(f.root, "expired"),
    clock: () => f.manifest.createdAt + 35 * 86400000,
  });
  await assert.rejects(collectArchive(request(f, { catalog: expiredCatalog })), /already_expired/);
  assert.equal((await expiredCatalog.read()).entries.length, 0);
});

test("a hanging transport factory cannot outlive the collector deadline or claim replication", async (t) => {
  const f = await backupFixture(t);
  await assert.rejects(
    collectArchive({
      ...request(f),
      existingArchivePath: undefined,
      timeoutMs: 25,
      fetchStream: () => new Promise(() => {}),
    }),
    (error) => error.code === "backup_transfer_aborted",
  );
  assert.equal((await f.catalog.read()).entries.length, 0);
  assert.equal((await f.catalog.inspectLocation()).inProgress, 1);
});

test("hard35 legacy retirement cannot become a fresh empty v1 offsite acknowledgement", async (t) => {
  const f = await backupFixture(t);
  let now = Date.now() + 1000;
  f.catalog.clock = () => now;
  const ledgerRoot = join(f.dataRoot, "uninstall-retention");
  mkdirSync(ledgerRoot, { mode: 0o700 });
  const decision = {
    format: 1,
    guildId: "900000000000000099",
    removedAt: now - 40 * 86400000,
    purgedAt: now - 35 * 86400000 + 1000,
    outcome: "purged",
  };
  writeFileSync(join(ledgerRoot, `${decision.guildId}.deleted.json`), JSON.stringify(decision), {
    mode: 0o600,
  });
  const before = await sealLatestDeletionLedger({ dataRoot: f.dataRoot, key: f.key, now });
  await collectArchive(request(f, { latestLedger: before.envelope }));
  now += 1000;
  const retired = await retireSourceDeletionLedgers({ dataRoot: f.dataRoot, key: f.key, now });
  assert.equal(retired.retiredCount, 1);
  assert.equal(retired.state, "operator_block");
  await assert.rejects(
    sealLatestDeletionLedger({ dataRoot: f.dataRoot, key: f.key, now }),
    (error) => error.code === "source_retention_gap",
  );
  const result = await collectArchive(request(f, { latestLedger: before.envelope }));
  assert.equal(result.offsiteSuccess, false);
  assert.equal(result.ledger.state, "proof_sync_required");
  assert.equal(
    readdirSync(join(f.catalog.root, "deletion-ledger")).some((name) =>
      name.endsWith(".gldledger"),
    ),
    false,
  );
});
for (const replayed of [false, true])
  test(`rotation during fresh ledger sync cannot acknowledge a removed ${replayed ? "replayed" : "new"} archive`, async (t) => {
    const f = await backupFixture(t),
      now = Date.now(),
      day = 86400000;
    await backdateBackup(f, now - 34 * day);
    f.catalog.clock = () => now + 1000;
    if (replayed) await collectArchive(request(f));
    const thisDay = new Date(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
    const week = thisDay.getTime() - ((thisDay.getUTCDay() + 6) % 7) * day;
    const dates = [
      ...Array.from({ length: 7 }, (_, index) => now - index * day),
      ...Array.from({ length: 4 }, (_, index) => week - (1 + index * 7) * day),
    ];
    for (const createdAt of dates) {
      const id = randomUUID();
      writeFileSync(f.catalog.archivePath(id), "verified-other", { mode: 0o600 });
      const identity = await import("../scripts/backup-catalog.mjs").then((module) =>
        module.archiveIdentity(f.catalog.archivePath(id)),
      );
      await f.catalog.registerVerified({
        manifest: { id, createdAt },
        ...identity,
        reason: "daily",
      });
    }
    let removed = false;
    await assert.rejects(
      collectArchive(
        request(f, {
          latestLedger: async () => {
            const result = await f.catalog.applyRotation(await f.catalog.planRotation());
            removed = result.removed.includes(f.expected.id);
            return f.latestLedger;
          },
        }),
      ),
      (error) => error.code === "backup_not_found",
    );
    assert.equal(removed, true);
    assert.equal(existsSync(f.catalog.archivePath(f.expected.id)), false);
  });

for (const replayed of [false, true])
  test(`caller abort during authenticated ledger import prevents ${replayed ? "replay" : "new"} acknowledgement`, async (t) => {
    const f = await backupFixture(t);
    if (replayed) await collectArchive(request(f));
    const envelope = (await sealLatestDeletionLedger({ dataRoot: f.dataRoot, key: f.key }))
      .envelope;
    const controller = new globalThis.AbortController();
    let timer;
    try {
      await assert.rejects(
        collectArchive(
          request(f, {
            signal: controller.signal,
            latestLedger: async () => {
              timer = setTimeout(() => controller.abort(), 0);
              return envelope;
            },
          }),
        ),
        (error) => error.code === "backup_transfer_aborted",
      );
      assert.equal(controller.signal.aborted, true);
      assert.equal(
        existsSync(join(f.catalog.root, "deletion-ledger", "latest-deletion-ledger.json")),
        true,
      );
      assert.equal(existsSync(f.catalog.archivePath(f.expected.id)), true);
    } finally {
      if (timer) globalThis.clearTimeout(timer);
    }
  });

for (const replayed of [false, true])
  test(`expiry reached during final confirmation prevents ${replayed ? "replay" : "new"} acknowledgement`, async (t) => {
    const f = await backupFixture(t),
      now = Date.now();
    await backdateBackup(f, now - 35 * 86400000 + 1000);
    const expiry = f.manifest.createdAt + 35 * 86400000;
    f.catalog.clock = () => expiry - 1;
    if (replayed) await collectArchive(request(f));
    const confirm = f.catalog.confirmArchive.bind(f.catalog);
    f.catalog.confirmArchive = async (expected) => {
      const result = await confirm(expected);
      f.catalog.clock = () => expiry;
      return result;
    };
    await assert.rejects(
      collectArchive(request(f)),
      (error) => error.code === "backup_already_expired",
    );
  });
