import { randomUUID } from "node:crypto";
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JobStore } from "../core/jobs/store.js";
import {
  acknowledgeRulesDeletions,
  deletionGuildId,
  deletionInteger,
  expireRulesDeletions,
  pendingRulesDeletions,
  RulesDeletionError,
  rulesDeletionRetentionMs,
  rulesDeletionState,
  rulesDeletionUuid,
  validateRulesDeletion,
  type RulesDeletionEntry,
} from "../modules/server-rules/deletion-outbox.js";
import { acquireLock } from "./lock.js";
import {
  privateDirectory,
  regularFile,
  syncDirectory,
  withInput,
  writeAll,
} from "./recovery/files.js";
import { acquireDataRootLease, assertRestoreStartupAllowed } from "./recovery/lease.js";

export interface RulesDeletionInstallation {
  guildId: string;
  databasePath: string;
}
export interface RulesDeletionStore {
  guildId: string;
  jobs: JobStore;
}
interface JournalInventory {
  guildId: string;
  path: string;
  through: number;
}
export interface RulesDeletionJournal {
  format: 1;
  sourceId: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  coveredFrom: number;
  inventory: JournalInventory[];
  entries: RulesDeletionEntry[];
}
export const rulesDeletionJournalLimits = Object.freeze({
  entries: 10000,
  bytes: 3 * 1024 * 1024,
  guilds: 1000,
});
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === fields.slice().sort().join(",");
const fail = (code: string): never => {
  throw new RulesDeletionError(code);
};
const missing = (path: string): boolean => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};
function rootOf(root: string): string {
  if (!isAbsolute(root) || missing(root)) fail("source_unavailable");
  privateDirectory(root);
  assertRestoreStartupAllowed(root);
  return resolve(root);
}
function sourcePath(root: string): string {
  return join(root, "rules-acceptance-deletions", "journal.json");
}
function paths(
  root: string,
  installations: readonly RulesDeletionInstallation[],
): JournalInventory[] {
  if (
    !Array.isArray(installations) ||
    !installations.length ||
    installations.length > rulesDeletionJournalLimits.guilds
  )
    fail("invalid_inventory");
  const guilds = new Set<string>(),
    files = new Set<string>();
  return installations
    .map((installation) => {
      const guildId = deletionGuildId(installation.guildId),
        path = relative(root, resolve(installation.databasePath)).replaceAll("\\", "/");
      if (
        !isAbsolute(installation.databasePath) ||
        guilds.has(guildId) ||
        files.has(path) ||
        !/^[a-zA-Z0-9._/-]{1,240}\.sqlite$/.test(path) ||
        path.split("/").some((p) => !p || p === "." || p === "..")
      )
        fail("invalid_inventory");
      guilds.add(guildId);
      files.add(path);
      regularFile(join(root, ...path.split("/")));
      return { guildId, path, through: 0 };
    })
    .sort((a, b) => a.guildId.localeCompare(b.guildId));
}
function validate(value: unknown): RulesDeletionJournal {
  if (
    !exact(value, [
      "format",
      "sourceId",
      "sequence",
      "createdAt",
      "updatedAt",
      "coveredFrom",
      "inventory",
      "entries",
    ]) ||
    value.format !== 1 ||
    typeof value.sourceId !== "string" ||
    !rulesDeletionUuid.test(value.sourceId) ||
    !Array.isArray(value.inventory) ||
    !value.inventory.length ||
    value.inventory.length > rulesDeletionJournalLimits.guilds ||
    !Array.isArray(value.entries) ||
    value.entries.length > rulesDeletionJournalLimits.entries
  )
    fail("invalid_journal");
  const journal = value as unknown as RulesDeletionJournal;
  for (const n of [journal.sequence, journal.createdAt, journal.updatedAt, journal.coveredFrom])
    deletionInteger(n);
  if (journal.createdAt > journal.updatedAt || journal.coveredFrom !== journal.createdAt)
    fail("invalid_journal");
  const guilds = new Set<string>(),
    files = new Set<string>(),
    ids = new Set<string>(),
    sequences = new Set<string>();
  for (const item of journal.inventory) {
    if (
      !exact(item, ["guildId", "path", "through"]) ||
      typeof item.path !== "string" ||
      !/^[a-zA-Z0-9._/-]{1,240}\.sqlite$/.test(item.path) ||
      item.path.split("/").some((p) => !p || p === "." || p === "..")
    )
      fail("invalid_journal");
    deletionGuildId(item.guildId);
    deletionInteger(item.through);
    if (guilds.has(item.guildId) || files.has(item.path)) fail("invalid_journal");
    guilds.add(item.guildId);
    files.add(item.path);
  }
  for (const entry of journal.entries) {
    if (!exact(entry, ["guildId", "acceptanceId", "retiredAt", "expiresAt", "sequence"]))
      fail("invalid_journal");
    validateRulesDeletion(entry);
    const key = entry.guildId + ":" + entry.acceptanceId,
      sequence = entry.guildId + ":" + entry.sequence;
    if (
      !guilds.has(entry.guildId) ||
      ids.has(key) ||
      sequences.has(sequence) ||
      entry.retiredAt > journal.updatedAt ||
      entry.sequence > journal.inventory.find((i) => i.guildId === entry.guildId)!.through
    )
      fail("invalid_journal");
    ids.add(key);
    sequences.add(sequence);
  }
  return journal;
}
function read(root: string): RulesDeletionJournal {
  const path = sourcePath(root);
  if (missing(path)) fail("source_unavailable");
  return withInput(path, (fd, size) => {
    if (size > rulesDeletionJournalLimits.bytes) fail("journal_quota");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (!count) fail("source_changed");
      offset += count;
    }
    try {
      return validate(JSON.parse(bytes.toString("utf8")));
    } finally {
      bytes.fill(0);
    }
  });
}
function write(root: string, journal: RulesDeletionJournal): void {
  validate(journal);
  const bytes = Buffer.from(JSON.stringify(journal));
  if (bytes.length > rulesDeletionJournalLimits.bytes) fail("journal_quota");
  const path = sourcePath(root),
    directory = privateDirectory(dirname(path)),
    temporary = join(directory, `${randomUUID()}.tmp`);
  if (!missing(path)) regularFile(path);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
    bytes.fill(0);
  }
  try {
    renameSync(temporary, path);
    syncDirectory(directory);
    // Persist the newly created journal directory's entry before any SQLite ACK.
    syncDirectory(root);
  } finally {
    if (!missing(temporary)) unlinkSync(temporary);
  }
}
function compatible(journal: RulesDeletionJournal, inventory: JournalInventory[]): void {
  if (
    JSON.stringify(journal.inventory.map(({ guildId, path }) => ({ guildId, path }))) !==
    JSON.stringify(inventory.map(({ guildId, path }) => ({ guildId, path })))
  )
    fail("inventory_changed");
}
function databaseScope(db: DatabaseSync, guildId: string): void {
  const state = rulesDeletionState(db, guildId);
  if (
    db
      .prepare(
        `SELECT 1 FROM server_rules_deletion_outbox WHERE guild_id=? AND
      (sequence>? OR (journaled_at IS NULL AND sequence<=?) OR (journaled_at IS NOT NULL AND sequence>?)) LIMIT 1`,
      )
      .get(guildId, state.sequence, state.journaledThrough, state.journaledThrough)
  )
    fail("source_gap");
  for (const table of [
    "server_rules_deletion_state",
    "server_rules_deletion_outbox",
    "server_rules_retired_acceptances",
  ])
    if (db.prepare(`SELECT 1 FROM ${table} WHERE guild_id<>? LIMIT 1`).get(guildId))
      fail("guild_mismatch");
  if (
    db
      .prepare(
        `SELECT 1 FROM server_rules_retired_acceptances r WHERE guild_id=? AND NOT EXISTS
      (SELECT 1 FROM server_rules_deletion_outbox o WHERE o.guild_id=r.guild_id AND o.acceptance_id=r.id) LIMIT 1`,
      )
      .get(guildId)
  )
    fail("source_gap");
}
async function locked<T>(root: string, work: () => T | Promise<T>): Promise<T> {
  const target = join(root, ".rules-deletion-journal");
  if (!missing(target)) regularFile(target);
  const release = await acquireLock(target);
  try {
    cleanupJournalTemps(root);
    return await work();
  } finally {
    await release();
  }
}
function cleanupJournalTemps(root: string): void {
  const directory = dirname(sourcePath(root));
  if (missing(directory)) return;
  privateDirectory(directory);
  const names = readdirSync(directory);
  if (names.length > 33) fail("journal_quota");
  const temporary = names.filter(
    (name) => name.endsWith(".tmp") && rulesDeletionUuid.test(name.slice(0, -4)),
  );
  if (names.some((name) => name !== "journal.json" && !temporary.includes(name)))
    fail("operator_block");
  // The lock excludes an in-progress write. An unrenamed temp was never acknowledged in SQLite.
  for (const name of temporary)
    if (regularFile(join(directory, name)) > rulesDeletionJournalLimits.bytes)
      fail("journal_quota");
  for (const name of temporary) unlinkSync(join(directory, name));
  if (temporary.length) syncDirectory(directory);
}
/** Quiescent-only admission. Missing journal is never silently treated as an empty latest proof. */
export async function initializeRulesDeletionJournal(options: {
  dataRoot: string;
  installations: readonly RulesDeletionInstallation[];
  now?: number;
}): Promise<RulesDeletionJournal> {
  return withRulesDeletionSource(options, (root, inventory, databases) =>
    locked(root, () => {
      if (!missing(sourcePath(root))) {
        const journal = read(root);
        compatible(journal, inventory);
        return journal;
      }
      for (const item of inventory)
        if (rulesDeletionState(databases.get(item.guildId)!, item.guildId).journaledThrough !== 0)
          fail("source_missing_history");
      const now = deletionInteger(options.now ?? Date.now()),
        journal: RulesDeletionJournal = {
          format: 1,
          sourceId: randomUUID(),
          sequence: 0,
          createdAt: now,
          updatedAt: now,
          coveredFrom: now,
          inventory,
          entries: [],
        };
      write(root, journal);
      return journal;
    }),
  );
}
function expireJournal(root: string, journal: RulesDeletionJournal, now: number): number {
  if (now < journal.updatedAt) fail("clock_rollback");
  const before = journal.entries.length;
  journal.entries = journal.entries.filter((e) => e.expiresAt > now);
  if (before !== journal.entries.length) {
    journal.updatedAt = now;
    write(root, journal);
  }
  return before - journal.entries.length;
}
/** Local TTL maintenance is independent of missing databases, pending ACKs and source gaps. */
export async function pruneRulesDeletionJournal(options: {
  dataRoot: string;
  now?: number;
}): Promise<number> {
  const root = rootOf(options.dataRoot),
    now = deletionInteger(options.now ?? Date.now());
  return locked(root, () => expireJournal(root, read(root), now));
}
/** Holds the writer root lease and every admitted SQLite lease, without migrating any source. */
async function withRulesDeletionSource<T>(
  options: {
    dataRoot: string;
    installations: readonly RulesDeletionInstallation[];
  },
  work: (
    root: string,
    inventory: JournalInventory[],
    databases: Map<string, DatabaseSync>,
  ) => T | Promise<T>,
): Promise<T> {
  const root = rootOf(options.dataRoot),
    releases: (() => Promise<void>)[] = [],
    databases = new Map<string, DatabaseSync>();
  try {
    try {
      releases.push(await acquireDataRootLease(root));
    } catch {
      fail("writer_active");
    }
    assertRestoreStartupAllowed(root);
    const inventory = paths(root, options.installations);
    for (const item of inventory) {
      const path = join(root, ...item.path.split("/"));
      try {
        releases.push(await acquireLock(path, { createTarget: false }));
      } catch {
        fail("writer_active");
      }
      regularFile(path);
      const db = new DatabaseSync(path, { readOnly: true });
      databases.set(item.guildId, db);
      databaseScope(db, item.guildId);
    }
    return await work(root, inventory, databases);
  } finally {
    for (const db of databases.values()) db.close();
    for (const release of releases.reverse()) await release();
  }
}
/** Safe while the caller owns live SQLite stores; journal fsync always precedes SQLite ACK. */
export async function drainRulesDeletionOutbox(options: {
  dataRoot: string;
  stores: readonly RulesDeletionStore[];
  now?: number;
  limit?: number;
  checkpoint?: (stage: "journal_durable") => void;
}): Promise<{ written: number; acknowledged: number; pending: boolean }> {
  const root = rootOf(options.dataRoot),
    now = deletionInteger(options.now ?? Date.now()),
    limit = deletionInteger(options.limit ?? 100, 1);
  if (limit > 1000) fail("invalid_input");
  const inventory = paths(
    root,
    options.stores.map(({ guildId, jobs }) => {
      if (jobs.db.isTransaction) fail("uncommitted_source");
      const databasePath = jobs.db.location();
      if (!databasePath) throw new RulesDeletionError("invalid_inventory");
      return { guildId, databasePath };
    }),
  );
  return locked(root, () => {
    const journal = read(root);
    compatible(journal, inventory);
    if (now < journal.updatedAt) fail("clock_rollback");
    expireJournal(root, journal, now);
    let written = 0,
      acknowledged = 0;
    const batches: { db: DatabaseSync; entries: RulesDeletionEntry[] }[] = [];
    for (const item of journal.inventory) {
      const db = options.stores.find((s) => s.guildId === item.guildId)!.jobs.db;
      databaseScope(db, item.guildId);
      expireRulesDeletions(db, item.guildId, now, 1000);
      if (rulesDeletionState(db, item.guildId).gapAt !== null) fail("source_gap");
      const entries = pendingRulesDeletions(db, item.guildId, Math.max(1, limit - acknowledged));
      for (const entry of entries) {
        const existing = journal.entries.find(
          (e) => e.guildId === entry.guildId && e.acceptanceId === entry.acceptanceId,
        );
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(entry)) fail("conflicting_deletion");
        } else {
          if (
            entry.sequence !== item.through + 1 ||
            journal.entries.length >= rulesDeletionJournalLimits.entries
          )
            fail("source_gap");
          journal.entries.push(entry);
          item.through = entry.sequence;
          written++;
        }
      }
      batches.push({ db, entries });
      acknowledged += entries.length;
      if (acknowledged >= limit) break;
    }
    journal.updatedAt = now;
    write(root, journal);
    options.checkpoint?.("journal_durable");
    for (const batch of batches) acknowledgeRulesDeletions(batch.db, batch.entries, now);
    return {
      written,
      acknowledged,
      pending: options.stores.some(({ guildId, jobs }) => {
        const state = rulesDeletionState(jobs.db, guildId);
        return state.gapAt !== null || state.journaledThrough !== state.sequence;
      }),
    };
  });
}
/** Complete source read plus monotonic seal sequence. No network or restore activation. */
export async function snapshotRulesDeletionJournal<T>(
  options: {
    dataRoot: string;
    installations: readonly RulesDeletionInstallation[];
    now?: number;
  },
  consume: (journal: RulesDeletionJournal, dataRoot: string) => T,
): Promise<T> {
  return withRulesDeletionSource(options, (root, inventory, databases) =>
    locked(root, () => {
      const journal = read(root),
        now = deletionInteger(options.now ?? Date.now());
      compatible(journal, inventory);
      if (now < journal.updatedAt) fail("clock_rollback");
      expireJournal(root, journal, now);
      for (const item of journal.inventory) {
        const db = databases.get(item.guildId)!,
          state = rulesDeletionState(db, item.guildId);
        if (
          state.gapAt !== null ||
          state.journaledThrough !== state.sequence ||
          state.sequence !== item.through ||
          pendingRulesDeletions(db, item.guildId, 1).length
        )
          fail("source_incomplete");
        for (const row of db
          .prepare("SELECT * FROM server_rules_deletion_outbox WHERE guild_id=? AND expires_at>?")
          .all(item.guildId, now)) {
          const entry = journal.entries.find(
            (e) => e.guildId === item.guildId && e.acceptanceId === row.acceptance_id,
          );
          if (
            !entry ||
            entry.sequence !== row.sequence ||
            entry.retiredAt !== row.retired_at ||
            entry.expiresAt !== row.expires_at
          )
            fail("source_gap");
        }
      }
      journal.entries = journal.entries.filter((e) => e.expiresAt > now);
      journal.sequence = deletionInteger(journal.sequence + 1, 1);
      journal.updatedAt = now;
      write(root, journal);
      return consume(journal, root);
    }),
  );
}
export { rulesDeletionRetentionMs };
