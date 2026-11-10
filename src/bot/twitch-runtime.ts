import type { DatabaseSync } from "node:sqlite";
import { ChannelType, PermissionFlagsBits as P, Routes, type REST } from "discord.js";
import type { BotContext } from "./context.js";
import {
  discordErrorCode,
  freshMember,
  isDiscordChannelUnavailable,
} from "./module-permissions.js";
import {
  buildCapabilities,
  ControlError,
  type ControlOperation,
  type ModuleCapability,
  type PublicDelivery,
  type PublicJob,
} from "../contracts/index.js";
import type { JobStore } from "../core/jobs/store.js";
import { JobError, type DeliveryAttempt, type Job } from "../core/jobs/types.js";
import type { ExecutionContext, ExecutionOutcome } from "../core/jobs/runner.js";
import type { ModuleSettingsStore } from "../core/modules/settings.js";
import { ModulePermissionError, requirePermission, type MemberFacts } from "../core/permissions.js";
import { publishDiscord, type Publication } from "../core/delivery/discord.js";
import { digest } from "../shared/utils.js";
import { TwitchHubStore } from "../modules/twitch/store.js";
import {
  TwitchProvider,
  TwitchProviderError,
  type TwitchProviderOptions,
} from "../modules/twitch/provider.js";
import { TwitchDispatcher } from "../modules/twitch/dispatcher.js";
import { EventSubReceiver, type EventSubRequest } from "../modules/twitch/webhook.js";
import {
  TwitchError,
  type TwitchAuthorization,
  type TwitchBinding,
  type WebhookResponse,
} from "../modules/twitch/types.js";
import { discordId, integer, record, text } from "../modules/twitch/validation.js";

