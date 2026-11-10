import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BackupCatalog,
  archiveIdentity,
  backupDayMs as day,
  planBackupRotation,
} from "../scripts/backup-catalog.mjs";

const time = (text) => Date.parse(text + "T12:00:00Z");
function entry(createdAt, extra = {}) {
  return {
    id: randomUUID(),
    createdAt,
    expiresAt: createdAt + 35 * day,
    verifiedAt: createdAt,
    size: 4,
    sha256: "a".repeat(64),
    reason: "daily",
    revision: null,
    state: "verified",
    checkpoint: null,
    ...extra,
  };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-backup-catalog-"));
  chmodSync(root, 0o700);
  t.after(() => {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.match(target, /gildiusz-backup-catalog-[^\\/]+$/);
    rmSync(target, { recursive: true, force: true });
  });
  let now = time("2026-11-10");
  const catalog = new BackupCatalog({ root: join(root, "catalog"), clock: () => now });
  async function add(createdAt, extra = {}) {
    const body = Buffer.from(randomUUID()),
      id = randomUUID();
    writeFileSync(catalog.archivePath(id), body, { mode: 0o600 });
    return catalog.registerVerified({
      manifest: { id, createdAt },
      ...(await archiveIdentity(catalog.archivePath(id))),
      reason: "daily",
      ...extra,
    });
  }
  return {
    root,
    catalog,
    add,
    setNow: (value) => {
      now = value;
    },
  };
}

test("UTC daily buckets and four completed calendar ISO weeks form a union without inventing a fifth week", () => {
  const now = time("2027-01-06"); // Wednesday; completed weeks start Dec28,21,14,7.
  const rows = [
    "2027-01-06",
    "2027-01-05",
    "2027-01-04",
    "2027-01-03",
    "2027-01-02",
    "2027-01-01",
    "2026-12-31",
    "2026-12-30",
    "2026-12-20",
    "2026-12-06",
  ].map((date) => entry(time(date)));
  const laterSameDay = entry(time("2027-01-05") + 1000);
  rows.push(laterSameDay);
  const plan = planBackupRotation(rows, { now });
  assert.ok(plan.keep.includes(laterSameDay.id));
  assert.ok(!plan.keep.includes(rows[1].id));
  assert.ok(plan.keep.includes(rows[8].id));
  assert.ok(!plan.keep.includes(rows[9].id)); // Dec6 belongs to a fifth completed ISO week.
  assert.equal(new Set(plan.keep).size, plan.keep.length);
  assert.ok(!plan.keep.includes(rows[7].id));
});

test("authenticated age caps checkpoints and arrivals while unknown or future copies require review", () => {
  const now = time("2026-11-10");
  const checkpoint = {
    upgradeId: randomUUID(),
    revision: "b".repeat(40),
    healthyAt: null,
    offsiteAck: null,
  };
  const expired = entry(now - 35 * day, { checkpoint, verifiedAt: now });
  const protectedFresh = entry(now - 1000);
  const future = entry(now + day);
  const unknown = entry(now - 40 * day, { state: "unknown" });
  const plan = planBackupRotation([expired, protectedFresh, future, unknown], {
    now,
    protectedIds: [expired.id],
  });
  assert.deepEqual(
    plan.remove.map((item) => item.id),
    [expired.id],
  );
  assert.ok(plan.keep.includes(protectedFresh.id));
  assert.equal(plan.blocked.length, 2);
});

test("restart preserves exact checkpoint health and offsite correlation, without accepting another archive or target", async (t) => {
  const f = fixture(t),
    checkpoint = {
      upgradeId: randomUUID(),
      revision: "b".repeat(40),
      healthyAt: null,
      offsiteAck: null,
    };
  const saved = await f.add(time("2026-11-09"), { reason: "before-upgrade", checkpoint });
  await assert.rejects(
    f.catalog.markUpgradeHealthy(saved.id, { ...checkpoint, sha256: "c".repeat(64) }),
    /checkpoint_conflict/,
  );
  await f.catalog.markUpgradeHealthy(saved.id, { ...checkpoint, sha256: saved.sha256 });
  const ack = {
    ...saved,
    locationId: randomUUID(),
    verifiedAt: time("2026-11-10"),
    upgradeId: checkpoint.upgradeId,
    revision: checkpoint.revision,
  };
  await assert.rejects(
    f.catalog.acknowledgeOffsite(saved.id, { ...ack, createdAt: saved.createdAt + 1 }),
    /replication_conflict/,
  );
  await assert.rejects(
    f.catalog.acknowledgeOffsite(saved.id, { ...ack, revision: "c".repeat(40) }),
    /replication_conflict/,
  );
  await f.catalog.acknowledgeOffsite(saved.id, ack);
  const restarted = new BackupCatalog({ root: f.catalog.root, clock: () => time("2026-11-10") });
  const state = await restarted.read();
  assert.equal(state.entries[0].checkpoint.offsiteAck.sha256, saved.sha256);
  assert.equal(state.entries[0].checkpoint.healthyAt, time("2026-11-10"));
});

