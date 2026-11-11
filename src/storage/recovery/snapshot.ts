import { DatabaseSync, backup } from "node:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { GuildInstallation } from "../../installations.js";
import { acquireLock } from "../lock.js";
import {
  assertRecoverySourceLease,
  assertRecoveryDatabaseLease,
  assertRecoverySnapshotLease,
  type RecoverySourceLease,
} from "./source-lease.js";
import {
  acquireDataRootLease,
  assertRestoreStartupAllowed,
  assertSourcePreparationComplete,
  restoreQuarantineFile,
} from "./lease.js";
import { backupKey, decryptArchive, encryptArchive, manifestLimit } from "./archive.js";
import { assertRecoveryArchiveAge } from "./age.js";
import {
  copyPrivate,
  hashFile,
  inside,
  privateDirectory,
  regularFile,
  safeRelativePath,
  syncDirectory,
  withInput,
  writeAll,
} from "./files.js";
import {
  assertIntegrity,
  currentRecoverySchemaPolicy,
  quarantineDatabase,
  schemaOf,
  verifySchema,
  type RecoverySchema,
  type RecoverySchemaPolicy,
} from "./schema.js";

interface FileEntry {
  path: string;
  size: number;
  sha256: string;
  kind: "guild" | "hub" | "web" | "configuration" | "asset";
  guildId?: string;
  schema?: RecoverySchema;
}
export interface SnapshotManifest {
  format: 1;
  id: string;
  createdAt: number;
  release: string | null;
  guilds: {
    guildId: string;
    ownerId: string;
    public: boolean;
    databasePath: string;
    configPath: string | null;
  }[];
  files: FileEntry[];
  webSessionsRemoved: boolean;
}
export interface SnapshotOptions {
  dataRoot: string;
  guilds: readonly GuildInstallation[];
  hubDatabasePath?: string;
  assetsRoot?: string;
  registryPath?: string;
  webDatabasePath?: string;
  outputPath: string;
  key: Uint8Array | string;
  forbiddenKeys?: readonly (Uint8Array | string)[];
  release?: string;
  maxBytes?: number;
  maxFiles?: number;
  schemaPolicy?: RecoverySchemaPolicy;
}
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{17,20}$/.test(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const formats: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const defaults = { maxBytes: 512 * 1024 * 1024, maxFiles: 10000 };

function budgets(options: { maxBytes?: number; maxFiles?: number }) {
  const maxBytes = options.maxBytes ?? defaults.maxBytes,
    maxFiles = options.maxFiles ?? defaults.maxFiles;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 16 * 1024 * 1024 * 1024 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 100000
  )
    throw new Error("Invalid recovery size budget.");
  return { maxBytes, maxFiles };
}
function safeJson(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) safeJson(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /(?:token|secret|password|credential|authorization|cookie|private.?key|api.?key)/i.test(key)
    )
      throw new Error("Configuration contains credentials and cannot enter a data snapshot.");
    safeJson(item);
  }
}
function loadSafeJson(path: string): unknown {
  if (regularFile(path) > 1024 * 1024) throw new Error("Recovery JSON size budget exceeded.");
  const body: unknown = JSON.parse(readFileSync(path, "utf8"));
  safeJson(body);
  return body;
}
function writeJson(path: string, body: unknown): void {
  privateDirectory(dirname(path));
  writeFileSync(path, JSON.stringify(body) + "\n", { flag: "wx", mode: 0o600, flush: true });
}
function fileExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function deletionLedgers(dataRoot: string): { path: string; value: unknown }[] {
  const directory = join(dataRoot, "uninstall-retention");
  if (!fileExists(directory)) return [];
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Invalid deletion ledger directory.");
  const result: { path: string; value: unknown }[] = [];
  for (const name of readdirSync(directory)) {
    if (/^[0-9]{17,20}\.pending\.json$/.test(name)) {
      const pending = loadSafeJson(join(directory, name)) as { phase?: string };
      if (pending.phase !== "prepared")
        throw new Error("A committed uninstall wipe must finish before a complete snapshot.");
    }
    const match = /^([0-9]{17,20})\.deleted\.json$/.exec(name);
    if (!match) continue;
    const value = loadSafeJson(join(directory, name));
    verifyDeletionLedger(value, match[1]);
    result.push({ path: `uninstall-retention/${name}`, value });
  }
  return result;
}
function verifyDeletionLedger(value: unknown, guildId: string): void {
  const row = value as {
    format?: unknown;
    guildId?: unknown;
    removedAt?: unknown;
    purgedAt?: unknown;
    outcome?: unknown;
  };
  if (
    !row ||
    typeof row !== "object" ||
    row.format !== 1 ||
    row.guildId !== guildId ||
    !Number.isSafeInteger(row.removedAt) ||
    Number(row.removedAt) < 0 ||
    !Number.isSafeInteger(row.purgedAt) ||
    Number(row.purgedAt) < Number(row.removedAt) ||
    row.outcome !== "purged" ||
    Object.keys(row).sort().join(",") !== "format,guildId,outcome,purgedAt,removedAt"
  )
    throw new Error("Invalid snapshot deletion ledger.");
}
function inspectGuild(db: DatabaseSync, guildId: string): void {
  if (db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !== guildId)
    throw new Error("Recovery database belongs to another guild.");
  for (const table of [
    "jobs",
    "announcements",
    "meetings",
    "cases",
    "guild_module_settings",
    "announcement_assets",
    "announcement_asset_refs",
    "announcement_asset_uploads",
    "case_messages",
    "case_votes",
    "case_events",
    "case_actions",
    "domain_retired",
    "server_rules_settings",
    "server_rules_versions",
    "server_rules_parts",
    "server_rules_memberships",
    "server_rules_acceptances",
    "server_rules_retired_acceptances",
    "server_rules_deletion_state",
    "server_rules_deletion_outbox",
  ])
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
      db.prepare(`SELECT 1 FROM ${table} WHERE guild_id<>? LIMIT 1`).get(guildId)
    )
      throw new Error("Recovery database contains another guild's data.");
  for (const table of ["runtime_settings", "control_configuration"])
    if (db.prepare(`SELECT 1 FROM ${table} WHERE guild<>? LIMIT 1`).get(guildId))
      throw new Error("Recovery settings contain another guild's data.");
}
function scrubWeb(db: DatabaseSync): void {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'")
    .all()
    .map((row) => String(row.name));
  if (!names.every((name) => ["sessions", "preview_config", "oauth_states"].includes(name)))
    throw new Error(
      "Unsupported web database; credential-bearing tables must be explicitly scrubbed.",
    );
  db.exec("PRAGMA secure_delete=ON");
  for (const name of ["sessions", "oauth_states"])
    if (names.includes(name)) db.exec(`DELETE FROM ${name}`);
  db.exec("VACUUM");
}

