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
import { transaction } from "./migrations.js";
import { acquireLock } from "./lock.js";
import {
  privateDirectory,
  regularFile,
  syncDirectory,
  withInput,
  writeAll,
} from "./recovery/files.js";
import { acquireDataRootLease, assertRestoreStartupAllowed } from "./recovery/lease.js";
import {
  assertIntegrity,
  currentRecoverySchemaPolicy,
  schemaOf,
  verifySchema,
  type RecoverySchemaPolicy,
} from "./recovery/schema.js";
import { readDeletionLedger, type DeletionLedger } from "./uninstall-retention.js";
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
import type { RulesDeletionInstallation, RulesDeletionStore } from "./rules-deletion-journal.js";

export const rulesDeletionInstallationKey = "retention.rules-deletion-installation";
export const rulesDeletionLifecycleLimits = Object.freeze({
  guilds: 1000,
  entries: 10000,
  bytes: 3 * 1024 * 1024,
});
interface Identity {
  dev: string;
  ino: string;
}
interface Active {
  guildId: string;
  path: string;
  epoch: string;
  admittedAt: number;
  through: number;
  fileIdentity: Identity;
}
interface Admitting {
  guildId: string;
  path: string;
  epoch: string;
  operationId: string;
  mode: "pristine" | "upgrade";
  baseSequence: number;
  startedAt: number;
  expiresAt: number;
  fileIdentity: Identity;
}
interface Retiring extends Active {
  operationId: string;
  removedAt: number;
  startedAt: number;
  expiresAt: number;
}
interface Retired extends DeletionLedger {
  lastEpoch: string;
  through: number;
  expiresAt: number;
}
type GapReason = "admission_expired" | "retirement_expired" | "retirement_evidence_missing";
interface Gap {
  blockedSince: number;
  unsafeBefore: number;
  reason: GapReason;
}
export interface RulesDeletionLifecycleJournal {
  format: 2;
  sourceId: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  coveredFrom: number;
  active: Active[];
  admitting: Admitting[];
  retiring: Retiring[];
  retired: Retired[];
  entries: RulesDeletionEntry[];
  globalGap: Gap | null;
}
export interface RulesDeletionProofScope {
  sourceId: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  coveredFrom: number;
  guildIds: string[];
  entries: RulesDeletionEntry[];
  active: { guildId: string; path: string; epoch: string; through: number }[];
  retired: (DeletionLedger & { expiresAt: number; through: number })[];
  complete: boolean;
  blockers: string[];
}
export interface RulesDeletionLifecycleOwnership {
  /** Internal capability supplied by main, never accepted from a request body. */
  assertHeld(): void;
  assertGuildLease(guildId: string, databasePath: string): void;
  assertQuiescent?(): void;
}
export interface RulesDeletionPruneResult {
  entriesRemoved: number;
  scopesRemoved: number;
  blocked: boolean;
  globalGap: Gap | null;
  sourceId: string;
  sequence: number;
  coveredFrom: number;
  /** Transient matched-unlink evidence only; never serialize expired GIDs into a new report/proof. */
  expiredRetired: RulesDeletionProofScope["retired"];
}
export interface RulesDeletionLifecycleOptions {
  dataRoot: string;
  ownership: RulesDeletionLifecycleOwnership;
  readCanonicalInstallations(): readonly RulesDeletionInstallation[];
  clock?: () => number;
  /** Trusted synchronous policy port; absence never means retirement was approved. */
  mayForgetRetired?: (decision: DeletionLedger, now: number) => boolean;
}
interface Legacy {
  format: 1;
  sourceId: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  coveredFrom: number;
  inventory: { guildId: string; path: string; through: number }[];
  entries: RulesDeletionEntry[];
}
interface Purge {
  format: 1;
  guildId: string;
  removedAt: number;
  phase: string;
  public: boolean;
  databasePath: string;
  databaseIdentity: Identity;
  assetNames: string[];
}
const fail = (code: string): never => {
  throw new RulesDeletionError(code);
};
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === keys.slice().sort().join(",");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const absent = (path: string): boolean => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};
function identity(path: string): Identity {
  regularFile(path);
  const stat = lstatSync(path, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function validIdentity(v: unknown): v is Identity {
  return (
    exact(v, ["dev", "ino"]) &&
    typeof v.dev === "string" &&
    /^\d{1,24}$/.test(v.dev) &&
    typeof v.ino === "string" &&
    /^\d{1,24}$/.test(v.ino)
  );
}
function pathOf(root: string, path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path)) fail("invalid_inventory");
  const tail = relative(root, resolve(path as string)).replaceAll("\\", "/");
  if (
    !/^[a-zA-Z0-9._/-]{1,240}\.sqlite$/.test(tail) ||
    tail.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail("invalid_inventory");
  return tail;
}
function relativePath(path: unknown): void {
  if (
    typeof path !== "string" ||
    !/^[a-zA-Z0-9._/-]{1,240}\.sqlite$/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail("invalid_journal");
}
function json(path: string, maximum: number): unknown {
  return withInput(path, (fd, size) => {
    if (size > maximum) fail("journal_quota");
    const bytes = Buffer.alloc(size);
    let at = 0;
    try {
      while (at < size) {
        const n = readSync(fd, bytes, at, size - at, at);
        if (!n) fail("source_changed");
        at += n;
      }
      return JSON.parse(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
    }
  });
}
function common(value: unknown): void {
  if (!value || typeof value !== "object") fail("invalid_journal");
  const v = value as Record<string, unknown>;
  if (typeof v.sourceId !== "string" || !rulesDeletionUuid.test(v.sourceId))
    fail("invalid_journal");
  for (const field of ["sequence", "createdAt", "updatedAt", "coveredFrom"])
    deletionInteger(v[field]);
  if (v.coveredFrom !== v.createdAt || Number(v.updatedAt) < Number(v.createdAt))
    fail("invalid_journal");
}
function validateLegacy(value: unknown): Legacy {
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
    !Array.isArray(value.inventory) ||
    !value.inventory.length ||
    value.inventory.length > 1000 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 10000
  )
    fail("invalid_journal");
  common(value);
  const j = value as unknown as Legacy,
    guilds = new Set<string>(),
    paths = new Set<string>();
  for (const row of j.inventory) {
    if (!exact(row, ["guildId", "path", "through"])) fail("invalid_journal");
    deletionGuildId(row.guildId);
    relativePath(row.path);
    deletionInteger(row.through);
    if (guilds.has(row.guildId) || paths.has(row.path)) fail("invalid_journal");
    guilds.add(row.guildId);
    paths.add(row.path);
  }
  validateEntries(
    j.entries,
    j.updatedAt,
    guilds,
    new Map(j.inventory.map((i) => [i.guildId, i.through])),
  );
  return j;
}
function validateEntries(
  entries: RulesDeletionEntry[],
  now: number,
  guilds: Set<string>,
  through: Map<string, number>,
): void {
  const ids = new Set<string>(),
    sequences = new Set<string>();
  for (const e of entries) {
    if (!exact(e, ["guildId", "acceptanceId", "retiredAt", "expiresAt", "sequence"]))
      fail("invalid_journal");
    validateRulesDeletion(e);
    const id = e.guildId + ":" + e.acceptanceId,
      seq = e.guildId + ":" + e.sequence;
    if (
      !guilds.has(e.guildId) ||
      ids.has(id) ||
      sequences.has(seq) ||
      e.retiredAt > now ||
      e.sequence > (through.get(e.guildId) ?? 0)
    )
      fail("invalid_journal");
    ids.add(id);
    sequences.add(seq);
  }
}
function validate(value: unknown): RulesDeletionLifecycleJournal {
  if (
    !exact(value, [
      "format",
      "sourceId",
      "sequence",
      "createdAt",
      "updatedAt",
      "coveredFrom",
      "active",
      "admitting",
      "retiring",
      "retired",
      "entries",
      "globalGap",
    ]) ||
    value.format !== 2
  )
    fail("journal_upgrade_required");
  common(value);
  const j = value as unknown as RulesDeletionLifecycleJournal;
  if (
    [j.active, j.admitting, j.retiring, j.retired, j.entries].some((a) => !Array.isArray(a)) ||
    j.entries.length > 10000 ||
    j.active.length + j.admitting.length + j.retiring.length + j.retired.length > 2000
  )
    fail("invalid_journal");
  const current = new Set<string>(),
    paths = new Set<string>(),
    epochs = new Set<string>(),
    all = new Set<string>(),
    through = new Map<string, number>();
  for (const phase of ["active", "admitting", "retiring"] as const)
    for (const row of j[phase]) {
      const activeFields = ["guildId", "path", "epoch", "admittedAt", "through", "fileIdentity"],
        admittingFields = [
          "guildId",
          "path",
          "epoch",
          "operationId",
          "mode",
          "baseSequence",
          "startedAt",
          "expiresAt",
          "fileIdentity",
        ];
      if (
        !exact(
          row,
          phase === "admitting"
            ? admittingFields
            : phase === "active"
              ? activeFields
              : [...activeFields, "operationId", "removedAt", "startedAt", "expiresAt"],
        )
      )
        fail("invalid_journal");
      deletionGuildId(row.guildId);
      relativePath(row.path);
      if (
        !rulesDeletionUuid.test(row.epoch) ||
        !validIdentity(row.fileIdentity) ||
        current.has(row.guildId) ||
        paths.has(row.path) ||
        epochs.has(row.epoch)
      )
        fail("invalid_journal");
      current.add(row.guildId);
      paths.add(row.path);
      epochs.add(row.epoch);
      all.add(row.guildId);
      if (phase === "admitting") {
        const r = row as Admitting;
        deletionInteger(r.baseSequence);
        deletionInteger(r.startedAt);
        deletionInteger(r.expiresAt);
        if (
          !rulesDeletionUuid.test(r.operationId) ||
          !["pristine", "upgrade"].includes(r.mode) ||
          r.expiresAt - r.startedAt !== rulesDeletionRetentionMs ||
          r.startedAt > j.updatedAt
        )
          fail("invalid_journal");
        through.set(r.guildId, Math.max(through.get(r.guildId) ?? 0, r.baseSequence));
      } else {
        const r = row as Active;
        deletionInteger(r.through);
        deletionInteger(r.admittedAt);
        if (r.admittedAt > j.updatedAt) fail("invalid_journal");
        through.set(r.guildId, Math.max(through.get(r.guildId) ?? 0, r.through));
        if (phase === "retiring") {
          const t = row as Retiring;
          deletionInteger(t.startedAt);
          deletionInteger(t.expiresAt);
          deletionInteger(t.removedAt);
          if (
            !rulesDeletionUuid.test(t.operationId) ||
            t.startedAt > j.updatedAt ||
            t.expiresAt - t.startedAt !== rulesDeletionRetentionMs
          )
            fail("invalid_journal");
        }
      }
    }
  const retiredIds = new Set<string>();
  for (const r of j.retired) {
    if (
      !exact(r, [
        "format",
        "guildId",
        "removedAt",
        "purgedAt",
        "outcome",
        "lastEpoch",
        "through",
        "expiresAt",
      ]) ||
      r.format !== 1 ||
      r.outcome !== "purged" ||
      !rulesDeletionUuid.test(r.lastEpoch) ||
      retiredIds.has(r.guildId)
    )
      fail("invalid_journal");
    deletionGuildId(r.guildId);
    for (const n of [r.removedAt, r.purgedAt, r.through, r.expiresAt]) deletionInteger(n);
    if (
      r.removedAt > r.purgedAt ||
      r.purgedAt > j.updatedAt ||
      r.expiresAt - r.purgedAt !== rulesDeletionRetentionMs
    )
      fail("invalid_journal");
    retiredIds.add(r.guildId);
    all.add(r.guildId);
    through.set(r.guildId, Math.max(through.get(r.guildId) ?? 0, r.through));
  }
  if (all.size > 1000) fail("journal_quota");
  validateEntries(j.entries, j.updatedAt, all, through);
  for (const r of j.retired)
    if (
      !current.has(r.guildId) &&
      j.entries.some((e) => e.guildId === r.guildId && e.retiredAt > r.purgedAt)
    )
      fail("invalid_journal");
  if (j.globalGap !== null) {
    const g = j.globalGap;
    if (
      !exact(g, ["blockedSince", "unsafeBefore", "reason"]) ||
      !["admission_expired", "retirement_expired", "retirement_evidence_missing"].includes(g.reason)
    )
      fail("invalid_journal");
    deletionInteger(g.blockedSince);
    deletionInteger(g.unsafeBefore);
    if (g.blockedSince > j.updatedAt || g.unsafeBefore > j.updatedAt) fail("invalid_journal");
  }
  return j;
}

/** Validates an authenticated offline capture without claiming ownership of a live source. */
export function parseRulesDeletionLifecycleJournal(value: unknown): RulesDeletionLifecycleJournal {
  return validate(value);
}

/** Read-only optimistic observation; it does not establish ownership for mutations. */
export function readRulesDeletionLifecycleJournal(dataRoot: string): RulesDeletionLifecycleJournal {
  const root = privateDirectory(resolve(dataRoot));
  assertRestoreStartupAllowed(root);
  const journal = validate(
    json(
      join(root, "rules-acceptance-deletions", "journal.json"),
      rulesDeletionLifecycleLimits.bytes,
    ),
  );
  if (absent(join(root, "uninstall-retention", "source-policy.json")))
    fail("source_policy_missing");
  const policy = json(join(root, "uninstall-retention", "source-policy.json"), 1024);
  if (
    !equal(policy, {
      format: 1,
      kind: "gildiusz-retention-source-policy",
      sourceId: journal.sourceId,
      minimumJournalFormat: 2,
    })
  )
    fail("source_policy_conflict");
  return journal;
}

export class RulesDeletionLifecycle {
  readonly root: string;
  private readonly options: RulesDeletionLifecycleOptions;
  private schemaPolicy: RecoverySchemaPolicy | undefined;
  constructor(options: RulesDeletionLifecycleOptions) {
    if (!isAbsolute(options.dataRoot) || absent(options.dataRoot)) fail("source_unavailable");
    this.root = privateDirectory(resolve(options.dataRoot));
    this.options = options;
    this.owned();
  }
  private owned(): void {
    this.options.ownership.assertHeld();
    assertRestoreStartupAllowed(this.root);
  }
  private now(): number {
    return deletionInteger((this.options.clock ?? Date.now)());
  }
  private file(): string {
    return join(this.root, "rules-acceptance-deletions", "journal.json");
  }
  private policy(sourceId: string, create = false): void {
    const path = join(this.root, "uninstall-retention", "source-policy.json"),
      expected = {
        format: 1,
        kind: "gildiusz-retention-source-policy",
        sourceId,
        minimumJournalFormat: 2,
      };
    if (create && !absent(dirname(path))) {
      privateDirectory(dirname(path));
      const temp = readdirSync(dirname(path)).filter((n) =>
        /^\.source-policy\.[a-f0-9-]{36}\.tmp$/.test(n),
      );
      if (temp.length > 32) fail("journal_quota");
      for (const name of temp)
        if (regularFile(join(dirname(path), name)) > 1024) fail("journal_quota");
      for (const name of temp) unlinkSync(join(dirname(path), name));
      if (temp.length) syncDirectory(dirname(path));
    }
    if (absent(path)) {
      if (!create) fail("source_policy_missing");
      this.atomic(path, expected);
      return;
    }
    const value = json(path, 1024);
    if (
      !exact(value, ["format", "kind", "sourceId", "minimumJournalFormat"]) ||
      !equal(value, expected)
    )
      fail("source_policy_conflict");
  }
  private read(): RulesDeletionLifecycleJournal {
    if (absent(this.file())) fail("source_unavailable");
    return readRulesDeletionLifecycleJournal(this.root);
  }
  private atomic(path: string, value: unknown): void {
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > rulesDeletionLifecycleLimits.bytes) fail("journal_quota");
    const dir = privateDirectory(dirname(path)),
      tmp = join(
        dir,
        (path.endsWith("source-policy.json") ? ".source-policy." : "") + randomUUID() + ".tmp",
      );
    if (!absent(path)) regularFile(path);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeAll(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
      data.fill(0);
    }
    try {
      renameSync(tmp, path);
      syncDirectory(dir);
      syncDirectory(this.root);
    } finally {
      if (!absent(tmp)) unlinkSync(tmp);
    }
  }
  private write(j: RulesDeletionLifecycleJournal): void {
    this.owned();
    validate(j);
    this.policy(j.sourceId);
    this.atomic(this.file(), j);
  }
  private async locked<T>(work: () => T, allowLegacyGap = false, readOnly = false): Promise<T> {
    this.owned();
    const target = join(this.root, ".rules-deletion-journal");
    if (!absent(target)) regularFile(target);
    const release = await acquireLock(target);
    try {
      this.owned();
      if (
        !allowLegacyGap &&
        !absent(join(this.root, "uninstall-retention", "source-gap-unverified.json"))
      )
        fail("unverified_retention_gap");
      if (!allowLegacyGap && !absent(join(this.root, "uninstall-retention", "source-gap.json")))
        fail("legacy_retention_gap");
      const dir = dirname(this.file());
      if (!absent(dir)) {
        privateDirectory(dir);
        const names = readdirSync(dir);
        if (names.length > 33) fail("journal_quota");
        const temp = names.filter(
          (n) => n.endsWith(".tmp") && rulesDeletionUuid.test(n.slice(0, -4)),
        );
        if (names.some((n) => n !== "journal.json" && !temp.includes(n))) fail("operator_block");
        if (readOnly && temp.length) fail("journal_staging_pending");
        for (const name of temp)
          if (regularFile(join(dir, name)) > rulesDeletionLifecycleLimits.bytes)
            fail("journal_quota");
        for (const name of temp) unlinkSync(join(dir, name));
        if (temp.length) syncDirectory(dir);
      }
      return work();
    } finally {
      await release();
    }
  }
  private commit(j: RulesDeletionLifecycleJournal, now: number): void {
    if (now < j.updatedAt) fail("clock_rollback");
    j.updatedAt = now;
    j.sequence = deletionInteger(j.sequence + 1, 1);
    this.write(j);
  }
  private canonical(): { guildId: string; path: string }[] {
    const rows = this.options.readCanonicalInstallations();
    if (!Array.isArray(rows) || rows.length > 1000) fail("invalid_inventory");
    const guilds = new Set<string>(),
      paths = new Set<string>();
    return rows
      .map((row) => {
        const guildId = deletionGuildId(row.guildId),
          path = pathOf(this.root, row.databasePath);
        if (guilds.has(guildId) || paths.has(path)) fail("invalid_inventory");
        guilds.add(guildId);
        paths.add(path);
        return { guildId, path };
      })
      .sort((a, b) => a.guildId.localeCompare(b.guildId));
  }
  private scopedDb<T>(
    guildId: string,
    path: string,
    work: (db: DatabaseSync) => T,
    readOnly = true,
  ): T {
    const absolute = join(this.root, ...path.split("/"));
    this.options.ownership.assertGuildLease(guildId, absolute);
    regularFile(absolute);
    const db = new DatabaseSync(absolute, { readOnly });
    try {
      this.verifyGuild(db, guildId);
      rulesDeletionState(db, guildId);
      return work(db);
    } finally {
      db.close();
    }
  }
  private marker(db: DatabaseSync): unknown {
    const row = db
      .prepare("SELECT kind,id,baseline FROM resources WHERE key=?")
      .get(rulesDeletionInstallationKey);
    if (!row) return null;
    let baseline;
    try {
      baseline = JSON.parse(String(row.baseline));
    } catch {
      fail("invalid_installation_marker");
    }
    if (
      row.kind !== "retention" ||
      typeof row.id !== "string" ||
      !rulesDeletionUuid.test(row.id) ||
      !exact(baseline, ["format", "sourceId", "baseSequence", "admittedAt"]) ||
      baseline.format !== 1 ||
      typeof baseline.sourceId !== "string" ||
      !rulesDeletionUuid.test(baseline.sourceId)
    )
      fail("invalid_installation_marker");
    deletionInteger(baseline.baseSequence);
    deletionInteger(baseline.admittedAt);
    return { epoch: row.id, ...baseline };
  }
  private verifyGuild(db: DatabaseSync, guildId: string): void {
    if (db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !== guildId)
      fail("guild_mismatch");
    this.schemaPolicy ??= currentRecoverySchemaPolicy();
    verifySchema(schemaOf(db, "guild"), this.schemaPolicy.guild);
    for (const table of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'")
      .all()) {
      const name = String(table.name),
        quoted = '"' + name.replaceAll('"', '""') + '"',
        columns = db.prepare(`PRAGMA table_info(${quoted})`).all();
      if (
        columns.some((c) => c.name === "guild_id") &&
        db.prepare(`SELECT 1 FROM ${quoted} WHERE guild_id<>? LIMIT 1`).get(guildId)
      )
        fail("guild_mismatch");
      if (
        ["runtime_settings", "control_configuration"].includes(name) &&
        db.prepare(`SELECT 1 FROM ${quoted} WHERE guild<>? LIMIT 1`).get(guildId)
      )
        fail("guild_mismatch");
    }
  }
  private markerMatches(
    db: DatabaseSync,
    j: RulesDeletionLifecycleJournal,
    row: Active | Admitting,
  ): boolean {
    const m = this.marker(db) as Record<string, unknown> | null;
    return (
      !!m &&
      m.epoch === row.epoch &&
      m.sourceId === j.sourceId &&
      m.admittedAt === ("admittedAt" in row ? row.admittedAt : row.startedAt) &&
      ("through" in row
        ? Number(m.baseSequence) <= row.through
        : m.baseSequence === row.baseSequence)
    );
  }
  private pristine(db: DatabaseSync, retry = false): void {
    const allowed = new Set(["schema_migrations", "guild_identity"]);
    for (const row of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'")
      .all()) {
      const name = String(row.name);
      if (allowed.has(name)) continue;
      if (retry && name === "resources") {
        if (
          db
            .prepare("SELECT 1 FROM resources WHERE key<>? LIMIT 1")
            .get(rulesDeletionInstallationKey)
        )
          fail("not_pristine");
        continue;
      }
      if (retry && name === "server_rules_deletion_state") continue;
      if (db.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get())
        fail("not_pristine");
    }
  }
  private purge(guildId: string): Purge {
    const value = json(
      join(this.root, "uninstall-retention", guildId + ".pending.json"),
      128 * 1024,
    );
    if (
      !exact(value, [
        "format",
        "guildId",
        "removedAt",
        "phase",
        "public",
        "databasePath",
        "databaseIdentity",
        "assetNames",
      ]) ||
      value.format !== 1 ||
      value.guildId !== guildId ||
      typeof value.phase !== "string" ||
      !["committed", "hub_done", "files_done", "registry_done"].includes(value.phase) ||
      typeof value.public !== "boolean" ||
      !validIdentity(value.databaseIdentity) ||
      typeof value.databasePath !== "string" ||
      !Array.isArray(value.assetNames) ||
      value.assetNames.length > 1024 ||
      value.assetNames.some(
        (n) => typeof n !== "string" || !/^([a-f0-9-]{36})\.(png|jpg|webp)$/.test(n),
      )
    )
      fail("purge_not_committed");
    const purge = value as unknown as Purge;
    deletionInteger(purge.removedAt);
    pathOf(this.root, purge.databasePath);
    return purge;
  }
  private ensureFence(checkFence: () => boolean): void {
    this.owned();
    if (checkFence() !== true) fail("operation_obsolete");
  }
  private seed(j: RulesDeletionLifecycleJournal, row: Admitting, db: DatabaseSync): void {
    if (this.now() >= row.expiresAt) fail("lifecycle_expired");
    if (db.isTransaction) fail("uncommitted_source");
    this.verifyGuild(db, row.guildId);
    assertIntegrity(db);
    if (
      db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !== row.guildId
    )
      fail("guild_mismatch");
    if (!equal(identity(join(this.root, ...row.path.split("/"))), row.fileIdentity))
      fail("installation_file_changed");
    const marker = this.marker(db),
      state = rulesDeletionState(db, row.guildId);
    if (marker) {
      if (
        !this.markerMatches(db, j, row) ||
        state.sequence !== row.baseSequence ||
        state.journaledThrough !== row.baseSequence ||
        state.gapAt !== null
      )
        fail("installation_marker_conflict");
      if (row.mode === "pristine") this.pristine(db, true);
      return;
    }
    if (row.mode === "pristine") {
      this.pristine(db);
      if (state.sequence || state.journaledThrough || state.gapAt !== null) fail("not_pristine");
    } else if (
      state.sequence !== row.baseSequence ||
      state.journaledThrough !== row.baseSequence ||
      state.gapAt !== null
    )
      fail("source_incomplete");
    db.exec("PRAGMA synchronous=FULL");
    transaction(db, () => {
      db.prepare("INSERT INTO resources VALUES(?,'retention',?,?)").run(
        rulesDeletionInstallationKey,
        row.epoch,
        JSON.stringify({
          format: 1,
          sourceId: j.sourceId,
          baseSequence: row.baseSequence,
          admittedAt: row.startedAt,
        }),
      );
      db.prepare(
        "INSERT INTO server_rules_deletion_state VALUES(?,?,?,NULL) ON CONFLICT(guild_id) DO NOTHING",
      ).run(row.guildId, row.baseSequence, row.baseSequence);
    });
  }
  private finish(
    j: RulesDeletionLifecycleJournal,
    row: Admitting,
    db: DatabaseSync,
    now: number,
  ): void {
    if (now >= row.expiresAt) fail("lifecycle_expired");
    if (!this.markerMatches(db, j, row)) fail("installation_marker_conflict");
    j.admitting = j.admitting.filter((r) => r !== row);
    j.active.push({
      guildId: row.guildId,
      path: row.path,
      epoch: row.epoch,
      admittedAt: row.startedAt,
      through: row.baseSequence,
      fileIdentity: row.fileIdentity,
    });
    this.commit(j, now);
  }
  async upgradeFormat1(options: {
    checkFence: () => boolean;
    checkpoint?: (
      stage: "policy_durable" | "intents_durable" | "db_seeded" | "active_durable",
    ) => void;
  }): Promise<{ upgraded: boolean }> {
    return this.locked(() => {
      if (!this.options.ownership.assertQuiescent) fail("quiescence_required");
      this.options.ownership.assertQuiescent!();
      this.ensureFence(options.checkFence);
      if (absent(this.file())) fail("source_unavailable");
      const raw = json(this.file(), rulesDeletionLifecycleLimits.bytes);
      if ((raw as { format?: unknown }).format === 2) {
        const j = this.read();
        if (j.admitting.some((r) => r.mode === "upgrade")) fail("upgrade_recovery_required");
        return { upgraded: false };
      }
      const old = validateLegacy(raw),
        now = this.now(),
        canonical = this.canonical();
      if (
        !equal(
          old.inventory
            .map(({ guildId, path }) => ({ guildId, path }))
            .sort((a, b) => a.guildId.localeCompare(b.guildId)),
          canonical,
        )
      )
        fail("inventory_changed");
      const admitting: Admitting[] = old.inventory.map((row) =>
        this.scopedDb(row.guildId, row.path, (db) => {
          const state = rulesDeletionState(db, row.guildId);
          if (
            state.sequence !== row.through ||
            state.journaledThrough !== row.through ||
            state.gapAt !== null ||
            pendingRulesDeletions(db, row.guildId, 1).length
          )
            fail("source_incomplete");
          if (this.marker(db)) fail("installation_marker_conflict");
          return {
            guildId: row.guildId,
            path: row.path,
            epoch: randomUUID(),
            operationId: randomUUID(),
            mode: "upgrade",
            baseSequence: row.through,
            startedAt: now,
            expiresAt: deletionInteger(now + rulesDeletionRetentionMs),
            fileIdentity: identity(join(this.root, ...row.path.split("/"))),
          };
        }),
      );
      this.ensureFence(options.checkFence);
      this.policy(old.sourceId, true);
      options.checkpoint?.("policy_durable");
      const j: RulesDeletionLifecycleJournal = {
        format: 2,
        sourceId: old.sourceId,
        sequence: old.sequence,
        createdAt: old.createdAt,
        updatedAt: old.updatedAt,
        coveredFrom: old.coveredFrom,
        active: [],
        admitting,
        retiring: [],
        retired: [],
        entries: old.entries,
        globalGap: null,
      };
      this.commit(j, now);
      options.checkpoint?.("intents_durable");
      for (const row of [...j.admitting]) {
        this.ensureFence(options.checkFence);
        this.scopedDb(
          row.guildId,
          row.path,
          (db) => {
            this.seed(j, row, db);
            options.checkpoint?.("db_seeded");
            this.ensureFence(options.checkFence);
            this.finish(j, row, db, this.now());
          },
          false,
        );
        options.checkpoint?.("active_durable");
      }
      return { upgraded: true };
    });
  }
  async classifyBeforeOpen(installation: RulesDeletionInstallation): Promise<{
    state: "active" | "admitting" | "retiring" | "retired" | "untracked";
    epoch?: string;
    operationId?: string;
  }> {
    return this.locked(() => {
      const j = this.read(),
        path = pathOf(this.root, installation.databasePath),
        guildId = deletionGuildId(installation.guildId);
      for (const state of ["active", "admitting", "retiring"] as const) {
        const row = j[state].find((r) => r.guildId === guildId);
        if (row) {
          if (row.path !== path) fail("inventory_changed");
          if (state !== "retiring") {
            const absolute = join(this.root, ...path.split("/"));
            if (absent(absolute)) fail("installation_file_missing");
            if (!equal(identity(absolute), row.fileIdentity)) fail("installation_file_changed");
          }
          return {
            state,
            epoch: row.epoch,
            ...("operationId" in row ? { operationId: row.operationId } : {}),
          };
        }
      }
      const retired = j.retired.find((r) => r.guildId === guildId);
      return retired ? { state: "retired", epoch: retired.lastEpoch } : { state: "untracked" };
    });
  }
  async admitPristine(options: {
    guildId: string;
    store: { db: DatabaseSync };
    operationId: string;
    checkFence: () => boolean;
    checkpoint?: (stage: "intent_durable" | "db_seeded" | "active_durable") => void;
  }): Promise<{ epoch: string; baseSequence: number; state: "active" }> {
    return this.locked(() => {
      this.ensureFence(options.checkFence);
      const j = this.read(),
        now = this.now(),
        guildId = deletionGuildId(options.guildId),
        location = options.store.db.location();
      if (!location) fail("invalid_inventory");
      const path = pathOf(this.root, location);
      this.options.ownership.assertGuildLease(guildId, location!);
      if (options.store.db.isTransaction) fail("uncommitted_source");
      this.verifyGuild(options.store.db, guildId);
      assertIntegrity(options.store.db);
      if (!this.canonical().some((r) => r.guildId === guildId && r.path === path))
        fail("inventory_changed");
      if (!rulesDeletionUuid.test(options.operationId)) fail("invalid_input");
      const active = j.active.find((r) => r.guildId === guildId);
      if (active) {
        if (
          active.path !== path ||
          !equal(active.fileIdentity, identity(location!)) ||
          !this.markerMatches(options.store.db, j, active)
        )
          fail("installation_marker_conflict");
        const state = rulesDeletionState(options.store.db, guildId);
        if (state.sequence < active.through || state.journaledThrough < active.through)
          fail("source_gap");
        return {
          epoch: active.epoch,
          baseSequence: Number(
            (this.marker(options.store.db) as { baseSequence: number }).baseSequence,
          ),
          state: "active",
        };
      }
      if (j.retiring.some((r) => r.guildId === guildId)) fail("retirement_pending");
      let row = j.admitting.find((r) => r.guildId === guildId);
      if (row) {
        if (row.operationId !== options.operationId || row.path !== path || row.mode !== "pristine")
          fail("operation_conflict");
      } else {
        this.pristine(options.store.db);
        const baseSequence = Math.max(
          0,
          ...j.entries.filter((e) => e.guildId === guildId).map((e) => e.sequence),
          ...j.retired.filter((e) => e.guildId === guildId).map((e) => e.through),
        );
        row = {
          guildId,
          path,
          epoch: randomUUID(),
          operationId: options.operationId,
          mode: "pristine",
          baseSequence,
          startedAt: now,
          expiresAt: deletionInteger(now + rulesDeletionRetentionMs),
          fileIdentity: identity(location!),
        };
        j.admitting.push(row);
        this.ensureFence(options.checkFence);
        this.commit(j, now);
        options.checkpoint?.("intent_durable");
      }
      this.ensureFence(options.checkFence);
      this.seed(j, row, options.store.db);
      options.checkpoint?.("db_seeded");
      this.ensureFence(options.checkFence);
      this.finish(j, row, options.store.db, this.now());
      options.checkpoint?.("active_durable");
      return { epoch: row.epoch, baseSequence: row.baseSequence, state: "active" };
    });
  }
  async prepareRetirement(options: {
    guildId: string;
    expectedEpoch: string;
    operationId: string;
  }): Promise<{ state: "retiring" | "retired" }> {
    return this.locked(() => {
      const j = this.read(),
        now = this.now(),
        guildId = deletionGuildId(options.guildId);
      if (
        !rulesDeletionUuid.test(options.expectedEpoch) ||
        !rulesDeletionUuid.test(options.operationId)
      )
        fail("invalid_input");
      const completed = j.retired.find(
        (r) => r.guildId === guildId && r.lastEpoch === options.expectedEpoch,
      );
      if (completed && !j.active.some((r) => r.guildId === guildId)) return { state: "retired" };
      const previous = j.retiring.find((r) => r.guildId === guildId),
        active = j.active.find((r) => r.guildId === guildId),
        scope = previous ?? active;
      if (!scope || scope.epoch !== options.expectedEpoch) fail("operation_obsolete");
      const row = scope!;
      this.options.ownership.assertGuildLease(guildId, join(this.root, ...row.path.split("/")));
      const purge = this.purge(guildId);
      if (
        pathOf(this.root, purge.databasePath) !== row.path ||
        !equal(purge.databaseIdentity, row.fileIdentity)
      )
        fail("purge_scope_changed");
      if (previous) {
        if (previous.operationId !== options.operationId || previous.removedAt !== purge.removedAt)
          fail("operation_conflict");
        return { state: "retiring" };
      }
      let through = row.through;
      const absolute = join(this.root, ...row.path.split("/"));
      if (!absent(absolute))
        through = this.scopedDb(guildId, row.path, (db) => {
          if (!equal(identity(absolute), row.fileIdentity) || !this.markerMatches(db, j, row))
            fail("installation_marker_conflict");
          const state = rulesDeletionState(db, guildId);
          if (state.sequence < row.through) fail("source_gap");
          return state.sequence;
        });
      j.active = j.active.filter((r) => r !== row);
      j.retiring.push({
        ...row,
        through,
        operationId: options.operationId,
        removedAt: purge.removedAt,
        startedAt: now,
        expiresAt: deletionInteger(now + rulesDeletionRetentionMs),
      });
      this.commit(j, now);
      return { state: "retiring" };
    });
  }
  async confirmRetired(options: {
    guildId: string;
    expectedEpoch: string;
    operationId: string;
  }): Promise<{ state: "retired" }> {
    return this.locked(() => {
      const j = this.read(),
        now = this.now(),
        guildId = deletionGuildId(options.guildId),
        row = j.retiring.find((r) => r.guildId === guildId);
      if (!row) {
        const old = j.retired.find(
          (r) => r.guildId === guildId && r.lastEpoch === options.expectedEpoch,
        );
        if (old && !j.active.some((r) => r.guildId === guildId)) return { state: "retired" };
        fail("operation_obsolete");
      }
      if (row!.epoch !== options.expectedEpoch || row!.operationId !== options.operationId)
        fail("operation_obsolete");
      const intent = row!,
        absolute = join(this.root, ...intent.path.split("/"));
      if (now >= intent.expiresAt) fail("lifecycle_expired");
      this.options.ownership.assertGuildLease(guildId, absolute);
      const purge = this.purge(guildId),
        proof = readDeletionLedger(this.root, guildId);
      if (
        purge.phase !== "registry_done" ||
        pathOf(this.root, purge.databasePath) !== intent.path ||
        !equal(purge.databaseIdentity, intent.fileIdentity) ||
        purge.removedAt !== intent.removedAt ||
        !proof ||
        proof.removedAt !== intent.removedAt ||
        proof.purgedAt > now ||
        proof.purgedAt < intent.admittedAt
      )
        fail("purge_evidence_missing");
      if ([absolute, absolute + "-wal", absolute + "-shm"].some((p) => !absent(p)))
        fail("purge_not_finished");
      if (j.entries.some((e) => e.guildId === guildId && e.retiredAt > proof!.purgedAt))
        fail("purge_scope_changed");
      const old = j.retired.find((r) => r.guildId === guildId);
      if (old && (proof!.removedAt < old.purgedAt || proof!.purgedAt <= old.purgedAt))
        fail("conflicting_deletion");
      j.retired = j.retired.filter((r) => r.guildId !== guildId);
      j.retired.push({
        ...proof!,
        lastEpoch: intent.epoch,
        through: Math.max(intent.through, old?.through ?? 0),
        expiresAt: deletionInteger(proof!.purgedAt + rulesDeletionRetentionMs),
      });
      j.retiring = j.retiring.filter((r) => r !== intent);
      this.commit(j, now);
      return { state: "retired" };
    });
  }
  async recoverPending(options: {
    checkFence: (guildId: string) => boolean;
    checkpoint?: (stage: "db_seeded" | "active_durable") => void;
  }): Promise<{ admissions: number; retirementsPending: number }> {
    return this.locked(() => {
      const j = this.read();
      let admissions = 0;
      for (const row of [...j.admitting]) {
        if (row.mode === "upgrade") {
          if (!this.options.ownership.assertQuiescent) fail("quiescence_required");
          this.options.ownership.assertQuiescent!();
        }
        this.ensureFence(() => options.checkFence(row.guildId));
        if (!this.canonical().some((r) => r.guildId === row.guildId && r.path === row.path))
          fail("inventory_changed");
        this.scopedDb(
          row.guildId,
          row.path,
          (db) => {
            this.seed(j, row, db);
            options.checkpoint?.("db_seeded");
            this.ensureFence(() => options.checkFence(row.guildId));
            this.finish(j, row, db, this.now());
          },
          false,
        );
        options.checkpoint?.("active_durable");
        admissions++;
      }
      // Retirement needs the explicit trusted purge bridge; absence is never inferred from cache.
      return { admissions, retirementsPending: j.retiring.length };
    });
  }
  private scope(j: RulesDeletionLifecycleJournal, now: number): RulesDeletionProofScope {
    if (now < j.updatedAt) fail("clock_rollback");
    const blockers = new Set<string>();
    if (!absent(join(this.root, "uninstall-retention", "source-gap-unverified.json")))
      blockers.add("unverified_retention_gap");
    if (!absent(join(this.root, "uninstall-retention", "source-gap.json")))
      blockers.add("legacy_retention_gap");
    if (j.globalGap) blockers.add("global_history_gap");
    if (j.admitting.length || j.retiring.length) blockers.add("pending_lifecycle");
    if ([...j.admitting, ...j.retiring, ...j.retired].some((r) => r.expiresAt <= now))
      blockers.add("lifecycle_expiry_pending");
    try {
      if (
        !equal(
          j.active
            .map(({ guildId, path }) => ({ guildId, path }))
            .sort((a, b) => a.guildId.localeCompare(b.guildId)),
          this.canonical(),
        )
      )
        blockers.add("inventory_changed");
    } catch {
      blockers.add("canonical_inventory_unavailable");
    }
    for (const row of j.active) {
      try {
        this.scopedDb(row.guildId, row.path, (db) => {
          if (
            !equal(identity(join(this.root, ...row.path.split("/"))), row.fileIdentity) ||
            !this.markerMatches(db, j, row)
          )
            fail("installation_marker_conflict");
          const state = rulesDeletionState(db, row.guildId);
          if (
            state.gapAt !== null ||
            state.sequence !== row.through ||
            state.journaledThrough !== row.through ||
            pendingRulesDeletions(db, row.guildId, 1).length
          )
            fail("source_incomplete");
          for (const item of db
            .prepare(
              "SELECT acceptance_id,retired_at,expires_at,sequence FROM server_rules_deletion_outbox WHERE guild_id=? AND expires_at>?",
            )
            .all(row.guildId, now)) {
            const e = j.entries.find(
              (e) => e.guildId === row.guildId && e.acceptanceId === item.acceptance_id,
            );
            if (
              !e ||
              e.sequence !== item.sequence ||
              e.retiredAt !== item.retired_at ||
              e.expiresAt !== item.expires_at
            )
              fail("source_gap");
          }
          if (
            db
              .prepare(
                `SELECT 1 FROM server_rules_retired_acceptances r WHERE guild_id=? AND expires_at>? AND NOT EXISTS(SELECT 1 FROM server_rules_deletion_outbox o WHERE o.guild_id=r.guild_id AND o.acceptance_id=r.id) LIMIT 1`,
              )
              .get(row.guildId, now)
          )
            fail("source_gap");
        });
      } catch (error) {
        blockers.add(error instanceof RulesDeletionError ? error.code : "source_unavailable");
      }
    }
    const guildIds = [...new Set([...j.active, ...j.retired].map((r) => r.guildId))].sort();
    return {
      sourceId: j.sourceId,
      sequence: j.sequence,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      coveredFrom: j.coveredFrom,
      guildIds,
      entries: j.entries.filter((e) => e.expiresAt > now),
      active: j.active.map(({ guildId, path, epoch, through }) => ({
        guildId,
        path,
        epoch,
        through,
      })),
      retired: j.retired
        .filter((r) => r.expiresAt > now)
        .map(({ format, guildId, removedAt, purgedAt, outcome, expiresAt, through }) => ({
          format,
          guildId,
          removedAt,
          purgedAt,
          outcome,
          expiresAt,
          through,
        })),
      complete: blockers.size === 0,
      blockers: [...blockers].sort(),
    };
  }
  async snapshot(): Promise<RulesDeletionProofScope> {
    return this.locked(() => this.scope(this.read(), this.now()), true, true);
  }
  /** Explicit seal counter advancement; ordinary status reads never modify the journal. */
  async sealSnapshot(): Promise<RulesDeletionProofScope> {
    return this.locked(() => {
      const j = this.read(),
        now = this.now(),
        scope = this.scope(j, now);
      if (!scope.complete) fail("source_incomplete");
      this.commit(j, now);
      return { ...scope, sequence: j.sequence, updatedAt: j.updatedAt };
    });
  }
  async drainActiveOutbox(options: {
    stores: readonly RulesDeletionStore[];
    limit?: number;
    checkpoint?: (stage: "journal_durable") => void;
  }): Promise<{ written: number; acknowledged: number; pending: boolean }> {
    return this.locked(() => {
      const j = this.read(),
        now = this.now(),
        limit = deletionInteger(options.limit ?? 100, 1);
      if (limit > 1000 || now < j.updatedAt) fail("invalid_input");
      const actual = options.stores
        .map(({ guildId, jobs }) => {
          if (jobs.db.isTransaction) fail("uncommitted_source");
          const location = jobs.db.location();
          if (!location) fail("invalid_inventory");
          return { guildId: deletionGuildId(guildId), path: pathOf(this.root, location) };
        })
        .sort((a, b) => a.guildId.localeCompare(b.guildId));
      if (
        !equal(
          actual,
          j.active
            .map(({ guildId, path }) => ({ guildId, path }))
            .sort((a, b) => a.guildId.localeCompare(b.guildId)),
        )
      )
        fail("inventory_changed");
      let written = 0,
        acknowledged = 0;
      const batches: { db: DatabaseSync; entries: RulesDeletionEntry[] }[] = [];
      for (const row of j.active) {
        const db = options.stores.find((s) => s.guildId === row.guildId)!.jobs.db;
        this.options.ownership.assertGuildLease(
          row.guildId,
          join(this.root, ...row.path.split("/")),
        );
        if (
          !this.markerMatches(db, j, row) ||
          !equal(identity(join(this.root, ...row.path.split("/"))), row.fileIdentity)
        )
          fail("installation_marker_conflict");
        expireRulesDeletions(db, row.guildId, now, 1000);
        if (rulesDeletionState(db, row.guildId).gapAt !== null) fail("source_gap");
        const entries = pendingRulesDeletions(db, row.guildId, Math.max(1, limit - acknowledged));
        for (const e of entries) {
          if (e.expiresAt <= now) fail("source_gap");
          const previous = j.entries.find(
            (p) => p.guildId === e.guildId && p.acceptanceId === e.acceptanceId,
          );
          if (previous) {
            if (!equal(previous, e)) fail("conflicting_deletion");
          } else {
            if (e.sequence !== row.through + 1 || j.entries.length >= 10000) fail("source_gap");
            j.entries.push(e);
            row.through = e.sequence;
            written++;
          }
        }
        batches.push({ db, entries });
        acknowledged += entries.length;
        if (acknowledged >= limit) break;
      }
      if (written) this.commit(j, now);
      options.checkpoint?.("journal_durable");
      this.owned();
      for (const batch of batches) {
        const ackNow = this.now();
        if (ackNow < now) fail("clock_rollback");
        acknowledgeRulesDeletions(batch.db, batch.entries, ackNow);
      }
      return {
        written,
        acknowledged,
        pending: options.stores.some(({ guildId, jobs }) => {
          const s = rulesDeletionState(jobs.db, guildId);
          return s.gapAt !== null || s.sequence !== s.journaledThrough;
        }),
      };
    });
  }
  async pruneExpired(): Promise<RulesDeletionPruneResult> {
    return this.locked(() => {
      const j = this.read(),
        now = this.now();
      if (now < j.updatedAt) fail("clock_rollback");
      const before = j.entries.length;
      j.entries = j.entries.filter((e) => e.expiresAt > now);
      let scopesRemoved = 0;
      const expiredRetired: RulesDeletionProofScope["retired"] = [];
      const gap = (unsafeBefore: number, reason: GapReason) => {
        j.globalGap = {
          blockedSince: Math.min(j.globalGap?.blockedSince ?? now, now),
          unsafeBefore: Math.max(j.globalGap?.unsafeBefore ?? 0, unsafeBefore),
          reason: j.globalGap?.reason ?? reason,
        };
      };
      j.admitting = j.admitting.filter((row) => {
        if (row.expiresAt > now) return true;
        scopesRemoved++;
        gap(row.startedAt, "admission_expired");
        return false;
      });
      j.retiring = j.retiring.filter((row) => {
        if (row.expiresAt > now) return true;
        scopesRemoved++;
        gap(row.startedAt, "retirement_expired");
        return false;
      });
      j.retired = j.retired.filter((row) => {
        if (row.expiresAt > now) return true;
        scopesRemoved++;
        const { format, guildId, removedAt, purgedAt, outcome, expiresAt, through } = row;
        expiredRetired.push({ format, guildId, removedAt, purgedAt, outcome, expiresAt, through });
        const decision: DeletionLedger = {
          format: 1,
          guildId: row.guildId,
          removedAt: row.removedAt,
          purgedAt: row.purgedAt,
          outcome: "purged",
        };
        let approved = false;
        try {
          approved = this.options.mayForgetRetired?.(decision, now) === true;
        } catch {
          /* Incomplete evidence must not extend identifier retention. */
        }
        if (!approved) gap(row.purgedAt, "retirement_evidence_missing");
        return false;
      });
      // Identifier retirement and the GID-free blocker are one durable replacement, never two writes.
      if (scopesRemoved || before !== j.entries.length) this.commit(j, now);
      return {
        entriesRemoved: before - j.entries.length,
        scopesRemoved,
        blocked:
          j.globalGap !== null ||
          !absent(join(this.root, "uninstall-retention", "source-gap-unverified.json")) ||
          !absent(join(this.root, "uninstall-retention", "source-gap.json")),
        globalGap: j.globalGap,
        sourceId: j.sourceId,
        sequence: j.sequence,
        coveredFrom: j.coveredFrom,
        expiredRetired,
      };
    }, true);
  }
  async resolveGlobalGap(
    options: {
      mayResolve?: (gap: Readonly<Gap>) => boolean;
    } = {},
  ): Promise<{ resolved: boolean; sequence: number; blockers: string[] }> {
    return this.locked(() => {
      const j = this.read();
      if (!j.globalGap) return { resolved: false, sequence: j.sequence, blockers: [] };
      const authorized = options.mayResolve?.(Object.freeze({ ...j.globalGap }));
      if (authorized !== true)
        return { resolved: false, sequence: j.sequence, blockers: ["retirement_evidence_missing"] };
      const now = this.now(),
        view = this.scope({ ...j, globalGap: null }, now);
      if (!view.complete) return { resolved: false, sequence: j.sequence, blockers: view.blockers };
      j.globalGap = null;
      this.commit(j, now);
      return { resolved: true, sequence: j.sequence, blockers: [] };
    });
  }
}

export function openRulesDeletionLifecycle(
  options: RulesDeletionLifecycleOptions,
): RulesDeletionLifecycle {
  return new RulesDeletionLifecycle(options);
}
export interface QuiescentRulesDeletionLifecycleOptions {
  dataRoot: string;
  installations: readonly RulesDeletionInstallation[];
  now?: number;
}
async function withQuiescent<T>(
  options: QuiescentRulesDeletionLifecycleOptions,
  work: (port: RulesDeletionLifecycle) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(options.dataRoot) || absent(options.dataRoot)) fail("source_unavailable");
  const root = privateDirectory(resolve(options.dataRoot)),
    releases: (() => Promise<void>)[] = [],
    held = new Set<string>();
  let owned = false;
  try {
    assertRestoreStartupAllowed(root);
    try {
      releases.push(await acquireDataRootLease(root));
      owned = true;
    } catch {
      fail("writer_active");
    }
    if (!Array.isArray(options.installations) || options.installations.length > 1000)
      fail("invalid_inventory");
    const unique = new Set<string>();
    for (const row of [...options.installations].sort((a, b) =>
      a.guildId.localeCompare(b.guildId),
    )) {
      deletionGuildId(row.guildId);
      const path = join(root, ...pathOf(root, row.databasePath).split("/"));
      if (unique.has(row.guildId) || held.has(path)) fail("invalid_inventory");
      unique.add(row.guildId);
      regularFile(path);
      try {
        releases.push(await acquireLock(path, { createTarget: false }));
        held.add(path);
      } catch {
        fail("writer_active");
      }
    }
    const port = openRulesDeletionLifecycle({
      dataRoot: root,
      readCanonicalInstallations: () => options.installations,
      clock: options.now === undefined ? undefined : () => options.now!,
      ownership: {
        assertHeld() {
          if (!owned) fail("writer_active");
        },
        assertGuildLease(_guildId, path) {
          if (!held.has(path)) fail("guild_lease_required");
        },
        assertQuiescent() {
          if (!owned) fail("quiescence_required");
        },
      },
    });
    return await work(port);
  } finally {
    owned = false;
    for (const release of releases.reverse()) await release();
  }
}
export async function snapshotRulesDeletionLifecycle(
  options: QuiescentRulesDeletionLifecycleOptions,
): Promise<RulesDeletionProofScope> {
  return withQuiescent(options, (port) => port.snapshot());
}
export async function sealRulesDeletionLifecycleSnapshot<T = RulesDeletionProofScope>(
  options: QuiescentRulesDeletionLifecycleOptions,
  consume?: (scope: RulesDeletionProofScope, dataRoot: string) => T,
): Promise<T> {
  return withQuiescent(options, async (port) => {
    const scope = await port.sealSnapshot();
    return consume ? consume(scope, port.root) : (scope as T);
  });
}
export async function upgradeRulesDeletionLifecycle(
  options: QuiescentRulesDeletionLifecycleOptions,
): Promise<{ upgraded: boolean }> {
  return withQuiescent(options, (port) => port.upgradeFormat1({ checkFence: () => true }));
}

