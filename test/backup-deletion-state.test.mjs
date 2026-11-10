import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertGlobalDeletionEvidence,
  acquireDeletionImportLock,
  commitDeletionState,
  compareGuildDeletion,
  deletionArtifactHash,
  deletionDeadline,
  deletionStateFile,
  deletionTerminalAgeMs,
  legacyDeletionGapFile,
  pruneLockedDeletionArtifacts,
  readDeletionState,
  scanDeletionArtifacts,
} from "../scripts/backup-deletion-state.mjs";
import { acquireLock } from "../dist/storage/lock.js";

const now = Date.parse("2026-11-10T12:00:00Z"),
  day = 86400000;
const fails = (code) => (error) => error.code === code;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-deletion-state-")),
    key = randomBytes(32),
    sourceId = randomUUID();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const meta = (sequence = 5) => ({
    format: 2,
    id: randomUUID(),
    sha256: "a".repeat(64),
    createdAt: now,
    sourceId,
    sequence,
    coveredFrom: now - day,
  });
  return {
    directory,
    key,
    sourceId,
    meta,
    read: () => readDeletionState({ directory, key, now }),
    write: (extra = {}) => commitDeletionState({ directory, key, now, ...extra }),
  };
}
function evidence(at = now) {
  return {
    knownLocationIds: ["host", "pc"],
    maxLocationAgeMs: 60000,
    canonicalInventory: { verifiedAt: at, complete: true, unknown: 0, untracked: 0 },
    locations: ["host", "pc"].map((id) => ({
      id,
      verifiedAt: at,
      complete: true,
      unknown: 0,
      inProgress: 0,
      copies: [],
    })),
  };
}
test("deadlines include original guild purge and acceptance expiry rather than import time", () => {
  assert.equal(
    deletionDeadline({ createdAt: now, guilds: [{ purgedAt: now - 34 * day }] }),
    now + day,
  );
  assert.equal(
    deletionDeadline({
      createdAt: now,
      guilds: [{ purgedAt: now - 34 * day }],
      acceptances: [{ expiresAt: now + 1 }],
    }),
    now + 1,
  );
  assert.equal(deletionDeadline({ createdAt: now, maxAgeMs: 60000 }), now + 60000);
  assert.throws(
    () => deletionDeadline({ createdAt: Number.MAX_SAFE_INTEGER }),
    fails("invalid_time"),
  );
});

test("import locking rejects linked targets without opening them and fences the legacy codec locks", async (t) => {
  const f = fixture(t),
    victim = join(f.directory, "victim"),
    target = join(f.directory, ".deletion-state-import");
  writeFileSync(victim, "", { mode: 0o600 });
  linkSync(victim, target);
  await assert.rejects(acquireDeletionImportLock(f.directory), /unlinked/);
  assert.equal(readFileSync(victim).length, 0);
  unlinkSync(target);
  unlinkSync(victim);
  const legacy = join(f.directory, ".deletion-ledger-import");
  writeFileSync(legacy, "", { mode: 0o600 });
  const held = await acquireLock(legacy, { createTarget: false });
  try {
    await assert.rejects(
      acquireDeletionImportLock(f.directory),
      (error) => error.code === "ELOCKED",
    );
    assert.equal(existsSync(`${target}.lock`), false);
    assert.equal(existsSync(join(f.directory, ".deletion-proof-import.lock")), false);
    assert.equal(existsSync(`${legacy}.lock`), true);
  } finally {
    await held();
  }
  const release = await acquireDeletionImportLock(f.directory);
  await release();
  assert.deepEqual(
    scanDeletionArtifacts({ directory: f.directory, now, decode: () => assert.fail() }),
    [],
  );
});

test("artifact namespace rejects a linked index before structural decoding or unlink", (t) => {
  const f = fixture(t),
    external = mkdtempSync(join(tmpdir(), "gildiusz-external-index-")),
    victim = join(external, "victim"),
    index = join(f.directory, "latest-proof.json");
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(victim, "{}", { mode: 0o600 });
  linkSync(victim, index);
  assert.throws(
    () => scanDeletionArtifacts({ directory: f.directory, now, decode: () => assert.fail() }),
    fails("operator_block"),
  );
  assert.equal(readFileSync(index, "utf8"), "{}");
  assert.equal(readFileSync(victim, "utf8"), "{}");
});

