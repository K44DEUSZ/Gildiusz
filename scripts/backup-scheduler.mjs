import { closeSync, existsSync, lstatSync, openSync, readSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { configuredSnapshot, recoveryCommand, recoveryCredentials } from "./recovery.mjs";
import { deploymentPause, startSupervisor, stopSupervisor, pendingUpgrade } from "./hosting.mjs";
import { sealLatestDeletionProof, verifyLatestDeletionProof } from "./backup-proof.mjs";
import { privateDirectory, regularFile, syncDirectory } from "../dist/storage/recovery/files.js";
import { archiveIdentity, BackupCatalog, backupFailure, backupDayMs } from "./backup-catalog.mjs";
import {
  collectArchive,
  pruneCollectedDeletionProofs,
  verifyTransferProof,
} from "./backup-collector.mjs";
import {
  validateOffsiteTransfer,
  verifyOffsiteAck,
  readOffsiteFile,
  writeOffsiteFile,
} from "./backup-offsite.mjs";
import { readDeletionState } from "./backup-deletion-state.mjs";

export function planDailyBackup(entries, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) backupFailure("invalid_backup_clock");
  const day = new Date(now).toISOString().slice(0, 10);
  const current = entries
    .filter(
      (entry) =>
        entry.state === "verified" &&
        entry.createdAt <= now &&
        new Date(entry.createdAt).toISOString().slice(0, 10) === day,
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    due: !current,
    utcDay: day,
    existingId: current?.id ?? null,
    nextUtcDayAt: Date.parse(day + "T00:00:00.000Z") + backupDayMs,
  };
}

/** Caller holds one deployment lock. Only this operation's pause may be released. */
export async function captureStoppedBackup({
  snapshotPort,
  lifecyclePort,
  outputPath,
  afterSealed,
}) {
  await snapshotPort.preflight({ outputPath });
  const pause = await lifecyclePort.pause();
  let stopped = false;
  try {
    stopped = true;
    await lifecyclePort.stop();
    const manifest = await snapshotPort.create({ outputPath });
    // This port also takes the data-root lease; it must run before writer resumption.
    const sealedLedger = snapshotPort.sealLatestProof
      ? await snapshotPort.sealLatestProof({ manifest })
      : await snapshotPort.sealLatestLedger();
    if (afterSealed) await afterSealed({ manifest, sealedLedger });
    return { manifest, sealedLedger };
  } finally {
    if (pause?.owned) {
      // A changed/manual pause refuses release and therefore also prevents restart.
      await pause.release();
      if (stopped) await lifecyclePort.resume();
    }
  }
}

export async function runDailyBackup({
  catalog,
  snapshotPort,
  lifecyclePort,
  key,
  forbiddenKeys,
  revision = null,
  signal,
}) {
  const pending = lifecyclePort.hasPendingUpgrade?.() ?? false;
  if (typeof pending !== "boolean") backupFailure("backup_pending_reconciliation_required");
  const pruned = await pruneCollectedDeletionProofs({ catalog, key, forbiddenKeys });
  if (pending)
    return {
      state: "deferred_pending_upgrade",
      retentionBlocked: pruned.blocked,
      offsiteSuccess: false,
    };
  const location = await catalog.inspectLocation();
  if (!location.complete) backupFailure("backup_reconciliation_required");
  const state = await catalog.read();
  const plan = planDailyBackup(state.entries, catalog.clock());
  if (!plan.due) return { state: "not_due", ...plan };
  const outputPath = join(catalog.captures, `${randomUUID()}.gldbak`);
  const sealed = await captureStoppedBackup({ snapshotPort, lifecyclePort, outputPath });
  const identity = await archiveIdentity(outputPath);
  const collected = await collectArchive({
    catalog,
    expected: { ...identity, id: sealed.manifest.id, createdAt: sealed.manifest.createdAt },
    existingArchivePath: outputPath,
    key,
    forbiddenKeys,
    ...(sealed.sealedLedger.meta?.format === 2
      ? {
          latestProof: sealed.sealedLedger.envelope,
          proofRequirements: sealed.sealedLedger.proofRequirements,
        }
      : { latestLedger: sealed.sealedLedger.envelope }),
    ledgerRetirementEvidence: sealed.sealedLedger.retirementEvidence,
    reason: "daily",
    revision,
    signal,
  });
  // This is an owned temporary capture, not a second retained archive tier.
  rmSync(outputPath);
  syncDirectory(catalog.captures);
  return { state: "verified", ...collected, offsiteSuccess: false, needsOffsite: true };
}

