import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import {
  sealLatestDeletionLedger,
  verifyLatestDeletionLedger,
  importLatestDeletionLedger,
  assessDeletionLedgerRetention,
  retireSourceDeletionLedgers,
  deletionLedgerMaxAgeMs,
  pruneImportedDeletionLedgers,
  BackupLedgerError,
} from "../scripts/backup-ledger.mjs";

const guildA = "900000000000000001",
  guildB = "900000000000000002",
  at = Date.parse("2026-11-10T12:00:00Z");
const entry = (guildId = guildA, purgedAt = at - 1000) => ({
  format: 1,
  guildId,
  removedAt: purgedAt - 30 * 86400000,
  purgedAt,
  outcome: "purged",
});
const fails = (code) => (error) => error instanceof BackupLedgerError && error.code === code;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-backup-ledger-")),
    dataRoot = join(root, "data"),
    source = join(dataRoot, "uninstall-retention");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const key = randomBytes(32),
    directory = join(root, "offsite");
  const save = (value) =>
    writeFileSync(join(source, `${value.guildId}.deleted.json`), JSON.stringify(value), {
      mode: 0o600,
    });
  t.after(() => {
    const path = resolve(root);
    assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes("gildiusz-backup-ledger-"));
    rmSync(path, { recursive: true, force: true });
  });
  return { root, dataRoot, source, directory, key, save };
}
function forge(body, key, { context = "gildiusz-deletion-ledger-v1", magic = "GLDLED01" } = {}) {
  const header = Buffer.concat([Buffer.from(magic), randomBytes(16), randomBytes(12)]),
    derived = Buffer.from(hkdfSync("sha256", key, header.subarray(8, 24), context, 32));
  const cipher = createCipheriv("aes-256-gcm", derived, header.subarray(24));
  cipher.setAAD(header);
  return Buffer.concat([
    header,
    cipher.update(Buffer.from(JSON.stringify(body))),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
const body = (entries) => ({
  format: 1,
  kind: "gildiusz-latest-deletion-ledger",
  id: randomUUID(),
  createdAt: at,
  entries,
});
function evidence(now, extra = {}) {
  return {
    knownLocationIds: ["host", "pc"],
    maxLocationAgeMs: 60000,
    locations: [
      { id: "host", verifiedAt: now, complete: true, unknown: 0, inProgress: 0, copies: [] },
      { id: "pc", verifiedAt: now, complete: true, unknown: 0, inProgress: 0, copies: [] },
    ],
    legacyClassification: {
      verifiedAt: now,
      complete: true,
      unknown: 0,
      configuredLegacyGuildIds: [],
    },
    ...extra,
  };
}

test("fresh minimal source seals and verifies authenticated IDs/times/hash without plaintext disclosure", async (t) => {
  const f = fixture(t);
  f.save(entry(guildB));
  f.save(entry());
  const sourceBefore = readFileSync(join(f.source, `${guildA}.deleted.json`));
  const sealed = await sealLatestDeletionLedger({ ...f, now: at });
  assert.equal(sealed.envelope.subarray(0, 8).toString(), "GLDLED01");
  assert.equal(sealed.meta.count, 2);
  assert.equal(sealed.meta.createdAt, at);
  assert.equal(sealed.meta.size, sealed.envelope.length);
  for (const text of [guildA, guildB, "guildId", "removedAt", f.key.toString("base64url")])
    assert.equal(sealed.envelope.includes(Buffer.from(text)), false);
  const verified = verifyLatestDeletionLedger({ ...f, ...sealed, now: at + 100, maxAgeMs: 1000 });
  assert.deepEqual(verified.meta, sealed.meta);
  assert.deepEqual(verified.entries, [entry(), entry(guildB)]);
  assert.deepEqual(readFileSync(join(f.source, `${guildA}.deleted.json`)), sourceBefore);
});

test("live writers, quarantine and irreversible pending wipes cannot be presented as a latest ledger", async (t) => {
  const f = fixture(t);
  f.save(entry());
  const release = await acquireDataRootLease(f.dataRoot);
  try {
    await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }), fails("writer_active"));
  } finally {
    await release();
  }
  writeFileSync(join(f.dataRoot, "restore-quarantine.json"), "{malformed", { mode: 0o600 });
  await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }), fails("source_quarantined"));
  rmSync(join(f.dataRoot, "restore-quarantine.json"));
  const pending = {
    format: 1,
    guildId: guildA,
    removedAt: at - 1000,
    phase: "prepared",
    public: true,
    databasePath: join(f.dataRoot, "gildiusz.sqlite"),
    databaseIdentity: { dev: "1", ino: "2" },
    assetNames: [],
  };
  const path = join(f.source, `${guildA}.pending.json`);
  writeFileSync(path, JSON.stringify(pending), { mode: 0o600 });
  assert.equal((await sealLatestDeletionLedger({ ...f, now: at })).meta.count, 1);
  writeFileSync(path, JSON.stringify({ ...pending, phase: "files_done" }));
  await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }), fails("ledger_incomplete"));
});

