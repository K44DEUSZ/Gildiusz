import {
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  backupKey,
  decryptArchive,
  encryptArchive,
  manifestLimit,
} from "../dist/storage/recovery/archive.js";
import {
  hashFile,
  privateDirectory,
  regularFile,
  withInput,
} from "../dist/storage/recovery/files.js";
import { restoreSnapshot } from "../dist/storage/recovery/snapshot.js";
import { parseRulesDeletionLifecycleJournal } from "../dist/storage/rules-deletion-lifecycle.js";
import { captureLatestDeletionRecoveryState, verifyLatestDeletionProof } from "./backup-proof.mjs";
import {
  withRecoverySourceLease,
  installColdSourceFence,
  assertRecoverySourceLease,
  ownedColdSourceFence,
} from "../dist/storage/recovery/source-lease.js";
import { createSnapshotWithSourceLease, planSnapshot } from "../dist/storage/recovery/snapshot.js";
import { withRecoveryRulesDeletionLifecycle } from "../dist/storage/rules-deletion-lifecycle.js";
import { JobStore } from "../dist/core/jobs/store.js";
import {
  currentRecoverySchemaPolicy,
  schemaOf,
  verifySchema,
} from "../dist/storage/recovery/schema.js";
import { logicalDatabaseDigest } from "../dist/storage/recovery/finalize-lineage.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function input(path, maximum) {
  need(isAbsolute(path), "absolute_capture_path_required");
  // Verification is read-only: inspect existing parents before validating their privacy.
  regularFile(path);
  privateDirectory(dirname(path));
  return withInput(path, (fd, size) => {
    const stat = fstatSync(fd);
    need(
      size > 0 &&
        size <= maximum &&
        realpathSync(path) === path &&
        (process.platform === "win32" || (stat.uid === process.getuid() && !(stat.mode & 0o077))),
      "unsafe_capture_input",
    );
    const value = Buffer.alloc(size);
    try {
      let offset = 0;
      while (offset < size) {
        const count = readSync(fd, value, offset, size - offset, offset);
        need(count > 0, "capture_input_changed");
        offset += count;
      }
      const after = fstatSync(fd),
        current = lstatSync(path);
      need(
        ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(
          (key) => stat[key] === after[key] && stat[key] === current[key],
        ),
        "capture_input_changed",
      );
      return value;
    } catch (error) {
      value.fill(0);
      throw error;
    }
  });
}
function outside(source, target) {
  const tail = relative(source, target);
  need(
    tail && (tail === ".." || tail.startsWith(".." + sep) || isAbsolute(tail)),
    "capture_output_inside_source",
  );
}
function archiveIdentity(manifest, file) {
  return { id: manifest.id, createdAt: manifest.createdAt, sha256: file.sha256, size: file.size };
}
function validateCapture(value, requirements, key, now) {
  if (value?.format === 2) {
    need(
      exact(value, [
        "format",
        "kind",
        "id",
        "createdAt",
        "archive",
        "journal",
        "proof",
        "captureBoundary",
        "activationAllowed",
        "coldPair",
      ]),
      "invalid_cold_recovery_capture",
    );
    const cold = value.coldPair;
    need(
      exact(cold, [
        "operationId",
        "fence",
        "snapshotCompletedAt",
        "manifestGuildsSha256",
        "active",
        "sourceState",
        "webDataDisposition",
      ]) &&
        uuid.test(cold.operationId) &&
        exact(cold.fence, ["body", "sha256"]) &&
        typeof cold.fence.body === "string" &&
        cold.fence.body.length <= 1024 * 1024 &&
        hash(Buffer.from(cold.fence.body)) === cold.fence.sha256 &&
        Number.isSafeInteger(cold.snapshotCompletedAt) &&
        cold.snapshotCompletedAt >= value.archive.createdAt &&
        cold.snapshotCompletedAt <= value.createdAt &&
        digest.test(cold.manifestGuildsSha256) &&
        cold.webDataDisposition === "discard_all" &&
        Array.isArray(cold.active) &&
        cold.active.length <= 1000 &&
        Array.isArray(cold.sourceState) &&
        cold.sourceState.length <= 1001,
      "invalid_cold_recovery_capture",
    );
    const fence = JSON.parse(cold.fence.body);
    need(
      exact(fence, [
        "format",
        "kind",
        "operationId",
        "installedAt",
        "compatibilityGuard",
        "sourceRoot",
        "webDatabasePath",
        "rootIdentity",
        "databases",
      ]) &&
        fence.format === 2 &&
        fence.compatibilityGuard === "source-preparation.json" &&
        (fence.webDatabasePath === null || isAbsolute(fence.webDatabasePath)) &&
        fence.kind === "gildiusz-controlled-cold-source" &&
        fence.operationId === cold.operationId &&
        isAbsolute(fence.sourceRoot) &&
        Number.isSafeInteger(fence.installedAt) &&
        fence.installedAt <= value.archive.createdAt,
      "invalid_cold_source_fence",
    );
    const sourcePaths = new Set();
    for (const row of cold.sourceState) {
      need(
        exact(row, ["path", "kind", "logicalSha256"]) &&
          isAbsolute(row.path) &&
          ["guild", "hub"].includes(row.kind) &&
          digest.test(row.logicalSha256) &&
          !sourcePaths.has(row.path) &&
          fence.databases.some((file) => file.path === row.path),
        "invalid_cold_source_state",
      );
      sourcePaths.add(row.path);
    }
    const checked = validateCapture(
      {
        ...Object.fromEntries(Object.entries(value).filter(([name]) => name !== "coldPair")),
        format: 1,
      },
      requirements,
      key,
      now,
    );
    need(
      cold.active.length === checked.capture.journal.active.length,
      "cold_active_inventory_mismatch",
    );
    const seen = new Set();
    for (const row of cold.active) {
      need(
        exact(row, [
          "guildId",
          "ownerId",
          "public",
          "sourcePath",
          "epoch",
          "admittedAt",
          "through",
          "configSha256",
        ]) &&
          /^\d{17,20}$/.test(row.guildId) &&
          /^\d{17,20}$/.test(row.ownerId) &&
          typeof row.public === "boolean" &&
          !seen.has(row.guildId) &&
          (row.public ? row.configSha256 === null : digest.test(row.configSha256)),
        "invalid_cold_active_inventory",
      );
      seen.add(row.guildId);
      const active = checked.capture.journal.active.find((entry) => entry.guildId === row.guildId);
      need(
        active &&
          row.sourcePath === active.path &&
          row.epoch === active.epoch &&
          row.through === active.through &&
          row.admittedAt === active.admittedAt,
        "cold_active_inventory_mismatch",
      );
    }
    return { ...checked, capture: value };
  }
  need(
    exact(value, [
      "format",
      "kind",
      "id",
      "createdAt",
      "archive",
      "journal",
      "proof",
      "captureBoundary",
      "activationAllowed",
    ]) &&
      value.format === 1 &&
      value.kind === "gildiusz-manual-recovery-capture" &&
      uuid.test(value.id) &&
      Number.isSafeInteger(value.createdAt) &&
      value.createdAt <= now &&
      value.activationAllowed === false &&
      value.captureBoundary === "root_and_guild_leases_held_during_capture_only" &&
      exact(value.archive, ["id", "createdAt", "sha256", "size"]) &&
      uuid.test(value.archive.id) &&
      Number.isSafeInteger(value.archive.createdAt) &&
      value.archive.createdAt <= value.createdAt &&
      Number.isSafeInteger(value.archive.size) &&
      value.archive.size > 0 &&
      digest.test(value.archive.sha256) &&
      typeof value.proof === "string" &&
      value.proof.length <= 6 * 1024 * 1024 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value.proof),
    "invalid_recovery_capture",
  );
  need(
    value.archive.id === requirements.backupId &&
      value.archive.sha256 === requirements.archiveSha256,
    "capture_archive_mismatch",
  );
  const proofBytes = Buffer.from(value.proof, "base64");
  need(proofBytes.toString("base64") === value.proof, "invalid_capture_proof_encoding");
  const result = verifyLatestDeletionProof({
    envelope: proofBytes,
    key,
    now,
    ...requirements.proof,
  });
  const proof = result.proof,
    journal = parseRulesDeletionLifecycleJournal(value.journal);
  need(
    value.createdAt === proof.createdAt &&
      journal.sourceId === proof.sourceId &&
      journal.sequence === proof.sequence &&
      journal.coveredFrom === proof.coveredFrom &&
      journal.updatedAt <= proof.createdAt &&
      journal.globalGap === null &&
      journal.admitting.length === 0 &&
      journal.retiring.length === 0 &&
      same(journal.entries, proof.acceptances) &&
      same(
        journal.active.map((entry) => entry.guildId),
        proof.guildIds,
      ) &&
      same(
        journal.retired.map(({ guildId, removedAt, purgedAt, outcome }) => ({
          format: 1,
          guildId,
          removedAt,
          purgedAt,
          outcome,
        })),
        proof.guilds,
      ) &&
      value.archive.createdAt >= proof.coveredFrom,
    "capture_journal_proof_mismatch",
  );
  return { capture: value, proof, meta: result.meta };
}
function requirementsValid(value) {
  need(
    exact(value, ["backupId", "archiveSha256", "proof"]) &&
      uuid.test(value.backupId) &&
      digest.test(value.archiveSha256) &&
      exact(value.proof, [
        "expectedSourceId",
        "minSequence",
        "notBefore",
        "challenge",
        "maxAgeMs",
      ]) &&
      uuid.test(value.proof.expectedSourceId) &&
      uuid.test(value.proof.challenge) &&
      Number.isSafeInteger(value.proof.minSequence) &&
      value.proof.minSequence > 0 &&
      Number.isSafeInteger(value.proof.notBefore) &&
      value.proof.notBefore >= 0,
    "independent_capture_requirements_required",
  );
}

