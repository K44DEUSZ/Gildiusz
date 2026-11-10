import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  lstatSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
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
import {
  acquireDataRootLease,
  assertRestoreStartupAllowed,
} from "../dist/storage/recovery/lease.js";
import {
  assertGlobalDeletionEvidence,
  acquireDeletionImportLock,
  commitDeletionState,
  compareGuildDeletion,
  deletionDeadline,
  deletionStateFile,
  legacyDeletionGapFile,
  pruneLockedDeletionArtifacts,
  readDeletionState,
  unverifiedDeletionGapFile,
} from "./backup-deletion-state.mjs";
import { decodeDeletionProofHistory } from "./backup-proof.mjs";

export const deletionLedgerMaxAgeMs = 35 * 86400000;
export const deletionLedgerMaxEvidenceAgeMs = 86400000;
export const deletionLedgerLimits = Object.freeze({
  entries: 10000,
  envelopeBytes: 2 * 1024 * 1024,
  importFiles: 8,
  locations: 32,
  copiesPerLocation: 10000,
});
const magic = Buffer.from("GLDLED01"),
  headerSize = 36,
  tagSize = 16,
  info = "gildiusz-deletion-ledger-v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const guildId = (value) => typeof value === "string" && /^[0-9]{17,20}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const exact = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === fields.slice().sort().join(",");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const missing = (path) => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
};
export class BackupLedgerError extends Error {
  constructor(code) {
    super(code);
    this.name = "BackupLedgerError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new BackupLedgerError(code);
};
function boundedRead(path, limit) {
  return withInput(path, (fd, size) => {
    if (size > limit) fail("ledger_quota");
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, data, offset, size - offset, offset);
      if (!count) fail("source_unavailable");
      offset += count;
    }
    return data;
  });
}
function optionsClock(now, maxFutureMs = 60000) {
  if (!integer(now) || !integer(maxFutureMs) || maxFutureMs > 60000) fail("invalid_input");
}
function entriesOf(value, createdAt, maxFutureMs = 0) {
  if (!Array.isArray(value) || value.length > deletionLedgerLimits.entries) fail("invalid_ledger");
  const seen = new Set(),
    entries = [];
  for (const row of value) {
    if (
      !exact(row, ["format", "guildId", "removedAt", "purgedAt", "outcome"]) ||
      row.format !== 1 ||
      !guildId(row.guildId) ||
      seen.has(row.guildId) ||
      !integer(row.removedAt) ||
      !integer(row.purgedAt) ||
      !integer(row.purgedAt + deletionLedgerMaxAgeMs) ||
      row.purgedAt < row.removedAt ||
      row.purgedAt > createdAt + maxFutureMs ||
      row.outcome !== "purged"
    )
      fail("invalid_ledger");
    seen.add(row.guildId);
    entries.push({
      format: 1,
      guildId: row.guildId,
      removedAt: row.removedAt,
      purgedAt: row.purgedAt,
      outcome: "purged",
    });
  }
  return entries.sort((a, b) => a.guildId.localeCompare(b.guildId));
}
function bytesOf(value) {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < headerSize + tagSize + 2 ||
    value.byteLength > deletionLedgerLimits.envelopeBytes
  )
    fail("invalid_envelope");
  return Buffer.from(value);
}
function metaOf(envelope, body) {
  return {
    format: 1,
    id: body.id,
    createdAt: body.createdAt,
    count: body.entries.length,
    sha256: digest(envelope),
    size: envelope.length,
  };
}
function encode(entries, key, now) {
  const body = {
    format: 1,
    kind: "gildiusz-latest-deletion-ledger",
    id: randomUUID(),
    createdAt: now,
    entries,
  };
  const plaintext = Buffer.from(JSON.stringify(body)),
    header = Buffer.concat([magic, randomBytes(16), randomBytes(12)]);
  if (plaintext.length + headerSize + tagSize > deletionLedgerLimits.envelopeBytes)
    fail("ledger_quota");
  const derived = Buffer.from(hkdfSync("sha256", key, header.subarray(8, 24), info, 32));
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, header.subarray(24));
    cipher.setAAD(header);
    const envelope = Buffer.concat([
      header,
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { envelope, meta: metaOf(envelope, body) };
  } finally {
    derived.fill(0);
    plaintext.fill(0);
  }
}
function decode(envelope, key, now, maxFutureMs) {
  envelope = bytesOf(envelope);
  if (!envelope.subarray(0, 8).equals(magic)) fail("invalid_envelope");
  const header = envelope.subarray(0, headerSize),
    derived = Buffer.from(hkdfSync("sha256", key, header.subarray(8, 24), info, 32));
  let plaintext;
  try {
    const cipher = createDecipheriv("aes-256-gcm", derived, header.subarray(24));
    cipher.setAAD(header);
    cipher.setAuthTag(envelope.subarray(-tagSize));
    plaintext = Buffer.concat([
      cipher.update(envelope.subarray(headerSize, -tagSize)),
      cipher.final(),
    ]);
  } catch {
    fail("authentication_failed");
  } finally {
    derived.fill(0);
  }
  try {
    let body;
    try {
      body = JSON.parse(plaintext.toString("utf8"));
    } catch {
      fail("invalid_ledger");
    }
    if (
      !exact(body, ["format", "kind", "id", "createdAt", "entries"]) ||
      body.format !== 1 ||
      body.kind !== "gildiusz-latest-deletion-ledger" ||
      !uuid.test(body.id) ||
      !integer(body.createdAt) ||
      body.createdAt > now + maxFutureMs
    )
      fail("invalid_ledger");
    body.entries = entriesOf(body.entries, body.createdAt);
    return { meta: metaOf(envelope, body), entries: body.entries };
  } finally {
    plaintext.fill(0);
  }
}
function keyOf(key, forbiddenKeys) {
  try {
    return backupKey(key, forbiddenKeys);
  } catch {
    fail("invalid_key");
  }
}
function readSourceEntries(dataRoot, now, forPrune = false) {
  if (!forPrune)
    for (const [name, code] of [
      ["source-policy.json", "source_requires_v2"],
      [legacyDeletionGapFile, "source_retention_gap"],
      [deletionStateFile, "source_retention_gap"],
      [unverifiedDeletionGapFile, "unverified_retention_gap"],
    ])
      if (!missing(join(dataRoot, "uninstall-retention", name))) fail(code);
  const directory = join(dataRoot, "uninstall-retention");
  if (missing(directory)) return [];
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("source_unavailable");
  const names = readdirSync(directory);
  if (names.length > deletionLedgerLimits.entries * 2) fail("ledger_quota");
  const entries = [];
  for (const name of names) {
    if (
      forPrune &&
      [
        "source-policy.json",
        legacyDeletionGapFile,
        deletionStateFile,
        unverifiedDeletionGapFile,
      ].includes(name)
    )
      continue;
    const match = /^([0-9]{17,20})\.deleted\.json$/.exec(name),
      pending = /^[0-9]{17,20}\.pending\.json$/.test(name);
    if (!match && !pending) fail("operator_block");
    const path = join(directory, name);
    let row;
    try {
      row = JSON.parse(boundedRead(path, pending ? 128 * 1024 : 1024).toString("utf8"));
    } catch {
      fail("invalid_ledger");
    }
    if (pending) {
      if (
        !exact(row, [
          "format",
          "guildId",
          "removedAt",
          "phase",
          "public",
          "databasePath",
          "databaseIdentity",
          "assetNames",
        ]) ||
        row.format !== 1 ||
        !guildId(row.guildId) ||
        !name.startsWith(`${row.guildId}.`) ||
        !integer(row.removedAt) ||
        row.removedAt > now ||
        typeof row.public !== "boolean" ||
        typeof row.databasePath !== "string" ||
        !isAbsolute(row.databasePath) ||
        !exact(row.databaseIdentity, ["dev", "ino"]) ||
        !/^[0-9]{1,24}$/.test(row.databaseIdentity.dev) ||
        !/^[0-9]{1,24}$/.test(row.databaseIdentity.ino) ||
        !Array.isArray(row.assetNames) ||
        row.assetNames.length > 1024 ||
        row.assetNames.some(
          (value) =>
            typeof value !== "string" ||
            !/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(png|jpg|webp)$/.test(
              value,
            ),
        )
      )
        fail("invalid_ledger");
      if (!["prepared", "committed", "hub_done", "files_done", "registry_done"].includes(row.phase))
        fail("invalid_ledger");
      if (row.phase !== "prepared" && !forPrune) fail("ledger_incomplete");
      continue;
    }
    if (row?.guildId !== match[1]) fail("invalid_ledger");
    entries.push(row);
  }
  return entriesOf(entries, now);
}
export function readDeletionLedgerSourceForProof(dataRoot, now) {
  return readSourceEntries(dataRoot, now);
}