/** Read-only planning validates independent key/configuration before an installer stops its worker. */
function inspectSnapshot(
  options: SnapshotOptions,
  sourceLease?: RecoverySourceLease,
): {
  guilds: number;
  databases: number;
  maxBytes: number;
  maxFiles: number;
} {
  const key = backupKey(options.key, options.forbiddenKeys);
  key.fill(0);
  const limits = budgets(options);
  if (
    !isAbsolute(options.dataRoot) ||
    !isAbsolute(options.outputPath) ||
    options.guilds.length > 1000
  )
    throw new Error("Invalid snapshot paths or guild count.");
  assertRestoreStartupAllowed(options.dataRoot);
  if (sourceLease) assertRecoverySnapshotLease(sourceLease, options);
  else assertSourcePreparationComplete(options.dataRoot);
  deletionLedgers(options.dataRoot);
  if (fileExists(options.outputPath)) throw new Error("Recovery output already exists.");
  const guilds = new Set<string>(),
    databases = new Set<string>();
  for (const entry of options.guilds) {
    if (!id(entry.guildId) || !id(entry.ownerId) || guilds.has(entry.guildId))
      throw new Error("Invalid snapshot installation.");
    guilds.add(entry.guildId);
    const path = resolve(entry.databasePath),
      identity = process.platform === "win32" ? path.toLowerCase() : path;
    if (!isAbsolute(entry.databasePath) || databases.has(identity))
      throw new Error("Duplicate recovery database.");
    databases.add(identity);
    regularFile(path);
    if (!entry.public) loadSafeJson(entry.configPath);
  }
  for (const path of [options.hubDatabasePath, options.webDatabasePath].filter(
    (value): value is string => !!value,
  )) {
    const identity = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (databases.has(identity)) throw new Error("Duplicate recovery database.");
    databases.add(identity);
    regularFile(path);
  }
  if (options.registryPath) {
    const rows = loadSafeJson(options.registryPath);
    const expected = options.guilds;
    if (
      !Array.isArray(rows) ||
      new Set(rows.map((row) => row?.guildId)).size !== rows.length ||
      rows.some(
        (row) =>
          !row ||
          Object.keys(row).some((key) => !["guildId", "ownerId"].includes(key)) ||
          !expected.some((entry) => entry.guildId === row.guildId && entry.ownerId === row.ownerId),
      ) ||
      options.guilds
        .filter((entry) => entry.public)
        .some((entry) => !rows.some((row) => row.guildId === entry.guildId))
    )
      throw new Error("Public registry and snapshot installations differ.");
  }
  if (options.guilds.some((entry) => entry.public) && !options.registryPath)
    throw new Error("Public installations require their registry in the snapshot.");
  return { guilds: guilds.size, databases: databases.size, ...limits };
}

