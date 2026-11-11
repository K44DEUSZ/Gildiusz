import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Store } from "../store.js";
import { migrate, migrationDefinitions } from "../migrations.js";
import { TwitchHubStore, twitchSchemaDefinitions } from "../../modules/twitch/store.js";
import { parseConfiguration } from "../../contracts/configuration.js";
import { validateSettings } from "../../settings.js";

export interface RecoverySchema {
  userVersion: number;
  migrations: { version: number; checksum: string }[];
  objects: { name: string; type: string; sql: string }[];
  knownPrefixes?: RecoverySchema[];
}
export interface RecoverySchemaPolicy {
  guild: RecoverySchema;
  hub: RecoverySchema;
}

export function schemaOf(db: DatabaseSync, kind: "guild" | "hub" | "web"): RecoverySchema {
  const table = kind === "guild" ? "schema_migrations" : "twitch_hub_migrations";
  const present =
    kind !== "web" &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return {
    userVersion: Number(db.prepare("PRAGMA user_version").get()!.user_version),
    migrations: present
      ? db
          .prepare(`SELECT version,checksum FROM ${table} ORDER BY version`)
          .all()
          .map((row) => ({ version: Number(row.version), checksum: String(row.checksum) }))
      : [],
    objects: db
      .prepare(
        "SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY type,name",
      )
      .all()
      .map((row) => ({ name: String(row.name), type: String(row.type), sql: String(row.sql) })),
  };
}

export function currentRecoverySchemaPolicy(): RecoverySchemaPolicy {
  const store = new Store(":memory:", "900000000000000001"),
    hub = new DatabaseSync(":memory:");
  try {
    new TwitchHubStore(hub, { authorize: () => {} });
    const guildSchema = schemaOf(store.db, "guild"),
      hubSchema = schemaOf(hub, "hub"),
      modules = new DatabaseSync(":memory:");
    try {
      migrate(modules);
      const moduleNames = new Set(schemaOf(modules, "guild").objects.map((value) => value.name));
      const baseline = guildSchema.objects.filter((value) => !moduleNames.has(value.name));
      guildSchema.knownPrefixes = prefixes(
        "guild",
        baseline,
        guildSchema.objects.find((value) => value.name === "schema_migrations")!,
        migrationDefinitions(),
      );
      hubSchema.knownPrefixes = prefixes(
        "hub",
        [],
        hubSchema.objects.find((value) => value.name === "twitch_hub_migrations")!,
        twitchSchemaDefinitions().map((sql, index) => ({ version: index + 1, sql })),
      );
      return { guild: guildSchema, hub: hubSchema };
    } finally {
      modules.close();
    }
  } finally {
    store.db.close();
    hub.close();
  }
}

function prefixes(
  kind: "guild" | "hub",
  baseline: RecoverySchema["objects"],
  ledger: RecoverySchema["objects"][number],
  definitions: readonly { version: number; name?: string; sql: string }[],
): RecoverySchema[] {
  const db = new DatabaseSync(":memory:"),
    result: RecoverySchema[] = [];
  try {
    for (const object of [...baseline].sort(
      (a, b) => (a.type === "table" ? 0 : 1) - (b.type === "table" ? 0 : 1),
    ))
      db.exec(object.sql);
    db.exec(ledger.sql);
    if (kind === "guild") db.exec("PRAGMA user_version=2");
    result.push(schemaOf(db, kind));
    for (const definition of definitions) {
      db.exec(definition.sql);
      const checksum = createHash("sha256").update(definition.sql).digest("hex");
      if (kind === "guild")
        db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,0)").run(
          definition.version,
          definition.name!,
          checksum,
        );
      else
        db.prepare("INSERT INTO twitch_hub_migrations VALUES (?,?)").run(
          definition.version,
          checksum,
        );
      result.push(schemaOf(db, kind));
    }
    return result;
  } finally {
    db.close();
  }
}

