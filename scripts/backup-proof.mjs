import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { backupKey } from "../dist/storage/recovery/archive.js";
import {
  privateDirectory,
  regularFile,
  syncDirectory,
  withInput,
  writeAll,
} from "../dist/storage/recovery/files.js";
import {
  rulesDeletionRetentionMs,
  validateRulesDeletion,
} from "../dist/modules/server-rules/deletion-outbox.js";
import { decodeDeletionLedgerHistory } from "./backup-ledger.mjs";
import {
  assertGlobalDeletionEvidence,
  acquireDeletionImportLock,
  commitDeletionState,
  compareGuildDeletion,
  deletionDeadline,
  deletionTerminalAgeMs,
  pruneLockedDeletionArtifacts,
  readDeletionState,
} from "./backup-deletion-state.mjs";

const magic = Buffer.from("GLDPRF02"),
  info = "gildiusz-latest-deletion-proof-v2",
  headerSize = 36,
  tagSize = 16;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const guildId = (v) => typeof v === "string" && /^[0-9]{17,20}$/.test(v);
const exact = (v, fields) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === fields.slice().sort().join(",");
const sha = (v) => createHash("sha256").update(v).digest("hex");
export const deletionProofLimits = Object.freeze({
  entries: 10000,
  guilds: 1000,
  envelopeBytes: 4 * 1024 * 1024,
  importFiles: 8,
  maxFreshnessMs: 86400000,
});
export class BackupProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "BackupProofError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new BackupProofError(code);
};
function clock(now, maxFutureMs = 0) {
  if (!integer(now) || !integer(maxFutureMs) || maxFutureMs > 60000) fail("invalid_input");
}
function keyOf(key, forbiddenKeys = []) {
  try {
    return backupKey(key, forbiddenKeys);
  } catch {
    fail("invalid_key");
  }
}
function validate(body, now, maxFutureMs) {
  if (
    !exact(body, [
      "format",
      "kind",
      "id",
      "sourceId",
      "sequence",
      "createdAt",
      "coveredFrom",
      "challenge",
      "complete",
      "coverage",
      "guildIds",
      "guilds",
      "acceptances",
    ]) ||
    body.format !== 2 ||
    body.kind !== "gildiusz-latest-deletion-proof" ||
    !uuid.test(body.id) ||
    !uuid.test(body.sourceId) ||
    !integer(body.sequence) ||
    body.sequence < 1 ||
    !integer(body.createdAt) ||
    !integer(body.createdAt + deletionTerminalAgeMs) ||
    body.createdAt > now + maxFutureMs ||
    !integer(body.coveredFrom) ||
    body.coveredFrom > body.createdAt ||
    !uuid.test(body.challenge) ||
    body.complete !== true ||
    JSON.stringify(body.coverage) !== JSON.stringify(["guilds", "rules_acceptances"]) ||
    !Array.isArray(body.guildIds) ||
    body.guildIds.length > deletionProofLimits.guilds ||
    body.guildIds.some((id) => !guildId(id)) ||
    new Set(body.guildIds).size !== body.guildIds.length ||
    !Array.isArray(body.guilds) ||
    body.guilds.length > deletionProofLimits.entries ||
    !Array.isArray(body.acceptances) ||
    body.acceptances.length > deletionProofLimits.entries
  )
    fail("invalid_proof");
  const guilds = new Set(),
    ids = new Set(),
    sequences = new Set();
  for (const entry of body.guilds) {
    if (
      !exact(entry, ["format", "guildId", "removedAt", "purgedAt", "outcome"]) ||
      entry.format !== 1 ||
      !guildId(entry.guildId) ||
      !integer(entry.removedAt) ||
      !integer(entry.purgedAt) ||
      !integer(entry.purgedAt + deletionTerminalAgeMs) ||
      entry.removedAt > entry.purgedAt ||
      entry.purgedAt > body.createdAt ||
      entry.outcome !== "purged" ||
      guilds.has(entry.guildId)
    )
      fail("invalid_proof");
    guilds.add(entry.guildId);
  }
  for (const entry of body.acceptances) {
    if (!exact(entry, ["guildId", "acceptanceId", "retiredAt", "expiresAt", "sequence"]))
      fail("invalid_proof");
    try {
      validateRulesDeletion(entry);
    } catch {
      fail("invalid_proof");
    }
    const key = entry.guildId + ":" + entry.acceptanceId,
      sequence = entry.guildId + ":" + entry.sequence;
    if (
      (!body.guildIds.includes(entry.guildId) && !guilds.has(entry.guildId)) ||
      entry.retiredAt > body.createdAt ||
      entry.expiresAt <= body.createdAt ||
      ids.has(key) ||
      sequences.has(sequence)
    )
      fail("invalid_proof");
    ids.add(key);
    sequences.add(sequence);
  }
  if (new Set([...body.guildIds, ...guilds]).size > deletionProofLimits.guilds) fail("proof_quota");
  return body;
}
function metadata(bytes, body) {
  return {
    format: 2,
    id: body.id,
    sourceId: body.sourceId,
    sequence: body.sequence,
    createdAt: body.createdAt,
    expiresAt: deletionDeadline({
      createdAt: body.createdAt,
      guilds: body.guilds,
      acceptances: body.acceptances,
      maxAgeMs: deletionProofLimits.maxFreshnessMs,
    }),
    coveredFrom: body.coveredFrom,
    guildCount: body.guilds.length,
    acceptanceCount: body.acceptances.length,
    sha256: sha(bytes),
    size: bytes.length,
  };
}
function encode(body, key) {
  const plain = Buffer.from(JSON.stringify(body)),
    header = Buffer.concat([magic, randomBytes(16), randomBytes(12)]),
    derived = Buffer.from(hkdfSync("sha256", key, header.subarray(8, 24), info, 32));
  try {
    if (plain.length + headerSize + tagSize > deletionProofLimits.envelopeBytes)
      fail("proof_quota");
    const cipher = createCipheriv("aes-256-gcm", derived, header.subarray(24));
    cipher.setAAD(header);
    const envelope = Buffer.concat([
      header,
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { envelope, meta: metadata(envelope, body) };
  } finally {
    plain.fill(0);
    derived.fill(0);
  }
}
function decode(value, key, now, maxFutureMs) {
  if (
    !(value instanceof Uint8Array) ||
    value.length < headerSize + tagSize + 2 ||
    value.length > deletionProofLimits.envelopeBytes
  )
    fail("invalid_envelope");
  const bytes = Buffer.from(value),
    header = bytes.subarray(0, headerSize);
  if (!header.subarray(0, 8).equals(magic)) fail("invalid_envelope");
  const derived = Buffer.from(hkdfSync("sha256", key, header.subarray(8, 24), info, 32));
  let plain;
  try {
    const cipher = createDecipheriv("aes-256-gcm", derived, header.subarray(24));
    cipher.setAAD(header);
    cipher.setAuthTag(bytes.subarray(-tagSize));
    plain = Buffer.concat([cipher.update(bytes.subarray(headerSize, -tagSize)), cipher.final()]);
  } catch {
    fail("authentication_failed");
  } finally {
    derived.fill(0);
  }
  try {
    let body;
    try {
      body = JSON.parse(plain.toString("utf8"));
    } catch {
      fail("invalid_proof");
    }
    validate(body, now, maxFutureMs);
    return { meta: metadata(bytes, body), proof: body };
  } finally {
    plain.fill(0);
  }
}
/** Caller supplies the complete trusted installation inventory, not a client-selected guild list. */
async function sealSourceProof(options, includeRecoveryJournal) {
  const {
    dataRoot,
    installations,
    key,
    forbiddenKeys = [],
    now: givenNow,
    notBefore,
    challenge,
  } = options;
  const readNow = options.clock ?? (() => givenNow ?? Date.now());
  const now = readNow();
  clock(now);
  if (
    !integer(notBefore) ||
    notBefore > now ||
    now - notBefore > deletionProofLimits.maxFreshnessMs ||
    !uuid.test(challenge)
  )
    fail("invalid_input");
  const master = keyOf(key, forbiddenKeys);
  try {
    const {
      sealRulesDeletionLifecycleSnapshot,
      pruneRulesDeletionLifecycle,
      readRulesDeletionLifecycleJournal,
      withRecoveryRulesDeletionLifecycle,
    } = await import("../dist/storage/rules-deletion-lifecycle.js");
    const consume = (journal, lockedRoot) => {
      if (!journal.complete || journal.blockers.length) fail("source_incomplete");
      const now = readNow();
      if (
        now < journal.updatedAt ||
        notBefore > now ||
        now - notBefore > deletionProofLimits.maxFreshnessMs
      )
        fail("clock_rollback");
      const body = {
        format: 2,
        kind: "gildiusz-latest-deletion-proof",
        id: randomUUID(),
        sourceId: journal.sourceId,
        sequence: journal.sequence,
        createdAt: now,
        coveredFrom: journal.coveredFrom,
        challenge,
        complete: true,
        coverage: ["guilds", "rules_acceptances"],
        guildIds: journal.active.map((i) => i.guildId),
        guilds: journal.retired.map(({ format, guildId, removedAt, purgedAt, outcome }) => ({
          format,
          guildId,
          removedAt,
          purgedAt,
          outcome,
        })),
        acceptances: journal.entries,
      };
      validate(body, now, 0);
      const sealed = encode(body, master);
      if (!includeRecoveryJournal) return sealed;
      // Read inside the same root and guild leases as the sealed proof.
      const recoveryJournal = readRulesDeletionLifecycleJournal(lockedRoot);
      if (
        recoveryJournal.sourceId !== body.sourceId ||
        recoveryJournal.sequence !== body.sequence ||
        recoveryJournal.coveredFrom !== body.coveredFrom ||
        recoveryJournal.globalGap !== null ||
        recoveryJournal.admitting.length ||
        recoveryJournal.retiring.length ||
        JSON.stringify(recoveryJournal.entries) !== JSON.stringify(body.acceptances)
      )
        fail("source_changed_during_capture");
      return { ...sealed, recoveryJournal };
    };
    let sealed;
    if (options.sourceLease) {
      sealed = await withRecoveryRulesDeletionLifecycle(
        {
          dataRoot,
          installations,
          sourceLease: options.sourceLease,
          ...(givenNow === undefined ? {} : { now: readNow() }),
        },
        async (port) => {
          await port.pruneExpired();
          return consume(await port.sealSnapshot(), port.root);
        },
      );
    } else {
      await pruneRulesDeletionLifecycle({
        dataRoot,
        ...(givenNow === undefined ? {} : { now: readNow() }),
      });
      sealed = await sealRulesDeletionLifecycleSnapshot(
        { dataRoot, installations, ...(givenNow === undefined ? {} : { now: readNow() }) },
        consume,
      );
    }
    if (readNow() >= sealed.meta.expiresAt) fail("expired_decision");
    return sealed;
  } finally {
    master.fill(0);
  }
}
export async function sealLatestDeletionProof(options) {
  return sealSourceProof(options, false);
}
/** Operator-only private data. It is not a public status response or permission to resume a restore. */
export async function captureLatestDeletionRecoveryState(options) {
  return sealSourceProof(options, true);
}
export function verifyLatestDeletionProof({
  envelope,
  key,
  forbiddenKeys = [],
  now = Date.now(),
  maxAgeMs,
  maxFutureMs = 0,
  expectedSourceId,
  minSequence = 0,
  notBefore,
  challenge,
}) {
  clock(now, maxFutureMs);
  if (
    !integer(maxAgeMs) ||
    maxAgeMs < 1 ||
    maxAgeMs > deletionProofLimits.maxFreshnessMs ||
    !integer(minSequence) ||
    (expectedSourceId !== undefined && !uuid.test(expectedSourceId)) ||
    (notBefore !== undefined && (!integer(notBefore) || notBefore > now)) ||
    (challenge !== undefined && !uuid.test(challenge))
  )
    fail("invalid_input");
  const master = keyOf(key, forbiddenKeys);
  try {
    const result = decode(envelope, master, now, maxFutureMs),
      proof = result.proof;
    if (
      now - proof.createdAt >= maxAgeMs ||
      (notBefore !== undefined && proof.createdAt < notBefore)
    )
      fail("stale_proof");
    if (
      now >=
      deletionDeadline({
        createdAt: proof.createdAt,
        guilds: proof.guilds,
        acceptances: proof.acceptances,
      })
    )
      fail("expired_decision");
    if (expectedSourceId !== undefined && proof.sourceId !== expectedSourceId)
      fail("source_changed");
    if (proof.sequence < minSequence) fail("rollback_detected");
    if (challenge !== undefined && proof.challenge !== challenge) fail("challenge_mismatch");
    return result;
  } finally {
    master.fill(0);
  }
}
export function decodeDeletionProofHistory({
  envelope,
  key,
  forbiddenKeys = [],
  now = Date.now(),
}) {
  clock(now);
  const master = keyOf(key, forbiddenKeys);
  try {
    return decode(envelope, master, now, 0);
  } finally {
    master.fill(0);
  }
}
function readBounded(path, maximum) {
  return withInput(path, (fd, size) => {
    if (size > maximum) fail("proof_quota");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, bytes, offset, size - offset, offset);
      if (!n) fail("source_changed");
      offset += n;
    }
    return bytes;
  });
}
const fileName = (id) => `deletion-proof-${id}.gldproof`;
function removeTemporary(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function durablePrivateDirectory(directory) {
  const created = [];
  for (let path = directory; ; path = dirname(path)) {
    try {
      lstatSync(path);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      created.push(path);
    }
  }
  privateDirectory(directory);
  for (const path of created.reverse()) syncDirectory(dirname(path));
}
function writeAtomic(directory, path, bytes) {
  const temp = join(directory, `${randomUUID()}.tmp`),
    fd = openSync(temp, "wx", 0o600);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
    syncDirectory(directory);
  } finally {
    removeTemporary(temp);
  }
}
function preserve(current, prior, now, retirementEvidence) {
  const proof = current.proof,
    old = prior.proof;
  if (proof.id === old.id && current.meta.sha256 !== prior.meta.sha256) fail("id_collision");
  if (proof.sourceId !== old.sourceId) fail("source_changed");
  if (
    proof.sequence < old.sequence ||
    proof.createdAt < old.createdAt ||
    proof.coveredFrom !== old.coveredFrom
  )
    fail("rollback_detected");
  if (proof.sequence === old.sequence && current.meta.sha256 !== prior.meta.sha256)
    fail("conflicting_proof");
  const entries = new Map(proof.acceptances.map((e) => [e.guildId + ":" + e.acceptanceId, e]));
  for (const entry of old.acceptances) {
    const next = entries.get(entry.guildId + ":" + entry.acceptanceId);
    if (next && JSON.stringify(entry) !== JSON.stringify(next)) fail("conflicting_deletion");
    if (!next && (entry.expiresAt > now || proof.createdAt < entry.expiresAt)) fail("proof_shrink");
  }
  for (const id of old.guildIds)
    if (
      !proof.guildIds.includes(id) &&
      !proof.guilds.some((e) => e.guildId === id && e.purgedAt >= old.createdAt)
    ) {
      if (
        now < old.createdAt + deletionTerminalAgeMs ||
        proof.createdAt < old.createdAt + deletionTerminalAgeMs
      )
        fail("inventory_changed");
      try {
        assertGlobalDeletionEvidence({
          ...retirementEvidence,
          gap: { unsafeBefore: old.createdAt },
          now,
        });
      } catch {
        fail("operator_block");
      }
    }
  const missing = [];
  for (const entry of old.guilds) {
    const next = proof.guilds.find((e) => e.guildId === entry.guildId);
    if (next) {
      try {
        compareGuildDeletion(entry, next);
      } catch {
        fail("conflicting_deletion");
      }
    }
    if (!next) missing.push(entry);
  }
  if (
    missing.length &&
    missing.some(
      (e) =>
        now < e.purgedAt + deletionTerminalAgeMs ||
        proof.createdAt < e.purgedAt + deletionTerminalAgeMs,
    )
  )
    fail("proof_shrink");
  if (missing.length) {
    try {
      assertGlobalDeletionEvidence({
        ...retirementEvidence,
        gap: { unsafeBefore: Math.max(...missing.map((e) => e.purgedAt)) },
        now,
      });
    } catch {
      fail("operator_block");
    }
  }
}
function proofHistory(master) {
  return (bytes, kind, now) => {
    const result =
      kind === "proof"
        ? decode(bytes, master, now, 0)
        : decodeDeletionLedgerHistory({ envelope: bytes, key: master, now });
    return {
      ...result,
      guilds: kind === "proof" ? result.proof.guilds : result.entries,
      acceptances: kind === "proof" ? result.proof.acceptances : [],
    };
  };
}
export async function pruneImportedDeletionProofs(options) {
  const { directory, key, forbiddenKeys = [] } = options,
    master = keyOf(key, forbiddenKeys),
    clock = options.clock ?? (() => options.now ?? Date.now());
  let release;
  try {
    durablePrivateDirectory(directory);
    release = await acquireDeletionImportLock(directory);
    const result = pruneLockedDeletionArtifacts({
      directory,
      key: master,
      now: clock(),
      decode: proofHistory(master),
    });
    return {
      removed: result.removed.length,
      blocked: Boolean(result.state?.globalGap),
      watermark: result.state,
    };
  } catch (error) {
    if (error instanceof BackupProofError) throw error;
    fail(error.code ?? "operator_block");
  } finally {
    master.fill(0);
    await release?.();
  }
}
/** Imported proof remains separate from backups and never clears restore quarantine. */
export async function importLatestDeletionProof(options) {
  const { directory, envelope, key, forbiddenKeys = [], retirementEvidence } = options;
  if (!isAbsolute(directory)) fail("invalid_input");
  if (!(envelope instanceof Uint8Array) || envelope.length > deletionProofLimits.envelopeBytes)
    fail("invalid_envelope");
  const bytes = Buffer.from(envelope),
    master = keyOf(key, forbiddenKeys);
  const verification = { ...options, envelope: bytes, key: master, forbiddenKeys: [] },
    clock = options.clock ?? (() => options.now ?? Date.now()),
    admit = () => verifyLatestDeletionProof({ ...verification, now: clock() });
  let release, result;
  try {
    let current = admit();
    durablePrivateDirectory(directory);
    try {
      release = await acquireDeletionImportLock(directory);
      current = admit();
      const now = clock();
      const pruned = pruneLockedDeletionArtifacts({
        directory,
        key: master,
        now,
        decode: proofHistory(master),
      });
      const previous = pruned.artifacts.filter((a) => a.meta.format === 2),
        legacy = pruned.artifacts.filter((a) => a.meta.format === 1),
        files = pruned.artifacts.map((a) => a.name);
      const indexPath = join(directory, "latest-proof.json");
      try {
        lstatSync(indexPath);
        regularFile(indexPath);
        let index;
        try {
          index = JSON.parse(readBounded(indexPath, 4096).toString("utf8"));
        } catch {
          fail("invalid_index");
        }
        const matching =
          !exact(index, [...Object.keys(current.meta), "file"]) ||
          !previous.some((p) =>
            Object.entries({ ...p.meta, file: fileName(p.meta.id) }).every(([key, value]) =>
              key === "expiresAt" ? integer(index.expiresAt) : index[key] === value,
            ),
          );
        if (matching) {
          const state = readDeletionState({ directory, key: master, now });
          const retiredIndex =
            state?.globalGap &&
            exact(index, [...Object.keys(current.meta), "file"]) &&
            index.format === 2 &&
            uuid.test(index.id) &&
            index.file === fileName(index.id) &&
            /^[a-f0-9]{64}$/.test(index.sha256) &&
            index.sourceId === state.sourceId &&
            index.coveredFrom === state.coveredFrom &&
            integer(index.sequence) &&
            index.sequence <= state.minSequence &&
            integer(index.createdAt) &&
            index.createdAt <= state.updatedAt &&
            ["expiresAt", "guildCount", "acceptanceCount", "size"].every((k) => integer(index[k]));
          if (!retiredIndex) fail("invalid_index");
          // The authenticated GID-free fence survives the interrupted payload/index retirement.
          unlinkSync(indexPath);
          syncDirectory(directory);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const prior of previous) preserve(current, prior, now, retirementEvidence);
      for (const prior of legacy)
        for (const old of prior.entries) {
          const next = current.proof.guilds.find((e) => e.guildId === old.guildId);
          if (!next) fail("proof_shrink");
          try {
            compareGuildDeletion(old, next);
          } catch {
            fail("conflicting_deletion");
          }
        }
      const path = join(directory, fileName(current.meta.id)),
        replay = previous.some((p) => p.meta.sha256 === current.meta.sha256);
      current = admit();
      if (!replay) writeAtomic(directory, path, bytes);
      try {
        current = admit();
        commitDeletionState({
          directory,
          key: master,
          now: clock(),
          incoming: current.meta,
          retirementEvidence,
        });
      } catch (error) {
        if (!replay) {
          regularFile(path);
          unlinkSync(path);
          syncDirectory(directory);
        }
        throw error;
      }
      writeAtomic(
        directory,
        indexPath,
        Buffer.from(JSON.stringify({ ...current.meta, file: fileName(current.meta.id) })),
      );
      for (const name of files)
        if (name !== fileName(current.meta.id)) {
          regularFile(join(directory, name));
          unlinkSync(join(directory, name));
        }
      syncDirectory(directory);
      result = { ...current, replay, file: path };
    } finally {
      await release?.();
    }
    // Lock acquisition/release are asynchronous; neither may carry a decision past its deadline.
    return { ...result, ...admit() };
  } catch (error) {
    if (error instanceof BackupProofError) throw error;
    fail(error.code ?? "operator_block");
  } finally {
    master.fill(0);
  }
}
export { rulesDeletionRetentionMs };