export function planSnapshot(options: SnapshotOptions) {
  return inspectSnapshot(options);
}

export async function createSnapshot(options: SnapshotOptions): Promise<SnapshotManifest> {
  return createSnapshotOwned(options);
}

export async function createSnapshotWithSourceLease(
  options: SnapshotOptions,
  sourceLease: RecoverySourceLease,
): Promise<SnapshotManifest> {
  assertRecoverySourceLease(sourceLease, options.dataRoot, options.guilds);
  assertRecoverySnapshotLease(sourceLease, options);
  for (const path of [options.hubDatabasePath, options.webDatabasePath])
    if (path) assertRecoveryDatabaseLease(sourceLease, path);
  const ownedOptions = Object.freeze({
    ...options,
    guilds: Object.freeze(options.guilds.map((row) => Object.freeze({ ...row }))),
  });
  return createSnapshotOwned(ownedOptions, sourceLease);
}

async function createSnapshotOwned(
  options: SnapshotOptions,
  sourceLease?: RecoverySourceLease,
): Promise<SnapshotManifest> {
  const limits = inspectSnapshot(options, sourceLease),
    key = backupKey(options.key, options.forbiddenKeys);
  privateDirectory(dirname(options.outputPath));
  const stage = mkdtempSync(join(dirname(options.outputPath), ".gildiusz-snapshot-"));
  const releases: (() => Promise<void>)[] = [];
  try {
    if (sourceLease) assertRecoverySourceLease(sourceLease, options.dataRoot, options.guilds);
    else {
      releases.push(await acquireDataRootLease(options.dataRoot));
      assertRestoreStartupAllowed(options.dataRoot);
      assertSourcePreparationComplete(options.dataRoot);
      for (const path of [
        ...options.guilds.map((entry) => entry.databasePath),
        ...(options.hubDatabasePath ? [options.hubDatabasePath] : []),
      ].sort())
        releases.push(await acquireLock(path));
    }
    // Recheck the registry/configuration after all writers have stopped, under the common lease.
    inspectSnapshot(options, sourceLease);
    const policy = options.schemaPolicy ?? currentRecoverySchemaPolicy();
    const manifest: SnapshotManifest = {
      format: 1,
      id: randomUUID(),
      createdAt: Date.now(),
      release: options.release ?? null,
      guilds: [],
      files: [],
      webSessionsRemoved: !!options.webDatabasePath,
    };
    let total = 0;
    const record = (
      path: string,
      kind: FileEntry["kind"],
      guildId?: string,
      schema?: RecoverySchema,
    ) => {
      const bytes = hashFile(inside(stage, path));
      total += bytes.size;
      if (total > limits.maxBytes || manifest.files.length >= limits.maxFiles)
        throw new Error("Recovery size budget exceeded.");
      manifest.files.push({
        path,
        ...bytes,
        kind,
        ...(guildId ? { guildId } : {}),
        ...(schema ? { schema } : {}),
      });
    };
    const database = async (
      source: string,
      path: string,
      kind: "guild" | "hub" | "web",
      guildId?: string,
    ) => {
      if (regularFile(source) > limits.maxBytes - total)
        throw new Error("Recovery size budget exceeded.");
      const destination = inside(stage, path);
      privateDirectory(dirname(destination));
      const input = new DatabaseSync(source, { readOnly: true });
      try {
        const bytes =
          Number(input.prepare("PRAGMA page_count").get()!.page_count) *
          Number(input.prepare("PRAGMA page_size").get()!.page_size);
        if (bytes > limits.maxBytes - total) throw new Error("Recovery size budget exceeded.");
        await backup(input, destination, { rate: 128 });
      } finally {
        input.close();
      }
      const copy = new DatabaseSync(destination);
      try {
        copy.exec("PRAGMA journal_mode=DELETE");
        if (kind === "web") scrubWeb(copy);
        assertIntegrity(copy);
        const schema = schemaOf(copy, kind);
        if (kind !== "web") verifySchema(schema, policy[kind]);
        if (guildId) inspectGuild(copy, guildId);
        record(path, kind, guildId, schema);
      } finally {
        copy.close();
      }
      return destination;
    };
    for (const entry of options.guilds) {
      const path = `${entry.public ? "public-guilds" : "guilds"}/${entry.guildId}/gildiusz.sqlite`;
      const configPath = entry.public ? null : `configuration/${entry.guildId}.json`;
      manifest.guilds.push({
        guildId: entry.guildId,
        ownerId: entry.ownerId,
        public: !!entry.public,
        databasePath: path,
        configPath,
      });
      const copied = await database(entry.databasePath, path, "guild", entry.guildId);
      if (configPath) {
        writeJson(inside(stage, configPath), loadSafeJson(entry.configPath));
        record(configPath, "configuration", entry.guildId);
      }
      const db = new DatabaseSync(copied, { readOnly: true });
      try {
        if (
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='announcement_assets'",
            )
            .get()
        )
          for (const row of db
            .prepare("SELECT id,guild_id,media_type,size,hash FROM announcement_assets ORDER BY id")
            .all()) {
            const assetId = String(row.id),
              format = formats[String(row.media_type)];
            if (
              !uuid.test(assetId) ||
              !format ||
              row.guild_id !== entry.guildId ||
              !options.assetsRoot
            )
              throw new Error("Controlled asset storage is missing or invalid.");
            const assetPath = `announcement-assets/${entry.guildId}/${assetId}.${format}`;
            copyPrivate(
              join(options.assetsRoot, entry.guildId, `${assetId}.${format}`),
              inside(stage, assetPath),
              Math.min(2 * 1024 * 1024, limits.maxBytes - total),
            );
            record(assetPath, "asset", entry.guildId);
            const saved = manifest.files.at(-1)!;
            if (saved.size !== row.size || saved.sha256 !== row.hash)
              throw new Error("Controlled asset checksum mismatch.");
          }
      } finally {
        db.close();
      }
    }
    const privateGuilds = manifest.guilds
      .filter((entry) => !entry.public)
      .map((entry) => ({
        guildId: entry.guildId,
        ownerId: entry.ownerId,
        databasePath: entry.databasePath,
        configPath: entry.configPath,
      }));
    if (privateGuilds.length) {
      writeJson(join(stage, "guilds.json"), privateGuilds);
      record("guilds.json", "configuration");
    }
    if (options.registryPath) {
      writeJson(
        inside(stage, "public-guilds/installations.json"),
        loadSafeJson(options.registryPath),
      );
      record("public-guilds/installations.json", "configuration");
    }
    if (options.hubDatabasePath)
      await database(options.hubDatabasePath, "integrations.sqlite", "hub");
    if (options.webDatabasePath) await database(options.webDatabasePath, "web/web.sqlite", "web");
    for (const ledger of deletionLedgers(options.dataRoot)) {
      writeJson(inside(stage, ledger.path), ledger.value);
      record(ledger.path, "configuration");
    }
    if (sourceLease) assertRecoverySnapshotLease(sourceLease, options);
    encryptArchive(
      options.outputPath,
      manifest,
      manifest.files.map((entry) => inside(stage, entry.path)),
      key,
    );
    if (sourceLease) assertRecoverySnapshotLease(sourceLease, options);
    return manifest;
  } finally {
    key.fill(0);
    try {
      for (const release of releases.reverse()) await release();
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

function validateManifest(
  value: unknown,
  limits: { maxFiles: number; maxBytes: number },
): SnapshotManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid recovery manifest.");
  const manifest = value as SnapshotManifest;
  if (
    manifest.format !== 1 ||
    !uuid.test(manifest.id) ||
    !Number.isSafeInteger(manifest.createdAt) ||
    !Array.isArray(manifest.guilds) ||
    manifest.guilds.length > 1000 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > limits.maxFiles
  )
    throw new Error("Unsupported recovery manifest.");
  const names = new Set<string>(),
    guilds = new Set<string>();
  let total = 0;
  for (const guild of manifest.guilds) {
    if (
      !id(guild.guildId) ||
      !id(guild.ownerId) ||
      typeof guild.public !== "boolean" ||
      guilds.has(guild.guildId) ||
      guild.databasePath !==
        `${guild.public ? "public-guilds" : "guilds"}/${guild.guildId}/gildiusz.sqlite` ||
      guild.configPath !== (guild.public ? null : `configuration/${guild.guildId}.json`)
    )
      throw new Error("Invalid recovery guild manifest.");
    guilds.add(guild.guildId);
  }
  for (const entry of manifest.files) {
    safeRelativePath(entry.path);
    if (
      names.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !["guild", "hub", "web", "configuration", "asset"].includes(entry.kind) ||
      (entry.guildId !== undefined && !guilds.has(entry.guildId))
    )
      throw new Error("Invalid recovery file manifest.");
    names.add(entry.path);
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > limits.maxBytes)
      throw new Error("Recovery size budget exceeded.");
    const expectedKind = entry.path.endsWith(".sqlite")
      ? entry.path === "integrations.sqlite"
        ? "hub"
        : entry.path === "web/web.sqlite"
          ? "web"
          : "guild"
      : entry.path.startsWith("announcement-assets/")
        ? "asset"
        : "configuration";
    if (
      entry.kind !== expectedKind ||
      (["guild", "hub", "web"].includes(entry.kind) && !entry.schema)
    )
      throw new Error("Recovery file kind mismatch.");
    if (
      entry.kind === "guild" &&
      !manifest.guilds.some(
        (guild) => guild.guildId === entry.guildId && guild.databasePath === entry.path,
      )
    )
      throw new Error("Recovery database installation mismatch.");
    if (entry.kind === "asset" && !entry.path.startsWith(`announcement-assets/${entry.guildId}/`))
      throw new Error("Recovery asset guild mismatch.");
  }
  for (const guild of manifest.guilds)
    if (!names.has(guild.databasePath) || (guild.configPath && !names.has(guild.configPath)))
      throw new Error("Incomplete recovery installation.");
  if (
    (manifest.guilds.some((guild) => guild.public) &&
      !names.has("public-guilds/installations.json")) ||
    (manifest.guilds.some((guild) => !guild.public) && !names.has("guilds.json"))
  )
    throw new Error("Recovery installation registry is missing.");
  return manifest;
}

