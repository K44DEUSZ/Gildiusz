import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backupKey } from "../dist/storage/recovery/archive.js";
import { restoreSnapshot, maximumRecoveryArchiveAgeMs } from "../dist/storage/recovery/index.js";
import {
  hashFile,
  privateDirectory,
  regularFile,
  syncDirectory,
} from "../dist/storage/recovery/files.js";
import { physicalIdentity } from "../dist/storage/recovery/source-lease.js";
import {
  restoreQuarantineFile,
  sourcePreparationFile,
  coldSourceFenceFile,
} from "../dist/storage/recovery/lease.js";
import {
  coldRestoreReceiptFile,
  finalizationDirectory,
  digest,
  readPrivateRecoveryJson,
  signedRecoveryDocument,
  readSignedRecoveryDocument,
  durableRecoveryWrite,
  recoveryTargetInventory,
  withRecoveryTargetLease,
  recoveredLifecycleJournal,
  closeRecoveryDatabase,
} from "../dist/storage/recovery/finalize.js";
import {
  inspectRestoredInstallation,
  reconcileRestoredGuild,
  rebaseRestoredGuild,
  logicalDatabaseDigest,
  assertCoreQuarantined,
} from "../dist/storage/recovery/finalize-lineage.js";
import {
  applyRestoredRetention,
  acknowledgeRestoredRetention,
  eraseRetiredGuildIntegrations,
  scrubRestoredWebData,
  assertHubQuarantined,
  assertRestoredWebEmpty,
} from "../dist/storage/recovery/finalize-erasure.js";
import {
  assertIntegrity,
  schemaOf,
  verifySchema,
  currentRecoverySchemaPolicy,
} from "../dist/storage/recovery/schema.js";
import { verifyRecoveryCapture, createColdRecoveryPair } from "./recovery-capture.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const need = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const json = (body) => JSON.stringify(body) + "\n";
const signedWrite = (path, body, key) =>
  durableRecoveryWrite(path, signedRecoveryDocument(body, key));
function immutableJson(value) {
  const copy = globalThis.structuredClone(value);
  const freeze = (row) => {
    if (row && typeof row === "object") {
      for (const child of Object.values(row)) freeze(child);
      Object.freeze(row);
    }
    return row;
  };
  return freeze(copy);
}
function ownInputs(options) {
  return Object.freeze({
    ...options,
    requirements: immutableJson(options.requirements),
    ...(options.plan === undefined ? {} : { plan: immutableJson(options.plan) }),
  });
}
function sourcePathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function sourceFenceStillValid(capture) {
  const fence = JSON.parse(capture.coldPair.fence.body);
  need(isAbsolute(fence.sourceRoot || ""), "cold_source_location_not_bound");
  if (fence.webDatabasePath !== null) {
    const peer = fence.webDatabasePath + ".source-cold-pair.json";
    if (sourcePathExists(peer))
      need(
        readFileSync(peer, "utf8") === capture.coldPair.fence.body,
        "cold_web_source_fence_changed",
      );
    else
      need(
        !sourcePathExists(fence.webDatabasePath) && !sourcePathExists(fence.sourceRoot),
        "cold_web_source_fence_missing",
      );
  }
  if (!sourcePathExists(fence.sourceRoot)) return;
  need(same(physicalIdentity(fence.sourceRoot), fence.rootIdentity), "cold_source_root_replaced");
  const path = join(fence.sourceRoot, coldSourceFenceFile);
  regularFile(path);
  need(
    readFileSync(path, "utf8") === capture.coldPair.fence.body,
    "cold_source_fence_missing_or_changed",
  );
  need(
    readFileSync(join(fence.sourceRoot, sourcePreparationFile), "utf8") ===
      capture.coldPair.fence.body,
    "cold_source_compatibility_fence_changed",
  );
  for (const file of capture.coldPair.sourceState) {
    const identity = fence.databases.find((entry) => entry.path === file.path)?.identity;
    need(identity && same(physicalIdentity(file.path), identity), "cold_source_database_replaced");
    const db = new DatabaseSync(file.path, { readOnly: true });
    try {
      need(logicalDatabaseDigest(db) === file.logicalSha256, "cold_source_has_later_writes");
    } finally {
      db.close();
    }
  }
  need(
    same(
      readPrivateRecoveryJson(join(fence.sourceRoot, "rules-acceptance-deletions/journal.json")),
      capture.journal,
    ),
    "cold_source_journal_changed",
  );
}
async function authority(options, key) {
  need(
    [options.archivePath, options.capturePath, options.targetRoot].every(
      (path) => typeof path === "string" && isAbsolute(path),
    ),
    "absolute_finalization_paths_required",
  );
  const now = options.now ?? Date.now(),
    requirements = options.requirements,
    checked = verifyRecoveryCapture({ path: options.capturePath, key, requirements, now });
  need(checked.capture.format === 2, "cold_capture_v2_required");
  sourceFenceStillValid(checked.capture);
  const manifest = await restoreSnapshot({
    archivePath: options.archivePath,
    targetRoot: join(dirname(options.archivePath), ".finalize-verify-" + randomUUID()),
    key,
    dryRun: true,
    now,
  });
  need(
    hashFile(options.archivePath).sha256 === checked.capture.archive.sha256 &&
      manifest.id === checked.capture.archive.id,
    "cold_archive_mismatch",
  );
  need(
    digest(JSON.stringify(manifest.guilds)) === checked.capture.coldPair.manifestGuildsSha256,
    "cold_archive_inventory_mismatch",
  );
  need(
    manifest.webSessionsRemoved ===
      (JSON.parse(checked.capture.coldPair.fence.body).webDatabasePath !== null),
    "cold_web_archive_binding_mismatch",
  );
  for (const row of checked.capture.coldPair.active) {
    const guild = manifest.guilds.find((guild) => guild.guildId === row.guildId);
    need(
      guild && guild.ownerId === row.ownerId && guild.public === row.public,
      "current_active_identity_missing_from_archive",
    );
    need(
      row.public ||
        manifest.files.find((file) => file.path === guild.configPath)?.sha256 === row.configSha256,
      "cold_archive_configuration_mismatch",
    );
  }
  return {
    ...checked,
    manifest,
    now,
    archiveSha256: hashFile(options.archivePath).sha256,
    captureSha256: hashFile(options.capturePath).sha256,
    requirementsSha256: digest(JSON.stringify(requirements)),
  };
}
function baseline(root, auth, key) {
  const body = readSignedRecoveryDocument(join(root, coldRestoreReceiptFile), key);
  need(
    body.kind === "gildiusz-cold-restore-baseline" &&
      body.archiveId === auth.manifest.id &&
      body.archiveSha256 === auth.archiveSha256 &&
      body.captureSha256 === auth.captureSha256 &&
      body.requirementsSha256 === auth.requirementsSha256 &&
      same(body.rootIdentity, physicalIdentity(root)),
    "cold_restore_baseline_mismatch",
  );
  return body;
}
function assertInitialTarget(root, auth, receipt, permitOwnedPreIntent = false) {
  need(
    same(readPrivateRecoveryJson(join(root, "restore-manifest.json")), auth.manifest),
    "authenticated_restore_manifest_mismatch",
  );
  for (const file of auth.manifest.files.filter((file) => file.kind === "web")) {
    const peer = readPrivateRecoveryJson(join(root, file.path + ".restore-quarantine.json"));
    need(
      same(peer, {
        format: 1,
        kind: "gildiusz-restored-web-quarantine",
        backupId: auth.manifest.id,
        automaticResume: false,
      }),
      "restore_web_quarantine_mismatch",
    );
  }
  const marker = readPrivateRecoveryJson(join(root, restoreQuarantineFile));
  need(
    marker.backupId === auth.manifest.id && marker.automaticResume === false,
    "restore_quarantine_mismatch",
  );
  need(
    same(recoveryTargetInventory(root, auth.manifest, permitOwnedPreIntent), receipt.files),
    "cold_restore_target_changed",
  );
}

