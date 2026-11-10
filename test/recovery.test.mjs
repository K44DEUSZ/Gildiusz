import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { ModuleSettingsStore } from "../dist/core/modules/settings.js";
import { TwitchHubStore } from "../dist/modules/twitch/store.js";
import { acquireLock } from "../dist/storage/lock.js";
import {
  createSnapshot,
  restoreSnapshot,
  planSnapshot,
  currentRecoverySchemaPolicy,
  acquireDataRootLease,
  assertRestoreStartupAllowed,
  snapshotSchemasUnchanged,
  maximumRecoveryArchiveAgeMs,
} from "../dist/storage/recovery/index.js";
import { encryptArchive } from "../dist/storage/recovery/archive.js";
import { configuredSnapshot, recoveryCommand } from "../scripts/recovery.mjs";
import { stoppedSnapshot, deploymentPause } from "../scripts/hosting.mjs";
import { quarantineDatabase } from "../dist/storage/recovery/schema.js";
import { serverRulesMigration } from "../dist/modules/server-rules/schema.js";

const guildA = "900000000000000001",
  guildB = "900000000000000002",
  actor = "900000000000000003",
  channel = "900000000000000004";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==",
  "base64",
);

test("restore quarantine independently disables rules and retires old controls and queued grants", (t) => {
  const store = new Store(":memory:", guildA),
    db = store.db;
  t.after(() => store.close());
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_rules_settings'")
      .get()
  )
    db.exec(serverRulesMigration.sql);
  const version = randomUUID(),
    acceptance = randomUUID(),
    now = Date.now();
  db.prepare("INSERT INTO server_rules_settings VALUES(?,4,8,1,NULL,?)").run(guildA, version);
  db.prepare("INSERT INTO server_rules_versions VALUES(?,?,8,?,'hash','active',?,?)").run(
    guildA,
    version,
    JSON.stringify({
      channelId: channel,
      roleId: actor,
      label: "1",
      content: "Test",
      method: "button",
      emoji: null,
    }),
    now,
    actor,
  );
  db.prepare(
    "INSERT INTO server_rules_acceptances VALUES(?,?,?,?,?,?,?,'button','pending',NULL,NULL,NULL)",
  ).run(guildA, acceptance, actor, now - 1000, version, actor, now);
  quarantineDatabase(db, "guild", now + 1);
  const settings = db.prepare("SELECT * FROM server_rules_settings").get();
  assert.equal(settings.enabled, 0);
  assert.equal(settings.active_version_id, null);
  assert.equal(settings.revision, 5);
  assert.equal(settings.generation, 9);
  assert.equal(db.prepare("SELECT state FROM server_rules_versions").get().state, "retired");
  const grant = db.prepare("SELECT grant_state,reason FROM server_rules_acceptances").get();
  assert.equal(grant.grant_state, "blocked");
  assert.equal(grant.reason, "restore_quarantine");
});
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-recovery-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data"),
    backups = join(root, "backups");
  mkdirSync(dataRoot, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  const guilds = [],
    stores = [];
  for (const [index, guildId] of [guildA, guildB].entries()) {
    const databasePath =
        index === 1
          ? join(dataRoot, "public-guilds", guildId, "gildiusz.sqlite")
          : join(dataRoot, `${guildId}.sqlite`),
      configPath = join(root, `${guildId}.json`),
      store = new Store(databasePath, guildId);
    store.db.exec("PRAGMA wal_autocheckpoint=0");
    store.db
      .prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), Date.now(), "test", guildId, `guild-data-${index}`, null, null);
    writeFileSync(configPath, JSON.stringify({ brand: { name: `Guild ${index}` } }), {
      mode: 0o600,
    });
    guilds.push({
      guildId,
      ownerId: actor,
      databasePath,
      configPath,
      ...(index === 1 ? { public: true } : {}),
    });
    stores.push(store);
    const jobs = new JobStore(store.db, () => 1000);
    for (const state of ["pending", "retry", "running", "unknown", "succeeded"]) {
      const job = jobs.enqueue({
        guildId,
        type: "announcement.publish",
        payload: { test: true },
        dueAt: 1000,
        dedupeKey: `${guildId}:${state}`,
      });
      store.db
        .prepare("UPDATE jobs SET state=?,lease_token=?,lease_until=?,message_id=? WHERE id=?")
        .run(
          state,
          state === "running" ? "lease-test" : null,
          state === "running" ? 10000 : null,
          state === "succeeded" ? "confirmed-message" : null,
          job.id,
        );
      if (state === "running")
        store.db
          .prepare(
            "INSERT INTO delivery_attempts(id,job_id,number,lease_token,state,started_at) VALUES(?,?,1,?,'sending',1000)",
          )
          .run(randomUUID(), job.id, "lease-test");
    }
    const settings = new ModuleSettingsStore(store.db, guildId),
      initial = settings.read();
    settings.save(
      {
        ...initial,
        enabled: { ...initial.enabled, announcements: true, meetings: true, integrations: true },
      },
      actor,
    );
  }
  const hubDatabasePath = join(dataRoot, "integrations.sqlite"),
    hubDb = new DatabaseSync(hubDatabasePath),
    hub = new TwitchHubStore(hubDb, { authorize: () => {} });
  const bindingA = await hub.createBinding(guildA, actor, randomUUID(), {
    broadcasterId: "1337",
    channelId: channel,
    roleIds: [],
    mentionEveryone: false,
    enabled: true,
    template: "{name} nadaje {url}",
  });
  await hub.createBinding(guildB, actor, randomUUID(), {
    broadcasterId: "1337",
    channelId: channel,
    roleIds: [],
    mentionEveryone: false,
    enabled: true,
    template: "{name} nadaje {url}",
  });
  const registryPath = join(dataRoot, "public-guilds", "installations.json");
  mkdirSync(join(dataRoot, "public-guilds"), { recursive: true, mode: 0o700 });
  writeFileSync(registryPath, JSON.stringify([{ guildId: guildB, ownerId: actor }]), {
    mode: 0o600,
  });
  const assetId = randomUUID(),
    assetsRoot = join(dataRoot, "announcement-assets");
  mkdirSync(join(assetsRoot, guildA), { recursive: true, mode: 0o700 });
  writeFileSync(join(assetsRoot, guildA, `${assetId}.png`), png, { mode: 0o600 });
  stores[0].db
    .prepare("INSERT INTO announcement_assets VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      assetId,
      guildA,
      "image/png",
      png.length,
      1,
      1,
      createHash("sha256").update(png).digest("hex"),
      1000,
      null,
    );
  const annId = randomUUID();
  stores[0].db
    .prepare(
      `INSERT INTO announcements(id,guild_id,actor_id,channel_id,content,role_ids,mention_everyone,status,revision,generation,created_at,updated_at,presentation)
    VALUES (?,?,?,?,?,'[]',0,'scheduled',1,1,1000,1000,?)`,
    )
    .run(
      annId,
      guildA,
      actor,
      channel,
      "saved text",
      JSON.stringify({ card: { imageAssetId: assetId } }),
    );
  stores[0].db
    .prepare("INSERT INTO schedules(announcement_id,definition,next_due_at) VALUES (?, '{}',2000)")
    .run(annId);
  stores[0].db
    .prepare("INSERT INTO announcement_asset_refs VALUES (?,?,?)")
    .run(annId, assetId, guildA);
  const webDatabasePath = join(root, "web.sqlite"),
    web = new DatabaseSync(webDatabasePath);
  web.exec(
    "PRAGMA journal_mode=WAL;CREATE TABLE sessions(id TEXT PRIMARY KEY,token TEXT);CREATE TABLE oauth_states(id TEXT);CREATE TABLE preview_config(id TEXT PRIMARY KEY,body TEXT)",
  );
  web.prepare("INSERT INTO sessions VALUES ('s',?)").run("do-not-backup-oauth-token");
  web.exec(
    "INSERT INTO oauth_states VALUES ('oauth');INSERT INTO preview_config VALUES ('p','saved')",
  );
  const options = {
    dataRoot,
    guilds,
    hubDatabasePath,
    registryPath,
    assetsRoot,
    webDatabasePath,
    outputPath: join(backups, "snapshot.gldbak"),
    key: randomBytes(32),
    release: "a".repeat(40),
  };
  t.after(() => {
    for (const store of stores) store.db.close();
    hubDb.close();
    web.close();
    const path = resolve(root);
    assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes("gildiusz-recovery-"));
    rmSync(path, { recursive: true, force: true });
  });
  return { root, options, stores, hubDb, bindingA, assetId, annId };
}

