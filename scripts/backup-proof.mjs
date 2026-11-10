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
  readdirSync,
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
import { acquireLock } from "../dist/storage/lock.js";
import { snapshotRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import {
  rulesDeletionRetentionMs,
  validateRulesDeletion,
} from "../dist/modules/server-rules/deletion-outbox.js";
import {
  readDeletionLedgerSourceForProof,
  assessDeletionLedgerRetention,
} from "./backup-ledger.mjs";

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
    !integer(body.createdAt + deletionProofLimits.maxFreshnessMs) ||
    body.createdAt > now + maxFutureMs ||
    !integer(body.coveredFrom) ||
    body.coveredFrom > body.createdAt ||
    !uuid.test(body.challenge) ||
    body.complete !== true ||
    JSON.stringify(body.coverage) !== JSON.stringify(["guilds", "rules_acceptances"]) ||
    !Array.isArray(body.guildIds) ||
    !body.guildIds.length ||
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
      !body.guildIds.includes(entry.guildId) ||
      entry.retiredAt > body.createdAt ||
      entry.expiresAt <= body.createdAt ||
      ids.has(key) ||
      sequences.has(sequence)
    )
      fail("invalid_proof");
    ids.add(key);
    sequences.add(sequence);
  }
  return body;
}
function metadata(bytes, body) {
  return {
    format: 2,
    id: body.id,
    sourceId: body.sourceId,
    sequence: body.sequence,
    createdAt: body.createdAt,
    expiresAt: Math.min(
      body.createdAt + deletionProofLimits.maxFreshnessMs,
      ...body.acceptances.map((entry) => entry.expiresAt),
    ),
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
export async function sealLatestDeletionProof({
  dataRoot,
  installations,
  key,
  forbiddenKeys = [],
  now = Date.now(),
  notBefore,
  challenge,
}) {
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
    return await snapshotRulesDeletionJournal({ dataRoot, installations, now }, (journal, root) => {
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
        guildIds: journal.inventory.map((i) => i.guildId),
        guilds: readDeletionLedgerSourceForProof(root, now),
        acceptances: journal.entries,
      };
      validate(body, now, 0);
      return encode(body, master);
    });
  } finally {
    master.fill(0);
  }
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
    if (proof.acceptances.some((entry) => entry.expiresAt <= now)) fail("expired_decision");
    if (expectedSourceId !== undefined && proof.sourceId !== expectedSourceId)
      fail("source_changed");
    if (proof.sequence < minSequence) fail("rollback_detected");
    if (challenge !== undefined && proof.challenge !== challenge) fail("challenge_mismatch");
    return result;
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
    if (!proof.guildIds.includes(id) && !proof.guilds.some((e) => e.guildId === id))
      fail("inventory_changed");
  const missing = [];
  for (const entry of old.guilds) {
    const next = proof.guilds.find((e) => e.guildId === entry.guildId);
    if (next && JSON.stringify(next) !== JSON.stringify(entry)) fail("conflicting_deletion");
    if (!next) missing.push(entry);
  }
  if (
    missing.length &&
    assessDeletionLedgerRetention({ ...retirementEvidence, entries: missing, now }).state !==
      "eligible"
  )
    fail("proof_shrink");
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
    clock = () => options.now ?? Date.now(),
    admit = () => verifyLatestDeletionProof({ ...verification, now: clock() });
  let release, result;
  try {
    let current = admit();
    durablePrivateDirectory(directory);
    try {
      release = await acquireLock(join(directory, ".deletion-proof-import"));
      current = admit();
      const now = clock();
      const names = readdirSync(directory),
        files = names.filter((n) => /^deletion-proof-[a-f0-9-]{36}\.gldproof$/.test(n));
      if (
        files.length > deletionProofLimits.importFiles ||
        names.length > deletionProofLimits.importFiles + 4
      )
        fail("proof_quota");
      for (const name of names)
        if (
          !files.includes(name) &&
          !["latest-proof.json", ".deletion-proof-import", ".deletion-proof-import.lock"].includes(
            name,
          )
        )
          fail("operator_block");
      const previous = files.map((name) => {
        const result = decode(
          readBounded(join(directory, name), deletionProofLimits.envelopeBytes),
          master,
          now,
          0,
        );
        if (fileName(result.meta.id) !== name) fail("invalid_index");
        return result;
      });
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
        if (
          !exact(index, [...Object.keys(current.meta), "file"]) ||
          !previous.some(
            (p) =>
              JSON.stringify({ ...p.meta, file: fileName(p.meta.id) }) === JSON.stringify(index),
          )
        )
          fail("invalid_index");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const prior of previous) preserve(current, prior, now, retirementEvidence);
      const path = join(directory, fileName(current.meta.id)),
        replay = previous.some((p) => p.meta.sha256 === current.meta.sha256);
      current = admit();
      if (!replay) writeAtomic(directory, path, bytes);
      try {
        current = admit();
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
  } finally {
    master.fill(0);
  }
}
export { rulesDeletionRetentionMs };
