import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import { acquireLock } from "../dist/storage/lock.js";
import { createSnapshot } from "../dist/storage/recovery/index.js";
import { initializeRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import {
  openRulesDeletionLifecycle,
  upgradeRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";
import { recordRulesDeletion } from "../dist/modules/server-rules/deletion-outbox.js";
import { BackupCatalog, archiveIdentity } from "../scripts/backup-catalog.mjs";
import { sealLatestDeletionProof } from "../scripts/backup-proof.mjs";

export async function backupV2Fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-backup-v2-")),
    dataRoot = join(root, "data"),
    guildId = "900000000000000001",
    key = randomBytes(32);
  mkdirSync(dataRoot, { mode: 0o700 });
  const databasePath = join(dataRoot, "guild.sqlite"),
    configPath = join(root, "configuration.json");
  let store = new Store(databasePath, guildId);
  store.db
    .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?)")
    .run("v2-fixture-event", Date.now(), "fixture", guildId, "content", null, null);
  store.close();
  writeFileSync(configPath, JSON.stringify({ brand: { name: "Fixture" } }), { mode: 0o600 });
  const installations = [{ guildId, databasePath }];
  await initializeRulesDeletionJournal({ dataRoot, installations });
  await upgradeRulesDeletionLifecycle({ dataRoot, installations });
  const options = {
    dataRoot,
    key,
    outputPath: join(root, "source.gldbak"),
    release: "a".repeat(40),
    guilds: [{ guildId, ownerId: "900000000000000002", databasePath, configPath }],
  };
  const manifest = await createSnapshot(options),
    identity = await archiveIdentity(options.outputPath),
    catalog = new BackupCatalog({ root: join(root, "pc") });
  const f = {
    root,
    dataRoot,
    guildId,
    key,
    options,
    manifest,
    catalog,
    expected: { id: manifest.id, createdAt: manifest.createdAt, ...identity },
    now: Date.now(),
    installations,
  };
  catalog.clock = () => f.now;
  f.seal = async ({ challenge = randomUUID(), notBefore = f.now } = {}) => {
    const sealed = await sealLatestDeletionProof({
      dataRoot,
      installations,
      key,
      now: f.now,
      notBefore,
      challenge,
    });
    return {
      ...sealed,
      proofRequirements: {
        expectedSourceId: sealed.meta.sourceId,
        minSequence: sealed.meta.sequence,
        notBefore,
        challenge,
      },
    };
  };
  f.request = (sealed) => ({
    catalog,
    expected: f.expected,
    existingArchivePath: options.outputPath,
    key,
    latestProof: sealed.envelope,
    proofRequirements: sealed.proofRequirements,
  });
  f.expiringDecision = async () => {
    const release = await acquireDataRootLease(dataRoot),
      lease = await acquireLock(databasePath, { createTarget: false });
    let owned = true;
    store = new Store(databasePath, guildId);
    try {
      const id = randomUUID();
      new JobStore(store.db).transaction(() =>
        recordRulesDeletion(store.db, guildId, id, f.now - 35 * 86400000 + 1000, f.now + 1000),
      );
      const port = openRulesDeletionLifecycle({
        dataRoot,
        clock: () => f.now,
        readCanonicalInstallations: () => installations,
        ownership: {
          assertHeld() {
            assert.equal(owned, true);
          },
          assertGuildLease(gid) {
            assert.equal(gid, guildId);
          },
          assertQuiescent() {
            assert.equal(owned, true);
          },
        },
      });
      await port.drainActiveOutbox({ stores: [{ guildId, jobs: new JobStore(store.db) }] });
      return id;
    } finally {
      store.close();
      owned = false;
      await lease();
      await release();
    }
  };
  f.evidence = () => ({
    knownLocationIds: ["host", "pc"],
    maxLocationAgeMs: 60000,
    canonicalInventory: { verifiedAt: f.now, complete: true, unknown: 0, untracked: 0 },
    locations: ["host", "pc"].map((id) => ({
      id,
      verifiedAt: f.now,
      complete: true,
      unknown: 0,
      inProgress: 0,
      copies: [{ id: manifest.id, createdAt: manifest.createdAt }],
    })),
  });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}