test("source whitelists prevent credentials, owner fields, mismatched guilds and future deletion times", async (t) => {
  const f = fixture(t);
  f.save({ ...entry(), ownerId: "900000000000000003" });
  await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }), fails("invalid_ledger"));
  f.save({ ...entry(), token: "private" });
  await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }), fails("invalid_ledger"));
  writeFileSync(join(f.source, `${guildA}.deleted.json`), JSON.stringify(entry(guildB)));
  await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }), fails("invalid_ledger"));
  f.save(entry(guildA, at + 1));
  await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }), fails("invalid_ledger"));
});

test("wrong keys, altered headers/tags, cross-domain ciphertext and stale or malformed authenticated documents are rejected", async (t) => {
  const f = fixture(t);
  f.save(entry());
  const sealed = await sealLatestDeletionLedger({ ...f, now: at });
  assert.throws(
    () => verifyLatestDeletionLedger({ ...sealed, key: randomBytes(32), now: at, maxAgeMs: 1000 }),
    fails("authentication_failed"),
  );
  for (const offset of [8, 24, 40, sealed.envelope.length - 1]) {
    const changed = Buffer.from(sealed.envelope);
    changed[offset] ^= 1;
    assert.throws(
      () => verifyLatestDeletionLedger({ envelope: changed, key: f.key, now: at, maxAgeMs: 1000 }),
      fails("authentication_failed"),
    );
  }
  assert.throws(
    () =>
      verifyLatestDeletionLedger({
        envelope: forge(body([entry()]), f.key, { context: "gildiusz-backup-v1" }),
        key: f.key,
        now: at,
        maxAgeMs: 1000,
      }),
    fails("authentication_failed"),
  );
  assert.throws(
    () => verifyLatestDeletionLedger({ ...sealed, key: f.key, now: at + 1001, maxAgeMs: 1000 }),
    fails("stale_ledger"),
  );
  assert.throws(
    () =>
      verifyLatestDeletionLedger({
        ...sealed,
        key: f.key,
        now: at - 1,
        maxAgeMs: 1000,
        maxFutureMs: 0,
      }),
    fails("invalid_ledger"),
  );
  for (const document of [
    { ...body([entry()]), unexpected: true },
    body([{ ...entry(), ownerId: "owner" }]),
    body([entry(), entry()]),
  ])
    assert.throws(
      () =>
        verifyLatestDeletionLedger({
          envelope: forge(document, f.key),
          key: f.key,
          now: at,
          maxAgeMs: 1000,
        }),
      fails("invalid_ledger"),
    );
  await assert.rejects(
    sealLatestDeletionLedger({ ...f, forbiddenKeys: [f.key.toString("base64url")], now: at }),
    fails("invalid_key"),
  );
});

test("offsite import writes encrypted data plus a verified private index and safely handles exact retries", async (t) => {
  const f = fixture(t);
  f.save(entry());
  const sealed = await sealLatestDeletionLedger({ ...f, now: at });
  const imported = await importLatestDeletionLedger({ ...f, ...sealed, now: at, maxAgeMs: 60000 });
  assert.equal(imported.replay, false);
  const index = JSON.parse(readFileSync(imported.indexPath));
  assert.equal(index.sha256, sealed.meta.sha256);
  assert.equal(index.file, `deletion-ledger-${sealed.meta.id}.gldledger`);
  assert.equal(JSON.stringify(index).includes(guildA), false);
  assert.deepEqual(readFileSync(imported.path), sealed.envelope);
  const retried = await importLatestDeletionLedger({
    ...f,
    ...sealed,
    now: at + 10,
    maxAgeMs: 60000,
  });
  assert.equal(retried.replay, true);
  assert.equal(readdirSync(f.directory).filter((name) => name.endsWith(".gldledger")).length, 1);
  if (process.platform !== "win32") {
    assert.equal((await import("node:fs")).statSync(f.directory).mode & 0o077, 0);
    assert.equal((await import("node:fs")).statSync(imported.path).mode & 0o077, 0);
  }
});

