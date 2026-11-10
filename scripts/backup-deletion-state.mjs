import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { backupKey } from "../dist/storage/recovery/archive.js";
import {
  privateDirectory,
  regularFile,
  syncDirectory,
  withInput,
} from "../dist/storage/recovery/files.js";
import { acquireLock } from "../dist/storage/lock.js";

export const deletionStateFile = "deletion-watermark.json";
export const legacyDeletionGapFile = "source-gap.json";
export const unverifiedDeletionGapFile = "source-gap-unverified.json";
export const deletionTerminalAgeMs = 35 * 86400000;
export const deletionEvidenceAgeMs = 86400000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const exact = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...fields].sort().join(",");
export class DeletionStateError extends Error {
  constructor(code) {
    super(code);
    this.name = "DeletionStateError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new DeletionStateError(code);
};
const clone = (value) => globalThis.structuredClone(value);
const plus = (value, offset) => {
  if (!integer(value) || !integer(value + offset)) fail("invalid_time");
  return value + offset;
};
export function deletionDeadline({
  createdAt,
  guilds = [],
  acceptances = [],
  maxAgeMs = deletionTerminalAgeMs,
}) {
  if (
    !integer(maxAgeMs) ||
    maxAgeMs < 1 ||
    maxAgeMs > deletionTerminalAgeMs ||
    !Array.isArray(guilds) ||
    !Array.isArray(acceptances) ||
    guilds.length > 10000 ||
    acceptances.length > 10000
  )
    fail("invalid_time");
  let deadline = plus(createdAt, maxAgeMs);
  for (const entry of guilds)
    deadline = Math.min(deadline, plus(entry.purgedAt, deletionTerminalAgeMs));
  for (const entry of acceptances) {
    if (!integer(entry.expiresAt)) fail("invalid_time");
    deadline = Math.min(deadline, entry.expiresAt);
  }
  return deadline;
}
/** Authenticated issuer validates the installation epoch; consumers enforce these monotonic dates. */
export function compareGuildDeletion(prior, next) {
  const valid = (entry) =>
    exact(entry, ["format", "guildId", "removedAt", "purgedAt", "outcome"]) &&
    entry.format === 1 &&
    /^[0-9]{17,20}$/.test(entry.guildId) &&
    entry.outcome === "purged";
  if (!valid(prior) || !valid(next)) fail("conflicting_deletion");
  if (
    prior.guildId === next.guildId &&
    prior.removedAt === next.removedAt &&
    prior.purgedAt === next.purgedAt
  )
    return "same";
  if (
    prior.guildId !== next.guildId ||
    !integer(prior.removedAt) ||
    !integer(prior.purgedAt) ||
    !integer(next.removedAt) ||
    !integer(next.purgedAt) ||
    next.removedAt < prior.purgedAt ||
    next.purgedAt <= prior.purgedAt ||
    next.purgedAt < next.removedAt
  )
    fail("conflicting_deletion");
  return "superseded";
}
export function assertGlobalDeletionEvidence({
  gap,
  now,
  knownLocationIds,
  locations,
  maxLocationAgeMs,
  canonicalInventory,
}) {
  if (
    !gap ||
    !integer(gap.unsafeBefore) ||
    !integer(now) ||
    !Array.isArray(knownLocationIds) ||
    knownLocationIds.length < 1 ||
    knownLocationIds.length > 32 ||
    knownLocationIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) ||
    new Set(knownLocationIds).size !== knownLocationIds.length ||
    !Array.isArray(locations) ||
    locations.length !== knownLocationIds.length ||
    !integer(maxLocationAgeMs) ||
    maxLocationAgeMs < 1 ||
    maxLocationAgeMs > deletionEvidenceAgeMs
  )
    fail("operator_block");
  const fresh = (value) => integer(value) && value <= now && now - value <= maxLocationAgeMs;
  if (
    !exact(canonicalInventory, ["verifiedAt", "complete", "unknown", "untracked"]) ||
    canonicalInventory.complete !== true ||
    canonicalInventory.unknown !== 0 ||
    canonicalInventory.untracked !== 0 ||
    !fresh(canonicalInventory.verifiedAt)
  )
    fail("operator_block");
  const seen = new Set();
  for (const location of locations) {
    if (
      !location ||
      !knownLocationIds.includes(location.id) ||
      seen.has(location.id) ||
      !fresh(location.verifiedAt) ||
      location.complete !== true ||
      location.unknown !== 0 ||
      location.inProgress !== 0 ||
      !Array.isArray(location.copies) ||
      location.copies.length > 10000
    )
      fail("operator_block");
    seen.add(location.id);
    for (const copy of location.copies)
      if (
        !copy ||
        !uuid.test(copy.id) ||
        !integer(copy.createdAt) ||
        copy.createdAt > now ||
        copy.createdAt <= gap.unsafeBefore ||
        now - copy.createdAt >= deletionTerminalAgeMs
      )
        fail("operator_block");
  }
  return true;
}
function validate(body, now) {
  if (
    !exact(body, [
      "format",
      "kind",
      "sourceId",
      "minSequence",
      "coveredFrom",
      "head",
      "globalGap",
      "updatedAt",
    ]) ||
    body.format !== 1 ||
    body.kind !== "gildiusz-deletion-state" ||
    !integer(now) ||
    !integer(body.updatedAt) ||
    body.updatedAt > now
  )
    fail("invalid_watermark");
  const legacy = body.sourceId === null;
  if (
    legacy
      ? body.minSequence !== null || body.coveredFrom !== null
      : !uuid.test(body.sourceId) ||
        !integer(body.minSequence) ||
        body.minSequence < 1 ||
        !integer(body.coveredFrom)
  )
    fail("invalid_watermark");
  if (
    body.head !== null &&
    (!exact(body.head, ["format", "id", "sha256", "createdAt"]) ||
      ![1, 2].includes(body.head.format) ||
      !uuid.test(body.head.id) ||
      !digest.test(body.head.sha256) ||
      !integer(body.head.createdAt) ||
      body.head.createdAt > body.updatedAt ||
      (legacy
        ? body.head.format !== 1
        : body.head.format !== 2 || body.coveredFrom > body.head.createdAt))
  )
    fail("invalid_watermark");
  if (
    body.globalGap !== null &&
    (!exact(body.globalGap, ["blockedSince", "unsafeBefore", "reason"]) ||
      !integer(body.globalGap.blockedSince) ||
      body.globalGap.blockedSince > body.updatedAt ||
      !integer(body.globalGap.unsafeBefore) ||
      body.globalGap.unsafeBefore > body.updatedAt ||
      !["terminal_expired", "legacy_retention_expired", "source_gap"].includes(
        body.globalGap.reason,
      ))
  )
    fail("invalid_watermark");
  if (legacy && body.head === null && body.globalGap === null) fail("invalid_watermark");
  return body;
}
function keyed(key, forbiddenKeys, work) {
  let master, derived;
  try {
    master = backupKey(key, forbiddenKeys);
    derived = Buffer.from(
      hkdfSync("sha256", master, Buffer.alloc(0), "gildiusz-deletion-watermark-v1", 32),
    );
    return work(derived);
  } finally {
    master?.fill(0);
    derived?.fill(0);
  }
}
const sign = (body, key) => createHmac("sha256", key).update(JSON.stringify(body)).digest("hex");
function readJson(path) {
  regularFile(path);
  const stat = lstatSync(path);
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
  )
    fail("invalid_watermark");
  return withInput(path, (fd, size) => {
    if (size > 4096) fail("invalid_watermark");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count) fail("invalid_watermark");
      offset += count;
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("invalid_watermark");
    }
  });
}
function filePath(directory, filename) {
  if (!isAbsolute(directory) || ![deletionStateFile, legacyDeletionGapFile].includes(filename))
    fail("invalid_input");
  privateDirectory(directory);
  return join(directory, filename);
}
/** Caller owns the directory's import lock or the source-root writer lease. */
export function readDeletionState({
  directory,
  key,
  forbiddenKeys = [],
  now = Date.now(),
  filename = deletionStateFile,
}) {
  const path = filePath(directory, filename);
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return keyed(key, forbiddenKeys, (derived) => {
    const value = readJson(path);
    if (!exact(value, ["format", "body", "hmac"]) || value.format !== 1 || !digest.test(value.hmac))
      fail("invalid_watermark");
    const expected = sign(value.body, derived);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(value.hmac, "hex")))
      fail("watermark_authentication_failed");
    return clone(validate(value.body, now));
  });
}
function atomic(directory, path, value) {
  const temporary = join(directory, `.deletion-state-${randomUUID()}.tmp`);
  let promoted = false;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    privateDirectory(directory);
    try {
      regularFile(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    regularFile(temporary);
    renameSync(temporary, path);
    promoted = true;
    syncDirectory(directory);
  } finally {
    if (!promoted) {
      try {
        unlinkSync(temporary);
      } catch {
        /* An owned unpromoted temporary may require explicit reconciliation after IO failure. */
      }
    }
  }
}
/** No guild identifiers or decision UUIDs survive in this authenticated antirollback state. */
export function commitDeletionState({
  directory,
  key,
  forbiddenKeys = [],
  now = Date.now(),
  filename = deletionStateFile,
  incoming,
  sourceCheckpoint,
  gap,
  retirementEvidence,
}) {
  const path = filePath(directory, filename),
    prior = readDeletionState({ directory, key, forbiddenKeys, now, filename });
  const body = prior
    ? clone(prior)
    : {
        format: 1,
        kind: "gildiusz-deletion-state",
        sourceId: null,
        minSequence: null,
        coveredFrom: null,
        head: null,
        globalGap: null,
        updatedAt: now,
      };
  if (!integer(now) || now < body.updatedAt) fail("clock_rollback");
  if (sourceCheckpoint) {
    const { sourceId, sequence, coveredFrom } = sourceCheckpoint;
    if (
      !uuid.test(sourceId) ||
      !integer(sequence) ||
      sequence < 1 ||
      !integer(coveredFrom) ||
      coveredFrom > now
    )
      fail("invalid_watermark");
    if (
      body.sourceId !== null &&
      (sourceId !== body.sourceId ||
        sequence < body.minSequence ||
        coveredFrom !== body.coveredFrom)
    )
      fail("rollback_detected");
    if (body.sourceId === null || sequence > body.minSequence) body.head = null;
    body.sourceId = sourceId;
    body.minSequence = sequence;
    body.coveredFrom = coveredFrom;
  }
  if (incoming) {
    const { format, id, sha256, createdAt, sourceId, sequence, coveredFrom } = incoming;
    if (
      ![1, 2].includes(format) ||
      !uuid.test(id) ||
      !digest.test(sha256) ||
      !integer(createdAt) ||
      createdAt > now
    )
      fail("invalid_watermark");
    if (
      body.head &&
      (createdAt < body.head.createdAt || (id === body.head.id && sha256 !== body.head.sha256))
    )
      fail("rollback_detected");
    if (format === 1) {
      if (body.sourceId !== null || body.globalGap) fail("source_requires_v2");
    } else {
      if (
        !uuid.test(sourceId) ||
        !integer(sequence) ||
        sequence < 1 ||
        !integer(coveredFrom) ||
        coveredFrom > createdAt
      )
        fail("invalid_watermark");
      if (
        body.sourceId !== null &&
        (sourceId !== body.sourceId ||
          coveredFrom !== body.coveredFrom ||
          sequence < body.minSequence)
      )
        fail("rollback_detected");
      if (body.sourceId !== null && sequence === body.minSequence && body.head?.sha256 !== sha256)
        fail("conflicting_proof");
      body.sourceId = sourceId;
      body.minSequence = sequence;
      body.coveredFrom = coveredFrom;
    }
    body.head = { format, id, sha256, createdAt };
  }
  if (gap) {
    if (
      !integer(gap.unsafeBefore) ||
      gap.unsafeBefore > now ||
      !["terminal_expired", "legacy_retention_expired", "source_gap"].includes(gap.reason)
    )
      fail("invalid_watermark");
    body.globalGap = {
      blockedSince: body.globalGap?.blockedSince ?? now,
      unsafeBefore: Math.max(body.globalGap?.unsafeBefore ?? 0, gap.unsafeBefore),
      reason: body.globalGap?.reason ?? gap.reason,
    };
  } else if (body.globalGap && (incoming?.format === 2 || sourceCheckpoint)) {
    assertGlobalDeletionEvidence({ ...retirementEvidence, gap: body.globalGap, now });
    body.globalGap = null;
  }
  body.updatedAt = now;
  validate(body, now);
  keyed(key, forbiddenKeys, (derived) =>
    atomic(directory, path, { format: 1, body, hmac: sign(body, derived) }),
  );
  return clone(body);
}
export function deletionArtifactHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const deletionImportLock = ".deletion-state-import";
/** Also fences old codec processes; no append-open may follow a planted lock-target link. */
export async function acquireDeletionImportLock(directory) {
  privateDirectory(directory);
  const names = [deletionImportLock, ".deletion-proof-import", ".deletion-ledger-import"],
    releases = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const fd = openSync(path, "wx", 0o600);
      closeSync(fd);
      syncDirectory(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (regularFile(path) !== 0) fail("operator_block");
    const state = lstatSync(path);
    if (
      (process.getuid && state.uid !== process.getuid()) ||
      (process.platform !== "win32" && (state.mode & 0o022) !== 0)
    )
      fail("operator_block");
    try {
      const held = lstatSync(`${path}.lock`);
      if (
        !held.isDirectory() ||
        held.isSymbolicLink() ||
        (process.getuid && held.uid !== process.getuid()) ||
        (process.platform !== "win32" && (held.mode & 0o022) !== 0)
      )
        fail("operator_block");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  try {
    for (const name of names)
      releases.push(await acquireLock(join(directory, name), { createTarget: false }));
    return async () => {
      for (const release of releases.reverse()) await release();
    };
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
}
/** Structural authenticated decoders are supplied by the two codecs; this helper never admits latest. */
export function scanDeletionArtifacts({ directory, decode, now }) {
  privateDirectory(directory);
  const names = readdirSync(directory),
    artifacts = [];
  if (names.length > 32) fail("proof_quota");
  const allowed = new Set([
    deletionStateFile,
    "latest-proof.json",
    "latest-deletion-ledger.json",
    deletionImportLock,
    `${deletionImportLock}.lock`,
    ".deletion-proof-import",
    ".deletion-proof-import.lock",
    ".deletion-ledger-import",
    ".deletion-ledger-import.lock",
  ]);
  for (const name of names) {
    const match = /^deletion-(proof|ledger)-([a-f0-9-]{36})\.(gldproof|gldledger)$/.exec(name);
    if (!match) {
      if (!allowed.has(name)) fail("operator_block");
      const stat = lstatSync(join(directory, name));
      if (
        stat.isSymbolicLink() ||
        (name.endsWith(".lock") ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      )
        fail("operator_block");
      continue;
    }
    if (
      !uuid.test(match[2]) ||
      (match[1] === "proof" ? match[3] !== "gldproof" : match[3] !== "gldledger")
    )
      fail("operator_block");
    const path = join(directory, name);
    const bytes = withInput(path, (fd, size) => {
      if (size > 4 * 1024 * 1024) fail("proof_quota");
      const buffer = Buffer.alloc(size);
      let at = 0;
      while (at < size) {
        const count = readSync(fd, buffer, at, size - at, at);
        if (!count) fail("source_changed");
        at += count;
      }
      return buffer;
    });
    const document = decode(bytes, match[1], now);
    if (document.meta.id !== match[2] || document.meta.sha256 !== deletionArtifactHash(bytes))
      fail("invalid_index");
    artifacts.push({ ...document, name, path, sha256: document.meta.sha256 });
  }
  if (
    artifacts.length > 16 ||
    artifacts.filter((a) => a.meta.format === 1).length > 8 ||
    artifacts.filter((a) => a.meta.format === 2).length > 8
  )
    fail("proof_quota");
  return artifacts;
}
/** Caller holds deletionImportLock. A signed global gap is durable BEFORE any expired payload unlink. */
export function pruneLockedDeletionArtifacts({
  directory,
  key,
  forbiddenKeys = [],
  now = Date.now(),
  decode,
}) {
  let prior = readDeletionState({ directory, key, forbiddenKeys, now });
  const artifacts = scanDeletionArtifacts({ directory, decode, now });
  if (
    prior?.head &&
    !prior.globalGap &&
    !artifacts.some(
      (a) =>
        a.meta.id === prior.head.id &&
        a.meta.sha256 === prior.head.sha256 &&
        a.meta.format === prior.head.format,
    )
  ) {
    // A missing committed payload is unknown loss, not the empty initial state.
    prior = commitDeletionState({
      directory,
      key,
      forbiddenKeys,
      now,
      gap: { unsafeBefore: prior.head.createdAt, reason: "source_gap" },
    });
  }
  const proofs = artifacts
    .filter((a) => a.meta.format === 2)
    .sort((a, b) => a.meta.sequence - b.meta.sequence);
  if (
    proofs.some(
      (a) =>
        a.meta.sourceId !== proofs[0]?.meta.sourceId ||
        a.meta.coveredFrom !== proofs[0]?.meta.coveredFrom,
    ) ||
    (prior?.sourceId && proofs.some((a) => a.meta.sourceId !== prior.sourceId))
  )
    fail("source_changed");
  const expired = artifacts.filter(
    (a) =>
      now >=
      deletionDeadline({
        createdAt: a.meta.createdAt,
        guilds: a.guilds,
        acceptances: a.acceptances,
      }),
  );
  if (!expired.length) return { removed: [], state: prior, artifacts };
  const unsafe = [];
  for (const a of expired) {
    if (now >= plus(a.meta.createdAt, deletionTerminalAgeMs)) unsafe.push(a.meta.createdAt);
    for (const e of a.guilds)
      if (now >= plus(e.purgedAt, deletionTerminalAgeMs)) unsafe.push(e.purgedAt);
    for (const e of a.acceptances) if (now >= e.expiresAt) unsafe.push(e.retiredAt);
  }
  const latest =
    proofs.at(-1) ?? [...artifacts].sort((a, b) => a.meta.createdAt - b.meta.createdAt).at(-1);
  const advance =
    latest &&
    (!prior?.head ||
      (latest.meta.format === 2
        ? prior.sourceId === null || latest.meta.sequence > prior.minSequence
        : prior.sourceId === null && latest.meta.createdAt > prior.head.createdAt));
  const state = commitDeletionState({
    directory,
    key,
    forbiddenKeys,
    now,
    ...(advance ? { incoming: latest.meta } : {}),
    gap: { unsafeBefore: Math.max(...unsafe), reason: "terminal_expired" },
  });
  for (const a of expired) {
    const actual = withInput(a.path, (fd, size) => {
      const hash = createHash("sha256"),
        chunk = Buffer.alloc(65536);
      let at = 0;
      while (at < size) {
        const n = readSync(fd, chunk, 0, Math.min(size - at, chunk.length), at);
        if (!n) fail("source_changed");
        hash.update(chunk.subarray(0, n));
        at += n;
      }
      return hash.digest("hex");
    });
    if (actual !== a.sha256) fail("source_changed");
  }
  for (const a of expired) unlinkSync(a.path);
  for (const name of ["latest-proof.json", "latest-deletion-ledger.json"]) {
    const path = join(directory, name);
    let index;
    try {
      index = readJson(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const old = expired.find(
      (a) => a.name === index?.file && a.meta.id === index.id && a.meta.sha256 === index.sha256,
    );
    if (old) {
      regularFile(path);
      unlinkSync(path);
    }
  }
  syncDirectory(directory);
  return {
    removed: expired.map((a) => a.name),
    state,
    artifacts: artifacts.filter((a) => !expired.includes(a)),
  };
}
