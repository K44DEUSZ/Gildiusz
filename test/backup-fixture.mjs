import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Store } from "../dist/storage/store.js";
import { createSnapshot } from "../dist/storage/recovery/index.js";
import { BackupCatalog, archiveIdentity } from "../scripts/backup-catalog.mjs";
import { sealLatestDeletionLedger } from "../scripts/backup-ledger.mjs";
import { decryptArchive, encryptArchive } from "../dist/storage/recovery/archive.js";

export async function backupFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-backup-flow-"));
  chmodSync(root, 0o700);
  t.after(() => {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.match(target, /gildiusz-backup-flow-[^\\/]+$/);
    rmSync(target, { recursive: true, force: true });
  });
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot, { mode: 0o700 });
  const key = randomBytes(32),
    guildId = "900000000000000001";
  const databasePath = join(dataRoot, "guild.sqlite"),
    configPath = join(root, "configuration.json");
  const store = new Store(databasePath, guildId);
  store.db
    .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?)")
    .run("fixture-event", Date.now(), "test", guildId, "fixture-content", null, null);
  store.close();
  writeFileSync(configPath, JSON.stringify({ brand: { name: "Fixture" } }), { mode: 0o600 });
  const options = {
    dataRoot,
    key,
    outputPath: join(root, "source.gldbak"),
    release: "a".repeat(40),
    guilds: [{ guildId, ownerId: "900000000000000002", databasePath, configPath }],
  };
  const manifest = await createSnapshot(options);
  const identity = await archiveIdentity(options.outputPath);
  const expected = { id: manifest.id, createdAt: manifest.createdAt, ...identity };
  const latestLedger = (await sealLatestDeletionLedger({ dataRoot, key })).envelope;
  const catalog = new BackupCatalog({ root: join(root, "pc") });
  return { root, dataRoot, key, manifest, expected, options, latestLedger, catalog };
}

export async function backdateBackup(f, createdAt) {
  const payload = join(f.root, "fixture-payload"),
    archive = join(f.root, "backdated.gldbak");
  decryptArchive(f.options.outputPath, payload, f.key, 512 * 1024 * 1024);
  const bytes = readFileSync(payload),
    length = bytes.readUInt32BE(0);
  const manifest = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8"));
  manifest.createdAt = createdAt;
  let offset = 4 + length;
  const files = manifest.files.map((entry, index) => {
    const path = join(f.root, `fixture-file-${index}`);
    writeFileSync(path, bytes.subarray(offset, offset + entry.size), { mode: 0o600 });
    offset += entry.size;
    return path;
  });
  encryptArchive(archive, manifest, files, f.key);
  f.options.outputPath = archive;
  f.manifest = manifest;
  f.expected = { id: manifest.id, createdAt, ...(await archiveIdentity(archive)) };
}
