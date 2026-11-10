export const serverRulesMigration = Object.freeze({
  version: 12,
  name: "server-rules",
  sql: `CREATE TABLE server_rules_settings (
    guild_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), draft TEXT,
    active_version_id TEXT
  );
  CREATE TABLE server_rules_versions (
    guild_id TEXT NOT NULL, id TEXT NOT NULL, generation INTEGER NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)), content_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN('publishing','active','retired')),
    created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
    PRIMARY KEY(guild_id,id)
  );
  CREATE TABLE server_rules_parts (
    guild_id TEXT NOT NULL, version_id TEXT NOT NULL, part_index INTEGER NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL, job_id TEXT NOT NULL,
    message_id TEXT, state TEXT NOT NULL CHECK(state IN('pending','sending','unverified','confirmed')),
    reaction_job_id TEXT, reaction_state TEXT NOT NULL CHECK(reaction_state IN('not_required','pending','sending','confirmed','unknown')),
    PRIMARY KEY(guild_id,version_id,part_index), UNIQUE(guild_id,message_id),
    FOREIGN KEY(guild_id,version_id) REFERENCES server_rules_versions(guild_id,id)
  );
  CREATE TABLE server_rules_memberships (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
    left_at INTEGER, revoked_at INTEGER,
    last_checked_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(guild_id,user_id,joined_at)
  );
  CREATE TABLE server_rules_acceptances (
    guild_id TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
    version_id TEXT NOT NULL, role_id TEXT NOT NULL, accepted_at INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN('button','reaction','reaction_reconcile')),
    grant_state TEXT NOT NULL CHECK(grant_state IN('pending','sending','confirmed','already_present','unknown','blocked')),
    job_id TEXT, confirmed_at INTEGER, reason TEXT,
    PRIMARY KEY(guild_id,id), UNIQUE(guild_id,user_id,joined_at,version_id),
    FOREIGN KEY(guild_id,version_id) REFERENCES server_rules_versions(guild_id,id)
  );
  CREATE INDEX server_rules_user ON server_rules_acceptances(guild_id,user_id,joined_at);
  CREATE INDEX server_rules_grants ON server_rules_acceptances(guild_id,grant_state);
  CREATE TABLE server_rules_retired_acceptances (
    guild_id TEXT NOT NULL, id TEXT NOT NULL, retired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(guild_id,id)
  );
  CREATE INDEX server_rules_retired_expiry ON server_rules_retired_acceptances(guild_id,expires_at);`,
});
