export const announcementPresentationMigration = {
  version: 8,
  name: "announcement-presentation",
  sql: `ALTER TABLE announcements ADD COLUMN presentation TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(presentation));
  ALTER TABLE announcements ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0 CHECK(is_draft IN (0,1));`,
} as const;

export const announcementRemovalMigration = {
  version: 10,
  name: "announcement-removal",
  sql: `ALTER TABLE announcements ADD COLUMN removed_at INTEGER;
  CREATE INDEX announcements_visible ON announcements(guild_id,removed_at,created_at);`,
} as const;
