import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { transaction } from "../migrations.js";
import {
  recordRulesDeletion,
  validateRulesDeletion,
  deletionGuildId,
  deletionInteger,
  type RulesDeletionEntry,
} from "../../modules/server-rules/deletion-outbox.js";

export class RestoredDeletionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RestoredDeletionError";
  }
}
export interface RestoredRulesDeletionResult {
  acceptancesRemoved: number;
  membershipsRemoved: number;
  jobsScrubbed: number;
  attemptsScrubbed: number;
  cacheEntriesScrubbed: number;
  fencesAdded: number;
}
const fail = (code: string): never => {
  throw new RestoredDeletionError(code);
};
const retiredResult = JSON.stringify({ retired: true, reason: "acceptance_deleted" });
function references(text: unknown, ids: Set<string>): string[] {
  return [
    ...new Set(
      [
        ...String(text ?? "").matchAll(
          /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
        ),
      ]
        .map((match) => match[0])
        .filter((id) => ids.has(id)),
    ),
  ];
}
function decoded(value: unknown): string {
  if (value === null) return "";
  const text = String(value);
  if (Buffer.byteLength(text) > 65536) fail("reconciliation_quota");
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    throw new RestoredDeletionError("invalid_cached_payload");
  }
}
function budget(db: DatabaseSync, table: string, fields: string[]): void {
  const sum = fields.map((field) => `COALESCE(length(CAST(${field} AS BLOB)),0)`).join("+");
  const row = db
    .prepare(`SELECT COUNT(*) count,COALESCE(SUM(${sum}),0) bytes FROM ${table}`)
    .get()!;
  if (Number(row.count) > 50000 || Number(row.bytes) > 16 * 1024 * 1024)
    fail("reconciliation_quota");
}
function has(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
export function assertRestoredRulesQuarantined(db: DatabaseSync, guildId: string): void {
  deletionGuildId(guildId);
  if (db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !== guildId)
    fail("guild_mismatch");
  for (const table of [
    "jobs",
    "server_rules_settings",
    "server_rules_versions",
    "server_rules_parts",
    "server_rules_memberships",
    "server_rules_acceptances",
    "server_rules_retired_acceptances",
    "server_rules_deletion_state",
    "server_rules_deletion_outbox",
  ])
    if (
      has(db, table) &&
      db.prepare(`SELECT 1 FROM ${table} WHERE guild_id<>? LIMIT 1`).get(guildId)
    )
      fail("guild_mismatch");
  if (
    has(db, "jobs") &&
    db
      .prepare(
        "SELECT 1 FROM jobs WHERE state IN('pending','retry','running') OR lease_token IS NOT NULL OR lease_until IS NOT NULL LIMIT 1",
      )
      .get()
  )
    fail("target_not_quarantined");
  if (
    has(db, "delivery_attempts") &&
    db.prepare("SELECT 1 FROM delivery_attempts WHERE state='sending' LIMIT 1").get()
  )
    fail("target_not_quarantined");
  if (
    has(db, "server_rules_settings") &&
    db
      .prepare(
        "SELECT 1 FROM server_rules_settings WHERE enabled<>0 OR active_version_id IS NOT NULL LIMIT 1",
      )
      .get()
  )
    fail("target_not_quarantined");
  if (
    has(db, "server_rules_versions") &&
    db.prepare("SELECT 1 FROM server_rules_versions WHERE state<>'retired' LIMIT 1").get()
  )
    fail("target_not_quarantined");
}
interface JobPlan {
  id: string;
  state: string;
  needsScrub: boolean;
  attemptIds: string[];
  retiredAt: number;
}
interface FencePlan {
  entry: RulesDeletionEntry;
  insert: boolean;
  outbox: boolean;
}
interface Plan {
  acceptanceIds: string[];
  cohorts: { userId: string; joinedAt: number }[];
  jobs: JobPlan[];
  cache: { scope: string; requestId: string }[];
  fences: FencePlan[];
  result: RestoredRulesDeletionResult;
}
function plan(
  db: DatabaseSync,
  guildId: string,
  entries: readonly RulesDeletionEntry[],
  now: number,
): Plan {
  assertRestoredRulesQuarantined(db, guildId);
  deletionInteger(now);
  if (entries.length > 10000) fail("reconciliation_quota");
  const seen = new Set<string>();
  for (const e of entries) {
    validateRulesDeletion(e);
    if (
      e.guildId !== guildId ||
      e.retiredAt > now ||
      e.expiresAt <= now ||
      seen.has(e.acceptanceId)
    )
      fail("invalid_decision");
    seen.add(e.acceptanceId);
  }
  const result: RestoredRulesDeletionResult = {
      acceptancesRemoved: 0,
      membershipsRemoved: 0,
      jobsScrubbed: 0,
      attemptsScrubbed: 0,
      cacheEntriesScrubbed: 0,
      fencesAdded: 0,
    },
    value: Plan = { acceptanceIds: [], cohorts: [], jobs: [], cache: [], fences: [], result };
  if (!has(db, "server_rules_acceptances")) return value;
  budget(db, "jobs", ["payload", "result", "dedupe_key"]);
  budget(db, "idempotency_keys", ["scope", "request_id", "result"]);
  const jobs = db
    .prepare("SELECT * FROM jobs WHERE guild_id=? AND type='server-rules.grant-role'")
    .all(guildId);
  if (jobs.length > 50000) fail("reconciliation_quota");
  const byAcceptance = new Map<string, typeof jobs>(),
    byId = new Map(jobs.map((job) => [String(job.id), job])),
    payloads = new Map<string, Record<string, unknown> | null>();
  for (const job of jobs) {
    let payload;
    try {
      payload = JSON.parse(String(job.payload));
    } catch {
      fail("invalid_job_association");
    }
    payloads.set(String(job.id), payload);
    for (const id of references(
      JSON.stringify(payload) + decoded(job.result) + String(job.dedupe_key),
      seen,
    )) {
      const selected = byAcceptance.get(id) ?? [];
      selected.push(job);
      byAcceptance.set(id, selected);
    }
  }
  const jobPlans = new Map<string, JobPlan>();
  for (const entry of entries) {
    const row = db
        .prepare("SELECT * FROM server_rules_acceptances WHERE guild_id=? AND id=?")
        .get(guildId, entry.acceptanceId),
      fence = db
        .prepare("SELECT * FROM server_rules_retired_acceptances WHERE guild_id=? AND id=?")
        .get(guildId, entry.acceptanceId);
    if (
      row &&
      (Number(row.accepted_at) > entry.retiredAt || Number(row.joined_at) > entry.retiredAt)
    )
      fail("decision_before_acceptance");
    if (fence && (fence.retired_at !== entry.retiredAt || fence.expires_at !== entry.expiresAt))
      fail("conflicting_deletion");
    const outbox = has(db, "server_rules_deletion_outbox")
      ? db
          .prepare(
            "SELECT * FROM server_rules_deletion_outbox WHERE guild_id=? AND acceptance_id=?",
          )
          .get(guildId, entry.acceptanceId)
      : null;
    if (outbox && (outbox.retired_at !== entry.retiredAt || outbox.expires_at !== entry.expiresAt))
      fail("conflicting_deletion");
    value.fences.push({
      entry,
      insert: !fence,
      outbox: has(db, "server_rules_deletion_outbox") && !outbox,
    });
    if (!fence) result.fencesAdded++;
    if (row) {
      value.acceptanceIds.push(entry.acceptanceId);
      value.cohorts.push({ userId: String(row.user_id), joinedAt: Number(row.joined_at) });
      result.acceptancesRemoved++;
    }
    if (row?.job_id) {
      const linked = db
        .prepare("SELECT guild_id,type,payload FROM jobs WHERE id=?")
        .get(String(row.job_id));
      if (linked && (linked.guild_id !== guildId || linked.type !== "server-rules.grant-role"))
        fail("invalid_job_association");
      if (linked) {
        let payload;
        try {
          payload = JSON.parse(String(linked.payload));
        } catch {
          fail("invalid_job_association");
        }
        if (payload?.acceptanceId !== undefined && payload.acceptanceId !== entry.acceptanceId)
          fail("invalid_job_association");
      }
    }
    const selected = new Map(
      (byAcceptance.get(entry.acceptanceId) ?? []).map((job) => [String(job.id), job]),
    );
    if (row?.job_id && byId.has(String(row.job_id)))
      selected.set(String(row.job_id), byId.get(String(row.job_id))!);
    for (const job of selected.values()) {
      const payload = payloads.get(String(job.id));
      if (payload?.acceptanceId !== undefined && payload.acceptanceId !== entry.acceptanceId)
        fail("invalid_job_association");
      const id = String(job.id);
      if (id === entry.acceptanceId) fail("invalid_job_association");
      const state = String(job.state),
        error = state === "unknown" ? "retention_unresolved" : null,
        attempts = db.prepare("SELECT * FROM delivery_attempts WHERE job_id=?").all(id),
        dirtyAttempts = attempts.filter(
          (a) =>
            a.result !== null ||
            a.nonce !== null ||
            a.channel_id !== null ||
            a.message_id !== null ||
            a.error !== (a.state === "unknown" ? "retention_unresolved" : null),
        );
      const prior = jobPlans.get(id),
        retiredAt = Math.min(entry.retiredAt, prior?.retiredAt ?? entry.retiredAt),
        retired = db.prepare("SELECT retired_at FROM job_history_retired WHERE job_id=?").get(id),
        needsScrub =
          String(job.payload) !== "{}" ||
          job.result !== null ||
          job.dedupe_key !== `server-rules:retired:${id}` ||
          job.last_error !== error ||
          job.message_id !== null ||
          job.cancel_requested !== 1 ||
          !retired ||
          Number(retired.retired_at) > retiredAt;
      jobPlans.set(id, {
        id,
        state,
        needsScrub,
        attemptIds: dirtyAttempts.map((a) => String(a.id)),
        retiredAt,
      });
    }
  }
  const ids = new Set(value.acceptanceIds);
  value.cohorts = [
    ...new Map(
      value.cohorts.map((cohort) => [`${cohort.userId}:${cohort.joinedAt}`, cohort]),
    ).values(),
  ].filter(
    (cohort) =>
      !db
        .prepare(
          "SELECT id FROM server_rules_acceptances WHERE guild_id=? AND user_id=? AND joined_at=?",
        )
        .all(guildId, cohort.userId, cohort.joinedAt)
        .some((a) => !ids.has(String(a.id))),
  );
  result.membershipsRemoved = value.cohorts.filter(
    (c) =>
      !!db
        .prepare(
          "SELECT 1 FROM server_rules_memberships WHERE guild_id=? AND user_id=? AND joined_at=?",
        )
        .get(guildId, c.userId, c.joinedAt),
  ).length;
  value.jobs = [...jobPlans.values()];
  result.jobsScrubbed = value.jobs.filter((j) => j.needsScrub).length;
  result.attemptsScrubbed = value.jobs.reduce((n, j) => n + j.attemptIds.length, 0);
  const caches = db.prepare("SELECT scope,request_id,result FROM idempotency_keys").all();
  if (caches.length > 50000) fail("reconciliation_quota");
  for (const cache of caches) {
    const keys = [String(cache.scope), String(cache.request_id)];
    if (keys.some((key) => references(key, seen).length)) fail("unsupported_cache_key");
    if (references(decoded(cache.result), seen).length)
      value.cache.push({ scope: String(cache.scope), requestId: String(cache.request_id) });
  }
  result.cacheEntriesScrubbed = value.cache.length;
  return value;
}
/** SQL-only internal port. The wrapper must authenticate v2 and the original archive first. */
export function reconcileRulesDeletionEntries(
  db: DatabaseSync,
  options: {
    guildId: string;
    entries: readonly RulesDeletionEntry[];
    now: number;
    dryRun?: boolean;
    beforeCommit?: () => void;
  },
): RestoredRulesDeletionResult {
  if (options.dryRun !== false)
    return plan(db, options.guildId, options.entries, options.now).result;
  db.exec("PRAGMA secure_delete=ON");
  return transaction(db, () => {
    const value = plan(db, options.guildId, options.entries, options.now),
      guildId = options.guildId;
    for (const fence of value.fences) {
      if (fence.insert)
        db.prepare("INSERT INTO server_rules_retired_acceptances VALUES(?,?,?,?)").run(
          guildId,
          fence.entry.acceptanceId,
          fence.entry.retiredAt,
          fence.entry.expiresAt,
        );
      if (fence.outbox)
        recordRulesDeletion(
          db,
          guildId,
          fence.entry.acceptanceId,
          fence.entry.retiredAt,
          fence.entry.expiresAt,
        );
    }
    for (const job of value.jobs) {
      if (job.needsScrub) {
        db.prepare(
          "UPDATE jobs SET payload='{}',result=NULL,dedupe_key=?,input_hash=?,cancel_requested=1,message_id=NULL,last_error=?,revision=revision+1,updated_at=? WHERE guild_id=? AND id=?",
        ).run(
          `server-rules:retired:${job.id}`,
          createHash("sha256").update("{}").digest("hex"),
          job.state === "unknown" ? "retention_unresolved" : null,
          options.now,
          guildId,
          job.id,
        );
        db.prepare(
          "INSERT INTO job_history_retired VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET retired_at=MIN(retired_at,excluded.retired_at)",
        ).run(job.id, job.retiredAt);
      }
      for (const id of job.attemptIds)
        db.prepare(
          "UPDATE delivery_attempts SET result=NULL,nonce=NULL,channel_id=NULL,message_id=NULL,error=CASE WHEN state='unknown' THEN 'retention_unresolved' ELSE NULL END WHERE job_id=? AND id=?",
        ).run(job.id, id);
    }
    for (const cache of value.cache)
      db.prepare("UPDATE idempotency_keys SET result=? WHERE scope=? AND request_id=?").run(
        retiredResult,
        cache.scope,
        cache.requestId,
      );
    for (const id of value.acceptanceIds)
      db.prepare("DELETE FROM server_rules_acceptances WHERE guild_id=? AND id=?").run(guildId, id);
    for (const cohort of value.cohorts)
      db.prepare(
        "DELETE FROM server_rules_memberships WHERE guild_id=? AND user_id=? AND joined_at=? AND NOT EXISTS(SELECT 1 FROM server_rules_acceptances WHERE guild_id=? AND user_id=? AND joined_at=?)",
      ).run(guildId, cohort.userId, cohort.joinedAt, guildId, cohort.userId, cohort.joinedAt);
    options.beforeCommit?.();
    return value.result;
  });
}
