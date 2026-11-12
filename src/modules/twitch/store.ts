import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../../storage/migrations.js";
import { digest } from "../../shared/utils.js";
import { bindingInput, broadcasterId, discordId, integer, text } from "./validation.js";
import {
  TwitchError,
  type HubOptions,
  type SubscriptionIntent,
  type TwitchBinding,
  type TwitchFanout,
  type TwitchInboxEvent,
  type TwitchJobInput,
  type TwitchRetention,
  type TwitchSource,
  type VerifiedEnvelope,
  type WebhookResponse,
} from "./types.js";

const schema = `
CREATE TABLE twitch_sources (
 broadcaster_id TEXT PRIMARY KEY, subscription_id TEXT UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','enabled','revoked')),
 reason TEXT, last_event_at INTEGER
);
CREATE TABLE twitch_bindings (
 id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, broadcaster_id TEXT NOT NULL REFERENCES twitch_sources(broadcaster_id),
 definition TEXT NOT NULL, UNIQUE(guild_id,broadcaster_id)
);
CREATE INDEX twitch_bindings_source ON twitch_bindings(broadcaster_id);
CREATE TABLE twitch_mutations (
 scope TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL,
 PRIMARY KEY(scope,request_id)
);
CREATE TABLE twitch_inbox (
 id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, envelope TEXT NOT NULL,
 received_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','done','ignored')),
 response TEXT NOT NULL, last_error TEXT
);
CREATE INDEX twitch_inbox_pending ON twitch_inbox(state,received_at);
CREATE TABLE twitch_fanout (
 id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES twitch_bindings(id), stream_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','queued','skipped')), job TEXT NOT NULL,
 job_id TEXT, reason TEXT, updated_at INTEGER NOT NULL, UNIQUE(binding_id,stream_id)
);
CREATE INDEX twitch_fanout_pending ON twitch_fanout(state,updated_at);
`;
const providerSchema = `
CREATE TABLE twitch_subscription_intents (
 id TEXT PRIMARY KEY, broadcaster_id TEXT NOT NULL REFERENCES twitch_sources(broadcaster_id),
 callback_url TEXT NOT NULL UNIQUE, secret_ref TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','registered','confirmed','superseded','expired')),
 subscription_id TEXT UNIQUE, attempted_at INTEGER, retry_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX twitch_subscription_pending ON twitch_subscription_intents(broadcaster_id)
 WHERE state IN ('pending','registered');
`;

export function twitchSchemaDefinitions(): readonly string[] {
  return [schema, providerSchema];
}
type Row = Record<string, unknown>;
const readIntent = (row: Row): SubscriptionIntent => ({
  id: String(row.id),
  broadcasterId: String(row.broadcaster_id),
  callbackUrl: String(row.callback_url),
  secretRef: String(row.secret_ref),
  state: row.state as SubscriptionIntent["state"],
  subscriptionId: row.subscription_id === null ? null : String(row.subscription_id),
  attemptedAt: row.attempted_at === null ? null : Number(row.attempted_at),
  retryAt: Number(row.retry_at),
  createdAt: Number(row.created_at),
  expiresAt: Number(row.expires_at),
});
const readBinding = (row: Row): TwitchBinding =>
  JSON.parse(String(row.definition)) as TwitchBinding;
const readFanout = (row: Row): TwitchFanout => ({
  id: String(row.id),
  bindingId: String(row.binding_id),
  streamId: String(row.stream_id),
  state: row.state as TwitchFanout["state"],
  job: JSON.parse(String(row.job)) as TwitchJobInput,
  jobId: row.job_id === null ? null : String(row.job_id),
  reason: row.reason === null ? null : String(row.reason),
});

export interface OrphanTwitchSource {
  broadcasterId: string;
  subscriptionId: string | null;
  intents: SubscriptionIntent[];
  fingerprint: string;
}

function orphanSource(db: DatabaseSync, id: string): OrphanTwitchSource | undefined {
  broadcasterId(id);
  if (db.prepare("SELECT 1 FROM twitch_bindings WHERE broadcaster_id=? LIMIT 1").get(id))
    return undefined;
  const source = db.prepare("SELECT * FROM twitch_sources WHERE broadcaster_id=?").get(id);
  if (!source) return undefined;
  const intents = db
    .prepare("SELECT * FROM twitch_subscription_intents WHERE broadcaster_id=? ORDER BY id")
    .all(id);
  return {
    broadcasterId: id,
    subscriptionId: source.subscription_id === null ? null : String(source.subscription_id),
    intents: intents.map(readIntent),
    fingerprint: digest({ source, intents }),
  };
}