test("rules from another guild cannot enter a guild snapshot", async (t) => {
  const f = await fixture(t);
  f.stores[0].db.prepare("INSERT INTO server_rules_settings VALUES(?,0,0,0,NULL,NULL)").run(guildB);
  await assert.rejects(createSnapshot(f.options), /another guild's data/);
  assert.equal(existsSync(f.options.outputPath), false);
});

test("foreign rules deletion counters and UUID outbox rows cannot enter another guild's snapshot", async (t) => {
  for (const table of ["server_rules_deletion_state", "server_rules_deletion_outbox"]) {
    const f = await fixture(t);
    if (table === "server_rules_deletion_state")
      f.stores[0].db
        .prepare("INSERT INTO server_rules_deletion_state VALUES(?,0,0,NULL)")
        .run(guildB);
    else
      f.stores[0].db
        .prepare("INSERT INTO server_rules_deletion_outbox VALUES(?,?,0,3024000000,1,NULL)")
        .run(guildB, randomUUID());
    await assert.rejects(createSnapshot(f.options), /another guild's data/);
    assert.equal(existsSync(f.options.outputPath), false);
  }
});

test("direct restore enforces the original archive deadline even after the encrypted file is copied", async (t) => {
  const f = await fixture(t),
    manifest = await createSnapshot(f.options),
    copied = join(f.root, "copied-later.gldbak");
  writeFileSync(copied, readFileSync(f.options.outputPath));
  for (const [label, now] of [
    ["deadline", manifest.createdAt + maximumRecoveryArchiveAgeMs],
    ["expired", manifest.createdAt + maximumRecoveryArchiveAgeMs + 1],
    ["future", manifest.createdAt - 1],
  ]) {
    const targetRoot = join(f.root, "rejected-" + label);
    await assert.rejects(
      restoreSnapshot({ archivePath: copied, targetRoot, key: f.options.key, now }),
      /expired or dated in the future/,
    );
    assert.equal(existsSync(targetRoot), false);
  }
  const targetRoot = join(f.root, "just-before-deadline");
  await restoreSnapshot({
    archivePath: copied,
    targetRoot,
    key: f.options.key,
    now: manifest.createdAt + maximumRecoveryArchiveAgeMs - 1,
  });
  assert.throws(() => assertRestoreStartupAllowed(targetRoot), /quarantined/);
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith(".gildiusz-restore-")),
    false,
  );
  await assert.rejects(
    restoreSnapshot({
      archivePath: copied,
      targetRoot: join(f.root, "invalid-policy"),
      key: f.options.key,
      now: manifest.createdAt,
      maxArchiveAgeMs: maximumRecoveryArchiveAgeMs + 1,
      dryRun: true,
    }),
    /age policy/,
  );
});