export async function recoverRulesDeletionLifecycle(
  options: QuiescentRulesDeletionLifecycleOptions,
): Promise<{ admissions: number; retirementsPending: number }> {
  return withQuiescent(options, (port) => port.recoverPending({ checkFence: () => true }));
}

export async function pruneRulesDeletionLifecycle<T = RulesDeletionPruneResult>(
  options: {
    dataRoot: string;
    now?: number;
    mayForgetRetired?: RulesDeletionLifecycleOptions["mayForgetRetired"];
  },
  consume?: (result: RulesDeletionPruneResult, dataRoot: string) => T | Promise<T>,
): Promise<T> {
  if (!isAbsolute(options.dataRoot) || absent(options.dataRoot)) fail("source_unavailable");
  const root = privateDirectory(resolve(options.dataRoot));
  assertRestoreStartupAllowed(root);
  let owned = false,
    release: (() => Promise<void>) | undefined;
  try {
    try {
      release = await acquireDataRootLease(root);
      owned = true;
    } catch {
      fail("writer_active");
    }
    const port = openRulesDeletionLifecycle({
      dataRoot: root,
      clock: options.now === undefined ? undefined : () => options.now!,
      mayForgetRetired: options.mayForgetRetired,
      readCanonicalInstallations: () => [],
      ownership: {
        assertHeld() {
          if (!owned) fail("writer_active");
        },
        assertGuildLease() {
          fail("guild_lease_required");
        },
      },
    });
    const result = await port.pruneExpired();
    return consume ? await consume(result, root) : (result as T);
  } finally {
    owned = false;
    await release?.();
  }
}