test("new source snapshots cannot roll back known deletions or silently drop them before all locations are verified clear", async (t) => {
  const f = fixture(t);
  f.save(entry());
  const first = await sealLatestDeletionLedger({ ...f, now: at });
  await importLatestDeletionLedger({ ...f, ...first, now: at, maxAgeMs: 60000 });
  f.save(entry(guildB, at + 1000));
  const second = await sealLatestDeletionLedger({ ...f, now: at + 2000 });
  const imported = await importLatestDeletionLedger({
      ...f,
      ...second,
      now: at + 2000,
      maxAgeMs: 60000,
    }),
    before = readFileSync(imported.indexPath);
  await assert.rejects(
    importLatestDeletionLedger({ ...f, ...first, now: at + 2000, maxAgeMs: 60000 }),
    fails("rollback_detected"),
  );
  assert.deepEqual(readFileSync(imported.indexPath), before);
  rmSync(join(f.source, `${guildA}.deleted.json`));
  const dropped = await sealLatestDeletionLedger({ ...f, now: at + 3000 });
  await assert.rejects(
    importLatestDeletionLedger({ ...f, ...dropped, now: at + 3000, maxAgeMs: 60000 }),
    fails("operator_block"),
  );
  await assert.rejects(
    importLatestDeletionLedger({
      ...f,
      ...dropped,
      now: at + 3000,
      maxAgeMs: 60000,
      retirementEvidence: evidence(at + 3000),
    }),
    fails("operator_block"),
  );
  const eligible = entry().purgedAt + deletionLedgerMaxAgeMs,
    last = await sealLatestDeletionLedger({ ...f, now: eligible });
  await assert.rejects(
    importLatestDeletionLedger({
      ...f,
      ...last,
      now: eligible,
      maxAgeMs: 60000,
      retirementEvidence: evidence(eligible),
    }),
    fails("source_requires_v2"),
  );
  assert.equal(existsSync(imported.path), false);
});

test("same-time seals of the same decisions and caller buffer mutation do not corrupt imports or leak locks", async (t) => {
  const f = fixture(t);
  f.save(entry());
  const first = await sealLatestDeletionLedger({ ...f, now: at });
  await importLatestDeletionLedger({ ...f, ...first, now: at, maxAgeMs: 60000 });
  const equivalent = await sealLatestDeletionLedger({ ...f, now: at }),
    mutableKey = Buffer.from(f.key);
  const importing = importLatestDeletionLedger({
    ...f,
    ...equivalent,
    key: mutableKey,
    now: at,
    maxAgeMs: 60000,
  });
  mutableKey.fill(0);
  const imported = await importing;
  assert.equal(imported.meta.id, equivalent.meta.id);
  assert.deepEqual(imported.entries, [entry()]);
  assert.equal(
    (await importLatestDeletionLedger({ ...f, ...equivalent, now: at, maxAgeMs: 60000 })).replay,
    true,
  );
});

test("35-day retirement needs fresh complete inventories of every known place, including the PC", () => {
  const row = entry(),
    now = row.purgedAt + deletionLedgerMaxAgeMs;
  assert.equal(
    assessDeletionLedgerRetention({ entries: [row], now: now - 1, ...evidence(now - 1) }).state,
    "keep",
  );
  assert.equal(
    assessDeletionLedgerRetention({ entries: [row], now, ...evidence(now) }).state,
    "eligible",
  );
  for (const patch of [
    { unknown: 1 },
    { inProgress: 1 },
    { complete: false },
    { verifiedAt: now - 60001 },
  ]) {
    const input = evidence(now);
    input.locations[1] = { ...input.locations[1], ...patch };
    assert.equal(
      assessDeletionLedgerRetention({ entries: [row], now, ...input }).state,
      "operator_block",
    );
  }
  const absent = evidence(now);
  absent.locations.pop();
  assert.equal(
    assessDeletionLedgerRetention({ entries: [row], now, ...absent }).state,
    "operator_block",
  );
  assert.equal(
    assessDeletionLedgerRetention({
      entries: [row],
      now,
      knownLocationIds: [],
      locations: [],
      maxLocationAgeMs: 60000,
    }).state,
    "operator_block",
  );
  const old = evidence(now);
  old.locations[1].copies = [{ id: "old-backup", createdAt: row.purgedAt }];
  assert.equal(
    assessDeletionLedgerRetention({ entries: [row], now, ...old }).decisions[0].reason,
    "pre_deletion_copy_remaining",
  );
  old.locations[1].copies[0].guildIds = [guildB];
  assert.equal(assessDeletionLedgerRetention({ entries: [row], now, ...old }).state, "eligible");
});