export function verifySchema(actual: RecoverySchema, supported: RecoverySchema): void {
  if (
    actual.userVersion > supported.userVersion ||
    actual.userVersion < 0 ||
    actual.migrations.length > supported.migrations.length
  )
    throw new Error("Recovery schema is not supported by this release.");
  for (const [index, value] of actual.migrations.entries()) {
    const expected = supported.migrations[index];
    if (!expected || value.version !== expected.version || value.checksum !== expected.checksum)
      throw new Error("Recovery migration checksum is not supported.");
  }
  const selected = (supported.knownPrefixes ?? [supported]).find(
    (candidate) =>
      candidate.userVersion === actual.userVersion &&
      candidate.migrations.length === actual.migrations.length &&
      candidate.migrations.length <= supported.migrations.length &&
      candidate.migrations.every(
        (row, index) =>
          row.version === actual.migrations[index]?.version &&
          row.checksum === actual.migrations[index]?.checksum,
      ),
  );
  if (!selected) throw new Error("Recovery schema prefix is not supported.");
  const expectedObjects = selected.objects.filter(
    (item) =>
      !(
        actual.migrations.length === 0 &&
        item.name === "schema_migrations" &&
        !actual.objects.some((value) => value.name === item.name)
      ),
  );
  if (actual.objects.length !== expectedObjects.length)
    throw new Error("Recovery database has missing or unexpected schema objects.");
  for (const item of actual.objects) {
    const expected = expectedObjects.find(
      (value) => value.type === item.type && value.name === item.name,
    );
    if (!expected || item.sql !== expected.sql)
      throw new Error("Recovery database contains an unsupported schema object.");
  }
}

export function assertIntegrity(db: DatabaseSync): void {
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
  const rows = db.prepare("PRAGMA integrity_check").all();
  if (
    rows.length !== 1 ||
    Object.values(rows[0])[0] !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").get()
  )
    throw new Error("Recovery database integrity check failed.");
}

function quarantineCoreConfiguration(db: DatabaseSync, now: number): void {
  const guildId = db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild;
  if (typeof guildId !== "string" || !/^\d{17,20}$/.test(guildId))
    throw new Error("Recovery core configuration is missing its guild identity.");
  if (
    db.prepare("SELECT 1 FROM control_configuration WHERE guild<>? LIMIT 1").get(guildId) ||
    db.prepare("SELECT 1 FROM runtime_settings WHERE guild<>? LIMIT 1").get(guildId)
  )
    throw new Error("Recovery core configuration contains another guild.");
  const saved = db.prepare("SELECT body FROM control_configuration WHERE guild=?").get(guildId),
    runtime = db.prepare("SELECT revision,body FROM runtime_settings WHERE guild=?").get(guildId),
    previousConfiguration = saved ? JSON.parse(String(saved.body)) : null,
    values = runtime ? validateSettings(JSON.parse(String(runtime.body))) : null,
    configuration = parseConfiguration(
      saved
        ? previousConfiguration
        : {
            revision: 0,
            modules: { rooms: false, reactions: false, files: false, reports: false },
            rooms: {
              entryChannelId: "",
              categoryId: "",
              maxRooms: values?.maximum ?? 10,
              userLimit: 0,
              idleSeconds: values?.emptySeconds ?? 60,
            },
            reactions: { channelId: "", choices: [] },
            files: {
              channelIds: [],
              formats: values
                ? values.extensions.map((extension) => extension.toUpperCase())
                : ["PDF", "PNG", "JPG", "JPEG", "WEBP", "GIF"],
              includeRooms: false,
            },
            reports: { channelId: "" },
          },
    ),
    revision = Math.max(configuration.revision, Number(runtime?.revision ?? 0)) + 1;
  if (
    (runtime && (!Number.isSafeInteger(runtime.revision) || Number(runtime.revision) < 0)) ||
    !Number.isSafeInteger(revision) ||
    revision > Number.MAX_SAFE_INTEGER - 1
  )
    throw new Error("Recovery core configuration revision is invalid.");
  const review = {
    format: 1,
    kind: "gildiusz-restored-core-configuration",
    guildId,
    previousConfiguration,
    previousRuntimeRevision: runtime?.revision ?? null,
    legacyFallbackDisabled: !saved,
    roomMappingDetached: true,
  };
  // The archive remains unchanged; retain the detached mapping for explicit operator review too.
  db.prepare("INSERT OR IGNORE INTO resources VALUES(?,'recovery-review',?,?)").run(
    `recovery.core-configuration.${createHash("sha256").update(JSON.stringify(review)).digest("hex")}`,
    guildId,
    JSON.stringify({ ...review, quarantinedAt: now }),
  );
  configuration.revision = revision;
  configuration.modules = { rooms: false, reactions: false, files: false, reports: false };
  // Main constructs/reconciles rooms by category presence even when the rooms switch is OFF.
  configuration.rooms.entryChannelId = "";
  configuration.rooms.categoryId = "";
  db.prepare(
    "INSERT INTO control_configuration VALUES (?,?) ON CONFLICT(guild) DO UPDATE SET body=excluded.body",
  ).run(guildId, JSON.stringify(configuration));
  if (runtime)
    db.prepare("UPDATE runtime_settings SET revision=?,updated=? WHERE guild=?").run(
      revision,
      now,
      guildId,
    );
}