test("two WAL guilds, shared hub, registry and controlled assets round-trip only into quarantined data", async (t) => {
  const f = await fixture(t),
    manifest = await createSnapshot(f.options);
  assert.equal(manifest.guilds.length, 2);
  assert.ok(existsSync(f.options.guilds[0].databasePath + "-wal"));
  const archive = readFileSync(f.options.outputPath);
  assert.equal(archive.subarray(0, 8).toString(), "GLDBAK01");
  for (const value of [
    "guild-data-0",
    "do-not-backup-oauth-token",
    "saved text",
    f.options.key.toString("base64url"),
  ])
    assert.equal(archive.includes(Buffer.from(value)), false);
  assert.equal(await snapshotSchemasUnchanged(f.options, manifest), true);
  const targetRoot = join(f.root, "restored");
  await restoreSnapshot({ archivePath: f.options.outputPath, targetRoot, key: f.options.key });
  assert.throws(() => assertRestoreStartupAllowed(targetRoot), /quarantined/);
  for (const entry of manifest.guilds) {
    const db = new DatabaseSync(join(targetRoot, entry.databasePath), { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(db.prepare("SELECT COUNT(*) count FROM events").get().count, 1);
      assert.equal(
        db
          .prepare("SELECT COUNT(*) count FROM jobs WHERE state IN ('pending','running','retry')")
          .get().count,
        0,
      );
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) count FROM jobs WHERE state='succeeded' AND message_id='confirmed-message'",
          )
          .get().count,
        1,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) count FROM jobs WHERE state='unknown'").get().count,
        2,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) count FROM delivery_attempts WHERE state='sending'").get()
          .count,
        0,
      );
      const settings = new ModuleSettingsStore(db, entry.guildId).read();
      assert.equal(Object.values(settings.enabled).some(Boolean), false);
      if (entry.guildId === guildA) {
        assert.equal(
          db.prepare("SELECT status FROM announcements WHERE id=?").get(f.annId).status,
          "paused",
        );
        assert.equal(db.prepare("SELECT next_due_at FROM schedules").get().next_due_at, null);
        assert.deepEqual(
          readFileSync(join(targetRoot, `announcement-assets/${guildA}/${f.assetId}.png`)),
          png,
        );
        assert.equal(
          db.prepare("SELECT COUNT(*) count FROM announcement_asset_refs").get().count,
          1,
        );
      }
    } finally {
      db.close();
    }
  }
  const hub = new DatabaseSync(join(targetRoot, "integrations.sqlite"), { readOnly: true });
  try {
    assert.equal(hub.prepare("SELECT COUNT(*) count FROM twitch_sources").get().count, 1);
    for (const row of hub.prepare("SELECT definition FROM twitch_bindings").all())
      assert.equal(JSON.parse(row.definition).enabled, false);
  } finally {
    hub.close();
  }
  const web = new DatabaseSync(join(targetRoot, "web/web.sqlite"), { readOnly: true });
  try {
    assert.equal(web.prepare("SELECT COUNT(*) count FROM sessions").get().count, 0);
    assert.equal(web.prepare("SELECT COUNT(*) count FROM oauth_states").get().count, 0);
    assert.equal(web.prepare("SELECT body FROM preview_config").get().body, "saved");
  } finally {
    web.close();
  }
  assert.equal(
    readFileSync(join(targetRoot, "web/web.sqlite")).includes(
      Buffer.from("do-not-backup-oauth-token"),
    ),
    false,
  );
  assert.equal(
    JSON.parse(readFileSync(join(targetRoot, "public-guilds/installations.json")))[0].guildId,
    guildB,
  );
  assert.equal(
    f.stores[0].db.prepare("SELECT COUNT(*) count FROM jobs WHERE state='pending'").get().count,
    1,
  );
  await assert.rejects(
    restoreSnapshot({ archivePath: f.options.outputPath, targetRoot, key: f.options.key }),
    /empty target/,
  );
});