/** The old restore path remains quarantined; only this authenticated fresh baseline can be planned. */
export async function restoreColdRecoveryTarget(givenOptions) {
  const options = ownInputs(givenOptions);
  const key = backupKey(options.key, options.forbiddenKeys);
  try {
    const auth = await authority(options, key);
    await restoreSnapshot({
      archivePath: options.archivePath,
      targetRoot: options.targetRoot,
      key,
      now: auth.now,
      quarantineWeb: true,
    });
    return await withRecoveryTargetLease(options.targetRoot, auth.manifest, async () => {
      const body = {
        format: 1,
        kind: "gildiusz-cold-restore-baseline",
        archiveId: auth.manifest.id,
        archiveSha256: auth.archiveSha256,
        captureSha256: auth.captureSha256,
        requirementsSha256: auth.requirementsSha256,
        createdAt: auth.now,
        rootIdentity: physicalIdentity(options.targetRoot),
        files: recoveryTargetInventory(options.targetRoot, auth.manifest),
      };
      signedWrite(join(options.targetRoot, coldRestoreReceiptFile), body, key);
      return {
        state: "cold_target_quarantined",
        backupId: auth.manifest.id,
        activationAllowed: false,
      };
    });
  } finally {
    key.fill(0);
  }
}

async function copyDatabase(source, destination) {
  writeFileSync(destination, "", { flag: "wx", mode: 0o600, flush: true });
  const input = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(input, destination);
  } finally {
    input.close();
  }
}
async function transformGuild(source, destination, guild, auth, plannedAt, persistHistory) {
  await copyDatabase(source, destination);
  const db = new DatabaseSync(destination);
  try {
    reconcileRestoredGuild(db, guild.guildId, auth.capture.journal, plannedAt);
    rebaseRestoredGuild(db, guild.original, auth.capture.journal, guild.newEpoch, plannedAt);
    const history = applyRestoredRetention(db, guild.guildId, plannedAt);
    await persistHistory(history);
    acknowledgeRestoredRetention(db, history.entries, plannedAt);
    assertCoreQuarantined(db, guild.guildId);
    assertIntegrity(db);
    return { logicalSha256: logicalDatabaseDigest(db), history };
  } finally {
    closeRecoveryDatabase(db);
  }
}
async function transformShared(source, destination, kind, retired) {
  await copyDatabase(source, destination);
  const db = new DatabaseSync(destination);
  try {
    if (kind === "hub") {
      assertHubQuarantined(db);
      eraseRetiredGuildIntegrations(db, retired);
      assertHubQuarantined(db);
    } else scrubRestoredWebData(db);
    assertIntegrity(db);
    return logicalDatabaseDigest(db);
  } finally {
    closeRecoveryDatabase(db);
  }
}