test("missing committed payload becomes a durable global gap rather than a new empty directory", (t) => {
  const f = fixture(t),
    head = f.meta();
  f.write({ incoming: head });
  const result = pruneLockedDeletionArtifacts({
    directory: f.directory,
    key: f.key,
    now,
    decode: () => assert.fail(),
  });
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.state.globalGap.reason, "source_gap");
  assert.equal(result.state.globalGap.unsafeBefore, head.createdAt);
  assert.equal(f.read().minSequence, head.sequence);
  const before = readFileSync(join(f.directory, deletionStateFile));
  assert.throws(() => f.write({ incoming: f.meta(6) }), fails("operator_block"));
  assert.deepEqual(readFileSync(join(f.directory, deletionStateFile)), before);
  f.write({ incoming: f.meta(6), retirementEvidence: evidence() });
  assert.equal(f.read().globalGap, null);
});
test("purge supersession is monotonic while exact replay does not renew dates", () => {
  const old = {
    format: 1,
    guildId: "100000000000000001",
    removedAt: 10,
    purgedAt: 20,
    outcome: "purged",
  };
  assert.equal(
    compareGuildDeletion(old, Object.fromEntries(Object.entries(old).reverse())),
    "same",
  );
  assert.equal(compareGuildDeletion(old, { ...old, removedAt: 20, purgedAt: 21 }), "superseded");
  for (const next of [
    { ...old, purgedAt: 21 },
    { ...old, removedAt: 19, purgedAt: 21 },
    { ...old, removedAt: 21 },
    { ...old, format: 2, removedAt: 22, purgedAt: 23 },
  ])
    assert.throws(() => compareGuildDeletion(old, next), fails("conflicting_deletion"));
});
test("authenticated watermark preserves source, sequence and coverage after decision payloads are gone", (t) => {
  const f = fixture(t),
    first = f.meta();
  f.write({ incoming: first });
  assert.equal(f.read().minSequence, 5);
  f.write({ incoming: { ...f.meta(6), createdAt: now + 1 }, now: now + 1 });
  const bytes = readFileSync(join(f.directory, deletionStateFile));
  for (const incoming of [
    { ...f.meta(4), createdAt: now + 2 },
    { ...f.meta(7), sourceId: randomUUID(), createdAt: now + 2 },
    { ...f.meta(7), coveredFrom: now, createdAt: now + 2 },
  ])
    assert.throws(() => f.write({ incoming, now: now + 2 }), fails("rollback_detected"));
  assert.deepEqual(readFileSync(join(f.directory, deletionStateFile)), bytes);
  const raw = JSON.parse(bytes);
  raw.body.minSequence = 999;
  writeFileSync(join(f.directory, deletionStateFile), JSON.stringify(raw));
  assert.throws(
    () => readDeletionState({ directory: f.directory, key: f.key, now: now + 2 }),
    fails("watermark_authentication_failed"),
  );
});
test("legacy expiry gap is durable and has no invented source identity or per-guild fields", (t) => {
  const f = fixture(t),
    params = {
      filename: legacyDeletionGapFile,
      gap: { unsafeBefore: now - deletionTerminalAgeMs, reason: "legacy_retention_expired" },
    };
  const first = f.write(params);
  assert.equal(first.sourceId, null);
  assert.equal(first.minSequence, null);
  assert.equal(first.coveredFrom, null);
  assert.equal(first.head, null);
  const later = f.write({
    ...params,
    now: now + day,
    gap: { ...params.gap, unsafeBefore: now - day },
  });
  assert.equal(later.globalGap.blockedSince, now);
  assert.equal(later.globalGap.unsafeBefore, now - day);
  const text = readFileSync(join(f.directory, legacyDeletionGapFile), "utf8");
  assert.doesNotMatch(text, /guildId|acceptanceId|removedAt|purgedAt|epoch/);
  assert.throws(
    () =>
      f.write({
        filename: legacyDeletionGapFile,
        now: now + day,
        incoming: { format: 1, id: randomUUID(), sha256: "b".repeat(64), createdAt: now + day },
      }),
    fails("source_requires_v2"),
  );
});
test("clearing a gap requires fresh complete physical inventory for every known location and canonical definitions", (t) => {
  const f = fixture(t);
  f.write({ incoming: f.meta(), gap: { unsafeBefore: now - day, reason: "terminal_expired" } });
  const before = readFileSync(join(f.directory, deletionStateFile));
  const variants = [
    undefined,
    { ...evidence(), locations: evidence().locations.slice(0, 1) },
    { ...evidence(), canonicalInventory: { ...evidence().canonicalInventory, untracked: 1 } },
    {
      ...evidence(),
      canonicalInventory: { ...evidence().canonicalInventory, verifiedAt: now - day },
    },
    {
      ...evidence(),
      locations: evidence().locations.map((v) => (v.id === "pc" ? { ...v, unknown: 1 } : v)),
    },
    {
      ...evidence(),
      locations: evidence().locations.map((v) => ({
        ...v,
        copies: [{ id: randomUUID(), createdAt: now - day }],
      })),
    },
  ];
  for (const retirementEvidence of variants) {
    assert.throws(
      () => f.write({ incoming: f.meta(6), retirementEvidence }),
      fails("operator_block"),
    );
    assert.deepEqual(readFileSync(join(f.directory, deletionStateFile)), before);
  }
  f.write({ incoming: f.meta(6), retirementEvidence: evidence() });
  assert.equal(f.read().globalGap, null);
  assert.equal(f.read().minSequence, 6);
  assert.equal(f.read().coveredFrom, now - day);
});
test("invalid keys and signatures cannot commit a replacement, and gaps never resolve from time alone", (t) => {
  const f = fixture(t);
  f.write({ gap: { unsafeBefore: now - 35 * day, reason: "legacy_retention_expired" } });
  const bytes = readFileSync(join(f.directory, deletionStateFile));
  assert.throws(
    () => readDeletionState({ directory: f.directory, key: randomBytes(32), now }),
    fails("watermark_authentication_failed"),
  );
  assert.throws(() => f.write({ incoming: f.meta(), now: now + day }), fails("operator_block"));
  assert.deepEqual(readFileSync(join(f.directory, deletionStateFile)), bytes);
  assert.throws(
    () =>
      assertGlobalDeletionEvidence({
        gap: { unsafeBefore: now },
        now,
        ...evidence(),
        maxLocationAgeMs: 35 * day,
      }),
    fails("operator_block"),
  );
});