function minimizeOrphanInbox(db: DatabaseSync, id: string): void {
  // Minimized envelopes have no source locator. Preserve them and every exact webhook reply.
  db.prepare(
    `UPDATE twitch_inbox SET envelope='{}',last_error=NULL,
       state=CASE WHEN state='pending' THEN 'ignored' ELSE state END
     WHERE CASE WHEN json_valid(envelope)
       THEN json_extract(envelope,'$.broadcasterId') END=?`,
  ).run(id);
}

function finalizeOrphanSource(
  db: DatabaseSync,
  expected: OrphanTwitchSource,
  deletedIds: readonly string[],
): boolean {
  return transaction(db, () => {
    const current = orphanSource(db, expected.broadcasterId),
      deleted = new Set(deletedIds);
    if (
      !current ||
      current.fingerprint !== expected.fingerprint ||
      (current.subscriptionId !== null && !deleted.has(current.subscriptionId)) ||
      current.intents.some((intent) =>
        intent.subscriptionId === null
          ? intent.attemptedAt !== null || ["registered", "confirmed"].includes(intent.state)
          : !deleted.has(intent.subscriptionId),
      )
    )
      return false;
    minimizeOrphanInbox(db, current.broadcasterId);
    db.prepare("DELETE FROM twitch_subscription_intents WHERE broadcaster_id=?").run(
      current.broadcasterId,
    );
    db.prepare("DELETE FROM twitch_sources WHERE broadcaster_id=?").run(current.broadcasterId);
    return true;
  });
}

/** Guild purge is local: external cleanup locators survive until DELETE has been confirmed. */
export function minimizeOrphanTwitchSource(db: DatabaseSync, id: string): void {
  transaction(db, () => {
    const source = orphanSource(db, id);
    if (!source) return;
    minimizeOrphanInbox(db, id);
    finalizeOrphanSource(db, source, []);
  });
}

export class TwitchHubStore {
  readonly retention: TwitchRetention;
  private readonly clock: () => number;