test("operator restore and full dry-run require only the independent key, not the lost source installation", async (t) => {
  const f = await fixture(t);
  await createSnapshot(f.options);
  const target = join(f.root, "operator-restored"),
    values = { BACKUP_ENCRYPTION_KEY: f.options.key.toString("base64url") };
  const checked = await recoveryCommand(
    "restore",
    { archive: f.options.outputPath, target, dryRun: true },
    values,
  );
  assert.equal(checked.dryRun, true);
  assert.equal(checked.quarantined, false);
  assert.equal(existsSync(target), false);
  const restored = await recoveryCommand(
    "restore",
    { archive: f.options.outputPath, target },
    values,
  );
  assert.equal(restored.quarantined, true);
  assert.throws(() => assertRestoreStartupAllowed(target), /quarantined/);
});

test("minimal deletion decisions round-trip privately and restore explicitly requires reconciliation", async (t) => {
  const f = await fixture(t),
    guildId = "900000000000000099",
    directory = join(f.options.dataRoot, "uninstall-retention");
  mkdirSync(directory, { mode: 0o700 });
  const ledger = {
    format: 1,
    guildId,
    removedAt: 1000,
    purgedAt: 1000 + 30 * 86400000,
    outcome: "purged",
  };
  writeFileSync(join(directory, `${guildId}.deleted.json`), JSON.stringify(ledger), {
    mode: 0o600,
  });
  const manifest = await createSnapshot(f.options);
  assert.equal(
    manifest.files.some((entry) => entry.path === `uninstall-retention/${guildId}.deleted.json`),
    true,
  );
  const targetRoot = join(f.root, "deletion-aware-restore");
  await restoreSnapshot({ archivePath: f.options.outputPath, targetRoot, key: f.options.key });
  assert.deepEqual(
    JSON.parse(readFileSync(join(targetRoot, "uninstall-retention", `${guildId}.deleted.json`))),
    ledger,
  );
  const marker = JSON.parse(readFileSync(join(targetRoot, "restore-quarantine.json")));
  assert.equal(marker.deletionReconciliationRequired, true);
  assert.equal(marker.deletionLedgerIncluded, true);
  assert.throws(() => assertRestoreStartupAllowed(targetRoot), /quarantined/);
});

