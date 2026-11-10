import { randomUUID } from "node:crypto";
import { canonical } from "../../shared/utils.js";
import type { JobStore } from "../../core/jobs/store.js";
import type { Job } from "../../core/jobs/types.js";
import { detachAnnouncementAsset } from "../announcement-assets/references.js";
import { nextOccurrences, normalizeSchedule } from "./schedule.js";
import { hasAnnouncementBody, normalizeAnnouncementPresentation } from "./presentation.js";
import {
  AnnouncementError,
  type Announcement,
  type AnnouncementAuthorization,
  type AnnouncementDraft,
  type AnnouncementMutation,
  type AnnouncementMessage,
  type AnnouncementOperation,
  type AnnouncementOptions,
  type AnnouncementSchedule,
  type AnnouncementStatus,
  type PreparedAnnouncement,
  type ScheduledOccurrence,
} from "./types.js";

export { AnnouncementError } from "./types.js";
export type * from "./types.js";
export const announcementGraceMs = 600000;
type Row = Record<string, unknown>;
type NormalizedDraft = Omit<
  AnnouncementDraft,
  "roleIds" | "mentionEveryone" | "schedule" | "card" | "links" | "saveAsDraft"
> & {
  roleIds: string[];
  mentionEveryone: boolean;
  schedule: AnnouncementSchedule;
  card: Announcement["card"];
  links: Announcement["links"];
  saveAsDraft: boolean;
};

