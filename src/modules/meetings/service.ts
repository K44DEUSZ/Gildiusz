import { randomUUID } from "node:crypto";
import { canonical } from "../../shared/utils.js";
import type { JobStore } from "../../core/jobs/store.js";
import type { Job } from "../../core/jobs/types.js";
import {
  MeetingError,
  type Meeting,
  type MeetingAudience,
  type MeetingDraft,
  type MeetingDetail,
  type MeetingEffectResult,
  type MeetingJobType,
  type MeetingMutation,
  type MeetingOperation,
  type MeetingOptions,
  type MeetingParticipant,
  type MeetingRoom,
  type PreparedMeetingJob,
} from "./types.js";

export { MeetingError } from "./types.js";
export type * from "./types.js";
export const meetingNowGraceMs = 60000;
type Row = Record<string, unknown>;
type Definition = Required<MeetingDraft>;
type Eligibility = Map<string, boolean>;
const liveStates = new Set(["draft", "open", "starting", "active"]);
const jobTypes = new Set<MeetingJobType>([
  "meeting.publish",
  "meeting.reminder",
  "meeting.promoted",
  "meeting.start",
  "meeting.finish",
]);

function id(value: unknown): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value))
    throw new MeetingError("invalid_input");
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 200 || value.includes("\0"))
    throw new MeetingError("invalid_input");
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new MeetingError("invalid_input");
  return value as number;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new MeetingError("invalid_input");
  return value;
}
function room(input: unknown): MeetingRoom {
  if (input === undefined) return { kind: "none" };
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new MeetingError("invalid_input");
  const value = input as Record<string, unknown>;
  if (value.kind === "none" && Object.keys(value).length === 1) return { kind: "none" };
  if (value.kind === "existing" && Object.keys(value).length === 2)
    return { kind: "existing", channelId: id(value.channelId) };
  if (value.kind === "create" && Object.keys(value).length === 2)
    return { kind: "create", categoryId: id(value.categoryId) };
  throw new MeetingError("invalid_input");
}
function definition(input: MeetingDraft, fallbackState: "draft" | "open" = "open"): Definition {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (field) =>
        ![
          "title",
          "description",
          "capacity",
          "startsAt",
          "endsAt",
          "channelId",
          "visibility",
          "allowedRoleIds",
          "invitedUserIds",
          "organizerParticipates",
          "room",
          "reminderMinutes",
          "state",
        ].includes(field),
    )
  )
    throw new MeetingError("invalid_input");
  const startsAt = integer(input.startsAt),
    endsAt = integer(input.endsAt);
  if (endsAt <= startsAt || endsAt - startsAt > 7 * 86400000)
    throw new MeetingError("invalid_input");
  if (!["public", "private"].includes(input.visibility)) throw new MeetingError("invalid_input");
  const allowedRoleIds = input.allowedRoleIds ?? [];
  if (
    !Array.isArray(allowedRoleIds) ||
    allowedRoleIds.length > 20 ||
    new Set(allowedRoleIds).size !== allowedRoleIds.length
  )
    throw new MeetingError("invalid_input");
  allowedRoleIds.forEach(id);
  const invitedUserIds = input.invitedUserIds ?? [];
  if (
    !Array.isArray(invitedUserIds) ||
    invitedUserIds.length > 50 ||
    new Set(invitedUserIds).size !== invitedUserIds.length
  )
    throw new MeetingError("invalid_input");
  invitedUserIds.forEach(id);
  const reminderMinutes = input.reminderMinutes ?? [15];
  if (
    !Array.isArray(reminderMinutes) ||
    reminderMinutes.length > 5 ||
    new Set(reminderMinutes).size !== reminderMinutes.length
  )
    throw new MeetingError("invalid_input");
  reminderMinutes.forEach((value) => integer(value, 1, 10080));
  const organizerParticipates = input.organizerParticipates ?? true;
  if (typeof organizerParticipates !== "boolean") throw new MeetingError("invalid_input");
  const state = input.state ?? fallbackState;
  if (state !== "draft" && state !== "open") throw new MeetingError("invalid_input");
  return {
    title: text(input.title, 120),
    description: text(input.description, 1500, true),
    capacity: integer(input.capacity, 1, 100),
    startsAt,
    endsAt,
    channelId: id(input.channelId),
    visibility: input.visibility,
    allowedRoleIds: [...allowedRoleIds],
    invitedUserIds: [...invitedUserIds],
    organizerParticipates,
    room: room(input.room),
    reminderMinutes: [...reminderMinutes].sort((a, b) => b - a),
    state,
  };
}
function draftOf(value: Meeting): MeetingDraft {
  return {
    title: value.title,
    description: value.description,
    capacity: value.capacity,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    channelId: value.channelId,
    visibility: value.visibility,
    allowedRoleIds: value.allowedRoleIds,
    invitedUserIds: value.invitedUserIds,
    organizerParticipates: value.organizerParticipates,
    room: value.room,
    reminderMinutes: value.reminderMinutes,
    state: value.state === "draft" ? "draft" : "open",
  };
}
function participant(row: Row): MeetingParticipant {
  return {
    meetingId: String(row.meeting_id),
    userId: String(row.user_id),
    state: row.state as MeetingParticipant["state"],
    sequence: Number(row.sequence),
    joinedAt: Number(row.joined_at),
    updatedAt: Number(row.updated_at),
    leftReason: row.left_reason as MeetingParticipant["leftReason"],
  };
}
function forbidden(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "forbidden",
  );
}

