import type { DatabaseSync } from "node:sqlite";
import { JobStore } from "../../core/jobs/store.js";
import { ServerRulesRetention } from "../../modules/server-rules/retention.js";
import {
  acknowledgeRulesDeletions,
  validateRulesDeletion,
  rulesDeletionState,
} from "../../modules/server-rules/deletion-outbox.js";
import { pruneDomainData } from "../domain-retention.js";
import { wipeGuildIntegrations } from "../uninstall-retention.js";
import type { RulesDeletionEntry } from "../../modules/server-rules/deletion-outbox.js";

export function applyRestoredRetention(
  db: DatabaseSync,
  guildId: string,
  now: number,
): {
  through: number;
  entries: RulesDeletionEntry[];
} {
  const jobs = new JobStore(db, () => now),
    rules = new ServerRulesRetention(jobs, { guildId, clock: () => now });
  for (let batch = 0; batch < 100; batch++) {
    const result = rules.prune({ limit: 1000 });
    if (
      !result.acceptancesRemoved &&
      !result.membershipsRemoved &&
      !result.jobsScrubbed &&
      !result.fencesExpired
    )
      break;
    if (batch === 99) throw new Error("recovery_rules_retention_quota");
  }
  for (let batch = 0; batch < 100; batch++) {
    const result = pruneDomainData(jobs, guildId, { now, limit: 1000 });
    if (result.deferredCases || result.deferredMeetings)
      throw new Error("recovery_retention_deferred");
    if (!result.casesRemoved && !result.meetingsRemoved && !result.jobsRetired) break;
    if (batch === 99) throw new Error("recovery_domain_retention_quota");
  }
  const entries = db
    .prepare(
      "SELECT * FROM server_rules_deletion_outbox WHERE guild_id=? AND journaled_at IS NULL ORDER BY sequence LIMIT 10001",
    )
    .all(guildId)
    .map((row) => ({
      guildId,
      acceptanceId: String(row.acceptance_id),
      retiredAt: Number(row.retired_at),
      expiresAt: Number(row.expires_at),
      sequence: Number(row.sequence),
    }));
  if (entries.length > 10000) throw new Error("recovery_retention_history_quota");
  for (const entry of entries) validateRulesDeletion(entry);
  return { through: rulesDeletionState(db, guildId).sequence, entries };
}

/** The caller must fsync its authenticated recovery history before acknowledging these entries. */
export function acknowledgeRestoredRetention(
  db: DatabaseSync,
  entries: readonly RulesDeletionEntry[],
  now: number,
): void {
  acknowledgeRulesDeletions(db, [...entries], now);
}

export function eraseRetiredGuildIntegrations(db: DatabaseSync, guildIds: readonly string[]): void {
  for (const guildId of guildIds) wipeGuildIntegrations(db, guildId);
}

export function scrubRestoredWebData(db: DatabaseSync): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  if (
    tables.some((row) => !["sessions", "oauth_states", "preview_config"].includes(String(row.name)))
  )
    throw new Error("unsupported_recovery_web_data");
  db.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
  try {
    for (const row of tables) db.exec(`DELETE FROM "${String(row.name)}"`);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export function assertRestoredWebEmpty(db: DatabaseSync): void {
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const name = String(row.name);
    if (
      !["sessions", "oauth_states", "preview_config"].includes(name) ||
      db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get()
    )
      throw new Error("restored_web_data_not_empty");
  }
}

export function assertHubQuarantined(db: DatabaseSync): void {
  for (const row of db.prepare("SELECT definition FROM twitch_bindings").all())
    if (JSON.parse(String(row.definition)).enabled !== false)
      throw new Error("restored_hub_not_quarantined");
  if (
    db.prepare("SELECT 1 FROM twitch_inbox WHERE state='pending' LIMIT 1").get() ||
    db.prepare("SELECT 1 FROM twitch_fanout WHERE state='pending' LIMIT 1").get() ||
    db
      .prepare(
        "SELECT 1 FROM twitch_subscription_intents WHERE state IN ('pending','registered','confirmed') LIMIT 1",
      )
      .get()
  )
    throw new Error("restored_hub_work_not_quarantined");
}
