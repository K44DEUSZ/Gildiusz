import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { canonical, digest } from "../../shared/utils.js";
import { migrate, transaction } from "../../storage/migrations.js";
import {
  JobError,
  type AttemptState,
  type ClaimOptions,
  type DeliveryAttempt,
  type Job,
  type JobFilter,
  type JobInput,
  type JobLease,
  type JobResult,
  type JobState,
  type Reconciliation,
  type ManualDeliveryResolution,
} from "./types.js";
import {
  deliveryAttemptsFingerprint,
  mergeManualDeliveryResult,
  readManualDeliveryResolution,
} from "./manual-delivery.js";

export { JobError } from "./types.js";
export type * from "./types.js";

type Row = Record<string, unknown>;
export interface JobQueueObservation {
  due: number;
  deferredRetries: number;
  running: number;
  unknown: number;
  oldestOverdueMs: number | null;
}
const terminal = new Set<JobState>(["succeeded", "failed", "cancelled", "expired"]);
const states = new Set<JobState>([...terminal, "pending", "running", "retry", "unknown"]);

function text(value: unknown, maximum = 200): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0"))
    throw new JobError("invalid_input");
  return value;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new JobError("invalid_input");
  return value as number;
}

function json(value: unknown): string {
  const seen = new Set<object>();
  const check = (entry: unknown, depth = 0): void => {
    if (depth > 64) throw new JobError("invalid_input");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (!entry || typeof entry !== "object" || seen.has(entry)) throw new JobError("invalid_input");
    if (!Array.isArray(entry) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry)))
      throw new JobError("invalid_input");
    seen.add(entry);
    for (const item of Array.isArray(entry) ? entry : Object.values(entry)) check(item, depth + 1);
    seen.delete(entry);
  };
  check(value);
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, "utf8") > 65536) throw new JobError("invalid_input");
  return encoded;
}