export interface TwitchGuildRuntime {
  context: BotContext;
  jobs: JobStore;
  settings: ModuleSettingsStore;
}
export interface TwitchRuntimeConfiguration {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  callbackUrl: string;
}
export interface TwitchRuntimeOptions {
  db: DatabaseSync;
  configuration?: TwitchRuntimeConfiguration;
  publicationRest: REST;
  resolveGuild(guildId: string): TwitchGuildRuntime | undefined;
  configuredGuildEnabled?: (guildId: string) => boolean | undefined;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  providerOptions?: Pick<TwitchProviderOptions, "timeoutMs" | "retries" | "maxWaitMs" | "sleep">;
  batchSize?: number;
}
function publicJob(job: Job): PublicJob {
  return {
    id: job.id,
    guildId: job.guildId,
    type: job.type,
    state: job.state,
    dueAt: job.dueAt,
    nextAttemptAt: job.nextAttemptAt,
    expiresAt: job.expiresAt,
    dedupeKey: job.dedupeKey,
    objectId: job.objectId,
    generation: job.generation,
    attempts: job.attempts,
    failures: job.failures,
    maxAttempts: job.maxAttempts,
    leaseUntil: job.leaseUntil,
    revision: job.revision,
    cancelRequested: job.cancelRequested,
    messageId: job.messageId,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function publicDelivery(value: DeliveryAttempt): PublicDelivery {
  return {
    id: value.id,
    jobId: value.jobId,
    number: value.number,
    state: value.state,
    channelId: value.channelId,
    messageId: value.messageId,
    error: value.error,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
  };
}
function revision(value: unknown): number {
  const result = integer(value);
  if (result < 1) throw new TwitchError("invalid_input");
  return result;
}
function only(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new TwitchError("invalid_input");
}

export class TwitchRuntime {
  readonly hub: TwitchHubStore;
  readonly #resolveGuild: TwitchRuntimeOptions["resolveGuild"];
  readonly #rest: REST;
  readonly #clock: () => number;
  readonly #configuredGuildEnabled?: TwitchRuntimeOptions["configuredGuildEnabled"];
  readonly #provider?: TwitchProvider;
  readonly #dispatcher?: TwitchDispatcher;
  readonly #receiver?: EventSubReceiver;
  readonly #batchSize: number;
  #pump?: Promise<unknown>;
  #nextReconcileAt = 0;
  #closed = false;
  readonly configured: boolean;

  constructor(options: TwitchRuntimeOptions) {
    this.#resolveGuild = options.resolveGuild;
    this.#rest = options.publicationRest;
    this.#clock = options.clock ?? Date.now;
    this.#configuredGuildEnabled = options.configuredGuildEnabled;
    this.#batchSize = integer(options.batchSize ?? 20);
    if (this.#batchSize < 1 || this.#batchSize > 100) throw new TwitchError("invalid_input");
    this.hub = new TwitchHubStore(options.db, {
      clock: this.#clock,
      authorize: (request) => this.#authorize(request),
    });
    if (options.configuration && this.#rest.options?.retries === 0) {
      try {
        this.#provider = new TwitchProvider({
          ...options.configuration,
          ...options.providerOptions,
          store: this.hub,
          fetch: options.fetch,
          clock: this.#clock,
          activeBinding: (binding) => this.#eligibility(binding.guildId),
        });
        this.#receiver = new EventSubReceiver({
          secret: options.configuration.webhookSecret,
          store: this.hub,
          clock: this.#clock,
        });
        this.#dispatcher = new TwitchDispatcher({
          store: this.hub,
          lookupLive: (id) => this.#provider!.getLive(id),
          authorize: (request) => this.#authorize(request),
          enqueue: (job) => {
            const target = this.#guild(job.guildId, true);
            return target.jobs.enqueue(job);
          },
        });
      } catch {
        this.#provider?.close();
      }
    }
    this.configured = Boolean(this.#provider && this.#receiver && this.#dispatcher);
  }
  capability(guildId: string): ModuleCapability {
    const target = this.#resolve(guildId);
    return buildCapabilities(
      this.configured
        ? {
            integrations: !target
              ? "degraded"
              : target.settings.read().enabled.integrations
                ? "enabled"
                : "available",
          }
        : {},
      this.configured ? ["integrations"] : [],
    ).modules.find((value) => value.key === "integrations")!;
  }
  #resolve(guildId: string): TwitchGuildRuntime | undefined {
    const target = this.#resolveGuild(guildId);
    return target?.context.guild.id === guildId ? target : undefined;
  }
  #eligibility(guildId: string): boolean | undefined {
    try {
      return this.#configuredGuildEnabled
        ? this.#configuredGuildEnabled(guildId)
        : this.#resolve(guildId)?.settings.read().enabled.integrations;
    } catch {
      return undefined;
    }
  }
  #guild(guildId: string, publication = false): TwitchGuildRuntime {
    const target = this.#resolve(discordId(guildId));
    if (!target) {
      if (this.#eligibility(guildId) === false) throw new TwitchError("permission_revoked");
      throw new ControlError(
        503,
        "guild_unavailable",
        "Serwer nie jest teraz dostępny. Spróbuj ponownie za chwilę.",
      );
    }
    if (
      publication &&
      (this.#eligibility(guildId) === false || !target.settings.read().enabled.integrations)
    )
      throw new TwitchError("permission_revoked");
    if (publication && (!target.context.guild.available || !target.context.client.isReady()))
      throw new ControlError(
        503,
        "discord_unavailable",
        "Nie ma teraz połączenia z serwerem Discorda.",
      );
    return target;
  }
  #ready(): void {
    if (!this.configured || this.#closed)
      throw new ControlError(
        409,
        "module_unavailable",
        "Powiadomienia Twitch nie są jeszcze skonfigurowane.",
      );
  }
  async #target(
    guildId: string,
    actorId: string,
    operation: string,
    channelId?: string,
    roleIds: readonly string[] = [],
    everyone = false,
    publication = false,
  ): Promise<void> {
    const target = this.#guild(guildId, publication);
    let current: Awaited<ReturnType<typeof freshMember>>;
    try {
      current = await freshMember(target.context.guild, actorId);
    } catch (error) {
      if (error instanceof ControlError && error.code === "permission_revoked")
        throw new TwitchError("permission_revoked");
      throw error;
    }
    try {
      requirePermission(operation, current.facts, target.settings.policy(), { guildId });
    } catch (error) {
      if (error instanceof ModulePermissionError) throw new TwitchError("permission_revoked");
      throw error;
    }
    if (!channelId) return;
    const channel = await current.guild.channels
      .fetch(channelId, { force: true })
      .catch((error: unknown) => {
        if (isDiscordChannelUnavailable(error)) throw new TwitchError("channel_unavailable");
        throw error;
      });
    const me = await current.guild.members.fetchMe({ force: true }).catch((error: unknown) => {
      if (discordErrorCode(error) === 10007) throw new TwitchError("permission_revoked");
      throw error;
    });
    if (
      !channel ||
      channel.guildId !== guildId ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
      !channel.permissionsFor(current.member)?.has([P.ViewChannel, P.SendMessages]) ||
      !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory])
    )
      throw new TwitchError("channel_unavailable");
    const mention = Boolean(
      channel.permissionsFor(current.member)?.has(P.MentionEveryone) &&
      channel.permissionsFor(me)?.has(P.MentionEveryone),
    );
    for (const id of roleIds) {
      const role = current.roles.get(id);
      if (!role || id === guildId || (!role.mentionable && !mention))
        throw new TwitchError("permission_revoked");
    }
    if (everyone && !mention) throw new TwitchError("permission_revoked");
    this.#guild(guildId, publication);
  }
  async #authorize(request: TwitchAuthorization): Promise<void> {
    this.#ready();
    await this.#target(
      request.guildId,
      request.actorId,
      request.operation === "publish" ? "integrations.create" : `integrations.${request.operation}`,
      request.channelId,
      request.roleIds,
      request.mentionEveryone,
      request.operation === "publish",
    );
  }
  #history(target: TwitchGuildRuntime, bindingId: string) {
    const jobs = target.jobs
      .list({ guildId: target.context.guild.id, objectId: bindingId, limit: 100 })
      .filter((value) => ["twitch.send", "twitch.test"].includes(value.type));
    return {
      jobs: jobs.map(publicJob),
      deliveries: jobs.flatMap((value) => target.jobs.attempts(value.id).map(publicDelivery)),
    };
  }
  #view(target: TwitchGuildRuntime, binding: TwitchBinding) {
    const source = this.hub.source(binding.broadcasterId);
    return {
      integration: binding,
      source: source
        ? {
            broadcasterId: source.broadcasterId,
            status: source.status,
            reason: source.reason,
            lastEventAt: source.lastEventAt,
          }
        : null,
      ...this.#history(target, binding.id),
    };
  }
  #cancelOldJobs(target: TwitchGuildRuntime, bindingId: string): void {
    const current = this.hub.binding(bindingId);
    if (!current || current.guildId !== target.context.guild.id) return;
    while (true) {
      const rows = target.jobs.db
        .prepare(
          "SELECT id FROM jobs WHERE guild_id=? AND object_id=? AND type IN ('twitch.send','twitch.test') AND state IN ('pending','retry','running','unknown') AND cancel_requested=0 AND (?=1 OR generation<?) LIMIT 500",
        )
        .all(
          current.guildId,
          bindingId,
          Number(current.removed || !current.enabled),
          current.generation,
        );
      if (!rows.length) break;
      for (const value of rows) target.jobs.cancel(String(value.id));
    }
  }
  async request(
    actor: MemberFacts,
    operation: ControlOperation,
    input: unknown,
    objectId?: string,
    requestId?: string,
  ): Promise<unknown> {
    try {
      this.#ready();
      const target = this.#guild(actor.guildId),
        payload = record(input);
      if (!operation.startsWith("integrations."))
        throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
      if (operation === "integrations.list") {
        only(payload, []);
        const bindings = await this.hub.listBindings(actor.guildId, actor.userId);
        return { integrations: bindings.map((value) => this.#view(target, value)) };
      }
      if (operation === "integrations.lookup") {
        only(payload, ["login"]);
        await this.#target(actor.guildId, actor.userId, operation);
        const broadcaster = await this.#provider!.lookupBroadcaster(text(payload.login, 25));
        await this.#target(actor.guildId, actor.userId, operation);
        return { broadcaster };
      }
      if (operation === "integrations.create")
        return {
          integration: await this.hub.createBinding(
            actor.guildId,
            actor.userId,
            text(requestId, 128),
            payload,
          ),
        };
      const id = text(objectId);
      if (operation === "integrations.read") {
        only(payload, []);
        return this.#view(target, await this.hub.getBinding(actor.guildId, actor.userId, id));
      }
      if (operation === "integrations.update") {
        only(payload, ["revision", "draft"]);
        const integration = await this.hub.updateBinding(
          actor.guildId,
          actor.userId,
          text(requestId, 128),
          id,
          revision(payload.revision),
          record(payload.draft),
        );
        this.#cancelOldJobs(target, id);
        return { integration };
      }
      if (operation === "integrations.remove") {
        only(payload, ["revision"]);
        const integration = await this.hub.removeBinding(
          actor.guildId,
          actor.userId,
          text(requestId, 128),
          id,
          revision(payload.revision),
        );
        this.#cancelOldJobs(target, id);
        return { integration };
      }
      if (operation === "integrations.test") {
        only(payload, ["revision"]);
        const binding = await this.hub.getBinding(actor.guildId, actor.userId, id);
        await this.#target(
          actor.guildId,
          actor.userId,
          operation,
          binding.channelId,
          [],
          false,
          true,
        );
        return target.jobs.idempotent(
          `${actor.guildId}:twitch-test`,
          text(requestId, 128),
          { actorId: actor.userId, bindingId: id, revision: payload.revision },
          () => {
            const current = this.hub.binding(id);
            if (!current || current.removed || current.guildId !== actor.guildId)
              throw new TwitchError("not_found");
            if (
              current.revision !== revision(payload.revision) ||
              current.generation !== binding.generation
            )
              throw new TwitchError("revision_conflict");
            const count = target.jobs.db
              .prepare(
                "SELECT COUNT(*) AS count FROM jobs WHERE guild_id=? AND type='twitch.test' AND created_at>?",
              )
              .get(actor.guildId, this.#clock() - 60000);
            if (Number(count?.count) >= 3)
              throw new ControlError(
                429,
                "limit_exceeded",
                "Odczekaj chwilę przed następną próbą.",
              );
            const now = integer(this.#clock());
            const job = target.jobs.enqueue({
              guildId: actor.guildId,
              objectId: id,
              generation: current.generation,
              type: "twitch.test",
              dueAt: now,
              expiresAt: now + 300000,
              dedupeKey: `twitch:test:${digest({ guildId: actor.guildId, actorId: actor.userId, requestId })}`,
              payload: { bindingId: id, generation: current.generation, testActorId: actor.userId },
            });
            return { integration: current, job: publicJob(job) };
          },
        );
      }
      throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
    } catch (error) {
      throw this.#controlError(error);
    }
  }
  receive(request: EventSubRequest): WebhookResponse {
    return !this.#closed && this.configured && this.#receiver
      ? this.#receiver.receive(request)
      : { status: 503, body: "" };
  }
  pump(): Promise<unknown> {
    if (!this.configured || this.#closed) return Promise.resolve({ availability: "planned" });
    if (!this.#pump)
      this.#pump = (async () => {
        let reconciliation: unknown = null;
        if (this.#clock() >= this.#nextReconcileAt) {
          this.#nextReconcileAt = this.#clock() + 60000;
          reconciliation = await this.#provider!.reconcile();
        }
        const dispatch = await this.#dispatcher!.drain(this.#batchSize);
        return { reconciliation, dispatch };
      })().finally(() => {
        this.#pump = undefined;
      });
    return this.#pump;
  }
  #activeJob(job: Job, target: TwitchGuildRuntime): Job {
    const current = target.jobs.get(job.id);
    if (
      !current ||
      current.guildId !== job.guildId ||
      current.type !== job.type ||
      current.state !== "running" ||
      current.leaseToken !== job.leaseToken ||
      current.leaseUntil === null ||
      current.leaseUntil <= this.#clock() ||
      current.cancelRequested ||
      (current.expiresAt !== null && current.expiresAt <= this.#clock())
    )
      throw new ControlError(409, "expired", "To zadanie nie jest już aktualne.");
    return current;
  }
  async execute(job: Job, execution: ExecutionContext): Promise<ExecutionOutcome> {
    if (!["twitch.send", "twitch.test"].includes(job.type))
      return { state: "failed", error: "unsupported_job" };
    try {
      this.#ready();
      const target = this.#guild(job.guildId, true),
        persisted = this.#activeJob(job, target),
        payload = record(persisted.payload),
        bindingId = text(payload.bindingId);
      const binding = this.hub.binding(bindingId);
      if (
        !binding ||
        binding.guildId !== job.guildId ||
        binding.id !== job.objectId ||
        binding.removed ||
        binding.generation !== persisted.generation ||
        payload.generation !== persisted.generation
      )
        return { state: "expired", reason: "binding_changed" };
      const prior = target.jobs
        .attempts(job.id)
        .find((value) => value.state === "succeeded" && value.messageId);
      if (prior?.messageId) return { state: "succeeded", messageId: prior.messageId };
      const streamId = job.type === "twitch.send" ? text(record(payload.stream).id) : null;
      const prepare = async (): Promise<Publication> => {
        this.#guild(job.guildId, true);
        this.#activeJob(job, target);
        const current = this.hub.binding(bindingId);
        if (
          !current ||
          current.guildId !== job.guildId ||
          current.removed ||
          current.generation !== persisted.generation
        )
          throw new ControlError(409, "expired", "Powiązanie zmieniło się.");
        if (streamId) {
          const refreshed = await this.#dispatcher!.prepareDelivery(
            job.guildId,
            bindingId,
            persisted.generation,
            streamId,
          );
          if (!refreshed)
            throw new ControlError(409, "expired", "Ta transmisja nie jest już aktualna.");
          return {
            guildId: job.guildId,
            channelId: refreshed.channelId,
            content: refreshed.content,
            roleIds: refreshed.roleIds,
            everyone: refreshed.mentionEveryone,
          };
        }
        await this.#target(
          job.guildId,
          discordId(payload.testActorId),
          "integrations.test",
          current.channelId,
          [],
          false,
          true,
        );
        return {
          guildId: job.guildId,
          channelId: current.channelId,
          content:
            "Próba powiadomienia Twitch\n\nTo wiadomość próbna sprawdzająca ustawienia kanału. Nie dotyczy rzeczywistego startu transmisji.",
          roleIds: [],
          everyone: false,
        };
      };
      const publication = await prepare();
      return await publishDiscord(job.id, publication, execution, {
        check: async () => {
          Object.assign(publication, await prepare());
          this.#activeJob(job, target);
        },
        send: async (value, options) => {
          this.#guild(job.guildId, true);
          this.#activeJob(job, target);
          const current = this.hub.binding(bindingId);
          if (!current || current.removed || current.generation !== persisted.generation)
            throw new ControlError(409, "expired", "Powiązanie zmieniło się.");
          return this.#rest.post(Routes.channelMessages(value.channelId), {
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)]),
            body: {
              content: value.content,
              nonce: options.nonce,
              enforce_nonce: true,
              allowed_mentions: {
                parse: value.everyone ? ["everyone"] : [],
                roles: value.roleIds,
                users: [],
                replied_user: false,
              },
            },
          }) as Promise<{ id: string }>;
        },
      });
    } catch (error) {
      if (error instanceof TwitchProviderError && error.code === "rate_limited")
        return {
          state: "retry",
          at: Math.max(execution.now() + 1000, error.retryAt ?? execution.now() + 5000),
          error: "twitch_rate_limit",
          rateLimited: true,
        };
      if (error instanceof TwitchError) return { state: "failed", error: error.code };
      if (error instanceof ControlError && error.status < 500)
        return error.code === "expired"
          ? { state: "expired", reason: error.code }
          : { state: "failed", error: error.code };
      throw error;
    }
  }
  close(): void {
    this.#closed = true;
    this.#provider?.close();
  }
  #controlError(error: unknown): unknown {
    if (error instanceof TwitchError)
      return new ControlError(
        ["permission_revoked", "channel_unavailable"].includes(error.code)
          ? 403
          : error.code === "not_found"
            ? 404
            : ["revision_conflict", "idempotency_conflict", "binding_exists"].includes(error.code)
              ? 409
              : 400,
        error.code,
        error.code === "not_found"
          ? "Nie znaleziono powiązania."
          : error.code === "permission_revoked"
            ? "Potrzebujesz uprawnienia Zarządzanie serwerem."
            : error.code === "channel_unavailable"
              ? "Sprawdź kanał publikacji i jego uprawnienia."
              : "Sprawdź ustawienia powiadomień Twitch.",
      );
    if (error instanceof JobError)
      return new ControlError(
        error.code === "invalid_input" ? 400 : 409,
        error.code,
        "Stan zadania zmienił się. Wczytaj aktualny widok.",
      );
    if (error instanceof TwitchProviderError)
      return new ControlError(503, error.code, "Nie ma teraz połączenia z Twitchem.");
    return error;
  }
}