test("committed uninstall cleanup or an extended deletion ledger cannot produce a complete snapshot", async (t) => {
  const f = await fixture(t),
    directory = join(f.options.dataRoot, "uninstall-retention");
  mkdirSync(directory, { mode: 0o700 });
  const pending = join(directory, `${guildA}.pending.json`);
  writeFileSync(pending, JSON.stringify({ phase: "committed" }), { mode: 0o600 });
  assert.throws(() => planSnapshot(f.options), /committed uninstall wipe/);
  rmSync(pending);
  writeFileSync(
    join(directory, `${guildA}.deleted.json`),
    JSON.stringify({
      format: 1,
      guildId: guildA,
      removedAt: 1000,
      purgedAt: 2000,
      outcome: "purged",
      ownerId: actor,
    }),
    { mode: 0o600 },
  );
  assert.throws(() => planSnapshot(f.options), /deletion ledger/);
  assert.equal(existsSync(f.options.outputPath), false);
});

test(
  "POSIX snapshot output and restore target parents reject permissive pre-existing directories",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      outputDirectory = join(f.root, "backups");
    chmodSync(outputDirectory, 0o777);
    await assert.rejects(createSnapshot(f.options), /unrelated writers|private/);
    chmodSync(outputDirectory, 0o700);
    await createSnapshot(f.options);
    const badParent = join(f.root, "shared-restore");
    mkdirSync(badParent, { mode: 0o777 });
    chmodSync(badParent, 0o777);
    await assert.rejects(
      restoreSnapshot({
        archivePath: f.options.outputPath,
        targetRoot: join(badParent, "target"),
        key: f.options.key,
      }),
      /unrelated writers|private/,
    );
  },
);

test("common and per-database writer leases deny a snapshot before any archive is created", async (t) => {
  const f = await fixture(t);
  for (const acquire of [
    () => acquireDataRootLease(f.options.dataRoot),
    () => acquireLock(f.options.guilds[0].databasePath),
    () => acquireLock(f.options.hubDatabasePath),
  ]) {
    const release = await acquire();
    try {
      await assert.rejects(createSnapshot(f.options), /lock/i);
      assert.equal(existsSync(f.options.outputPath), false);
    } finally {
      await release();
    }
  }
  assert.deepEqual(readdirSync(join(f.root, "backups")), []);
});

test("wrong key, corruption, authenticated path escape, bad file hash and old schema never expose restored data", async (t) => {
  const f = await fixture(t),
    manifest = await createSnapshot(f.options),
    targetRoot = join(f.root, "empty");
  mkdirSync(targetRoot, { mode: 0o700 });
  await assert.rejects(
    restoreSnapshot({ archivePath: f.options.outputPath, targetRoot, key: randomBytes(32) }),
    /authentication/,
  );
  const corrupted = join(f.root, "backups/corrupt.gldbak"),
    bytes = readFileSync(f.options.outputPath);
  bytes[55] ^= 1;
  writeFileSync(corrupted, bytes, { mode: 0o600 });
  await assert.rejects(
    restoreSnapshot({ archivePath: corrupted, targetRoot, key: f.options.key }),
    /authentication/,
  );
  const poison = {
    ...manifest,
    files: [
      {
        path: "../escaped",
        size: 0,
        sha256: createHash("sha256").update("").digest("hex"),
        kind: "configuration",
      },
    ],
    guilds: [],
  };
  const poisonPath = join(f.root, "backups/poison.gldbak");
  encryptArchive(poisonPath, poison, [], f.options.key);
  await assert.rejects(
    restoreSnapshot({ archivePath: poisonPath, targetRoot, key: f.options.key }),
    /manifest path/,
  );
  const mismatch = join(f.root, "backups/mismatch.gldbak");
  encryptArchive(
    mismatch,
    { ...poison, files: [{ ...poison.files[0], path: "guilds.json", sha256: "0".repeat(64) }] },
    [],
    f.options.key,
  );
  await assert.rejects(
    restoreSnapshot({ archivePath: mismatch, targetRoot, key: f.options.key }),
    /checksum/,
  );
  const policy = currentRecoverySchemaPolicy();
  policy.guild.migrations.pop();
  await assert.rejects(
    restoreSnapshot({
      archivePath: f.options.outputPath,
      targetRoot,
      key: f.options.key,
      schemaPolicy: policy,
    }),
    /schema is not supported/,
  );
  assert.deepEqual(readdirSync(targetRoot), []);
  assert.equal(existsSync(join(f.root, "escaped")), false);
});

