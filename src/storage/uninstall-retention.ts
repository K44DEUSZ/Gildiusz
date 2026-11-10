import { DatabaseSync } from "node:sqlite";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { GuildInstallation } from "../installations.js";
import { transaction } from "./migrations.js";
import { privateDirectory, regularFile, syncDirectory } from "./recovery/files.js";

export const guildUninstallRetentionMs = 30 * 86400000;
export const uninstallResourceKey = "retention.guild-uninstalled";
export const unverifiedRulesDeletionGapFile = "source-gap-unverified.json";
const terminalRetentionMs = 35 * 86400000;
const proofLifetime = 30000;
const snowflake = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{17,20}$/.test(value);
const timestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
export interface MembershipProof {
  // Discord adapters must map outages/cache misses to unknown, never to absent.
  state: "present" | "absent" | "unknown";
  observedAt: number;
  source: "discord-rest" | "gateway-join";
}
export interface UninstallMarker {
  removedAt: number;
}

function requireGuild(store: Store, guildId: string): void {
  if (
    !snowflake(guildId) ||
    store.db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !== guildId
  )
    throw new Error("Uninstall retention guild mismatch.");
}
function fresh(proof: MembershipProof, now: number): "present" | "absent" | "unknown" {
  if (
    !timestamp(now) ||
    !timestamp(proof.observedAt) ||
    proof.observedAt > now ||
    now - proof.observedAt > proofLifetime
  )
    return "unknown";
  if (proof.state === "absent" && proof.source !== "discord-rest") return "unknown";
  return proof.state;
}
export function readUninstallMarker(store: Store, guildId: string): UninstallMarker | null {
  requireGuild(store, guildId);
  const row = store.resource(uninstallResourceKey);
  if (!row) return null;
  const value = JSON.parse(row.baseline) as UninstallMarker;
  if (
    row.kind !== "retention" ||
    row.id !== guildId ||
    !timestamp(value.removedAt) ||
    Object.keys(value).length !== 1
  )
    throw new Error("Invalid uninstall retention marker.");
  return value;
}
function closedMarker(path: string, guildId: string): UninstallMarker | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !== guildId)
      throw new Error("Uninstall database guild changed.");
    const row = db
      .prepare("SELECT kind,id,baseline FROM resources WHERE key=?")
      .get(uninstallResourceKey);
    if (!row) return null;
    const marker = JSON.parse(String(row.baseline)) as UninstallMarker;
    if (
      row.kind !== "retention" ||
      row.id !== guildId ||
      !timestamp(marker.removedAt) ||
      Object.keys(marker).length !== 1
    )
      throw new Error("Invalid closed uninstall marker.");
    return marker;
  } finally {
    db.close();
  }
}
export function recordGuildMembership(
  store: Store,
  guildId: string,
  proof: MembershipProof,
  now = Date.now(),
): UninstallMarker | null {
  requireGuild(store, guildId);
  return transaction(store.db, () => {
    const state = fresh(proof, now),
      before = readUninstallMarker(store, guildId);
    if (state === "present") {
      store.removeResource(uninstallResourceKey);
      return null;
    }
    if (state !== "absent" || before) return before;
    const marker = { removedAt: proof.observedAt };
    store.putResource(uninstallResourceKey, "retention", guildId, marker);
    return marker;
  });
}

