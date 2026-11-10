import type { JobStore } from "../../core/jobs/store.js";
import { assertFresh, rulesId, rulesInteger } from "./policy.js";
import { RulesError } from "./types.js";

const day = 86400000;
export const serverRulesRetentionPolicy = Object.freeze({
  acceptancesAfterDepartureMs: 30 * day,
  // Opaque operation IDs, not a second consent/member register. Restore still requires quarantine.
  retiredAcceptanceFenceMs: 35 * day,
});
export interface RulesMembershipObservation {
  guildId: string;
  userId: string;
  observedAt: number;
  presence: "present" | "absent" | "unknown";
  joinedAt?: number;
  expectedJoinedAt?: number;
}
export interface RulesRetentionResult {
  acceptancesRemoved: number;
  membershipsRemoved: number;
  jobsScrubbed: number;
  fencesExpired: number;
}

/** No Discord/FS effects. Absence must be fresh authoritative REST evidence, never missing cache. */
export class ServerRulesRetention {
  readonly guildId: string;
  private readonly clock: () => number;
  private readonly maximumAge: number;
  constructor(
    readonly jobs: JobStore,
    options: { guildId: string; clock?: () => number; maxFactAgeMs?: number },
  ) {
    this.guildId = rulesId(options.guildId);
    this.clock = options.clock ?? Date.now;
    this.maximumAge = rulesInteger(options.maxFactAgeMs ?? 15000, 1);
    if (
      this.maximumAge > 60000 ||
      jobs.db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !==
        this.guildId
    )
      throw new RulesError("invalid_input");
  }
  private now(): number {
    return rulesInteger(this.clock());
  }
  private limit(value: number | undefined, fallback: number, maximum: number): number {
    const limit = rulesInteger(value ?? fallback, 1);
    if (limit > maximum) throw new RulesError("invalid_input");
    return limit;
  }
  observe(value: RulesMembershipObservation): {
    departed: number;
    restored: number;
    ignored: boolean;
  } {
    if (
      !value ||
      value.guildId !== this.guildId ||
      !["present", "absent", "unknown"].includes(value.presence)
    )
      throw new RulesError("invalid_input");
    rulesId(value.userId);
    const now = this.now();
    try {
      assertFresh(value.observedAt, now, this.maximumAge);
    } catch (error) {
      if (error instanceof RulesError) return { departed: 0, restored: 0, ignored: true };
      throw error;
    }
    if (value.presence === "present") rulesInteger(value.joinedAt, 1);
    if (value.expectedJoinedAt !== undefined) rulesInteger(value.expectedJoinedAt, 1);
    if (value.joinedAt !== undefined && value.joinedAt > value.observedAt)
      throw new RulesError("invalid_input");
    return this.jobs.transaction(() => {
      let departed = 0,
        restored = 0;
      const rows = this.jobs.db
        .prepare(
          "SELECT joined_at,left_at,last_checked_at FROM server_rules_memberships WHERE guild_id=? AND user_id=?",
        )
        .all(this.guildId, value.userId);
      for (const row of rows) {
        const joinedAt = Number(row.joined_at);
        if (Number(row.last_checked_at) > value.observedAt || joinedAt > value.observedAt) continue;
        if (
          value.presence === "absent" &&
          value.expectedJoinedAt !== undefined &&
          joinedAt !== value.expectedJoinedAt
        )
          continue;
        if (value.presence === "present" && joinedAt > value.joinedAt!) continue;
        this.jobs.db
          .prepare(
            "UPDATE server_rules_memberships SET last_checked_at=? WHERE guild_id=? AND user_id=? AND joined_at=?",
          )
          .run(value.observedAt, this.guildId, value.userId, joinedAt);
        if (value.presence === "unknown") continue;
        if (value.presence === "present" && joinedAt === value.joinedAt) {
          if (row.left_at !== null && value.observedAt >= Number(row.left_at)) {
            this.jobs.db
              .prepare(
                "UPDATE server_rules_memberships SET left_at=NULL WHERE guild_id=? AND user_id=? AND joined_at=?",
              )
              .run(this.guildId, value.userId, joinedAt);
            restored++;
          }
          continue;
        }
        if (row.left_at === null) departed++;
        this.jobs.db
          .prepare(
            "UPDATE server_rules_memberships SET left_at=COALESCE(left_at,?) WHERE guild_id=? AND user_id=? AND joined_at=?",
          )
          .run(now, this.guildId, value.userId, joinedAt);
        for (const grant of this.jobs.db
          .prepare(
            "SELECT job_id FROM server_rules_acceptances WHERE guild_id=? AND user_id=? AND joined_at=? AND job_id IS NOT NULL",
          )
          .all(this.guildId, value.userId, joinedAt))
          this.jobs.cancel(String(grant.job_id));
        this.jobs.db
          .prepare(
            "UPDATE server_rules_acceptances SET grant_state='blocked',reason='membership_changed' WHERE guild_id=? AND user_id=? AND joined_at=? AND grant_state='pending'",
          )
          .run(this.guildId, value.userId, joinedAt);
      }
      return { departed, restored, ignored: value.presence === "unknown" };
    });
  }
  async reconcile(
    read: (userId: string, expectedJoinedAt?: number) => Promise<RulesMembershipObservation>,
    options: { limit?: number } = {},
  ): Promise<{ checked: number; departed: number; restored: number; unknown: number }> {
    const limit = this.limit(options.limit, 5, 25);
    const users = this.jobs.db
      .prepare(
        "SELECT user_id,MAX(joined_at) expected_joined_at FROM server_rules_memberships WHERE guild_id=? GROUP BY user_id ORDER BY MIN(last_checked_at),user_id LIMIT ?",
      )
      .all(this.guildId, limit);
    const result = { checked: 0, departed: 0, restored: 0, unknown: 0 };
    for (const row of users) {
      const userId = String(row.user_id);
      result.checked++;
      try {
        const expected = Number(row.expected_joined_at),
          proof = await read(userId, expected);
        if (proof.userId !== userId) throw new RulesError("invalid_input");
        if (
          proof.presence === "absent" &&
          proof.expectedJoinedAt !== undefined &&
          proof.expectedJoinedAt !== expected
        )
          throw new RulesError("invalid_input");
        const observed = this.observe(
          proof.presence === "absent" ? { ...proof, expectedJoinedAt: expected } : proof,
        );
        result.departed += observed.departed;
        result.restored += observed.restored;
        if (observed.ignored) result.unknown++;
      } catch {
        result.unknown++;
      } finally {
        // Every cohort advances together; an old joinedAt must not pin this user ahead of others.
        this.jobs.db
          .prepare(
            "UPDATE server_rules_memberships SET last_checked_at=MAX(last_checked_at,?) WHERE guild_id=? AND user_id=?",
          )
          .run(this.now(), this.guildId, userId);
      }
    }
    return result;
  }
  prune(options: { limit?: number } = {}): RulesRetentionResult {
    const limit = this.limit(options.limit, 100, 1000),
      now = this.now(),
      db = this.jobs.db;
    db.exec("PRAGMA secure_delete=ON");
    return this.jobs.transaction(() => {
      const result = {
        acceptancesRemoved: 0,
        membershipsRemoved: 0,
        jobsScrubbed: 0,
        fencesExpired: 0,
      };
      const cutoff = now - serverRulesRetentionPolicy.acceptancesAfterDepartureMs;
      const memberships = db
        .prepare(
          `SELECT user_id,joined_at FROM server_rules_memberships WHERE guild_id=? AND left_at IS NOT NULL AND left_at<=?
        UNION SELECT a.user_id,a.joined_at FROM server_rules_acceptances a JOIN server_rules_retired_acceptances r ON r.guild_id=a.guild_id AND r.id=a.id WHERE a.guild_id=?
        ORDER BY user_id,joined_at LIMIT ?`,
        )
        .all(this.guildId, cutoff, this.guildId, limit);
      for (const membership of memberships) {
        const rows = db
          .prepare(
            `SELECT a.id,a.job_id FROM server_rules_acceptances a WHERE a.guild_id=? AND a.user_id=? AND a.joined_at=? AND
          (EXISTS(SELECT 1 FROM server_rules_memberships m WHERE m.guild_id=a.guild_id AND m.user_id=a.user_id AND m.joined_at=a.joined_at AND m.left_at<=?)
           OR EXISTS(SELECT 1 FROM server_rules_retired_acceptances r WHERE r.guild_id=a.guild_id AND r.id=a.id)) LIMIT ?`,
          )
          .all(
            this.guildId,
            String(membership.user_id),
            Number(membership.joined_at),
            cutoff,
            Math.max(1, limit - result.acceptancesRemoved),
          );
        for (const row of rows) {
          db.prepare("INSERT OR IGNORE INTO server_rules_retired_acceptances VALUES(?,?,?,?)").run(
            this.guildId,
            String(row.id),
            now,
            now + serverRulesRetentionPolicy.retiredAcceptanceFenceMs,
          );
          if (row.job_id) {
            const jobId = String(row.job_id),
              job = this.jobs.get(jobId);
            if (job && (job.guildId !== this.guildId || job.type !== "server-rules.grant-role"))
              throw new RulesError("invalid_input");
            if (job) {
              this.jobs.cancel(jobId);
              db.prepare(
                "UPDATE jobs SET payload='{}',result=NULL,dedupe_key=?,last_error=CASE WHEN state='unknown' THEN 'retention_unresolved' ELSE NULL END WHERE guild_id=? AND id=?",
              ).run(`server-rules:retired:${jobId}`, this.guildId, jobId);
              db.prepare(
                "UPDATE delivery_attempts SET result=NULL,nonce=NULL,error=CASE WHEN state='unknown' THEN 'retention_unresolved' ELSE NULL END WHERE job_id=?",
              ).run(jobId);
              db.prepare(
                "INSERT OR IGNORE INTO job_history_retired(job_id,retired_at) VALUES(?,?)",
              ).run(jobId, now);
              result.jobsScrubbed++;
            }
          }
          db.prepare("DELETE FROM server_rules_acceptances WHERE guild_id=? AND id=?").run(
            this.guildId,
            String(row.id),
          );
          result.acceptancesRemoved++;
        }
        if (
          !db
            .prepare(
              "SELECT 1 FROM server_rules_acceptances WHERE guild_id=? AND user_id=? AND joined_at=? LIMIT 1",
            )
            .get(this.guildId, String(membership.user_id), Number(membership.joined_at))
        ) {
          result.membershipsRemoved += Number(
            db
              .prepare(
                "DELETE FROM server_rules_memberships WHERE guild_id=? AND user_id=? AND joined_at=?",
              )
              .run(this.guildId, String(membership.user_id), Number(membership.joined_at)).changes,
          );
        }
        if (result.acceptancesRemoved >= limit) break;
      }
      const expired = db
        .prepare(
          "SELECT id FROM server_rules_retired_acceptances r WHERE guild_id=? AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM server_rules_acceptances a WHERE a.guild_id=r.guild_id AND a.id=r.id) ORDER BY expires_at,id LIMIT ?",
        )
        .all(this.guildId, now, limit);
      for (const row of expired) {
        db.prepare("DELETE FROM server_rules_retired_acceptances WHERE guild_id=? AND id=?").run(
          this.guildId,
          String(row.id),
        );
        result.fencesExpired++;
      }
      return result;
    });
  }
}