function verifyConfiguration(data: string, manifest: SnapshotManifest): void {
  const privateGuilds = manifest.guilds.filter((guild) => !guild.public);
  if (privateGuilds.length) {
    const rows = loadSafeJson(join(data, "guilds.json"));
    if (
      !Array.isArray(rows) ||
      rows.length !== privateGuilds.length ||
      new Set(rows.map((row) => row?.guildId)).size !== rows.length ||
      rows.some(
        (row) =>
          !row ||
          Object.keys(row).sort().join(",") !== "configPath,databasePath,guildId,ownerId" ||
          !privateGuilds.some(
            (guild) =>
              guild.guildId === row.guildId &&
              guild.ownerId === row.ownerId &&
              guild.databasePath === row.databasePath &&
              guild.configPath === row.configPath,
          ),
      )
    )
      throw new Error("Recovery private installation registry mismatch.");
  }
  if (manifest.files.some((entry) => entry.path === "public-guilds/installations.json")) {
    const rows = loadSafeJson(join(data, "public-guilds/installations.json"));
    if (
      !Array.isArray(rows) ||
      new Set(rows.map((row) => row?.guildId)).size !== rows.length ||
      rows.some(
        (row) =>
          !row ||
          Object.keys(row).sort().join(",") !== "guildId,ownerId" ||
          !manifest.guilds.some(
            (guild) => guild.guildId === row.guildId && guild.ownerId === row.ownerId,
          ),
      ) ||
      manifest.guilds
        .filter((guild) => guild.public)
        .some((guild) => !rows.some((row) => row.guildId === guild.guildId))
    )
      throw new Error("Recovery public installation registry mismatch.");
  }
}

