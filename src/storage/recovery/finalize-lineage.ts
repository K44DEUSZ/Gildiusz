import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { parseConfiguration } from "../../contracts/configuration.js";
import { rulesDeletionState } from "../../modules/server-rules/deletion-outbox.js";
import type { RulesDeletionLifecycleJournal } from "../rules-deletion-lifecycle.js";
import { assertRestoredRulesQuarantined, reconcileRulesDeletionEntries } from "./deletions.js";

export interface RestoredInstallation {
  guildId: string;
  epoch: string;
  admittedAt: number;
  sequence: number;
  through: number;
  disposition: "keep" | "purge";
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(code: string): never {
  throw new Error(code);
}
export function assertCoreQuarantined(db: DatabaseSync, guildId: string): void {
  assertRestoredRulesQuarantined(db, guildId);
  const row = db.prepare("SELECT body FROM control_configuration WHERE guild=?").get(guildId);
  if (!row) fail("restored_core_configuration_absent");
  const core = parseConfiguration(JSON.parse(String(row.body)));
  if (
    Object.values(core.modules).some(Boolean) ||
    core.rooms.entryChannelId ||
    core.rooms.categoryId
  )
    fail("restored_core_not_quarantined");
  for (const row of db.prepare("SELECT body FROM guild_module_settings").all()) {
    const body = JSON.parse(String(row.body));
    if (
      !body.enabled ||
      typeof body.enabled !== "object" ||
      Object.values(body.enabled).some((value) => value !== false)
    )
      fail("restored_modules_not_quarantined");
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM schedules WHERE next_due_at IS NOT NULL OR active_job_id IS NOT NULL LIMIT 1",
      )
      .get() ||
    db
      .prepare("SELECT 1 FROM meetings WHERE state IN ('draft','open','starting','active') LIMIT 1")
      .get()
  )
    fail("restored_work_not_quarantined");
}
export function inspectRestoredInstallation(
  db: DatabaseSync,
  guildId: string,
  journal: RulesDeletionLifecycleJournal,
  now: number,
): RestoredInstallation {
  assertCoreQuarantined(db, guildId);
  const marker = db
    .prepare(
      "SELECT kind,id,baseline FROM resources WHERE key='retention.rules-deletion-installation'",
    )
    .get();
  if (!marker || marker.kind !== "retention") fail("restored_installation_marker_absent");
  const baseline = JSON.parse(String(marker.baseline)),
    active = journal.active.find((row) => row.guildId === guildId && row.epoch === marker.id),
    retired = journal.retired.find((row) => row.guildId === guildId && row.lastEpoch === marker.id),
    state = rulesDeletionState(db, guildId);
  if (
    baseline.format !== 1 ||
    baseline.sourceId !== journal.sourceId ||
    !Number.isSafeInteger(baseline.baseSequence) ||
    baseline.baseSequence < 0 ||
    !Number.isSafeInteger(baseline.admittedAt) ||
    baseline.admittedAt < 0 ||
    Object.keys(baseline).sort().join(",") !== "admittedAt,baseSequence,format,sourceId" ||
    state.gapAt !== null ||
    state.sequence !== state.journaledThrough ||
    baseline.baseSequence > state.sequence
  )
    fail("restored_installation_lineage_mismatch");
  if (!active && !retired) fail("restored_installation_epoch_unknown");
  const through = active?.through ?? retired!.through;
  if ((active && baseline.admittedAt !== active.admittedAt) || state.sequence > through)
    fail("restored_installation_counter_mismatch");
  for (const row of db
    .prepare("SELECT * FROM server_rules_deletion_outbox WHERE guild_id=? AND expires_at>?")
    .all(guildId, now)) {
    const entry = journal.entries.find(
      (entry) => entry.guildId === guildId && entry.acceptanceId === row.acceptance_id,
    );
    if (
      !entry ||
      row.sequence !== entry.sequence ||
      row.retired_at !== entry.retiredAt ||
      row.expires_at !== entry.expiresAt
    )
      fail("restored_outbox_history_mismatch");
  }
  for (const row of db
    .prepare("SELECT * FROM server_rules_retired_acceptances WHERE guild_id=? AND expires_at>?")
    .all(guildId, now)) {
    const entry = journal.entries.find(
      (entry) => entry.guildId === guildId && entry.acceptanceId === row.id,
    );
    if (!entry || row.retired_at !== entry.retiredAt || row.expires_at !== entry.expiresAt)
      fail("restored_fence_history_mismatch");
  }
  return {
    guildId,
    epoch: String(marker.id),
    admittedAt: baseline.admittedAt,
    sequence: state.sequence,
    through,
    disposition: active ? "keep" : "purge",
  };
}

