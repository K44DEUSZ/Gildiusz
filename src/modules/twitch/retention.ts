import type { DatabaseSync } from "node:sqlite";
import type { JobStore } from "../../core/jobs/store.js";
import { transaction } from "../../storage/migrations.js";

export const twitchHistoryRetentionMs = 30 * 86400000;
const terminal = new Set(["succeeded", "failed", "cancelled", "expired"]);
type Row = Record<string, unknown>;
interface RetentionOptions {
  resolveJobStore(guildId: string): JobStore | undefined;
  clock?: () => number;
}
export interface TwitchHistoryRetentionResult {
  scanned: number;
  inboxMinimized: number;
  fanoutMinimized: number;
  deferredFanout: number;
}

/** Local history minimization; unique event/stream fences and exact webhook replies remain. */
export class TwitchHistoryRetention {
  private inboxCursor = "";
  private fanoutCursor = "";
  private first: "inbox" | "fanout" = "inbox";
  constructor(
    readonly db: DatabaseSync,
    private readonly options: RetentionOptions,
  ) {
    db.exec("PRAGMA secure_delete=ON");
  }

  prune(limit = 100): TwitchHistoryRetentionResult {
    const now = (this.options.clock ?? Date.now)();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid Twitch history retention bounds.");
    const cutoff = now - twitchHistoryRetentionMs,
      firstBudget = Math.ceil(limit / 2),
      secondBudget = Math.floor(limit / 2),
      inboxBudget = this.first === "inbox" ? firstBudget : secondBudget,
      fanoutBudget = this.first === "fanout" ? firstBudget : secondBudget;
    let inboxCursor = this.inboxCursor,
      fanoutCursor = this.fanoutCursor;
    const result = transaction(this.db, () => {
      const result: TwitchHistoryRetentionResult = {
        scanned: 0,
        inboxMinimized: 0,
        fanoutMinimized: 0,
        deferredFanout: 0,
      };
      if (inboxBudget) {
        const rows = this.db
          .prepare(
            `SELECT id,state,received_at,(envelope!='{}' OR last_error IS NOT NULL) AS has_history
           FROM twitch_inbox WHERE id>? ORDER BY id LIMIT ?`,
          )
          .all(inboxCursor, inboxBudget);
        // Scan the primary key, including minimized/ineligible rows, so they cannot starve later work.
        inboxCursor = rows.length === inboxBudget ? String(rows.at(-1)!.id) : "";
        result.scanned += rows.length;
        for (const row of rows) {
          if (
            !row.has_history ||
            !["done", "ignored"].includes(String(row.state)) ||
            !this.old(row.received_at, cutoff)
          )
            continue;
          const changed = this.db
            .prepare(
              "UPDATE twitch_inbox SET envelope='{}',last_error=NULL WHERE id=? AND state IN ('done','ignored') AND received_at=?",
            )
            .run(String(row.id), Number(row.received_at));
          result.inboxMinimized += Number(changed.changes);
        }
      }
      if (fanoutBudget) {
        const rows = this.db
          .prepare(
            `SELECT f.id,f.binding_id,f.state,f.job_id,f.updated_at,
             (f.job!='{}' OR f.reason IS NOT NULL) AS has_history,b.guild_id
           FROM twitch_fanout f LEFT JOIN twitch_bindings b ON b.id=f.binding_id
           WHERE f.id>? ORDER BY f.id LIMIT ?`,
          )
          .all(fanoutCursor, fanoutBudget);
        fanoutCursor = rows.length === fanoutBudget ? String(rows.at(-1)!.id) : "";
        result.scanned += rows.length;
        for (const row of rows) {
          if (
            !row.has_history ||
            !["queued", "skipped"].includes(String(row.state)) ||
            !this.old(row.updated_at, cutoff)
          )
            continue;
          if (row.state === "queued" && !this.finished(row, cutoff)) {
            result.deferredFanout++;
            continue;
          }
          // Dispatcher only uses the frozen enqueue input while state=pending.
          const changed = this.db
            .prepare(
              "UPDATE twitch_fanout SET job='{}',reason=NULL WHERE id=? AND state=? AND updated_at=?",
            )
            .run(String(row.id), String(row.state), Number(row.updated_at));
          result.fanoutMinimized += Number(changed.changes);
        }
      }
      return result;
    });
    this.inboxCursor = inboxCursor;
    this.fanoutCursor = fanoutCursor;
    this.first = this.first === "inbox" ? "fanout" : "inbox";
    return result;
  }

  private old(value: unknown, cutoff: number): boolean {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= cutoff;
  }
  private finished(row: Row, cutoff: number): boolean {
    if (typeof row.guild_id !== "string" || typeof row.job_id !== "string") return false;
    try {
      const job = this.options.resolveJobStore(row.guild_id)?.get(row.job_id);
      return Boolean(
        job &&
        job.guildId === row.guild_id &&
        job.objectId === row.binding_id &&
        job.type === "twitch.send" &&
        terminal.has(job.state) &&
        this.old(job.updatedAt, cutoff),
      );
    } catch {
      // A closed/unavailable guild store provides no evidence that delivery has finished.
      return false;
    }
  }
}
