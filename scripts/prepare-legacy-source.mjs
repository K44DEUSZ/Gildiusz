import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/storage/store.js";
import { acquireLock } from "../dist/storage/lock.js";
import {
  acquireDataRootLease,
  assertRestoreStartupAllowed,
  assertSourcePreparationComplete,
  sourcePreparationFile,
} from "../dist/storage/recovery/lease.js";
import { privateDirectory, regularFile, syncDirectory } from "../dist/storage/recovery/files.js";
import {
  restoreSnapshot,
  currentRecoverySchemaPolicy,
  schemaOf,
  verifySchema,
} from "../dist/storage/recovery/index.js";
import { initializeRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import {
  snapshotRulesDeletionLifecycle,
  upgradeRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";
import { configuredSnapshot, recoveryCredentials } from "./recovery.mjs";
import { withHostingBackupLock } from "./backup-scheduler.mjs";

function refused(code) {
  throw Object.assign(new Error(code), { code });
}

function inventory(dataRoot, installations) {
  if (!Array.isArray(installations) || !installations.length || installations.length > 1000)
    refused("invalid_inventory");
  const ids = new Set(),
    paths = new Set();
  return [...installations]
    .sort((a, b) => a.guildId.localeCompare(b.guildId))
    .map((entry) => {
      const path = resolve(entry.databasePath),
        local = relative(dataRoot, path);
      if (
        !/^[0-9]{17,20}$/.test(entry.guildId) ||
        !/^[0-9]{17,20}$/.test(entry.ownerId) ||
        ids.has(entry.guildId) ||
        paths.has(path) ||
        !local ||
        local.startsWith("..") ||
        isAbsolute(local)
      )
        refused("invalid_inventory");
      regularFile(path);
      ids.add(entry.guildId);
      paths.add(path);
      return { ...entry, databasePath: path };
    });
}

function verifyLegacyDatabase(entry, manifest, policy) {
  const saved = manifest.files.find(
      (file) => file.kind === "guild" && file.guildId === entry.guildId,
    ),
    db = new DatabaseSync(entry.databasePath, { readOnly: true });
  try {
    const schema = schemaOf(db, "guild");
    verifySchema(schema, policy.guild);
    if (
      schema.userVersion !== 2 ||
      schema.migrations.length ||
      !saved?.schema ||
      JSON.stringify(schema) !== JSON.stringify(saved.schema)
    )
      refused("not_legacy_source");
    if (
      db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !==
      entry.guildId
    )
      refused("guild_mismatch");
    if (Object.values(db.prepare("PRAGMA integrity_check").get())[0] !== "ok")
      refused("source_integrity_failed");
  } finally {
    db.close();
  }
}

/** First migration only. The caller owns the hosting pause and its deployment lock throughout. */
export async function prepareLegacySource({
  dataRoot,
  installations,
  archivePath,
  key,
  forbiddenKeys = [],
  sourceRevision,
  assertPaused,
  apply = false,
  clock = Date.now,
}) {
  if (
    typeof assertPaused !== "function" ||
    !/^[a-f0-9]{40}$/.test(sourceRevision ?? "") ||
    typeof apply !== "boolean"
  )
    refused("invalid_source_preparation");
  const fence = () => {
    const verified = assertPaused();
    if (verified && typeof verified.then === "function") {
      Promise.resolve(verified).catch(() => {});
      refused("hosting_pause_unverified");
    }
    if (verified !== undefined && verified !== true) refused("hosting_pause_unverified");
  };
  const root = privateDirectory(dataRoot);
  fence();
  assertRestoreStartupAllowed(root);
  assertSourcePreparationComplete(root);
  const entries = inventory(root, installations),
    releases = [];
  const marker = join(root, sourcePreparationFile);
  let intent;
  try {
    try {
      releases.push(await acquireDataRootLease(root));
      for (const entry of entries)
        releases.push(await acquireLock(entry.databasePath, { createTarget: false }));
    } catch {
      refused("writer_active");
    }
    fence();
    assertSourcePreparationComplete(root);
    if (
      existsSync(join(root, "rules-acceptance-deletions", "journal.json")) ||
      existsSync(join(root, "rules-acceptance-deletions", "source-policy.json"))
    )
      refused("source_already_initialized");
    const manifest = await restoreSnapshot({
        archivePath,
        key,
        forbiddenKeys,
        dryRun: true,
        targetRoot: join(dirname(archivePath), "source-preparation-check-" + randomUUID()),
      }),
      now = clock();
    if (
      !Number.isSafeInteger(now) ||
      manifest.release !== sourceRevision ||
      manifest.createdAt > now ||
      now - manifest.createdAt > 15 * 60000
    )
      refused("fresh_source_backup_required");
    const expected = entries.map((e) => [e.guildId, e.ownerId, !!e.public]),
      actual = [...manifest.guilds]
        .sort((a, b) => a.guildId.localeCompare(b.guildId))
        .map((e) => [e.guildId, e.ownerId, e.public]);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) refused("backup_scope_mismatch");
    const policy = currentRecoverySchemaPolicy();
    for (const entry of entries) verifyLegacyDatabase(entry, manifest, policy);
    if (!apply) return { state: "requires_apply", guilds: entries.length, backupId: manifest.id };
    fence();
    intent =
      JSON.stringify({
        format: 1,
        operationId: randomUUID(),
        backupId: manifest.id,
        sourceRevision,
        startedAt: now,
      }) + "\n";
    writeFileSync(marker, intent, { flag: "wx", mode: 0o600, flush: true });
    syncDirectory(root);
    for (const entry of entries) {
      fence();
      const store = new Store(entry.databasePath, entry.guildId);
      store.close();
    }
  } catch (error) {
    throw Object.assign(error, { sourcePreparationIncomplete: !!intent });
  } finally {
    for (const release of releases.reverse()) await release();
  }
  try {
    fence();
    await initializeRulesDeletionJournal({ dataRoot: root, installations: entries });
    fence();
    await upgradeRulesDeletionLifecycle({ dataRoot: root, installations: entries });
    const scope = await snapshotRulesDeletionLifecycle({ dataRoot: root, installations: entries });
    if (!scope.complete || scope.blockers.length || scope.active.length !== entries.length)
      refused("source_preparation_incomplete");
    fence();
    if (readFileSync(marker, "utf8") !== intent) refused("preparation_marker_changed");
    unlinkSync(marker);
    syncDirectory(root);
    return {
      state: "ready",
      guilds: entries.length,
      journalFormat: 2,
      sourceId: scope.sourceId,
      sequence: scope.sequence,
    };
  } catch (error) {
    throw Object.assign(error, { sourcePreparationIncomplete: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2),
      apply = args.includes("--apply"),
      archiveIndex = args.indexOf("--archive"),
      archivePath = args[archiveIndex + 1],
      hostingRoot = process.env.BACKUP_HOSTING_ROOT;
    if (
      !hostingRoot ||
      !isAbsolute(hostingRoot) ||
      archiveIndex < 0 ||
      !archivePath ||
      !isAbsolute(archivePath) ||
      args.length !== (apply ? 3 : 2) ||
      args.filter((arg) => arg === "--apply").length > 1
    )
      refused("use_private_hosting_root_and_archive");
    const root = privateDirectory(hostingRoot),
      pause = join(root, "shared/paused");
    regularFile(pause);
    const ownedPause = readFileSync(pause, "utf8");
    const { realpathSync } = await import("node:fs"),
      current = realpathSync(join(root, "current"));
    process.chdir(current);
    const config = configuredSnapshot(join(root, "shared/backups/unused-preparation.gldbak"));
    const result = await withHostingBackupLock(root, (fence) =>
      prepareLegacySource({
        dataRoot: config.dataRoot,
        installations: config.guilds,
        archivePath,
        ...recoveryCredentials(process.env),
        sourceRevision: basename(current),
        apply,
        assertPaused() {
          fence();
          regularFile(pause);
          if (readFileSync(pause, "utf8") !== ownedPause) refused("hosting_pause_changed");
        },
      }),
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      JSON.stringify({
        code: error.code ?? "legacy_source_preparation_refused",
        sourcePreparationIncomplete: error.sourcePreparationIncomplete === true,
      }),
    );
    process.exitCode = 1;
  }
}