test("hard35 removes verified legacy source decisions even with an offline PC, and leaves a signed blocker", async (t) => {
  const f = fixture(t),
    old = entry(),
    now = old.purgedAt + deletionLedgerMaxAgeMs,
    young = entry(guildB, now - 1000);
  f.save(old);
  f.save(young);
  const unavailable = evidence(now);
  unavailable.locations[1].unknown = 1;
  const result = await retireSourceDeletionLedgers({ ...f, now, ...unavailable });
  assert.equal(result.state, "operator_block");
  assert.equal(result.retiredCount, 1);
  assert.equal(result.remainingCount, 1);
  assert.equal(existsSync(join(f.source, `${guildA}.deleted.json`)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.source, `${guildB}.deleted.json`))), young);
  const gap = readFileSync(join(f.source, "source-gap.json"), "utf8");
  assert.equal(gap.includes(guildA), false);
  assert.equal(gap.includes(guildB), false);
  await assert.rejects(sealLatestDeletionLedger({ ...f, now }), fails("source_retention_gap"));
  const retry = await retireSourceDeletionLedgers({ ...f, now, ...evidence(now) });
  assert.equal(retry.state, "operator_block");
  assert.equal(retry.retiredCount, 0);
  assert.equal(readFileSync(join(f.source, "source-gap.json"), "utf8"), gap);
});

test("writer fence, quarantine and a missing key prevent source unlink before a durable authenticated gap", async (t) => {
  const f = fixture(t),
    old = entry(),
    now = old.purgedAt + deletionLedgerMaxAgeMs;
  f.save(old);
  const before = readFileSync(join(f.source, `${guildA}.deleted.json`)),
    release = await acquireDataRootLease(f.dataRoot);
  try {
    await assert.rejects(retireSourceDeletionLedgers({ ...f, now }), fails("writer_active"));
  } finally {
    await release();
  }
  writeFileSync(join(f.dataRoot, "restore-quarantine.json"), "{invalid", { mode: 0o600 });
  await assert.rejects(retireSourceDeletionLedgers({ ...f, now }), fails("source_quarantined"));
  rmSync(join(f.dataRoot, "restore-quarantine.json"));
  await assert.rejects(retireSourceDeletionLedgers({ ...f, key: "", now }), fails("invalid_key"));
  assert.deepEqual(readFileSync(join(f.source, `${guildA}.deleted.json`)), before);
  const expired = await retireSourceDeletionLedgers({ ...f, now, ...evidence(now) });
  assert.equal(expired.retiredCount, 1);
  assert.equal(expired.state, "operator_block");
});

test("legacy offsite hard35 removes the expired encrypted proof while retaining only global antirollback and refusing v1 empty ACK", async (t) => {
  const f = fixture(t),
    old = entry(),
    now = old.purgedAt + deletionLedgerMaxAgeMs;
  f.save(old);
  const sealed = await sealLatestDeletionLedger({ ...f, now: now - 1 }),
    imported = await importLatestDeletionLedger({ ...f, ...sealed, now: now - 1, maxAgeMs: 60000 });
  const result = await pruneImportedDeletionLedgers({ ...f, now });
  assert.equal(result.removed, 1);
  assert.equal(result.blocked, true);
  assert.equal(existsSync(imported.path), false);
  assert.equal(existsSync(imported.indexPath), false);
  const state = readFileSync(join(f.directory, "deletion-watermark.json"), "utf8");
  assert.equal(state.includes(guildA), false);
  assert.throws(
    () => verifyLatestDeletionLedger({ ...f, ...sealed, now, maxAgeMs: 60000 }),
    fails("expired_decision"),
  );
  const dropped = forge({ ...body([]), createdAt: now }, f.key);
  for (const retirementEvidence of [
    undefined,
    evidence(now),
    {
      ...evidence(now),
      canonicalInventory: { verifiedAt: now, complete: true, unknown: 0, untracked: 0 },
    },
  ])
    await assert.rejects(
      importLatestDeletionLedger({
        ...f,
        envelope: dropped,
        now,
        maxAgeMs: 60000,
        retirementEvidence,
      }),
      fails("source_requires_v2"),
    );
  assert.equal(readFileSync(join(f.directory, "deletion-watermark.json"), "utf8"), state);
});