export class MeetingService {
  readonly guildId: string;
  private readonly clock: () => number;
  private readonly maxMeetings: number;
  constructor(
    readonly jobs: JobStore,
    private readonly options: MeetingOptions,
  ) {
    this.guildId = id(options.guildId);
    const hasIdentity = this.jobs.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guild_identity'")
      .get();
    if (hasIdentity) {
      const identity = this.jobs.db
        .prepare("SELECT guild FROM guild_identity WHERE singleton=1")
        .get();
      if (identity && identity.guild !== this.guildId) throw new MeetingError("guild_conflict");
    }
    this.clock = options.clock ?? Date.now;
    this.maxMeetings = integer(options.maxMeetings ?? 100, 1, 1000);
  }
  private now(): number {
    return integer(this.clock());
  }
  private row(meetingId: string): Row {
    const value = this.jobs.db
      .prepare(
        `SELECT m.*,
      (SELECT COUNT(*) FROM meeting_participants p WHERE p.meeting_id=m.id AND p.state='confirmed') AS confirmed_count,
      (SELECT COUNT(*) FROM meeting_participants p WHERE p.meeting_id=m.id AND p.state='waitlisted') AS waitlisted_count
      FROM meetings m WHERE m.id=? AND m.guild_id=?`,
      )
      .get(key(meetingId), this.guildId);
    if (!value) throw new MeetingError("not_found");
    return value;
  }
  private read(meetingId: string): Meeting {
    const value = this.row(meetingId),
      confirmedCount = Number(value.confirmed_count);
    return {
      id: String(value.id),
      guildId: String(value.guild_id),
      creatorId: String(value.creator_id),
      organizerId: String(value.organizer_id),
      title: String(value.title),
      description: String(value.description),
      capacity: Number(value.capacity),
      startsAt: Number(value.starts_at),
      endsAt: Number(value.ends_at),
      channelId: String(value.channel_id),
      visibility: value.visibility as Meeting["visibility"],
      allowedRoleIds: JSON.parse(String(value.allowed_role_ids)),
      invitedUserIds: this.jobs.db
        .prepare("SELECT user_id FROM meeting_invites WHERE meeting_id=? ORDER BY user_id")
        .all(String(value.id))
        .map((invite) => String(invite.user_id)),
      organizerParticipates: value.organizer_participates === 1,
      room: JSON.parse(String(value.room)),
      reminderMinutes: JSON.parse(String(value.reminder_minutes)),
      state: value.state as Meeting["state"],
      revision: Number(value.revision),
      generation: Number(value.generation),
      participantVersion: Number(value.participant_version),
      confirmedCount,
      waitlistedCount: Number(value.waitlisted_count),
      full: confirmedCount >= Number(value.capacity),
      messageId: value.message_id === null ? null : String(value.message_id),
      roomChannelId: value.room_channel_id === null ? null : String(value.room_channel_id),
      roomCreatedByBot: value.room_created_by_bot === 1,
      guildScheduledEventId:
        value.guild_scheduled_event_id === null ? null : String(value.guild_scheduled_event_id),
      createdAt: Number(value.created_at),
      updatedAt: Number(value.updated_at),
    };
  }
  private roster(meetingId: string): MeetingParticipant[] {
    return this.jobs.db
      .prepare("SELECT * FROM meeting_participants WHERE meeting_id=? ORDER BY sequence")
      .all(meetingId)
      .map(participant);
  }
  private detail(meetingId: string): MeetingDetail {
    return { meeting: this.read(meetingId), participants: this.roster(meetingId) };
  }
  // Trusted adapter read for security housekeeping. Never expose this without member authorization.
  systemDetail(meetingId: string): MeetingDetail {
    return this.jobs.transaction(() => this.detail(meetingId));
  }
  private response(meetingId: string): MeetingMutation {
    return {
      ...this.detail(meetingId),
      jobs: this.jobs.list({ guildId: this.guildId, objectId: meetingId, limit: 500 }),
    };
  }
  private mutate(
    scope: string,
    requestId: string,
    input: unknown,
    work: () => MeetingMutation,
  ): MeetingMutation {
    // Persist the outcome reference, not a growing roster and history in the idempotency record.
    const meetingId = this.jobs.idempotent(scope, requestId, input, () => work().meeting.id);
    return this.response(meetingId);
  }
  private async allowed(
    actorId: string,
    operation: MeetingOperation,
    meeting?: Meeting,
    draft?: Definition,
    jobType?: MeetingJobType,
  ): Promise<void> {
    if (
      (await this.options.authorize({
        guildId: this.guildId,
        actorId: id(actorId),
        operation,
        ...(meeting ? { meeting } : {}),
        ...(meeting
          ? {
              participantIds: this.roster(meeting.id)
                .filter((entry) => entry.state !== "left")
                .map((entry) => entry.userId),
            }
          : {}),
        ...(draft ? { draft } : {}),
        ...(jobType ? { jobType } : {}),
      })) === false
    )
      throw new MeetingError("forbidden");
  }
  private checkSnapshot(snapshot: Meeting, roster = false): Meeting {
    const current = this.read(snapshot.id);
    if (
      current.revision !== snapshot.revision ||
      current.generation !== snapshot.generation ||
      (roster && current.participantVersion !== snapshot.participantVersion)
    )
      throw new MeetingError("revision_conflict");
    return current;
  }
  private assertOpen(value: Meeting): void {
    if (value.state !== "open") throw new MeetingError("state_conflict");
    if (value.endsAt <= this.now()) throw new MeetingError("expired");
  }
  private audit(meetingId: string, actorId: string, action: string): void {
    this.jobs.db
      .prepare("INSERT INTO meeting_audit VALUES (?,?,?,?,?)")
      .run(randomUUID(), meetingId, actorId, action, this.now());
  }
  private changed(meetingId: string): Meeting {
    this.jobs.db
      .prepare(
        "UPDATE meetings SET participant_version=participant_version+1,updated_at=? WHERE id=?",
      )
      .run(this.now(), meetingId);
    return this.read(meetingId);
  }
  private replaceInvites(meetingId: string, invitedUserIds: readonly string[]): void {
    const existing = this.read(meetingId).invitedUserIds;
    for (const userId of existing)
      if (!invitedUserIds.includes(userId))
        this.jobs.db
          .prepare("DELETE FROM meeting_invites WHERE meeting_id=? AND user_id=?")
          .run(meetingId, userId);
    for (const userId of invitedUserIds)
      this.jobs.db
        .prepare("INSERT OR IGNORE INTO meeting_invites VALUES (?,?,?)")
        .run(meetingId, userId, this.now());
  }
  private async audienceEligibility(value: Meeting): Promise<Eligibility> {
    const result: Eligibility = new Map();
    for (const person of this.roster(value.id).filter((entry) => entry.state !== "left")) {
      const eligible = await this.options.eligible(person.userId, value);
      if (typeof eligible !== "boolean") throw new MeetingError("invalid_input");
      result.set(person.userId, eligible);
    }
    return result;
  }
  private removeIneligible(value: Meeting, eligibility: Eligibility): void {
    for (const person of this.roster(value.id).filter((entry) => entry.state !== "left")) {
      if (!eligibility.has(person.userId)) throw new MeetingError("revision_conflict");
      if (eligibility.get(person.userId)) continue;
      this.jobs.db
        .prepare(
          "UPDATE meeting_participants SET state='left',left_reason='ineligible',updated_at=? WHERE meeting_id=? AND user_id=?",
        )
        .run(this.now(), value.id, person.userId);
      this.cancelJobs(value, person.userId);
    }
  }
  private retireMessage(value: Meeting): void {
    if (!value.messageId) return;
    const proof = this.jobs.db
      .prepare(
        `SELECT j.id AS source_id,a.id AS attempt_id
      FROM jobs j JOIN delivery_attempts a ON a.job_id=j.id
      WHERE j.guild_id=? AND j.object_id=? AND j.type='meeting.publish'
      AND json_extract(j.payload,'$.meetingId')=? AND a.state='succeeded'
      AND a.channel_id=? AND a.message_id=? ORDER BY j.created_at DESC,j.id DESC,a.number DESC LIMIT 1`,
      )
      .get(this.guildId, value.id, value.id, value.channelId, value.messageId);
    if (proof) {
      const dedupeKey = `community:meeting-controls-clear:${proof.attempt_id}`,
        existing = this.jobs.db
          .prepare("SELECT due_at FROM jobs WHERE dedupe_key=?")
          .get(dedupeKey);
      this.jobs.enqueue({
        guildId: this.guildId,
        objectId: value.id,
        type: "community.meeting-controls-clear",
        dueAt: existing ? Number(existing.due_at) : this.now(),
        dedupeKey,
        payload: {
          sourceJobId: String(proof.source_id),
          attemptId: String(proof.attempt_id),
          channelId: value.channelId,
          messageId: value.messageId,
        },
      });
    }
  }
  private enqueue(
    type: MeetingJobType,
    value: Meeting,
    suffix: string,
    extra: Record<string, unknown> = {},
    dueAt = this.now(),
    expiresAt = value.endsAt,
  ): Job {
    return this.jobs.enqueue({
      guildId: this.guildId,
      type,
      objectId: value.id,
      generation: value.generation,
      dueAt,
      expiresAt: Math.max(dueAt, expiresAt),
      dedupeKey: `meeting:${type}:${this.guildId}:${value.id}:${value.generation}:${suffix}`,
      payload: { meetingId: value.id, generation: value.generation, ...extra },
    });
  }
  private publish(value: Meeting): void {
    if (value.state === "draft") return;
    this.enqueue(
      "meeting.publish",
      value,
      `${value.revision}:${value.participantVersion}`,
      { participantVersion: value.participantVersion },
      this.now(),
      liveStates.has(value.state) ? value.endsAt : this.now() + 86400000,
    );
  }
  private reminders(value: Meeting, target?: MeetingParticipant): void {
    if (value.state !== "open") return;
    for (const person of target
      ? [target]
      : this.roster(value.id).filter((entry) => entry.state === "confirmed")) {
      for (const minutes of value.reminderMinutes) {
        const dueAt = value.startsAt - minutes * 60000;
        if (dueAt <= this.now()) continue;
        this.enqueue(
          "meeting.reminder",
          value,
          `${person.userId}:${person.sequence}:${minutes}`,
          { recipientId: person.userId, sequence: person.sequence, minutes },
          dueAt,
          value.startsAt,
        );
      }
    }
  }
  private cancelJobs(value: Meeting, recipientId?: string): void {
    const rows = this.jobs.db
      .prepare(
        "SELECT id,payload,type FROM jobs WHERE guild_id=? AND object_id=? AND generation=? AND state IN ('pending','retry','running','unknown')",
      )
      .all(this.guildId, value.id, value.generation);
    for (const row of rows) {
      if (recipientId) {
        const payload = JSON.parse(String(row.payload));
        if (payload.recipientId !== recipientId) continue;
      }
      this.jobs.cancel(String(row.id));
    }
  }
  private insertParticipant(
    value: Meeting,
    userId: string,
    state: "confirmed" | "waitlisted",
  ): MeetingParticipant {
    const sequence = Number(this.row(value.id).next_sequence),
      now = this.now();
    this.jobs.db
      .prepare("UPDATE meetings SET next_sequence=next_sequence+1 WHERE id=?")
      .run(value.id);
    this.jobs.db
      .prepare(
        `INSERT INTO meeting_participants VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT(meeting_id,user_id) DO UPDATE SET state=excluded.state,sequence=excluded.sequence,
      joined_at=excluded.joined_at,updated_at=excluded.updated_at,left_reason=NULL`,
      )
      .run(value.id, userId, state, sequence, now, now);
    return this.roster(value.id).find((entry) => entry.userId === userId)!;
  }
  private async eligibility(value: Meeting, spaces: number): Promise<Eligibility> {
    const result: Eligibility = new Map();
    if (spaces <= 0 || value.state !== "open" || value.endsAt <= this.now()) return result;
    for (const person of this.roster(value.id).filter((entry) => entry.state === "waitlisted")) {
      const eligible = await this.options.eligible(person.userId, value);
      if (typeof eligible !== "boolean") throw new MeetingError("invalid_input");
      result.set(person.userId, eligible);
      if (eligible && --spaces <= 0) break;
    }
    return result;
  }
  private promote(value: Meeting, eligibility: Eligibility): void {
    if (value.state !== "open" || value.endsAt <= this.now()) return;
    let spaces = value.capacity - this.read(value.id).confirmedCount;
    for (const person of this.roster(value.id).filter((entry) => entry.state === "waitlisted")) {
      if (spaces <= 0) break;
      if (!eligibility.has(person.userId)) throw new MeetingError("revision_conflict");
      if (!eligibility.get(person.userId)) {
        this.jobs.db
          .prepare(
            "UPDATE meeting_participants SET state='left',left_reason='ineligible',updated_at=? WHERE meeting_id=? AND user_id=?",
          )
          .run(this.now(), value.id, person.userId);
        this.cancelJobs(value, person.userId);
        continue;
      }
      this.jobs.db
        .prepare(
          "UPDATE meeting_participants SET state='confirmed',updated_at=? WHERE meeting_id=? AND user_id=?",
        )
        .run(this.now(), value.id, person.userId);
      spaces--;
      this.enqueue("meeting.promoted", value, `${person.userId}:${person.sequence}`, {
        recipientId: person.userId,
        sequence: person.sequence,
      });
      this.reminders(value, { ...person, state: "confirmed" });
    }
  }