type Phase = "prepared" | "committed" | "hub_done" | "files_done" | "registry_done";
interface FileIdentity {
  dev: string;
  ino: string;
}
interface PurgeJournal {
  format: 1;
  guildId: string;
  removedAt: number;
  phase: Phase;
  public: boolean;
  databasePath: string;
  databaseIdentity: FileIdentity;
  assetNames: string[];
}
export interface DeletionLedger {
  format: 1;
  guildId: string;
  removedAt: number;
  purgedAt: number;
  outcome: "purged";
}
export function readDeletionLedger(dataRoot: string, guildId: string): DeletionLedger | null {
  if (!isAbsolute(dataRoot) || !snowflake(guildId))
    throw new Error("Invalid deletion ledger scope.");
  const path = join(dataRoot, "uninstall-retention", `${guildId}.deleted.json`);
  if (absent(path)) return null;
  if (regularFile(path) > 1024) throw new Error("Invalid deletion ledger size.");
  const value = JSON.parse(readFileSync(path, "utf8")) as DeletionLedger;
  if (
    value.format !== 1 ||
    value.guildId !== guildId ||
    !timestamp(value.removedAt) ||
    !timestamp(value.purgedAt) ||
    value.purgedAt < value.removedAt ||
    value.outcome !== "purged" ||
    Object.keys(value).sort().join(",") !== "format,guildId,outcome,purgedAt,removedAt"
  )
    throw new Error("Invalid deletion ledger.");
  return value;
}
export interface PurgeOutcome {
  state: "not_due" | "deferred" | "rejoined" | "pending" | "purged";
  store: "open" | "reopen" | "closed";
  phase?: Phase;
}
export type RetentionInstallation = Pick<GuildInstallation, "guildId" | "databasePath" | "public">;
export interface PurgePorts {
  freshProof(): Promise<MembershipProof>;
  checkFence(): boolean;
  // The callback owns a drained, closed Store while its individual file lease remains held.
  withClosedGuild(
    guildId: string,
    work: () => Promise<PurgeOutcome>,
  ): Promise<PurgeOutcome | undefined>;
}
export interface GuildUninstallRetentionOptions {
  dataRoot: string;
  databaseRoots?: readonly string[];
  assetsRoot?: string;
  // undefined is an outage; null explicitly confirms no integrations database exists.
  hub(): DatabaseSync | null | undefined;
  registry?: { remove(guildId: string): boolean; validateRemoval?(): void };
  clock?: () => number;
  onStage?: (phase: Phase) => void;
  rulesDeletion?: {
    prepareRetirement(installation: RetentionInstallation): Promise<void>;
    confirmRetired(installation: RetentionInstallation): Promise<void>;
  };
}
const assetName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$/;
function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
function contained(root: string, path: string): boolean {
  const tail = relative(root, path);
  return !!tail && !tail.startsWith("..") && !isAbsolute(tail);
}
function identity(path: string): FileIdentity {
  safeRemovalFile(path);
  const stat = lstatSync(path, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function safeRemovalFile(path: string): void {
  regularFile(path);
  const state = lstatSync(path);
  if (process.getuid && state.uid !== process.getuid())
    throw new Error("Uninstall file has another owner.");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
      throw new Error("Uninstall directory permits unrelated writers.");
    if (parent === dirname(parent)) break;
  }
}

export class GuildUninstallRetention {
  readonly #directory: string;
  readonly #assetsRoot: string;
  readonly #databaseRoots: readonly string[];
  readonly #clock: () => number;
  readonly #active = new Set<string>();
  #metadataCursor = 0;
  constructor(private readonly options: GuildUninstallRetentionOptions) {
    if (!isAbsolute(options.dataRoot))
      throw new Error("Uninstall retention needs an absolute data root.");
    this.#directory = privateDirectory(join(options.dataRoot, "uninstall-retention"));
    if (options.assetsRoot && !isAbsolute(options.assetsRoot))
      throw new Error("Invalid retention assets root.");
    this.#assetsRoot = resolve(options.assetsRoot ?? join(options.dataRoot, "announcement-assets"));
    this.#databaseRoots = (options.databaseRoots ?? [options.dataRoot]).map((path) => {
      if (!isAbsolute(path)) throw new Error("Invalid retention database root.");
      return resolve(path);
    });
    this.#clock = options.clock ?? Date.now;
  }
  #path(guildId: string, suffix = "pending"): string {
    if (!snowflake(guildId)) throw new Error("Invalid retention guild.");
    return join(this.#directory, `${guildId}.${suffix}.json`);
  }
  #write(guildId: string, value: PurgeJournal | DeletionLedger, suffix = "pending"): void {
    privateDirectory(this.#directory);
    const path = this.#path(guildId, suffix),
      temporary = path + `.${randomUUID()}.tmp`;
    if (!absent(path)) regularFile(path);
    try {
      writeFileSync(temporary, JSON.stringify(value) + "\n", {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      renameSync(temporary, path);
      syncDirectory(this.#directory);
      syncDirectory(dirname(this.#directory));
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  #read(guildId: string, terminalMetadata = false): PurgeJournal | null {
    const path = this.#path(guildId);
    if (absent(path)) return null;
    if (regularFile(path) > 128 * 1024) throw new Error("Invalid retention journal size.");
    const value = JSON.parse(readFileSync(path, "utf8")) as PurgeJournal;
    if (
      value.format !== 1 ||
      value.guildId !== guildId ||
      !timestamp(value.removedAt) ||
      typeof value.public !== "boolean" ||
      !["prepared", "committed", "hub_done", "files_done", "registry_done"].includes(value.phase) ||
      !value.databaseIdentity ||
      !/^[0-9]{1,24}$/.test(value.databaseIdentity.dev) ||
      !/^[0-9]{1,24}$/.test(value.databaseIdentity.ino) ||
      !Array.isArray(value.assetNames) ||
      value.assetNames.length > 1024 ||
      new Set(value.assetNames).size !== value.assetNames.length ||
      value.assetNames.some((name) => !assetName.test(name))
    )
      throw new Error("Invalid retention journal.");
    if (terminalMetadata) {
      if (value.phase !== "registry_done") return null;
      if (
        Object.keys(value).sort().join(",") !==
          "assetNames,databaseIdentity,databasePath,format,guildId,phase,public,removedAt" ||
        Object.keys(value.databaseIdentity).sort().join(",") !== "dev,ino" ||
        typeof value.databasePath !== "string" ||
        value.databasePath.length > 1024 ||
        value.databasePath.includes("\0") ||
        !isAbsolute(value.databasePath)
      )
        throw new Error("Invalid terminal retention metadata.");
      safeRemovalFile(path);
      if (process.platform !== "win32" && (lstatSync(path).mode & 0o077) !== 0)
        throw new Error("Terminal retention metadata must be private.");
    } else this.#databasePath(value.databasePath);
    return value;
  }
  #databasePath(path: string): string {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      !this.#databaseRoots.some((root) => contained(root, resolve(path))) ||
      !/^[a-zA-Z0-9._-]+\.sqlite$/.test(path.split(/[\\/]/).at(-1)!)
    )
      throw new Error("Unsafe uninstall database scope.");
    if (path.split(/[\\/]/).some((part) => part.toLowerCase() === "public_html"))
      throw new Error("Unsafe uninstall database scope.");
    return resolve(path);
  }
  #assetDirectory(guildId: string): string {
    return join(this.#assetsRoot, guildId);
  }
  #assetFiles(guildId: string): string[] {
    const directory = this.#assetDirectory(guildId);
    if (absent(directory)) return [];
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error("Unsafe uninstall asset directory.");
    const files = readdirSync(directory);
    if (files.length > 1024 || files.some((name) => !assetName.test(name)))
      throw new Error("Unexpected files in uninstall asset scope.");
    for (const name of files) safeRemovalFile(join(directory, name));
    return files.sort();
  }
  status(guildId: string): { phase: Phase; removedAt: number; reopenable: boolean } | null {
    const journal = this.#read(guildId);
    return journal
      ? {
          phase: journal.phase,
          removedAt: journal.removedAt,
          reopenable: journal.phase === "prepared" && this.#canReopen(journal),
        }
      : null;
  }
  pendingGuilds(): string[] {
    privateDirectory(this.#directory);
    return readdirSync(this.#directory).flatMap((name) => {
      const match = /^([0-9]{17,20})\.pending\.json$/.exec(name);
      return match ? [match[1]] : [];
    });
  }
  pendingInstallations(): readonly RetentionInstallation[] {
    return this.pendingGuilds().map((guildId) => {
      const journal = this.#read(guildId)!;
      return {
        guildId: journal.guildId,
        databasePath: journal.databasePath,
        public: journal.public,
      };
    });
  }
  deletionLedger(guildId: string): DeletionLedger | null {
    return readDeletionLedger(resolve(this.#directory, ".."), guildId);
  }
  #blockProof(unsafeBefore: number): void {
    privateDirectory(this.#directory);
    const now = this.#clock();
    if (!timestamp(unsafeBefore) || !timestamp(now) || unsafeBefore > now)
      throw new Error("Invalid retention gap clock.");
    const path = join(this.#directory, unverifiedRulesDeletionGapFile),
      temporary = path + `.${randomUUID()}.tmp`;
    let blockedSince = now;
    if (!absent(path)) {
      if (regularFile(path) > 4096) throw new Error("Invalid retention gap marker.");
      const previous = JSON.parse(readFileSync(path, "utf8"));
      if (
        previous.format !== 1 ||
        previous.kind !== "gildiusz-retention-source-gap-unverified" ||
        previous.reason !== "lifecycle_unavailable" ||
        !timestamp(previous.blockedSince) ||
        !timestamp(previous.unsafeBefore) ||
        Object.keys(previous).sort().join(",") !== "blockedSince,format,kind,reason,unsafeBefore"
      )
        throw new Error("Invalid retention gap marker.");
      blockedSince = Math.min(blockedSince, previous.blockedSince);
      unsafeBefore = Math.max(unsafeBefore, previous.unsafeBefore);
    }
    try {
      writeFileSync(
        temporary,
        JSON.stringify({
          format: 1,
          kind: "gildiusz-retention-source-gap-unverified",
          blockedSince,
          unsafeBefore,
          reason: "lifecycle_unavailable",
        }) + "\n",
        { flag: "wx", mode: 0o600, flush: true },
      );
      renameSync(temporary, path);
      syncDirectory(this.#directory);
      syncDirectory(dirname(this.#directory));
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  /** Caller holds the data-root lease. No live guild or open database is needed. */
  pruneTerminalMetadata(limit = 20): { removed: number; blocked: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid retention metadata limit.");
    privateDirectory(this.#directory);
    const temporary = readdirSync(this.#directory)
      .filter((name) =>
        /^(?:[0-9]{17,20}\.(?:pending|deleted)\.json|source-gap-unverified\.json)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(
          name,
        ),
      )
      .slice(0, 64);
    // Only unpromoted files of our atomic writer are removable; their final record is authoritative.
    for (const name of temporary) {
      const file = join(this.#directory, name);
      safeRemovalFile(file);
      unlinkSync(file);
    }
    if (temporary.length) syncDirectory(this.#directory);
    const guilds = this.pendingGuilds().sort(),
      now = this.#clock();
    if (!timestamp(now)) throw new Error("Invalid retention clock.");
    let removed = 0,
      blocked = 0;
    for (let offset = 0; offset < Math.min(limit, guilds.length); offset++) {
      const guildId = guilds[(this.#metadataCursor + offset) % guilds.length];
      if (this.#active.has(guildId)) continue;
      let journal: PurgeJournal | null, proof: DeletionLedger | null;
      try {
        journal = this.#read(guildId, true);
        if (!journal) continue;
        proof = this.deletionLedger(guildId);
        if (proof) {
          const path = this.#path(guildId, "deleted");
          safeRemovalFile(path);
          if (process.platform !== "win32" && (lstatSync(path).mode & 0o077) !== 0)
            throw new Error("Terminal deletion metadata must be private.");
        }
      } catch {
        blocked++;
        continue;
      }
      if (!proof || proof.removedAt !== journal.removedAt) {
        blocked++;
        continue;
      }
      if (now < proof.purgedAt || now - proof.purgedAt < terminalRetentionMs) continue;
      this.#blockProof(proof.purgedAt);
      // This expires only our old records. It neither inspects the old DB path nor claims a current wipe.
      // Keep the first purge time until the pending bridge itself has disappeared durably.
      unlinkSync(this.#path(guildId));
      syncDirectory(this.#directory);
      unlinkSync(this.#path(guildId, "deleted"));
      syncDirectory(this.#directory);
      removed++;
    }
    if (guilds.length) this.#metadataCursor = (this.#metadataCursor + limit) % guilds.length;
    return { removed, blocked };
  }
  cancelPrepared(guildId: string): boolean {
    const journal = this.#read(guildId);
    if (!journal) return true;
    if (journal.phase !== "prepared") return false;
    if (!this.#canReopen(journal)) return false;
    unlinkSync(this.#path(guildId));
    syncDirectory(this.#directory);
    return true;
  }
  #canReopen(journal: PurgeJournal): boolean {
    try {
      return sameIdentity(identity(journal.databasePath), journal.databaseIdentity);
    } catch {
      return false;
    }
  }
  async purge(
    installation: RetentionInstallation,
    store: Store | undefined,
    ports: PurgePorts,
  ): Promise<PurgeOutcome> {
    const guildId = installation.guildId;
    if (!snowflake(guildId)) throw new Error("Invalid retention guild.");
    if (this.#active.has(guildId)) return { state: "deferred", store: store ? "open" : "closed" };
    this.#active.add(guildId);
    try {
      let journal = this.#read(guildId);
      let proofBeforeClose = false;
      const path = this.#databasePath(installation.databasePath);
      if (store && resolve(store.path) !== path) throw new Error("Retention Store path mismatch.");
      if (journal && resolve(journal.databasePath) !== path)
        throw new Error("Retention journal installation changed.");
      if (journal && journal.public !== !!installation.public)
        throw new Error("Retention journal installation kind changed.");
      if (!journal) {
        if (!store) return { state: "not_due", store: "closed" };
        const marker = readUninstallMarker(store, guildId),
          now = this.#clock();
        if (!marker || now < marker.removedAt || now - marker.removedAt < guildUninstallRetentionMs)
          return { state: "not_due", store: "open" };
        if (!ports.checkFence()) return { state: "deferred", store: "open" };
        const proof = await ports.freshProof(),
          state = fresh(proof, this.#clock());
        if (!ports.checkFence() || state === "unknown") return { state: "deferred", store: "open" };
        if (state === "present") {
          recordGuildMembership(store, guildId, proof, this.#clock());
          return { state: "rejoined", store: "open" };
        }
        proofBeforeClose = true;
        journal = {
          format: 1,
          guildId,
          removedAt: marker.removedAt,
          phase: "prepared",
          public: !!installation.public,
          databasePath: path,
          databaseIdentity: identity(path),
          assetNames: this.#assetFiles(guildId),
        };
        this.#write(guildId, journal);
      }
      if (journal.phase === "prepared" && !proofBeforeClose) {
        if (!ports.checkFence())
          return { state: "deferred", store: store ? "open" : "closed", phase: "prepared" };
        const proof = await ports.freshProof(),
          state = fresh(proof, this.#clock());
        if (!ports.checkFence() || state === "unknown")
          return { state: "deferred", store: store ? "open" : "closed", phase: "prepared" };
        if (state === "present" && store && this.cancelPrepared(guildId)) {
          recordGuildMembership(store, guildId, proof, this.#clock());
          return { state: "rejoined", store: "open" };
        }
      }
      const work = async (): Promise<PurgeOutcome> => {
        try {
          if (journal!.phase === "prepared") {
            const proof = await ports.freshProof(),
              state = fresh(proof, this.#clock());
            if (!this.#canReopen(journal!))
              return { state: "pending", store: "closed", phase: "prepared" };
            for (const file of [path + "-wal", path + "-shm"])
              if (!absent(file)) safeRemovalFile(file);
            const marker = closedMarker(path, guildId);
            if (!ports.checkFence())
              return { state: "deferred", store: "reopen", phase: "prepared" };
            if (state === "present") {
              this.cancelPrepared(guildId);
              return { state: "rejoined", store: "reopen" };
            }
            if (!marker || marker.removedAt !== journal!.removedAt) {
              this.cancelPrepared(guildId);
              return { state: "not_due", store: "reopen" };
            }
            if (state !== "absent")
              return { state: "deferred", store: "reopen", phase: "prepared" };
            if (installation.public && !this.options.registry)
              return { state: "deferred", store: "reopen", phase: "prepared" };
            this.options.registry?.validateRemoval?.();
            if (this.options.hub() === undefined)
              return { state: "deferred", store: "reopen", phase: "prepared" };
            if (!sameIdentity(identity(path), journal!.databaseIdentity))
              throw new Error("Uninstall database file changed.");
            journal!.assetNames = this.#assetFiles(guildId);
            for (const file of [path + "-wal", path + "-shm"])
              if (!absent(file)) safeRemovalFile(file);
            journal!.phase = "committed";
            this.#write(guildId, journal!);
            this.options.onStage?.("committed");
          }
          // After commit, a rejoin waits for this old-data wipe before a fresh installation.
          if (this.options.rulesDeletion) {
            try {
              await this.options.rulesDeletion.prepareRetirement(installation);
            } catch {
              const prior = this.deletionLedger(guildId);
              this.#blockProof(
                prior?.removedAt === journal!.removedAt ? prior.purgedAt : this.#clock(),
              );
            }
          }
          if (journal!.phase === "committed") {
            if (!absent(path) && !sameIdentity(identity(path), journal!.databaseIdentity))
              throw new Error("Uninstall database file changed.");
            const hub = this.options.hub();
            if (hub === undefined) return { state: "pending", store: "closed", phase: "committed" };
            if (hub) wipeGuildIntegrations(hub, guildId);
            journal!.phase = "hub_done";
            this.#write(guildId, journal!);
            this.options.onStage?.("hub_done");
          }
          if (journal!.phase === "hub_done") {
            if (!absent(path) && !sameIdentity(identity(path), journal!.databaseIdentity))
              throw new Error("Uninstall database file changed.");
            const assets = this.#assetFiles(guildId);
            if (assets.some((name) => !journal!.assetNames.includes(name)))
              throw new Error("Unexpected new uninstall assets.");
            for (const file of [path + "-wal", path + "-shm", path])
              if (!absent(file)) safeRemovalFile(file);
            for (const name of assets) unlinkSync(join(this.#assetDirectory(guildId), name));
            for (const file of [path + "-wal", path + "-shm", path])
              if (!absent(file)) unlinkSync(file);
            if (!absent(this.#assetDirectory(guildId)))
              syncDirectory(this.#assetDirectory(guildId));
            syncDirectory(dirname(path));
            journal!.phase = "files_done";
            this.#write(guildId, journal!);
            this.options.onStage?.("files_done");
          }
          if (journal!.phase === "files_done") {
            this.options.registry?.remove(guildId);
            journal!.phase = "registry_done";
            this.#write(guildId, journal!);
            this.options.onStage?.("registry_done");
          }
          const now = this.#clock();
          if (!timestamp(now)) throw new Error("Invalid retention clock.");
          const previous = this.deletionLedger(guildId),
            purgedAt = previous?.removedAt === journal!.removedAt ? previous.purgedAt : now;
          this.#write(
            guildId,
            { format: 1, guildId, removedAt: journal!.removedAt, purgedAt, outcome: "purged" },
            "deleted",
          );
          if (this.options.rulesDeletion) {
            try {
              await this.options.rulesDeletion.confirmRetired(installation);
            } catch (error) {
              this.#blockProof(purgedAt);
              throw error;
            }
          }
          unlinkSync(this.#path(guildId));
          syncDirectory(this.#directory);
          return { state: "purged", store: "closed" };
        } catch {
          const current = this.#read(guildId);
          return {
            state: "pending",
            store: current?.phase === "prepared" && this.#canReopen(current) ? "reopen" : "closed",
            phase: current?.phase,
          };
        }
      };
      return (
        (await ports.withClosedGuild(guildId, work)) ?? {
          state: "deferred",
          store: store ? "open" : "closed",
          phase: journal.phase,
        }
      );
    } finally {
      this.#active.delete(guildId);
    }
  }
}

export function wipeGuildIntegrations(db: DatabaseSync, guildId: string): void {
  if (!snowflake(guildId)) throw new Error("Invalid retention guild.");
  transaction(db, () => {
    db.prepare(
      "DELETE FROM twitch_fanout WHERE binding_id IN (SELECT id FROM twitch_bindings WHERE guild_id=?)",
    ).run(guildId);
    db.prepare("DELETE FROM twitch_bindings WHERE guild_id=?").run(guildId);
    db.prepare("DELETE FROM twitch_mutations WHERE scope GLOB ?").run(`${guildId}:*`);
  });
}