/** A previous running release is safe for code-only rollback only if no schema changed. */
export async function snapshotSchemasUnchanged(
  options: Pick<SnapshotOptions, "dataRoot" | "guilds" | "hubDatabasePath" | "webDatabasePath">,
  manifest: SnapshotManifest,
): Promise<boolean> {
  const release = await acquireDataRootLease(options.dataRoot),
    locks: (() => Promise<void>)[] = [];
  try {
    const inputs = options.guilds.map((guild) => ({
      path: guild.databasePath,
      entry: manifest.files.find(
        (entry) => entry.kind === "guild" && entry.guildId === guild.guildId,
      ),
    }));
    if (options.hubDatabasePath)
      inputs.push({
        path: options.hubDatabasePath,
        entry: manifest.files.find((entry) => entry.kind === "hub"),
      });
    if (options.webDatabasePath)
      inputs.push({
        path: options.webDatabasePath,
        entry: manifest.files.find((entry) => entry.kind === "web"),
      });
    if (
      inputs.length !==
      manifest.files.filter((entry) => ["guild", "hub", "web"].includes(entry.kind)).length
    )
      return false;
    for (const input of inputs) regularFile(input.path);
    for (const input of inputs
      .filter((input) => input.entry?.kind !== "web")
      .sort((a, b) => a.path.localeCompare(b.path)))
      locks.push(await acquireLock(input.path));
    for (const input of inputs) {
      if (!input.entry) return false;
      regularFile(input.path);
      const db = new DatabaseSync(input.path, { readOnly: true });
      try {
        assertIntegrity(db);
        if (
          JSON.stringify(schemaOf(db, input.entry.kind as "guild" | "hub" | "web")) !==
          JSON.stringify(input.entry.schema)
        )
          return false;
      } finally {
        db.close();
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      for (const unlock of locks.reverse()) await unlock();
    } finally {
      await release();
    }
  }
}

export async function restoreSnapshot(options: {
  archivePath: string;
  targetRoot: string;
  key: Uint8Array | string;
  forbiddenKeys?: readonly (Uint8Array | string)[];
  dryRun?: boolean;
  schemaPolicy?: RecoverySchemaPolicy;
  maxBytes?: number;
  maxFiles?: number;
  now?: number;
  maxArchiveAgeMs?: number;
  quarantineWeb?: true;
}): Promise<SnapshotManifest> {
  const key = backupKey(options.key, options.forbiddenKeys),
    limits = budgets(options);
  if (!isAbsolute(options.archivePath) || !isAbsolute(options.targetRoot))
    throw new Error("Recovery paths must be absolute.");
  const target = resolve(options.targetRoot);
  if (options.quarantineWeb !== undefined && options.quarantineWeb !== true)
    throw new Error("Invalid Web quarantine request.");
  privateDirectory(dirname(target));
  const assertEmpty = () => {
    if (fileExists(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(target).length)
        throw new Error("Restore requires a new empty target directory.");
    }
  };
  assertEmpty();
  const stage = mkdtempSync(join(dirname(target), ".gildiusz-restore-")),
    payload = join(stage, "payload"),
    data = join(stage, "data");
  try {
    privateDirectory(data);
    decryptArchive(options.archivePath, payload, key, limits.maxBytes);
    const manifest = withInput(payload, (input, size) => {
      const prefix = Buffer.alloc(4);
      if (readSync(input, prefix, 0, 4, 0) !== 4) throw new Error("Truncated recovery manifest.");
      const length = prefix.readUInt32BE();
      if (length > manifestLimit || length < 2 || length + 4 > size)
        throw new Error("Invalid recovery manifest length.");
      const json = Buffer.alloc(length);
      if (readSync(input, json, 0, length, 4) !== length)
        throw new Error("Truncated recovery manifest.");
      const manifest = validateManifest(JSON.parse(json.toString("utf8")), limits);
      assertRecoveryArchiveAge(manifest.createdAt, options);
      if (4 + length + manifest.files.reduce((sum, entry) => sum + entry.size, 0) !== size)
        throw new Error("Recovery archive length mismatch.");
      let position = length + 4;
      for (const entry of manifest.files) {
        const path = inside(data, entry.path);
        privateDirectory(dirname(path));
        const output = openSync(path, "wx", 0o600),
          chunk = Buffer.alloc(65536);
        let remaining = entry.size;
        try {
          while (remaining) {
            const count = readSync(input, chunk, 0, Math.min(remaining, chunk.length), position);
            if (!count) throw new Error("Truncated recovery file.");
            writeAll(output, chunk.subarray(0, count));
            remaining -= count;
            position += count;
          }
          fsyncSync(output);
        } finally {
          closeSync(output);
        }
        const hash = hashFile(path);
        if (hash.sha256 !== entry.sha256 || hash.size !== entry.size)
          throw new Error("Recovery file checksum mismatch.");
      }
      return manifest;
    });
    const policy = options.schemaPolicy ?? currentRecoverySchemaPolicy(),
      now = assertRecoveryArchiveAge(manifest.createdAt, options);
    verifyConfiguration(data, manifest);
    // The marker exists before any recovered SQLite state can be opened by a worker.
    writeJson(join(data, restoreQuarantineFile), {
      format: 1,
      backupId: manifest.id,
      restoredAt: now,
      sourceRelease: manifest.release,
      requiresOperatorReview: true,
      automaticResume: false,
      externalEffectsMayAlreadyExist: true,
      webSessionsRemoved: manifest.webSessionsRemoved,
      deletionReconciliationRequired: true,
      deletionLedgerIncluded: manifest.files.some((entry) =>
        entry.path.startsWith("uninstall-retention/"),
      ),
    });
    for (const entry of manifest.files) {
      const path = inside(data, entry.path);
      if (entry.kind === "configuration") {
        const value = loadSafeJson(path);
        if (entry.path.startsWith("uninstall-retention/"))
          verifyDeletionLedger(value, entry.path.split("/")[1].split(".")[0]);
        continue;
      }
      if (!["guild", "hub", "web"].includes(entry.kind)) continue;
      const kind = entry.kind as "guild" | "hub" | "web",
        db = new DatabaseSync(path);
      try {
        assertIntegrity(db);
        const schema = schemaOf(db, kind);
        if (JSON.stringify(schema) !== JSON.stringify(entry.schema))
          throw new Error("Recovery schema manifest mismatch.");
        if (kind !== "web") {
          verifySchema(schema, policy[kind]);
        }
        if (kind === "guild") {
          if (!entry.guildId) throw new Error("Recovery guild is missing.");
          inspectGuild(db, entry.guildId);
        }
        if (kind === "web") scrubWeb(db);
        else quarantineDatabase(db, kind, now);
        assertIntegrity(db);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
      } finally {
        db.close();
      }
    }
    // Verify files and DB metadata agree before exposing the private target root.
    const expectedAssets = new Set<string>();
    for (const guild of manifest.guilds) {
      const db = new DatabaseSync(inside(data, guild.databasePath), { readOnly: true });
      try {
        if (
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='announcement_assets'",
            )
            .get()
        )
          for (const row of db
            .prepare("SELECT id,media_type,size,hash FROM announcement_assets")
            .all()) {
            const format = formats[String(row.media_type)];
            if (!uuid.test(String(row.id)) || !format)
              throw new Error("Invalid restored asset metadata.");
            const file = manifest.files.find(
              (entry) => entry.path === `announcement-assets/${guild.guildId}/${row.id}.${format}`,
            );
            if (file) expectedAssets.add(file.path);
            if (
              !file ||
              file.kind !== "asset" ||
              file.size !== row.size ||
              file.sha256 !== row.hash
            )
              throw new Error("Restored asset is missing or corrupted.");
          }
      } finally {
        db.close();
      }
    }
    if (manifest.files.some((entry) => entry.kind === "asset" && !expectedAssets.has(entry.path)))
      throw new Error("Restored asset has no database metadata.");
    assertRecoveryArchiveAge(manifest.createdAt, options);
    if (options.quarantineWeb && manifest.files.some((entry) => entry.kind === "web"))
      writeJson(join(data, "web", "web.sqlite.restore-quarantine.json"), {
        format: 1,
        kind: "gildiusz-restored-web-quarantine",
        backupId: manifest.id,
        automaticResume: false,
      });
    writeJson(join(data, "restore-manifest.json"), manifest);
    if (options.dryRun) return manifest;
    for (const entry of manifest.files.filter((entry) =>
      ["guild", "hub", "web"].includes(entry.kind),
    )) {
      const fd = openSync(inside(data, entry.path), "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    syncDirectory(data);
    assertEmpty();
    assertRecoveryArchiveAge(manifest.createdAt, options);
    if (existsSync(target)) rmdirSync(target);
    renameSync(data, target);
    syncDirectory(dirname(target));
    return manifest;
  } finally {
    key.fill(0);
    rmSync(stage, { recursive: true, force: true });
  }
}