  async create(actorId: string, requestId: string, input: MeetingDraft): Promise<MeetingMutation> {
    const value = definition(input);
    await this.allowed(actorId, "create", undefined, value);
    return this.mutate(`meeting:create:${this.guildId}:${actorId}`, key(requestId), value, () => {
      if (value.startsAt < this.now() - meetingNowGraceMs || value.endsAt <= this.now())
        throw new MeetingError("invalid_input");
      const count = this.jobs.db
        .prepare(
          "SELECT COUNT(*) AS count FROM meetings WHERE guild_id=? AND state IN ('draft','open','starting','active')",
        )
        .get(this.guildId)!;
      if (Number(count.count) >= this.maxMeetings) throw new MeetingError("limit_exceeded");
      const meetingId = randomUUID(),
        now = this.now();
      this.jobs.db
        .prepare(
          `INSERT INTO meetings
        (id,guild_id,creator_id,organizer_id,title,description,capacity,starts_at,ends_at,channel_id,visibility,allowed_role_ids,
        organizer_participates,room,reminder_minutes,state,room_channel_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          meetingId,
          this.guildId,
          actorId,
          actorId,
          value.title,
          value.description,
          value.capacity,
          value.startsAt,
          value.endsAt,
          value.channelId,
          value.visibility,
          JSON.stringify(value.allowedRoleIds),
          Number(value.organizerParticipates),
          JSON.stringify(value.room),
          JSON.stringify(value.reminderMinutes),
          value.state,
          value.room.kind === "existing" ? value.room.channelId : null,
          now,
          now,
        );
      this.replaceInvites(meetingId, value.invitedUserIds);
      let created = this.read(meetingId);
      if (value.organizerParticipates) {
        this.insertParticipant(created, actorId, "confirmed");
        created = this.changed(meetingId);
      }
      this.publish(created);
      this.reminders(created);
      this.audit(meetingId, actorId, "create");
      return this.response(meetingId);
    });
  }
  async get(actorId: string, meetingId: string): Promise<MeetingDetail> {
    const value = this.read(meetingId);
    await this.allowed(actorId, "read", value);
    return this.jobs.transaction(() => {
      this.checkSnapshot(value, true);
      return this.detail(meetingId);
    });
  }
  async list(actorId: string): Promise<Meeting[]> {
    await this.allowed(actorId, "list");
    const rows = this.jobs.db
        .prepare("SELECT id FROM meetings WHERE guild_id=? ORDER BY starts_at,id LIMIT 500")
        .all(this.guildId),
      result: Meeting[] = [];
    for (const row of rows) {
      const value = this.read(String(row.id));
      try {
        await this.allowed(actorId, "read", value);
        this.checkSnapshot(value, true);
        result.push(value);
      } catch (error) {
        if (!forbidden(error)) throw error;
      }
    }
    return result;
  }
  async join(actorId: string, requestId: string, meetingId: string): Promise<MeetingMutation> {
    const snapshot = this.read(meetingId);
    await this.allowed(actorId, "join", snapshot);
    return this.mutate(
      `meeting:join:${this.guildId}:${actorId}`,
      key(requestId),
      { meetingId },
      () => {
        const value = this.checkSnapshot(snapshot);
        this.assertOpen(value);
        const existing = this.roster(meetingId).find((entry) => entry.userId === actorId);
        if (existing && existing.state !== "left") return this.response(meetingId);
        if (this.roster(meetingId).filter((entry) => entry.state !== "left").length >= 1000)
          throw new MeetingError("limit_exceeded");
        const person = this.insertParticipant(
          value,
          actorId,
          value.confirmedCount < value.capacity && !value.waitlistedCount
            ? "confirmed"
            : "waitlisted",
        );
        const current = this.changed(meetingId);
        this.publish(current);
        if (person.state === "confirmed") this.reminders(current, person);
        this.audit(meetingId, actorId, "join");
        return this.response(meetingId);
      },
    );
  }
  async leave(actorId: string, requestId: string, meetingId: string): Promise<MeetingMutation> {
    const snapshot = this.read(meetingId);
    await this.allowed(actorId, "leave", snapshot);
    const leaving = this.roster(meetingId).find((entry) => entry.userId === actorId);
    const eligibility = await this.eligibility(
      snapshot,
      snapshot.capacity - snapshot.confirmedCount + (leaving?.state === "confirmed" ? 1 : 0),
    );
    return this.mutate(
      `meeting:leave:${this.guildId}:${actorId}`,
      key(requestId),
      { meetingId },
      () => {
        const value = this.checkSnapshot(snapshot, true);
        const person = this.roster(meetingId).find((entry) => entry.userId === actorId);
        if (!person || person.state === "left") return this.response(meetingId);
        this.jobs.db
          .prepare(
            "UPDATE meeting_participants SET state='left',left_reason='left',updated_at=? WHERE meeting_id=? AND user_id=?",
          )
          .run(this.now(), meetingId, actorId);
        this.cancelJobs(value, actorId);
        this.promote(value, eligibility);
        this.publish(this.changed(meetingId));
        this.audit(meetingId, actorId, "leave");
        return this.response(meetingId);
      },
    );
  }
  async update(
    actorId: string,
    requestId: string,
    meetingId: string,
    revision: number,
    input: MeetingDraft,
  ): Promise<MeetingMutation> {
    const snapshot = this.read(meetingId),
      value = definition(
        { ...input, invitedUserIds: input.invitedUserIds ?? snapshot.invitedUserIds },
        snapshot.state === "draft" ? "draft" : "open",
      );
    await this.allowed(actorId, "update", snapshot, value);
    const eligibility = await this.audienceEligibility({
      ...snapshot,
      ...value,
      state: snapshot.state,
    });
    return this.mutate(
      `meeting:update:${this.guildId}:${actorId}`,
      key(requestId),
      { meetingId, revision, draft: value },
      () => {
        if (value.startsAt < this.now() - meetingNowGraceMs || value.endsAt <= this.now())
          throw new MeetingError("invalid_input");
        const current = this.checkSnapshot(snapshot, true);
        if (current.revision !== integer(revision, 1)) throw new MeetingError("revision_conflict");
        if (
          current.visibility === "public" &&
          value.visibility === "private" &&
          (current.messageId !== null ||
            this.jobs.db
              .prepare(
                "SELECT 1 FROM delivery_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.guild_id=? AND j.object_id=? AND j.type='meeting.publish' AND a.state IN ('sending','succeeded','unknown') LIMIT 1",
              )
              .get(this.guildId, meetingId))
        )
          throw new MeetingError("visibility_conflict");
        if (
          !["draft", "open"].includes(current.state) ||
          (current.state === "open" && value.state === "draft")
        )
          throw new MeetingError("state_conflict");
        const organizer = this.roster(meetingId).find(
          (entry) => entry.userId === current.organizerId,
        );
        const count =
          current.confirmedCount -
          (organizer?.state === "confirmed" && !value.organizerParticipates ? 1 : 0) +
          (value.organizerParticipates &&
          !current.organizerParticipates &&
          organizer?.state !== "confirmed"
            ? 1
            : 0);
        const ineligibleConfirmed = this.roster(meetingId).filter(
          (entry) =>
            entry.state === "confirmed" &&
            !eligibility.get(entry.userId) &&
            !(entry.userId === current.organizerId && !value.organizerParticipates),
        ).length;
        if (value.capacity < count - ineligibleConfirmed)
          throw new MeetingError("capacity_conflict");
        this.cancelJobs(current);
        if (value.channelId !== current.channelId) this.retireMessage(current);
        this.jobs.db
          .prepare(
            `UPDATE meetings SET title=?,description=?,capacity=?,starts_at=?,ends_at=?,channel_id=?,visibility=?,allowed_role_ids=?,organizer_participates=?,room=?,reminder_minutes=?,state=?,revision=revision+1,generation=generation+1,room_channel_id=?,room_created_by_bot=0,message_id=CASE WHEN channel_id<>? THEN NULL ELSE message_id END,updated_at=? WHERE id=?`,
          )
          .run(
            value.title,
            value.description,
            value.capacity,
            value.startsAt,
            value.endsAt,
            value.channelId,
            value.visibility,
            JSON.stringify(value.allowedRoleIds),
            Number(value.organizerParticipates),
            JSON.stringify(value.room),
            JSON.stringify(value.reminderMinutes),
            value.state,
            value.room.kind === "existing" ? value.room.channelId : null,
            value.channelId,
            this.now(),
            meetingId,
          );
        this.replaceInvites(meetingId, value.invitedUserIds);
        let next = this.read(meetingId);
        this.removeIneligible(next, eligibility);
        if (value.organizerParticipates !== current.organizerParticipates) {
          if (value.organizerParticipates)
            this.insertParticipant(next, current.organizerId, "confirmed");
          else
            this.jobs.db
              .prepare(
                "UPDATE meeting_participants SET state='left',left_reason='organizer_opt_out',updated_at=? WHERE meeting_id=? AND user_id=?",
              )
              .run(this.now(), meetingId, current.organizerId);
        }
        this.promote(next, eligibility);
        next = this.changed(meetingId);
        this.publish(next);
        this.reminders(next);
        this.audit(meetingId, actorId, "update");
        return this.response(meetingId);
      },
    );
  }
  async updateAudience(
    actorId: string,
    requestId: string,
    meetingId: string,
    revision: number,
    input: MeetingAudience,
  ): Promise<MeetingMutation> {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      !Array.isArray(input.invitedUserIds) ||
      !Array.isArray(input.allowedRoleIds) ||
      Object.keys(input).some((field) => !["invitedUserIds", "allowedRoleIds"].includes(field))
    )
      throw new MeetingError("invalid_input");
    const snapshot = this.read(meetingId),
      draft = definition({
        ...draftOf(snapshot),
        invitedUserIds: input.invitedUserIds,
        allowedRoleIds: input.allowedRoleIds,
      });
    const projected = {
      ...snapshot,
      invitedUserIds: draft.invitedUserIds,
      allowedRoleIds: draft.allowedRoleIds,
    };
    await this.allowed(actorId, "update", snapshot, draft);
    const eligibility = await this.audienceEligibility(projected);
    return this.mutate(
      `meeting:audience:${this.guildId}:${actorId}`,
      key(requestId),
      {
        meetingId,
        revision,
        audience: { invitedUserIds: draft.invitedUserIds, allowedRoleIds: draft.allowedRoleIds },
      },
      () => {
        const current = this.checkSnapshot(snapshot, true);
        if (current.revision !== integer(revision, 1)) throw new MeetingError("revision_conflict");
        if (!liveStates.has(current.state)) throw new MeetingError("state_conflict");
        this.replaceInvites(meetingId, draft.invitedUserIds);
        this.jobs.db
          .prepare(
            "UPDATE meetings SET allowed_role_ids=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(draft.allowedRoleIds), this.now(), meetingId);
        const next = this.read(meetingId);
        this.removeIneligible(next, eligibility);
        this.promote(next, eligibility);
        this.publish(this.changed(meetingId));
        this.audit(meetingId, actorId, "audience");
        return this.response(meetingId);
      },
    );
  }
  async transition(
    actorId: string,
    requestId: string,
    meetingId: string,
    revision: number,
    operation: "start" | "complete" | "cancel",
  ): Promise<MeetingMutation> {
    if (!["start", "complete", "cancel"].includes(operation))
      throw new MeetingError("invalid_input");
    const snapshot = this.read(meetingId);
    await this.allowed(actorId, operation, snapshot);
    return this.mutate(
      `meeting:${operation}:${this.guildId}:${actorId}`,
      key(requestId),
      { meetingId, revision },
      () => {
        const value = this.checkSnapshot(snapshot);
        if (value.revision !== integer(revision, 1)) throw new MeetingError("revision_conflict");
        if (
          (operation === "start" && value.state !== "open") ||
          (operation === "complete" && !["starting", "active"].includes(value.state)) ||
          (operation === "cancel" && !liveStates.has(value.state))
        )
          throw new MeetingError("state_conflict");
        if (operation === "start" && value.endsAt <= this.now()) throw new MeetingError("expired");
        this.cancelJobs(value);
        this.jobs.db
          .prepare(
            "UPDATE meetings SET state=?,revision=revision+1,generation=generation+1,updated_at=? WHERE id=?",
          )
          .run(
            operation === "start"
              ? "starting"
              : operation === "complete"
                ? "completed"
                : "cancelled",
            this.now(),
            meetingId,
          );
        const next = this.read(meetingId);
        if (operation === "start") this.enqueue("meeting.start", next, "start");
        else
          this.enqueue("meeting.finish", next, "finish", {}, this.now(), this.now() + 7 * 86400000);
        this.publish(next);
        this.audit(meetingId, actorId, operation);
        return this.response(meetingId);
      },
    );
  }
  // Only the trusted guild-member removal adapter calls this; it is not a member action.
  async memberRemoved(
    userId: string,
    requestId: string,
    joinedBefore = Number.MAX_SAFE_INTEGER,
    promote = true,
  ): Promise<MeetingMutation[]> {
    id(userId);
    integer(joinedBefore);
    const rows = this.jobs.db
      .prepare(
        `SELECT m.id FROM meetings m WHERE m.guild_id=? AND m.state IN ('draft','open','starting','active') AND (
          EXISTS(SELECT 1 FROM meeting_participants p WHERE p.meeting_id=m.id AND p.user_id=? AND p.state<>'left' AND p.joined_at<=?) OR
          EXISTS(SELECT 1 FROM meeting_invites i WHERE i.meeting_id=m.id AND i.user_id=? AND i.created_at<=?))`,
      )
      .all(this.guildId, userId, joinedBefore, userId, joinedBefore);
    const snapshots = rows.map((row) => this.read(String(row.id))),
      checks = new Map<string, Eligibility>();
    for (const value of snapshots) {
      const leaving = this.roster(value.id).find(
        (entry) => entry.userId === userId && entry.joinedAt <= joinedBefore,
      );
      checks.set(
        value.id,
        promote
          ? await this.eligibility(
              value,
              value.capacity - value.confirmedCount + (leaving?.state === "confirmed" ? 1 : 0),
            )
          : new Map(),
      );
    }
    const affected = this.jobs.idempotent(
      `meeting:member-removed:${this.guildId}:${userId}`,
      key(requestId),
      { userId, joinedBefore },
      () => {
        for (const value of snapshots) this.checkSnapshot(value, true);
        return snapshots.map((value) => {
          this.jobs.db
            .prepare(
              "UPDATE meeting_participants SET state='left',left_reason='member_removed',updated_at=? WHERE meeting_id=? AND user_id=? AND joined_at<=?",
            )
            .run(this.now(), value.id, userId, joinedBefore);
          const revoked = this.jobs.db
            .prepare(
              "DELETE FROM meeting_invites WHERE meeting_id=? AND user_id=? AND created_at<=?",
            )
            .run(value.id, userId, joinedBefore);
          if (revoked.changes)
            this.jobs.db
              .prepare("UPDATE meetings SET revision=revision+1 WHERE id=?")
              .run(value.id);
          if (
            !this.roster(value.id).some(
              (entry) => entry.userId === userId && entry.state !== "left",
            )
          )
            this.cancelJobs(value, userId);
          if (promote) this.promote(this.read(value.id), checks.get(value.id)!);
          const next = this.changed(value.id);
          if (promote) this.publish(next);
          this.audit(value.id, userId, "member_removed");
          return value.id;
        });
      },
    );
    return affected.map((meetingId) => this.response(meetingId));
  }
  // Trusted reconciliation, never exposed as an unauthenticated member operation.
  async reconcileParticipants(
    meetingId: string,
    requestId: string,
    beforeCommit?: () => void,
  ): Promise<MeetingMutation> {
    const snapshot = this.read(meetingId),
      eligibility = await this.audienceEligibility(snapshot);
    return this.mutate(`meeting:reconcile:${this.guildId}`, key(requestId), { meetingId }, () => {
      beforeCommit?.();
      const current = this.checkSnapshot(snapshot, true);
      if (!liveStates.has(current.state)) return this.response(meetingId);
      const before = canonical(this.roster(meetingId));
      this.removeIneligible(current, eligibility);
      this.promote(this.read(meetingId), eligibility);
      if (before !== canonical(this.roster(meetingId))) {
        this.publish(this.changed(meetingId));
        this.audit(meetingId, current.organizerId, "reconcile");
      }
      return this.response(meetingId);
    });
  }
  private job(queued: Job): { job: Job; meeting: Meeting; payload: Row } {
    const persisted = this.jobs.get(queued.id);
    if (
      !persisted ||
      persisted.guildId !== this.guildId ||
      !jobTypes.has(persisted.type as MeetingJobType) ||
      persisted.state !== "running" ||
      persisted.leaseToken !== queued.leaseToken ||
      persisted.leaseUntil === null ||
      persisted.leaseUntil <= this.now() ||
      persisted.cancelRequested
    )
      throw new MeetingError("stale_job");
    const payload = persisted.payload as Row;
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.meetingId !== "string" ||
      persisted.objectId !== payload.meetingId
    )
      throw new MeetingError("invalid_input");
    const meeting = this.read(payload.meetingId);
    if (persisted.generation !== meeting.generation || payload.generation !== meeting.generation)
      throw new MeetingError("stale_generation");
    return { job: persisted, meeting, payload };
  }
  async prepare(queued: Job): Promise<PreparedMeetingJob> {
    const before = this.job(queued);
    await this.allowed(
      before.meeting.organizerId,
      "deliver",
      before.meeting,
      undefined,
      before.job.type as MeetingJobType,
    );
    if (["meeting.reminder", "meeting.promoted"].includes(before.job.type)) {
      if (!(await this.options.eligible(id(before.payload.recipientId), before.meeting)))
        throw new MeetingError("forbidden");
    }
    const { job, meeting, payload } = this.job(queued);
    if (
      meeting.revision !== before.meeting.revision ||
      meeting.participantVersion !== before.meeting.participantVersion
    )
      throw new MeetingError("revision_conflict");
    if (
      job.type !== "meeting.finish" &&
      liveStates.has(meeting.state) &&
      meeting.endsAt <= this.now()
    )
      throw new MeetingError("expired");
    if (
      job.type === "meeting.publish" &&
      (meeting.state === "draft" || payload.participantVersion !== meeting.participantVersion)
    )
      throw new MeetingError("stale_generation");
    if (job.type === "meeting.start" && meeting.state !== "starting")
      throw new MeetingError("state_conflict");
    if (job.type === "meeting.finish" && !["completed", "cancelled"].includes(meeting.state))
      throw new MeetingError("state_conflict");
    if (["meeting.reminder", "meeting.promoted"].includes(job.type)) {
      const person = this.roster(meeting.id).find((entry) => entry.userId === payload.recipientId);
      if (
        meeting.state !== "open" ||
        !person ||
        person.state !== "confirmed" ||
        person.sequence !== payload.sequence ||
        (job.type === "meeting.reminder" && this.now() >= meeting.startsAt)
      )
        throw new MeetingError("state_conflict");
    }
    return {
      ...this.detail(meeting.id),
      type: job.type as MeetingJobType,
      recipientId: typeof payload.recipientId === "string" ? payload.recipientId : null,
      room: meeting.room,
      cleanupRoom:
        job.type === "meeting.finish" && meeting.roomCreatedByBot && meeting.roomChannelId
          ? { channelId: meeting.roomChannelId, createdByBot: true, requireNoHumans: true }
          : null,
    };
  }
  recordResult(queued: Job, result: MeetingEffectResult): MeetingDetail {
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).some(
        (field) =>
          !["messageId", "roomChannelId", "roomCreatedByBot", "guildScheduledEventId"].includes(
            field,
          ),
      )
    )
      throw new MeetingError("invalid_input");
    for (const field of [result.messageId, result.roomChannelId, result.guildScheduledEventId])
      if (field !== undefined) id(field);
    if (result.roomCreatedByBot !== undefined && typeof result.roomCreatedByBot !== "boolean")
      throw new MeetingError("invalid_input");
    if (result.roomCreatedByBot && !result.roomChannelId) throw new MeetingError("invalid_input");
    return this.jobs.transaction(() => {
      const receipt = this.jobs.db
        .prepare("SELECT * FROM meeting_effect_receipts WHERE job_id=?")
        .get(key(queued.id));
      if (receipt) {
        if (canonical(JSON.parse(String(receipt.result))) !== canonical(result))
          throw new MeetingError("state_conflict");
        return this.detail(String(receipt.meeting_id));
      }
      const { job, meeting } = this.job(queued);
      if (
        job.type !== "meeting.publish" &&
        (result.messageId !== undefined || result.guildScheduledEventId !== undefined)
      )
        throw new MeetingError("invalid_input");
      if (job.type === "meeting.start" && meeting.state !== "starting")
        throw new MeetingError("state_conflict");
      if (
        job.type !== "meeting.start" &&
        (result.roomChannelId !== undefined || result.roomCreatedByBot !== undefined)
      )
        throw new MeetingError("invalid_input");
      if (
        job.type === "meeting.start" &&
        meeting.room.kind === "create" &&
        (!result.roomChannelId || result.roomCreatedByBot !== true)
      )
        throw new MeetingError("invalid_input");
      if (
        job.type === "meeting.start" &&
        meeting.room.kind === "none" &&
        (result.roomChannelId !== undefined || result.roomCreatedByBot !== undefined)
      )
        throw new MeetingError("invalid_input");
      if (
        job.type === "meeting.start" &&
        meeting.room.kind === "existing" &&
        (result.roomCreatedByBot === true ||
          (result.roomChannelId !== undefined && result.roomChannelId !== meeting.room.channelId))
      )
        throw new MeetingError("invalid_input");
      this.jobs.db
        .prepare(
          `UPDATE meetings SET message_id=COALESCE(?,message_id),room_channel_id=COALESCE(?,room_channel_id),room_created_by_bot=COALESCE(?,room_created_by_bot),guild_scheduled_event_id=COALESCE(?,guild_scheduled_event_id),state=?,revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(
          result.messageId ?? null,
          result.roomChannelId ?? null,
          result.roomCreatedByBot === undefined ? null : Number(result.roomCreatedByBot),
          result.guildScheduledEventId ?? null,
          job.type === "meeting.start" ? "active" : meeting.state,
          this.now(),
          meeting.id,
        );
      this.jobs.db
        .prepare("INSERT INTO meeting_effect_receipts VALUES (?,?,?,?)")
        .run(job.id, meeting.id, canonical(result), this.now());
      const next = this.read(meeting.id);
      if (job.type === "meeting.start") this.publish(next);
      return this.detail(meeting.id);
    });
  }
}
