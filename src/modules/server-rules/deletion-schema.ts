export const serverRulesDeletionMigration = Object.freeze({
  version: 13,
  name: "server-rules-deletion-outbox",
  sql: `CREATE TABLE server_rules_deletion_state (
    guild_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL CHECK(sequence>=0),
    journaled_through INTEGER NOT NULL CHECK(journaled_through>=0 AND journaled_through<=sequence),
    gap_at INTEGER
  );
  CREATE TABLE server_rules_deletion_outbox (
    guild_id TEXT NOT NULL, acceptance_id TEXT NOT NULL, retired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), journaled_at INTEGER,
    PRIMARY KEY(guild_id,acceptance_id), UNIQUE(guild_id,sequence)
  );
  CREATE INDEX server_rules_deletion_pending ON server_rules_deletion_outbox(guild_id,journaled_at,sequence);
  INSERT INTO server_rules_deletion_outbox(guild_id,acceptance_id,retired_at,expires_at,sequence)
    SELECT guild_id,id,retired_at,expires_at,
      ROW_NUMBER() OVER(PARTITION BY guild_id ORDER BY retired_at,id)
    FROM server_rules_retired_acceptances;
  INSERT INTO server_rules_deletion_state(guild_id,sequence,journaled_through)
    SELECT guild_id,MAX(sequence),0 FROM server_rules_deletion_outbox GROUP BY guild_id;`,
});