export {
  sealLatestDeletionProof,
  verifyLatestDeletionProof,
  importLatestDeletionProof,
} from "./backup-proof.mjs";

/** Caller keeps its owned pause until this lease-protected latest snapshot is sealed. */
async function withLockedSource(
  { dataRoot, key, forbiddenKeys = [], now = Date.now() },
  task,
  forPrune = false,
) {
  optionsClock(now);
  if (!isAbsolute(dataRoot) || missing(dataRoot) || !lstatSync(dataRoot).isDirectory())
    fail("source_unavailable");
  dataRoot = privateDirectory(dataRoot);
  try {
    assertRestoreStartupAllowed(dataRoot);
  } catch {
    fail("source_quarantined");
  }
  const master = keyOf(key, forbiddenKeys);
  let release;
  try {
    try {
      release = await acquireDataRootLease(dataRoot);
    } catch {
      fail("writer_active");
    }
    try {
      assertRestoreStartupAllowed(dataRoot);
    } catch {
      fail("source_quarantined");
    }
    return task({ dataRoot, master, now, entries: readSourceEntries(dataRoot, now, forPrune) });
  } finally {
    master.fill(0);
    await release?.();
  }
}
export async function sealLatestDeletionLedger(options) {
  return withLockedSource(options, ({ entries, master, now }) => {
    if (entries.some((e) => e.purgedAt + deletionLedgerMaxAgeMs <= now))
      fail("source_retention_expired");
    return encode(entries, master, now);
  });
}
export function verifyLatestDeletionLedger({
  envelope,
  key,
  forbiddenKeys = [],
  now = Date.now(),
  maxAgeMs,
  maxFutureMs = 60000,
}) {
  optionsClock(now, maxFutureMs);
  if (!integer(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > deletionLedgerMaxAgeMs)
    fail("invalid_input");
  const master = keyOf(key, forbiddenKeys);
  try {
    const verified = decode(envelope, master, now, maxFutureMs);
    if (now - verified.meta.createdAt > maxAgeMs) fail("stale_ledger");
    if (now >= deletionDeadline({ createdAt: verified.meta.createdAt, guilds: verified.entries }))
      fail("expired_decision");
    return verified;
  } finally {
    master.fill(0);
  }
}
/** Authenticates history for watermark/TTL; it does not assert freshness or permit restore. */
export function decodeDeletionLedgerHistory({
  envelope,
  key,
  forbiddenKeys = [],
  now = Date.now(),
}) {
  optionsClock(now, 0);
  const master = keyOf(key, forbiddenKeys);
  try {
    return decode(envelope, master, now, 0);
  } finally {
    master.fill(0);
  }
}
function locationEvidence({ knownLocationIds, locations, now, maxLocationAgeMs }) {
  const validId = (value) =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
  if (
    !Array.isArray(knownLocationIds) ||
    !knownLocationIds.length ||
    knownLocationIds.length > deletionLedgerLimits.locations ||
    knownLocationIds.some((id) => !validId(id)) ||
    new Set(knownLocationIds).size !== knownLocationIds.length
  )
    return { reason: "locations_unknown" };
  if (
    !Array.isArray(locations) ||
    locations.length !== knownLocationIds.length ||
    !integer(maxLocationAgeMs) ||
    maxLocationAgeMs < 1 ||
    maxLocationAgeMs > deletionLedgerMaxEvidenceAgeMs
  )
    return { reason: "invalid_location_evidence" };
  const seen = new Set(),
    copies = [];
  for (const location of locations) {
    if (!location || !knownLocationIds.includes(location.id) || seen.has(location.id))
      return { reason: "missing_or_unknown_location" };
    seen.add(location.id);
    if (
      !integer(location.verifiedAt) ||
      location.verifiedAt > now ||
      now - location.verifiedAt > maxLocationAgeMs
    )
      return { reason: "stale_location" };
    if (location.complete !== true || !integer(location.unknown) || !integer(location.inProgress))
      return { reason: "incomplete_location" };
    if (location.unknown) return { reason: "unknown_files" };
    if (location.inProgress) return { reason: "in_progress" };
    if (
      !Array.isArray(location.copies) ||
      location.copies.length > deletionLedgerLimits.copiesPerLocation
    )
      return { reason: "invalid_location_evidence" };
    const ids = new Set();
    for (const copy of location.copies) {
      if (
        !copy ||
        typeof copy.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(copy.id) ||
        ids.has(copy.id) ||
        !integer(copy.createdAt) ||
        copy.createdAt > now ||
        (copy.guildIds !== undefined &&
          (!Array.isArray(copy.guildIds) ||
            copy.guildIds.length > 1000 ||
            copy.guildIds.some((id) => !guildId(id)) ||
            new Set(copy.guildIds).size !== copy.guildIds.length))
      )
        return { reason: "invalid_location_evidence" };
      ids.add(copy.id);
      copies.push(copy);
    }
  }
  return { copies };
}
function legacyEvidence(value, now) {
  if (!value) return { reason: "legacy_classification_required" };
  if (
    !exact(value, ["verifiedAt", "complete", "unknown", "configuredLegacyGuildIds"]) ||
    value.complete !== true ||
    !integer(value.unknown) ||
    value.unknown !== 0 ||
    !Array.isArray(value.configuredLegacyGuildIds) ||
    value.configuredLegacyGuildIds.length > 1000 ||
    value.configuredLegacyGuildIds.some((id) => !guildId(id)) ||
    new Set(value.configuredLegacyGuildIds).size !== value.configuredLegacyGuildIds.length
  )
    return { reason: "legacy_classification_incomplete" };
  if (
    !integer(value.verifiedAt) ||
    value.verifiedAt > now ||
    now - value.verifiedAt > deletionLedgerMaxEvidenceAgeMs
  )
    return { reason: "stale_legacy_classification" };
  return { guildIds: new Set(value.configuredLegacyGuildIds) };
}
/** Both inventories come from trusted operator ports, never an unchecked request body. */
export function assessDeletionLedgerRetention({
  entries,
  now = Date.now(),
  knownLocationIds,
  locations,
  maxLocationAgeMs,
  legacyClassification,
}) {
  optionsClock(now);
  entries = entriesOf(entries, now);
  const evidence = locationEvidence({ knownLocationIds, locations, now, maxLocationAgeMs }),
    legacy = legacyEvidence(legacyClassification, now),
    reason = evidence.reason ?? legacy.reason;
  const decisions = entries.map((entry) => {
    const eligibleAt = entry.purgedAt + deletionLedgerMaxAgeMs;
    if (!Number.isSafeInteger(eligibleAt))
      return {
        guildId: entry.guildId,
        state: "operator_block",
        reason: "invalid_time",
        eligibleAt: null,
      };
    if (now < eligibleAt)
      return { guildId: entry.guildId, state: "keep", reason: "minimum_35_days", eligibleAt };
    if (reason)
      return {
        guildId: entry.guildId,
        state: "operator_block",
        reason,
        eligibleAt,
      };
    if (legacy.guildIds.has(entry.guildId))
      return {
        guildId: entry.guildId,
        state: "operator_block",
        reason: "legacy_configuration_referenced",
        eligibleAt,
      };
    if (
      evidence.copies.some(
        (copy) =>
          copy.createdAt <= entry.purgedAt &&
          (copy.guildIds === undefined || copy.guildIds.includes(entry.guildId)),
      )
    )
      return {
        guildId: entry.guildId,
        state: "operator_block",
        reason: "pre_deletion_copy_remaining",
        eligibleAt,
      };
    return {
      guildId: entry.guildId,
      state: "eligible",
      reason: "no_pre_deletion_copies",
      eligibleAt,
    };
  });
  const state = decisions.some((value) => value.state === "operator_block")
    ? "operator_block"
    : decisions.some((value) => value.state === "keep")
      ? "keep"
      : reason
        ? "operator_block"
        : "eligible";
  return {
    state,
    decisions,
    ...(!decisions.length && reason ? { reason } : {}),
  };
}

/** Explicit operator policy only; no caller is allowed to fabricate the location inventories. */
export async function retireSourceDeletionLedgers(options) {
  const { dataRoot, key, forbiddenKeys = [] } = options,
    now = options.now ?? Date.now();
  optionsClock(now, 0);
  const retirementEvidence = {
    knownLocationIds: options.knownLocationIds,
    locations: options.locations,
    maxLocationAgeMs: options.maxLocationAgeMs,
    canonicalInventory: options.canonicalInventory,
  };
  const approved = (entry, at) => {
    try {
      return assertGlobalDeletionEvidence({
        ...retirementEvidence,
        gap: { unsafeBefore: entry.purgedAt },
        now: at,
      });
    } catch {
      return false;
    }
  };
  const retire = (root, master, entries, lifecycle) => {
    const directory = join(root, "uninstall-retention");
    const terminal = entries.filter((e) => e.purgedAt + deletionLedgerMaxAgeMs <= now);
    const pendingTerminal = terminal.some(
      (e) => !missing(join(directory, `${e.guildId}.pending.json`)),
    );
    const expired = terminal.filter((e) => missing(join(directory, `${e.guildId}.pending.json`)));
    const legacyGap = !missing(join(directory, legacyDeletionGapFile))
      ? readDeletionState({ directory, key: master, now, filename: legacyDeletionGapFile })
      : null;
    const previous = !missing(join(directory, deletionStateFile))
      ? readDeletionState({ directory, key: master, now })
      : null;
    const unverified = !missing(join(directory, unverifiedDeletionGapFile));
    if (!lifecycle && !expired.length) {
      if (pendingTerminal || unverified || legacyGap || previous?.globalGap || previous?.sourceId)
        return {
          state: "operator_block",
          retiredCount: 0,
          remainingCount: entries.length,
          reason: pendingTerminal ? "terminal_pending_cleanup_required" : "source_retention_gap",
        };
      return {
        state: "keep",
        retiredCount: 0,
        remainingCount: entries.length,
        latest: encode(entries, master, now),
      };
    }
    if (lifecycle)
      for (const entry of expired) {
        const witnessed = lifecycle.expiredRetired.some(
          (e) =>
            e.guildId === entry.guildId &&
            e.removedAt === entry.removedAt &&
            e.purgedAt === entry.purgedAt,
        );
        const gap = lifecycle.globalGap ?? previous?.globalGap;
        if (!witnessed && !(gap && entry.purgedAt <= gap.unsafeBefore) && !approved(entry, now))
          fail("operator_block");
      }
    if (!lifecycle) {
      commitDeletionState({
        directory,
        key: master,
        now,
        filename: legacyDeletionGapFile,
        gap: {
          unsafeBefore: Math.max(...expired.map((e) => e.purgedAt)),
          reason: "legacy_retention_expired",
        },
      });
    } else {
      commitDeletionState({
        directory,
        key: master,
        now,
        sourceCheckpoint: lifecycle,
        retirementEvidence,
        ...(lifecycle.globalGap
          ? { gap: { unsafeBefore: lifecycle.globalGap.unsafeBefore, reason: "source_gap" } }
          : {}),
      });
    }
    const files = expired.map((entry) => {
      const path = join(directory, `${entry.guildId}.deleted.json`),
        bytes = boundedRead(path, 1024),
        current = entriesOf([JSON.parse(bytes.toString("utf8"))], now)[0];
      if (JSON.stringify(current) !== JSON.stringify(entry)) fail("source_changed");
      return { path, sha256: digest(bytes) };
    });
    for (const file of files)
      if (digest(boundedRead(file.path, 1024)) !== file.sha256) fail("source_changed");
    for (const file of files) unlinkSync(file.path);
    if (files.length) syncDirectory(directory);
    const remaining = readSourceEntries(root, now, true);
    const blocked =
      pendingTerminal ||
      !lifecycle ||
      lifecycle.blocked ||
      Boolean(lifecycle.globalGap) ||
      Boolean(legacyGap) ||
      unverified;
    return {
      state: blocked ? "operator_block" : files.length ? "retired" : "keep",
      retiredCount: files.length,
      remainingCount: remaining.length,
      ...(blocked
        ? { reason: pendingTerminal ? "terminal_pending_cleanup_required" : "source_retention_gap" }
        : {}),
    };
  };
  if (!missing(join(dataRoot, "uninstall-retention", "source-policy.json"))) {
    const master = keyOf(key, forbiddenKeys);
    try {
      const { pruneRulesDeletionLifecycle } =
        await import("../dist/storage/rules-deletion-lifecycle.js");
      return await pruneRulesDeletionLifecycle(
        { dataRoot, now, mayForgetRetired: approved },
        (result, root) => retire(root, master, readSourceEntries(root, now, true), result),
      );
    } finally {
      master.fill(0);
    }
  }
  return withLockedSource(
    options,
    ({ dataRoot: root, master, entries }) => retire(root, master, entries, null),
    true,
  );
}
const filename = (id) => `deletion-ledger-${id}.gldledger`;
function safeIndex(value) {
  return (
    exact(value, ["format", "id", "createdAt", "count", "sha256", "size", "file"]) &&
    value.format === 1 &&
    uuid.test(value.id) &&
    integer(value.createdAt) &&
    integer(value.count) &&
    value.count <= deletionLedgerLimits.entries &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    integer(value.size) &&
    value.size <= deletionLedgerLimits.envelopeBytes &&
    value.file === filename(value.id)
  );
}
function preserveKnownDecisions(current, previous, retirementEvidence, now) {
  const indexed = new Map(current.entries.map((entry) => [entry.guildId, entry])),
    missingEntries = new Map();
  for (const prior of previous) {
    if (current.meta.id === prior.meta.id && current.meta.sha256 !== prior.meta.sha256)
      fail("id_collision");
    if (current.meta.createdAt < prior.meta.createdAt) fail("rollback_detected");
    if (
      current.meta.createdAt === prior.meta.createdAt &&
      current.meta.sha256 !== prior.meta.sha256 &&
      JSON.stringify(current.entries) !== JSON.stringify(prior.entries)
    )
      fail("conflicting_ledger");
    for (const entry of prior.entries) {
      const next = indexed.get(entry.guildId);
      if (!next) {
        const old = missingEntries.get(entry.guildId);
        if (!old || entry.purgedAt > old.purgedAt) missingEntries.set(entry.guildId, entry);
        continue;
      }
      try {
        compareGuildDeletion(entry, next);
      } catch {
        fail("rollback_detected");
      }
    }
  }
  if (missingEntries.size) {
    if (!retirementEvidence) fail("operator_block");
    const assessment = assessDeletionLedgerRetention({
      ...retirementEvidence,
      entries: [...missingEntries.values()],
      now,
    });
    if (assessment.state !== "eligible") fail("operator_block");
  }
}

function historyDecoder(master) {
  return (bytes, kind, now) => {
    if (kind === "proof") {
      const value = decodeDeletionProofHistory({ envelope: bytes, key: master, now });
      return { ...value, guilds: value.proof.guilds, acceptances: value.proof.acceptances };
    }
    const value = decode(bytes, master, now, 0);
    return { ...value, guilds: value.entries, acceptances: [] };
  };
}
export async function pruneImportedDeletionLedgers(options) {
  const { directory, key, forbiddenKeys = [] } = options,
    master = keyOf(key, forbiddenKeys),
    clock = options.clock ?? (() => options.now ?? Date.now());
  let release;
  try {
    privateDirectory(directory);
    release = await acquireDeletionImportLock(directory);
    const result = pruneLockedDeletionArtifacts({
      directory,
      key: master,
      now: clock(),
      decode: historyDecoder(master),
    });
    return {
      removed: result.removed.length,
      blocked: result.state?.globalGap !== null && Boolean(result.state?.globalGap),
      watermark: result.state,
    };
  } catch (error) {
    if (error instanceof BackupLedgerError) throw error;
    fail(error.code ?? "operator_block");
  } finally {
    master.fill(0);
    await release?.();
  }
}
export async function importLatestDeletionLedger(options) {
  let {
    directory,
    envelope,
    key,
    forbiddenKeys = [],
    maxAgeMs,
    maxFutureMs = 60000,
    retirementEvidence,
  } = options;
  const clock = options.clock ?? (() => options.now ?? Date.now());
  const master = keyOf(key, forbiddenKeys);
  let release, temporary;
  try {
    envelope = bytesOf(envelope);
    directory = privateDirectory(directory);
    try {
      release = await acquireDeletionImportLock(directory);
    } catch {
      fail("import_busy");
    }
    const pruned = pruneLockedDeletionArtifacts({
      directory,
      key: master,
      now: clock(),
      decode: historyDecoder(master),
    });
    if (
      pruned.state?.sourceId ||
      pruned.state?.globalGap ||
      pruned.artifacts.some((a) => a.meta.format === 2)
    )
      fail("source_requires_v2");
    const admit = () =>
      verifyLatestDeletionLedger({ envelope, key: master, now: clock(), maxAgeMs, maxFutureMs });
    let current = admit(),
      now = clock();
    const indexPath = join(directory, "latest-deletion-ledger.json");
    privateDirectory(directory);
    const previous = pruned.artifacts.map((a) => ({ ...a, file: a.name }));
    let existingIndex;
    if (!missing(indexPath)) {
      try {
        existingIndex = JSON.parse(boundedRead(indexPath, 4096).toString("utf8"));
      } catch {
        fail("invalid_index");
      }
      if (!safeIndex(existingIndex)) fail("invalid_index");
      const existing = previous.find((item) => item.file === existingIndex.file);
      if (
        !existing ||
        Object.entries(existing.meta).some(([field, value]) => existingIndex[field] !== value)
      )
        fail("invalid_index");
    }
    preserveKnownDecisions(current, previous, retirementEvidence, now);
    const file = filename(current.meta.id),
      path = join(directory, file),
      already = previous.find((item) => item.file === file);
    if (already && already.meta.sha256 !== current.meta.sha256) fail("id_collision");
    if (!already) {
      temporary = join(directory, `.deletion-ledger-${randomUUID()}.tmp`);
      writeFileSync(temporary, envelope, { flag: "wx", mode: 0o600, flush: true });
      renameSync(temporary, path);
      temporary = undefined;
      syncDirectory(directory);
    }
    current = admit();
    now = clock();
    commitDeletionState({ directory, key: master, now, incoming: current.meta });
    temporary = join(directory, `.deletion-ledger-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify({ ...current.meta, file }) + "\n", {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, indexPath);
    temporary = undefined;
    syncDirectory(directory);
    // Verified old decisions are either preserved in current or retired with complete location evidence.
    for (const prior of previous)
      if (prior.file !== file) {
        regularFile(join(directory, prior.file));
        unlinkSync(join(directory, prior.file));
      }
    syncDirectory(directory);
    await release();
    release = undefined;
    current = admit();
    return { ...current, path, indexPath, replay: existingIndex?.sha256 === current.meta.sha256 };
  } catch (error) {
    if (error instanceof BackupLedgerError) throw error;
    fail(error.code ?? "operator_block");
  } finally {
    master.fill(0);
    try {
      if (temporary) rmSync(temporary, { force: true });
    } finally {
      await release?.();
    }
  }
}