test("credentials, wrong guilds, missing images and reused keys reject incomplete snapshots", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => planSnapshot({ ...f.options, forbiddenKeys: [f.options.key.toString("base64url")] }),
    /independent/,
  );
  writeFileSync(f.options.guilds[0].configPath, JSON.stringify({ clientSecret: "no" }));
  assert.throws(() => planSnapshot(f.options), /credentials/);
  writeFileSync(f.options.guilds[0].configPath, "{}");
  const bad = {
    ...f.options,
    guilds: f.options.guilds.map((guild, index) =>
      index ? guild : { ...guild, guildId: "900000000000000099" },
    ),
  };
  await assert.rejects(createSnapshot(bad), /another guild/);
  rmSync(join(f.options.assetsRoot, guildA, `${f.assetId}.png`));
  await assert.rejects(createSnapshot(f.options), /ENOENT/);
  assert.equal(existsSync(f.options.outputPath), false);
  assert.deepEqual(readdirSync(join(f.root, "backups")), []);
});

test("schema mutations after a failed activation prohibit code-only rollback", async (t) => {
  const f = await fixture(t),
    manifest = await createSnapshot(f.options);
  assert.equal(await snapshotSchemasUnchanged(f.options, manifest), true);
  f.stores[0].db.exec("CREATE TABLE future_schema(value TEXT)");
  assert.equal(await snapshotSchemasUnchanged(f.options, manifest), false);
});

test("known pre-migration schemas restore under quarantine while altered SQL with the same ledger is denied", async (t) => {
  const f = await fixture(t);
  for (const store of f.stores)
    store.db.exec(
      "DROP TABLE server_rules_deletion_outbox;DROP TABLE server_rules_deletion_state;DROP TABLE server_rules_acceptances;DROP TABLE server_rules_parts;DROP TABLE server_rules_memberships;DROP TABLE server_rules_retired_acceptances;DROP TABLE server_rules_settings;DROP TABLE server_rules_versions;DROP TABLE domain_retired;DROP TABLE job_history_retired;DROP INDEX announcements_visible;ALTER TABLE announcements DROP COLUMN removed_at;DELETE FROM schema_migrations WHERE version>=10",
    );
  const manifest = await createSnapshot(f.options);
  assert.equal(manifest.files.find((entry) => entry.kind === "guild").schema.migrations.length, 9);
  const targetRoot = join(f.root, "older-restored");
  await restoreSnapshot({ archivePath: f.options.outputPath, targetRoot, key: f.options.key });
  assert.throws(() => assertRestoreStartupAllowed(targetRoot), /quarantined/);
  const db = new DatabaseSync(join(targetRoot, manifest.guilds[0].databasePath), {
    readOnly: true,
  });
  try {
    assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 9);
  } finally {
    db.close();
  }
  f.stores[0].db.exec("ALTER TABLE jobs ADD COLUMN injected TEXT");
  await assert.rejects(
    createSnapshot({ ...f.options, outputPath: join(f.root, "backups/tampered.gldbak") }),
    /unsupported schema object/,
  );
});

test("installer validates its key before stopping and cannot activate past a failed stopped snapshot", async () => {
  const calls = [];
  await assert.rejects(
    stoppedSnapshot({
      preflight: () => {
        calls.push("plan");
        throw Error("key");
      },
      stop: () => calls.push("stop"),
      snapshot: () => calls.push("snapshot"),
    }),
    /key/,
  );
  assert.deepEqual(calls, ["plan"]);
  calls.length = 0;
  await assert.rejects(
    stoppedSnapshot({
      preflight: () => calls.push("plan"),
      stop: () => calls.push("stop"),
      snapshot: () => {
        calls.push("snapshot");
        throw Error("locked");
      },
    }),
    /locked/,
  );
  assert.deepEqual(calls, ["plan", "stop", "snapshot"]);
  assert.equal(
    await stoppedSnapshot({ preflight: () => {}, stop: () => {}, snapshot: () => "complete" }),
    "complete",
  );
});