/** Explicit manual operation. The capsule authenticates the complete lifecycle journal with its proof. */
export async function createRecoveryCapture(options) {
  return createCapture(options);
}

async function createCapture(options, coldPair) {
  const {
    dataRoot,
    installations,
    archivePath,
    outputPath,
    key,
    forbiddenKeys = [],
    challenge,
  } = options;
  need(
    isAbsolute(dataRoot) &&
      isAbsolute(archivePath) &&
      isAbsolute(outputPath) &&
      uuid.test(challenge),
    "invalid_capture_paths",
  );
  const root = resolve(dataRoot),
    parent = dirname(outputPath);
  // Reject an absent source or an output inside it before creating any directories.
  const sourceState = lstatSync(root);
  need(sourceState.isDirectory() && !sourceState.isSymbolicLink(), "unsafe_capture_source");
  outside(root, parent);
  outside(root, archivePath);
  need(outputPath !== archivePath, "capture_output_is_archive");
  privateDirectory(root);
  privateDirectory(parent);
  regularFile(archivePath);
  privateDirectory(dirname(archivePath));
  need(
    realpathSync(root) === root && realpathSync(parent) === parent && !existsSync(outputPath),
    "capture_output_exists_or_unsafe",
  );
  const master = backupKey(key, forbiddenKeys);
  let scratch;
  try {
    const archiveBefore = hashFile(archivePath);
    // The normal restore verifier authenticates the actual manual backup without creating a target.
    scratch = mkdtempSync(join(parent, ".capture-check-"));
    const manifest = await restoreSnapshot({
      archivePath,
      targetRoot: join(scratch, "unused"),
      key: master,
      dryRun: true,
    });
    need(same(hashFile(archivePath), archiveBefore), "capture_archive_changed");
    const captured = await captureLatestDeletionRecoveryState({
      dataRoot: root,
      installations,
      key: master,
      challenge,
      notBefore: Date.now(),
      ...(options.sourceLease ? { sourceLease: options.sourceLease } : {}),
    });
    const value = {
      format: coldPair ? 2 : 1,
      kind: "gildiusz-manual-recovery-capture",
      id: randomUUID(),
      createdAt: captured.meta.createdAt,
      archive: archiveIdentity(manifest, archiveBefore),
      journal: captured.recoveryJournal,
      proof: captured.envelope.toString("base64"),
      captureBoundary: "root_and_guild_leases_held_during_capture_only",
      activationAllowed: false,
      ...(coldPair ? { coldPair } : {}),
    };
    const requirements = {
      backupId: manifest.id,
      archiveSha256: archiveBefore.sha256,
      proof: {
        expectedSourceId: captured.meta.sourceId,
        minSequence: captured.meta.sequence,
        notBefore: captured.meta.createdAt,
        challenge,
        maxAgeMs: 86400000,
      },
    };
    validateCapture(value, requirements, master, Date.now());
    need(same(hashFile(archivePath), archiveBefore), "capture_archive_changed");
    encryptArchive(outputPath, value, [], master);
    return {
      format: 1,
      state: "manual_recovery_capture_created",
      path: outputPath,
      backupId: manifest.id,
      sourceId: captured.meta.sourceId,
      sequence: captured.meta.sequence,
      createdAt: captured.meta.createdAt,
      expiresAt: captured.meta.expiresAt,
      sha256: hashFile(outputPath).sha256,
      verificationRequirements: requirements,
      activationAllowed: false,
      writesAfterCaptureExcluded: false,
      automaticBackupScheduled: false,
    };
  } finally {
    master.fill(0);
    // Only this exact newly created private verification directory is disposable.
    if (scratch) {
      need(
        dirname(scratch) === parent && realpathSync(scratch) === scratch,
        "capture_scratch_changed",
      );
      rmSync(scratch, { recursive: true });
    }
  }
}

