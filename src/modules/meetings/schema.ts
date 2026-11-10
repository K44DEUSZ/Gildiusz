// Included by the central migration ledger; services never create schema on demand.
export const meetingSchema = `
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    organizer_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 100),
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
    channel_id TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
    allowed_role_ids TEXT NOT NULL,
    organizer_participates INTEGER NOT NULL CHECK(organizer_participates IN (0,1)),
    room TEXT NOT NULL,
    reminder_minutes TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft','open','starting','active','completed','cancelled')),
    revision INTEGER NOT NULL DEFAULT 1,
    generation INTEGER NOT NULL DEFAULT 1,
    participant_version INTEGER NOT NULL DEFAULT 0,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    message_id TEXT,
    room_channel_id TEXT,
    room_created_by_bot INTEGER NOT NULL DEFAULT 0 CHECK(room_created_by_bot IN (0,1)),
    guild_scheduled_event_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX meetings_guild ON meetings(guild_id,state,starts_at);
  CREATE TABLE meeting_participants (
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    user_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('confirmed','waitlisted','left')),
    sequence INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    left_reason TEXT,
    PRIMARY KEY(meeting_id,user_id),
    UNIQUE(meeting_id,sequence)
  );
  CREATE INDEX meeting_waitlist ON meeting_participants(meeting_id,state,sequence);
  CREATE TABLE meeting_audit (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE meeting_effect_receipts (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    result TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

export const meetingInvitesMigration = {
  version: 7,
  name: "meeting-invites",
  sql: `CREATE TABLE meeting_invites (
    meeting_id TEXT NOT NULL REFERENCES meetings(id),
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(meeting_id,user_id)
  );
  CREATE INDEX meeting_invites_member ON meeting_invites(user_id,meeting_id);`,
} as const;
