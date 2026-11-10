import { randomUUID } from "node:crypto";
import type { Job, JobLease } from "../../core/jobs/types.js";
import type { JobStore } from "../../core/jobs/store.js";
import type { ExecutionOutcome } from "../../core/jobs/runner.js";
import { canonical, digest } from "../../shared/utils.js";
import { reactionEmojiKey, reactionEmojiValidation } from "../../contracts/emoji.js";
import {
  assertFresh,
  assertRulesMemberRead,
  assertRulesPreflight,
  rulesId,
  rulesInteger,
  rulesKey,
} from "./policy.js";
import { normalizeRulesDraft, rulesContentHash, rulesControlId, rulesParts } from "./content.js";
import { rulesRateLimit } from "./effects.js";
import { ServerRulesRetention } from "./retention.js";
import {
  RulesError,
  type RulesAcceptEvent,
  type RulesAcceptance,
  type RulesDraft,
  type RulesExecutionContext,
  type RulesMemberFacts,
  type RulesOptions,
  type RulesPart,
  type RulesPreflightFacts,
  type RulesSettings,
  type RulesVersion,
} from "./types.js";

export { RulesError } from "./types.js";
export type * from "./types.js";
type Row = Record<string, unknown>;
const grantLifetime = 600000;
const publicationLifetime = 86400000;

function acceptance(row: Row): RulesAcceptance {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    userId: String(row.user_id),
    joinedAt: Number(row.joined_at),
    versionId: String(row.version_id),
    roleId: String(row.role_id),
    acceptedAt: Number(row.accepted_at),
    source: row.source as RulesAcceptance["source"],
    grantState: row.grant_state as RulesAcceptance["grantState"],
    jobId: row.job_id === null ? null : String(row.job_id),
    confirmedAt: row.confirmed_at === null ? null : Number(row.confirmed_at),
    reason: row.reason === null ? null : String(row.reason),
  };
}
function increment(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) throw new RulesError("revision_conflict");
  return value + 1;
}

