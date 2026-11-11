import { DatabaseSync } from "node:sqlite";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { acquireLock } from "../lock.js";
import type { GuildInstallation } from "../../installations.js";
import { hashFile, privateDirectory, regularFile, syncDirectory } from "./files.js";
import {
  acquireDataRootLease,
  assertRestoreStartupAllowed,
  assertSourcePreparationComplete,
  coldSourceFenceFile,
  sourcePreparationFile,
} from "./lease.js";

declare const sourceLeaseBrand: unique symbol;
export interface RecoverySourceLease {
  readonly [sourceLeaseBrand]: true;
}
export interface RecoverySourceInventory {
  dataRoot: string;
  guilds: readonly GuildInstallation[];
  hubDatabasePath?: string;
  webDatabasePath?: string;
  registryPath?: string;
}
export interface PhysicalIdentity {
  dev: string;
  ino: string;
}
interface State {
  root: string;
  rootIdentity: PhysicalIdentity;
  lockIdentities: Map<string, PhysicalIdentity>;
  guilds: readonly GuildInstallation[];
  files: Map<string, PhysicalIdentity>;
  configuration: Map<string, string>;
  active: boolean;
  inventory: string;
  webDatabasePath?: string;
  fence?: { body: string; sha256: string };
}
const states = new WeakMap<object, State>();
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
function assertWebPeerAbsent(databasePath?: string): void {
  if (!databasePath) return;
  let present = false;
  try {
    lstatSync(databasePath + ".source-cold-pair.json");
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (present) throw new Error("The Web source is sealed for a controlled cold recovery.");
}
export function physicalIdentity(path: string): PhysicalIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new Error("Unsafe recovery identity.");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function snapshotInventory(options: RecoverySourceInventory): string {
  return JSON.stringify({
    root: resolve(options.dataRoot),
    guilds: options.guilds
      .map((row) => ({
        guildId: row.guildId,
        ownerId: row.ownerId,
        public: !!row.public,
        databasePath: resolve(row.databasePath),
        configPath: row.public ? null : resolve(row.configPath),
      }))
      .sort((a, b) => a.guildId.localeCompare(b.guildId)),
    hub: options.hubDatabasePath ? resolve(options.hubDatabasePath) : null,
    web: options.webDatabasePath ? resolve(options.webDatabasePath) : null,
    registry: options.registryPath ? resolve(options.registryPath) : null,
  });
}
export function assertRecoverySnapshotLease(
  lease: RecoverySourceLease,
  options: RecoverySourceInventory,
): void {
  assertRecoverySourceLease(lease, options.dataRoot, options.guilds);
  if (snapshotInventory(options) !== stateOf(lease).inventory)
    throw new Error("The compound lease snapshot metadata changed.");
}
function stateOf(lease: RecoverySourceLease): State {
  const state = states.get(lease);
  if (!state?.active) throw new Error("A live compound recovery source lease is required.");
  return state;
}
export function assertRecoverySourceLease(
  lease: RecoverySourceLease,
  root?: string,
  guilds?: readonly { guildId: string; databasePath: string }[],
): void {
  const state = stateOf(lease);
  if (!same(physicalIdentity(state.root), state.rootIdentity))
    throw new Error("The leased recovery source root changed identity.");
  for (const [path, expected] of state.lockIdentities)
    if (!same(physicalIdentity(path), expected))
      throw new Error("A compound recovery writer lease changed identity.");
  if (root !== undefined && resolve(root) !== state.root)
    throw new Error("Recovery source lease root mismatch.");
  if (guilds !== undefined) {
    const scope = (rows: readonly { guildId: string; databasePath: string }[]) =>
      rows.map((row) => [row.guildId, resolve(row.databasePath)]).sort();
    if (!same(scope(guilds), scope(state.guilds)))
      throw new Error("Recovery source lease inventory mismatch.");
  }
  assertRestoreStartupAllowed(state.root);
  if (state.fence) {
    for (const name of [coldSourceFenceFile, sourcePreparationFile]) {
      const path = join(state.root, name);
      regularFile(path);
      if (readFileSync(path, "utf8") !== state.fence.body)
        throw new Error("The owned cold source fence changed.");
    }
    if (state.webDatabasePath) {
      const path = state.webDatabasePath + ".source-cold-pair.json";
      regularFile(path);
      if (readFileSync(path, "utf8") !== state.fence.body)
        throw new Error("The owned cold Web source fence changed.");
    }
  } else {
    assertSourcePreparationComplete(state.root);
    assertWebPeerAbsent(state.webDatabasePath);
  }
  for (const [path, expected] of state.files)
    if (!same(physicalIdentity(path), expected))
      throw new Error("A leased recovery source database changed identity.");
  for (const [path, expected] of state.configuration)
    if (hashFile(path).sha256 !== expected)
      throw new Error("Recovery source configuration changed under its lease.");
}
export function assertRecoveryGuildLease(
  lease: RecoverySourceLease,
  guildId: string,
  databasePath: string,
): void {
  assertRecoverySourceLease(lease);
  const state = stateOf(lease);
  if (!state.guilds.some((row) => row.guildId === guildId && row.databasePath === databasePath))
    throw new Error("The compound lease does not own this guild database.");
}
export function assertRecoveryDatabaseLease(lease: RecoverySourceLease, path: string): void {
  assertRecoverySourceLease(lease);
  if (!stateOf(lease).files.has(resolve(path)))
    throw new Error("The compound lease does not own this database.");
}
export function installColdSourceFence(
  lease: RecoverySourceLease,
  operationId: string,
): { body: string; sha256: string } {
  assertRecoverySourceLease(lease);
  if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("Invalid cold operation identity.");
  const state = stateOf(lease);
  if (state.fence) throw new Error("The source is already sealed by this operation.");
  const body =
    JSON.stringify({
      format: 2,
      kind: "gildiusz-controlled-cold-source",
      operationId,
      installedAt: Date.now(),
      compatibilityGuard: sourcePreparationFile,
      sourceRoot: state.root,
      webDatabasePath: state.webDatabasePath ?? null,
      rootIdentity: physicalIdentity(state.root),
      databases: [...state.files].map(([path, identity]) => ({ path, identity })),
    }) + "\n";
  writeFileSync(join(state.root, sourcePreparationFile), body, {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  syncDirectory(state.root);
  if (state.webDatabasePath) {
    writeFileSync(state.webDatabasePath + ".source-cold-pair.json", body, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    syncDirectory(dirname(state.webDatabasePath));
  }
  writeFileSync(join(state.root, coldSourceFenceFile), body, {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  syncDirectory(state.root);
  state.fence = { body, sha256: digest(body) };
  assertRecoverySourceLease(lease);
  return { ...state.fence };
}
export function ownedColdSourceFence(lease: RecoverySourceLease): { body: string; sha256: string } {
  assertRecoverySourceLease(lease);
  const fence = stateOf(lease).fence;
  if (!fence) throw new Error("The compound source has not been sealed.");
  return { ...fence };
}

/** The capability exists only while these actual writer leases remain owned. */
export async function withRecoverySourceLease<T>(
  options: RecoverySourceInventory,
  work: (lease: RecoverySourceLease) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(options.dataRoot) || !lstatSync(options.dataRoot).isDirectory())
    throw new Error("The recovery source must already exist.");
  const root = privateDirectory(resolve(options.dataRoot)),
    releases: (() => Promise<void>)[] = [],
    files = new Map<string, PhysicalIdentity>(),
    configuration = new Map<string, string>(),
    guilds = options.guilds.map((row) =>
      Object.freeze({ ...row, databasePath: resolve(row.databasePath) }),
    ),
    lease = Object.freeze({}) as RecoverySourceLease,
    state: State = {
      root,
      rootIdentity: physicalIdentity(root),
      lockIdentities: new Map(),
      guilds,
      files,
      configuration,
      active: false,
      inventory: snapshotInventory(options),
      ...(options.webDatabasePath ? { webDatabasePath: resolve(options.webDatabasePath) } : {}),
    };
  let web: DatabaseSync | undefined;
  try {
    assertRestoreStartupAllowed(root);
    assertSourcePreparationComplete(root);
    assertWebPeerAbsent(state.webDatabasePath);
    releases.push(await acquireDataRootLease(root));
    state.lockIdentities.set(
      join(root, ".runtime-data.lock"),
      physicalIdentity(join(root, ".runtime-data.lock")),
    );
    assertSourcePreparationComplete(root);
    const paths = [
      ...guilds.map((row) => row.databasePath),
      options.hubDatabasePath,
      options.webDatabasePath,
    ]
      .filter((path): path is string => !!path)
      .map((path) => resolve(path))
      .sort();
    if (
      new Set(paths).size !== paths.length ||
      new Set(guilds.map((row) => row.guildId)).size !== guilds.length
    )
      throw new Error("Duplicate recovery source database.");
    for (const row of guilds) {
      const tail = relative(root, row.databasePath);
      if (!tail || tail.startsWith("..") || isAbsolute(tail))
        throw new Error("Guild database is outside the source root.");
    }
    for (const path of paths) {
      regularFile(path);
      releases.push(await acquireLock(path, { createTarget: false }));
      state.lockIdentities.set(path + ".lock", physicalIdentity(path + ".lock"));
      files.set(path, physicalIdentity(path));
    }
    for (const path of [
      ...guilds.filter((row) => !row.public).map((row) => row.configPath),
      options.registryPath,
    ].filter((path): path is string => !!path)) {
      regularFile(path);
      configuration.set(path, hashFile(path).sha256);
    }
    // SQLite also excludes pre-bridge writers while this snapshot is taken.
    if (options.webDatabasePath) {
      web = new DatabaseSync(options.webDatabasePath);
      web.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    }
    state.active = true;
    states.set(lease, state);
    assertRecoverySourceLease(lease);
    return await work(lease);
  } finally {
    state.active = false;
    if (web) {
      if (web.isTransaction) web.exec("ROLLBACK");
      web.close();
    }
    for (const release of releases.reverse()) await release();
  }
}