export async function registerBeforeUpgrade({
  catalog,
  archivePath,
  manifest,
  upgradeId,
  targetRevision,
  key,
  forbiddenKeys,
  latestLedger,
  latestProof,
  proofRequirements,
  ledgerRetirementEvidence,
  signal,
}) {
  if (!/^[a-f0-9]{40}$/.test(targetRevision) || !/^[a-f0-9-]{36}$/.test(upgradeId))
    backupFailure("invalid_upgrade_checkpoint");
  const identity = await archiveIdentity(archivePath);
  return collectArchive({
    catalog,
    existingArchivePath: archivePath,
    expected: { ...identity, id: manifest.id, createdAt: manifest.createdAt },
    key,
    forbiddenKeys,
    latestLedger,
    latestProof,
    proofRequirements,
    ledgerRetirementEvidence,
    reason: "before-upgrade",
    revision: manifest.release,
    checkpoint: { upgradeId, revision: targetRevision, healthyAt: null, offsiteAck: null },
    signal,
  });
}

export async function prepareBeforeUpgrade(options) {
  const {
    catalog,
    key,
    forbiddenKeys = [],
    latestProof,
    proofRequirements,
    destinationLocationId,
  } = options;
  const value = verifyLatestDeletionProof({
    envelope: latestProof,
    key,
    forbiddenKeys,
    now: catalog.clock(),
    maxAgeMs: 86400000,
    ...proofRequirements,
  });
  const result = await registerBeforeUpgrade(options);
  const transfer = validateOffsiteTransfer(
    {
      format: 1,
      kind: "gildiusz-offsite-transfer",
      backup: Object.fromEntries(
        ["id", "createdAt", "size", "sha256"].map((k) => [k, result.entry[k]]),
      ),
      upgradeId: options.upgradeId,
      targetRevision: options.targetRevision,
      sourceLocationId: result.entry.locationId,
      destinationLocationId,
      proof: {
        ...Object.fromEntries(
          ["id", "sha256", "sourceId", "sequence", "createdAt", "expiresAt", "coveredFrom"].map(
            (k) => [k, value.meta[k]],
          ),
        ),
        challenge: proofRequirements.challenge,
        notBefore: proofRequirements.notBefore,
      },
    },
    catalog.clock(),
  );
  verifyTransferProof({
    transfer,
    envelope: latestProof,
    key,
    forbiddenKeys,
    now: catalog.clock(),
  });
  const entry = await catalog.bindOffsiteTransfer(result.entry.id, transfer);
  return {
    state: "awaiting_offsite",
    entry,
    transfer,
    localVerificationSucceeded: true,
    offsiteSuccess: false,
  };
}

async function checkpointSource({
  catalog,
  id,
  upgradeId,
  targetRevision,
  destinationLocationId,
  key,
  forbiddenKeys = [],
  sourceSnapshot,
}) {
  const state = await catalog.read(),
    entry = state.entries.find((row) => row.id === id);
  const transfer = validateOffsiteTransfer(entry?.checkpoint?.offsite, catalog.clock());
  if (
    transfer.upgradeId !== upgradeId ||
    transfer.targetRevision !== targetRevision ||
    transfer.destinationLocationId !== destinationLocationId ||
    transfer.sourceLocationId !== state.locationId
  )
    backupFailure("backup_checkpoint_conflict");
  const proof = readOffsiteFile(
    join(catalog.root, "deletion-ledger", `deletion-proof-${transfer.proof.id}.gldproof`),
    4 * 1024 * 1024,
  );
  verifyTransferProof({ transfer, envelope: proof, key, forbiddenKeys, now: catalog.clock() });
  const watermark = readDeletionState({
    directory: join(catalog.root, "deletion-ledger"),
    key,
    forbiddenKeys,
    now: catalog.clock(),
  });
  if (
    !watermark ||
    watermark.globalGap ||
    watermark.sourceId !== transfer.proof.sourceId ||
    watermark.minSequence !== transfer.proof.sequence ||
    watermark.head?.sha256 !== transfer.proof.sha256
  )
    backupFailure("offsite_proof_mismatch");
  if (typeof sourceSnapshot !== "function") backupFailure("offsite_source_verification_required");
  const checkSource = async () => {
    const source = await sourceSnapshot();
    if (
      !source?.complete ||
      source.blockers?.length ||
      source.sourceId !== transfer.proof.sourceId ||
      source.sequence !== transfer.proof.sequence ||
      source.coveredFrom !== transfer.proof.coveredFrom
    )
      backupFailure("offsite_source_changed");
  };
  await checkSource();
  if ((await catalog.confirmArchive(transfer.backup)).locationId !== transfer.sourceLocationId)
    backupFailure("offsite_location_mismatch");
  await checkSource();
  const finalWatermark = readDeletionState({
    directory: join(catalog.root, "deletion-ledger"),
    key,
    forbiddenKeys,
    now: catalog.clock(),
  });
  if (
    finalWatermark?.globalGap ||
    finalWatermark?.sourceId !== transfer.proof.sourceId ||
    finalWatermark?.minSequence !== transfer.proof.sequence ||
    finalWatermark?.head?.sha256 !== transfer.proof.sha256
  )
    backupFailure("offsite_proof_mismatch");
  verifyTransferProof({
    transfer,
    envelope: readOffsiteFile(
      join(catalog.root, "deletion-ledger", `deletion-proof-${transfer.proof.id}.gldproof`),
      4 * 1024 * 1024,
    ),
    key,
    forbiddenKeys,
    now: catalog.clock(),
  });
  validateOffsiteTransfer(transfer, catalog.clock());
  return { entry, transfer };
}

