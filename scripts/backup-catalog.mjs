import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { privateDirectory, regularFile, syncDirectory } from "../dist/storage/recovery/files.js";
import { validateOffsiteTransfer } from "./backup-offsite.mjs";

export const backupDayMs = 86400000;
export const backupMaxAgeMs = 35 * backupDayMs;
export const backupMaxBytes = 512 * 1024 * 1024 + 8 * 1024 * 1024 + 56;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const copy = (value) => globalThis.structuredClone(value);

export class BackupError extends Error {
  constructor(code) {
    super(code);
    this.name = "BackupError";
    this.code = code;
  }
}
export function backupFailure(code) {
  throw new BackupError(code);
}
function validId(id) {
  if (typeof id !== "string" || !uuid.test(id)) backupFailure("invalid_backup_id");
}
function privateFile(path, maximum) {
  if (regularFile(path) > maximum) backupFailure("backup_file_budget");
  privateDirectory(dirname(path));
  const stat = lstatSync(path);
  if (
    (process.getuid && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    backupFailure("backup_file_not_private");
  return stat;
}
export async function archiveIdentity(path, maximum = backupMaxBytes) {
  const before = privateFile(path, maximum);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  let size = 0;
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    )
      backupFailure("backup_file_changed");
    const stream = createReadStream(path, { fd, autoClose: false, highWaterMark: 65536 });
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maximum) backupFailure("backup_file_budget");
      hash.update(chunk);
    }
    const after = fstatSync(fd);
    const current = privateFile(path, maximum);
    if (
      after.size !== size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs
    )
      backupFailure("backup_file_changed");
    return { size, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}
function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + "\n", {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, path);
    syncDirectory(resolve(path, ".."));
  } finally {
    rmSync(temporary, { force: true });
  }
}
function validateRecord(entry) {
  validId(entry?.id);
  if (
    !timestamp(entry.createdAt) ||
    entry.expiresAt !== entry.createdAt + backupMaxAgeMs ||
    !timestamp(entry.verifiedAt) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1 ||
    entry.size > backupMaxBytes ||
    !digest.test(entry.sha256) ||
    !["daily", "before-upgrade"].includes(entry.reason) ||
    !["verified", "unknown"].includes(entry.state) ||
    (entry.revision !== null && !revision.test(entry.revision))
  )
    backupFailure("invalid_backup_catalog");
  if (entry.checkpoint !== null) {
    const checkpoint = entry.checkpoint;
    if (
      typeof checkpoint !== "object" ||
      !uuid.test(checkpoint.upgradeId) ||
      !revision.test(checkpoint.revision) ||
      (checkpoint.healthyAt !== null && !timestamp(checkpoint.healthyAt)) ||
      (checkpoint.offsiteAck !== null &&
        (!uuid.test(checkpoint.offsiteAck.locationId) ||
          checkpoint.offsiteAck.sha256 !== entry.sha256 ||
          checkpoint.offsiteAck.upgradeId !== checkpoint.upgradeId ||
          checkpoint.offsiteAck.revision !== checkpoint.revision ||
          !timestamp(checkpoint.offsiteAck.verifiedAt)))
    )
      backupFailure("invalid_backup_catalog");
    if (checkpoint.offsite !== undefined) {
      const transfer = validateOffsiteTransfer(
        checkpoint.offsite,
        checkpoint.offsite?.proof?.createdAt,
      );
      if (
        transfer.backup.id !== entry.id ||
        transfer.backup.sha256 !== entry.sha256 ||
        transfer.backup.createdAt !== entry.createdAt ||
        transfer.backup.size !== entry.size ||
        transfer.upgradeId !== checkpoint.upgradeId ||
        transfer.targetRevision !== checkpoint.revision
      )
        backupFailure("invalid_backup_catalog");
    }
    if (
      checkpoint.offsiteAck?.signedReceipt !== undefined &&
      (typeof checkpoint.offsiteAck.signedReceipt !== "string" ||
        checkpoint.offsiteAck.signedReceipt.length > 12000 ||
        !/^[A-Za-z0-9_-]+$/.test(checkpoint.offsiteAck.signedReceipt))
    )
      backupFailure("invalid_backup_catalog");
  }
  return entry;
}
function utcDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}
function isoWeekStart(time) {
  const day = new Date(utcDay(time) + "T00:00:00.000Z");
  return day.getTime() - ((day.getUTCDay() + 6) % 7) * backupDayMs;
}
export function planBackupRotation(entries, { now, protectedIds = [] }) {
  if (!timestamp(now)) backupFailure("invalid_backup_clock");
  const protectedSet = new Set(protectedIds);
  const valid = entries.map(validateRecord).filter((entry) => entry.state === "verified");
  const eligible = valid.filter((entry) => entry.createdAt <= now && entry.expiresAt > now);
  const newest = [...eligible].sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
  const keep = new Set();
  const days = new Set();
  for (const entry of newest) {
    const date = utcDay(entry.createdAt);
    if (!days.has(date) && days.size < 7) {
      days.add(date);
      keep.add(entry.id);
    }
  }
  const thisWeek = isoWeekStart(now);
  for (let index = 1; index <= 4; index++) {
    const start = thisWeek - index * 7 * backupDayMs;
    const selected = newest.find(
      (entry) => entry.createdAt >= start && entry.createdAt < start + 7 * backupDayMs,
    );
    if (selected) keep.add(selected.id);
  }
  const remove = [],
    retained = [],
    blocked = [];
  for (const entry of entries) {
    if (entry.state !== "verified" || entry.createdAt > now) {
      blocked.push({ id: entry.id, code: "backup_verification_required" });
      continue;
    }
    // Authenticated creation time wins over arrival time, checkpoints and the fresh-copy guard.
    if (entry.expiresAt <= now) {
      remove.push({ id: entry.id, sha256: entry.sha256, size: entry.size, reason: "expired" });
      continue;
    }
    const checkpoint = entry.checkpoint;
    if (
      keep.has(entry.id) ||
      protectedSet.has(entry.id) ||
      now - entry.createdAt < backupDayMs ||
      (checkpoint && (checkpoint.healthyAt === null || checkpoint.offsiteAck === null))
    )
      retained.push(entry.id);
    else remove.push({ id: entry.id, sha256: entry.sha256, size: entry.size, reason: "rotation" });
  }
  return { now, keep: retained, remove, blocked };
}