test("physical expiry keeps authenticated global antirollback state before removing the old payload and index", (t) => {
  const f = fixture(t),
    expiredId = randomUUID(),
    recentId = randomUUID(),
    acceptanceId = randomUUID();
  const make = (id, sequence, createdAt, acceptances = []) => {
    const body = {
      meta: { ...f.meta(sequence), id, createdAt, coveredFrom: now - 50 * day },
      guilds: [],
      acceptances,
    };
    const bytes = Buffer.from(JSON.stringify(body)),
      name = `deletion-proof-${id}.gldproof`;
    writeFileSync(join(f.directory, name), bytes, { mode: 0o600 });
    return { body, bytes, name };
  };
  const old = make(expiredId, 5, now - 36 * day, [
    {
      guildId: "100000000000000001",
      acceptanceId,
      retiredAt: now - 36 * day,
      expiresAt: now - day,
    },
  ]);
  const recent = make(recentId, 7, now - 1000);
  utimesSync(join(f.directory, old.name), new Date(now), new Date(now));
  writeFileSync(
    join(f.directory, "latest-proof.json"),
    JSON.stringify({ id: expiredId, sha256: deletionArtifactHash(old.bytes), file: old.name }),
    { mode: 0o600 },
  );
  const decode = (bytes) => {
    const result = JSON.parse(bytes.toString());
    result.meta.sha256 = deletionArtifactHash(bytes);
    return result;
  };
  const result = pruneLockedDeletionArtifacts({ directory: f.directory, key: f.key, now, decode });
  assert.deepEqual(result.removed, [old.name]);
  assert.equal(existsSync(join(f.directory, old.name)), false);
  assert.equal(existsSync(join(f.directory, "latest-proof.json")), false);
  assert.equal(existsSync(join(f.directory, recent.name)), true);
  const state = f.read();
  assert.equal(state.sourceId, f.sourceId);
  assert.equal(state.minSequence, 7);
  assert.equal(state.globalGap.unsafeBefore, now - 36 * day);
  const raw = readFileSync(join(f.directory, deletionStateFile), "utf8");
  assert.equal(raw.includes(acceptanceId), false);
  assert.equal(raw.includes("100000000000000001"), false);
  assert.throws(
    () => f.write({ incoming: { ...f.meta(6), coveredFrom: now - 50 * day } }),
    fails("rollback_detected"),
  );
});