export async function importOffsiteAck(options) {
  const envelope = Buffer.from(options.envelope);
  const { entry, transfer } = await checkpointSource(options);
  const verified = verifyOffsiteAck({
    envelope,
    transfer,
    key: options.key,
    forbiddenKeys: options.forbiddenKeys,
    now: options.catalog.clock(),
  });
  await options.catalog.acknowledgeOffsite(entry.id, {
    ...transfer.backup,
    locationId: transfer.destinationLocationId,
    verifiedAt: verified.verifiedAt,
    upgradeId: transfer.upgradeId,
    revision: transfer.targetRevision,
    transfer,
    signedReceipt: envelope.toString("base64url"),
  });
  return verifyUpgradeCheckpoint(options);
}

export async function verifyUpgradeCheckpoint(options) {
  const { entry, transfer } = await checkpointSource(options);
  if (!entry.checkpoint.offsiteAck?.signedReceipt) backupFailure("offsite_ack_required");
  verifyOffsiteAck({
    envelope: Buffer.from(entry.checkpoint.offsiteAck.signedReceipt, "base64url"),
    transfer,
    key: options.key,
    forbiddenKeys: options.forbiddenKeys,
    now: options.catalog.clock(),
  });
  return { id: entry.id, sha256: entry.sha256, checkpoint: entry.checkpoint, offsiteSuccess: true };
}

export function hostingLifecycle(root, assertFence = () => {}) {
  const shared = privateDirectory(join(root, "shared"));
  return {
    hasPendingUpgrade() {
      assertFence();
      try {
        const stat = lstatSync(join(shared, "pending-upgrade.json"));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          backupFailure("backup_pending_reconciliation_required");
      } catch (error) {
        if (error.code === "ENOENT") return false;
        backupFailure("backup_pending_reconciliation_required");
      }
      try {
        // Presence alone does not certify a valid pause/checkpoint. Never treat corruption as absence.
        if (!pendingUpgrade(root)) backupFailure("backup_pending_reconciliation_required");
        return true;
      } catch {
        backupFailure("backup_pending_reconciliation_required");
      }
    },
    pause() {
      assertFence();
      const path = join(shared, "paused");
      if (existsSync(path)) {
        regularFile(path);
        return { owned: false };
      }
      const release = deploymentPause(root);
      return {
        owned: true,
        release: () => {
          assertFence();
          release();
        },
      };
    },
    stop: () => {
      assertFence();
      return stopSupervisor(root);
    },
    resume: () => {
      assertFence();
      return startSupervisor(root);
    },
  };
}