export async function planColdRecoveryFinalization(givenOptions) {
  const options = ownInputs(givenOptions);
  const key = backupKey(options.key, options.forbiddenKeys);
  let scratch;
  try {
    const auth = await authority(options, key),
      root = resolve(options.targetRoot);
    return await withRecoveryTargetLease(root, auth.manifest, async () => {
      const receipt = baseline(root, auth, key);
      assertInitialTarget(root, auth, receipt);
      need(
        !existsSync(join(root, finalizationDirectory)) &&
          !existsSync(join(root, sourcePreparationFile)),
        "finalization_already_started",
      );
      scratch = mkdtempSync(join(dirname(options.archivePath), ".finalize-plan-"));
      const plannedAt = auth.now,
        policy = currentRecoverySchemaPolicy(),
        guilds = [];
      for (const entry of auth.manifest.guilds) {
        const path = join(root, entry.databasePath),
          db = new DatabaseSync(path, { readOnly: true });
        let original, before;
        try {
          verifySchema(schemaOf(db, "guild"), policy.guild);
          original = inspectRestoredInstallation(
            db,
            entry.guildId,
            auth.capture.journal,
            plannedAt,
          );
          before = logicalDatabaseDigest(db);
        } finally {
          db.close();
        }
        const current = auth.capture.coldPair.active.find((row) => row.guildId === entry.guildId);
        if (original.disposition === "keep")
          need(
            current && current.epoch === original.epoch && current.through === original.sequence,
            "cold_snapshot_counter_or_epoch_mismatch",
          );
        const guild = {
          ...entry,
          original,
          before,
          newEpoch: original.disposition === "keep" ? randomUUID() : null,
        };
        if (guild.original.disposition === "keep") {
          const transformed = await transformGuild(
            path,
            join(scratch, entry.guildId + ".sqlite"),
            guild,
            auth,
            plannedAt,
            async () => {},
          );
          guild.after = transformed.logicalSha256;
          guild.history = transformed.history;
        }
        guilds.push(guild);
      }
      need(
        auth.capture.journal.active.every((active) =>
          guilds.some(
            (guild) =>
              guild.guildId === active.guildId &&
              guild.original.disposition === "keep" &&
              guild.original.epoch === active.epoch,
          ),
        ),
        "post_backup_active_installation_requires_reconstruction",
      );
      const retired = auth.capture.journal.retired
          .filter(
            (row) => !auth.capture.journal.active.some((active) => active.guildId === row.guildId),
          )
          .map((row) => row.guildId),
        shared = [];
      for (const file of auth.manifest.files.filter((file) => ["hub", "web"].includes(file.kind))) {
        const after = await transformShared(
          join(root, file.path),
          join(scratch, file.kind + ".sqlite"),
          file.kind,
          retired,
        );
        shared.push({ path: file.path, kind: file.kind, after });
      }
      const removed = auth.manifest.files
        .filter(
          (file) =>
            file.guildId &&
            guilds.some(
              (guild) => guild.guildId === file.guildId && guild.original.disposition === "purge",
            ),
        )
        .map((file) => file.path);
      const plan = {
        format: 1,
        kind: "gildiusz-controlled-cold-finalization",
        plannedAt,
        expiresAt: Math.min(
          auth.meta.expiresAt,
          auth.manifest.createdAt + maximumRecoveryArchiveAgeMs,
        ),
        sourceId: auth.capture.journal.sourceId,
        capturedSequence: auth.capture.journal.sequence,
        newSequence: auth.capture.journal.sequence + 1,
        archiveId: auth.manifest.id,
        archiveSha256: auth.archiveSha256,
        captureSha256: auth.captureSha256,
        requirementsSha256: auth.requirementsSha256,
        rootIdentity: receipt.rootIdentity,
        baselineSha256: hashFile(join(root, coldRestoreReceiptFile)).sha256,
        files: receipt.files,
        guilds,
        retired,
        shared,
        removed,
        webDataDisposition: "discard_all",
        automaticResume: false,
      };
      assertInitialTarget(root, auth, receipt);
      return { plan, sha256: digest(JSON.stringify(plan)), activationAllowed: false };
    });
  } finally {
    key.fill(0);
    if (scratch) {
      need(
        dirname(resolve(scratch)) === dirname(resolve(options.archivePath)) &&
          dirname(scratch) === dirname(options.archivePath) &&
          lstatSync(scratch).isDirectory() &&
          !lstatSync(scratch).isSymbolicLink(),
        "finalization_scratch_identity_changed",
      );
      rmSync(scratch, { recursive: true });
    }
  }
}