  constructor(
    readonly db: DatabaseSync,
    private readonly options: HubOptions,
  ) {
    this.clock = options.clock ?? Date.now;
    const duration = (value: number | null | undefined) => {
      if (value == null) return null;
      if (integer(value) < 600000) throw new TwitchError("invalid_input");
      return value;
    };
    this.retention = {
      inboxMs: duration(options.retention?.inboxMs),
      fanoutMs: duration(options.retention?.fanoutMs),
    };
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'twitch_*'",
        )
        .get()
    )
      throw new Error("Twitch integrations require a separate database.");
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000",
    );
    transaction(db, () => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS twitch_hub_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL)",
      );
      const installed = db
        .prepare("SELECT version,checksum FROM twitch_hub_migrations ORDER BY version")
        .all();
      const migrations = [schema, providerSchema];
      if (installed.length > migrations.length)
        throw new Error("Unsupported Twitch integration schema.");
      for (const [index, sql] of migrations.entries()) {
        const checksum = createHash("sha256").update(sql).digest("hex"),
          previous = installed[index];
        if (previous) {
          if (previous.version !== index + 1 || previous.checksum !== checksum)
            throw new Error("Unsupported Twitch integration schema.");
        } else {
          db.exec(sql);
          db.prepare("INSERT INTO twitch_hub_migrations(version,checksum) VALUES (?,?)").run(
            index + 1,
            checksum,
          );
        }
      }
    });
  }

  now(): number {
    return integer(this.clock());
  }

  private mutation<T>(scope: string, requestId: string, input: unknown, work: () => T): T {
    text(requestId, 128);
    const hash = digest(input);
    return transaction(this.db, () => {
      const previous = this.db
        .prepare("SELECT input_hash,result FROM twitch_mutations WHERE scope=? AND request_id=?")
        .get(scope, requestId);
      if (previous) {
        if (previous.input_hash !== hash) throw new TwitchError("idempotency_conflict");
        return JSON.parse(String(previous.result)) as T;
      }
      const result = work();
      this.db
        .prepare(
          "INSERT INTO twitch_mutations(scope,request_id,input_hash,result) VALUES (?,?,?,?)",
        )
        .run(scope, requestId, hash, JSON.stringify(result));
      return result;
    });
  }

  private saveBinding(value: TwitchBinding): TwitchBinding {
    this.db
      .prepare(
        "INSERT INTO twitch_bindings(id,guild_id,broadcaster_id,definition) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition",
      )
      .run(value.id, value.guildId, value.broadcasterId, JSON.stringify(value));
    return value;
  }
  private requireBinding(guildId: string, bindingId: string): TwitchBinding {
    const binding = this.binding(bindingId);
    if (!binding || binding.guildId !== guildId || binding.removed)
      throw new TwitchError("not_found");
    return binding;
  }
  private changed(value: TwitchBinding, expected: number): void {
    if (integer(expected) !== value.revision) throw new TwitchError("revision_conflict");
    if (
      value.revision >= Number.MAX_SAFE_INTEGER - 1 ||
      value.generation >= Number.MAX_SAFE_INTEGER - 1
    )
      throw new TwitchError("revision_conflict");
  }
  async listBindings(guild: string, actor: string): Promise<TwitchBinding[]> {
    const guildId = discordId(guild),
      actorId = discordId(actor);
    await this.options.authorize({ guildId, actorId, operation: "list" });
    return this.db
      .prepare("SELECT definition FROM twitch_bindings WHERE guild_id=? ORDER BY id")
      .all(guildId)
      .map(readBinding)
      .filter((value) => !value.removed);
  }
  async getBinding(guild: string, actor: string, id: string): Promise<TwitchBinding> {
    const guildId = discordId(guild),
      actorId = discordId(actor);
    await this.options.authorize({ guildId, actorId, operation: "read", bindingId: text(id) });
    return this.requireBinding(guildId, id);
  }
  async createBinding(
    guild: string,
    actor: string,
    requestId: string,
    input: unknown,
  ): Promise<TwitchBinding> {
    const guildId = discordId(guild),
      actorId = discordId(actor),
      draft = bindingInput(input);
    await this.options.authorize({ guildId, actorId, operation: "create", ...draft });
    return this.mutation(`${guildId}:create`, requestId, { actorId, draft }, () => {
      this.db
        .prepare(
          "INSERT INTO twitch_sources(broadcaster_id,status) VALUES (?,'pending') ON CONFLICT DO NOTHING",
        )
        .run(draft.broadcasterId);
      const oldRow = this.db
        .prepare("SELECT definition FROM twitch_bindings WHERE guild_id=? AND broadcaster_id=?")
        .get(guildId, draft.broadcasterId);
      const old = oldRow ? readBinding(oldRow) : undefined;
      if (old && !old.removed) throw new TwitchError("binding_exists");
      if (old) this.changed(old, old.revision);
      return this.saveBinding({
        ...draft,
        id: old?.id ?? randomUUID(),
        guildId,
        actorId,
        revision: old ? old.revision + 1 : 1,
        generation: old ? old.generation + 1 : 1,
        removed: false,
        createdAt: old?.createdAt ?? this.now(),
        updatedAt: this.now(),
      });
    });
  }
  async updateBinding(
    guild: string,
    actor: string,
    requestId: string,
    id: string,
    expected: number,
    input: unknown,
  ): Promise<TwitchBinding> {
    const guildId = discordId(guild),
      actorId = discordId(actor),
      draft = bindingInput(input);
    text(id);
    integer(expected);
    await this.options.authorize({
      guildId,
      actorId,
      operation: "update",
      bindingId: id,
      ...draft,
    });
    return this.mutation(`${guildId}:update`, requestId, { actorId, id, expected, draft }, () => {
      const before = this.requireBinding(guildId, id);
      this.changed(before, expected);
      if (before.broadcasterId !== draft.broadcasterId) throw new TwitchError("invalid_input");
      return this.saveBinding({
        ...before,
        ...draft,
        actorId,
        revision: before.revision + 1,
        generation: before.generation + 1,
        updatedAt: this.now(),
      });
    });
  }
  async removeBinding(
    guild: string,
    actor: string,
    requestId: string,
    id: string,
    expected: number,
  ): Promise<TwitchBinding> {
    const guildId = discordId(guild),
      actorId = discordId(actor);
    text(id);
    integer(expected);
    await this.options.authorize({ guildId, actorId, operation: "remove", bindingId: id });
    return this.mutation(`${guildId}:remove`, requestId, { actorId, id, expected }, () => {
      const before = this.requireBinding(guildId, id);
      this.changed(before, expected);
      return this.saveBinding({
        ...before,
        actorId,
        enabled: false,
        removed: true,
        revision: before.revision + 1,
        generation: before.generation + 1,
        updatedAt: this.now(),
      });
    });
  }

  // Provider/worker methods are internal; panel access goes through the authorized methods above.
  binding(id: string): TwitchBinding | undefined {
    const row = this.db.prepare("SELECT definition FROM twitch_bindings WHERE id=?").get(text(id));
    return row ? readBinding(row) : undefined;
  }
  recipients(broadcaster: string, receivedAt: number): TwitchBinding[] {
    return this.db
      .prepare("SELECT definition FROM twitch_bindings WHERE broadcaster_id=? ORDER BY id")
      .all(broadcasterId(broadcaster))
      .map(readBinding)
      .filter((value) => value.enabled && !value.removed && value.updatedAt <= receivedAt);
  }
  sourceBindings(broadcaster: string): TwitchBinding[] {
    return this.db
      .prepare("SELECT definition FROM twitch_bindings WHERE broadcaster_id=? ORDER BY id")
      .all(broadcasterId(broadcaster))
      .map(readBinding);
  }
  source(id: string): TwitchSource | undefined {
    const row = this.db
      .prepare("SELECT * FROM twitch_sources WHERE broadcaster_id=?")
      .get(broadcasterId(id));
    if (!row) return undefined;
    const activeBindingCount = this.db
      .prepare("SELECT definition FROM twitch_bindings WHERE broadcaster_id=?")
      .all(id)
      .map(readBinding)
      .filter((value) => value.enabled && !value.removed).length;
    return {
      broadcasterId: id,
      subscriptionId: row.subscription_id === null ? null : String(row.subscription_id),
      status: row.status as TwitchSource["status"],
      reason: row.reason === null ? null : String(row.reason),
      lastEventAt: row.last_event_at === null ? null : Number(row.last_event_at),
      activeBindingCount,
    };
  }
  registerSubscription(broadcaster: string, subscriptionId: string): void {
    if (!this.source(broadcaster)) throw new TwitchError("not_found");
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE twitch_subscription_intents SET state='superseded' WHERE broadcaster_id=? AND state IN ('pending','registered')",
        )
        .run(broadcasterId(broadcaster));
      this.db
        .prepare(
          "UPDATE twitch_sources SET subscription_id=?,status='pending',reason=NULL WHERE broadcaster_id=?",
        )
        .run(text(subscriptionId), broadcasterId(broadcaster));
    });
  }

  sources(): TwitchSource[] {
    return this.db
      .prepare("SELECT broadcaster_id FROM twitch_sources ORDER BY broadcaster_id")
      .all()
      .map((row) => this.source(String(row.broadcaster_id))!);
  }
  subscriptionIntents(broadcaster?: string): SubscriptionIntent[] {
    return (
      broadcaster === undefined
        ? this.db.prepare("SELECT * FROM twitch_subscription_intents ORDER BY created_at,id").all()
        : this.db
            .prepare(
              "SELECT * FROM twitch_subscription_intents WHERE broadcaster_id=? ORDER BY created_at,id",
            )
            .all(broadcasterId(broadcaster))
    ).map(readIntent);
  }
  orphanSource(broadcaster: string): OrphanTwitchSource | undefined {
    return orphanSource(this.db, broadcaster);
  }
  sourceFingerprint(broadcaster: string): string | undefined {
    broadcasterId(broadcaster);
    const source = this.db
      .prepare("SELECT * FROM twitch_sources WHERE broadcaster_id=?")
      .get(broadcaster);
    if (!source) return undefined;
    return digest({
      source,
      intents: this.db
        .prepare("SELECT * FROM twitch_subscription_intents WHERE broadcaster_id=? ORDER BY id")
        .all(broadcaster),
      bindings: this.db
        .prepare("SELECT * FROM twitch_bindings WHERE broadcaster_id=? ORDER BY id")
        .all(broadcaster),
    });
  }
  recordSubscriptionLocator(intentId: string, subscriptionId: string, callbackUrl: string): void {
    text(subscriptionId);
    transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM twitch_subscription_intents WHERE id=?")
        .get(text(intentId));
      if (
        !row ||
        row.callback_url !== callbackUrl ||
        (row.subscription_id !== null && row.subscription_id !== subscriptionId)
      )
        throw new TwitchError("subscription_mismatch");
      // Discovery is not a DELETE receipt; keep the callback and intent state across crashes.
      this.db
        .prepare("UPDATE twitch_subscription_intents SET subscription_id=? WHERE id=?")
        .run(subscriptionId, intentId);
    });
  }
  finalizeOrphanSource(expected: OrphanTwitchSource, deletedIds: readonly string[]): boolean {
    return finalizeOrphanSource(this.db, expected, deletedIds);
  }
  beginSubscriptionIntent(
    broadcaster: string,
    callbackBase: string,
    secretRef: string,
    ttlMs = 600000,
  ): SubscriptionIntent {
    broadcasterId(broadcaster);
    text(secretRef, 64);
    if (!/^[a-f0-9]{64}$/.test(secretRef) || integer(ttlMs) < 30000 || ttlMs > 600000)
      throw new TwitchError("invalid_input");
    const base = new URL(callbackBase);
    if (
      base.protocol !== "https:" ||
      base.port ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new TwitchError("invalid_input");
    return transaction(this.db, () => {
      if (!this.source(broadcaster)?.activeBindingCount)
        throw new TwitchError("permission_revoked");
      const previous = this.subscriptionIntents(broadcaster).find((value) =>
        ["pending", "registered"].includes(value.state),
      );
      if (
        previous &&
        previous.expiresAt > this.now() &&
        previous.secretRef === secretRef &&
        previous.callbackUrl.split("?")[0] === base.href
      )
        return previous;
      this.db
        .prepare(
          "UPDATE twitch_subscription_intents SET state=CASE WHEN expires_at<=? THEN 'expired' ELSE 'superseded' END WHERE broadcaster_id=? AND state IN ('pending','registered')",
        )
        .run(this.now(), broadcaster);
      const intentId = randomUUID(),
        callback = new URL(base),
        now = this.now();
      callback.searchParams.set("gildiusz_intent", intentId);
      this.db
        .prepare(
          "INSERT INTO twitch_subscription_intents(id,broadcaster_id,callback_url,secret_ref,state,retry_at,created_at,expires_at) VALUES (?,?,?,?,'pending',?,?,?)",
        )
        .run(intentId, broadcaster, callback.href, secretRef, now, now, now + ttlMs);
      return this.subscriptionIntents(broadcaster).find((value) => value.id === intentId)!;
    });
  }
  markSubscriptionAttempt(intentId: string): boolean {
    return transaction(this.db, () => {
      const intent = this.subscriptionIntents().find((value) => value.id === text(intentId));
      if (!intent || !this.source(intent.broadcasterId)?.activeBindingCount) return false;
      return (
        Number(
          this.db
            .prepare(
              "UPDATE twitch_subscription_intents SET attempted_at=? WHERE id=? AND state='pending' AND attempted_at IS NULL AND retry_at<=? AND expires_at>?",
            )
            .run(this.now(), intent.id, this.now(), this.now()).changes,
        ) === 1
      );
    });
  }
  deferSubscriptionIntent(intentId: string, retryAt: number): void {
    this.db
      .prepare(
        "UPDATE twitch_subscription_intents SET attempted_at=NULL,retry_at=? WHERE id=? AND state='pending' AND subscription_id IS NULL",
      )
      .run(integer(retryAt), text(intentId));
  }
  completeSubscriptionIntent(
    intentId: string,
    subscriptionId: string,
    status: "enabled" | "pending",
  ): void {
    text(subscriptionId);
    transaction(this.db, () => {
      const intent = this.subscriptionIntents().find((value) => value.id === text(intentId));
      if (
        !intent ||
        ["expired", "superseded"].includes(intent.state) ||
        (intent.subscriptionId !== null && intent.subscriptionId !== subscriptionId)
      )
        throw new TwitchError("subscription_mismatch");
      const source = this.source(intent.broadcasterId)!;
      if (intent.state === "confirmed") {
        if (source.subscriptionId !== subscriptionId)
          throw new TwitchError("subscription_mismatch");
        return;
      }
      this.db
        .prepare("UPDATE twitch_subscription_intents SET subscription_id=?,state=? WHERE id=?")
        .run(subscriptionId, status === "enabled" ? "confirmed" : "registered", intent.id);
      this.db
        .prepare(
          "UPDATE twitch_sources SET subscription_id=?,status=?,reason=NULL WHERE broadcaster_id=?",
        )
        .run(subscriptionId, status, intent.broadcasterId);
    });
  }
  revokeSubscriptionIfCurrent(broadcaster: string, subscriptionId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE twitch_sources SET status='revoked',reason=? WHERE broadcaster_id=? AND subscription_id=?",
      )
      .run(text(reason, 100), broadcasterId(broadcaster), text(subscriptionId));
  }
  retireSubscriptionIntent(intentId: string, subscriptionId: string): void {
    this.db
      .prepare(
        "UPDATE twitch_subscription_intents SET state='superseded' WHERE id=? AND (subscription_id IS NULL OR subscription_id=?)",
      )
      .run(text(intentId), text(subscriptionId));
  }

  accept(event: VerifiedEnvelope): WebhookResponse {
    return transaction(this.db, () => {
      const previous = this.db
        .prepare("SELECT body_hash,response FROM twitch_inbox WHERE id=?")
        .get(event.id);
      if (previous) {
        if (previous.body_hash !== event.bodyHash) throw new TwitchError("message_collision");
        return JSON.parse(String(previous.response)) as WebhookResponse;
      }
      let source = this.source(event.broadcasterId);
      const supported =
        event.subscriptionType === "stream.online" && event.subscriptionVersion === "1";
      let matches = supported && source?.subscriptionId === event.subscriptionId;
      if (event.messageType === "webhook_callback_verification" && supported) {
        const known = this.subscriptionIntents(event.broadcasterId).find(
          (value) => value.subscriptionId === event.subscriptionId,
        );
        if (
          known &&
          (known.callbackUrl !== event.callbackUrl ||
            known.secretRef !== event.secretRef ||
            ["superseded", "expired"].includes(known.state))
        )
          throw new TwitchError("subscription_mismatch");
        if (!matches && source?.activeBindingCount && event.callbackUrl && event.secretRef) {
          const pending = this.db
            .prepare(
              "SELECT * FROM twitch_subscription_intents WHERE broadcaster_id=? AND callback_url=? AND secret_ref=? AND state='pending' AND attempted_at IS NOT NULL AND expires_at>?",
            )
            .get(event.broadcasterId, event.callbackUrl, event.secretRef, this.now());
          if (pending) {
            this.db
              .prepare(
                "UPDATE twitch_subscription_intents SET subscription_id=?,state='confirmed' WHERE id=?",
              )
              .run(event.subscriptionId, String(pending.id));
            this.db
              .prepare(
                "UPDATE twitch_sources SET subscription_id=?,status='enabled',reason=NULL WHERE broadcaster_id=?",
              )
              .run(event.subscriptionId, event.broadcasterId);
            source = this.source(event.broadcasterId);
            matches = true;
          }
        }
      }
      let state: "pending" | "done" | "ignored" = "ignored";
      let response: WebhookResponse = { status: 204, body: "" };
      if (event.messageType === "webhook_callback_verification") {
        if (
          !matches ||
          !source ||
          !["pending", "enabled"].includes(source.status) ||
          !event.challenge
        )
          throw new TwitchError("subscription_mismatch");
        this.db
          .prepare("UPDATE twitch_sources SET status='enabled',reason=NULL WHERE broadcaster_id=?")
          .run(event.broadcasterId);
        this.db
          .prepare(
            "UPDATE twitch_subscription_intents SET state='confirmed' WHERE subscription_id=? AND state='registered'",
          )
          .run(event.subscriptionId);
        response = {
          status: 200,
          body: event.challenge,
          headers: { "content-type": "text/plain; charset=utf-8" },
        };
        state = "done";
      } else if (event.messageType === "revocation" && matches) {
        this.db
          .prepare(
            "UPDATE twitch_sources SET status='revoked',reason=?,last_event_at=? WHERE broadcaster_id=?",
          )
          .run(event.subscriptionStatus, this.now(), event.broadcasterId);
        state = "done";
      } else if (
        event.messageType === "notification" &&
        matches &&
        source?.status === "enabled" &&
        event.streamType === "live"
      ) {
        this.db
          .prepare("UPDATE twitch_sources SET last_event_at=? WHERE broadcaster_id=?")
          .run(this.now(), event.broadcasterId);
        state = "pending";
      }
      const receivedAt = this.now();
      this.db
        .prepare(
          "INSERT INTO twitch_inbox(id,body_hash,envelope,received_at,state,response) VALUES (?,?,?,?,?,?)",
        )
        .run(
          event.id,
          event.bodyHash,
          JSON.stringify({ ...event, receivedAt }),
          receivedAt,
          state,
          JSON.stringify(response),
        );
      return response;
    });
  }
  pending(limit = 20): TwitchInboxEvent[] {
    return this.db
      .prepare(
        "SELECT envelope FROM twitch_inbox WHERE state='pending' ORDER BY received_at,id LIMIT ?",
      )
      .all(Math.max(1, Math.min(100, integer(limit))))
      .map((row) => JSON.parse(String(row.envelope)) as TwitchInboxEvent);
  }
  finishEvent(id: string): void {
    this.db
      .prepare("UPDATE twitch_inbox SET state='done',last_error=NULL WHERE id=?")
      .run(text(id));
  }
  eventError(id: string, reason: string): void {
    this.db
      .prepare("UPDATE twitch_inbox SET last_error=? WHERE id=?")
      .run(text(reason, 100), text(id));
  }
  prepareFanout(binding: TwitchBinding, streamId: string, job: TwitchJobInput): TwitchFanout {
    return transaction(this.db, () => {
      const existing = this.db
        .prepare("SELECT * FROM twitch_fanout WHERE binding_id=? AND stream_id=?")
        .get(binding.id, text(streamId));
      if (existing) return readFanout(existing);
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO twitch_fanout(id,binding_id,stream_id,state,job,updated_at) VALUES (?,?,?,'pending',?,?)",
        )
        .run(id, binding.id, streamId, JSON.stringify(job), this.now());
      return readFanout(this.db.prepare("SELECT * FROM twitch_fanout WHERE id=?").get(id)!);
    });
  }
  completeFanout(id: string, state: "queued" | "skipped", value: string): void {
    this.db
      .prepare(
        "UPDATE twitch_fanout SET state=?,job_id=?,reason=?,updated_at=? WHERE id=? AND state='pending'",
      )
      .run(
        state,
        state === "queued" ? text(value) : null,
        state === "skipped" ? text(value, 100) : null,
        this.now(),
        text(id),
      );
  }
  fanouts(bindingId: string): TwitchFanout[] {
    return this.db
      .prepare("SELECT * FROM twitch_fanout WHERE binding_id=? ORDER BY updated_at,id")
      .all(text(bindingId))
      .map(readFanout);
  }
  skipStream(broadcaster: string, streamId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE twitch_fanout SET state='skipped',reason=?,updated_at=? WHERE stream_id=? AND state='pending' AND binding_id IN (SELECT id FROM twitch_bindings WHERE broadcaster_id=?)",
      )
      .run(text(reason, 100), this.now(), text(streamId), broadcasterId(broadcaster));
  }
  prune(): { inbox: number; fanout: number } {
    return transaction(this.db, () => ({
      inbox:
        this.retention.inboxMs === null
          ? 0
          : Number(
              this.db
                .prepare("DELETE FROM twitch_inbox WHERE state!='pending' AND received_at<?")
                .run(this.now() - this.retention.inboxMs).changes,
            ),
      fanout:
        this.retention.fanoutMs === null
          ? 0
          : Number(
              this.db
                .prepare("DELETE FROM twitch_fanout WHERE state!='pending' AND updated_at<?")
                .run(this.now() - this.retention.fanoutMs).changes,
            ),
    }));
  }
}
