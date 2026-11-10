import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../../storage/migrations.js";

export const rulesDeletionRetentionMs = 35 * 86400000;
export const rulesDeletionUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface RulesDeletionEntry {
  guildId: string;
  acceptanceId: string;
  retiredAt: number;
  expiresAt: number;
  sequence: number;
}
export class RulesDeletionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RulesDeletionError";
  }
}
export function deletionInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new RulesDeletionError("invalid_input");
  return Number(value);
}
export function deletionGuildId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{17,20}$/.test(value))
    throw new RulesDeletionError("invalid_input");
  return value;
}
export function validateRulesDeletion(value: RulesDeletionEntry): RulesDeletionEntry {
  deletionGuildId(value.guildId);
  if (!rulesDeletionUuid.test(value.acceptanceId)) throw new RulesDeletionError("invalid_input");
  deletionInteger(value.retiredAt);
  deletionInteger(value.expiresAt);
  deletionInteger(value.sequence, 1);
  if (value.expiresAt - value.retiredAt !== rulesDeletionRetentionMs)
    throw new RulesDeletionError("invalid_input");
  return value;
}
function identity(db: DatabaseSync, guildId: string): void {
  deletionGuildId(guildId);
  if (db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !== guildId)
    throw new RulesDeletionError("guild_mismatch");
}
export function rulesDeletionState(
  db: DatabaseSync,
  guildId: string,
): {
  sequence: number;
  journaledThrough: number;
  gapAt: number | null;
} {
  identity(db, guildId);
  const row = db.prepare("SELECT * FROM server_rules_deletion_state WHERE guild_id=?").get(guildId);
  const value = {
    sequence: deletionInteger(row?.sequence ?? 0),
    journaledThrough: deletionInteger(row?.journaled_through ?? 0),
    gapAt: row?.gap_at == null ? null : deletionInteger(row.gap_at),
  };
  if (value.journaledThrough > value.sequence) throw new RulesDeletionError("source_changed");
  return value;
}
/** Called inside the same SQLite transaction that erases the acceptance. */
export function recordRulesDeletion(
  db: DatabaseSync,
  guildId: string,
  acceptanceId: string,
  retiredAt: number,
  expiresAt: number,
): RulesDeletionEntry {
  identity(db, guildId);
  if (!db.isTransaction) throw new RulesDeletionError("transaction_required");
  validateRulesDeletion({ guildId, acceptanceId, retiredAt, expiresAt, sequence: 1 });
  const existing = db
    .prepare("SELECT * FROM server_rules_deletion_outbox WHERE guild_id=? AND acceptance_id=?")
    .get(guildId, acceptanceId);
  if (existing) {
    if (existing.retired_at !== retiredAt || existing.expires_at !== expiresAt)
      throw new RulesDeletionError("conflicting_deletion");
    return { guildId, acceptanceId, retiredAt, expiresAt, sequence: Number(existing.sequence) };
  }
  const state = rulesDeletionState(db, guildId),
    sequence = deletionInteger(state.sequence + 1, 1);
  db.prepare(
    "INSERT INTO server_rules_deletion_state VALUES(?,?,0,NULL) ON CONFLICT(guild_id) DO UPDATE SET sequence=excluded.sequence",
  ).run(guildId, sequence);
  db.prepare("INSERT INTO server_rules_deletion_outbox VALUES(?,?,?,?,?,NULL)").run(
    guildId,
    acceptanceId,
    retiredAt,
    expiresAt,
    sequence,
  );
  return { guildId, acceptanceId, retiredAt, expiresAt, sequence };
}
export function pendingRulesDeletions(
  db: DatabaseSync,
  guildId: string,
  limit = 100,
): RulesDeletionEntry[] {
  identity(db, guildId);
  if (deletionInteger(limit, 1) > 1000) throw new RulesDeletionError("invalid_input");
  return db
    .prepare(
      "SELECT * FROM server_rules_deletion_outbox WHERE guild_id=? AND journaled_at IS NULL ORDER BY sequence LIMIT ?",
    )
    .all(guildId, limit)
    .map((row) =>
      validateRulesDeletion({
        guildId,
        acceptanceId: String(row.acceptance_id),
        retiredAt: Number(row.retired_at),
        expiresAt: Number(row.expires_at),
        sequence: Number(row.sequence),
      }),
    );
}
/** A journal ACK cannot precede its durable filesystem write. Caller enforces that ordering. */
export function acknowledgeRulesDeletions(
  db: DatabaseSync,
  entries: RulesDeletionEntry[],
  now: number,
): void {
  deletionInteger(now);
  transaction(db, () => {
    for (const entry of entries) {
      validateRulesDeletion(entry);
      const state = rulesDeletionState(db, entry.guildId),
        row = db
          .prepare(
            "SELECT * FROM server_rules_deletion_outbox WHERE guild_id=? AND acceptance_id=?",
          )
          .get(entry.guildId, entry.acceptanceId);
      if (
        !row ||
        row.retired_at !== entry.retiredAt ||
        row.expires_at !== entry.expiresAt ||
        row.sequence !== entry.sequence ||
        entry.expiresAt <= now ||
        state.gapAt !== null
      )
        throw new RulesDeletionError("source_changed");
      if (row.journaled_at !== null) continue;
      if (entry.sequence !== state.journaledThrough + 1) throw new RulesDeletionError("source_gap");
      db.prepare(
        "UPDATE server_rules_deletion_outbox SET journaled_at=? WHERE guild_id=? AND acceptance_id=?",
      ).run(now, entry.guildId, entry.acceptanceId);
      db.prepare("UPDATE server_rules_deletion_state SET journaled_through=? WHERE guild_id=?").run(
        entry.sequence,
        entry.guildId,
      );
    }
  });
}
export function expireRulesDeletions(
  db: DatabaseSync,
  guildId: string,
  now: number,
  limit = 1000,
): number {
  identity(db, guildId);
  deletionInteger(now);
  if (deletionInteger(limit, 1) > 1000) throw new RulesDeletionError("invalid_input");
  return transaction(db, () => {
    const rows = db
      .prepare(
        "SELECT acceptance_id,journaled_at FROM server_rules_deletion_outbox WHERE guild_id=? AND expires_at<=? ORDER BY expires_at,sequence LIMIT ?",
      )
      .all(guildId, now, limit);
    if (rows.some((row) => row.journaled_at === null))
      db.prepare(
        "UPDATE server_rules_deletion_state SET gap_at=COALESCE(gap_at,?) WHERE guild_id=?",
      ).run(now, guildId);
    for (const row of rows)
      db.prepare(
        "DELETE FROM server_rules_deletion_outbox WHERE guild_id=? AND acceptance_id=?",
      ).run(guildId, String(row.acceptance_id));
    return rows.length;
  });
}
