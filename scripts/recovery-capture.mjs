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
    });
    const value = {
      format: 1,
      kind: "gildiusz-manual-recovery-capture",
      id: randomUUID(),
      createdAt: captured.meta.createdAt,
      archive: archiveIdentity(manifest, archiveBefore),
      journal: captured.recoveryJournal,
      proof: captured.envelope.toString("base64"),
      captureBoundary: "root_and_guild_leases_held_during_capture_only",
      activationAllowed: false,
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
