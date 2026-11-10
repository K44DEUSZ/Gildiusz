import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, open, readdir, realpath, statfs, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Announcement, AnnouncementAsset } from "../../contracts/modules.js";
import { migrate, transaction } from "../../storage/migrations.js";
import {
  AnnouncementAssetError,
  type AnnouncementAssetData,
  type AnnouncementAssetPort,
} from "./types.js";
import { validateImage } from "./validate.js";

const retentionMs = 86400000,
  uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const formats = {
  "image/png": { extension: "png", name: "announcement.png" },
  "image/jpeg": { extension: "jpg", name: "announcement.jpg" },
  "image/webp": { extension: "webp", name: "announcement.webp" },
} as const;
function directorySecure(path: string): boolean {
  const info = lstatSync(path);
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (process.platform === "win32" || ((info.mode & 0o022) === 0 && info.uid === process.getuid!()))
  );
}
function ancestorsSecure(path: string): boolean {
  if (process.platform === "win32") return true;
  for (let current = dirname(path); ; current = dirname(current)) {
    const info = lstatSync(current);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      ((info.mode & 0o022) !== 0 &&
        (!(info.mode & 0o1000) || (info.uid !== 0 && info.uid !== process.getuid!())))
    )
      return false;
    if (dirname(current) === current) return true;
  }
}
interface AssetRow {
  id: string;
  guild_id: string;
  media_type: AnnouncementAsset["mediaType"];
  size: number;
  width: number;
  height: number;
  hash: string;
  created_at: number;
  unlinked_at: number | null;
}
export interface AnnouncementAssetStoreOptions {
  clock?: () => number;
  maxGuildBytes?: number;
  maxGuildFiles?: number;
  minimumFreeBytes?: number;
  maxUploadsPerMinute?: number;
}

