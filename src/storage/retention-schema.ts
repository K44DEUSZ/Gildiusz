export const domainRetentionMigration = {
  version: 11,
  name: "domain-history-retention",
  sql: `CREATE TABLE job_history_retired (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    retired_at INTEGER NOT NULL
  );
  CREATE TABLE domain_retired (
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('case','meeting')),
    object_id TEXT NOT NULL,
    retired_at INTEGER NOT NULL,
    PRIMARY KEY(guild_id,kind,object_id)
  );`,
} as const;
