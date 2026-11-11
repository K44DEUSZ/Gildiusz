import type { JobStore } from "../../core/jobs/store.js";
import {
  deliveryAttemptsFingerprint,
  readManualDeliveryResolution,
} from "../../core/jobs/manual-delivery.js";
import type { DeliveryAttempt, Job, ManualDeliveryResolution } from "../../core/jobs/types.js";
import type {
  AnnouncementDeliveryDecision,
  AnnouncementDeliveryInspection,
} from "../../contracts/modules.js";
import { digest } from "../../shared/utils.js";
import { AnnouncementError } from "./types.js";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const snowflake = /^[0-9]{17,20}$/;
const hash = /^[a-f0-9]{64}$/;
const need = (value: unknown, code: ConstructorParameters<typeof AnnouncementError>[0]) => {
  if (!value) throw new AnnouncementError(code);
};
export interface InspectedDeliveryMessage {
  id: string;
  channelId: string;
  authorId: string;
  webhook: boolean;
  content: string;
  createdAt: number;
  fingerprint: string;
}
interface Options {
  guildId: string;
  botId: string;
  clock?: () => number;
  authorize(actorId: string, channels: readonly string[]): Promise<void>;
  fetchMessage(channelId: string, messageId: string): Promise<InspectedDeliveryMessage>;
  audit(jobId: string, resolution: ManualDeliveryResolution): void;
}
interface ResolutionReceipt {
  resolved: true;
  announcementId: string;
  jobId: string;
  confirmedAttempts: number;
  closedAttempts: number;
}

function decision(input: unknown, apply: boolean): AnnouncementDeliveryDecision {
  need(input && typeof input === "object" && !Array.isArray(input), "invalid_input");
  const value = input as Record<string, unknown>;
  need(
    !Object.keys(value).some(
      (key) =>
        ![
          "jobId",
          "jobRevision",
          "announcementRevision",
          "attemptIds",
          "attemptsFingerprint",
          "decisions",
          ...(apply ? ["confirmed"] : []),
        ].includes(key),
    ),
    "invalid_input",
  );
  need(
    typeof value.jobId === "string" &&
      uuid.test(value.jobId) &&
      [value.jobRevision, value.announcementRevision].every(
        (v) => Number.isSafeInteger(v) && Number(v) > 0,
      ) &&
      Array.isArray(value.attemptIds) &&
      value.attemptIds.length > 0 &&
      value.attemptIds.length <= 100 &&
      value.attemptIds.every((v) => typeof v === "string" && uuid.test(v)) &&
      new Set(value.attemptIds).size === value.attemptIds.length &&
      typeof value.attemptsFingerprint === "string" &&
      hash.test(value.attemptsFingerprint) &&
      Array.isArray(value.decisions) &&
      value.decisions.length > 0 &&
      value.decisions.length <= 100 &&
      (!apply || value.confirmed === true),
    "invalid_input",
  );
  const seen = new Set<string>();
  for (const candidate of value.decisions as unknown[]) {
    need(candidate && typeof candidate === "object" && !Array.isArray(candidate), "invalid_input");
    const item = candidate as Record<string, unknown>;
    need(
      !Object.keys(item).some(
        (key) => !["attemptId", "decision", "messageUrl", "messageFingerprint"].includes(key),
      ) &&
        typeof item.attemptId === "string" &&
        (value.attemptIds as string[]).includes(item.attemptId) &&
        !seen.has(String(item.attemptId)) &&
        ["human_confirmed_message", "closed_unconfirmed"].includes(String(item.decision)),
      "invalid_input",
    );
    seen.add(String(item.attemptId));
    if (item.decision === "human_confirmed_message") {
      need(
        typeof item.messageUrl === "string" &&
          item.messageUrl.length < 200 &&
          (item.messageFingerprint === undefined
            ? !apply
            : typeof item.messageFingerprint === "string" && hash.test(item.messageFingerprint)),
        "invalid_input",
      );
    } else
      need(item.messageUrl === undefined && item.messageFingerprint === undefined, "invalid_input");
  }
  const normalized = { ...value };
  delete normalized.confirmed;
  return structuredClone(normalized) as unknown as AnnouncementDeliveryDecision;
}

/** Human decisions end automatic work; they never manufacture a transport ACK. */
export class AnnouncementDeliveryResolution {
  private readonly clock: () => number;
  private receiptCursor = "";
  constructor(
    private readonly jobs: JobStore,
    private readonly options: Options,
  ) {
    this.clock = options.clock ?? Date.now;
  }

  private target(announcementId: string, jobId: string) {
    const announcement = this.jobs.db
      .prepare(
        "SELECT id,revision,status FROM announcements WHERE id=? AND guild_id=? AND removed_at IS NULL",
      )
      .get(announcementId, this.options.guildId);
    const job = this.jobs.get(jobId);
    need(
      announcement &&
        job &&
        job.guildId === this.options.guildId &&
        job.type === "announcement.send" &&
        job.objectId === announcementId &&
        !this.jobs.isHistoryRetired(jobId),
      "not_found",
    );
    return { announcement: announcement!, job: job!, attempts: this.jobs.attempts(jobId) };
  }

