import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { meetingSchema, meetingInvitesMigration } from "../modules/meetings/schema.js";
import { casesMigration } from "../modules/cases/schema.js";
import {
  announcementPresentationMigration,
  announcementRemovalMigration,
} from "../modules/announcements/schema.js";
import { announcementAssetsMigration } from "../modules/announcement-assets/schema.js";
import { domainRetentionMigration } from "./retention-schema.js";
import { serverRulesMigration } from "../modules/server-rules/schema.js";

const migrations = [
  {
    version: 1,
    name: "durable-jobs",
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','retry','failed','cancelled','expired','unknown')),
        due_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        expires_at INTEGER,
        dedupe_key TEXT NOT NULL UNIQUE,
        object_id TEXT,
        generation INTEGER NOT NULL CHECK(generation >= 0),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
        lease_token TEXT,
        lease_until INTEGER,
        revision INTEGER NOT NULL DEFAULT 1,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
        message_id TEXT,
        last_error TEXT,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK((state = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
              (state <> 'running' AND lease_token IS NULL AND lease_until IS NULL))
      );
      CREATE INDEX jobs_ready ON jobs(state,next_attempt_at,due_at);
      CREATE INDEX jobs_lease ON jobs(state,lease_until);
      CREATE INDEX jobs_object ON jobs(guild_id,object_id,generation);
      CREATE TABLE delivery_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        number INTEGER NOT NULL,
        lease_token TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('sending','succeeded','retry','rate_limited','failed','cancelled','expired','unknown')),
        nonce TEXT,
        channel_id TEXT,
        message_id TEXT,
        error TEXT,
        result TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE(job_id,number),
        UNIQUE(job_id,lease_token)
      );
      CREATE INDEX delivery_attempts_job ON delivery_attempts(job_id,number);
      CREATE TABLE idempotency_keys (
        scope TEXT NOT NULL,
        request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(scope,request_id)
      );
      CREATE INDEX idempotency_keys_created ON idempotency_keys(created_at);
    `,
  },
  {
    version: 2,
    name: "guild-module-settings",
    sql: `CREATE TABLE guild_module_settings (
      guild_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL,
      actor TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`,
  },
  {
    version: 3,
    name: "announcements",
    sql: `
      CREATE TABLE announcements (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        content TEXT NOT NULL,
        role_ids TEXT NOT NULL,
        mention_everyone INTEGER NOT NULL CHECK(mention_everyone IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('scheduled','paused','cancelled','completed','expired','blocked')),
        revision INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        last_message_id TEXT,
        last_published_at INTEGER,
        blocked_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX announcements_guild ON announcements(guild_id,status,created_at);
      CREATE TABLE schedules (
        announcement_id TEXT PRIMARY KEY REFERENCES announcements(id),
        definition TEXT NOT NULL,
        active_job_id TEXT REFERENCES jobs(id),
        next_due_at INTEGER,
        last_processed_at INTEGER,
        published_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE announcement_actions (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('write','test')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX announcement_actions_recent ON announcement_actions(actor_id,kind,created_at);
    `,
  },
  {
    version: 4,
    name: "announcement-job-receipts",
    sql: `CREATE TABLE announcement_job_receipts (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id),
      announcement_id TEXT NOT NULL REFERENCES announcements(id),
      delivered INTEGER NOT NULL CHECK(delivered IN (0,1)),
      processed_at INTEGER NOT NULL
    )`,
  },
  { version: 5, name: "meetings", sql: meetingSchema },
  casesMigration,
  meetingInvitesMigration,
  announcementPresentationMigration,
  announcementAssetsMigration,
  announcementRemovalMigration,
  domainRetentionMigration,
  serverRulesMigration,
] as const;

export function migrationDefinitions(): readonly { version: number; name: string; sql: string }[] {
  return migrations.map(({ version, name, sql }) => ({ version, name, sql }));
}

export function transaction<T>(db: DatabaseSync, task: () => T): T {
  const nested = db.isTransaction;
  const point = `job_${randomUUID().replaceAll("-", "")}`;
  db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
  try {
    const result = task();
    if (result && typeof result === "object" && "then" in result)
      throw new TypeError("Database transactions must be synchronous.");
    db.exec(nested ? `RELEASE ${point}` : "COMMIT");
    return result;
  } catch (error) {
    if (nested) db.exec(`ROLLBACK TO ${point}; RELEASE ${point}`);
    else if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function migrate(db: DatabaseSync): void {
  transaction(db, () => {
    // Module migrations are additive; the established bot schema stays readable as version 2.
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
    )`);
    const installed = db
      .prepare("SELECT version,checksum FROM schema_migrations ORDER BY version")
      .all();
    if (installed.some((row) => Number(row.version) > migrations.length))
      throw new Error("Module database was created by a newer application.");
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const existing = installed.find((row) => Number(row.version) === migration.version);
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error("Applied module migration was changed.");
        continue;
      }
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(
        migration.version,
        migration.name,
        checksum,
        Date.now(),
      );
    }
  });
}