/** Use the same kernel lock as hosting.install; a .lock directory would be a different lock. */
export async function withHostingBackupLock(root, task) {
  if (process.platform !== "linux") backupFailure("hosting_backup_requires_linux");
  const shared = privateDirectory(join(root, "shared"));
  const lock = join(shared, "deploy.lock");
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (existsSync(lock)) {
    regularFile(lock);
    const stat = lstatSync(lock);
    if ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      backupFailure("backup_lock_not_private");
  }
  const child = spawn(
    "flock",
    [
      "-o",
      "-n",
      lock,
      process.execPath,
      "--input-type=module",
      "--eval",
      'process.stdout.write("locked\\n"); process.stdin.resume();',
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      windowsHide: true,
    },
  );
  let owned = false,
    greeting = "";
  let failure;
  child.once("error", () => {
    failure = "backup_deployment_lock_unavailable";
  });
  child.stdin.on("error", () => {});
  child.once("exit", () => {
    if (!owned) failure ??= "backup_deployment_busy";
  });
  child.stdout.on("data", (chunk) => {
    greeting += chunk.toString();
    if (greeting === "locked\n") owned = true;
    else if (!"locked\n".startsWith(greeting)) failure = "backup_deployment_lock_unavailable";
  });
  const deadline = Date.now() + 5000;
  try {
    while (!owned && !failure && Date.now() < deadline) await delay(20);
    if (!owned || failure) backupFailure(failure ?? "backup_deployment_lock_unavailable");
    return await task(() => {
      if (child.exitCode !== null || child.signalCode !== null)
        backupFailure("backup_deployment_lock_lost");
    });
  } finally {
    child.stdin.end();
    const deadline = Date.now() + 2000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
      await delay(20);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function snapshotPorts(values) {
  let options;
  return {
    preflight({ outputPath }) {
      options = configuredSnapshot(outputPath, values);
      return recoveryCommand("plan", { output: outputPath }, values);
    },
    create({ outputPath }) {
      return recoveryCommand("snapshot", { output: outputPath }, values);
    },
    async sealLatestProof() {
      const notBefore = Date.now(),
        challenge = randomUUID();
      const sealed = await sealLatestDeletionProof({
        dataRoot: options.dataRoot,
        installations: options.guilds,
        ...recoveryCredentials(values),
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
    },
  };
}

function inputManifest() {
  const chunks = [],
    chunk = Buffer.alloc(65536);
  let size = 0;
  while (true) {
    const count = readSync(0, chunk, 0, chunk.length, null);
    if (!count) break;
    size += count;
    if (size > 8 * 1024 * 1024) backupFailure("backup_metadata_budget");
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, root, ...args] = process.argv.slice(2);
    if (
      ![
        "plan",
        "status",
        "rotate",
        "run-daily",
        "register-before-upgrade",
        "import-offsite-ack",
        "verify-checkpoint",
        "mark-healthy",
      ].includes(command) ||
      !root
    )
      backupFailure("invalid_backup_options");
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (
        ![
          "--archive",
          "--target-revision",
          "--upgrade-id",
          "--id",
          "--sha256",
          "--pc-location",
          "--transfer-output",
          "--receipt",
        ].includes(args[index]) ||
        !args[index + 1] ||
        options[args[index]]
      )
        backupFailure("invalid_backup_options");
      options[args[index]] = args[index + 1];
    }
    if (
      ![
        "register-before-upgrade",
        "mark-healthy",
        "import-offsite-ack",
        "verify-checkpoint",
      ].includes(command) &&
      args.length
    )
      backupFailure("invalid_backup_options");
    const catalog = new BackupCatalog({ root: resolve(root) });
    let result;
    if (command === "status") result = await catalog.inspectLocation();
    else if (command === "plan") result = await catalog.planRotation();
    else if (command === "rotate")
      result = await catalog.applyRotation(await catalog.planRotation());
    else if (command === "register-before-upgrade") {
      if (
        !options["--archive"] ||
        !options["--target-revision"] ||
        !options["--upgrade-id"] ||
        !options["--pc-location"] ||
        !options["--transfer-output"]
      )
        backupFailure("invalid_backup_options");
      const manifest = inputManifest();
      const archivePath = resolve(options["--archive"]);
      if (dirname(archivePath) !== catalog.captures) backupFailure("backup_capture_not_owned");
      const configuration = configuredSnapshot(archivePath, process.env);
      const notBefore = catalog.clock(),
        challenge = randomUUID();
      const ledger = await sealLatestDeletionProof({
        dataRoot: configuration.dataRoot,
        installations: configuration.guilds,
        ...recoveryCredentials(process.env),
        notBefore,
        challenge,
      });
      result = await prepareBeforeUpgrade({
        catalog,
        archivePath,
        manifest,
        upgradeId: options["--upgrade-id"],
        targetRevision: options["--target-revision"],
        destinationLocationId: options["--pc-location"],
        ...recoveryCredentials(process.env),
        latestProof: ledger.envelope,
        proofRequirements: {
          expectedSourceId: ledger.meta.sourceId,
          minSequence: ledger.meta.sequence,
          notBefore,
          challenge,
        },
      });
      writeOffsiteFile(
        resolve(options["--transfer-output"]),
        Buffer.from(JSON.stringify(result.transfer)),
      );
      rmSync(archivePath);
      syncDirectory(catalog.captures);
      console.log(
        JSON.stringify({
          id: result.entry.id,
          sha256: result.entry.sha256,
          checkpoint: result.entry.checkpoint,
          state: "awaiting_offsite",
          localVerificationSucceeded: true,
          offsiteSuccess: false,
        }),
      );
      result = null;
    } else if (["import-offsite-ack", "verify-checkpoint"].includes(command)) {
      if (
        !options["--id"] ||
        !options["--target-revision"] ||
        !options["--upgrade-id"] ||
        !options["--pc-location"] ||
        (command === "import-offsite-ack" && !options["--receipt"])
      )
        backupFailure("invalid_backup_options");
      const configuration = configuredSnapshot(catalog.archivePath(options["--id"]), process.env);
      const { snapshotRulesDeletionLifecycle } =
        await import("../dist/storage/rules-deletion-lifecycle.js");
      const input = {
        catalog,
        id: options["--id"],
        upgradeId: options["--upgrade-id"],
        targetRevision: options["--target-revision"],
        destinationLocationId: options["--pc-location"],
        ...recoveryCredentials(process.env),
        sourceSnapshot: () =>
          snapshotRulesDeletionLifecycle({
            dataRoot: configuration.dataRoot,
            installations: configuration.guilds,
          }),
      };
      const checked =
        command === "import-offsite-ack"
          ? await importOffsiteAck({
              ...input,
              envelope: readOffsiteFile(resolve(options["--receipt"])),
            })
          : await verifyUpgradeCheckpoint(input);
      console.log(JSON.stringify(checked));
      result = null;
    } else if (command === "mark-healthy") {
      result = await catalog.markUpgradeHealthy(options["--id"], {
        upgradeId: options["--upgrade-id"],
        revision: options["--target-revision"],
        sha256: options["--sha256"],
      });
      console.log(
        JSON.stringify({ id: result.id, sha256: result.sha256, checkpoint: result.checkpoint }),
      );
      result = null;
    } else {
      if (!process.env.BACKUP_HOSTING_ROOT) backupFailure("backup_hosting_root_required");
      result = await withHostingBackupLock(
        resolve(process.env.BACKUP_HOSTING_ROOT),
        async (fence) => {
          const lifecycle = hostingLifecycle(resolve(process.env.BACKUP_HOSTING_ROOT), fence);
          const snapshot = snapshotPorts(process.env);
          const guarded = Object.fromEntries(
            Object.entries(snapshot).map(([name, effect]) => [
              name,
              (...args) => {
                fence();
                return effect(...args);
              },
            ]),
          );
          const daily = await runDailyBackup({
            catalog,
            snapshotPort: guarded,
            lifecyclePort: lifecycle,
            ...recoveryCredentials(process.env),
            revision: process.env.DEPLOYMENT_REVISION ?? null,
          });
          fence();
          const rotation = await catalog.applyRotation(await catalog.planRotation());
          const blocked = [
            ...rotation.blocked,
            ...(daily.retentionBlocked ? [{ code: "deletion_proof_reconciliation_required" }] : []),
          ];
          return {
            ...daily,
            state:
              rotation.state === "retention_blocked" || blocked.length
                ? "retention_blocked"
                : daily.state,
            backupState: daily.state,
            rotation,
            removed: rotation.removed,
            blocked,
          };
        },
      );
    }
    // Summary only: no paths, configuration values, guild identities or credentials.
    if (result)
      console.log(
        JSON.stringify({
          state: result.state ?? (result.complete === false ? "retention_blocked" : "complete"),
          backupState: result.backupState,
          copies: result.copies?.length,
          removed: result.removed?.length,
          blocked: result.blocked?.length,
          backupId: result.entry?.id,
          offsiteSuccess: result.offsiteSuccess,
        }),
      );
  } catch (error) {
    console.error(
      typeof error?.code === "string" && /^[a-z_]+$/.test(error.code)
        ? error.code
        : "backup_scheduler_failed",
    );
    process.exitCode = 1;
  }
}