export function reconcileRestoredGuild(
  db: DatabaseSync,
  guildId: string,
  journal: RulesDeletionLifecycleJournal,
  now: number,
): void {
  reconcileRulesDeletionEntries(db, {
    guildId,
    entries: journal.entries.filter((entry) => entry.guildId === guildId && entry.expiresAt > now),
    now,
    dryRun: false,
  });
}

/** Explicit populated-database rebase: imported history, never pristine admission or counter reset. */
export function rebaseRestoredGuild(
  db: DatabaseSync,
  original: RestoredInstallation,
  journal: RulesDeletionLifecycleJournal,
  newEpoch: string,
  admittedAt: number,
): void {
  if (
    original.disposition !== "keep" ||
    !/^[a-f0-9-]{36}$/.test(newEpoch) ||
    newEpoch === original.epoch
  )
    fail("invalid_recovery_epoch_transition");
  const entries = journal.entries.filter(
    (entry) => entry.guildId === original.guildId && entry.expiresAt > admittedAt,
  );
  db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM server_rules_deletion_outbox WHERE guild_id=?").run(original.guildId);
    db.prepare(
      "DELETE FROM server_rules_retired_acceptances WHERE guild_id=? AND expires_at<=?",
    ).run(original.guildId, admittedAt);
    for (const entry of entries) {
      db.prepare("INSERT OR IGNORE INTO server_rules_retired_acceptances VALUES(?,?,?,?)").run(
        entry.guildId,
        entry.acceptanceId,
        entry.retiredAt,
        entry.expiresAt,
      );
      db.prepare("INSERT INTO server_rules_deletion_outbox VALUES(?,?,?,?,?,?)").run(
        entry.guildId,
        entry.acceptanceId,
        entry.retiredAt,
        entry.expiresAt,
        entry.sequence,
        admittedAt,
      );
    }
    db.prepare(
      "INSERT INTO server_rules_deletion_state VALUES(?,?,?,NULL) ON CONFLICT(guild_id) DO UPDATE SET sequence=excluded.sequence,journaled_through=excluded.journaled_through,gap_at=NULL",
    ).run(original.guildId, original.through, original.through);
    db.prepare(
      "UPDATE resources SET id=?,baseline=? WHERE key='retention.rules-deletion-installation'",
    ).run(
      newEpoch,
      JSON.stringify({
        format: 1,
        sourceId: journal.sourceId,
        baseSequence: original.through,
        admittedAt,
      }),
    );
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function logicalDatabaseDigest(db: DatabaseSync): string {
  const hash = createHash("sha256"),
    tables = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
  hash.update(JSON.stringify(db.prepare("PRAGMA user_version").get()));
  for (const table of tables) {
    const name = String(table.name).replaceAll('"', '""'),
      columns = db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((row) => `"${String(row.name).replaceAll('"', '""')}"`);
    hash.update(JSON.stringify(table));
    for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY ${columns.join(",")}`).all())
      hash.update(
        JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
      );
  }
  return hash.digest("hex");
}

export function verifyRebasedGuild(
  db: DatabaseSync,
  original: RestoredInstallation,
  sourceId: string,
  newEpoch: string,
  admittedAt: number,
): void {
  assertCoreQuarantined(db, original.guildId);
  const marker = db
      .prepare(
        "SELECT id,baseline FROM resources WHERE key='retention.rules-deletion-installation'",
      )
      .get(),
    state = rulesDeletionState(db, original.guildId);
  if (
    marker?.id !== newEpoch ||
    !same(JSON.parse(String(marker.baseline)), {
      format: 1,
      sourceId,
      baseSequence: original.through,
      admittedAt,
    }) ||
    state.sequence !== original.through ||
    state.journaledThrough !== original.through ||
    state.gapAt !== null
  )
    fail("recovery_rebase_verification_failed");
}