/** Creates a fresh archive and complete inventory under one real, durable writer fence. */
export async function createColdRecoveryPair(options) {
  const { capturePath, challenge, ...givenSnapshot } = options;
  const snapshot = Object.freeze({
    ...givenSnapshot,
    guilds: Object.freeze(givenSnapshot.guilds.map((row) => Object.freeze({ ...row }))),
  });
  need(
    uuid.test(challenge) && isAbsolute(capturePath) && !existsSync(capturePath),
    "invalid_cold_pair_output",
  );
  outside(resolve(snapshot.dataRoot), dirname(capturePath));
  outside(resolve(snapshot.dataRoot), snapshot.outputPath);
  need(capturePath !== snapshot.outputPath, "cold_pair_outputs_overlap");
  planSnapshot(snapshot);
  return withRecoverySourceLease(snapshot, async (sourceLease) => {
    const operationId = randomUUID(),
      databases = snapshot.guilds.map((row) => ({
        ...row,
        db: new DatabaseSync(row.databasePath),
      }));
    try {
      const policy = currentRecoverySchemaPolicy();
      for (const row of databases) verifySchema(schemaOf(row.db, "guild"), policy.guild);
      await withRecoveryRulesDeletionLifecycle(
        { dataRoot: snapshot.dataRoot, installations: snapshot.guilds, sourceLease },
        async (port) => {
          const stores = databases.map((row) => ({
            guildId: row.guildId,
            jobs: new JobStore(row.db),
          }));
          for (let batch = 0; batch <= 10; batch++) {
            const drained = await port.drainActiveOutbox({ stores, limit: 1000 });
            if (!drained.pending) break;
            need(batch < 10, "cold_pair_deletion_quota");
          }
          await port.pruneExpired();
          const scope = await port.snapshot();
          need(scope.complete && !scope.blockers.length, "cold_pair_source_incomplete");
        },
      );
      installColdSourceFence(sourceLease, operationId);
      const manifest = await createSnapshotWithSourceLease(snapshot, sourceLease),
        snapshotCompletedAt = Date.now(),
        active = [];
      for (const row of databases) {
        const marker = row.db
            .prepare(
              "SELECT id,baseline FROM resources WHERE key='retention.rules-deletion-installation'",
            )
            .get(),
          baseline = marker ? JSON.parse(marker.baseline) : null,
          counter = row.db
            .prepare(
              "SELECT sequence,journaled_through,gap_at FROM server_rules_deletion_state WHERE guild_id=?",
            )
            .get(row.guildId);
        need(
          marker &&
            baseline &&
            counter &&
            counter.sequence === counter.journaled_through &&
            counter.gap_at === null,
          "cold_pair_installation_incomplete",
        );
        const root = resolve(snapshot.dataRoot),
          sourcePath = relative(root, resolve(row.databasePath)).replaceAll("\\", "/");
        active.push({
          guildId: row.guildId,
          ownerId: row.ownerId,
          public: !!row.public,
          sourcePath,
          epoch: marker.id,
          admittedAt: baseline.admittedAt,
          through: counter.sequence,
          configSha256: row.public
            ? null
            : manifest.files.find((file) => file.path === `configuration/${row.guildId}.json`)
                ?.sha256,
        });
      }
      const sourceState = databases.map((row) => ({
        path: row.databasePath,
        kind: "guild",
        logicalSha256: logicalDatabaseDigest(row.db),
      }));
      if (snapshot.hubDatabasePath) {
        const hub = new DatabaseSync(snapshot.hubDatabasePath, { readOnly: true });
        try {
          sourceState.push({
            path: snapshot.hubDatabasePath,
            kind: "hub",
            logicalSha256: logicalDatabaseDigest(hub),
          });
        } finally {
          hub.close();
        }
      }
      const captured = await createCapture(
        {
          dataRoot: snapshot.dataRoot,
          installations: snapshot.guilds,
          archivePath: snapshot.outputPath,
          outputPath: capturePath,
          key: snapshot.key,
          forbiddenKeys: snapshot.forbiddenKeys,
          challenge,
          sourceLease,
        },
        {
          operationId,
          fence: ownedColdSourceFence(sourceLease),
          snapshotCompletedAt,
          manifestGuildsSha256: hash(Buffer.from(JSON.stringify(manifest.guilds))),
          active,
          sourceState,
          webDataDisposition: "discard_all",
        },
      );
      assertRecoverySourceLease(sourceLease, snapshot.dataRoot, snapshot.guilds);
      return {
        ...captured,
        format: 2,
        state: "controlled_cold_pair_created",
        sourceRemainsSealed: true,
        writerBoundary: "persistent_fence_for_cooperating_writers",
        cryptographicProofOfNoLaterWrites: false,
      };
    } finally {
      for (const row of databases) row.db.close();
    }
  });
}