export class ServerRulesService {
  readonly guildId: string;
  private readonly botId: string;
  private readonly clock: () => number;
  private readonly maximumAge: number;
  constructor(
    readonly jobs: JobStore,
    private readonly options: RulesOptions,
  ) {
    this.guildId = rulesId(options.guildId);
    this.botId = rulesId(options.botId);
    this.clock = options.clock ?? Date.now;
    this.maximumAge = rulesInteger(options.maxFactAgeMs ?? 15000, 1);
    if (this.maximumAge > 60000) throw new RulesError("invalid_input");
    const identity = jobs.db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get();
    if (!identity || identity.guild !== this.guildId) throw new RulesError("permission_revoked");
  }
  private now(): number {
    return rulesInteger(this.clock());
  }
  /** Configuration reads are internal; adapters must authorize their public endpoint separately. */
  settings(): RulesSettings {
    const row = this.jobs.db
      .prepare("SELECT * FROM server_rules_settings WHERE guild_id=?")
      .get(this.guildId);
    return row
      ? {
          guildId: this.guildId,
          revision: Number(row.revision),
          generation: Number(row.generation),
          enabled: row.enabled === 1,
          draft: row.draft === null ? null : JSON.parse(String(row.draft)),
          activeVersionId: row.active_version_id === null ? null : String(row.active_version_id),
        }
      : {
          guildId: this.guildId,
          revision: 0,
          generation: 0,
          enabled: false,
          draft: null,
          activeVersionId: null,
        };
  }
  private version(versionId: string): RulesVersion {
    const row = this.jobs.db
      .prepare("SELECT * FROM server_rules_versions WHERE guild_id=? AND id=?")
      .get(this.guildId, rulesKey(versionId));
    if (!row) throw new RulesError("not_found");
    return {
      ...JSON.parse(String(row.body)),
      id: String(row.id),
      guildId: this.guildId,
      generation: Number(row.generation),
      contentHash: String(row.content_hash),
      state: row.state as RulesVersion["state"],
      createdAt: Number(row.created_at),
      createdBy: String(row.created_by),
    };
  }
  parts(versionId: string): RulesPart[] {
    this.version(versionId);
    return this.jobs.db
      .prepare(
        "SELECT * FROM server_rules_parts WHERE guild_id=? AND version_id=? ORDER BY part_index",
      )
      .all(this.guildId, versionId)
      .map((row) => ({
        versionId,
        index: Number(row.part_index),
        content: String(row.content),
        contentHash: String(row.content_hash),
        jobId: String(row.job_id),
        messageId: row.message_id === null ? null : String(row.message_id),
        state: row.state as RulesPart["state"],
        reactionJobId: row.reaction_job_id === null ? null : String(row.reaction_job_id),
        reactionState: row.reaction_state as RulesPart["reactionState"],
      }));
  }
  private async admin(userId: string): Promise<void> {
    const facts = await this.options.ports.administrator(rulesId(userId));
    assertFresh(facts.observedAt, this.now(), this.maximumAge);
    if (
      facts.guildId !== this.guildId ||
      facts.userId !== userId ||
      (facts.owner !== true && facts.manageGuild !== true) ||
      facts.pending !== false ||
      facts.timedOut !== false
    )
      throw new RulesError("permission_revoked");
  }
  async inspect(
    actorId: string,
  ): Promise<{ settings: RulesSettings; versions: (RulesVersion & { parts: RulesPart[] })[] }> {
    await this.admin(actorId);
    const versions = this.jobs.db
      .prepare(
        "SELECT id FROM server_rules_versions WHERE guild_id=? ORDER BY created_at DESC,id DESC LIMIT 25",
      )
      .all(this.guildId)
      .map((row) => ({ ...this.version(String(row.id)), parts: this.parts(String(row.id)) }));
    return { settings: this.settings(), versions };
  }
  async listAcceptances(
    actorId: string,
    options: { limit?: number; before?: { acceptedAt: number; id: string } } = {},
  ): Promise<RulesAcceptance[]> {
    await this.admin(actorId);
    const limit = rulesInteger(options.limit ?? 50, 1);
    if (limit > 100) throw new RulesError("invalid_input");
    const before = options.before;
    if (before) {
      rulesInteger(before.acceptedAt);
      rulesKey(before.id);
    }
    return (
      before
        ? this.jobs.db
            .prepare(
              "SELECT * FROM server_rules_acceptances a WHERE guild_id=? AND NOT EXISTS(SELECT 1 FROM server_rules_retired_acceptances r WHERE r.guild_id=a.guild_id AND r.id=a.id) AND (accepted_at<? OR (accepted_at=? AND id<?)) ORDER BY accepted_at DESC,id DESC LIMIT ?",
            )
            .all(this.guildId, before.acceptedAt, before.acceptedAt, before.id, limit)
        : this.jobs.db
            .prepare(
              "SELECT * FROM server_rules_acceptances a WHERE guild_id=? AND NOT EXISTS(SELECT 1 FROM server_rules_retired_acceptances r WHERE r.guild_id=a.guild_id AND r.id=a.id) ORDER BY accepted_at DESC,id DESC LIMIT ?",
            )
            .all(this.guildId, limit)
    ).map(acceptance);
  }
  private async preflight(draft: RulesDraft): Promise<RulesPreflightFacts> {
    const facts = await this.options.ports.preflight();
    assertRulesPreflight(this.guildId, draft, facts, this.now(), this.maximumAge, this.botId);
    return facts;
  }
  private async member(
    userId: string,
    facts: RulesPreflightFacts,
    draft: RulesDraft,
  ): Promise<RulesMemberFacts> {
    const member = await this.options.ports.member(rulesId(userId));
    assertFresh(facts.observedAt, this.now(), this.maximumAge);
    if (
      !member ||
      member.guildId !== this.guildId ||
      member.userId !== userId ||
      member.bot !== false ||
      member.timedOut !== false ||
      ![true, false, null].includes(member.pending)
    )
      throw new RulesError("member_unavailable");
    assertFresh(member.observedAt, this.now(), this.maximumAge);
    rulesInteger(member.joinedAt, 1);
    if (
      member.joinedAt > this.now() ||
      !Array.isArray(member.roleIds) ||
      new Set(member.roleIds).size !== member.roleIds.length
    )
      throw new RulesError("member_unavailable");
    member.roleIds.forEach(rulesId);
    if (member.pending === true || (facts.nativeScreening && member.pending !== false))
      throw new RulesError("native_pending");
    assertRulesMemberRead(draft, member, facts);
    return member;
  }
  private current(version: RulesVersion, active = false): RulesSettings {
    const settings = this.settings();
    if (!settings.enabled) throw new RulesError("disabled");
    if (
      settings.generation !== version.generation ||
      version.state === "retired" ||
      (active &&
        (settings.activeVersionId !== version.id || this.version(version.id).state !== "active"))
    )
      throw new RulesError("stale_generation");
    return settings;
  }
  private cancelEffects(): void {
    const rows = this.jobs.db
      .prepare(
        "SELECT id FROM jobs WHERE guild_id=? AND type LIKE 'server-rules.%' AND type<>'server-rules.retire-controls' AND state IN('pending','retry','running','unknown')",
      )
      .all(this.guildId);
    for (const row of rows) this.jobs.cancel(String(row.id));
    this.jobs.db
      .prepare(
        "UPDATE server_rules_acceptances SET grant_state='blocked',reason='generation_changed' WHERE guild_id=? AND grant_state='pending'",
      )
      .run(this.guildId);
  }
  private queueRetire(version: RulesVersion, messageId?: string, phase = "post"): void {
    this.jobs.enqueue({
      guildId: this.guildId,
      type: "server-rules.retire-controls",
      payload: { versionId: version.id, ...(messageId ? { messageId } : {}) },
      objectId: version.id,
      generation: version.generation,
      dueAt: version.createdAt,
      dedupeKey: `server-rules:retire:${this.guildId}:${version.id}${messageId ? ":" + messageId + ":" + phase : ""}`,
    });
  }
  private retire(versionId: string): void {
    const version = this.version(versionId);
    this.jobs.db
      .prepare("UPDATE server_rules_versions SET state='retired' WHERE guild_id=? AND id=?")
      .run(this.guildId, versionId);
    this.queueRetire(version);
  }
  async configure(
    actorId: string,
    requestId: string,
    expectedRevision: number,
    input: { enabled: boolean; draft: RulesDraft | null },
  ): Promise<RulesSettings> {
    rulesKey(requestId);
    rulesInteger(expectedRevision);
    if (
      !input ||
      typeof input.enabled !== "boolean" ||
      Object.keys(input).some((key) => !["enabled", "draft"].includes(key))
    )
      throw new RulesError("invalid_input");
    const draft = input.draft === null ? null : normalizeRulesDraft(input.draft);
    if (input.enabled && !draft) throw new RulesError("invalid_input");
    await this.admin(actorId);
    if (input.enabled) {
      await this.preflight(draft!);
      await this.admin(actorId);
    }
    this.jobs.idempotent(
      `server-rules:configure:${this.guildId}:${actorId}`,
      requestId,
      { expectedRevision, enabled: input.enabled, draft },
      () => {
        const before = this.settings();
        if (before.revision !== expectedRevision) throw new RulesError("revision_conflict");
        const generation =
          !input.enabled && before.enabled ? increment(before.generation) : before.generation;
        if (!input.enabled) {
          this.cancelEffects();
          for (const row of this.jobs.db
            .prepare("SELECT id FROM server_rules_versions WHERE guild_id=? AND state<>'retired'")
            .all(this.guildId))
            this.retire(String(row.id));
        }
        this.jobs.db
          .prepare(
            `INSERT INTO server_rules_settings VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,enabled=excluded.enabled,draft=excluded.draft,active_version_id=excluded.active_version_id`,
          )
          .run(
            this.guildId,
            increment(before.revision),
            generation,
            Number(input.enabled),
            draft === null ? null : canonical(draft),
            input.enabled ? before.activeVersionId : null,
          );
        return { saved: true };
      },
    );
    return this.settings();
  }
  async publish(
    actorId: string,
    requestId: string,
    expectedRevision: number,
  ): Promise<RulesVersion> {
    rulesKey(requestId);
    rulesInteger(expectedRevision);
    await this.admin(actorId);
    const initial = this.settings();
    if (!initial.enabled || !initial.draft) throw new RulesError("disabled");
    await this.preflight(initial.draft);
    await this.admin(actorId);
    const { versionId } = this.jobs.idempotent(
      `server-rules:publish:${this.guildId}:${actorId}`,
      requestId,
      { expectedRevision },
      () => {
        const before = this.settings();
        if (before.revision !== expectedRevision) throw new RulesError("revision_conflict");
        if (!before.enabled || !before.draft) throw new RulesError("disabled");
        const versionId = randomUUID(),
          generation = increment(before.generation),
          now = this.now();
        this.cancelEffects();
        for (const row of this.jobs.db
          .prepare("SELECT id FROM server_rules_versions WHERE guild_id=? AND state<>'retired'")
          .all(this.guildId))
          this.retire(String(row.id));
        this.jobs.db
          .prepare("INSERT INTO server_rules_versions VALUES(?,?,?,?,?,'publishing',?,?)")
          .run(
            this.guildId,
            versionId,
            generation,
            canonical(before.draft),
            rulesContentHash(before.draft),
            now,
            actorId,
          );
        const messages = rulesParts(before.draft);
        for (const [index, content] of messages.entries()) {
          const job = this.jobs.enqueue({
            guildId: this.guildId,
            type: "server-rules.publish-part",
            objectId: versionId,
            generation,
            payload: { versionId, index },
            dueAt: now,
            expiresAt: now + publicationLifetime,
            dedupeKey: `server-rules:publish:${this.guildId}:${versionId}:${index}`,
          });
          this.jobs.db
            .prepare("INSERT INTO server_rules_parts VALUES(?,?,?,?,?,?,NULL,'pending',NULL,?)")
            .run(
              this.guildId,
              versionId,
              index,
              content,
              digest(content),
              job.id,
              index === messages.length - 1 && before.draft.method === "reaction"
                ? "pending"
                : "not_required",
            );
        }
        this.jobs.db
          .prepare(
            "UPDATE server_rules_settings SET generation=?,revision=?,active_version_id=NULL WHERE guild_id=?",
          )
          .run(generation, increment(before.revision), this.guildId);
        return { versionId };
      },
    );
    return this.version(versionId);
  }
  private async verifyPart(version: RulesVersion, part: RulesPart, control = true): Promise<void> {
    if (!part.messageId) throw new RulesError("publication_not_ready");
    const message = await this.options.ports.message(version.channelId, part.messageId);
    const final = part.index === this.parts(version.id).length - 1;
    if (
      !message ||
      message.guildId !== this.guildId ||
      message.channelId !== version.channelId ||
      message.messageId !== part.messageId ||
      message.authorId !== this.botId ||
      message.webhookId !== null ||
      digest(message.content) !== part.contentHash ||
      (control &&
        final &&
        (version.method === "button"
          ? message.controlId !== rulesControlId(this.guildId, version.id)
          : !message.reactionEmoji ||
            reactionEmojiValidation(message.reactionEmoji) !== "valid" ||
            reactionEmojiKey(message.reactionEmoji) !== reactionEmojiKey(version.emoji!)))
    )
      throw new RulesError("publication_unavailable");
  }
  private async verifyPublication(version: RulesVersion, controls = true): Promise<void> {
    const parts = this.parts(version.id);
    // Published parts are immutable. Older publications keep their original message boundaries.
    const completeFormat = ([2, 1] as const).some((format) => {
      let expected: string[];
      try {
        expected = rulesParts(version, format);
      } catch (error) {
        if (error instanceof RulesError && error.code === "invalid_input") return false;
        throw error;
      }
      return (
        parts.length > 0 &&
        parts.length === expected.length &&
        parts.every(
          (part, index) =>
            part.index === index && part.content === expected[index] && part.state === "confirmed",
        )
      );
    });
    if (!completeFormat) throw new RulesError("publication_not_ready");
    for (const part of parts) await this.verifyPart(version, part, controls);
  }
  private findAcceptance(acceptanceId: string): RulesAcceptance {
    const row = this.jobs.db
      .prepare(
        "SELECT * FROM server_rules_acceptances a WHERE guild_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM server_rules_retired_acceptances r WHERE r.guild_id=a.guild_id AND r.id=a.id)",
      )
      .get(this.guildId, rulesKey(acceptanceId));
    if (!row) throw new RulesError("not_found");
    return acceptance(row);
  }
  private checkRevocation(member: RulesMemberFacts): void {
    const existing = this.jobs.db
      .prepare(
        "SELECT * FROM server_rules_memberships WHERE guild_id=? AND user_id=? AND joined_at=?",
      )
      .get(this.guildId, member.userId, member.joinedAt);
    if (existing?.left_at !== undefined && existing.left_at !== null)
      throw new RulesError("membership_changed");
    const grants = this.jobs.db
      .prepare(
        "SELECT role_id FROM server_rules_acceptances WHERE guild_id=? AND user_id=? AND joined_at=? AND grant_state IN('confirmed','already_present')",
      )
      .all(this.guildId, member.userId, member.joinedAt);
    if (
      existing?.revoked_at != null ||
      grants.some((row) => !member.roleIds.includes(String(row.role_id)))
    ) {
      this.jobs.transaction(() => {
        this.jobs.db
          .prepare(
            "UPDATE server_rules_memberships SET revoked_at=COALESCE(revoked_at,?) WHERE guild_id=? AND user_id=? AND joined_at=?",
          )
          .run(this.now(), this.guildId, member.userId, member.joinedAt);
        this.jobs.db
          .prepare(
            "UPDATE server_rules_acceptances SET grant_state='blocked',reason='role_revoked' WHERE guild_id=? AND user_id=? AND joined_at=?",
          )
          .run(this.guildId, member.userId, member.joinedAt);
      });
      throw new RulesError("role_revoked");
    }
  }
  private observeMembership(member: RulesMemberFacts): void {
    const older = this.jobs.db
      .prepare(
        "SELECT job_id FROM server_rules_acceptances WHERE guild_id=? AND user_id=? AND joined_at<>? AND grant_state IN('pending','sending','unknown')",
      )
      .all(this.guildId, member.userId, member.joinedAt);
    for (const row of older) if (row.job_id) this.jobs.cancel(String(row.job_id));
    this.jobs.db
      .prepare(
        "UPDATE server_rules_memberships SET left_at=COALESCE(left_at,?) WHERE guild_id=? AND user_id=? AND joined_at<>?",
      )
      .run(this.now(), this.guildId, member.userId, member.joinedAt);
    this.jobs.db
      .prepare(
        "UPDATE server_rules_acceptances SET grant_state='blocked',reason='membership_changed' WHERE guild_id=? AND user_id=? AND joined_at<>? AND grant_state='pending'",
      )
      .run(this.guildId, member.userId, member.joinedAt);
    this.jobs.db
      .prepare("INSERT OR IGNORE INTO server_rules_memberships VALUES(?,?,?,NULL,NULL,?)")
      .run(this.guildId, member.userId, member.joinedAt, member.observedAt);
  }
  async accept(userId: string, event: RulesAcceptEvent): Promise<RulesAcceptance> {
    rulesId(userId);
    if (
      !event ||
      event.guildId !== this.guildId ||
      !["button", "reaction", "reaction_reconcile"].includes(event.source)
    )
      throw new RulesError("invalid_input");
    const version = this.version(event.versionId);
    this.current(version, true);
    const parts = this.parts(version.id),
      final = parts.at(-1)!;
    if (event.channelId !== version.channelId || event.messageId !== final.messageId)
      throw new RulesError("publication_unavailable");
    if (
      event.source === "button"
        ? version.method !== "button" ||
          event.controlId !== rulesControlId(this.guildId, version.id)
        : version.method !== "reaction" ||
          !event.emoji ||
          reactionEmojiValidation(event.emoji) !== "valid" ||
          reactionEmojiKey(event.emoji) !== reactionEmojiKey(version.emoji!)
    )
      throw new RulesError("invalid_input");
    if (event.source === "reaction_reconcile" && event.reconciliationComplete !== true)
      throw new RulesError("invalid_input");
    if (event.source === "reaction_reconcile")
      assertFresh(rulesInteger(event.observedAt), this.now(), this.maximumAge);
    const facts = await this.preflight(version);
    const first = await this.member(userId, facts, version);
    await this.verifyPublication(version);
    const currentFacts = await this.preflight(version),
      member = await this.member(userId, currentFacts, version);
    if (member.joinedAt !== first.joinedAt) throw new RulesError("membership_changed");
    this.current(version, true);
    this.checkRevocation(member);
    const unresolved = this.jobs.db
      .prepare(
        "SELECT role_id FROM server_rules_acceptances WHERE guild_id=? AND user_id=? AND joined_at=? AND version_id<>? AND grant_state IN('sending','unknown')",
      )
      .all(this.guildId, userId, member.joinedAt, version.id);
    if (unresolved.some((row) => !member.roleIds.includes(String(row.role_id))))
      throw new RulesError("unknown_effect");
    const acceptanceId = this.jobs.transaction(() => {
      this.current(version, true);
      this.observeMembership(member);
      const existing = this.jobs.db
        .prepare(
          "SELECT id FROM server_rules_acceptances WHERE guild_id=? AND user_id=? AND joined_at=? AND version_id=?",
        )
        .get(this.guildId, userId, member.joinedAt, version.id);
      if (existing) return String(existing.id);
      const id = randomUUID(),
        now = this.now(),
        present = member.roleIds.includes(version.roleId);
      const job = present
        ? null
        : this.jobs.enqueue({
            guildId: this.guildId,
            type: "server-rules.grant-role",
            objectId: version.id,
            generation: version.generation,
            dueAt: now,
            expiresAt: now + grantLifetime,
            payload: { versionId: version.id, acceptanceId: id },
            dedupeKey: `server-rules:grant:${this.guildId}:${userId}:${member.joinedAt}:${version.id}`,
          });
      this.jobs.db
        .prepare("INSERT INTO server_rules_acceptances VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)")
        .run(
          this.guildId,
          id,
          userId,
          member.joinedAt,
          version.id,
          version.roleId,
          event.source === "reaction_reconcile" ? event.observedAt! : now,
          event.source,
          present ? "already_present" : "pending",
          job?.id ?? null,
          present ? now : null,
        );
      return id;
    });
    return this.findAcceptance(acceptanceId);
  }
  /** Removing a reaction is deliberately not a withdrawal of membership or a role toggle. */
  async reaction(
    userId: string,
    event: RulesAcceptEvent,
    added: boolean,
  ): Promise<RulesAcceptance | null> {
    if (added === false) return null;
    if (added !== true || event.source === "button") throw new RulesError("invalid_input");
    return this.accept(userId, event);
  }
  /** Trusted member-remove input only. Reactions being removed never call this method. */
  memberLeft(userId: string, joinedAt: number): void {
    new ServerRulesRetention(this.jobs, {
      guildId: this.guildId,
      clock: this.clock,
      maxFactAgeMs: this.maximumAge,
    }).observe({
      guildId: this.guildId,
      userId,
      expectedJoinedAt: joinedAt,
      observedAt: this.now(),
      presence: "absent",
    });
  }
  async ownAcceptance(userId: string, acceptanceId: string): Promise<RulesAcceptance> {
    const found = this.findAcceptance(acceptanceId);
    if (found.userId !== rulesId(userId)) throw new RulesError("not_found");
    const version = this.version(found.versionId),
      facts = await this.preflight(version),
      member = await this.member(userId, facts, version);
    if (member.joinedAt !== found.joinedAt) throw new RulesError("membership_changed");
    this.checkRevocation(member);
    return this.findAcceptance(acceptanceId);
  }
  private lease(job: JobLease, context: RulesExecutionContext): void {
    context.checkpoint();
    const current = this.jobs.get(job.id);
    if (
      !current ||
      current.guildId !== this.guildId ||
      current.state !== "running" ||
      current.leaseToken !== job.leaseToken ||
      current.leaseUntil! <= this.now() ||
      current.cancelRequested ||
      context.signal.aborted ||
      (current.expiresAt !== null && current.expiresAt <= this.now())
    )
      throw new RulesError("stale_lease");
  }
  private associated(job: Job, version: RulesVersion): void {
    if (
      job.guildId !== this.guildId ||
      job.objectId !== version.id ||
      job.generation !== version.generation
    )
      throw new RulesError("stale_generation");
    const current = this.jobs.get(job.id);
    if (
      !current ||
      canonical(current.payload) !== canonical(job.payload) ||
      current.type !== job.type ||
      current.objectId !== job.objectId ||
      current.generation !== job.generation
    )
      throw new RulesError("invalid_input");
  }
  private activate(version: RulesVersion): void {
    this.current(version);
    this.jobs.db
      .prepare("UPDATE server_rules_versions SET state='active' WHERE guild_id=? AND id=?")
      .run(this.guildId, version.id);
    this.jobs.db
      .prepare(
        "UPDATE server_rules_settings SET active_version_id=? WHERE guild_id=? AND generation=?",
      )
      .run(version.id, this.guildId, version.generation);
  }
  private enqueueActivation(version: RulesVersion): void {
    const parts = this.parts(version.id);
    if (parts.some((part) => part.state !== "confirmed")) return;
    this.current(version);
    const final = parts.at(-1)!;
    if (version.method === "reaction" && final.reactionState !== "confirmed") {
      const job = this.jobs.enqueue({
        guildId: this.guildId,
        type: "server-rules.seed-reaction",
        objectId: version.id,
        generation: version.generation,
        payload: { versionId: version.id },
        dueAt: version.createdAt,
        expiresAt: version.createdAt + publicationLifetime,
        dedupeKey: `server-rules:seed:${this.guildId}:${version.id}`,
      });
      this.jobs.db
        .prepare(
          "UPDATE server_rules_parts SET reaction_job_id=? WHERE guild_id=? AND version_id=? AND part_index=?",
        )
        .run(job.id, this.guildId, version.id, final.index);
      return;
    }
    this.jobs.enqueue({
      guildId: this.guildId,
      type: "server-rules.activate",
      objectId: version.id,
      generation: version.generation,
      payload: { versionId: version.id },
      dueAt: version.createdAt,
      expiresAt: version.createdAt + publicationLifetime,
      dedupeKey: `server-rules:activate:${this.guildId}:${version.id}`,
    });
  }
  async execute(job: JobLease, context: RulesExecutionContext): Promise<ExecutionOutcome> {
    try {
      return await this.executeJob(job, context);
    } catch (error) {
      if (!(error instanceof RulesError) || error.code === "stale_lease") throw error;
      if (error.code === "unknown_effect") return { state: "unknown", error: error.code };
      if (
        this.jobs
          .attempts(job.id)
          .some(
            (attempt) =>
              attempt.leaseToken === job.leaseToken &&
              ["sending", "succeeded"].includes(attempt.state),
          )
      )
        return { state: "unknown", error: error.code };
      if (job.type === "server-rules.grant-role") {
        const stored = this.jobs.get(job.id),
          input = job.payload as { acceptanceId?: string; versionId?: string };
        if (
          input &&
          typeof input === "object" &&
          stored?.guildId === this.guildId &&
          stored.type === job.type &&
          stored.objectId === job.objectId &&
          canonical(stored.payload) === canonical(job.payload)
        )
          this.jobs.db
            .prepare(
              "UPDATE server_rules_acceptances SET grant_state='blocked',reason=? WHERE guild_id=? AND job_id=? AND id=? AND version_id=? AND grant_state='pending'",
            )
            .run(error.code, this.guildId, job.id, input.acceptanceId ?? "", input.versionId ?? "");
      }
      return { state: "failed", error: error.code };
    }
  }
  private async executeJob(
    job: JobLease,
    context: RulesExecutionContext,
  ): Promise<ExecutionOutcome> {
    const payload = job.payload as {
      versionId?: string;
      index?: number;
      acceptanceId?: string;
      messageId?: string;
    };
    if (!payload || typeof payload !== "object" || !payload.versionId)
      throw new RulesError("invalid_input");
    const version = this.version(payload.versionId);
    this.associated(job, version);
    this.lease(job, context);
    if (job.type === "server-rules.retire-controls")
      return this.executeRetire(job, context, version, payload.messageId);
    this.current(version);
    if (job.type === "server-rules.grant-role")
      return this.executeGrant(job, context, version, rulesKey(payload.acceptanceId));
    if (job.type === "server-rules.seed-reaction") return this.executeSeed(job, context, version);
    if (job.type === "server-rules.activate") {
      const facts = await this.preflight(version);
      await this.verifyPublication(version);
      await this.admin(version.createdBy);
      assertFresh(facts.observedAt, this.now(), this.maximumAge);
      this.lease(job, context);
      this.current(version);
      this.jobs.transaction(() => this.activate(version));
      return { state: "succeeded", result: { versionId: version.id } };
    }
    if (job.type !== "server-rules.publish-part") throw new RulesError("invalid_input");
    const part = this.parts(version.id)[rulesInteger(payload.index)];
    if (!part || part.jobId !== job.id) throw new RulesError("invalid_input");
    const facts = await this.preflight(version);
    await this.admin(version.createdBy);
    assertFresh(facts.observedAt, this.now(), this.maximumAge);
    this.lease(job, context);
    this.current(version);
    if (part.state === "sending" && !part.messageId)
      return { state: "unknown", error: "publication_unconfirmed" };
    if (!part.messageId) {
      const nonce = BigInt("0x" + digest(job.id).slice(0, 16)).toString();
      this.jobs.transaction(() => {
        this.lease(job, context);
        this.current(version);
        const latest = this.parts(version.id)[part.index];
        if (latest.state !== "pending" || latest.messageId !== null)
          throw new RulesError("unknown_effect");
        context.beginAttempt({ nonce, channelId: version.channelId });
        this.jobs.db
          .prepare(
            "UPDATE server_rules_parts SET state='sending' WHERE guild_id=? AND version_id=? AND part_index=?",
          )
          .run(this.guildId, version.id, part.index);
      });
      const final = part.index === this.parts(version.id).length - 1;
      let receipt: { guildId: string; channelId: string; messageId: string };
      try {
        receipt = await this.options.ports.sendPart({
          guildId: this.guildId,
          channelId: version.channelId,
          content: part.content,
          controlId:
            final && version.method === "button" ? rulesControlId(this.guildId, version.id) : null,
          allowedMentions: { parse: [], users: [], roles: [] },
          nonce,
          enforceNonce: true,
          signal: context.signal,
        });
      } catch (error) {
        const retry = rulesRateLimit(error, this.now());
        if (!retry) throw error;
        this.lease(job, context);
        this.current(version);
        this.jobs.db
          .prepare(
            "UPDATE server_rules_parts SET state='pending' WHERE guild_id=? AND version_id=? AND part_index=? AND job_id=? AND state='sending' AND message_id IS NULL",
          )
          .run(this.guildId, version.id, part.index, job.id);
        return retry;
      }
      if (receipt.guildId !== this.guildId || receipt.channelId !== version.channelId)
        throw new RulesError("publication_unavailable");
      part.messageId = rulesId(receipt.messageId);
      this.jobs.db
        .prepare(
          "UPDATE server_rules_parts SET message_id=?,state='unverified' WHERE guild_id=? AND version_id=? AND part_index=? AND message_id IS NULL",
        )
        .run(part.messageId, this.guildId, version.id, part.index);
      if (final && this.version(version.id).state === "retired")
        this.queueRetire(version, part.messageId);
    }
    await this.verifyPart(version, part, version.method !== "reaction");
    // A late positive receipt is kept even when OFF/new version has invalidated the old job.
    this.jobs.recordReceipt(job.id, job.leaseToken, {
      messageId: part.messageId!,
      result: { versionId: version.id, index: part.index },
    });
    this.lease(job, context);
    this.current(version);
    this.jobs.transaction(() => {
      this.jobs.db
        .prepare(
          "UPDATE server_rules_parts SET state='confirmed' WHERE guild_id=? AND version_id=? AND part_index=?",
        )
        .run(this.guildId, version.id, part.index);
      this.enqueueActivation(version);
    });
    return { state: "succeeded", messageId: part.messageId! };
  }
  private async executeGrant(
    job: JobLease,
    context: RulesExecutionContext,
    version: RulesVersion,
    acceptanceId: string,
  ): Promise<ExecutionOutcome> {
    const found = this.findAcceptance(acceptanceId);
    if (found.versionId !== version.id || found.jobId !== job.id || found.roleId !== version.roleId)
      throw new RulesError("invalid_input");
    this.current(version, true);
    let facts = await this.preflight(version),
      member = await this.member(found.userId, facts, version);
    if (member.joinedAt !== found.joinedAt) throw new RulesError("membership_changed");
    this.checkRevocation(member);
    await this.verifyPublication(version);
    facts = await this.preflight(version);
    member = await this.member(found.userId, facts, version);
    if (member.joinedAt !== found.joinedAt) throw new RulesError("membership_changed");
    this.checkRevocation(member);
    this.lease(job, context);
    this.current(version, true);
    if (found.grantState === "blocked") return { state: "failed", error: "role_revoked" };
    if (["confirmed", "already_present"].includes(found.grantState)) return { state: "succeeded" };
    if (member.roleIds.includes(version.roleId)) {
      this.setGrant(found.id, found.grantState === "pending" ? "already_present" : "confirmed");
      return {
        state: "succeeded",
        result: { acceptanceId: found.id, grantState: this.findAcceptance(found.id).grantState },
      };
    }
    if (found.grantState === "sending" || found.grantState === "unknown")
      return { state: "unknown", error: "role_unconfirmed" };
    this.jobs.transaction(() => {
      this.lease(job, context);
      this.current(version, true);
      assertFresh(facts.observedAt, this.now(), this.maximumAge);
      assertFresh(member.observedAt, this.now(), this.maximumAge);
      if (this.findAcceptance(found.id).grantState !== "pending")
        throw new RulesError("unknown_effect");
      context.beginAttempt();
      this.setGrant(found.id, "sending");
    });
    try {
      await this.options.ports.addRole({
        guildId: this.guildId,
        userId: found.userId,
        roleId: version.roleId,
        signal: context.signal,
      });
    } catch (error) {
      const retry = rulesRateLimit(error, this.now());
      if (retry) {
        this.lease(job, context);
        this.current(version, true);
        this.jobs.db
          .prepare(
            "UPDATE server_rules_acceptances SET grant_state='pending',reason=NULL WHERE guild_id=? AND id=? AND job_id=? AND grant_state='sending'",
          )
          .run(this.guildId, found.id, job.id);
        return retry;
      }
      this.setGrant(found.id, "unknown", "role_unconfirmed");
      return { state: "unknown", error: "role_unconfirmed" };
    }
    this.setGrant(found.id, "unknown", "role_unconfirmed");
    const refreshedFacts = await this.preflight(version),
      refreshed = await this.member(found.userId, refreshedFacts, version);
    if (refreshed.joinedAt !== found.joinedAt) throw new RulesError("membership_changed");
    if (refreshed.roleIds.includes(version.roleId)) {
      // Preserve a historical success without reviving a cancelled job or overwriting a later block.
      this.jobs.db
        .prepare(
          "UPDATE server_rules_acceptances SET grant_state='confirmed',confirmed_at=?,reason=NULL WHERE guild_id=? AND id=? AND grant_state IN('sending','unknown') AND EXISTS(SELECT 1 FROM server_rules_memberships m WHERE m.guild_id=server_rules_acceptances.guild_id AND m.user_id=server_rules_acceptances.user_id AND m.joined_at=server_rules_acceptances.joined_at AND m.left_at IS NULL AND m.revoked_at IS NULL)",
        )
        .run(this.now(), this.guildId, found.id);
    }
    this.lease(job, context);
    this.current(version, true);
    if (!refreshed.roleIds.includes(version.roleId))
      return { state: "unknown", error: "role_unconfirmed" };
    this.setGrant(found.id, "confirmed");
    return { state: "succeeded", result: { acceptanceId: found.id, grantState: "confirmed" } };
  }
  private async executeSeed(
    job: JobLease,
    context: RulesExecutionContext,
    version: RulesVersion,
  ): Promise<ExecutionOutcome> {
    const final = this.parts(version.id).at(-1);
    if (version.method !== "reaction" || !final?.messageId || final.reactionJobId !== job.id)
      throw new RulesError("invalid_input");
    const facts = await this.preflight(version);
    await this.verifyPublication(version, false);
    await this.admin(version.createdBy);
    assertFresh(facts.observedAt, this.now(), this.maximumAge);
    this.lease(job, context);
    this.current(version);
    if (final.reactionState !== "pending") {
      try {
        await this.verifyPart(version, final);
      } catch (error) {
        if (error instanceof RulesError) return { state: "unknown", error: "reaction_unconfirmed" };
        throw error;
      }
    } else {
      this.jobs.transaction(() => {
        this.lease(job, context);
        this.current(version);
        assertFresh(facts.observedAt, this.now(), this.maximumAge);
        if (this.parts(version.id).at(-1)!.reactionState !== "pending")
          throw new RulesError("unknown_effect");
        context.beginAttempt({ channelId: version.channelId });
        this.jobs.db
          .prepare(
            "UPDATE server_rules_parts SET reaction_state='sending' WHERE guild_id=? AND version_id=? AND part_index=?",
          )
          .run(this.guildId, version.id, final.index);
      });
      try {
        await this.options.ports.seedReaction({
          guildId: this.guildId,
          channelId: version.channelId,
          messageId: final.messageId,
          emoji: version.emoji!,
          signal: context.signal,
        });
      } catch (error) {
        const retry = rulesRateLimit(error, this.now());
        if (retry) {
          this.lease(job, context);
          this.current(version);
          this.jobs.db
            .prepare(
              "UPDATE server_rules_parts SET reaction_state='pending' WHERE guild_id=? AND version_id=? AND part_index=? AND reaction_job_id=? AND reaction_state='sending'",
            )
            .run(this.guildId, version.id, final.index, job.id);
          return retry;
        }
        this.jobs.db
          .prepare(
            "UPDATE server_rules_parts SET reaction_state='unknown' WHERE guild_id=? AND version_id=? AND part_index=? AND reaction_state='sending'",
          )
          .run(this.guildId, version.id, final.index);
        return { state: "unknown", error: "reaction_unconfirmed" };
      }
      await this.verifyPart(version, final);
      this.jobs.recordReceipt(job.id, job.leaseToken, {
        messageId: final.messageId,
        result: { reactionConfirmed: true },
      });
      if (this.version(version.id).state === "retired")
        this.queueRetire(version, final.messageId, "reaction");
    }
    this.lease(job, context);
    this.current(version);
    this.jobs.transaction(() => {
      this.jobs.db
        .prepare(
          "UPDATE server_rules_parts SET reaction_state='confirmed' WHERE guild_id=? AND version_id=? AND part_index=?",
        )
        .run(this.guildId, version.id, final.index);
      this.enqueueActivation(version);
    });
    return { state: "succeeded", messageId: final.messageId };
  }
  private setGrant(
    id: string,
    state: RulesAcceptance["grantState"],
    reason: string | null = null,
  ): void {
    const allowed =
      state === "sending" || state === "already_present"
        ? ["pending"]
        : state === "unknown"
          ? ["sending", "unknown"]
          : ["pending", "sending", "unknown"];
    this.jobs.db
      .prepare(
        `UPDATE server_rules_acceptances SET grant_state=?,reason=?,confirmed_at=CASE WHEN ? IN('confirmed','already_present') THEN ? ELSE confirmed_at END WHERE guild_id=? AND id=? AND grant_state IN(${allowed.map(() => "?").join(",")})`,
      )
      .run(state, reason, state, this.now(), this.guildId, id, ...allowed);
  }
  async reconcileGrant(userId: string, acceptanceId: string): Promise<RulesAcceptance> {
    const found = await this.ownAcceptance(userId, acceptanceId),
      version = this.version(found.versionId);
    this.current(version, true);
    if (!["sending", "unknown"].includes(found.grantState)) return found;
    await this.verifyPublication(version);
    const facts = await this.preflight(version),
      member = await this.member(userId, facts, version);
    if (member.joinedAt !== found.joinedAt) throw new RulesError("membership_changed");
    this.current(version, true);
    this.checkRevocation(member);
    if (member.roleIds.includes(found.roleId)) {
      this.setGrant(found.id, "confirmed");
      const job = found.jobId ? this.jobs.get(found.jobId) : undefined;
      if (job?.state === "unknown" && !job.cancelRequested)
        this.jobs.reconcile(job.id, job.revision, {
          outcome: "succeeded",
          result: { acceptanceId: found.id, grantState: "confirmed" },
        });
    }
    return this.findAcceptance(acceptanceId);
  }
  private async executeRetire(
    job: JobLease,
    context: RulesExecutionContext,
    version: RulesVersion,
    expectedMessageId?: string,
  ): Promise<ExecutionOutcome> {
    if (this.version(version.id).state !== "retired") throw new RulesError("stale_generation");
    const final = this.parts(version.id).at(-1);
    if (expectedMessageId !== undefined && expectedMessageId !== final?.messageId)
      throw new RulesError("publication_unavailable");
    if (!final?.messageId) return { state: "succeeded" };
    await this.verifyPart(version, final, false);
    this.lease(job, context);
    context.beginAttempt({ channelId: version.channelId });
    await this.options.ports.retireControls({
      guildId: this.guildId,
      channelId: version.channelId,
      messageId: final.messageId,
      signal: context.signal,
    });
    return { state: "succeeded", messageId: final.messageId };
  }
  async reconcilePublication(actorId: string, versionId: string): Promise<RulesVersion> {
    await this.admin(actorId);
    const version = this.version(versionId);
    this.current(version);
    const facts = await this.preflight(version);
    for (const part of this.parts(versionId)) {
      if (!part.messageId) throw new RulesError("publication_not_ready");
      await this.verifyPart(version, part);
    }
    await this.admin(actorId);
    assertFresh(facts.observedAt, this.now(), this.maximumAge);
    this.current(version);
    this.jobs.transaction(() => {
      for (const part of this.parts(versionId)) {
        this.jobs.db
          .prepare(
            "UPDATE server_rules_parts SET state='confirmed' WHERE guild_id=? AND version_id=? AND part_index=?",
          )
          .run(this.guildId, versionId, part.index);
        const job = this.jobs.get(part.jobId);
        if (job?.state === "unknown" && !job.cancelRequested)
          this.jobs.reconcile(job.id, job.revision, {
            outcome: "succeeded",
            messageId: part.messageId!,
          });
        if (part.reactionState !== "not_required") {
          this.jobs.db
            .prepare(
              "UPDATE server_rules_parts SET reaction_state='confirmed' WHERE guild_id=? AND version_id=? AND part_index=?",
            )
            .run(this.guildId, versionId, part.index);
          const seed = part.reactionJobId ? this.jobs.get(part.reactionJobId) : undefined;
          if (seed?.state === "unknown" && !seed.cancelRequested)
            this.jobs.reconcile(seed.id, seed.revision, {
              outcome: "succeeded",
              messageId: part.messageId!,
            });
          else if (seed && ["pending", "retry"].includes(seed.state)) this.jobs.cancel(seed.id);
        }
      }
      this.enqueueActivation(version);
    });
    return this.version(versionId);
  }
}
