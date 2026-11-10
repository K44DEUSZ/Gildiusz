import {
  constants,
  closeSync,
  createReadStream,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { restoreSnapshot } from "../dist/storage/recovery/index.js";
import { syncDirectory, withInput } from "../dist/storage/recovery/files.js";
import {
  archiveIdentity,
  BackupCatalog,
  backupFailure,
  backupMaxAgeMs,
  backupMaxBytes,
} from "./backup-catalog.mjs";
import { importLatestDeletionLedger, verifyLatestDeletionLedger } from "./backup-ledger.mjs";
import {
  importLatestDeletionProof,
  pruneImportedDeletionProofs,
  verifyLatestDeletionProof,
} from "./backup-proof.mjs";
import { readDeletionState } from "./backup-deletion-state.mjs";
import { recoveryCredentials } from "./recovery.mjs";

function validateExpected(value, now) {
  if (
    !value ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    value.createdAt > now ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > backupMaxBytes ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    backupFailure("invalid_backup_expectation");
  if (value.createdAt + backupMaxAgeMs <= now) backupFailure("backup_already_expired");
}
function aborted(signal) {
  if (signal.aborted) backupFailure("backup_transfer_aborted");
}
async function nextPart(iterator, signal) {
  return abortable(() => iterator.next(), signal);
}
async function abortable(task, signal) {
  aborted(signal);
  let handler;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        handler = () =>
          reject(
            Object.assign(Error("backup_transfer_aborted"), { code: "backup_transfer_aborted" }),
          );
        signal.addEventListener("abort", handler, { once: true });
      }),
    ]);
  } finally {
    if (handler) signal.removeEventListener("abort", handler);
  }
}
async function writeIncoming(path, source, expected, signal) {
  const fd = openSync(path, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0,
    chunks = 0;
  const iterator = source[Symbol.asyncIterator]?.() ?? source[Symbol.iterator]?.();
  if (!iterator) {
    closeSync(fd);
    backupFailure("invalid_backup_stream");
  }
  try {
    while (true) {
      const next = await nextPart(iterator, signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0)
        backupFailure("invalid_backup_stream");
      size += next.value.byteLength;
      if (size > expected.size || size > backupMaxBytes) backupFailure("backup_transfer_budget");
      hash.update(next.value);
      let offset = 0;
      while (offset < next.value.byteLength)
        offset += writeSync(fd, next.value, offset, next.value.byteLength - offset);
      if (++chunks % 1024 === 0) await yieldLoop();
    }
    aborted(signal);
    if (size !== expected.size || hash.digest("hex") !== expected.sha256)
      backupFailure("backup_hash_mismatch");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
    // A transport that ignores AbortSignal must not hold the scheduler open indefinitely.
    const closing = iterator.return?.();
    if (closing?.catch) closing.catch(() => {});
  }
}

function boundedRead(path, limit) {
  return withInput(resolve(path), (fd, size) => {
    if (size > limit) backupFailure("backup_metadata_budget");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count) backupFailure("backup_file_changed");
      offset += count;
    }
    return bytes;
  });
}
export async function pruneCollectedDeletionProofs({ catalog, key, forbiddenKeys = [] }) {
  if (!(catalog instanceof BackupCatalog)) backupFailure("invalid_backup_catalog");
  return pruneImportedDeletionProofs({
    directory: join(catalog.root, "deletion-ledger"),
    key,
    forbiddenKeys,
    clock: () => catalog.clock(),
  });
}
async function latestLedger({
  catalog,
  key,
  forbiddenKeys,
  latestLedger,
  latestProof,
  proofRequirements,
  retirementEvidence,
  signal,
  manifest,
  expected,
}) {
  const directory = join(catalog.root, "deletion-ledger");
  const pruned = await pruneCollectedDeletionProofs({ catalog, key, forbiddenKeys });
  aborted(signal);
  const v2 = Boolean(
    latestProof || proofRequirements || pruned.watermark?.sourceId || pruned.watermark?.globalGap,
  );
  const receipt = (value, check) =>
    Object.defineProperty(value, "assertCurrent", { value: check, enumerable: false });
  if (v2) {
    if (!latestProof) return receipt({ state: "proof_sync_required" }, () => {});
    if (
      !proofRequirements ||
      typeof proofRequirements.expectedSourceId !== "string" ||
      !Number.isSafeInteger(proofRequirements.minSequence) ||
      proofRequirements.minSequence < 1
    )
      backupFailure("proof_requirements_required");
    let challenge = proofRequirements.challenge,
      notBefore = proofRequirements.notBefore;
    if (typeof latestProof === "function") {
      challenge = randomUUID();
      notBefore = catalog.clock();
    }
    const raw =
      typeof latestProof === "function"
        ? await abortable(() => latestProof({ signal, challenge, notBefore }), signal)
        : latestProof;
    if (!(raw instanceof Uint8Array)) backupFailure("invalid_deletion_proof");
    const envelope = Buffer.from(raw);
    const evidence =
      typeof retirementEvidence === "function"
        ? await abortable(() => retirementEvidence({ signal }), signal)
        : retirementEvidence;
    aborted(signal);
    const requirements = {
      expectedSourceId: proofRequirements.expectedSourceId,
      minSequence: proofRequirements.minSequence,
      challenge,
      notBefore,
      maxAgeMs: 86400000,
      maxFutureMs: 0,
    };
    if (
      !Number.isSafeInteger(notBefore) ||
      notBefore < expected.createdAt ||
      typeof challenge !== "string"
    )
      backupFailure("proof_requirements_required");
    const current = await importLatestDeletionProof({
      directory,
      envelope,
      key,
      forbiddenKeys,
      clock: () => catalog.clock(),
      ...requirements,
      retirementEvidence: evidence,
    });
    aborted(signal);
    if (!manifest)
      manifest = await restoreSnapshot({
        archivePath: catalog.archivePath(expected.id),
        targetRoot: join(catalog.verification, randomUUID()),
        key,
        forbiddenKeys,
        dryRun: true,
        maxBytes: backupMaxBytes - 8 * 1024 * 1024 - 56,
        now: catalog.clock(),
      });
    const check = () => {
      const value = verifyLatestDeletionProof({
        envelope,
        key,
        forbiddenKeys,
        now: catalog.clock(),
        ...requirements,
      }).proof;
      if (expected.createdAt < value.coveredFrom || expected.createdAt > value.createdAt)
        backupFailure("proof_coverage_missing");
      for (const guild of manifest.guilds)
        if (
          !value.guildIds.includes(guild.guildId) &&
          !value.guilds.some((e) => e.guildId === guild.guildId && expected.createdAt <= e.purgedAt)
        )
          backupFailure("proof_scope_missing");
      const state = readDeletionState({ directory, key, forbiddenKeys, now: catalog.clock() });
      if (
        !state ||
        state.globalGap ||
        state.sourceId !== value.sourceId ||
        state.minSequence !== value.sequence ||
        state.head?.id !== current.meta.id ||
        state.head?.sha256 !== current.meta.sha256
      )
        backupFailure("proof_state_unavailable");
      aborted(signal);
    };
    check();
    return receipt(
      {
        state: "verified",
        format: 2,
        id: current.meta.id,
        sourceId: current.meta.sourceId,
        sequence: current.meta.sequence,
        sha256: current.meta.sha256,
        createdAt: current.meta.createdAt,
      },
      check,
    );
  }
  if (!latestLedger) return receipt({ state: "ledger_sync_required" }, () => {});
  const raw =
    typeof latestLedger === "function"
      ? await abortable(() => latestLedger({ signal }), signal)
      : latestLedger;
  const envelope = Buffer.from(raw);
  aborted(signal);
  const evidence =
    typeof retirementEvidence === "function"
      ? await abortable(() => retirementEvidence({ signal }), signal)
      : retirementEvidence;
  const imported = await importLatestDeletionLedger({
    directory,
    envelope,
    key,
    forbiddenKeys,
    clock: () => catalog.clock(),
    maxAgeMs: 86400000,
    maxFutureMs: 0,
    retirementEvidence: evidence,
  });
  const check = () => {
    verifyLatestDeletionLedger({
      envelope,
      key,
      forbiddenKeys,
      now: catalog.clock(),
      maxAgeMs: 86400000,
      maxFutureMs: 0,
    });
    const state = readDeletionState({ directory, key, forbiddenKeys, now: catalog.clock() });
    if (
      state?.sourceId ||
      state?.globalGap ||
      state?.head?.id !== imported.meta.id ||
      state?.head?.sha256 !== imported.meta.sha256
    )
      backupFailure("source_requires_v2");
    aborted(signal);
  };
  check();
  return receipt({ state: "verified", format: 1 }, check);
}
/** No host transport is installed here. fetchStream is an explicitly supplied operator adapter. */
export async function collectArchive(options) {
  const timeoutMs = options.timeoutMs ?? 300000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000)
    backupFailure("invalid_backup_timeout");
  const timeout = new globalThis.AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const result = await collectWithinDeadline({ ...options, timeoutSignal: timeout.signal });
    aborted(options.signal?.aborted ? options.signal : timeout.signal);
    return result;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