function id(value: unknown): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value))
    throw new AnnouncementError("invalid_input");
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 200 || value.includes("\0"))
    throw new AnnouncementError("invalid_input");
  return value;
}
function number(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new AnnouncementError("invalid_input");
  return value as number;
}
function clone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new AnnouncementError("invalid_input");
  }
}
function mentions(value: { roleIds: string[]; mentionEveryone: boolean }): string {
  return [
    ...value.roleIds.map((role) => `<@&${role}>`),
    ...(value.mentionEveryone ? ["@everyone"] : []),
  ].join(" ");
}
function draft(value: AnnouncementDraft, now: number): NormalizedDraft {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (field) =>
        ![
          "channelId",
          "content",
          "card",
          "links",
          "saveAsDraft",
          "roleIds",
          "mentionEveryone",
          "schedule",
        ].includes(field),
    )
  )
    throw new AnnouncementError("invalid_input");
  if (value.saveAsDraft !== undefined && typeof value.saveAsDraft !== "boolean")
    throw new AnnouncementError("invalid_input");
  const saveAsDraft = value.saveAsDraft ?? false;
  const channelId = saveAsDraft && value.channelId === "" ? "" : id(value.channelId);
  const presentation = normalizeAnnouncementPresentation(value);
  if (
    typeof value.content !== "string" ||
    value.content.length > 2000 ||
    value.content.includes("\0") ||
    (!saveAsDraft &&
      (!hasAnnouncementBody(value.content, presentation.card) ||
        (presentation.card && !hasAnnouncementBody("", presentation.card))))
  )
    throw new AnnouncementError("invalid_input");
  const roleIds = value.roleIds ?? [];
  if (!Array.isArray(roleIds) || roleIds.length > 10 || new Set(roleIds).size !== roleIds.length)
    throw new AnnouncementError("invalid_input");
  roleIds.forEach(id);
  if (value.mentionEveryone !== undefined && typeof value.mentionEveryone !== "boolean")
    throw new AnnouncementError("invalid_input");
  const normalized = {
    channelId,
    content: value.content,
    ...presentation,
    saveAsDraft,
    roleIds: [...roleIds],
    mentionEveryone: value.mentionEveryone ?? false,
    schedule: normalizeSchedule(value.schedule, now),
  };
  const prefix = mentions(normalized);
  if (value.content.length + (prefix ? prefix.length + 1 : 0) > 2000)
    throw new AnnouncementError("invalid_input");
  return normalized;
}
function announcement(row: Row): Announcement {
  const presentation = normalizeAnnouncementPresentation(JSON.parse(String(row.presentation)));
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    actorId: String(row.actor_id),
    channelId: String(row.channel_id),
    content: String(row.content),
    ...presentation,
    roleIds: JSON.parse(String(row.role_ids)),
    mentionEveryone: row.mention_everyone === 1,
    schedule: JSON.parse(String(row.definition)),
    status: row.is_draft === 1 ? "draft" : (row.status as AnnouncementStatus),
    revision: Number(row.revision),
    generation: Number(row.generation),
    nextDueAt: row.next_due_at === null ? null : Number(row.next_due_at),
    activeJobId: row.active_job_id === null ? null : String(row.active_job_id),
    publishedCount: Number(row.published_count),
    lastMessageId: row.last_message_id === null ? null : String(row.last_message_id),
    lastPublishedAt: row.last_published_at === null ? null : Number(row.last_published_at),
    blockedReason: row.blocked_reason === null ? null : String(row.blocked_reason),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
function savedDraft(value: Announcement): AnnouncementDraft {
  return {
    channelId: value.channelId,
    content: value.content,
    ...(value.card ? { card: value.card } : {}),
    links: value.links,
    roleIds: value.roleIds,
    mentionEveryone: value.mentionEveryone,
    schedule: value.schedule,
  };
}
function message(
  value: Pick<
    Announcement,
    "channelId" | "content" | "card" | "links" | "roleIds" | "mentionEveryone"
  >,
  test: boolean,
): AnnouncementMessage {
  const prefix = test ? "Próba ogłoszenia\n\n" : mentions(value);
  let content = test ? value.content : (prefix ? prefix + "\n" : "") + value.content;
  if (test) {
    const available = 2000 - prefix.length;
    if (content.length > available)
      content = content.slice(0, available - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
    content = prefix + content;
  }
  return {
    channelId: value.channelId,
    content,
    card: value.card,
    links: value.links,
    roleIds: test ? [] : value.roleIds,
    mentionEveryone: !test && value.mentionEveryone,
  };
}

export class AnnouncementService {
  readonly guildId: string;
  private readonly clock: () => number;
  private readonly maxAnnouncements: number;
  private readonly maxWrites: number;
  private readonly maxTests: number;

  constructor(
    readonly jobs: JobStore,
    private readonly options: AnnouncementOptions,
  ) {
    this.guildId = id(options.guildId);
    this.clock = options.clock ?? Date.now;
    this.maxAnnouncements = number(options.maxAnnouncements ?? 100, 1);
    this.maxWrites = number(options.maxWritesPerMinute ?? 20, 1);
    this.maxTests = number(options.maxTestsPerMinute ?? 3, 1);
    if (this.maxAnnouncements > 1000 || this.maxWrites > 100 || this.maxTests > 20)
      throw new AnnouncementError("invalid_input");
  }

  private now(): number {
    return number(this.clock());
  }
  private row(announcementId: string, includeRemoved = false): Row {
    const found = this.jobs.db
      .prepare(
        `SELECT a.*,s.definition,s.active_job_id,s.next_due_at,
      s.last_processed_at,s.published_count FROM announcements a JOIN schedules s ON s.announcement_id=a.id
      WHERE a.id=? AND a.guild_id=? AND (a.removed_at IS NULL OR ?=1)`,
      )
      .get(key(announcementId), this.guildId, Number(includeRemoved));
    if (!found) throw new AnnouncementError("not_found");
    return found;
  }
  private read(announcementId: string, includeRemoved = false): Announcement {
    return announcement(this.row(announcementId, includeRemoved));
  }
  private async authorize(
    actorId: string,
    operation: AnnouncementOperation,
    target?: Pick<Announcement, "channelId" | "roleIds" | "mentionEveryone"> &
      Partial<Pick<Announcement, "card">>,
  ): Promise<void> {
    const request: AnnouncementAuthorization = {
      guildId: this.guildId,
      actorId: id(actorId),
      operation,
      ...(target
        ? {
            channelId: target.channelId,
            roleIds: target.roleIds,
            mentionEveryone: target.mentionEveryone,
            hasCard: Boolean(target.card),
            hasImage: Boolean(target.card?.imageAssetId),
          }
        : {}),
    };
    await this.options.authorize(request);
  }
  private change(announcementId: string, expected: number): Announcement {
    const found = this.read(announcementId);
    if (found.revision !== number(expected, 1)) throw new AnnouncementError("revision_conflict");
    return found;
  }
  private async validateAsset(value: Pick<Announcement, "card">): Promise<void> {
    if (!value.card?.imageAssetId) return;
    if (!this.options.validateAsset) throw new AnnouncementError("invalid_input");
    await this.options.validateAsset(value.card.imageAssetId);
  }
  private saved(announcementId: string, includeRemoved = false): void {
    const result = this.options.onSaved?.(this.read(announcementId, includeRemoved)) as unknown;
    if (result && typeof result === "object" && "then" in result)
      throw new TypeError("Announcement save hooks must be synchronous.");
  }
  private response(announcementId: string): AnnouncementMutation {
    const value = this.read(announcementId);
    return {
      announcement: value,
      job: value.activeJobId ? (this.jobs.get(value.activeJobId) ?? null) : null,
    };
  }
  private action(actorId: string, kind: "write" | "test"): void {
    const now = this.now();
    this.jobs.db.prepare("DELETE FROM announcement_actions WHERE created_at<=?").run(now - 60000);
    const current = this.jobs.db
      .prepare("SELECT COUNT(*) AS count FROM announcement_actions WHERE actor_id=? AND kind=?")
      .get(actorId, kind)!;
    if (Number(current.count) >= (kind === "test" ? this.maxTests : this.maxWrites))
      throw new AnnouncementError("limit_exceeded");
    this.jobs.db
      .prepare("INSERT INTO announcement_actions VALUES (?,?,?,?)")
      .run(randomUUID(), actorId, kind, now);
  }
  private cancelGeneration(value: Announcement): void {
    const pending = this.jobs.db
      .prepare(
        `SELECT id FROM jobs WHERE guild_id=? AND object_id=? AND generation=?
      AND state IN ('pending','retry','running','unknown')`,
      )
      .all(this.guildId, value.id, value.generation);
    for (const entry of pending) this.jobs.cancel(String(entry.id));
  }
  private select(
    schedule: AnnouncementSchedule,
    after: number,
    catchUp: boolean,
  ): ScheduledOccurrence | undefined {
    const floor = Math.max(after, this.now() - (catchUp ? announcementGraceMs : 1));
    const choices = nextOccurrences(schedule, floor, 5);
    return (
      (catchUp ? choices.filter((entry) => entry.at <= this.now()).at(-1) : undefined) ?? choices[0]
    );
  }
  private plan(value: Announcement, after: number, catchUp: boolean): Job | null {
    if (
      value.schedule.kind !== "once" &&
      value.schedule.maxOccurrences !== undefined &&
      value.publishedCount >= value.schedule.maxOccurrences
    )
      return null;
    const occurrence = this.select(value.schedule, after, catchUp);
    if (!occurrence) return null;
    const queued = this.jobs.enqueue({
      guildId: this.guildId,
      type: "announcement.send",
      objectId: value.id,
      generation: value.generation,
      dueAt: occurrence.at,
      expiresAt: occurrence.at + announcementGraceMs,
      dedupeKey: `announcement:${value.id}:${value.generation}:${occurrence.at}`,
      payload: { announcementId: value.id, generation: value.generation },
    });
    this.jobs.db
      .prepare("UPDATE schedules SET active_job_id=?,next_due_at=? WHERE announcement_id=?")
      .run(queued.id, occurrence.at, value.id);
    return queued;
  }

  async create(
    actorId: string,
    requestId: string,
    input: AnnouncementDraft,
  ): Promise<AnnouncementMutation> {
    const requestInput = clone(input) as AnnouncementDraft;
    const value = draft(requestInput, this.now());
    const immediate = requestInput.schedule.kind === "now";
    await this.authorize(actorId, "create", value);
    await this.validateAsset(value);
    const outcome = this.jobs.idempotent(
      `announcement:create:${this.guildId}:${actorId}`,
      key(requestId),
      requestInput,
      () => {
        this.action(actorId, "write");
        const quantity = this.jobs.db
          .prepare(
            "SELECT COUNT(*) AS count FROM announcements WHERE guild_id=? AND removed_at IS NULL AND status IN ('scheduled','paused','blocked')",
          )
          .get(this.guildId)!;
        if (Number(quantity.count) >= this.maxAnnouncements)
          throw new AnnouncementError("limit_exceeded");
        const now = this.now();
        const schedule = immediate ? normalizeSchedule(requestInput.schedule, now) : value.schedule;
        if (!value.saveAsDraft && schedule.kind === "once" && schedule.at < now)
          throw new AnnouncementError("invalid_input");
        const announcementId = randomUUID();
        this.jobs.db
          .prepare(
            `INSERT INTO announcements
        (id,guild_id,actor_id,channel_id,content,role_ids,mention_everyone,status,revision,generation,created_at,updated_at,presentation,is_draft)
        VALUES (?,?,?,?,?,?,?,?,1,1,?,?,?,?)`,
          )
          .run(
            announcementId,
            this.guildId,
            actorId,
            value.channelId,
            value.content,
            canonical(value.roleIds),
            Number(value.mentionEveryone),
            value.saveAsDraft ? "paused" : "scheduled",
            now,
            now,
            canonical({ card: value.card, links: value.links }),
            Number(value.saveAsDraft),
          );
        this.jobs.db
          .prepare("INSERT INTO schedules (announcement_id,definition) VALUES (?,?)")
          .run(announcementId, canonical(schedule));
        this.saved(announcementId);
        if (!value.saveAsDraft && !this.plan(this.read(announcementId), now - 1, immediate))
          throw new AnnouncementError("schedule_exhausted");
        return this.response(announcementId);
      },
    );
    // An old create receipt must not expose or restore an explicitly removed rule.
    this.row(outcome.announcement.id);
    return outcome;
  }

  async get(actorId: string, announcementId: string): Promise<Announcement> {
    await this.authorize(actorId, "read");
    this.sync();
    return this.read(announcementId);
  }
  async list(actorId: string): Promise<Announcement[]> {
    await this.authorize(actorId, "list");
    this.sync();
    return this.jobs.db
      .prepare(
        "SELECT id FROM announcements WHERE guild_id=? AND removed_at IS NULL ORDER BY created_at DESC,id LIMIT 500",
      )
      .all(this.guildId)
      .map((row) => this.read(String(row.id)));
  }

  async update(
    actorId: string,
    requestId: string,
    announcementId: string,
    revision: number,
    input: AnnouncementDraft,
  ): Promise<AnnouncementMutation> {
    const requestInput = clone(input) as AnnouncementDraft;
    if (requestInput?.schedule?.kind === "now") throw new AnnouncementError("invalid_input");
    const value = draft(requestInput, this.now());
    await this.authorize(actorId, "update", value);
    await this.validateAsset(value);
    this.row(announcementId);
    return this.jobs.idempotent(
      `announcement:update:${this.guildId}:${actorId}`,
      key(requestId),
      clone({ announcementId, revision, input: requestInput }),
      () => {
        const current = this.change(announcementId, revision);
        if (current.status === "cancelled") throw new AnnouncementError("cancelled");
        if (!value.saveAsDraft && value.schedule.kind === "once" && value.schedule.at < this.now())
          throw new AnnouncementError("invalid_input");
        this.action(actorId, "write");
        this.cancelGeneration(current);
        const status = value.saveAsDraft
          ? "paused"
          : ["paused", "blocked"].includes(current.status)
            ? current.status
            : "scheduled";
        this.jobs.db
          .prepare(
            `UPDATE announcements SET actor_id=?,channel_id=?,content=?,role_ids=?,mention_everyone=?,
          status=?,revision=revision+1,generation=generation+1,updated_at=?,presentation=?,is_draft=? WHERE id=?`,
          )
          .run(
            actorId,
            value.channelId,
            value.content,
            canonical(value.roleIds),
            Number(value.mentionEveryone),
            status,
            this.now(),
            canonical({ card: value.card, links: value.links }),
            Number(value.saveAsDraft),
            announcementId,
          );
        this.jobs.db
          .prepare(
            "UPDATE schedules SET definition=?,active_job_id=NULL,next_due_at=NULL,last_processed_at=NULL WHERE announcement_id=?",
          )
          .run(canonical(value.schedule), announcementId);
        this.saved(announcementId);
        if (
          !value.saveAsDraft &&
          status === "scheduled" &&
          !this.plan(this.read(announcementId), this.now() - 1, false)
        )
          throw new AnnouncementError("schedule_exhausted");
        return this.response(announcementId);
      },
    );
  }

  async pause(
    actorId: string,
    requestId: string,
    announcementId: string,
    revision: number,
  ): Promise<AnnouncementMutation> {
    return this.transition(actorId, requestId, announcementId, revision, "pause");
  }
  async resume(
    actorId: string,
    requestId: string,
    announcementId: string,
    revision: number,
  ): Promise<AnnouncementMutation> {
    return this.transition(actorId, requestId, announcementId, revision, "resume");
  }
  async cancel(
    actorId: string,
    requestId: string,
    announcementId: string,
    revision: number,
  ): Promise<AnnouncementMutation> {
    return this.transition(actorId, requestId, announcementId, revision, "cancel");
  }
  async remove(
    actorId: string,
    requestId: string,
    announcementId: string,
    revision: number,
  ): Promise<{ removed: true; announcementId: string; revision: number }> {
    // Cleanup must not depend on a deleted channel or an expired image being readable.
    await this.authorize(actorId, "remove");
    return this.jobs.idempotent(
      `announcement:remove:${this.guildId}:${actorId}`,
      key(requestId),
      { announcementId: key(announcementId), revision: number(revision, 1) },
      () => {
        const current = this.change(announcementId, revision);
        this.action(actorId, "write");
        const removedAt = this.now();
        for (const queued of this.jobs.db
          .prepare(
            "SELECT id FROM jobs WHERE guild_id=? AND object_id=? AND type='announcement.send' AND state IN ('pending','retry','running','unknown')",
          )
          .all(this.guildId, announcementId))
          this.jobs.cancel(String(queued.id));
        this.jobs.db
          .prepare(
            `UPDATE announcements SET status='cancelled',is_draft=0,
          content='',channel_id='',role_ids='[]',mention_everyone=0,presentation=?,
          removed_at=?,revision=revision+1,generation=generation+1,updated_at=? WHERE id=? AND guild_id=?`,
          )
          .run(
            canonical({ card: null, links: [] }),
            removedAt,
            removedAt,
            announcementId,
            this.guildId,
          );
        this.jobs.db
          .prepare(
            "UPDATE schedules SET active_job_id=NULL,next_due_at=NULL WHERE announcement_id=?",
          )
          .run(announcementId);
        detachAnnouncementAsset(this.jobs.db, this.guildId, announcementId, removedAt);
        this.saved(announcementId, true);
        this.jobs.db
          .prepare(
            `UPDATE idempotency_keys SET result=json_set(result,
          '$.announcement.content','', '$.announcement.card',json('null'), '$.announcement.links',json('[]'))
          WHERE json_extract(result,'$.announcement.id')=? AND json_extract(result,'$.announcement.guildId')=?`,
          )
          .run(announcementId, this.guildId);
        return { removed: true as const, announcementId, revision: current.revision + 1 };
      },
    );
  }
  private async transition(
    actorId: string,
    requestId: string,
    announcementId: string,
    revision: number,
    operation: "pause" | "resume" | "cancel",
  ): Promise<AnnouncementMutation> {
    const resumeTarget =
      operation === "resume" ? draft(savedDraft(this.read(announcementId)), this.now()) : undefined;
    await this.authorize(actorId, operation, resumeTarget);
    if (resumeTarget) await this.validateAsset(resumeTarget);
    this.row(announcementId);
    return this.jobs.idempotent(
      `announcement:${operation}:${this.guildId}:${actorId}`,
      key(requestId),
      { announcementId, revision },
      () => {
        const current = this.change(announcementId, revision);
        if (current.status === "cancelled") throw new AnnouncementError("cancelled");
        if (operation === "pause" && !["scheduled", "blocked"].includes(current.status))
          throw new AnnouncementError("state_conflict");
        if (
          operation === "resume" &&
          !["draft", "paused", "blocked", "expired", "completed"].includes(current.status)
        )
          throw new AnnouncementError("state_conflict");
        this.action(actorId, "write");
        this.cancelGeneration(current);
        const status =
          operation === "pause" ? "paused" : operation === "cancel" ? "cancelled" : "scheduled";
        this.jobs.db
          .prepare(
            `UPDATE announcements SET status=?,is_draft=0,generation=generation+1,revision=revision+1,
          actor_id=?,blocked_reason=NULL,updated_at=? WHERE id=?`,
          )
          .run(
            status,
            operation === "resume" ? actorId : current.actorId,
            this.now(),
            announcementId,
          );
        this.jobs.db
          .prepare(
            "UPDATE schedules SET active_job_id=NULL,next_due_at=NULL WHERE announcement_id=?",
          )
          .run(announcementId);
        if (
          operation === "resume" &&
          !this.plan(this.read(announcementId), -1, current.schedule.kind === "once")
        )
          throw new AnnouncementError("schedule_exhausted");
        return this.response(announcementId);
      },
    );
  }

  async test(
    actorId: string,
    requestId: string,
    announcementId: string,
    revision?: number,
  ): Promise<AnnouncementMutation> {
    const before = this.read(announcementId);
    const value = draft(savedDraft(before), this.now());
    await this.authorize(actorId, "test", { ...before, roleIds: [], mentionEveryone: false });
    await this.validateAsset(value);
    return this.jobs.idempotent(
      `announcement:test:${this.guildId}:${actorId}`,
      key(requestId),
      clone({ announcementId, ...(revision === undefined ? {} : { revision }) }),
      () => {
        const current =
          revision === undefined
            ? this.read(announcementId)
            : this.change(announcementId, revision);
        if (current.status === "cancelled") throw new AnnouncementError("cancelled");
        if (current.generation !== before.generation)
          throw new AnnouncementError("revision_conflict");
        this.action(actorId, "test");
        const queued = this.jobs.enqueue({
          guildId: this.guildId,
          type: "announcement.send",
          objectId: announcementId,
          generation: current.generation,
          dueAt: this.now(),
          expiresAt: this.now() + announcementGraceMs,
          dedupeKey: `announcement:${announcementId}:test:${actorId}:${requestId}`,
          payload: { announcementId, generation: current.generation, test: true, actorId },
        });
        return { announcement: current, job: queued };
      },
    );
  }

  async preview(
    actorId: string,
    input: AnnouncementDraft,
    after = this.now() - 1,
    count = 5,
  ): Promise<ScheduledOccurrence[]> {
    const value = draft(input, this.now());
    await this.authorize(actorId, "preview", value);
    await this.validateAsset(value);
    return nextOccurrences(value.schedule, after, count);
  }
  async previewMessage(actorId: string, input: AnnouncementDraft): Promise<AnnouncementMessage> {
    const value = draft({ ...(clone(input) as AnnouncementDraft), saveAsDraft: false }, this.now());
    await this.authorize(actorId, "preview", value);
    await this.validateAsset(value);
    return message(value, false);
  }

  private allowed(value: Announcement, generation: number, test: boolean): void {
    if (value.generation !== generation) throw new AnnouncementError("stale_generation");
    if (value.status === "cancelled") throw new AnnouncementError("cancelled");
    if (test) return;
    if (value.status === "paused") throw new AnnouncementError("paused");
    if (value.status === "blocked")
      throw new AnnouncementError(
        value.blockedReason === "channel_unavailable"
          ? "channel_unavailable"
          : value.blockedReason === "asset_unavailable"
            ? "asset_unavailable"
            : "permission_revoked",
      );
    if (value.status !== "scheduled") throw new AnnouncementError("expired");
  }

  private blockPublication(
    queued: Job,
    reason: "channel_unavailable" | "permission_revoked" | "asset_unavailable",
  ): void {
    this.jobs.transaction(() => {
      const active = this.jobs.get(queued.id);
      if (
        !active ||
        active.guildId !== this.guildId ||
        active.type !== "announcement.send" ||
        active.state !== "running" ||
        active.leaseToken !== queued.leaseToken ||
        active.leaseUntil === null ||
        active.leaseUntil <= this.now() ||
        active.cancelRequested ||
        !active.objectId ||
        (active.payload &&
          typeof active.payload === "object" &&
          "test" in active.payload &&
          active.payload.test === true)
      )
        return;
      const value = this.read(active.objectId);
      if (value.generation !== active.generation || value.status !== "scheduled") return;
      this.jobs.db
        .prepare(
          "UPDATE announcements SET status='blocked',blocked_reason=?,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(reason, this.now(), value.id);
    });
  }
  markAssetUnavailable(queued: Job): void {
    this.blockPublication(queued, "asset_unavailable");
  }
  async prepare(queued: Job): Promise<PreparedAnnouncement> {
    const persisted = this.jobs.get(queued.id);
    if (!persisted || persisted.guildId !== this.guildId || persisted.type !== "announcement.send")
      throw new AnnouncementError("not_found");
    if (
      persisted.state !== "running" ||
      persisted.leaseToken !== queued.leaseToken ||
      persisted.leaseUntil === null ||
      persisted.leaseUntil <= this.now() ||
      persisted.cancelRequested
    )
      throw new AnnouncementError(persisted.state === "cancelled" ? "cancelled" : "expired");
    const payload = persisted.payload as Record<string, unknown>;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.announcementId !== "string" ||
      !Number.isSafeInteger(payload.generation) ||
      (payload.test !== undefined && payload.test !== true) ||
      persisted.objectId !== payload.announcementId ||
      persisted.generation !== payload.generation
    )
      throw new AnnouncementError("invalid_input");
    const isTest = payload.test === true;
    const value = this.read(payload.announcementId, true);
    this.allowed(value, persisted.generation, isTest);
    if (persisted.expiresAt === null || persisted.expiresAt <= this.now())
      throw new AnnouncementError("expired");
    if (persisted.dueAt > this.now()) throw new AnnouncementError("invalid_input");
    const actor = isTest ? id(payload.actorId) : value.actorId;
    try {
      await this.authorize(actor, "deliver", {
        ...value,
        roleIds: isTest ? [] : value.roleIds,
        mentionEveryone: !isTest && value.mentionEveryone,
      });
      draft(savedDraft(value), this.now());
      await this.validateAsset(value);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const reason = ["asset_not_found", "asset_expired", "invalid_asset"].includes(code)
        ? "asset_unavailable"
        : ["channel_unavailable", "invalid_channel", "missing_channel"].includes(code)
          ? "channel_unavailable"
          : ["permission_revoked", "forbidden", "not_authorized"].includes(code)
            ? "permission_revoked"
            : null;
      if (!reason) throw error;
      this.blockPublication(queued, reason);
      throw new AnnouncementError(reason);
    }
    const fresh = this.read(value.id, true);
    this.allowed(fresh, persisted.generation, isTest);
    const active = this.jobs.get(queued.id);
    if (
      active?.state !== "running" ||
      active.leaseToken !== queued.leaseToken ||
      active.leaseUntil === null ||
      active.leaseUntil <= this.now() ||
      active.cancelRequested
    )
      throw new AnnouncementError(active?.state === "cancelled" ? "cancelled" : "expired");
    if (persisted.expiresAt <= this.now()) throw new AnnouncementError("expired");
    return {
      announcement: fresh,
      ...message(fresh, isTest),
      test: isTest,
    };
  }

  private record(settled: Job): boolean {
    if (
      !settled.objectId ||
      !["succeeded", "failed", "cancelled", "expired"].includes(settled.state)
    )
      return false;
    const payload =
      settled.payload && typeof settled.payload === "object" && !Array.isArray(settled.payload)
        ? (settled.payload as Record<string, unknown>)
        : {};
    const delivered =
      settled.state === "succeeded" &&
      payload.test !== true &&
      payload.announcementId === settled.objectId;
    const inserted = this.jobs.db
      .prepare("INSERT OR IGNORE INTO announcement_job_receipts VALUES (?,?,?,?)")
      .run(settled.id, settled.objectId, Number(delivered), this.now());
    if (!Number(inserted.changes)) return false;
    if (delivered) {
      this.jobs.db
        .prepare("UPDATE schedules SET published_count=published_count+1 WHERE announcement_id=?")
        .run(settled.objectId);
      this.jobs.db
        .prepare(
          `UPDATE announcements SET last_message_id=?,last_published_at=?,revision=revision+1,updated_at=?
        WHERE id=? AND removed_at IS NULL AND (last_published_at IS NULL OR last_published_at<=?)`,
        )
        .run(settled.messageId, settled.updatedAt, this.now(), settled.objectId, settled.updatedAt);
    }
    return true;
  }

  sync(): number {
    return this.jobs.transaction(() => {
      this.jobs.recover();
      let changed = 0;
      const finished = this.jobs.db
        .prepare(
          `SELECT j.id FROM jobs j JOIN announcements a ON a.id=j.object_id
        LEFT JOIN announcement_job_receipts r ON r.job_id=j.id
        WHERE j.guild_id=? AND j.type='announcement.send' AND r.job_id IS NULL
        AND j.state IN ('succeeded','failed','cancelled','expired') ORDER BY j.updated_at,j.id LIMIT 100`,
        )
        .all(this.guildId);
      for (const row of finished) if (this.record(this.jobs.get(String(row.id))!)) changed++;
      const active = this.jobs.db
        .prepare(
          "SELECT id FROM announcements WHERE guild_id=? AND removed_at IS NULL AND status='scheduled' ORDER BY created_at,id LIMIT 1000",
        )
        .all(this.guildId);
      for (const row of active) {
        let value = this.read(String(row.id));
        const currentJob = value.activeJobId ? this.jobs.get(value.activeJobId) : undefined;
        if (currentJob && this.record(currentJob)) changed++;
        value = this.read(value.id);
        if (
          value.schedule.kind !== "once" &&
          value.schedule.maxOccurrences !== undefined &&
          value.publishedCount >= value.schedule.maxOccurrences
        ) {
          this.cancelGeneration(value);
          this.jobs.db
            .prepare(
              "UPDATE announcements SET status='completed',generation=generation+1,revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(this.now(), value.id);
          this.jobs.db
            .prepare(
              "UPDATE schedules SET active_job_id=NULL,next_due_at=NULL WHERE announcement_id=?",
            )
            .run(value.id);
          changed++;
          continue;
        }
        if (currentJob && ["pending", "retry", "running", "unknown"].includes(currentJob.state))
          continue;
        if (currentJob?.state === "failed" || currentJob?.state === "cancelled") {
          this.jobs.db
            .prepare(
              "UPDATE announcements SET status=?,blocked_reason=?,revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(
              currentJob.state === "failed" ? "blocked" : "paused",
              currentJob.lastError,
              this.now(),
              value.id,
            );
          changed++;
          continue;
        }
        if (value.schedule.kind === "once") {
          this.jobs.db
            .prepare(
              "UPDATE announcements SET status=?,revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(currentJob?.state === "succeeded" ? "completed" : "expired", this.now(), value.id);
          this.jobs.db
            .prepare(
              "UPDATE schedules SET active_job_id=NULL,next_due_at=NULL,last_processed_at=? WHERE announcement_id=?",
            )
            .run(currentJob?.dueAt ?? this.now(), value.id);
          changed++;
          continue;
        }
        const after = currentJob?.dueAt ?? Number(this.row(value.id).last_processed_at ?? -1);
        this.jobs.db
          .prepare(
            "UPDATE schedules SET active_job_id=NULL,next_due_at=NULL,last_processed_at=? WHERE announcement_id=?",
          )
          .run(after, value.id);
        const queued = this.plan(this.read(value.id), after, true);
        if (!queued)
          this.jobs.db
            .prepare(
              "UPDATE announcements SET status='completed',revision=revision+1,updated_at=? WHERE id=?",
            )
            .run(this.now(), value.id);
        else
          this.jobs.db
            .prepare("UPDATE announcements SET revision=revision+1,updated_at=? WHERE id=?")
            .run(this.now(), value.id);
        changed++;
      }
      return changed;
    });
  }
}
