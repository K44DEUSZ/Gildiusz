export const casesMigration = {
  version: 6,
  name: "cases",
  sql: `
    CREATE TABLE cases (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('report','question','suggestion')),
      visibility TEXT NOT NULL CHECK(visibility IN ('private','public')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      assignee_id TEXT,
      revision INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      votes_revision INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      retention_at INTEGER,
      UNIQUE(guild_id,id),
      CHECK(kind='suggestion' OR visibility='private'),
      CHECK((kind IN ('report','question') AND status IN ('new','in_progress','waiting_author','resolved','closed')) OR
            (kind='suggestion' AND status IN ('new','in_review','accepted','rejected','implemented'))),
      CHECK(revision>0 AND generation>0 AND votes_revision>=0)
    );
    CREATE INDEX cases_guild_state ON cases(guild_id,status,created_at);
    CREATE INDEX cases_owner ON cases(guild_id,owner_id,status);
    CREATE TABLE case_messages (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('reply','note')),
      visibility TEXT NOT NULL CHECK(visibility IN ('private','public')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK(kind<>'note' OR visibility='private'),
      FOREIGN KEY(guild_id,case_id) REFERENCES cases(guild_id,id)
    );
    CREATE INDEX case_messages_case ON case_messages(guild_id,case_id,created_at,id);
    CREATE TABLE case_votes (
      guild_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      value INTEGER NOT NULL CHECK(value IN (-1,1)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(guild_id,case_id,user_id),
      FOREIGN KEY(guild_id,case_id) REFERENCES cases(guild_id,id)
    );
    CREATE TABLE case_events (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT,
      message_id TEXT,
      audience TEXT CHECK(audience IN ('author','staff','public')),
      generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(guild_id,case_id) REFERENCES cases(guild_id,id)
    );
    CREATE INDEX case_events_case ON case_events(guild_id,case_id,created_at,id);
    CREATE TABLE case_actions (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('write','vote')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX case_actions_recent ON case_actions(guild_id,actor_id,kind,created_at);
  `,
} as const;