async function collectWithinDeadline({
  catalog,
  expected,
  existingArchivePath,
  fetchStream,
  key,
  forbiddenKeys,
  latestLedger: ledgerPort,
  latestProof,
  proofRequirements,
  ledgerRetirementEvidence,
  reason = "daily",
  revision = null,
  checkpoint = null,
  signal: callerSignal,
  timeoutSignal,
}) {
  if (!(catalog instanceof BackupCatalog)) backupFailure("invalid_backup_catalog");
  if (Boolean(existingArchivePath) === Boolean(fetchStream))
    backupFailure("choose_one_backup_transport");
  validateExpected(expected, catalog.clock());
  const signal = callerSignal
    ? globalThis.AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
  aborted(signal);
  const current = await catalog.read();
  const previous = current.entries.find((entry) => entry.id === expected.id);
  if (
    previous &&
    (previous.sha256 !== expected.sha256 ||
      previous.createdAt !== expected.createdAt ||
      previous.size !== expected.size)
  )
    backupFailure("backup_identity_conflict");
  if (previous?.state === "verified") {
    const identity = await archiveIdentity(catalog.archivePath(expected.id));
    if (identity.sha256 !== expected.sha256 || identity.size !== expected.size)
      backupFailure("backup_hash_mismatch");
    const ledger = await latestLedger({
      catalog,
      key,
      forbiddenKeys,
      latestLedger: ledgerPort,
      latestProof,
      proofRequirements,
      expected,
      retirementEvidence: ledgerRetirementEvidence,
      signal,
    });
    validateExpected(expected, catalog.clock());
    ledger.assertCurrent();
    const confirmed = await catalog.confirmArchive(expected);
    aborted(signal);
    validateExpected(expected, catalog.clock());
    ledger.assertCurrent();
    return {
      entry: confirmed,
      ledger,
      offsiteSuccess: ledger.state === "verified",
      replayed: true,
    };
  }
  const transfer = await catalog.beginTransfer(expected.id);
  const incoming = join(catalog.incoming, `${transfer.operationId}.part`);
  let promoted = false;
  try {
    let source;
    if (existingArchivePath) {
      if (!isAbsolute(existingArchivePath)) backupFailure("absolute_backup_path_required");
      const identity = await archiveIdentity(existingArchivePath);
      if (identity.sha256 !== expected.sha256 || identity.size !== expected.size)
        backupFailure("backup_hash_mismatch");
      source = createReadStream(existingArchivePath, {
        flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        highWaterMark: 65536,
        signal,
      });
    } else
      source = await abortable(() => fetchStream({ expected: { ...expected }, signal }), signal);
    await writeIncoming(incoming, source, expected, signal);
    const identity = await archiveIdentity(incoming);
    if (identity.sha256 !== expected.sha256 || identity.size !== expected.size)
      backupFailure("backup_hash_mismatch");
    const manifest = await restoreSnapshot({
      archivePath: incoming,
      targetRoot: join(catalog.verification, transfer.operationId),
      key,
      forbiddenKeys,
      dryRun: true,
      maxBytes: backupMaxBytes - 8 * 1024 * 1024 - 56,
    });
    aborted(signal);
    if (manifest.id !== expected.id || manifest.createdAt !== expected.createdAt)
      backupFailure("backup_authenticated_identity_conflict");
    validateExpected(
      { ...identity, id: manifest.id, createdAt: manifest.createdAt },
      catalog.clock(),
    );
    const after = await archiveIdentity(incoming);
    if (after.sha256 !== identity.sha256 || after.size !== identity.size)
      backupFailure("backup_file_changed");
    // link+unlink promotes one complete private file exclusively; it cannot replace an existing archive.
    linkSync(incoming, catalog.archivePath(expected.id));
    rmSync(incoming);
    syncDirectory(catalog.archives);
    syncDirectory(catalog.incoming);
    promoted = true;
    await catalog.registerVerified({
      manifest,
      ...identity,
      reason,
      revision,
      checkpoint,
      operationId: transfer.operationId,
    });
    const ledger = await latestLedger({
      catalog,
      key,
      forbiddenKeys,
      latestLedger: ledgerPort,
      latestProof,
      proofRequirements,
      expected,
      manifest,
      retirementEvidence: ledgerRetirementEvidence,
      signal,
    });
    validateExpected(expected, catalog.clock());
    ledger.assertCurrent();
    const entry = await catalog.confirmArchive(expected);
    aborted(signal);
    validateExpected(expected, catalog.clock());
    ledger.assertCurrent();
    return { entry, ledger, offsiteSuccess: ledger.state === "verified", replayed: false };
  } catch (error) {
    // Keep only this encrypted partial + durable transfer record for explicit reconciliation.
    // Rotation never treats a failed, incomplete or ambiguously promoted transfer as a verified copy.
    throw Object.assign(Error("backup_collection_failed"), {
      code:
        typeof error?.code === "string" && /^[a-z_]+$/.test(error.code)
          ? error.code
          : "backup_collection_failed",
      operationId: transfer.operationId,
      promoted,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (
        ![
          "--catalog",
          "--archive",
          "--metadata",
          "--ledger",
          "--proof",
          "--proof-requirements",
        ].includes(args[i]) ||
        !args[i + 1] ||
        options[args[i]]
      )
        backupFailure("invalid_backup_options");
      options[args[i]] = args[i + 1];
    }
    if (command === "prune-deletions") {
      if (Object.keys(options).length !== 1 || !options["--catalog"])
        backupFailure("invalid_backup_options");
      const result = await pruneCollectedDeletionProofs({
        catalog: new BackupCatalog({ root: resolve(options["--catalog"]) }),
        ...recoveryCredentials(process.env),
      });
      console.log(JSON.stringify(result));
    } else {
      if (
        command !== "collect" ||
        !options["--catalog"] ||
        !options["--archive"] ||
        !options["--metadata"] ||
        (options["--ledger"] && options["--proof"]) ||
        Boolean(options["--proof"]) !== Boolean(options["--proof-requirements"])
      )
        backupFailure("invalid_backup_options");
      const expected = JSON.parse(boundedRead(options["--metadata"], 1024 * 1024).toString("utf8"));
      const result = await collectArchive({
        catalog: new BackupCatalog({ root: resolve(options["--catalog"]) }),
        existingArchivePath: resolve(options["--archive"]),
        expected,
        ...recoveryCredentials(process.env),
        latestLedger: options["--ledger"]
          ? boundedRead(options["--ledger"], 2 * 1024 * 1024)
          : undefined,
        latestProof: options["--proof"]
          ? boundedRead(options["--proof"], 4 * 1024 * 1024)
          : undefined,
        proofRequirements: options["--proof-requirements"]
          ? JSON.parse(boundedRead(options["--proof-requirements"], 4096).toString("utf8"))
          : undefined,
        reason: expected.reason ?? "daily",
        revision: expected.revision ?? null,
        checkpoint: expected.checkpoint ?? null,
      });
      console.log(
        JSON.stringify({
          backupId: result.entry.id,
          verified: true,
          offsiteSuccess: result.offsiteSuccess,
          ledger: result.ledger.state,
        }),
      );
    }
  } catch (error) {
    console.error(
      typeof error?.code === "string" && /^[a-z_]+$/.test(error.code)
        ? error.code
        : "backup_collection_failed",
    );
    process.exitCode = 1;
  }
}
