import type { DatabaseSync } from "node:sqlite";
import { AnnouncementAssetError } from "./types.js";

// Reference release is a database operation, including when file storage is unavailable.
export function detachAnnouncementAsset(
  db: DatabaseSync,
  guildId: string,
  announcementId: string,
  at: number,
): void {
  if (!db.isTransaction || !Number.isSafeInteger(at) || at < 0)
    throw new AnnouncementAssetError("invalid_asset");
  const parent = db.prepare("SELECT guild_id FROM announcements WHERE id=?").get(announcementId);
  if (parent?.guild_id !== guildId) throw new AnnouncementAssetError("asset_not_found");
  const previous = db
    .prepare("SELECT asset_id FROM announcement_asset_refs WHERE announcement_id=? AND guild_id=?")
    .get(announcementId, guildId);
  db.prepare("DELETE FROM announcement_asset_refs WHERE announcement_id=? AND guild_id=?").run(
    announcementId,
    guildId,
  );
  if (previous)
    db.prepare(
      "UPDATE announcement_assets SET unlinked_at=? WHERE id=? AND guild_id=? AND NOT EXISTS(SELECT 1 FROM announcement_asset_refs WHERE asset_id=announcement_assets.id)",
    ).run(at, String(previous.asset_id), guildId);
}