/** Does not infer the trusted source or watermark from the candidate capsule itself. */
export function verifyRecoveryCapture({
  path,
  key,
  forbiddenKeys = [],
  requirements,
  now = Date.now(),
}) {
  requirementsValid(requirements);
  const envelope = input(path, manifestLimit + 65536),
    parent = privateDirectory(dirname(path));
  let scratch, master, plain;
  try {
    master = backupKey(key, forbiddenKeys);
    scratch = mkdtempSync(join(parent, ".capture-read-"));
    const plainPath = join(scratch, "plain");
    const identity = hash(envelope);
    decryptArchive(path, plainPath, master, 0);
    need(hash(input(path, manifestLimit + 65536)) === identity, "capture_input_changed");
    plain = input(plainPath, manifestLimit + 4);
    need(
      plain.length >= 6 && plain.readUInt32BE(0) === plain.length - 4,
      "invalid_capture_payload",
    );
    const value = JSON.parse(plain.subarray(4).toString("utf8"));
    return validateCapture(value, requirements, master, now);
  } finally {
    master?.fill(0);
    plain?.fill(0);
    envelope.fill(0);
    if (scratch) {
      need(
        dirname(scratch) === parent && realpathSync(scratch) === scratch,
        "capture_scratch_changed",
      );
      rmSync(scratch, { recursive: true });
    }
  }
}
