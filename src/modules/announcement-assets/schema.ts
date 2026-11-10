export const announcementAssetsMigration = {
  version: 9,
  name: "announcement-image-assets",
  sql: `
    CREATE TABLE announcement_assets (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/webp')),
      size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 2097152),
      width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 4096),
      height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 4096),
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      unlinked_at INTEGER
    );
    CREATE INDEX announcement_assets_scope ON announcement_assets(guild_id,unlinked_at);
    CREATE TABLE announcement_asset_refs (
      announcement_id TEXT PRIMARY KEY REFERENCES announcements(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES announcement_assets(id) ON DELETE RESTRICT,
      guild_id TEXT NOT NULL
    );
    CREATE INDEX announcement_asset_usage ON announcement_asset_refs(asset_id,guild_id);
    CREATE TABLE announcement_asset_uploads (
      guild_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      PRIMARY KEY(guild_id,actor_id,request_id)
    );
  `,
} as const;
