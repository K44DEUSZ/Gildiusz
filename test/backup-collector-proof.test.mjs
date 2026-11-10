import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { backupV2Fixture } from "./backup-v2-fixture.mjs";
import { collectArchive, pruneCollectedDeletionProofs } from "../scripts/backup-collector.mjs";
import { readDeletionState } from "../scripts/backup-deletion-state.mjs";

test("v2 offsite ACK binds the real archive to fresh authoritative coverage and cannot fall back to v1", async (t) => {
  const f = await backupV2Fixture(t),
    sealed = await f.seal(),
    first = await collectArchive(f.request(sealed));
  assert.equal(first.offsiteSuccess, true);
  assert.equal(first.ledger.format, 2);
  assert.equal(first.ledger.sequence, sealed.meta.sequence);
  const path = join(f.catalog.root, "deletion-ledger", "deletion-watermark.json"),
    before = readFileSync(path);
  const blocked = await collectArchive({
    ...f.request(sealed),
    latestProof: undefined,
    proofRequirements: undefined,
    latestLedger: new Uint8Array([1, 2, 3]),
  });
  assert.equal(blocked.offsiteSuccess, false);
  assert.equal(blocked.ledger.state, "proof_sync_required");
  assert.deepEqual(readFileSync(path), before);
  const replay = await collectArchive(f.request(sealed));
  assert.equal(replay.replayed, true);
  assert.equal(replay.offsiteSuccess, true);
});

test("a live proof transport receives a new challenge and stale ciphertext or source loss cannot ACK", async (t) => {
  const f = await backupV2Fixture(t),
    first = await f.seal();
  await collectArchive(f.request(first));
  await assert.rejects(
    collectArchive({ ...f.request(first), latestProof: async () => first.envelope }),
    (error) => error.code === "challenge_mismatch",
  );
  const latest = await collectArchive({
    ...f.request(first),
    latestProof: async (context) => (await f.seal(context)).envelope,
  });
  assert.equal(latest.offsiteSuccess, true);
  unlinkSync(join(f.dataRoot, "rules-acceptance-deletions", "journal.json"));
  await assert.rejects(
    collectArchive({
      ...f.request(first),
      latestProof: async (context) => (await f.seal(context)).envelope,
    }),
    (error) => error.code === "source_unavailable",
  );
  assert.equal(existsSync(f.catalog.archivePath(f.expected.id)), true);
});

for (const replay of [false, true])
  test(`proof expiry during final ${replay ? "replay" : "new"} confirmation blocks ACK and TTL runs without a source transport`, async (t) => {
    const f = await backupV2Fixture(t),
      id = await f.expiringDecision(),
      sealed = await f.seal(),
      expiry = sealed.meta.expiresAt;
    if (replay) await collectArchive(f.request(sealed));
    const confirm = f.catalog.confirmArchive.bind(f.catalog);
    f.catalog.confirmArchive = async (expected) => {
      const result = await confirm(expected);
      f.now = expiry;
      return result;
    };
    await assert.rejects(
      collectArchive(f.request(sealed)),
      (error) => error.code === "expired_decision",
    );
    const removed = await pruneCollectedDeletionProofs({ catalog: f.catalog, key: f.key });
    assert.equal(removed.removed, 1);
    assert.equal(removed.blocked, true);
    const directory = join(f.catalog.root, "deletion-ledger");
    assert.equal(
      readdirSync(directory).some((n) => n.endsWith(".gldproof")),
      false,
    );
    const state = readDeletionState({ directory, key: f.key, now: f.now });
    assert.equal(state.sourceId, sealed.meta.sourceId);
    assert.equal(state.minSequence, sealed.meta.sequence);
    assert.ok(state.globalGap);
    assert.equal(
      readFileSync(join(directory, "deletion-watermark.json"), "utf8").includes(id),
      false,
    );
  });

test("retirement evidence is explicit after TTL; complete fresh inventories allow the newer proof without source reset", async (t) => {
  const f = await backupV2Fixture(t);
  await f.expiringDecision();
  const sealed = await f.seal();
  await collectArchive(f.request(sealed));
  f.now = sealed.meta.expiresAt;
  await pruneCollectedDeletionProofs({ catalog: f.catalog, key: f.key });
  const newer = await f.seal();
  await assert.rejects(
    collectArchive(f.request(newer)),
    (error) => error.code === "operator_block",
  );
  const result = await collectArchive({
    ...f.request(newer),
    ledgerRetirementEvidence: async () => f.evidence(),
  });
  assert.equal(result.offsiteSuccess, true);
  assert.equal(result.ledger.sourceId, sealed.meta.sourceId);
  assert.ok(result.ledger.sequence > sealed.meta.sequence);
});