  private current(announcementId: string, input: AnnouncementDeliveryDecision) {
    const target = this.target(announcementId, input.jobId);
    need(
      target.job.revision === input.jobRevision &&
        target.announcement.revision === input.announcementRevision &&
        target.attempts.map((entry) => entry.id).join(",") === input.attemptIds.join(",") &&
        deliveryAttemptsFingerprint(target.attempts) === input.attemptsFingerprint,
      "revision_conflict",
    );
    need(target.job.state === "unknown", "state_conflict");
    need(!readManualDeliveryResolution(target.job.result), "already_resolved");
    const ambiguous = target.attempts.filter((entry) =>
      ["sending", "unknown"].includes(entry.state),
    );
    need(
      ambiguous.length === input.decisions.length &&
        ambiguous.every((entry) => input.decisions.some((item) => item.attemptId === entry.id)),
      "state_conflict",
    );
    return target;
  }

  private channels(attempts: readonly DeliveryAttempt[]) {
    const channels = [
      ...new Set(attempts.map((entry) => entry.channelId).filter((id) => id !== null)),
    ];
    need(channels.length > 0 && channels.every((id) => snowflake.test(id)), "channel_unavailable");
    return channels;
  }

  private async inspect(
    actorId: string,
    announcementId: string,
    input: AnnouncementDeliveryDecision,
  ) {
    await this.options.authorize(actorId, []);
    const target = this.current(announcementId, input);
    const channels = this.channels(target.attempts);
    await this.options.authorize(actorId, channels);
    const messages: AnnouncementDeliveryInspection["messages"] = [];
    const decisions = structuredClone(input.decisions);
    for (const item of decisions) {
      if (item.decision !== "human_confirmed_message") continue;
      const match =
        /^https:\/\/discord\.com\/channels\/([0-9]{17,20})\/([0-9]{17,20})\/([0-9]{17,20})$/.exec(
          item.messageUrl!,
        );
      const attempt = target.attempts.find((entry) => entry.id === item.attemptId);
      need(
        match &&
          match[1] === this.options.guildId &&
          attempt?.channelId === match[2] &&
          ["unknown", "sending", "succeeded"].includes(attempt!.state),
        "invalid_input",
      );
      const message = await this.options.fetchMessage(match![2], match![3]);
      need(
        message.id === match![3] &&
          message.channelId === attempt!.channelId &&
          message.authorId === this.options.botId &&
          !message.webhook &&
          Number.isSafeInteger(message.createdAt) &&
          message.createdAt >= attempt!.startedAt - 5000 &&
          message.createdAt <= this.clock() + 5000 &&
          hash.test(message.fingerprint),
        "delivery_conflict",
      );
      need(!attempt!.messageId || attempt!.messageId === message.id, "delivery_conflict");
      if (item.messageFingerprint)
        need(item.messageFingerprint === message.fingerprint, "message_changed");
      item.messageFingerprint = message.fingerprint;
      messages.push({
        attemptId: item.attemptId,
        channelId: message.channelId,
        messageId: message.id,
        url: `https://discord.com/channels/${this.options.guildId}/${message.channelId}/${message.id}`,
        content: message.content.slice(0, 2000),
        createdAt: message.createdAt,
      });
    }
    // Network waits can outlive membership, channel access and the captured database revisions.
    await this.options.authorize(actorId, channels);
    this.current(announcementId, input);
    const response: AnnouncementDeliveryInspection = {
      format: 1,
      decision: { ...input, decisions },
      messages,
      hasMultipleAttempts:
        target.attempts.filter((entry) => ["sending", "unknown"].includes(entry.state)).length > 1,
    };
    return response;
  }

  async preview(actorId: string, announcementId: string, input: unknown) {
    return this.inspect(actorId, announcementId, decision(input, false));
  }

