import { createHash } from "node:crypto";
import { Routes, type REST } from "discord.js";
import type { CommunityRuntime } from "./community-runtime.js";
import { discordErrorCode } from "./module-permissions.js";
import { MeetingError } from "../modules/meetings/service.js";

// Individual REST lookups also reconcile departures missed during a Gateway outage.
// joinedTimestamp distinguishes a new guild membership from an old reservation.
export class MeetingMembership {
  private cursor = "";
  private nextAt = 0;
  private sweeping = false;
  private readonly active = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();

  constructor(
    private readonly runtime: CommunityRuntime,
    private readonly rest: Pick<REST, "get">,
    private readonly clock = Date.now,
  ) {}

  check(userId: string): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    const pending = this.active.get(userId);
    if (pending) return pending;
    const task = this.reconcile(userId)
      .catch((error) => {
        if (!this.controller.signal.aborted) throw error;
      })
      .finally(() => this.active.delete(userId));
    this.active.set(userId, task);
    return task;
  }

  private async reconcile(userId: string): Promise<void> {
    if (!this.runtime.effectsReady) return;
    const observedAt = this.clock();
    let cutoff: number;
    try {
      const member = (await this.rest.get(
        Routes.guildMember(this.runtime.context.guild.id, userId),
        {
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        },
      )) as { user?: { id?: string }; joined_at?: string | null };
      if (member?.user?.id !== userId) throw Error("membership_unconfirmed");
      const joinedAt = typeof member.joined_at === "string" ? Date.parse(member.joined_at) : NaN;
      if (!Number.isSafeInteger(joinedAt) || joinedAt <= 0) return;
      cutoff = joinedAt - 1;
    } catch (error) {
      if (discordErrorCode(error) !== 10007) throw error;
      cutoff = observedAt;
    }
    if (this.controller.signal.aborted) return;
    const key = "membership_" + createHash("sha256").update(`${userId}:${cutoff}`).digest("hex");
    // A concurrent join/leave can change the roster while waitlist eligibility is read.
    // Re-read once; the cutoff never removes a later reservation after a rejoin.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.runtime.memberRemoved(userId, key, cutoff);
        if (!this.controller.signal.aborted) this.runtime.memberUpdated(userId);
        return;
      } catch (error) {
        if (!(error instanceof MeetingError && error.code === "revision_conflict") || attempt)
          throw error;
      }
    }
  }

  async sweep(): Promise<void> {
    if (
      !this.runtime.effectsReady ||
      this.controller.signal.aborted ||
      this.sweeping ||
      this.clock() < this.nextAt
    )
      return;
    this.sweeping = true;
    this.nextAt = this.clock() + 60000;
    try {
      const rows = this.runtime.jobs.db
        .prepare(
          `SELECT DISTINCT p.user_id FROM meeting_participants p JOIN meetings m ON m.id=p.meeting_id
         WHERE m.guild_id=? AND m.state IN ('draft','open','starting','active')
         AND p.state<>'left' AND p.user_id>? ORDER BY p.user_id LIMIT 10`,
        )
        .all(this.runtime.context.guild.id, this.cursor);
      for (const row of rows) {
        if (this.controller.signal.aborted) break;
        const userId = String(row.user_id);
        await this.check(userId);
        this.cursor = userId;
      }
      if (rows.length < 10) this.cursor = "";
    } finally {
      this.sweeping = false;
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.active.values()]);
  }
  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.active.values()]);
  }
}
