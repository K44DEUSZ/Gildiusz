import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical } from "../shared/utils.js";

export interface Resource {
  key: string;
  kind: string;
  id: string;
  baseline: string;
}
export interface Room {
  id: string;
  owner: string;
  locked: boolean;
  allowed: string[];
  arrivals: Record<string, number>;
  emptySince: number | null;
  ownerAbsentSince: number | null;
}
export interface EventRow {
  id: string;
  created: number;
  kind: string;
  subject: string;
  result: string;
  channel: string | null;
  message: string | null;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    if (version > 2) throw new Error("Database was created by a newer application.");
    if (version === 0)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE resources (key TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, baseline TEXT NOT NULL);
      CREATE TABLE rooms (id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, created INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, result TEXT NOT NULL, channel TEXT, message TEXT);
      CREATE INDEX events_created ON events(created);
      CREATE TABLE cooldowns (key TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
      CREATE TABLE operations (key TEXT PRIMARY KEY, created INTEGER NOT NULL, body TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
    if (version < 2)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE runtime_settings (guild TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, actor TEXT NOT NULL, updated INTEGER NOT NULL);
      PRAGMA user_version=2; COMMIT;`);
  }
  resources(): Resource[] {
    return this.db.prepare("SELECT * FROM resources ORDER BY key").all() as unknown as Resource[];
  }
  resource(key: string): Resource | undefined {
    return this.db.prepare("SELECT * FROM resources WHERE key=?").get(key) as unknown as
      Resource | undefined;
  }
  id(key: string): string {
    const resource = this.resource(key);
    if (!resource) throw new Error(`Missing managed resource: ${key}`);
    return resource.id;
  }
  putResource(key: string, kind: string, id: string, baseline: unknown): void {
    this.db
      .prepare(
        "INSERT INTO resources VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,id=excluded.id,baseline=excluded.baseline",
      )
      .run(key, kind, id, canonical(baseline));
  }
  rooms(): Room[] {
    return this.db
      .prepare("SELECT body FROM rooms")
      .all()
      .map((row) => JSON.parse(row.body as string) as Room);
  }
  room(id: string): Room | undefined {
    const row = this.db.prepare("SELECT body FROM rooms WHERE id=?").get(id);
    return row ? (JSON.parse(row.body as string) as Room) : undefined;
  }
  putRoom(room: Room): void {
    this.db
      .prepare(
        "INSERT INTO rooms VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,body=excluded.body",
      )
      .run(room.id, room.owner, JSON.stringify(room));
  }
  deleteRoom(id: string): void {
    this.db.prepare("DELETE FROM rooms WHERE id=?").run(id);
  }
  transaction<T>(task: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = task();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  cooldown(key: string, durationMs: number, now = Date.now()): boolean {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT until_ms FROM cooldowns WHERE key=?").get(key);
      if (current && Number(current.until_ms) > now) return false;
      this.db
        .prepare(
          "INSERT INTO cooldowns VALUES (?,?) ON CONFLICT(key) DO UPDATE SET until_ms=excluded.until_ms",
        )
        .run(key, now + durationMs);
      return true;
    });
  }
  event(
    kind: string,
    subject: string,
    result: string,
    channel: string | null = null,
    message: string | null = null,
  ): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?)")
      .run(id, Date.now(), kind, subject, result, channel, message);
    return id;
  }
  oldEvents(before: number): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE created < ?")
      .all(before) as unknown as EventRow[];
  }
  deleteEvent(id: string): void {
    this.db.prepare("DELETE FROM events WHERE id=?").run(id);
  }
  cleanCooldowns(now = Date.now()): void {
    this.db.prepare("DELETE FROM cooldowns WHERE until_ms < ?").run(now);
  }
  settings(guild: string): { revision: number; body: string } | undefined {
    return this.db
      .prepare("SELECT revision, body FROM runtime_settings WHERE guild=?")
      .get(guild) as { revision: number; body: string } | undefined;
  }
  saveSettings(guild: string, body: unknown, expected: number, actor: string): number {
    return this.transaction(() => {
      if ((this.settings(guild)?.revision ?? 0) !== expected) throw new Error("settings_conflict");
      const revision = expected + 1;
      this.db
        .prepare(
          "INSERT INTO runtime_settings VALUES (?,?,?,?,?) ON CONFLICT(guild) DO UPDATE SET revision=excluded.revision,body=excluded.body,actor=excluded.actor,updated=excluded.updated",
        )
        .run(guild, revision, canonical(body), actor, Date.now());
      this.event("settings", guild, `revision:${revision};actor:${actor}`);
      return revision;
    });
  }
  beginOperation(key: string, body: unknown): void {
    this.db.prepare("INSERT INTO operations VALUES (?,?,?)").run(key, Date.now(), canonical(body));
  }
  endOperation(key: string): void {
    this.db.prepare("DELETE FROM operations WHERE key=?").run(key);
  }
  operations(): unknown[] {
    return this.db.prepare("SELECT * FROM operations").all();
  }
  async backup(target: string): Promise<void> {
    mkdirSync(dirname(target), { recursive: true });
    await backup(this.db, target);
  }
  close(): void {
    this.db.close();
  }
}