  async resolve(actorId: string, requestId: string, announcementId: string, input: unknown) {
    const value = decision(input, true);
    need(uuid.test(requestId), "invalid_input");
    await this.options.authorize(actorId, []);
    const retained = this.target(announcementId, value.jobId);
    await this.options.authorize(actorId, this.channels(retained.attempts));
    this.target(announcementId, value.jobId);
    const scope = `announcement:delivery:${this.options.guildId}`,
      command = { announcementId, actorId, decision: value },
      cached = this.jobs.readIdempotent<ResolutionReceipt>(scope, requestId, command);
    if (cached) return cached;
    const inspected = await this.inspect(actorId, announcementId, value);
    return this.jobs.idempotent<ResolutionReceipt>(scope, requestId, command, () => {
      const target = this.current(announcementId, value);
      need(
        !this.jobs.db
          .prepare(
            "SELECT 1 FROM jobs WHERE guild_id=? AND object_id=? AND state='running' AND id<>?",
          )
          .get(this.options.guildId, announcementId, value.jobId),
        "state_conflict",
      );
      const now = this.clock();
      const resolution: ManualDeliveryResolution = {
        format: 1,
        actorId,
        decidedAt: now,
        attemptIds: value.attemptIds,
        decisions: inspected.decision.decisions.map((item) => {
          const message = inspected.messages.find((entry) => entry.attemptId === item.attemptId);
          return {
            attemptId: item.attemptId,
            decision: item.decision,
            ...(message
              ? {
                  linkedMessage: {
                    channelId: message.channelId,
                    messageId: message.messageId,
                    checkedAt: now,
                    fingerprint: item.messageFingerprint!,
                  },
                }
              : {}),
          };
        }),
      };
      this.jobs.recordManualDeliveryResolution(
        value.jobId,
        value.jobRevision,
        value.attemptsFingerprint,
        resolution,
      );
      for (const job of this.jobs.db
        .prepare(
          "SELECT id FROM jobs WHERE guild_id=? AND object_id=? AND state IN ('pending','retry','running','unknown')",
        )
        .all(this.options.guildId, announcementId))
        this.jobs.cancel(String(job.id));
      this.jobs.db
        .prepare(
          "UPDATE announcements SET status=CASE WHEN status='cancelled' THEN status ELSE 'paused' END,generation=generation+1,revision=revision+1,updated_at=? WHERE id=? AND guild_id=?",
        )
        .run(now, announcementId, this.options.guildId);
      this.jobs.db
        .prepare("UPDATE schedules SET active_job_id=NULL,next_due_at=NULL WHERE announcement_id=?")
        .run(announcementId);
      const confirmedAttempts = value.decisions.filter(
        (item) => item.decision === "human_confirmed_message",
      ).length;
      this.count(
        target.job,
        confirmedAttempts > 0 ||
          target.attempts.some((entry) => entry.state === "succeeded" && entry.messageId),
      );
      this.options.audit(value.jobId, resolution);
      return {
        resolved: true,
        announcementId,
        jobId: value.jobId,
        confirmedAttempts,
        closedAttempts: value.decisions.length - confirmedAttempts,
      };
    });
  }

  private count(job: Job, delivered: boolean): boolean {
    const payload = job.payload as { test?: unknown; announcementId?: unknown } | null;
    const counted = delivered && payload?.test !== true && payload?.announcementId === job.objectId;
    const inserted = this.jobs.db
      .prepare("INSERT OR IGNORE INTO announcement_job_receipts VALUES (?,?,?,?)")
      .run(job.id, job.objectId, Number(counted), this.clock());
    const upgraded =
      counted && !Number(inserted.changes)
        ? this.jobs.db
            .prepare(
              "UPDATE announcement_job_receipts SET delivered=1 WHERE job_id=? AND delivered=0",
            )
            .run(job.id)
        : undefined;
    const changed = counted && Boolean(Number(inserted.changes) || Number(upgraded?.changes ?? 0));
    if (changed)
      this.jobs.db
        .prepare("UPDATE schedules SET published_count=published_count+1 WHERE announcement_id=?")
        .run(job.objectId!);
    return changed;
  }

  /** Fold factual late ACKs into counts even with outbound announcements disabled. */
  syncReceipts(): number {
    return this.jobs.transaction(() => {
      let changed = 0;
      const rows = this.jobs.db
        .prepare(
          `SELECT j.id FROM jobs j JOIN announcements a ON a.id=j.object_id
        WHERE j.guild_id=? AND j.type='announcement.send' AND j.state='unknown'
        AND a.removed_at IS NULL AND NOT EXISTS(SELECT 1 FROM job_history_retired h WHERE h.job_id=j.id)
        AND EXISTS(SELECT 1 FROM delivery_attempts d WHERE d.job_id=j.id AND d.state='succeeded' AND d.message_id IS NOT NULL)
        AND (NOT EXISTS(SELECT 1 FROM announcement_job_receipts r WHERE r.job_id=j.id AND r.delivered=1)
          OR json_extract(j.result,'$.manualDeliveryResolution.format') IS NULL)
        AND j.id>? ORDER BY j.id LIMIT 100`,
        )
        .all(this.options.guildId, this.receiptCursor);
      if (!rows.length) this.receiptCursor = "";
      for (const row of rows) {
        this.receiptCursor = String(row.id);
        const job = this.jobs.get(String(row.id))!;
        if (this.count(job, true)) {
          this.jobs.db
            .prepare("UPDATE announcements SET revision=revision+1,updated_at=? WHERE id=?")
            .run(this.clock(), job.objectId!);
          changed++;
        }
        if (!readManualDeliveryResolution(job.result)) {
          const attempts = this.jobs.attempts(job.id),
            confirmed = [
              ...new Set(
                attempts
                  .filter((entry) => entry.state === "succeeded" && entry.messageId)
                  .map((entry) => entry.messageId!),
              ),
            ];
          if (
            confirmed.length !== 1 ||
            attempts.some((entry) => ["sending", "unknown"].includes(entry.state))
          )
            continue;
          this.jobs.reconcile(job.id, job.revision, {
            outcome: "succeeded",
            messageId: confirmed[0],
          });
          changed++;
        }
      }
      return changed;
    });
  }
}

export function inspectedMessageFingerprint(value: unknown): string {
  return digest(value);
}