function job(row: Row): Job {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)),
    state: row.state as JobState,
    dueAt: Number(row.due_at),
    nextAttemptAt: Number(row.next_attempt_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    dedupeKey: String(row.dedupe_key),
    objectId: row.object_id === null ? null : String(row.object_id),
    generation: Number(row.generation),
    attempts: Number(row.attempts),
    failures: Number(row.failures),
    maxAttempts: Number(row.max_attempts),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
    revision: Number(row.revision),
    cancelRequested: row.cancel_requested === 1,
    messageId: row.message_id === null ? null : String(row.message_id),
    lastError: row.last_error === null ? null : String(row.last_error),
    result: row.result === null ? null : JSON.parse(String(row.result)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function attempt(row: Row): DeliveryAttempt {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    number: Number(row.number),
    leaseToken: String(row.lease_token),
    state: row.state as AttemptState,
    nonce: row.nonce === null ? null : String(row.nonce),
    channelId: row.channel_id === null ? null : String(row.channel_id),
    messageId: row.message_id === null ? null : String(row.message_id),
    error: row.error === null ? null : String(row.error),
    result: row.result === null ? null : JSON.parse(String(row.result)),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  };
}

export class JobStore {
  constructor(
    readonly db: DatabaseSync,
    private readonly clock: () => number = Date.now,
  ) {
    migrate(db);
  }

  transaction<T>(task: () => T): T {
    return transaction(this.db, task);
  }

  private now(): number {
    return integer(this.clock());
  }

  private require(id: string): Job {
    const found = this.get(id);
    if (!found) throw new JobError("job_not_found");
    return found;
  }

  private lease(id: string, token: string, now = this.now()): JobLease {
    const found = this.require(id);
    if (found.state !== "running" || found.leaseToken !== token || found.leaseUntil! <= now)
      throw new JobError("stale_lease");
    return found as JobLease;
  }

  private assertGuild(guildId: string): void {
    if (
      !this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guild_identity'")
        .get()
    )
      return;
    const identity = this.db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get();
    if (identity && identity.guild !== guildId) throw new JobError("guild_conflict");
  }

  enqueue(input: JobInput): Job {
    const guildId = text(input.guildId),
      type = text(input.type, 80),
      dedupeKey = text(input.dedupeKey, 500),
      payload = json(input.payload),
      dueAt = integer(input.dueAt),
      expiresAt = input.expiresAt === undefined ? null : integer(input.expiresAt, dueAt),
      objectId = input.objectId === undefined ? null : text(input.objectId),
      generation = integer(input.generation ?? 0),
      maxAttempts = integer(input.maxAttempts ?? 5, 1, 20);
    const id = input.id === undefined ? randomUUID() : text(input.id);
    const hash = digest({
      guildId,
      type,
      payload,
      dueAt,
      expiresAt,
      objectId,
      generation,
      maxAttempts,
    });
    return this.transaction(() => {
      this.assertGuild(guildId);
      const existing = this.db.prepare("SELECT * FROM jobs WHERE dedupe_key=?").get(dedupeKey);
      if (existing) {
        if (existing.input_hash !== hash || (input.id !== undefined && existing.id !== id))
          throw new JobError("dedupe_conflict");
        return job(existing);
      }
      if (
        objectId &&
        this.db
          .prepare("SELECT 1 FROM domain_retired WHERE guild_id=? AND object_id=?")
          .get(guildId, objectId)
      )
        throw new JobError("state_conflict");
      if (this.get(id)) throw new JobError("dedupe_conflict");
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO jobs (
        id,guild_id,type,payload,input_hash,state,due_at,next_attempt_at,expires_at,dedupe_key,
        object_id,generation,max_attempts,created_at,updated_at
      ) VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          guildId,
          type,
          payload,
          hash,
          dueAt,
          dueAt,
          expiresAt,
          dedupeKey,
          objectId,
          generation,
          maxAttempts,
          now,
          now,
        );
      return this.require(id);
    });
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(text(id));
    return row ? job(row) : undefined;
  }

  isHistoryRetired(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM job_history_retired WHERE job_id=?").get(text(id));
  }

  private isDomainRetired(id: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM domain_retired d JOIN jobs j ON j.guild_id=d.guild_id AND j.object_id=d.object_id WHERE j.id=?`,
      )
      .get(id);
  }

  list(filter: JobFilter = {}, options: { includeRetired?: boolean } = {}): Job[] {
    const conditions: string[] = options.includeRetired
        ? []
        : ["NOT EXISTS(SELECT 1 FROM job_history_retired h WHERE h.job_id=jobs.id)"],
      values: SQLInputValue[] = [];
    for (const [key, value] of [
      ["guild_id", filter.guildId],
      ["type", filter.type],
      ["object_id", filter.objectId],
    ])
      if (value !== undefined) {
        conditions.push(`${key}=?`);
        values.push(text(value));
      }
    if (filter.states !== undefined) {
      if (!filter.states.length) return [];
      if (filter.states.some((state) => !states.has(state))) throw new JobError("invalid_input");
      conditions.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      values.push(...filter.states);
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    return this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at,id LIMIT ?`)
      .all(...values, integer(filter.limit ?? 100, 1, 500))
      .map(job);
  }

  /** Read-only eligibility counts; intentional retry waits are not overdue worker work. */
  observeQueue(guildId: string, now = this.now()): JobQueueObservation {
    text(guildId);
    integer(now);
    const eligible = `guild_id=? AND state IN ('pending','retry') AND due_at<=?
      AND cancel_requested=0 AND (expires_at IS NULL OR expires_at>?)
      AND NOT EXISTS(SELECT 1 FROM delivery_attempts a
        WHERE a.job_id=jobs.id AND a.state='succeeded' AND a.message_id IS NOT NULL)`,
      due = this.db
        .prepare(
          `SELECT COUNT(*) AS count,MIN(MAX(due_at,next_attempt_at)) AS oldest
          FROM jobs WHERE ${eligible} AND next_attempt_at<=?`,
        )
        .get(guildId, now, now, now)!,
      deferred = this.db
        .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE ${eligible} AND next_attempt_at>?`)
        .get(guildId, now, now, now)!,
      states = this.db
        .prepare(
          `SELECT state,COUNT(*) AS count FROM jobs
          WHERE guild_id=? AND state IN ('running','unknown') GROUP BY state`,
        )
        .all(guildId);
    return {
      due: Number(due.count),
      deferredRetries: Number(deferred.count),
      running: Number(states.find((row) => row.state === "running")?.count ?? 0),
      unknown: Number(states.find((row) => row.state === "unknown")?.count ?? 0),
      oldestOverdueMs: due.oldest === null ? null : Math.max(0, now - Number(due.oldest)),
    };
  }

  claim(options: ClaimOptions = {}): JobLease[] {
    const limit = integer(options.limit ?? 10, 1, 10),
      leaseMs = integer(options.leaseMs ?? 30000, 1, 86400000);
    if (options.types?.length === 0) return [];
    return this.transaction(() => {
      const now = this.now();
      this.recoverInside(now);
      const conditions = ["state IN ('pending','retry')", "due_at<=?", "next_attempt_at<=?"];
      const values: SQLInputValue[] = [now, now];
      if (options.guildId !== undefined) {
        conditions.push("guild_id=?");
        values.push(text(options.guildId));
      }
      if (options.types) {
        conditions.push(`type IN (${options.types.map(() => "?").join(",")})`);
        values.push(...options.types.map((type) => text(type, 80)));
      }
      const ready = this.db
        .prepare(
          `SELECT id FROM jobs WHERE ${conditions.join(" AND ")}
        ORDER BY next_attempt_at,due_at,created_at,id LIMIT ?`,
        )
        .all(...values, limit);
      return ready.map((row) => {
        const token = randomUUID();
        this.db
          .prepare(
            `UPDATE jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,
          revision=revision+1,updated_at=? WHERE id=?`,
          )
          .run(token, integer(now + leaseMs), now, String(row.id));
        return this.require(String(row.id)) as JobLease;
      });
    });
  }

  renew(id: string, token: string, leaseMs = 30000): JobLease {
    integer(leaseMs, 1, 86400000);
    return this.transaction(() => {
      const current = this.lease(id, token);
      this.db
        .prepare("UPDATE jobs SET lease_until=?,updated_at=?,revision=revision+1 WHERE id=?")
        .run(Math.max(current.leaseUntil, integer(this.now() + leaseMs)), this.now(), id);
      return this.require(id) as JobLease;
    });
  }

  beginAttempt(
    id: string,
    token: string,
    metadata: { nonce?: string; channelId?: string } = {},
  ): DeliveryAttempt {
    const nonce = metadata.nonce === undefined ? null : text(metadata.nonce),
      channelId = metadata.channelId === undefined ? null : text(metadata.channelId);
    return this.transaction(() => {
      const current = this.lease(id, token);
      if (this.isDomainRetired(id)) throw new JobError("state_conflict");
      if (current.cancelRequested) throw new JobError("state_conflict");
      if (this.confirmedReceipt(id)) throw new JobError("state_conflict");
      const existing = this.db
        .prepare("SELECT * FROM delivery_attempts WHERE job_id=? AND lease_token=?")
        .get(id, token);
      if (existing) {
        if (
          existing.nonce !== nonce ||
          existing.channel_id !== channelId ||
          existing.state !== "sending"
        )
          throw new JobError("state_conflict");
        return attempt(existing);
      }
      const attemptId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO delivery_attempts
        (id,job_id,number,lease_token,state,nonce,channel_id,started_at)
        VALUES (?,?,?,?,'sending',?,?,?)`,
        )
        .run(attemptId, id, current.attempts, token, nonce, channelId, this.now());
      this.db
        .prepare("UPDATE jobs SET revision=revision+1,updated_at=? WHERE id=?")
        .run(this.now(), id);
      return attempt(this.db.prepare("SELECT * FROM delivery_attempts WHERE id=?").get(attemptId)!);
    });
  }

  private confirmedReceipt(id: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT id FROM delivery_attempts WHERE job_id=? AND state='succeeded' AND message_id IS NOT NULL ORDER BY number LIMIT 1",
      )
      .get(id);
  }

  recordReceipt(id: string, token: string, output: JobResult): DeliveryAttempt {
    const messageId = text(output.messageId),
      result = output.result === undefined ? null : json(output.result);
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT * FROM delivery_attempts WHERE job_id=? AND lease_token=?")
        .get(text(id), text(token));
      if (!previous) throw new JobError("state_conflict");
      if (previous.message_id !== null) {
        if (previous.message_id !== messageId) throw new JobError("state_conflict");
        return attempt(previous);
      }
      const previousResult = previous.result === null ? null : JSON.parse(String(previous.result));
      // A receipt records a fact about the old send; it never takes over a newer job lease.
      this.db
        .prepare(
          "UPDATE delivery_attempts SET state='succeeded',message_id=?,result=?,error='late_confirmation',finished_at=? WHERE id=?",
        )
        .run(
          messageId,
          this.isHistoryRetired(id) || this.isDomainRetired(id)
            ? null
            : readManualDeliveryResolution(previousResult)
              ? json(mergeManualDeliveryResult(previousResult, output.result ?? null))
              : result,
          this.now(),
          String(previous.id),
        );
      return attempt(
        this.db.prepare("SELECT * FROM delivery_attempts WHERE id=?").get(String(previous.id))!,
      );
    });
  }

  private finishAttempt(
    id: string,
    token: string,
    state: AttemptState,
    now: number,
    error: string | null,
    messageId: string | null = null,
    result: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE delivery_attempts SET state=?,finished_at=?,error=?,message_id=?,result=?
      WHERE job_id=? AND lease_token=? AND state='sending'`,
      )
      .run(state, now, error, messageId, result, id, token);
  }

  complete(id: string, token: string, output: JobResult = {}): Job {
    const messageId = output.messageId === undefined ? null : text(output.messageId),
      result = output.result === undefined ? null : json(output.result);
    return this.transaction(() => {
      this.lease(id, token);
      const now = this.now();
      this.finishAttempt(id, token, "succeeded", now, null, messageId, result);
      this.db
        .prepare(
          `UPDATE jobs SET state='succeeded',lease_token=NULL,lease_until=NULL,
        message_id=?,result=?,last_error=NULL,revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(messageId, result, now, id);
      return this.require(id);
    });
  }

  retry(
    id: string,
    token: string,
    options: { at: number; error: string; rateLimited?: boolean },
  ): Job {
    const at = integer(options.at),
      error = text(options.error, 1000);
    if (options.rateLimited !== undefined && typeof options.rateLimited !== "boolean")
      throw new JobError("invalid_input");
    return this.transaction(() => {
      const current = this.lease(id, token),
        now = this.now();
      const failures = current.failures + (options.rateLimited ? 0 : 1);
      const state: JobState = this.confirmedReceipt(id)
        ? "unknown"
        : current.cancelRequested
          ? "cancelled"
          : current.expiresAt !== null && current.expiresAt <= now
            ? "expired"
            : failures >= current.maxAttempts
              ? "failed"
              : "retry";
      this.finishAttempt(
        id,
        token,
        state === "retry" && options.rateLimited ? "rate_limited" : (state as AttemptState),
        now,
        error,
      );
      this.db
        .prepare(
          `UPDATE jobs SET state=?,next_attempt_at=?,failures=?,last_error=?,
        lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(state, Math.max(at, now), failures, error, now, id);
      return this.require(id);
    });
  }

  fail(id: string, token: string, error: string): Job {
    return this.finish(id, token, "failed", text(error, 1000));
  }

  unknown(id: string, token: string, error: string): Job {
    return this.finish(id, token, "unknown", text(error, 1000));
  }

  private finish(id: string, token: string, state: "failed" | "unknown", error: string): Job {
    return this.transaction(() => {
      this.lease(id, token);
      const now = this.now();
      this.finishAttempt(id, token, state, now, error);
      this.db
        .prepare(
          `UPDATE jobs SET state=?,last_error=?,lease_token=NULL,lease_until=NULL,
        revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(state, error, now, id);
      return this.require(id);
    });
  }

  cancel(id: string): Job | undefined {
    return this.transaction(() => {
      const current = this.get(id);
      if (!current || terminal.has(current.state) || current.cancelRequested) return current;
      const sending = this.db
        .prepare("SELECT 1 FROM delivery_attempts WHERE job_id=? AND state='sending'")
        .get(id);
      if (current.state === "unknown" || sending) {
        this.db
          .prepare("UPDATE jobs SET cancel_requested=1,revision=revision+1,updated_at=? WHERE id=?")
          .run(this.now(), id);
      } else
        this.db
          .prepare(
            `UPDATE jobs SET state='cancelled',cancel_requested=1,lease_token=NULL,
        lease_until=NULL,revision=revision+1,updated_at=? WHERE id=?`,
          )
          .run(this.now(), id);
      return this.require(id);
    });
  }

  expire(id: string, token?: string, reason = "deadline_exceeded"): Job {
    text(reason, 1000);
    return this.transaction(() => {
      const current = this.require(id),
        now = this.now();
      if (terminal.has(current.state) || current.state === "unknown")
        throw new JobError("state_conflict");
      if (current.state === "running") {
        this.lease(id, token ?? "", now);
        const sending = this.db
          .prepare("SELECT 1 FROM delivery_attempts WHERE job_id=? AND state='sending'")
          .get(id);
        if (sending) return this.unknown(id, token!, reason);
      } else if (token !== undefined) throw new JobError("stale_lease");
      this.db
        .prepare(
          `UPDATE jobs SET state='expired',last_error=?,lease_token=NULL,lease_until=NULL,
        revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(reason, now, id);
      return this.require(id);
    });
  }

  recover(): { requeued: number; unknown: number; expired: number } {
    return this.transaction(() => this.recoverInside(this.now()));
  }

  private recoverInside(now: number): { requeued: number; unknown: number; expired: number } {
    const result = { requeued: 0, unknown: 0, expired: 0 };
    const confirmed = this.db
      .prepare(
        `UPDATE jobs SET state='unknown',last_error='late_confirmation',revision=revision+1,updated_at=?
       WHERE state IN ('pending','retry') AND EXISTS (
         SELECT 1 FROM delivery_attempts WHERE job_id=jobs.id AND state='succeeded' AND message_id IS NOT NULL
       )`,
      )
      .run(now);
    result.unknown += Number(confirmed.changes);
    const expired = this.db
      .prepare(
        `UPDATE jobs SET state='expired',last_error='deadline_exceeded',
      revision=revision+1,updated_at=? WHERE state IN ('pending','retry') AND expires_at<=?`,
      )
      .run(now, now);
    result.expired += Number(expired.changes);
    const abandoned = this.db
      .prepare("SELECT * FROM jobs WHERE state='running' AND lease_until<=?")
      .all(now);
    for (const row of abandoned) {
      const current = job(row);
      const sending = this.db
        .prepare(
          "SELECT 1 FROM delivery_attempts WHERE job_id=? AND lease_token=? AND state='sending'",
        )
        .get(current.id, current.leaseToken!);
      const state: JobState =
        sending || this.confirmedReceipt(current.id)
          ? "unknown"
          : current.cancelRequested
            ? "cancelled"
            : current.expiresAt !== null && current.expiresAt <= now
              ? "expired"
              : "retry";
      this.finishAttempt(
        current.id,
        current.leaseToken!,
        state as AttemptState,
        now,
        "lease_expired",
      );
      this.db
        .prepare(
          `UPDATE jobs SET state=?,next_attempt_at=?,last_error='lease_expired',lease_token=NULL,
        lease_until=NULL,revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(state, now, now, current.id);
      if (state === "unknown") result.unknown++;
      else if (state === "expired") result.expired++;
      else if (state === "retry") result.requeued++;
    }
    return result;
  }

  attempts(id: string): DeliveryAttempt[] {
    return this.db
      .prepare("SELECT * FROM delivery_attempts WHERE job_id=? ORDER BY number")
      .all(text(id))
      .map(attempt);
  }

  /** Records a human decision without asserting an ACK or authorizing another send. */
  recordManualDeliveryResolution(
    id: string,
    expectedRevision: number,
    expectedAttemptsFingerprint: string,
    resolution: ManualDeliveryResolution,
  ): Job {
    if (!readManualDeliveryResolution({ manualDeliveryResolution: resolution }))
      throw new JobError("invalid_input");
    return this.transaction(() => {
      const current = this.require(id),
        attempts = this.attempts(id);
      if (
        current.revision !== integer(expectedRevision, 1) ||
        deliveryAttemptsFingerprint(attempts) !== expectedAttemptsFingerprint
      )
        throw new JobError("revision_conflict");
      if (
        current.state !== "unknown" ||
        current.type !== "announcement.send" ||
        this.isHistoryRetired(id) ||
        this.isDomainRetired(id) ||
        readManualDeliveryResolution(current.result) ||
        attempts.map((entry) => entry.id).join(",") !== resolution.attemptIds.join(",")
      )
        throw new JobError("state_conflict");
      const ambiguous = attempts.filter((entry) => ["sending", "unknown"].includes(entry.state));
      if (
        resolution.decisions.length !== ambiguous.length ||
        ambiguous.some((entry) => !resolution.decisions.some((item) => item.attemptId === entry.id))
      )
        throw new JobError("state_conflict");
      for (const item of resolution.decisions) {
        const entry = attempts.find((attempt) => attempt.id === item.attemptId)!;
        if (
          item.linkedMessage &&
          (entry.channelId !== item.linkedMessage.channelId ||
            (entry.messageId && entry.messageId !== item.linkedMessage.messageId))
        )
          throw new JobError("state_conflict");
      }
      for (const entry of attempts.filter((entry) => ["sending", "unknown"].includes(entry.state)))
        this.db
          .prepare("UPDATE delivery_attempts SET result=? WHERE id=?")
          .run(json({ manualDeliveryResolution: resolution, priorResult: entry.result }), entry.id);
      this.db
        .prepare(
          "UPDATE jobs SET cancel_requested=1,result=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          json({ manualDeliveryResolution: resolution, priorResult: current.result }),
          this.now(),
          id,
        );
      return this.require(id);
    });
  }

  reconcile(id: string, expectedRevision: number, resolution: Reconciliation): Job {
    integer(expectedRevision, 1);
    return this.transaction(() => {
      const current = this.require(id),
        now = this.now();
      if (current.revision !== expectedRevision) throw new JobError("revision_conflict");
      if (current.state !== "unknown" || this.isHistoryRetired(id))
        throw new JobError("state_conflict");
      const retired = this.isDomainRetired(id);
      if (retired && resolution.outcome === "retry") throw new JobError("state_conflict");
      let state: JobState,
        messageId: string | null = null,
        output: string | null = null,
        error: string | null = null,
        at = current.nextAttemptAt;
      if (resolution.outcome === "succeeded") {
        state = "succeeded";
        messageId = resolution.messageId === undefined ? null : text(resolution.messageId);
        output = retired || resolution.result === undefined ? null : json(resolution.result);
      } else if (resolution.outcome === "retry") {
        if (resolution.notDelivered !== true) throw new JobError("invalid_input");
        if (this.confirmedReceipt(id)) throw new JobError("state_conflict");
        at = Math.max(integer(resolution.at), now);
        state = current.cancelRequested
          ? "cancelled"
          : current.expiresAt !== null && current.expiresAt <= now
            ? "expired"
            : "retry";
        error = "confirmed_not_delivered";
      } else if (resolution.outcome === "failed") {
        state = "failed";
        const reason = text(resolution.error, 1000);
        error = retired ? "retention_resolved" : reason;
      } else throw new JobError("invalid_input");
      this.db
        .prepare(
          `UPDATE delivery_attempts SET state=?,finished_at=?,message_id=?,result=?,error=?
        WHERE job_id=? AND state='unknown'`,
        )
        .run(state, now, messageId, output, error, id);
      this.db
        .prepare(
          `UPDATE jobs SET state=?,message_id=?,result=?,last_error=?,next_attempt_at=?,
        revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(state, messageId, output, error, at, now, id);
      return this.require(id);
    });
  }

  idempotent<T>(scope: string, requestId: string, input: unknown, work: () => T): T {
    text(scope);
    text(requestId);
    const hash = digest(json(input));
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT * FROM idempotency_keys WHERE scope=? AND request_id=?")
        .get(scope, requestId);
      if (previous) {
        if (previous.input_hash !== hash) throw new JobError("idempotency_conflict");
        return JSON.parse(String(previous.result)) as T;
      }
      const result = work(),
        encoded = json(result);
      this.db
        .prepare("INSERT INTO idempotency_keys VALUES (?,?,?,?,?)")
        .run(scope, requestId, hash, encoded, this.now());
      return JSON.parse(encoded) as T;
    });
  }

  readIdempotent<T>(scope: string, requestId: string, input: unknown): T | undefined {
    const previous = this.db
      .prepare("SELECT input_hash,result FROM idempotency_keys WHERE scope=? AND request_id=?")
      .get(text(scope), text(requestId));
    if (!previous) return;
    if (previous.input_hash !== digest(json(input))) throw new JobError("idempotency_conflict");
    return JSON.parse(String(previous.result)) as T;
  }
}