test("deployment fence never removes an existing or changed operator pause", async (t) => {
  const f = await fixture(t),
    shared = join(f.root, "shared");
  mkdirSync(shared, { mode: 0o700 });
  const pause = join(shared, "paused"),
    release = deploymentPause(f.root);
  assert.throws(() => deploymentPause(f.root), /EEXIST/);
  writeFileSync(pause, "operator pause");
  assert.throws(release, /pause changed/);
  assert.equal(readFileSync(pause, "utf8"), "operator pause");
  assert.throws(() => deploymentPause(f.root), /EEXIST/);
});

test("recovery source discovery includes public installs without constructing or modifying their registry", async (t) => {
  const f = await fixture(t),
    registryBefore = readFileSync(f.options.registryPath);
  const config = configuredSnapshot(f.options.outputPath, {
    DISCORD_GUILD_ID: guildA,
    OWNER_USER_ID: actor,
    CONFIG_PATH: f.options.guilds[0].configPath,
    DATABASE_PATH: f.options.guilds[0].databasePath,
    HEALTH_PATH: join(f.options.dataRoot, "health.json"),
    PUBLIC_INSTALLS: "0",
    BACKUP_ENCRYPTION_KEY: f.options.key.toString("base64url"),
  });
  assert.equal(config.guilds.length, 2);
  assert.equal(config.hubDatabasePath, f.options.hubDatabasePath);
  assert.deepEqual(readFileSync(f.options.registryPath), registryBefore);
});