export class BackupCatalog {
  constructor({ root, clock = Date.now }) {
    this.root = privateDirectory(root);
    this.clock = clock;
    this.archives = privateDirectory(join(this.root, "archives"));
    this.incoming = privateDirectory(join(this.root, "incoming"));
    this.verification = privateDirectory(join(this.root, "verification"));
    this.captures = privateDirectory(join(this.root, "captures"));
    this.path = join(this.root, "catalog.json");
    this.anchor = join(this.root, "catalog-lock");
    try {
      writeFileSync(this.anchor, "", { flag: "wx", mode: 0o600, flush: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    privateFile(this.anchor, 0);
  }
  #read() {
    try {
      privateFile(this.path, 4 * 1024 * 1024);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const value = JSON.parse(readFileSync(this.path, "utf8"));
    if (
      value?.format !== 1 ||
      !uuid.test(value.locationId) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.entries) ||
      value.entries.length > 10000 ||
      new Set(value.entries.map((entry) => entry.id)).size !== value.entries.length ||
      !Array.isArray(value.transfers) ||
      value.transfers.length > 100 ||
      !Array.isArray(value.deleting)
    )
      backupFailure("invalid_backup_catalog");
    value.entries.forEach(validateRecord);
    for (const transfer of value.transfers)
      if (
        !uuid.test(transfer.operationId) ||
        !uuid.test(transfer.id) ||
        !timestamp(transfer.startedAt)
      )
        backupFailure("invalid_backup_catalog");
    for (const deletion of value.deleting)
      if (!uuid.test(deletion.id) || !digest.test(deletion.sha256))
        backupFailure("invalid_backup_catalog");
    return value;
  }
  async #locked(task) {
    privateDirectory(this.root);
    privateFile(this.anchor, 0);
    let fenced = false;
    const release = await lockfile.lock(this.anchor, {
      realpath: false,
      stale: 120000,
      update: 10000,
      retries: 0,
      onCompromised: () => {
        fenced = true;
      },
    });
    const assertFence = () => {
      if (fenced) backupFailure("backup_catalog_fenced");
      privateDirectory(this.root);
      privateFile(this.anchor, 0);
    };
    try {
      const catalog = this.#read() ?? {
        format: 1,
        locationId: randomUUID(),
        revision: 0,
        entries: [],
        transfers: [],
        deleting: [],
      };
      const result = await task(catalog, assertFence);
      assertFence();
      catalog.revision++;
      atomicJson(this.path, catalog);
      return copy(result);
    } finally {
      await release();
    }
  }
  archivePath(id) {
    validId(id);
    return join(this.archives, `${id}.gldbak`);
  }
  #rootProblems() {
    const directories = new Set([
      "archives",
      "incoming",
      "captures",
      "verification",
      "deletion-ledger",
      "catalog-lock.lock",
    ]);
    const files = new Set(["catalog.json", "catalog-lock"]);
    return readdirSync(this.root).flatMap((name) => {
      const state = lstatSync(join(this.root, name));
      if (
        (directories.has(name) && state.isDirectory() && !state.isSymbolicLink()) ||
        (files.has(name) && state.isFile() && !state.isSymbolicLink() && state.nlink === 1)
      )
        return [];
      return [{ code: "unmanaged_backup_root_entry" }];
    });
  }
  async read() {
    return this.#locked((catalog) => catalog);
  }
  async beginTransfer(id) {
    validId(id);
    return this.#locked((catalog) => {
      if (catalog.transfers.some((entry) => entry.id === id))
        backupFailure("backup_transfer_in_progress");
      if (catalog.transfers.length >= 100) backupFailure("backup_transfer_limit");
      const transfer = { operationId: randomUUID(), id, startedAt: this.clock() };
      catalog.transfers.push(transfer);
      return transfer;
    });
  }
  async registerVerified({
    manifest,
    sha256,
    size,
    reason,
    revision: sourceRevision = null,
    checkpoint = null,
    operationId,
  }) {
    const entry = validateRecord({
      id: manifest.id,
      createdAt: manifest.createdAt,
      expiresAt: manifest.createdAt + backupMaxAgeMs,
      verifiedAt: this.clock(),
      sha256,
      size,
      reason,
      revision: sourceRevision,
      checkpoint,
      state: "verified",
    });
    if (entry.createdAt > this.clock()) backupFailure("backup_future_timestamp");
    if (entry.expiresAt <= this.clock()) backupFailure("backup_already_expired");
    return this.#locked(async (catalog, fence) => {
      const present = catalog.entries.find((row) => row.id === entry.id);
      if (
        present &&
        (present.sha256 !== sha256 ||
          present.createdAt !== entry.createdAt ||
          present.size !== size)
      )
        backupFailure("backup_identity_conflict");
      const actual = await archiveIdentity(this.archivePath(entry.id));
      fence();
      if (actual.sha256 !== sha256 || actual.size !== size) backupFailure("backup_hash_mismatch");
      if (
        operationId &&
        !catalog.transfers.some((row) => row.operationId === operationId && row.id === entry.id)
      )
        backupFailure("backup_transfer_fenced");
      if (!present) {
        if (catalog.entries.length >= 10000) backupFailure("backup_catalog_limit");
        catalog.entries.push(entry);
      } else {
        present.state = "verified";
        present.verifiedAt = entry.verifiedAt;
      }
      catalog.transfers = catalog.transfers.filter((row) => row.operationId !== operationId);
      return { ...(present ?? entry), locationId: catalog.locationId };
    });
  }
  async markUpgradeHealthy(id, { upgradeId, revision: targetRevision, sha256 }) {
    return this.#locked(async (catalog, fence) => {
      const entry = catalog.entries.find((row) => row.id === id);
      if (
        !entry?.checkpoint ||
        entry.sha256 !== sha256 ||
        entry.checkpoint.upgradeId !== upgradeId ||
        entry.checkpoint.revision !== targetRevision
      )
        backupFailure("backup_checkpoint_conflict");
      const actual = await archiveIdentity(this.archivePath(id));
      fence();
      if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
        backupFailure("backup_hash_mismatch");
      entry.checkpoint.healthyAt ??= this.clock();
      return entry;
    });
  }
  async confirmArchive(expected) {
    return this.#locked(async (catalog, fence) => {
      const entry = catalog.entries.find((row) => row.id === expected.id);
      if (!entry || entry.state !== "verified") backupFailure("backup_not_found");
      if (
        entry.sha256 !== expected.sha256 ||
        entry.size !== expected.size ||
        entry.createdAt !== expected.createdAt
      )
        backupFailure("backup_identity_conflict");
      if (entry.createdAt > this.clock() || entry.expiresAt <= this.clock())
        backupFailure("backup_already_expired");
      const actual = await archiveIdentity(this.archivePath(entry.id));
      fence();
      if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
        backupFailure("backup_hash_mismatch");
      entry.verifiedAt = this.clock();
      if (entry.expiresAt <= entry.verifiedAt) backupFailure("backup_already_expired");
      return { ...entry, locationId: catalog.locationId };
    });
  }
  async bindOffsiteTransfer(id, transfer) {
    transfer = validateOffsiteTransfer(transfer, this.clock());
    return this.#locked(async (catalog, fence) => {
      const entry = catalog.entries.find((row) => row.id === id);
      if (
        !entry?.checkpoint ||
        transfer.sourceLocationId !== catalog.locationId ||
        transfer.backup.id !== id ||
        transfer.backup.sha256 !== entry.sha256 ||
        transfer.backup.createdAt !== entry.createdAt ||
        transfer.backup.size !== entry.size ||
        transfer.upgradeId !== entry.checkpoint.upgradeId ||
        transfer.targetRevision !== entry.checkpoint.revision
      )
        backupFailure("backup_checkpoint_conflict");
      const previous = entry.checkpoint.offsite;
      if (
        previous &&
        (previous.sourceLocationId !== transfer.sourceLocationId ||
          previous.destinationLocationId !== transfer.destinationLocationId ||
          previous.proof.sourceId !== transfer.proof.sourceId ||
          previous.proof.coveredFrom !== transfer.proof.coveredFrom ||
          transfer.proof.sequence < previous.proof.sequence ||
          (previous.proof.sequence === transfer.proof.sequence &&
            JSON.stringify(previous) !== JSON.stringify(transfer)))
      )
        backupFailure("backup_checkpoint_conflict");
      const actual = await archiveIdentity(this.archivePath(id));
      fence();
      if (actual.sha256 !== entry.sha256 || actual.size !== entry.size)
        backupFailure("backup_hash_mismatch");
      validateOffsiteTransfer(transfer, this.clock());
      if (JSON.stringify(previous) !== JSON.stringify(transfer)) entry.checkpoint.offsiteAck = null;
      entry.checkpoint.offsite = transfer;
      return { ...entry, locationId: catalog.locationId };
    });
  }
  async acknowledgeOffsite(id, ack) {
    return this.#locked((catalog) => {
      const entry = catalog.entries.find((row) => row.id === id);
      if (
        !entry?.checkpoint ||
        ack.upgradeId !== entry.checkpoint.upgradeId ||
        ack.revision !== entry.checkpoint.revision ||
        ack.sha256 !== entry.sha256 ||
        ack.createdAt !== entry.createdAt ||
        ack.size !== entry.size ||
        !uuid.test(ack.locationId) ||
        ack.locationId === catalog.locationId ||
        !timestamp(ack.verifiedAt) ||
        ack.verifiedAt > this.clock()
      )
        backupFailure("backup_replication_conflict");
      if (
        entry.checkpoint.offsite &&
        (ack.locationId !== entry.checkpoint.offsite.destinationLocationId ||
          JSON.stringify(ack.transfer) !== JSON.stringify(entry.checkpoint.offsite) ||
          typeof ack.signedReceipt !== "string" ||
          ack.signedReceipt.length > 12000 ||
          !/^[A-Za-z0-9_-]+$/.test(ack.signedReceipt))
      )
        backupFailure("backup_replication_conflict");
      entry.checkpoint.offsiteAck = {
        locationId: ack.locationId,
        verifiedAt: ack.verifiedAt,
        sha256: ack.sha256,
        upgradeId: ack.upgradeId,
        revision: ack.revision,
        ...(entry.checkpoint.offsite ? { signedReceipt: ack.signedReceipt } : {}),
      };
      return entry;
    });
  }
  async inspectLocation() {
    return this.#locked(async (catalog, fence) => {
      const unknown = this.#rootProblems();
      for (const entry of catalog.entries) {
        try {
          if (entry.createdAt > this.clock()) throw Error();
          const identity = await archiveIdentity(this.archivePath(entry.id));
          if (identity.sha256 !== entry.sha256 || identity.size !== entry.size) throw Error();
        } catch {
          entry.state = "unknown";
        }
        if (entry.state === "unknown")
          unknown.push({ id: entry.id, code: "backup_verification_required" });
        fence();
      }
      const known = new Set(catalog.entries.map((entry) => `${entry.id}.gldbak`));
      for (const name of readdirSync(this.archives))
        if (!known.has(name)) unknown.push({ code: "unmanaged_backup_file" });
      const expectedPartials = new Set(
        catalog.transfers.map((entry) => `${entry.operationId}.part`),
      );
      for (const name of readdirSync(this.incoming))
        if (!expectedPartials.has(name)) unknown.push({ code: "unmanaged_transfer_file" });
      if (readdirSync(this.captures).length) unknown.push({ code: "unfinished_backup_capture" });
      if (readdirSync(this.verification).length)
        unknown.push({ code: "unfinished_backup_verification" });
      return {
        id: catalog.locationId,
        verifiedAt: this.clock(),
        complete:
          unknown.length === 0 && catalog.transfers.length === 0 && catalog.deleting.length === 0,
        unknown: unknown.length + catalog.deleting.length,
        inProgress: catalog.transfers.length,
        copies: catalog.entries.map(({ id, createdAt }) => ({ id, createdAt })),
        problems: unknown,
      };
    });
  }
  async planRotation(options = {}) {
    const location = await this.inspectLocation();
    const catalog = await this.read();
    const plan = planBackupRotation(catalog.entries, { ...options, now: this.clock() });
    return {
      ...plan,
      catalogRevision: catalog.revision,
      locationId: catalog.locationId,
      location,
      nextExpiryAt: catalog.entries.length
        ? Math.min(...catalog.entries.map((entry) => entry.expiresAt))
        : null,
      state: location.complete && !plan.blocked.length ? "ready" : "retention_blocked",
    };
  }
  async applyRotation(plan) {
    return this.#locked(async (catalog, fence) => {
      if (catalog.revision !== plan.catalogRevision || catalog.locationId !== plan.locationId)
        backupFailure("backup_catalog_revision_conflict");
      if (!Array.isArray(plan.remove)) backupFailure("invalid_rotation_plan");
      const current = planBackupRotation(catalog.entries, {
        now: this.clock(),
        protectedIds: plan.keep,
      });
      const allowed = new Map(current.remove.map((entry) => [entry.id, entry]));
      const removed = [],
        blocked = [];
      for (const candidate of plan.remove) {
        const expected = allowed.get(candidate.id),
          entry = catalog.entries.find((row) => row.id === candidate.id);
        if (
          !expected ||
          !entry ||
          expected.sha256 !== candidate.sha256 ||
          expected.size !== candidate.size
        )
          backupFailure("backup_rotation_plan_changed");
        let actual, original;
        try {
          original = privateFile(this.archivePath(entry.id), backupMaxBytes);
          actual = await archiveIdentity(this.archivePath(entry.id));
          if (actual.sha256 !== entry.sha256 || actual.size !== entry.size) throw Error();
        } catch {
          entry.state = "unknown";
          blocked.push({ id: entry.id, code: "backup_verification_required" });
          continue;
        }
        fence();
        // Persist intent before unlink; an interrupted deletion is visible and needs reconciliation.
        catalog.deleting.push({ id: entry.id, sha256: entry.sha256 });
        catalog.revision++;
        atomicJson(this.path, catalog);
        const state = privateFile(this.archivePath(entry.id), backupMaxBytes);
        if (
          state.size !== actual.size ||
          state.ino !== original.ino ||
          state.dev !== original.dev ||
          state.mtimeMs !== original.mtimeMs ||
          state.ctimeMs !== original.ctimeMs
        )
          backupFailure("backup_file_changed");
        fence();
        rmSync(this.archivePath(entry.id));
        syncDirectory(this.archives);
        catalog.entries = catalog.entries.filter((row) => row.id !== entry.id);
        catalog.deleting = catalog.deleting.filter((row) => row.id !== entry.id);
        removed.push(entry.id);
      }
      for (const entry of catalog.entries)
        if (entry.state === "unknown" && !blocked.some((problem) => problem.id === entry.id))
          blocked.push({ id: entry.id, code: "backup_verification_required" });
      const known = new Set(catalog.entries.map((entry) => `${entry.id}.gldbak`));
      if (readdirSync(this.archives).some((name) => !known.has(name)))
        blocked.push({ code: "unmanaged_backup_file" });
      if (catalog.transfers.length || readdirSync(this.incoming).length)
        blocked.push({ code: "unfinished_backup_transfer" });
      if (catalog.deleting.length) blocked.push({ code: "unfinished_backup_deletion" });
      if (readdirSync(this.captures).length) blocked.push({ code: "unfinished_backup_capture" });
      if (readdirSync(this.verification).length)
        blocked.push({ code: "unfinished_backup_verification" });
      blocked.push(...this.#rootProblems());
      return { removed, blocked, state: blocked.length ? "retention_blocked" : "complete" };
    });
  }
}

export function defaultOffsiteDirectory(values = process.env) {
  if (process.platform !== "win32" || !values.LOCALAPPDATA)
    backupFailure("offsite_directory_required");
  return resolve(values.LOCALAPPDATA, "Gildiusz", "Backups");
}