test("rotation is revision fenced and a changed or missing artifact becomes unknown rather than being deleted", async (t) => {
  const f = fixture(t),
    saved = await f.add(time("2026-10-10"));
  f.setNow(time("2026-11-15"));
  const stale = await f.catalog.planRotation();
  await f.catalog.read();
  await assert.rejects(f.catalog.applyRotation(stale), /revision_conflict/);
  const plan = await f.catalog.planRotation();
  writeFileSync(f.catalog.archivePath(saved.id), "different", { mode: 0o600 });
  const result = await f.catalog.applyRotation(plan);
  assert.equal(result.state, "retention_blocked");
  assert.ok(existsSync(f.catalog.archivePath(saved.id)));
  assert.equal((await f.catalog.read()).entries[0].state, "unknown");
});

test("only verified known archives expire; unmatched encrypted files and unfinished transfers remain for reconciliation", async (t) => {
  const f = fixture(t),
    saved = await f.add(time("2026-10-10"));
  f.setNow(time("2026-11-15"));
  const unknownPath = join(f.catalog.archives, `${randomUUID()}.gldbak`);
  writeFileSync(unknownPath, "unknown", { mode: 0o600 });
  const transfer = await f.catalog.beginTransfer(randomUUID());
  writeFileSync(join(f.catalog.incoming, `${transfer.operationId}.part`), "partial", {
    mode: 0o600,
  });
  const plan = await f.catalog.planRotation();
  assert.equal(plan.state, "retention_blocked");
  const result = await f.catalog.applyRotation(plan);
  assert.deepEqual(result.removed, [saved.id]);
  assert.equal(result.state, "retention_blocked");
  assert.ok(result.blocked.some((problem) => problem.code === "unmanaged_backup_file"));
  assert.ok(result.blocked.some((problem) => problem.code === "unfinished_backup_transfer"));
  assert.equal(readFileSync(unknownPath, "utf8"), "unknown");
  assert.equal((await f.catalog.inspectLocation()).inProgress, 1);
});

test("legacy loose SQLite backups and orphan encrypted root archives block compliance without being adopted or removed", async (t) => {
  const f = fixture(t),
    legacy = join(
      f.catalog.root,
      `1600000000000-900000000000000001-before-${"a".repeat(40)}.sqlite`,
    ),
    orphan = join(f.catalog.root, `${randomUUID()}.gldbak`);
  writeFileSync(legacy, "legacy private database", { mode: 0o600 });
  writeFileSync(orphan, "unverified encrypted archive", { mode: 0o600 });
  const location = await f.catalog.inspectLocation();
  assert.equal(location.complete, false);
  assert.ok(location.problems.some((problem) => problem.code === "unmanaged_backup_root_entry"));
  const plan = await f.catalog.planRotation();
  assert.equal(plan.state, "retention_blocked");
  const result = await f.catalog.applyRotation(plan);
  assert.equal(result.state, "retention_blocked");
  assert.equal(readFileSync(legacy, "utf8"), "legacy private database");
  assert.equal(readFileSync(orphan, "utf8"), "unverified encrypted archive");
});

test("private physical path and file guards reject symlinks and hardlinks without touching their targets", async (t) => {
  const f = fixture(t),
    outside = join(f.root, "outside");
  mkdirSync(outside, { mode: 0o700 });
  const linkedRoot = join(f.root, "linked");
  symlinkSync(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => new BackupCatalog({ root: linkedRoot }), /Unsafe/);
  const file = join(outside, "archive.gldbak");
  writeFileSync(file, "protected", { mode: 0o600 });
  const alias = join(f.catalog.archives, `${randomUUID()}.gldbak`);
  linkSync(file, alias);
  await assert.rejects(archiveIdentity(alias), /unlinked/);
  assert.equal(
    createHash("sha256").update(readFileSync(file)).digest("hex"),
    createHash("sha256").update("protected").digest("hex"),
  );
});