function assertPlanBinding(plan, root, auth, receipt) {
  need(
    plan?.format === 1 &&
      plan.kind === "gildiusz-controlled-cold-finalization" &&
      plan.archiveId === auth.manifest.id &&
      plan.archiveSha256 === auth.archiveSha256 &&
      plan.captureSha256 === auth.captureSha256 &&
      plan.requirementsSha256 === auth.requirementsSha256 &&
      same(plan.rootIdentity, physicalIdentity(root)) &&
      plan.baselineSha256 === hashFile(join(root, coldRestoreReceiptFile)).sha256 &&
      same(plan.files, receipt.files) &&
      plan.sourceId === auth.capture.journal.sourceId &&
      plan.capturedSequence === auth.capture.journal.sequence &&
      plan.newSequence === plan.capturedSequence + 1 &&
      plan.plannedAt >= auth.capture.createdAt &&
      plan.plannedAt <= auth.now &&
      plan.expiresAt <= auth.meta.expiresAt &&
      plan.expiresAt <= auth.manifest.createdAt + maximumRecoveryArchiveAgeMs &&
      auth.now < plan.expiresAt &&
      plan.automaticResume === false &&
      plan.webDataDisposition === "discard_all",
    "finalization_plan_binding_mismatch",
  );
}
function validateInitialPlan(plan, root, auth) {
  need(
    Array.isArray(plan.guilds) && plan.guilds.length === auth.manifest.guilds.length,
    "invalid_finalization_guild_inventory",
  );
  const epochs = new Set();
  for (const entry of auth.manifest.guilds) {
    const guild = plan.guilds.find((guild) => guild.guildId === entry.guildId);
    need(
      guild && Object.entries(entry).every(([name, value]) => guild[name] === value),
      "finalization_guild_scope_changed",
    );
    const db = new DatabaseSync(join(root, entry.databasePath), { readOnly: true });
    try {
      need(
        same(
          inspectRestoredInstallation(db, entry.guildId, auth.capture.journal, plan.plannedAt),
          guild.original,
        ) && logicalDatabaseDigest(db) === guild.before,
        "finalization_original_lineage_changed",
      );
    } finally {
      db.close();
    }
    if (guild.original.disposition === "keep") {
      const current = auth.capture.coldPair.active.find((row) => row.guildId === guild.guildId);
      need(
        current &&
          current.epoch === guild.original.epoch &&
          current.through === guild.original.sequence &&
          /^[a-f0-9-]{36}$/.test(guild.newEpoch) &&
          guild.newEpoch !== guild.original.epoch &&
          !epochs.has(guild.newEpoch),
        "invalid_finalization_epoch",
      );
      epochs.add(guild.newEpoch);
    } else need(guild.newEpoch === null, "invalid_finalization_purge");
  }
  need(
    auth.capture.journal.active.every((active) =>
      plan.guilds.some(
        (guild) =>
          guild.guildId === active.guildId &&
          guild.original.disposition === "keep" &&
          guild.original.epoch === active.epoch,
      ),
    ),
    "post_backup_active_installation_requires_reconstruction",
  );
  const retired = auth.capture.journal.retired
      .filter(
        (row) => !auth.capture.journal.active.some((active) => active.guildId === row.guildId),
      )
      .map((row) => row.guildId),
    removed = auth.manifest.files
      .filter(
        (file) =>
          file.guildId &&
          plan.guilds.some(
            (guild) => guild.guildId === file.guildId && guild.original.disposition === "purge",
          ),
      )
      .map((file) => file.path),
    shared = auth.manifest.files
      .filter((file) => ["hub", "web"].includes(file.kind))
      .map(({ path, kind }) => ({ path, kind }));
  need(
    same(plan.retired, retired) &&
      same(plan.removed, removed) &&
      same(
        plan.shared.map(({ path, kind }) => ({ path, kind })),
        shared,
      ),
    "finalization_erasure_scope_changed",
  );
}
function finalRegistries(auth, plan) {
  const kept = auth.manifest.guilds.filter((guild) =>
    plan.guilds.some(
      (planned) => planned.guildId === guild.guildId && planned.original.disposition === "keep",
    ),
  );
  return [
    [
      "guilds.json",
      kept
        .filter((guild) => !guild.public)
        .map(({ guildId, ownerId, databasePath, configPath }) => ({
          guildId,
          ownerId,
          databasePath,
          configPath,
        })),
    ],
    [
      "public-guilds/installations.json",
      kept.filter((guild) => guild.public).map(({ guildId, ownerId }) => ({ guildId, ownerId })),
    ],
  ];
}
function assertOperationNames(directory, plan) {
  const allowed = new Set([
    "intent.json",
    "lineage-ready.json",
    "finalized.json",
    "retired-source-preparation.json",
    "retired-quarantine.json",
    "retired-web-quarantine.json",
  ]);
  for (const guild of plan.guilds.filter((guild) => guild.original.disposition === "keep"))
    for (const suffix of [
      "ready.json",
      "history.json",
      "sqlite",
      "sqlite-wal",
      "sqlite-shm",
      "sqlite-journal",
    ])
      allowed.add(`guild-${guild.guildId}.${suffix}`);
  for (const shared of plan.shared)
    for (const suffix of ["ready.json", "sqlite", "sqlite-wal", "sqlite-shm", "sqlite-journal"])
      allowed.add(`${shared.kind}.${suffix}`);
  for (const name of readdirSync(directory)) {
    need(
      allowed.has(name) || (name.endsWith(".recovery-tmp") && allowed.has(name.slice(0, -13))),
      "unknown_finalization_file",
    );
    regularFile(join(directory, name));
  }
}
function readySlot(path, expected, key) {
  const value = readSignedRecoveryDocument(path, key);
  need(
    value.kind === "gildiusz-cold-staged-database" &&
      value.slot === expected.slot &&
      value.planSha256 === expected.planSha256 &&
      value.path === expected.path &&
      value.staged === expected.staged &&
      value.logicalSha256 === expected.logicalSha256 &&
      /^[a-f0-9]{64}$/.test(value.sha256) &&
      Number.isSafeInteger(value.size) &&
      value.size > 0 &&
      value.identity &&
      Object.keys(value.identity).sort().join(",") === "dev,ino" &&
      /^\d+$/.test(value.identity.dev) &&
      /^\d+$/.test(value.identity.ino),
    "staging_receipt_slot_mismatch",
  );
  return value;
}
function allReadySlots(directory, plan, planSha256, key) {
  const values = [];
  for (const guild of plan.guilds.filter((guild) => guild.original.disposition === "keep"))
    values.push(
      readySlot(
        join(directory, `guild-${guild.guildId}.ready.json`),
        {
          slot: `guild:${guild.guildId}`,
          planSha256,
          path: guild.databasePath,
          staged: `guild-${guild.guildId}.sqlite`,
          logicalSha256: guild.after,
        },
        key,
      ),
    );
  for (const shared of plan.shared)
    values.push(
      readySlot(
        join(directory, `${shared.kind}.ready.json`),
        {
          slot: `shared:${shared.kind}`,
          planSha256,
          path: shared.path,
          staged: `${shared.kind}.sqlite`,
          logicalSha256: shared.after,
        },
        key,
      ),
    );
  need(
    new Set(values.map((entry) => entry.path)).size === values.length,
    "staged_database_coverage_mismatch",
  );
  return values;
}
function writePlannedFile(root, plan, path, body) {
  const destination = join(root, path);
  if (existsSync(destination)) {
    const current = hashFile(destination).sha256,
      initial = plan.files.find((file) => file.path === path)?.sha256;
    need(current === initial || current === digest(body), "planned_recovery_file_changed");
  }
  durableRecoveryWrite(destination, body);
}
function assertFinalInventory(root, auth, plan, ready, journalBody, preparation, key) {
  const expected = new Map(
    plan.files
      .filter((file) => !plan.removed.includes(file.path))
      .map((file) => [file.path, { sha256: file.sha256, identity: file.identity }]),
  );
  for (const entry of ready)
    expected.set(entry.path, { sha256: entry.sha256, identity: entry.identity });
  for (const [path, rows] of finalRegistries(auth, plan))
    if (auth.manifest.files.some((file) => file.path === path))
      expected.set(path, { sha256: digest(json(rows)) });
  expected.set("uninstall-retention/source-policy.json", {
    sha256: digest(
      json({
        format: 1,
        kind: "gildiusz-retention-source-policy",
        sourceId: plan.sourceId,
        minimumJournalFormat: 2,
      }),
    ),
  });
  expected.set("rules-acceptance-deletions/journal.json", { sha256: digest(journalBody) });
  expected.set(".rules-deletion-journal", { sha256: digest("") });
  if (existsSync(join(root, sourcePreparationFile)))
    expected.set(sourcePreparationFile, { sha256: digest(preparation) });
  if (!existsSync(join(root, restoreQuarantineFile))) {
    const completed = readSignedRecoveryDocument(
      join(root, finalizationDirectory, "finalized.json"),
      key,
    );
    need(completed.planSha256 === digest(JSON.stringify(plan)), "missing_finalization_guard");
    expected.delete(restoreQuarantineFile);
    for (const file of auth.manifest.files.filter((file) => file.kind === "web"))
      expected.delete(file.path + ".restore-quarantine.json");
  }
  const actual = recoveryTargetInventory(root, auth.manifest, true);
  need(actual.length === expected.size, "finalization_inventory_size_changed");
  for (const file of actual) {
    const wanted = expected.get(file.path);
    need(
      wanted &&
        file.sha256 === wanted.sha256 &&
        (!wanted.identity || same(file.identity, wanted.identity)),
      "finalization_inventory_changed",
    );
  }
}