test("completed legacy deletion no longer blocks backups and a fresh public installation can replace it", async (t) => {
  const f = await fixture(t),
    guildId = "900000000000000099",
    missing = join(f.options.dataRoot, "legacy-deleted.sqlite"),
    definitions = join(f.root, "operator-guilds.json");
  writeFileSync(
    definitions,
    JSON.stringify([
      {
        guildId,
        ownerId: actor,
        databasePath: missing,
        configPath: join(f.root, "legacy-config.json"),
      },
      f.options.guilds[0],
    ]),
    { mode: 0o600 },
  );
  const values = {
    GUILDS_PATH: definitions,
    HEALTH_PATH: join(f.options.dataRoot, "health.json"),
    PUBLIC_INSTALLS: "0",
    BACKUP_ENCRYPTION_KEY: f.options.key.toString("base64url"),
  };
  assert.throws(() => planSnapshot(configuredSnapshot(f.options.outputPath, values)), /ENOENT/);
  const directory = join(f.options.dataRoot, "uninstall-retention");
  mkdirSync(directory, { mode: 0o700 });
  const ledgerPath = join(directory, `${guildId}.deleted.json`),
    ledger = { format: 1, guildId, removedAt: 1000, purgedAt: 2000, outcome: "purged" };
  writeFileSync(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
  const filtered = configuredSnapshot(f.options.outputPath, values);
  assert.equal(
    filtered.guilds.some((entry) => entry.guildId === guildId),
    false,
  );
  assert.equal(planSnapshot(filtered).guilds, 2);
  const replacementPath = join(f.options.dataRoot, "public-guilds", guildId, "gildiusz.sqlite"),
    replacement = new Store(replacementPath, guildId);
  replacement.close();
  const registry = JSON.parse(readFileSync(f.options.registryPath));
  registry.push({ guildId, ownerId: actor });
  writeFileSync(f.options.registryPath, JSON.stringify(registry));
  const replaced = configuredSnapshot(f.options.outputPath, values),
    entry = replaced.guilds.find((entry) => entry.guildId === guildId);
  assert.equal(entry.public, true);
  assert.equal(entry.databasePath, replacementPath);
  assert.equal(planSnapshot(replaced).guilds, 3);
  writeFileSync(ledgerPath, JSON.stringify({ ...ledger, guildId: guildA }));
  assert.throws(() => configuredSnapshot(f.options.outputPath, values), /deletion ledger/);
});

test("public-only backups still discover the existing registry when new installs are disabled", async (t) => {
  const f = await fixture(t),
    before = readFileSync(f.options.registryPath);
  const values = {
    HEALTH_PATH: join(f.options.dataRoot, "health.json"),
    PUBLIC_INSTALLS: "0",
    BACKUP_ENCRYPTION_KEY: f.options.key.toString("base64url"),
  };
  const configuration = configuredSnapshot(f.options.outputPath, values);
  assert.deepEqual(
    configuration.guilds.map((entry) => entry.guildId),
    [guildB],
  );
  assert.equal(configuration.guilds[0].public, true);
  assert.equal(planSnapshot(configuration).guilds, 1);
  assert.deepEqual(readFileSync(f.options.registryPath), before);
  const manifest = await createSnapshot(configuration);
  assert.deepEqual(
    manifest.guilds.map((entry) => entry.guildId),
    [guildB],
  );
  assert.deepEqual(readFileSync(f.options.registryPath), before);
  assert.throws(
    () =>
      configuredSnapshot(join(f.root, "other.gldbak"), {
        ...values,
        CONTROL_DATA_DIR: join(f.root, "no-registry"),
      }),
    /DISCORD_GUILD_ID/,
  );
  assert.throws(
    () =>
      configuredSnapshot(join(f.root, "other.gldbak"), {
        ...values,
        GUILDS_PATH: join(f.root, "missing-explicit-config.json"),
      }),
    /ENOENT/,
  );
});

test("operator CLI performs plan, encrypted snapshot and independent dry-run without putting a key in arguments or output", async (t) => {
  const f = await fixture(t),
    output = join(f.root, "backups/cli.gldbak"),
    target = join(f.root, "cli-target");
  const base = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  const env = {
    ...base,
    DISCORD_GUILD_ID: guildA,
    OWNER_USER_ID: actor,
    CONFIG_PATH: f.options.guilds[0].configPath,
    DATABASE_PATH: f.options.guilds[0].databasePath,
    HEALTH_PATH: join(f.options.dataRoot, "health.json"),
    PUBLIC_INSTALLS: "0",
    BACKUP_ENCRYPTION_KEY: f.options.key.toString("base64url"),
  };
  for (const command of ["plan", "snapshot"]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/recovery.mjs", command, "--output", output],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(env.BACKUP_ENCRYPTION_KEY), false);
    const value = JSON.parse(result.stdout);
    assert.equal(command === "plan" ? value.guilds : value.guilds.length, 2);
  }
  const checked = spawnSync(
    process.execPath,
    ["scripts/recovery.mjs", "restore", "--archive", output, "--target", target, "--dry-run"],
    {
      cwd: process.cwd(),
      env: { ...base, BACKUP_ENCRYPTION_KEY: env.BACKUP_ENCRYPTION_KEY },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).dryRun, true);
  assert.equal(existsSync(target), false);
});

test("actual main rejects a malformed restore marker before credentials, health, registry or database writes", async (t) => {
  const f = await fixture(t),
    data = join(f.root, "main-probe");
  mkdirSync(data, { mode: 0o700 });
  const mainUrl = pathToFileURL(resolve("dist/bot/main.js")).href,
    configUrl = pathToFileURL(resolve("dist/config.js")).href;
  const intercepted =
    "data:text/javascript," +
    encodeURIComponent(
      `export * from ${JSON.stringify(configUrl)};export function loadCredentials(){throw Object.assign(new Error('sentinel'),{code:'credentials_touched'});}`,
    );
  const source = `import{registerHooks}from'node:module';registerHooks({resolve(specifier,context,next){return context.parentURL===${JSON.stringify(mainUrl)}&&specifier==='../config.js'?{url:${JSON.stringify(intercepted)},shortCircuit:true}:next(specifier,context)}});await import(${JSON.stringify(mainUrl)});`;
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  Object.assign(env, {
    HEALTH_PATH: join(data, "health.json"),
    DATABASE_PATH: join(data, "guild.sqlite"),
    PUBLIC_INSTALLS: "1",
    CONTROL_DATA_DIR: join(data, "public-guilds"),
  });
  const run = () =>
    spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 10000,
    });
  const control = run();
  assert.equal(control.status, 1);
  assert.match(control.stderr, /credentials_touched/);
  assert.deepEqual(readdirSync(data), []);
  writeFileSync(join(data, "restore-quarantine.json"), "{malformed", { mode: 0o600 });
  const blocked = run();
  assert.equal(blocked.status, 1);
  assert.doesNotMatch(blocked.stderr, /credentials_touched/);
  assert.deepEqual(readdirSync(data), ["restore-quarantine.json"]);
  assert.equal(readFileSync(join(data, "restore-quarantine.json"), "utf8"), "{malformed");
});
