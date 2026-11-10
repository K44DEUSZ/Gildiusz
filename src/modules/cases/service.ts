import { randomUUID } from "node:crypto";
import type { JobStore } from "../../core/jobs/store.js";
import type { Job } from "../../core/jobs/types.js";
import {
  canPerform,
  requirePermission,
  ModulePermissionError,
  type BoundObject,
  type ModuleAction,
} from "../../core/permissions.js";
import {
  CaseError,
  type CaseAuthority,
  type CaseDraft,
  type CaseKind,
  type CaseListFilter,
  type CaseMessage,
  type CaseMutation,
  type CaseOptions,
  type CaseRecord,
  type CaseStatus,
  type CaseSummary,
  type CaseTransition,
  type CaseView,
  type CaseVotes,
  type CaseAudience,
  type CaseAudienceScope,
  type ConfirmedCaseTarget,
  type PreparedCaseNotification,
} from "./types.js";
export { CaseError } from "./types.js";
export type * from "./types.js";

type Row = Record<string, unknown>;
const kinds = ["report", "question", "suggestion"];
const supportStates = ["new", "in_progress", "waiting_author", "resolved", "closed"];
const suggestionStates = ["new", "in_review", "accepted", "rejected", "implemented"];
const statusLabels: Record<string, string> = {
  new: "Nowe",
  in_progress: "W trakcie",
  waiting_author: "Oczekuje na autora",
  resolved: "Rozwiązane",
  closed: "Zamknięte",
  in_review: "W ocenie",
  accepted: "Przyjęte",
  rejected: "Odrzucone",
  implemented: "Zrealizowane",
};
const transitions: Record<string, string[]> = {
  new: ["in_progress", "waiting_author", "resolved", "closed"],
  in_progress: ["waiting_author", "resolved", "closed"],
  waiting_author: ["in_progress", "resolved", "closed"],
  resolved: ["in_progress", "closed"],
  closed: [],
};
const suggestionTransitions: Record<string, string[]> = {
  new: ["in_review", "accepted", "rejected"],
  in_review: ["accepted", "rejected"],
  accepted: ["implemented", "rejected"],
  rejected: [],
  implemented: [],
};
export function allowedCaseStatuses(kind: CaseKind, state: CaseStatus): CaseStatus[] {
  return [
    ...((kind === "suggestion" ? suggestionTransitions : transitions)[state] ?? []),
  ] as CaseStatus[];
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value)) throw new CaseError("invalid_input");
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 200 || value.includes("\0"))
    throw new CaseError("invalid_input");
  return value;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim().length ||
    value.length > max ||
    value.includes("\0")
  )
    throw new CaseError("invalid_input");
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new CaseError("invalid_input");
  return value as number;
}
function fields(value: unknown, allowed: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((field) => !allowed.includes(field))
  )
    throw new CaseError("invalid_input");
}
function record(row: Row): CaseRecord {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    ownerId: String(row.owner_id),
    kind: row.kind as CaseKind,
    visibility: row.visibility as "private" | "public",
    title: String(row.title),
    content: String(row.content),
    status: row.status as CaseStatus,
    assigneeId: row.assignee_id === null ? null : String(row.assignee_id),
    revision: Number(row.revision),
    generation: Number(row.generation),
    votesRevision: Number(row.votes_revision),
    approvedBy: row.approved_by === null ? null : String(row.approved_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
    retentionAt: row.retention_at === null ? null : Number(row.retention_at),
  };
}
function message(row: Row): CaseMessage {
  return {
    id: String(row.id),
    authorId: String(row.author_id),
    content: String(row.content),
    visibility: row.visibility as "private" | "public",
    createdAt: Number(row.created_at),
  };
}
function summary(value: CaseRecord): CaseSummary {
  const result = { ...value } as Partial<CaseRecord>;
  delete result.content;
  return result as CaseSummary;
}
function clip(value: string): string {
  return value.length <= 2000 ? value : value.slice(0, 1999).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

export class CaseService {
  readonly guildId: string;
  private readonly clock: () => number;
  private readonly limit: number;
  private readonly authorLimit: number;
  private readonly messageLimit: number;
  private readonly actionLimit: number;
  private readonly voteLimit: number;
  private readonly retention: number | null;
  private readonly votingStatuses: Set<string>;
  constructor(
    readonly jobs: JobStore,
    private readonly options: CaseOptions,
  ) {
    this.guildId = id(options.guildId);
    this.clock = options.clock ?? Date.now;
    this.limit = integer(options.maxActiveCases ?? 1000, 1, 10000);
    this.authorLimit = integer(options.maxActiveCasesPerAuthor ?? 20, 1, 1000);
    this.messageLimit = integer(options.maxMessagesPerCase ?? 1000, 1, 10000);
    this.actionLimit = integer(options.maxActionsPerMinute ?? 20, 1, 100);
    this.voteLimit = integer(options.maxVotesPerMinute ?? 60, 1, 120);
    this.retention =
      options.retentionMs == null ? null : integer(options.retentionMs, 60000, 31536000000);
    if (
      options.suggestionVisibility !== undefined &&
      !["approval", "immediate"].includes(options.suggestionVisibility)
    )
      throw new CaseError("invalid_input");
    const voting = options.voting;
    if (
      voting &&
      (typeof voting.enabled !== "boolean" ||
        !Array.isArray(voting.statuses) ||
        voting.statuses.some((state) => !["new", "in_review"].includes(state)) ||
        new Set(voting.statuses).size !== voting.statuses.length)
    )
      throw new CaseError("invalid_input");
    this.votingStatuses = new Set(voting?.statuses ?? []);
    if (
      options.reasonRequiredStatuses &&
      (!Array.isArray(options.reasonRequiredStatuses) ||
        options.reasonRequiredStatuses.some((state) => !["accepted", "rejected"].includes(state)))
    )
      throw new CaseError("invalid_input");
  }
  private now(): number {
    return integer(this.clock());
  }
  private read(caseId: string): CaseRecord {
    const row = this.jobs.db
      .prepare("SELECT * FROM cases WHERE guild_id=? AND id=?")
      .get(this.guildId, key(caseId));
    if (!row) throw new CaseError("not_found");
    return record(row);
  }
  private bound(value: CaseRecord): BoundObject {
    return {
      guildId: this.guildId,
      ownerId: value.ownerId,
      kind: value.kind,
      visibility: value.visibility,
      state: value.status,
      votingEnabled: this.options.voting?.enabled === true && this.votingStatuses.has(value.status),
    };
  }
  private async authority(
    actor: string,
    operation: ModuleAction,
    value?: CaseRecord,
  ): Promise<CaseAuthority> {
    id(actor);
    const object = value ? this.bound(value) : undefined;
    const result = await this.options.authorize({
      guildId: this.guildId,
      actorId: actor,
      operation,
      ...(object ? { object } : {}),
    });
    if (
      !result ||
      result.member?.userId !== actor ||
      result.member?.guildId !== this.guildId ||
      result.policy?.guildId !== this.guildId
    )
      throw new CaseError("permission_revoked");
    try {
      requirePermission(operation, result.member, result.policy, object);
    } catch (error) {
      if (error instanceof ModulePermissionError) throw new CaseError("permission_revoked");
      throw error;
    }
    this.assertAuthority(result);
    return result;
  }
  private assertAuthority(authority: CaseAuthority): void {
    const result: unknown = authority.assertCurrent?.();
    if (result && typeof result === "object" && "then" in result)
      throw new TypeError("Case authority guards must be synchronous.");
  }
  private changed(caseId: string, revision: number, generation?: number): CaseRecord {
    const value = this.read(caseId);
    if (value.revision !== integer(revision, 1)) throw new CaseError("revision_conflict");
    if (generation !== undefined && value.generation !== generation)
      throw new CaseError("stale_generation");
    return value;
  }
  private action(actor: string, kind: "write" | "vote"): void {
    const now = this.now();
    this.jobs.db
      .prepare("DELETE FROM case_actions WHERE guild_id=? AND created_at<=?")
      .run(this.guildId, now - 60000);
    const count = Number(
      this.jobs.db
        .prepare(
          "SELECT COUNT(*) AS count FROM case_actions WHERE guild_id=? AND actor_id=? AND kind=?",
        )
        .get(this.guildId, actor, kind)!.count,
    );
    if (count >= (kind === "vote" ? this.voteLimit : this.actionLimit))
      throw new CaseError("limit_exceeded");
    this.jobs.db
      .prepare("INSERT INTO case_actions VALUES (?,?,?,?,?)")
      .run(randomUUID(), this.guildId, actor, kind, now);
  }
  private command<T>(
    actor: string,
    operation: string,
    requestId: string,
    input: unknown,
    apply: () => T,
    authorities: readonly CaseAuthority[],
  ): T {
    const result = this.jobs.transaction(() => {
      for (const authority of authorities) this.assertAuthority(authority);
      const value = this.jobs.idempotent<T | { retiredCaseId: string }>(
        `case:${this.guildId}:${actor}:${operation}`,
        key(requestId),
        input,
        apply,
      );
      // Also fences synchronous enqueue hooks and replays; failures roll back the entire command.
      for (const authority of authorities) this.assertAuthority(authority);
      return value;
    });
    if (result && typeof result === "object" && "retiredCaseId" in result)
      throw new CaseError("not_found");
    return result as T;
  }
  private event(
    value: CaseRecord,
    actor: string,
    kind: string,
    audience: CaseAudience | null,
    content: string | null = null,
    messageId: string | null = null,
  ): Job | null {
    const eventId = randomUUID();
    this.jobs.db
      .prepare("INSERT INTO case_events VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(
        eventId,
        this.guildId,
        value.id,
        actor,
        kind,
        content,
        messageId,
        audience,
        value.generation,
        this.now(),
      );
    if (!audience) return null;
    return this.jobs.enqueue({
      guildId: this.guildId,
      type: "case.notify",
      objectId: value.id,
      generation: value.generation,
      dueAt: this.now(),
      dedupeKey: `case:${value.id}:${eventId}`,
      payload: { caseId: value.id, eventId, recipient: audience, generation: value.generation },
    });
  }
  private result(caseId: string, job: Job | null): CaseMutation {
    return { case: this.read(caseId), job };
  }
  private open(value: CaseRecord): void {
    if (["closed", "rejected", "implemented"].includes(value.status))
      throw new CaseError("state_conflict");
  }
  private votes(value: CaseRecord): CaseVotes {
    const row = this.jobs.db
      .prepare(
        "SELECT COALESCE(SUM(value=1),0) AS positive,COALESCE(SUM(value=-1),0) AS negative,COALESCE(SUM(value),0) AS score,COUNT(*) AS total FROM case_votes WHERE guild_id=? AND case_id=?",
      )
      .get(this.guildId, value.id)!;
    return {
      positive: Number(row.positive),
      negative: Number(row.negative),
      score: Number(row.score),
      total: Number(row.total),
      revision: value.votesRevision,
    };
  }

  async create(actor: string, requestId: string, input: CaseDraft): Promise<CaseMutation> {
    fields(input, ["kind", "title", "content"]);
    if (!kinds.includes(input.kind)) throw new CaseError("invalid_input");
    const title = text(input.title, 140),
      content = text(input.content, 4000);
    input = { kind: input.kind, title, content };
    const authority = await this.authority(actor, "cases.create");
    return this.command(
      actor,
      "create",
      requestId,
      input,
      () => {
        this.action(actor, "write");
        const counts = this.jobs.db
          .prepare(
            "SELECT COUNT(*) AS count,COALESCE(SUM(owner_id=?),0) AS own FROM cases WHERE guild_id=? AND status NOT IN ('closed','rejected','implemented')",
          )
          .get(actor, this.guildId)!;
        if (Number(counts.count) >= this.limit || Number(counts.own) >= this.authorLimit)
          throw new CaseError("limit_exceeded");
        const caseId = randomUUID(),
          now = this.now(),
          visibility =
            input.kind === "suggestion" && this.options.suggestionVisibility === "immediate"
              ? "public"
              : "private";
        this.jobs.db
          .prepare(
            "INSERT INTO cases (id,guild_id,owner_id,kind,visibility,title,content,status,revision,generation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'new',1,1,?,?)",
          )
          .run(caseId, this.guildId, actor, input.kind, visibility, title, content, now, now);
        const value = this.read(caseId);
        const created: unknown = this.options.onCreated?.(value);
        if (created && typeof created === "object" && "then" in created)
          throw new TypeError("Case creation hooks must be synchronous.");
        const job = this.event(
          value,
          actor,
          "created",
          visibility === "public" ? "public" : "staff",
        );
        return this.result(caseId, job);
      },
      [authority],
    );
  }
  async get(actor: string, caseId: string): Promise<CaseView> {
    const value = this.read(caseId);
    const authority = await this.authority(actor, "cases.read", value);
    const fresh = this.read(caseId);
    if (fresh.generation !== value.generation) throw new CaseError("stale_generation");
    const privateConversation =
      actor === fresh.ownerId ||
      canPerform("cases.note", authority.member, authority.policy, this.bound(fresh));
    const messages = this.jobs.db
      .prepare(
        "SELECT id,author_id,content,visibility,created_at FROM case_messages WHERE guild_id=? AND case_id=? AND kind='reply' AND (?=1 OR visibility='public') ORDER BY created_at,id LIMIT 10000",
      )
      .all(this.guildId, caseId, Number(privateConversation))
      .map(message);
    const own = this.jobs.db
      .prepare("SELECT value FROM case_votes WHERE guild_id=? AND case_id=? AND user_id=?")
      .get(this.guildId, caseId, actor);
    return {
      case: fresh,
      messages,
      votes: this.votes(fresh),
      ownVote: own ? (Number(own.value) as 1 | -1) : null,
    };
  }
  async list(actor: string, filter: CaseListFilter = {}): Promise<CaseSummary[]> {
    fields(filter, ["kind", "status", "mine"]);
    if (
      (filter.kind !== undefined && !kinds.includes(filter.kind)) ||
      (filter.status !== undefined &&
        ![...supportStates, ...suggestionStates].includes(filter.status)) ||
      (filter.mine !== undefined && typeof filter.mine !== "boolean")
    )
      throw new CaseError("invalid_input");
    await this.authority(actor, "cases.list");
    filter = { ...filter };
    const clauses = ["guild_id=?"],
      parameters: (string | number)[] = [this.guildId];
    if (filter.kind) {
      clauses.push("kind=?");
      parameters.push(filter.kind);
    }
    if (filter.status) {
      clauses.push("status=?");
      parameters.push(filter.status);
    }
    if (filter.mine) {
      clauses.push("owner_id=?");
      parameters.push(actor);
    }
    const rows = this.jobs.db
      .prepare(
        `SELECT * FROM cases WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC,id LIMIT 1000`,
      )
      .all(...parameters);
    const result: CaseSummary[] = [];
    for (const row of rows) {
      const value = record(row);
      if (
        (filter.kind && filter.kind !== value.kind) ||
        (filter.status && filter.status !== value.status) ||
        (filter.mine && value.ownerId !== actor)
      )
        continue;
      try {
        await this.authority(actor, "cases.read", value);
      } catch (error) {
        if (error instanceof CaseError && error.code === "permission_revoked") continue;
        throw error;
      }
      const fresh = this.read(value.id);
      if (fresh.generation !== value.generation) continue;
      result.push(summary(fresh));
    }
    return result;
  }
  async notes(actor: string, caseId: string): Promise<CaseMessage[]> {
    const before = this.read(caseId);
    await this.authority(actor, "cases.note", before);
    const fresh = this.read(caseId);
    if (fresh.generation !== before.generation) throw new CaseError("stale_generation");
    return this.jobs.db
      .prepare(
        "SELECT id,author_id,content,visibility,created_at FROM case_messages WHERE guild_id=? AND case_id=? AND kind='note' ORDER BY created_at,id LIMIT 10000",
      )
      .all(this.guildId, caseId)
      .map(message);
  }
  async reply(
    actor: string,
    requestId: string,
    caseId: string,
    revision: number,
    content: string,
  ): Promise<CaseMutation> {
    return this.addMessage(actor, requestId, caseId, revision, content, false);
  }
  async note(
    actor: string,
    requestId: string,
    caseId: string,
    revision: number,
    content: string,
  ): Promise<CaseMutation> {
    return this.addMessage(actor, requestId, caseId, revision, content, true);
  }
  private async addMessage(
    actor: string,
    requestId: string,
    caseId: string,
    revision: number,
    content: string,
    internal: boolean,
  ): Promise<CaseMutation> {
    text(content, 4000);
    const before = this.read(caseId);
    const authority = await this.authority(actor, internal ? "cases.note" : "cases.reply", before);
    return this.command(
      actor,
      internal ? "note" : "reply",
      requestId,
      { caseId, revision, content },
      () => {
        const value = this.changed(caseId, revision, before.generation);
        if (!internal) this.open(value);
        this.action(actor, "write");
        const count = Number(
          this.jobs.db
            .prepare("SELECT COUNT(*) AS count FROM case_messages WHERE guild_id=? AND case_id=?")
            .get(this.guildId, caseId)!.count,
        );
        if (count >= this.messageLimit) throw new CaseError("limit_exceeded");
        const messageId = randomUUID();
        this.jobs.db
          .prepare("INSERT INTO case_messages VALUES (?,?,?,?,?,?,?,?)")
          .run(
            messageId,
            this.guildId,
            caseId,
            actor,
            internal ? "note" : "reply",
            internal ? "private" : value.visibility,
            content,
            this.now(),
          );
        this.jobs.db
          .prepare("UPDATE cases SET revision=revision+1,updated_at=? WHERE guild_id=? AND id=?")
          .run(this.now(), this.guildId, caseId);
        const job = this.event(
          this.read(caseId),
          actor,
          internal ? "internal_note" : "replied",
          internal ? null : actor === value.ownerId ? "staff" : "author",
          null,
          messageId,
        );
        return this.result(caseId, job);
      },
      [authority],
    );
  }
  async assign(
    actor: string,
    requestId: string,
    caseId: string,
    revision: number,
    assigneeId: string | null,
  ): Promise<CaseMutation> {
    if (assigneeId !== null) id(assigneeId);
    const before = this.read(caseId);
    const authorities = [await this.authority(actor, "cases.assign", before)];
    if (assigneeId) authorities.push(await this.authority(assigneeId, "cases.assign", before));
    return this.command(
      actor,
      "assign",
      requestId,
      { caseId, revision, assigneeId },
      () => {
        const value = this.changed(caseId, revision, before.generation);
        this.open(value);
        this.action(actor, "write");
        this.jobs.db
          .prepare(
            "UPDATE cases SET assignee_id=?,revision=revision+1,updated_at=? WHERE guild_id=? AND id=?",
          )
          .run(assigneeId, this.now(), this.guildId, caseId);
        const job = this.event(this.read(caseId), actor, "assigned", "staff");
        return this.result(caseId, job);
      },
      authorities,
    );
  }
  async transition(
    actor: string,
    requestId: string,
    caseId: string,
    revision: number,
    input: CaseTransition,
  ): Promise<CaseMutation> {
    fields(input, ["status", "reason"]);
    if (![...supportStates, ...suggestionStates].includes(input.status))
      throw new CaseError("invalid_input");
    if (input.reason !== undefined) text(input.reason, 1000);
    input = {
      status: input.status,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    const before = this.read(caseId);
    const authority = await this.authority(actor, "cases.transition", before);
    return this.command(
      actor,
      "transition",
      requestId,
      { caseId, revision, input },
      () => {
        const value = this.changed(caseId, revision, before.generation);
        if (!allowedCaseStatuses(value.kind, value.status).includes(input.status))
          throw new CaseError("state_conflict");
        if (
          this.options.reasonRequiredStatuses?.includes(input.status as "accepted" | "rejected") &&
          !input.reason?.trim()
        )
          throw new CaseError("invalid_input");
        this.action(actor, "write");
        const closed = ["closed", "rejected", "implemented"].includes(input.status),
          now = this.now();
        this.jobs.db
          .prepare(
            "UPDATE cases SET status=?,revision=revision+1,updated_at=?,closed_at=?,retention_at=? WHERE guild_id=? AND id=?",
          )
          .run(
            input.status,
            now,
            closed ? now : null,
            closed && value.visibility === "private" && this.retention !== null
              ? now + this.retention
              : null,
            this.guildId,
            caseId,
          );
        const description = input.reason
          ? `${statusLabels[input.status]}\n${input.reason}`
          : statusLabels[input.status];
        const job = this.event(this.read(caseId), actor, "status_changed", "author", description);
        return this.result(caseId, job);
      },
      [authority],
    );
  }
  async approve(
    actor: string,
    requestId: string,
    caseId: string,
    revision: number,
  ): Promise<CaseMutation> {
    const before = this.read(caseId);
    const authority = await this.authority(actor, "cases.transition", before);
    return this.command(
      actor,
      "approve",
      requestId,
      { caseId, revision },
      () => {
        const value = this.changed(caseId, revision, before.generation);
        if (value.kind !== "suggestion" || value.visibility !== "private")
          throw new CaseError("state_conflict");
        this.open(value);
        this.action(actor, "write");
        for (const pending of this.jobs.list({
          guildId: this.guildId,
          type: "case.notify",
          objectId: caseId,
          states: ["pending", "retry", "running", "unknown"],
          limit: 500,
        }))
          this.jobs.cancel(pending.id);
        this.jobs.db
          .prepare(
            "UPDATE cases SET visibility='public',approved_by=?,generation=generation+1,revision=revision+1,updated_at=? WHERE guild_id=? AND id=?",
          )
          .run(actor, this.now(), this.guildId, caseId);
        const job = this.event(this.read(caseId), actor, "approved", "public");
        return this.result(caseId, job);
      },
      [authority],
    );
  }
  async vote(
    actor: string,
    requestId: string,
    caseId: string,
    value: 1 | -1 | null,
  ): Promise<{ votes: CaseVotes; ownVote: 1 | -1 | null }> {
    if (value !== null && value !== 1 && value !== -1) throw new CaseError("invalid_input");
    const before = this.read(caseId);
    const authority = await this.authority(actor, "cases.read", before);
    if (before.kind !== "suggestion" || before.visibility !== "public")
      throw new CaseError("approval_required");
    if (!this.options.voting?.enabled || !this.votingStatuses.has(before.status))
      throw new CaseError("voting_closed");
    const votingAuthority = await this.authority(actor, "cases.vote", before);
    return this.command(
      actor,
      "vote",
      requestId,
      { caseId, value },
      () => {
        const current = this.read(caseId);
        if (current.generation !== before.generation) throw new CaseError("stale_generation");
        if (!this.votingStatuses.has(current.status)) throw new CaseError("voting_closed");
        this.action(actor, "vote");
        const prior = this.jobs.db
          .prepare("SELECT value FROM case_votes WHERE guild_id=? AND case_id=? AND user_id=?")
          .get(this.guildId, caseId, actor);
        if (value === null)
          this.jobs.db
            .prepare("DELETE FROM case_votes WHERE guild_id=? AND case_id=? AND user_id=?")
            .run(this.guildId, caseId, actor);
        else
          this.jobs.db
            .prepare(
              "INSERT INTO case_votes VALUES (?,?,?,?,?) ON CONFLICT(guild_id,case_id,user_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            )
            .run(this.guildId, caseId, actor, value, this.now());
        if ((prior ? Number(prior.value) : null) !== value)
          this.jobs.db
            .prepare("UPDATE cases SET votes_revision=votes_revision+1 WHERE guild_id=? AND id=?")
            .run(this.guildId, caseId);
        return { votes: this.votes(this.read(caseId)), ownVote: value };
      },
      [authority, votingAuthority],
    );
  }

  private lease(job: Job): Job {
    const active = this.jobs.get(job.id);
    if (!active || active.guildId !== this.guildId || active.type !== "case.notify")
      throw new CaseError("not_found");
    if (
      active.state !== "running" ||
      active.leaseToken !== job.leaseToken ||
      active.leaseUntil === null ||
      active.leaseUntil <= this.now() ||
      (active.expiresAt !== null && active.expiresAt <= this.now()) ||
      active.cancelRequested
    )
      throw new CaseError("expired");
    return active;
  }
  async prepareNotification(
    job: Job,
    confirmAccess: (scope: CaseAudienceScope) => ConfirmedCaseTarget | Promise<ConfirmedCaseTarget>,
  ): Promise<PreparedCaseNotification> {
    const active = this.lease(job),
      payload = active.payload as Row;
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.caseId !== "string" ||
      typeof payload.eventId !== "string" ||
      payload.caseId !== active.objectId ||
      payload.generation !== active.generation
    )
      throw new CaseError("invalid_input");
    const value = this.read(payload.caseId);
    if (value.generation !== active.generation) throw new CaseError("stale_generation");
    const event = this.jobs.db
      .prepare("SELECT * FROM case_events WHERE guild_id=? AND case_id=? AND id=?")
      .get(this.guildId, value.id, payload.eventId);
    if (
      !event ||
      event.audience !== payload.recipient ||
      event.generation !== value.generation ||
      !["author", "staff", "public"].includes(String(event.audience)) ||
      event.kind === "internal_note"
    )
      throw new CaseError("invalid_input");
    if (
      event.audience === "public" &&
      (value.kind !== "suggestion" || value.visibility !== "public")
    )
      throw new CaseError("approval_required");
    await this.authority(String(event.actor_id), "cases.read", value);
    const scope: CaseAudienceScope = Object.freeze({
      guildId: this.guildId,
      caseId: value.id,
      ownerId: value.ownerId,
      visibility: value.visibility,
      audience: event.audience as CaseAudience,
      generation: value.generation,
    });
    const confirmed = await confirmAccess(scope);
    if (
      !confirmed ||
      confirmed.confirmed !== true ||
      Object.entries(scope).some(
        ([key, entry]) => confirmed[key as keyof ConfirmedCaseTarget] !== entry,
      )
    )
      throw new CaseError("acl_unconfirmed");
    id(confirmed.channelId);
    await this.authority(String(event.actor_id), "cases.read", this.read(value.id));
    const fresh = this.read(value.id);
    if (fresh.generation !== value.generation) throw new CaseError("stale_generation");
    this.lease(job);
    let content: string;
    if (event.kind === "replied") {
      const reply = this.jobs.db
        .prepare(
          "SELECT content FROM case_messages WHERE guild_id=? AND case_id=? AND id=? AND kind='reply'",
        )
        .get(this.guildId, value.id, String(event.message_id));
      if (!reply) throw new CaseError("not_found");
      content = `Odpowiedź w sprawie „${fresh.title}”\n\n${reply.content}`;
    } else if (event.kind === "status_changed")
      content = `Zmiana statusu sprawy „${fresh.title}”\n\n${event.content ?? ""}`;
    else if (event.kind === "assigned")
      content = `Sprawa „${fresh.title}” ma zmienioną osobę prowadzącą.`;
    else if (["created", "approved"].includes(String(event.kind)))
      content = `${fresh.title}\n\n${fresh.content}`;
    else throw new CaseError("invalid_input");
    return {
      caseId: value.id,
      eventId: String(event.id),
      channelId: confirmed.channelId,
      content: clip(content),
      roleIds: [],
      mentionEveryone: false,
      audience: scope.audience,
    };
  }
  async retentionCandidates(actor: string, limit = 100): Promise<CaseSummary[]> {
    integer(limit, 1, 1000);
    const authority = await this.authority(actor, "cases.list");
    if (
      !canPerform("cases.note", authority.member, authority.policy, {
        guildId: this.guildId,
        ownerId: actor,
        kind: "report",
        visibility: "private",
      })
    )
      throw new CaseError("permission_revoked");
    if (this.retention === null) return [];
    const result: CaseSummary[] = [];
    for (const row of this.jobs.db
      .prepare(
        "SELECT * FROM cases WHERE guild_id=? AND retention_at IS NOT NULL AND retention_at<=? ORDER BY retention_at,id LIMIT ?",
      )
      .all(this.guildId, this.now(), limit)) {
      const value = record(row);
      await this.authority(actor, "cases.note", value);
      result.push(summary(value));
    }
    return result;
  }
}