test("terminal pending pairs keep the first purge timestamp for their dedicated cleanup owner", async (t) => {
  const f = fixture(t),
    old = entry(),
    now = old.purgedAt + deletionLedgerMaxAgeMs;
  f.save(old);
  const pending = {
    format: 1,
    guildId: guildA,
    removedAt: old.removedAt,
    phase: "registry_done",
    public: true,
    databasePath: join(f.dataRoot, "old.sqlite"),
    databaseIdentity: { dev: "1", ino: "2" },
    assetNames: [],
  };
  const path = join(f.source, `${guildA}.pending.json`);
  writeFileSync(path, JSON.stringify(pending), { mode: 0o600 });
  const result = await retireSourceDeletionLedgers({ ...f, now });
  assert.equal(result.state, "operator_block");
  assert.equal(result.reason, "terminal_pending_cleanup_required");
  assert.equal(result.retiredCount, 0);
  assert.deepEqual(JSON.parse(readFileSync(path)), pending);
  assert.deepEqual(JSON.parse(readFileSync(join(f.source, `${guildA}.deleted.json`))), old);
});

test("unverified gap presence blocks empty v1 seal, while an invalid signed gap cannot authorize any source unlink", async (t) => {
  const f = fixture(t),
    unsigned = join(f.source, "source-gap-unverified.json");
  writeFileSync(unsigned, "{malformed", { mode: 0o600 });
  await assert.rejects(
    sealLatestDeletionLedger({ ...f, now: at }),
    fails("unverified_retention_gap"),
  );
  const old = entry(),
    now = old.purgedAt + deletionLedgerMaxAgeMs;
  f.save(old);
  writeFileSync(
    join(f.source, "source-gap.json"),
    JSON.stringify({ format: 1, body: {}, hmac: "a".repeat(64) }),
    { mode: 0o600 },
  );
  await assert.rejects(
    retireSourceDeletionLedgers({ ...f, now }),
    (error) => error.code === "watermark_authentication_failed",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(f.source, `${guildA}.deleted.json`))), old);
  assert.equal(readFileSync(unsigned, "utf8"), "{malformed");
});
test("private path, link, unfinished-import and tampered-index guards never touch unrelated files", async (t) => {
  const f = fixture(t);
  f.save(entry());
  const sealed = await sealLatestDeletionLedger({ ...f, now: at });
  await assert.rejects(
    importLatestDeletionLedger({
      ...f,
      ...sealed,
      directory: join(f.root, "public_html", "ledger"),
      now: at,
      maxAgeMs: 60000,
    }),
    fails("operator_block"),
  );
  mkdirSync(f.directory, { mode: 0o700 });
  const sentinel = join(f.directory, `.deletion-ledger-${randomUUID()}.tmp`);
  writeFileSync(sentinel, "unfinished", { mode: 0o600 });
  await assert.rejects(
    importLatestDeletionLedger({ ...f, ...sealed, now: at, maxAgeMs: 60000 }),
    fails("operator_block"),
  );
  assert.equal(readFileSync(sentinel, "utf8"), "unfinished");
  rmSync(sentinel);
  const imported = await importLatestDeletionLedger({ ...f, ...sealed, now: at, maxAgeMs: 60000 });
  const victim = join(f.root, "victim");
  writeFileSync(victim, "untouched");
  writeFileSync(
    imported.indexPath,
    JSON.stringify({ ...JSON.parse(readFileSync(imported.indexPath)), file: "../victim" }),
  );
  await assert.rejects(
    importLatestDeletionLedger({ ...f, ...sealed, now: at, maxAgeMs: 60000 }),
    fails("invalid_index"),
  );
  assert.equal(readFileSync(victim, "utf8"), "untouched");
});

test(
  "POSIX symlink and hardlink ledger inputs are rejected",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t),
      victim = join(f.root, "victim.json");
    writeFileSync(victim, JSON.stringify(entry()), { mode: 0o600 });
    const path = join(f.source, `${guildA}.deleted.json`);
    symlinkSync(victim, path);
    await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }));
    assert.deepEqual(JSON.parse(readFileSync(victim)), entry());
    rmSync(path);
    linkSync(victim, path);
    await assert.rejects(sealLatestDeletionLedger({ ...f, now: at }));
  },
);

test(
  "POSIX permissive existing offsite directories cannot receive ledger data",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    f.save(entry());
    const sealed = await sealLatestDeletionLedger({ ...f, now: at });
    mkdirSync(f.directory, { mode: 0o700 });
    chmodSync(f.directory, 0o777);
    await assert.rejects(
      importLatestDeletionLedger({ ...f, ...sealed, now: at, maxAgeMs: 60000 }),
      fails("operator_block"),
    );
    assert.deepEqual(readdirSync(f.directory), []);
  },
);