export class AnnouncementAssetStore implements AnnouncementAssetPort {
  readonly #directory: string;
  readonly #root: string;
  readonly #clock: () => number;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #minimumFree: number;
  readonly #maximumUploads: number;
  readonly #attempts = new Map<string, { at: number; count: number }>();
  constructor(
    readonly db: DatabaseSync,
    readonly guildId: string,
    root: string,
    options: AnnouncementAssetStoreOptions = {},
  ) {
    if (!/^\d{17,20}$/.test(guildId) || !isAbsolute(root))
      throw new AnnouncementAssetError("asset_storage_unavailable");
    this.#clock = options.clock ?? Date.now;
    this.#maxBytes = options.maxGuildBytes ?? 33554432;
    this.#maxFiles = options.maxGuildFiles ?? 64;
    this.#minimumFree = options.minimumFreeBytes ?? 67108864;
    this.#maximumUploads = options.maxUploadsPerMinute ?? 12;
    if (
      ![this.#maxBytes, this.#maxFiles, this.#minimumFree, this.#maximumUploads].every(
        (value) => Number.isSafeInteger(value) && value >= 1,
      )
    )
      throw new AnnouncementAssetError("asset_storage_unavailable");
    try {
      const target = resolve(root);
      if (/[\\/]public_html(?:[\\/]|$)/i.test(target)) throw Error();
      mkdirSync(target, { recursive: true, mode: 0o700 });
      if (!directorySecure(target) || !ancestorsSecure(target)) throw Error();
      this.#root = realpathSync(target);
      if (/[\\/]public_html(?:[\\/]|$)/i.test(this.#root)) throw Error();
      this.#directory = join(this.#root, guildId);
      mkdirSync(this.#directory, { mode: 0o700, recursive: true });
      if (!directorySecure(this.#directory) || realpathSync(this.#directory) !== this.#directory)
        throw Error();
      migrate(db);
    } catch {
      throw new AnnouncementAssetError("asset_storage_unavailable");
    }
  }
  #row(id: string): AssetRow {
    if (typeof id !== "string" || !uuid.test(id))
      throw new AnnouncementAssetError("asset_not_found");
    const row = this.db
      .prepare("SELECT * FROM announcement_assets WHERE id=? AND guild_id=?")
      .get(id, this.guildId) as unknown as AssetRow | undefined;
    if (!row) throw new AnnouncementAssetError("asset_not_found");
    if (row.width > 2048 || row.height > 2048) throw new AnnouncementAssetError("invalid_asset");
    if (row.unlinked_at !== null && row.unlinked_at + retentionMs <= this.#clock())
      throw new AnnouncementAssetError("asset_expired");
    return row;
  }
  describeAsset(id: string): AnnouncementAsset {
    const row = this.#row(id);
    return {
      id: row.id,
      guildId: row.guild_id,
      mediaType: row.media_type,
      size: row.size,
      width: row.width,
      height: row.height,
      createdAt: row.created_at,
      expiresAt: row.unlinked_at === null ? null : row.unlinked_at + retentionMs,
    };
  }
  async #guard(): Promise<void> {
    try {
      if (
        !directorySecure(this.#root) ||
        !ancestorsSecure(this.#root) ||
        !directorySecure(this.#directory) ||
        (await lstat(this.#root)).isSymbolicLink() ||
        (await realpath(this.#root)) !== this.#root ||
        (await lstat(this.#directory)).isSymbolicLink() ||
        (await realpath(this.#directory)) !== this.#directory
      )
        throw Error();
    } catch {
      throw new AnnouncementAssetError("asset_storage_unavailable");
    }
  }
  #path(row: Pick<AssetRow, "id" | "media_type">): string {
    if (!uuid.test(row.id) || !Object.hasOwn(formats, row.media_type))
      throw new AnnouncementAssetError("asset_not_found");
    return join(this.#directory, `${row.id}.${formats[row.media_type].extension}`);
  }
  async readAsset(id: string): Promise<AnnouncementAssetData> {
    const row = this.#row(id);
    await this.#guard();
    let handle;
    try {
      handle = await open(this.#path(row), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== row.size || stat.nlink !== 1) throw Error();
      const data = await handle.readFile();
      if (digest(data) !== row.hash) throw Error();
      this.#row(id);
      return { name: formats[row.media_type].name, contentType: row.media_type, data };
    } catch (error) {
      if (error instanceof AnnouncementAssetError) throw error;
      throw new AnnouncementAssetError("asset_storage_unavailable");
    } finally {
      await handle?.close();
    }
  }
  async validateAsset(id: string): Promise<void> {
    await this.readAsset(id);
  }
  #replay(actorId: string, requestId: string, inputHash: string): AnnouncementAsset | null {
    const replay = this.db
      .prepare(
        "SELECT input_hash,asset_id FROM announcement_asset_uploads WHERE guild_id=? AND actor_id=? AND request_id=?",
      )
      .get(this.guildId, actorId, requestId);
    if (!replay) return null;
    if (replay.input_hash !== inputHash) throw new AnnouncementAssetError("idempotency_conflict");
    try {
      return this.describeAsset(String(replay.asset_id));
    } catch (error) {
      if (error instanceof AnnouncementAssetError && error.code === "asset_not_found")
        throw new AnnouncementAssetError("asset_expired");
      throw error;
    }
  }
  async upload(
    actorId: string,
    requestId: string,
    mediaType: string,
    data: Uint8Array,
    authorize?: () => Promise<void>,
  ): Promise<AnnouncementAsset> {
    if (
      !/^\d{17,20}$/.test(actorId) ||
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(requestId) ||
      !Object.hasOwn(formats, mediaType) ||
      !(data instanceof Uint8Array) ||
      !data.byteLength ||
      data.byteLength > 2097152
    )
      throw new AnnouncementAssetError("invalid_asset");
    await authorize?.();
    const inputHash = createHash("sha256")
        .update(mediaType)
        .update("\0")
        .update(data)
        .digest("hex"),
      replay = this.#replay(actorId, requestId, inputHash);
    if (replay) {
      await this.validateAsset(replay.id);
      await authorize?.();
      return replay;
    }
    const usage = this.db
      .prepare(
        "SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS files FROM announcement_assets WHERE guild_id=? AND (unlinked_at IS NULL OR unlinked_at>?)",
      )
      .get(this.guildId, this.#clock() - retentionMs)!;
    if (
      Number(usage.bytes) + data.byteLength > this.#maxBytes ||
      Number(usage.files) >= this.#maxFiles
    )
      throw new AnnouncementAssetError("asset_quota");
    const at = this.#clock();
    for (const [id, bucket] of this.#attempts)
      if (bucket.at <= at - 60000) this.#attempts.delete(id);
    const budget = this.#attempts.get(actorId) ?? { at, count: 0 };
    if (
      budget.count >= this.#maximumUploads ||
      (!this.#attempts.has(actorId) && this.#attempts.size >= 1000)
    )
      throw new AnnouncementAssetError("asset_busy");
    budget.count++;
    this.#attempts.set(actorId, budget);
    await this.prune();
    await this.#guard();
    const filesystem = await statfs(this.#directory);
    if (filesystem.bavail * filesystem.bsize < this.#minimumFree + data.byteLength)
      throw new AnnouncementAssetError("asset_quota");
    const dimensions = await validateImage(data, mediaType);
    await this.#guard();
    const id = randomUUID(),
      now = this.#clock(),
      row: AssetRow = {
        id,
        guild_id: this.guildId,
        media_type: mediaType as AssetRow["media_type"],
        size: data.byteLength,
        ...dimensions,
        hash: digest(data),
        created_at: now,
        unlinked_at: now,
      };
    const path = this.#path(row);
    let created = false,
      committed = false;
    try {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== "win32") {
        const directory = await open(this.#directory, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      await authorize?.();
      const result = transaction(this.db, () => {
        const previous = this.#replay(actorId, requestId, inputHash);
        if (previous) return previous;
        const quota = this.db
          .prepare(
            "SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS files FROM announcement_assets WHERE guild_id=?",
          )
          .get(this.guildId)!;
        if (
          Number(quota.bytes) + data.byteLength > this.#maxBytes ||
          Number(quota.files) >= this.#maxFiles
        )
          throw new AnnouncementAssetError("asset_quota");
        this.db
          .prepare("INSERT INTO announcement_assets VALUES (?,?,?,?,?,?,?,?,?)")
          .run(id, this.guildId, mediaType, row.size, row.width, row.height, row.hash, now, now);
        this.db
          .prepare("INSERT INTO announcement_asset_uploads VALUES (?,?,?,?,?)")
          .run(this.guildId, actorId, requestId, inputHash, id);
        return this.describeAsset(id);
      });
      committed = result.id === id;
      return result;
    } catch (error) {
      if (error instanceof AnnouncementAssetError) throw error;
      throw new AnnouncementAssetError("asset_storage_unavailable");
    } finally {
      if (created && !committed) await unlink(path).catch(() => {});
    }
  }
  syncAnnouncement(announcement: Announcement): void {
    if (
      !this.db.isTransaction ||
      announcement.guildId !== this.guildId ||
      !uuid.test(announcement.id)
    )
      throw new AnnouncementAssetError("invalid_asset");
    const persisted = this.db
      .prepare("SELECT guild_id FROM announcements WHERE id=?")
      .get(announcement.id);
    if (persisted?.guild_id !== this.guildId) throw new AnnouncementAssetError("asset_not_found");
    const next = announcement.card?.imageAssetId,
      previous = this.db
        .prepare(
          "SELECT asset_id FROM announcement_asset_refs WHERE announcement_id=? AND guild_id=?",
        )
        .get(announcement.id, this.guildId);
    if (next) this.#row(next);
    if (previous?.asset_id === next) return;
    this.db
      .prepare("DELETE FROM announcement_asset_refs WHERE announcement_id=? AND guild_id=?")
      .run(announcement.id, this.guildId);
    if (previous)
      this.db
        .prepare(
          "UPDATE announcement_assets SET unlinked_at=? WHERE id=? AND guild_id=? AND NOT EXISTS(SELECT 1 FROM announcement_asset_refs WHERE asset_id=announcement_assets.id)",
        )
        .run(this.#clock(), previous.asset_id as string, this.guildId);
    if (next) {
      this.db
        .prepare("INSERT INTO announcement_asset_refs VALUES (?,?,?)")
        .run(announcement.id, next, this.guildId);
      this.db
        .prepare("UPDATE announcement_assets SET unlinked_at=NULL WHERE id=? AND guild_id=?")
        .run(next, this.guildId);
    }
  }
  async prune(): Promise<number> {
    await this.#guard();
    const removed = transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE announcement_assets SET unlinked_at=? WHERE guild_id=? AND unlinked_at IS NULL AND NOT EXISTS(SELECT 1 FROM announcement_asset_refs WHERE asset_id=announcement_assets.id)",
        )
        .run(this.#clock(), this.guildId);
      const rows = this.db
        .prepare(
          "SELECT * FROM announcement_assets WHERE guild_id=? AND unlinked_at IS NOT NULL AND unlinked_at<=? AND NOT EXISTS(SELECT 1 FROM announcement_asset_refs WHERE asset_id=announcement_assets.id) LIMIT 100",
        )
        .all(this.guildId, this.#clock() - retentionMs) as unknown as AssetRow[];
      for (const row of rows)
        this.db
          .prepare("DELETE FROM announcement_assets WHERE id=? AND guild_id=?")
          .run(row.id, this.guildId);
      return rows;
    });
    for (const row of removed) await unlink(this.#path(row)).catch(() => {});
    const names = await readdir(this.#directory);
    for (const name of names.slice(0, 1000)) {
      const match = /^([a-f0-9-]{36})\.(png|jpg|webp)$/.exec(name);
      if (!match || !uuid.test(match[1])) continue;
      if (
        this.db
          .prepare("SELECT 1 FROM announcement_assets WHERE id=? AND guild_id=?")
          .get(match[1], this.guildId)
      )
        continue;
      const path = join(this.#directory, name),
        stat = await lstat(path).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.mtimeMs <= this.#clock() - retentionMs)
        await unlink(path).catch(() => {});
    }
    return removed.length;
  }
}