export function quarantineDatabase(db: DatabaseSync, kind: "guild" | "hub", now: number): void {
  const has = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (kind === "guild") {
      quarantineCoreConfiguration(db, now);
      if (has("jobs"))
        db.prepare(
          `UPDATE jobs SET state=CASE WHEN state='running' THEN 'unknown' ELSE 'cancelled' END,
        cancel_requested=1,lease_token=NULL,lease_until=NULL,last_error='restore_quarantine',revision=revision+1,updated_at=?
        WHERE state IN ('pending','retry','running')`,
        ).run(now);
      if (has("delivery_attempts"))
        db.prepare(
          "UPDATE delivery_attempts SET state='unknown',error='restore_quarantine',finished_at=? WHERE state='sending'",
        ).run(now);
      if (has("announcements"))
        db.prepare(
          "UPDATE announcements SET status='paused',blocked_reason='restore_quarantine',revision=revision+1,generation=generation+1,updated_at=? WHERE status='scheduled'",
        ).run(now);
      if (has("schedules")) db.exec("UPDATE schedules SET active_job_id=NULL,next_due_at=NULL");
      if (has("guild_module_settings")) {
        for (const row of db
          .prepare("SELECT guild_id,body,revision FROM guild_module_settings")
          .all()) {
          const body = JSON.parse(String(row.body));
          if (body.enabled && typeof body.enabled === "object")
            for (const key of Object.keys(body.enabled)) body.enabled[key] = false;
          body.revision = Number(row.revision) + 1;
          db.prepare(
            "UPDATE guild_module_settings SET body=?,revision=?,updated_at=? WHERE guild_id=?",
          ).run(JSON.stringify(body), body.revision, now, String(row.guild_id));
        }
      }
      // Rules have independent settings; restoring the other module switches cannot disable them.
      if (has("server_rules_settings"))
        db.exec(
          "UPDATE server_rules_settings SET enabled=0,active_version_id=NULL,revision=revision+1,generation=generation+1",
        );
      if (has("server_rules_versions"))
        db.exec("UPDATE server_rules_versions SET state='retired' WHERE state<>'retired'");
      if (has("server_rules_acceptances"))
        db.exec(
          "UPDATE server_rules_acceptances SET grant_state='blocked',reason='restore_quarantine' WHERE grant_state IN ('pending','sending','unknown')",
        );
      if (has("meetings"))
        db.prepare(
          "UPDATE meetings SET state='cancelled',revision=revision+1,generation=generation+1,updated_at=? WHERE state IN ('draft','open','starting','active')",
        ).run(now);
    } else {
      if (has("twitch_bindings"))
        for (const row of db.prepare("SELECT id,definition FROM twitch_bindings").all()) {
          const body = JSON.parse(String(row.definition));
          body.enabled = false;
          body.revision += 1;
          body.generation += 1;
          db.prepare("UPDATE twitch_bindings SET definition=? WHERE id=?").run(
            JSON.stringify(body),
            String(row.id),
          );
        }
      if (has("twitch_inbox"))
        db.exec(
          "UPDATE twitch_inbox SET state='ignored',last_error='restore_quarantine' WHERE state='pending'",
        );
      if (has("twitch_fanout"))
        db.prepare(
          "UPDATE twitch_fanout SET state='skipped',reason='restore_quarantine',updated_at=? WHERE state='pending'",
        ).run(now);
      if (has("twitch_subscription_intents"))
        db.exec(
          "UPDATE twitch_subscription_intents SET state='superseded' WHERE state IN ('pending','registered','confirmed')",
        );
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