export async function applyColdRecoveryFinalization(givenOptions) {
  const options = ownInputs(givenOptions);
  const key = backupKey(options.key, options.forbiddenKeys);
  try {
    const auth = await authority(options, key),
      root = resolve(options.targetRoot),
      plan = options.plan,
      planSha256 = digest(JSON.stringify(plan));
    need(options.approve === planSha256, "exact_finalization_approval_required");
    return await withRecoveryTargetLease(root, auth.manifest, async () => {
      const receipt = baseline(root, auth, key);
      assertPlanBinding(plan, root, auth, receipt);
      const directory = join(root, finalizationDirectory),
        intentPath = join(directory, "intent.json"),
        stage = (name) => options.onStage?.(name);
      if (!existsSync(directory) || !existsSync(intentPath)) {
        const residue = existsSync(directory);
        if (residue) {
          privateDirectory(directory);
          need(
            readdirSync(directory).every((name) => name === "intent.json.recovery-tmp"),
            "unknown_pre_intent_file",
          );
          for (const name of readdirSync(directory)) regularFile(join(directory, name));
        }
        assertInitialTarget(root, auth, receipt, residue);
        validateInitialPlan(plan, root, auth);
        privateDirectory(directory);
        need(
          readdirSync(directory).every((name) => name === "intent.json.recovery-tmp"),
          "unknown_pre_intent_file",
        );
        signedWrite(
          intentPath,
          { format: 1, kind: "gildiusz-cold-finalization-intent", planSha256 },
          key,
        );
        stage("intent_durable");
      } else {
        const intent = readSignedRecoveryDocument(intentPath, key);
        need(
          intent.kind === "gildiusz-cold-finalization-intent" && intent.planSha256 === planSha256,
          "another_finalization_intent",
        );
      }
      assertOperationNames(directory, plan);
      if (!existsSync(join(root, restoreQuarantineFile))) {
        const completed = readSignedRecoveryDocument(join(directory, "finalized.json"), key);
        need(
          completed.kind === "gildiusz-cold-finalization-complete" &&
            completed.planSha256 === planSha256 &&
            completed.sourceId === plan.sourceId &&
            completed.sequence === plan.newSequence,
          "missing_finalization_guard",
        );
        need(
          !auth.manifest.files.some(
            (file) =>
              file.kind === "web" && existsSync(join(root, file.path + ".restore-quarantine.json")),
          ),
          "terminal_web_quarantine_present",
        );
        need(
          !existsSync(join(root, sourcePreparationFile)),
          "terminal_recovery_preparation_guard_present",
        );
        const journalBody = readFileSync(
            join(root, "rules-acceptance-deletions/journal.json"),
            "utf8",
          ),
          ready = allReadySlots(directory, plan, planSha256, key);
        need(digest(journalBody) === completed.journalSha256, "finalized_source_has_advanced");
        assertFinalInventory(root, auth, plan, ready, journalBody, "", key);
        return {
          state: "controlled_cold_finalization_complete",
          sourceId: completed.sourceId,
          sequence: completed.sequence,
          activationAllowed: true,
          automaticResume: false,
          unknownWorkRequeued: false,
        };
      }
      for (const file of auth.manifest.files.filter((file) => file.kind === "web")) {
        const peerPath = join(root, file.path + ".restore-quarantine.json"),
          retired = join(directory, "retired-web-quarantine.json"),
          expected = plan.files.find(
            (entry) => entry.path === file.path + ".restore-quarantine.json",
          );
        need(expected, "cold_restore_web_guard_not_bound");
        if (!existsSync(peerPath)) {
          need(
            existsSync(retired) &&
              hashFile(retired).sha256 === expected.sha256 &&
              same(physicalIdentity(retired), expected.identity),
            "restore_web_quarantine_missing",
          );
          renameSync(retired, peerPath);
          syncDirectory(dirname(peerPath));
          syncDirectory(directory);
        }
      }
      const preparation = json({ format: 1, kind: "gildiusz-cold-finalization", planSha256 });
      if (existsSync(join(root, sourcePreparationFile)))
        need(
          readFileSync(join(root, sourcePreparationFile), "utf8") === preparation,
          "another_source_preparation",
        );
      else if (existsSync(join(root, restoreQuarantineFile)))
        durableRecoveryWrite(join(root, sourcePreparationFile), preparation);
      stage("preparation_guard_durable");
      const ready = [];
      for (const guild of plan.guilds.filter((guild) => guild.original.disposition === "keep")) {
        const readyPath = join(directory, `guild-${guild.guildId}.ready.json`),
          staged = join(directory, `guild-${guild.guildId}.sqlite`);
        const slot = {
          slot: `guild:${guild.guildId}`,
          planSha256,
          path: guild.databasePath,
          staged: `guild-${guild.guildId}.sqlite`,
          logicalSha256: guild.after,
        };
        if (!existsSync(readyPath)) {
          const original = new DatabaseSync(join(root, guild.databasePath), { readOnly: true });
          try {
            need(logicalDatabaseDigest(original) === guild.before, "unstaged_guild_changed");
          } finally {
            original.close();
          }
          for (const path of [staged + "-wal", staged + "-shm", staged])
            if (existsSync(path)) {
              regularFile(path);
              unlinkSync(path);
            }
          const result = await transformGuild(
            join(root, guild.databasePath),
            staged,
            guild,
            auth,
            plan.plannedAt,
            async (history) => {
              need(same(history, guild.history), "recovery_retention_history_changed");
              signedWrite(
                join(directory, `guild-${guild.guildId}.history.json`),
                { planSha256, guildId: guild.guildId, history },
                key,
              );
              stage(`history_durable:${guild.guildId}`);
            },
          );
          need(result.logicalSha256 === guild.after, "staged_guild_result_changed");
          signedWrite(
            readyPath,
            {
              kind: "gildiusz-cold-staged-database",
              ...slot,
              identity: physicalIdentity(staged),
              ...hashFile(staged),
            },
            key,
          );
          stage(`guild_ready:${guild.guildId}`);
        }
        ready.push(readySlot(readyPath, slot, key));
      }
      for (const shared of plan.shared) {
        const readyPath = join(directory, `${shared.kind}.ready.json`),
          staged = join(directory, `${shared.kind}.sqlite`);
        const slot = {
          slot: `shared:${shared.kind}`,
          planSha256,
          path: shared.path,
          staged: `${shared.kind}.sqlite`,
          logicalSha256: shared.after,
        };
        if (!existsSync(readyPath)) {
          for (const path of [staged + "-wal", staged + "-shm", staged])
            if (existsSync(path)) {
              regularFile(path);
              unlinkSync(path);
            }
          need(
            (await transformShared(join(root, shared.path), staged, shared.kind, plan.retired)) ===
              shared.after,
            "staged_shared_result_changed",
          );
          signedWrite(
            readyPath,
            {
              kind: "gildiusz-cold-staged-database",
              ...slot,
              identity: physicalIdentity(staged),
              ...hashFile(staged),
            },
            key,
          );
          stage(`${shared.kind}_ready`);
        }
        ready.push(readySlot(readyPath, slot, key));
      }
      need(
        new Set(ready.map((entry) => entry.path)).size === ready.length &&
          ready.length ===
            plan.guilds.filter((guild) => guild.original.disposition === "keep").length +
              plan.shared.length,
        "staged_database_coverage_mismatch",
      );
      const active = plan.guilds
          .filter((guild) => guild.original.disposition === "keep")
          .map((guild) => ({
            guildId: guild.guildId,
            path: guild.databasePath,
            epoch: guild.newEpoch,
            through: guild.history.through,
            fileIdentity: ready.find((entry) => entry.path === guild.databasePath).identity,
          })),
        journal = recoveredLifecycleJournal(
          auth.capture.journal,
          active,
          plan.guilds.flatMap((guild) => guild.history?.entries ?? []),
          plan.plannedAt,
        ),
        journalBody = json(journal);
      signedWrite(
        join(directory, "lineage-ready.json"),
        { planSha256, journalSha256: digest(journalBody), journal },
        key,
      );
      stage("lineage_history_durable");
      for (const entry of ready) {
        need(entry.planSha256 === planSha256, "staging_receipt_plan_mismatch");
        const destination = join(root, entry.path),
          staged = join(directory, entry.staged);
        if (existsSync(staged)) {
          need(
            same(hashFile(staged), { size: entry.size, sha256: entry.sha256 }) &&
              same(physicalIdentity(staged), entry.identity),
            "staged_database_changed",
          );
          const initial = plan.files.find((file) => file.path === entry.path);
          need(
            same(physicalIdentity(destination), initial.identity) &&
              hashFile(destination).sha256 === initial.sha256,
            "target_database_changed_before_swap",
          );
          renameSync(staged, destination);
          syncDirectory(dirname(destination));
          syncDirectory(directory);
          stage(`database_swapped:${entry.path}`);
        } else
          need(
            same(physicalIdentity(destination), entry.identity) &&
              hashFile(destination).sha256 === entry.sha256,
            "swapped_database_identity_changed",
          );
      }
      for (const path of plan.removed) {
        const destination = join(root, path),
          original = plan.files.find((file) => file.path === path);
        if (existsSync(destination)) {
          need(
            original &&
              same(physicalIdentity(destination), original.identity) &&
              hashFile(destination).sha256 === original.sha256,
            "purged_guild_file_changed",
          );
          unlinkSync(destination);
          syncDirectory(dirname(destination));
          stage(`guild_file_removed:${path}`);
        }
      }
      for (const [path, rows] of finalRegistries(auth, plan)) {
        if (auth.manifest.files.some((file) => file.path === path)) {
          writePlannedFile(root, plan, path, json(rows));
          stage(`registry_written:${path}`);
        }
      }
      writePlannedFile(
        root,
        plan,
        "uninstall-retention/source-policy.json",
        json({
          format: 1,
          kind: "gildiusz-retention-source-policy",
          sourceId: journal.sourceId,
          minimumJournalFormat: 2,
        }),
      );
      stage("source_policy_durable");
      writePlannedFile(root, plan, "rules-acceptance-deletions/journal.json", journalBody);
      if (!existsSync(join(root, ".rules-deletion-journal")))
        durableRecoveryWrite(join(root, ".rules-deletion-journal"), "");
      stage("source_journal_durable");
      for (const guild of plan.guilds.filter((guild) => guild.original.disposition === "keep")) {
        const db = new DatabaseSync(join(root, guild.databasePath), { readOnly: true });
        try {
          assertIntegrity(db);
          need(logicalDatabaseDigest(db) === guild.after, "final_guild_verification_failed");
          assertCoreQuarantined(db, guild.guildId);
        } finally {
          db.close();
        }
      }
      for (const shared of plan.shared) {
        const db = new DatabaseSync(join(root, shared.path), { readOnly: true });
        try {
          assertIntegrity(db);
          need(logicalDatabaseDigest(db) === shared.after, "final_shared_verification_failed");
          if (shared.kind === "web") assertRestoredWebEmpty(db);
          else assertHubQuarantined(db);
        } finally {
          db.close();
        }
      }
      need(
        !readdirSync(directory).some(
          (name) =>
            name.endsWith(".sqlite") ||
            name.endsWith(".sqlite-wal") ||
            name.endsWith(".sqlite-shm") ||
            name.endsWith(".recovery-tmp"),
        ),
        "unconsumed_staged_database",
      );
      await authority({ ...options, now: options.now ?? Date.now() }, key);
      assertOperationNames(directory, plan);
      assertFinalInventory(root, auth, plan, ready, journalBody, preparation, key);
      signedWrite(
        join(directory, "finalized.json"),
        {
          format: 1,
          kind: "gildiusz-cold-finalization-complete",
          planSha256,
          sourceId: journal.sourceId,
          capturedSequence: plan.capturedSequence,
          sequence: journal.sequence,
          coveredFrom: journal.coveredFrom,
          journalSha256: digest(journalBody),
          active,
          originalManifestSha256: digest(JSON.stringify(auth.manifest)),
          automaticResume: false,
        },
        key,
      );
      stage("final_receipt_durable");
      for (const guild of plan.guilds.filter((guild) => guild.original.disposition === "keep")) {
        const path = join(directory, `guild-${guild.guildId}.history.json`);
        if (existsSync(path)) {
          const record = readSignedRecoveryDocument(path, key);
          need(
            record.planSha256 === planSha256 &&
              record.guildId === guild.guildId &&
              same(record.history, guild.history),
            "recovery_history_cleanup_mismatch",
          );
          unlinkSync(path);
          syncDirectory(directory);
        }
      }
      const stagedHistory = join(directory, "lineage-ready.json");
      if (existsSync(stagedHistory)) {
        const record = readSignedRecoveryDocument(stagedHistory, key);
        need(
          record.planSha256 === planSha256 &&
            record.journalSha256 === digest(journalBody) &&
            same(record.journal, journal),
          "recovery_lineage_cleanup_mismatch",
        );
        unlinkSync(stagedHistory);
        syncDirectory(directory);
      }
      stage("staging_history_cleaned");
      if (existsSync(join(root, sourcePreparationFile))) {
        renameSync(
          join(root, sourcePreparationFile),
          join(directory, "retired-source-preparation.json"),
        );
        syncDirectory(root);
        syncDirectory(directory);
      }
      stage("preparation_guard_retired");
      for (const file of auth.manifest.files.filter((file) => file.kind === "web")) {
        const path = join(root, file.path + ".restore-quarantine.json"),
          expected = plan.files.find(
            (entry) => entry.path === file.path + ".restore-quarantine.json",
          );
        need(
          expected &&
            hashFile(path).sha256 === expected.sha256 &&
            same(physicalIdentity(path), expected.identity),
          "restore_web_quarantine_changed",
        );
        renameSync(path, join(directory, "retired-web-quarantine.json"));
        syncDirectory(dirname(path));
        syncDirectory(directory);
      }
      stage("web_quarantine_retired");
      if (existsSync(join(root, restoreQuarantineFile))) {
        renameSync(join(root, restoreQuarantineFile), join(directory, "retired-quarantine.json"));
        syncDirectory(root);
        syncDirectory(directory);
      }
      stage("quarantine_retired");
      return {
        state: "controlled_cold_finalization_complete",
        sourceId: journal.sourceId,
        sequence: journal.sequence,
        activationAllowed: true,
        automaticResume: false,
        unknownWorkRequeued: false,
      };
    });
  } finally {
    key.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = process.argv[2],
      values = {},
      args = process.argv.slice(3);
    for (let i = 0; i < args.length; i += 2) {
      need(
        /^--[a-z-]+$/.test(args[i]) && args[i + 1] && !Object.hasOwn(values, args[i].slice(2)),
        "invalid_finalization_arguments",
      );
      values[args[i].slice(2)] = args[i + 1];
    }
    const { configuredSnapshot, recoveryCredentials } = await import("./recovery.mjs");
    let result;
    if (command === "prepare") {
      need(
        Object.keys(values).sort().join(",") === "archive,capture,challenge",
        "use_archive_capture_challenge",
      );
      result = await createColdRecoveryPair({
        ...configuredSnapshot(resolve(values.archive)),
        capturePath: resolve(values.capture),
        challenge: values.challenge,
      });
    } else {
      const expected =
        command === "restore"
          ? "archive,capture,requirements,target"
          : command === "plan"
            ? "archive,capture,output,requirements,target"
            : "approve,archive,capture,plan,requirements,target";
      need(
        ["restore", "plan", "apply"].includes(command) &&
          Object.keys(values).sort().join(",") === expected,
        "invalid_finalization_arguments",
      );
      const options = {
        archivePath: resolve(values.archive),
        capturePath: resolve(values.capture),
        targetRoot: resolve(values.target),
        requirements: readPrivateRecoveryJson(resolve(values.requirements), 4096),
        ...recoveryCredentials(process.env),
      };
      if (command === "restore") result = await restoreColdRecoveryTarget(options);
      else if (command === "plan") {
        result = await planColdRecoveryFinalization(options);
        durableRecoveryWrite(resolve(values.output), json(result.plan));
        result = {
          state: "cold_finalization_plan_ready",
          path: resolve(values.output),
          sha256: result.sha256,
          activationAllowed: false,
        };
      } else
        result = await applyColdRecoveryFinalization({
          ...options,
          plan: readPrivateRecoveryJson(resolve(values.plan)),
          approve: values.approve,
        });
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      JSON.stringify({ code: error.code ?? error.message ?? "cold_finalization_refused" }),
    );
    process.exitCode = 1;
  }
}
