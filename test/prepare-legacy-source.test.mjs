import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createSnapshot,
  currentRecoverySchemaPolicy,
  assertSourcePreparationComplete,
} from "../dist/storage/recovery/index.js";
import { acquireLock } from "../dist/storage/lock.js";
import { Store } from "../dist/storage/store.js";
import { snapshotRulesDeletionLifecycle } from "../dist/storage/rules-deletion-lifecycle.js";
import { prepareLegacySource } from "../scripts/prepare-legacy-source.mjs";

const guildId = "900000000000000001",
  ownerId = "900000000000000002",
  revision = "a".repeat(40);
async function fixture(t, { modern = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-legacy-source-")),
    dataRoot = join(root, "data"),
    databasePath = join(dataRoot, "guild.sqlite"),
    configPath = join(root, "config.json"),
    archivePath = join(root, "before.gldbak"),
    key = randomBytes(32);
  mkdirSync(dataRoot, { mode: 0o700 });
  if (modern) new Store(databasePath, guildId).close();
  else {
    const db = new DatabaseSync(databasePath),
      baseline = currentRecoverySchemaPolicy().guild.knownPrefixes[0];
    try {
      for (const object of baseline.objects.filter(
        (o) => o.type === "table" && o.name !== "schema_migrations",
      ))
        db.exec(object.sql);
      for (const object of baseline.objects.filter((o) => o.type !== "table")) db.exec(object.sql);
      db.exec("PRAGMA user_version=2");
      db.prepare("INSERT INTO guild_identity VALUES(1,?)").run(guildId);
      db.prepare("INSERT INTO resources VALUES(?,?,?,?)").run(
        "role.existing",
        "role",
        ownerId,
        '{"keep":true}',
      );
      db.prepare("INSERT INTO role_selections VALUES(?,?)").run(ownerId, "existing");
    } finally {
      db.close();
    }
  }
  writeFileSync(configPath, '{"brand":{"name":"Fixture"}}', { mode: 0o600 });
  const installations = [{ guildId, ownerId, databasePath, configPath }];
  await createSnapshot({
    dataRoot,
    guilds: installations,
    key,
    outputPath: archivePath,
    release: revision,
  });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /gildiusz-legacy-source-[^\\/]+$/);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dataRoot,
    databasePath,
    archivePath,
    key,
    installations,
    sourceRevision: revision,
    assertPaused() {},
    marker: join(dataRoot, "source-preparation.json"),
  };
}

test("planning leaves the legacy schema and current roles untouched", async (t) => {
  const f = await fixture(t),
    before = readFileSync(f.databasePath);
  assert.equal((await prepareLegacySource(f)).state, "requires_apply");
  assert.deepEqual(readFileSync(f.databasePath), before);
  assert.equal(existsSync(f.marker), false);
});

test("first source preparation preserves legacy work and creates a complete format2 source", async (t) => {
  const f = await fixture(t),
    result = await prepareLegacySource({ ...f, apply: true });
  assert.equal(result.state, "ready");
  assert.equal(result.journalFormat, 2);
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 13);
    assert.equal(
      db.prepare("SELECT baseline FROM resources WHERE key=?").get("role.existing").baseline,
      '{"keep":true}',
    );
    assert.equal(
      db.prepare("SELECT member FROM role_selections WHERE role_key=?").get("existing").member,
      ownerId,
    );
  } finally {
    db.close();
  }
  assert.equal(existsSync(f.marker), false);
  assertSourcePreparationComplete(f.dataRoot);
  assert.equal((await snapshotRulesDeletionLifecycle(f)).complete, true);
});

test("active writers, wrong keys and a foreign backup scope cannot start preparation", async (t) => {
  const f = await fixture(t),
    release = await acquireLock(f.databasePath, { createTarget: false });
  try {
    await assert.rejects(prepareLegacySource({ ...f, apply: true }), { code: "writer_active" });
  } finally {
    await release();
  }
  await assert.rejects(prepareLegacySource({ ...f, key: randomBytes(32), apply: true }));
  await assert.rejects(
    prepareLegacySource({
      ...f,
      installations: [{ ...f.installations[0], ownerId: "900000000000000003" }],
      apply: true,
    }),
    { code: "backup_scope_mismatch" },
  );
  assert.equal(existsSync(f.marker), false);
});

test("a modern database with missing deletion history is not reclassified as an empty legacy source", async (t) => {
  const f = await fixture(t, { modern: true });
  await assert.rejects(prepareLegacySource({ ...f, apply: true }), { code: "not_legacy_source" });
  assert.equal(existsSync(f.marker), false);
});

test("a false or asynchronous pause check cannot authorize source writes", async (t) => {
  const f = await fixture(t);
  for (const assertPaused of [() => false, async () => true])
    await assert.rejects(prepareLegacySource({ ...f, apply: true, assertPaused }), {
      code: "hosting_pause_unverified",
    });
  assert.equal(existsSync(f.marker), false);
});

test("loss of the owned hosting pause leaves a durable startup and backup block", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    prepareLegacySource({
      ...f,
      apply: true,
      assertPaused() {
        if (existsSync(f.marker)) throw Error("pause_lost");
      },
    }),
    { sourcePreparationIncomplete: true },
  );
  assert.equal(existsSync(f.marker), true);
  assert.throws(() => assertSourcePreparationComplete(f.dataRoot), /incomplete/);
  await assert.rejects(
    createSnapshot({
      dataRoot: f.dataRoot,
      guilds: f.installations,
      key: f.key,
      outputPath: join(f.root, "partial.gldbak"),
    }),
    /incomplete/,
  );
});
