import { ChannelType, PermissionFlagsBits as P, REST, Routes } from "discord.js";
import type { BotContext } from "./context.js";
import {
  discordErrorCode,
  freshMember,
  isDiscordChannelUnavailable,
} from "./module-permissions.js";
import { controlResources } from "./control.js";
import { CommunityRuntime } from "./community-runtime.js";
import type { TwitchRuntime } from "./twitch-runtime.js";
import { ServerRulesRuntime } from "./server-rules-runtime.js";
import type { AnnouncementAssetPort } from "../modules/announcement-assets/types.js";
import { AnnouncementAssetError } from "../modules/announcement-assets/types.js";
import { JobStore } from "../core/jobs/store.js";
import { JobError, type DeliveryAttempt, type Job } from "../core/jobs/types.js";
import type { ExecutionContext, ExecutionOutcome } from "../core/jobs/runner.js";
import {
  publishDiscord,
  publicationPresentation,
  type DeliveryTransport,
} from "../core/delivery/discord.js";
import { ModuleSettingsStore, parseModuleSettings, newModules } from "../core/modules/settings.js";
import {
  canPerform,
  ModulePermissionError,
  requirePermission,
  type MemberFacts,
} from "../core/permissions.js";
import { AnnouncementService } from "../modules/announcements/service.js";
import { AnnouncementDeliveryResolution } from "../modules/announcements/delivery-resolution.js";
import { announcementDeliveryAccess } from "./announcement-delivery.js";
import {
  publicManualDeliveryResolution,
  deliveryAttemptsFingerprint,
} from "../core/jobs/manual-delivery.js";
import {
  AnnouncementError,
  type AnnouncementAuthorization,
  type AnnouncementDraft,
  type AnnouncementMutation,
  type ScheduleInput,
} from "../modules/announcements/types.js";
import {
  nextOccurrences,
  normalizeSchedule,
  resolveLocalDateTime,
} from "../modules/announcements/schedule.js";
import {
  buildCapabilities,
  ControlError,
  type ControlOperation,
  type FeatureKey,
  type GuildResources,
  type ModuleStatus,
  type PublicDelivery,
  type PublicJob,
  type RuntimeCapabilities,
} from "../control/contracts.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ControlError(400, "invalid_input", "Sprawdź dane formularza.");
  return value as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new ControlError(400, "revision", "Wczytaj aktualną wersję wpisu.");
  return value as number;
}
function jobView(job: Job, attempts: readonly DeliveryAttempt[] = []): PublicJob {
  const manualResolution = publicManualDeliveryResolution(job.result, attempts);
  return {
    ...(attempts.length ? { attemptsFingerprint: deliveryAttemptsFingerprint(attempts) } : {}),
    ...(manualResolution ? { manualResolution } : {}),
    id: job.id,
    guildId: job.guildId,
    type: job.type,
    state: job.state,
    objectId: job.objectId,
    generation: job.generation,
    dueAt: job.dueAt,
    nextAttemptAt: job.nextAttemptAt,
    expiresAt: job.expiresAt,
    attempts: job.attempts,
    failures: job.failures,
    maxAttempts: job.maxAttempts,
    dedupeKey: job.dedupeKey,
    leaseUntil: job.leaseUntil,
    revision: job.revision,
    cancelRequested: job.cancelRequested,
    messageId: job.messageId,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function deliveryView(delivery: DeliveryAttempt): PublicDelivery {
  return {
    id: delivery.id,
    jobId: delivery.jobId,
    number: delivery.number,
    state: delivery.state,
    channelId: delivery.channelId,
    messageId: delivery.messageId,
    error: delivery.error,
    startedAt: delivery.startedAt,
    finishedAt: delivery.finishedAt,
  };
}
function mutationView(value: AnnouncementMutation) {
  return { ...value, job: value.job ? jobView(value.job) : null };
}

export class ModuleRuntime {
  readonly jobs: JobStore;
  readonly settings: ModuleSettingsStore;
  readonly announcements: AnnouncementService;
  readonly announcementDeliveries: AnnouncementDeliveryResolution;
  readonly community: CommunityRuntime;
  readonly rules: ServerRulesRuntime;
  private readonly transport: DeliveryTransport;

  constructor(
    readonly context: BotContext,
    publicationRest: REST,
    readonly beta = process.env.GILDIUSZ_BETA_MODULES === "1",
    private readonly integrations?: Pick<TwitchRuntime, "capability" | "request">,
    readonly announcementAssets?: AnnouncementAssetPort,
    memberEvents = process.env.GILDIUSZ_MEMBER_EVENTS === "1",
  ) {
    this.jobs = new JobStore(context.store.db);
    this.settings = new ModuleSettingsStore(context.store.db, context.guild.id);
    this.rules = new ServerRulesRuntime(
      context,
      this.jobs,
      this.settings,
      publicationRest,
      beta && memberEvents,
    );
    this.community = new CommunityRuntime(context, this.jobs, this.settings, publicationRest, beta);
    this.announcements = new AnnouncementService(this.jobs, {
      guildId: context.guild.id,
      authorize: (request) => this.authorizeAnnouncement(request),
      validateAsset: (id) => {
        if (!announcementAssets) throw new AnnouncementError("invalid_input");
        return announcementAssets.validateAsset(id);
      },
      onSaved: (announcement) => announcementAssets?.syncAnnouncement(announcement),
    });
    this.announcementDeliveries = new AnnouncementDeliveryResolution(this.jobs, {
      guildId: context.guild.id,
      botId: context.environment?.clientId ?? context.client?.user?.id ?? "",
      ...announcementDeliveryAccess(context, this.settings, publicationRest),
      audit: (jobId, resolution) =>
        context.store.event("announcement-delivery-resolution", jobId, JSON.stringify(resolution)),
    });
    this.transport = {
      check: async (publication) => {
        const channel = await context.guild.channels
          .fetch(publication.channelId, { force: true })
          .catch((error: unknown) => {
            if (isDiscordChannelUnavailable(error))
              throw new AnnouncementError("channel_unavailable");
            throw error;
          });
        const me = await context.guild.members.fetchMe({ force: true }).catch((error: unknown) => {
          if (discordErrorCode(error) === 10007) throw new AnnouncementError("permission_revoked");
          throw error;
        });
        if (
          publication.guildId !== context.guild.id ||
          !channel ||
          channel.guildId !== context.guild.id ||
          ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
          !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]) ||
          (publication.card && !channel.permissionsFor(me)?.has(P.EmbedLinks)) ||
          (publication.attachments?.length && !channel.permissionsFor(me)?.has(P.AttachFiles))
        )
          throw Object.assign(new Error("publication_channel_unavailable"), { status: 403 });
      },
      send: async (publication, options) => {
        const message = (await publicationRest.post(Routes.channelMessages(publication.channelId), {
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)]),
          body: {
            content: publication.content,
            ...publicationPresentation(publication),
            nonce: options.nonce,
            enforce_nonce: options.enforceNonce,
            allowed_mentions: {
              parse: publication.everyone ? ["everyone"] : [],
              roles: publication.roleIds,
              users: [],
              replied_user: false,
            },
          },
          ...(publication.attachments?.length
            ? {
                files: publication.attachments.map((file) => ({
                  name: file.name,
                  contentType: file.contentType,
                  data: Buffer.from(file.data),
                })),
              }
            : {}),
        })) as { id: string };
        return message;
      },
    };
  }

  capabilities() {
    const configuration = this.context.control;
    const states = Object.fromEntries(
      Object.entries(configuration.modules).map(([key, value]) => [
        key,
        value ? "enabled" : "available",
      ]),
    ) as Partial<Record<FeatureKey, ModuleStatus>>;
    const implemented: FeatureKey[] = ["rooms", "reactions", "files", "reports"];
    if (this.rules.effectsReady) {
      implemented.push("rules");
      states.rules = this.rules.status();
    }
    if (this.beta) {
      implemented.push("announcements");
      states.announcements = this.settings.read().enabled.announcements ? "enabled" : "available";
    }
    if (this.community.effectsReady) {
      implemented.push("meetings", "cases");
      states.meetings = this.community.status("meetings");
      states.cases = this.community.status("cases");
    }
    const capabilities = buildCapabilities(states, implemented);
    capabilities.modules = capabilities.modules.filter((module) => module.key !== "music");
    if (this.beta && this.integrations)
      capabilities.modules = capabilities.modules.map((module) =>
        module.key === "integrations"
          ? this.integrations!.capability(this.context.guild.id)
          : module,
      );
    return capabilities;
  }

  async capabilitiesView(actorId: string): Promise<RuntimeCapabilities> {
    try {
      const { guild, member, roles, facts } = await freshMember(this.context.guild, actorId);
      const policy = this.settings.policy();
      requirePermission("capabilities.read", facts, policy);
      const raw = await controlResources(guild);
      const channels = guild.channels.cache;
      const resources: GuildResources = {
        ...raw,
        channels: raw.channels.filter((channel) =>
          channels.get(channel.id)?.permissionsFor(member)?.has(P.ViewChannel),
        ),
        roles: raw.roles.filter((role) => roles.has(role.id)),
      };
      const me = await guild.members.fetchMe({ force: true });
      const publicationChannels = raw.channels
        .map((channel) => channels.get(channel.id))
        .filter((channel) => channel !== undefined)
        .filter(
          (channel) =>
            [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) &&
            channel.permissionsFor(member)?.has([P.ViewChannel, P.SendMessages]) &&
            channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]),
        );
      // These are selection hints; each write rechecks permissions in its chosen channel.
      const everyone = publicationChannels.some(
        (channel) =>
          channel.permissionsFor(member)?.has(P.MentionEveryone) &&
          channel.permissionsFor(me)?.has(P.MentionEveryone),
      );
      const roleIds = [...roles.values()]
        .filter(
          (role) =>
            role.id !== guild.id &&
            publicationChannels.length > 0 &&
            (role.mentionable || everyone),
        )
        .map((role) => role.id);
      const available: ControlOperation[] = [
        "capabilities.read",
        "settings.read",
        "settings.save",
        "jobs.list",
        "jobs.read",
        "jobs.cancel",
        "deliveries.list",
      ];
      if (this.beta)
        available.push(
          "announcements.list",
          "announcements.read",
          "announcements.delivery.inspect",
          "announcements.delivery.resolve",
          "announcements.pause",
          "announcements.cancel",
          "announcements.remove",
        );
      if (this.beta && this.settings.read().enabled.announcements)
        available.push(
          "announcements.create",
          "announcements.update",
          "announcements.preview",
          "announcements.test",
          "announcements.resume",
        );
      if (this.beta && this.settings.read().enabled.announcements && this.announcementAssets)
        available.push("announcements.assets.upload", "announcements.assets.read");
      if (this.community.effectsReady) {
        if (this.settings.read().enabled.meetings)
          available.push("meetings.list", "meetings.create", "meetings.preview");
        if (this.settings.read().enabled.cases) available.push("cases.list", "cases.create");
      }
      if (this.beta && this.integrations?.capability(guild.id).availability === "available")
        available.push("integrations.list", "integrations.create");
      if (this.rules.effectsReady)
        available.push(
          "rules.read",
          "rules.configure",
          "rules.publish",
          "rules.acceptances.list",
          "rules.publications.reconcile",
        );
      const permissions = available.filter((operation) =>
        canPerform(operation, facts, policy, { guildId: guild.id }),
      );
      return {
        ...this.capabilities(),
        ...(this.beta ? { announcementEditor: { cards: true, links: true, drafts: true } } : {}),
        ...(this.beta ? { announcementReconciliation: { version: 1 as const } } : {}),
        resources,
        announcementAssets: {
          available: Boolean(
            this.beta && this.settings.read().enabled.announcements && this.announcementAssets,
          ),
          maxBytes: 2097152,
          maxWidth: 2048,
          maxHeight: 2048,
          mediaTypes: ["image/png", "image/jpeg", "image/webp"],
        },
        permissions,
        mentionPermissions: { roleIds, everyone },
        ...(canPerform("settings.read", facts, policy)
          ? { moduleSettings: this.settings.read() }
          : {}),
      };
    } catch (error) {
      throw this.controlError(error);
    }
  }

  sync(): void {
    if (this.beta) this.announcementDeliveries.syncReceipts();
    if (this.beta && this.settings.read().enabled.announcements) this.announcements.sync();
  }

  async request(
    actor: MemberFacts,
    operation: ControlOperation,
    input: unknown,
    objectId?: string,
    requestId?: string,
  ): Promise<unknown> {
    const policy = this.settings.policy();
    try {
      if (operation.startsWith("rules.")) {
        requirePermission(operation, actor, policy, { guildId: this.context.guild.id });
        return await this.rules.request(actor.userId, operation, input, objectId, requestId);
      }
      if (operation.startsWith("integrations.")) {
        if (!this.beta || !this.integrations)
          throw new ControlError(
            409,
            "module_unavailable",
            "Powiadomienia Twitch nie są jeszcze dostępne.",
          );
        return await this.integrations.request(actor, operation, input, objectId, requestId);
      }
      if (operation.startsWith("meetings.") || operation.startsWith("cases."))
        return await this.community.request(actor, operation, input, objectId, requestId);
      requirePermission("capabilities.read", actor, policy);
      if (operation === "capabilities.read") {
        requirePermission(operation, actor, policy);
        return await this.capabilitiesView(actor.userId);
      }
      if (operation === "settings.read") {
        requirePermission(operation, actor, policy);
        return { moduleSettings: this.settings.read(), capabilities: this.capabilities() };
      }
      const payload = object(input);
      if (
        operation === "announcements.assets.upload" ||
        operation === "announcements.assets.read"
      ) {
        const authorize = () =>
          this.authorizeAnnouncement({
            guildId: actor.guildId,
            actorId: actor.userId,
            operation: "preview",
          });
        await authorize();
        if (!this.announcementAssets)
          throw new ControlError(
            503,
            "asset_transport_unavailable",
            "Przesyłanie obrazów nie jest teraz dostępne.",
          );
        if (operation === "announcements.assets.upload") {
          if (
            Object.keys(payload).some((key) => !["mediaType", "dataBase64"].includes(key)) ||
            typeof payload.mediaType !== "string" ||
            typeof payload.dataBase64 !== "string" ||
            payload.dataBase64.length > 2796204 ||
            payload.dataBase64.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.dataBase64)
          )
            throw new AnnouncementAssetError("invalid_asset");
          const data = Buffer.from(payload.dataBase64, "base64");
          if (data.toString("base64") !== payload.dataBase64)
            throw new AnnouncementAssetError("invalid_asset");
          return {
            asset: await this.announcementAssets.upload(
              actor.userId,
              requestId!,
              payload.mediaType,
              data,
              authorize,
            ),
          };
        }
        if (Object.keys(payload).length) throw new AnnouncementAssetError("invalid_asset");
        const asset = this.announcementAssets.describeAsset(objectId!),
          data = await this.announcementAssets.readAsset(objectId!);
        await authorize();
        return { asset, dataBase64: Buffer.from(data.data).toString("base64") };
      }
      if (operation === "settings.save") {
        requirePermission(operation, actor, policy);
        if (payload.scope !== "modules" || !requestId)
          throw new ControlError(400, "settings_scope", "Wskaż zakres zapisywanych ustawień.");
        const draft = parseModuleSettings(payload.settings);
        if (
          newModules.some(
            (key) =>
              draft.enabled[key] &&
              this.capabilities().modules.find((module) => module.key === key)?.availability !==
                "available",
          )
        )
          throw new ControlError(
            409,
            "module_unavailable",
            "Ta funkcja nie jest jeszcze dostępna na tym serwerze.",
          );
        await this.community.validateSettings(actor.userId, draft);
        const roles = await this.context.guild.roles.fetch();
        for (const id of [
          ...draft.organizerRoleIds,
          ...draft.caseModeratorRoleIds,
          ...draft.announcementManagerRoleIds,
          ...draft.djRoleIds,
        ])
          if (!roles.has(id) || id === this.context.guild.id || roles.get(id)?.managed)
            throw new ControlError(
              400,
              "roles",
              "Wybrana rola nie jest rolą uczestników tego serwera.",
            );
        return this.jobs.idempotent(
          `${actor.guildId}:module-settings`,
          requestId,
          { actor: actor.userId, draft },
          () => {
            const previous = this.settings.read();
            const saved = this.settings.save(draft, actor.userId);
            this.community.settingsChanged(actor.userId, previous, saved);
            if (!saved.enabled.integrations) {
              const pending = this.jobs.db
                .prepare(
                  "SELECT id FROM jobs WHERE guild_id=? AND type IN ('twitch.send','twitch.test') AND state IN ('pending','retry','running','unknown') AND cancel_requested=0",
                )
                .all(actor.guildId);
              for (const job of pending) this.jobs.cancel(String(job.id));
            }
            if (!saved.enabled.announcements)
              for (const job of this.jobs.list({
                guildId: actor.guildId,
                type: "announcement.send",
                states: ["pending", "retry", "running"],
                limit: 500,
              }))
                this.jobs.cancel(job.id);
            for (const module of ["meetings", "cases"] as const)
              if (!saved.enabled[module])
                for (const job of this.jobs.list({
                  guildId: actor.guildId,
                  states: ["pending", "retry", "running", "unknown"],
                  limit: 500,
                }))
                  if (
                    module === "meetings"
                      ? job.type.startsWith("meeting.")
                      : ["case.notify", "community.case-channel"].includes(job.type)
                  )
                    this.jobs.cancel(job.id);
            this.context.store.event(
              "module-settings",
              actor.guildId,
              `revision:${saved.revision};actor:${actor.userId}`,
            );
            return { moduleSettings: saved, capabilities: this.capabilities() };
          },
        );
      }
      if (operation.startsWith("jobs.") || operation === "deliveries.list") {
        // Authorize module entry before looking up an object, including missing objects.
        requirePermission("jobs.list", actor, policy);
        const job = objectId ? this.jobs.get(objectId) : undefined;
        if (
          objectId &&
          (!job || job.guildId !== actor.guildId || this.jobs.isHistoryRetired(objectId))
        )
          throw new ControlError(404, "not_found", "Nie znaleziono zadania.");
        requirePermission(operation, actor, policy, job ? { guildId: job.guildId } : undefined);
        if (operation === "jobs.list")
          return {
            jobs: this.jobs
              .list({ guildId: actor.guildId, limit: 100 })
              .map((job) => jobView(job, this.jobs.attempts(job.id))),
          };
        if (operation === "deliveries.list")
          return {
            deliveries: this.jobs
              .list({ guildId: actor.guildId, limit: 100 })
              .flatMap((value) => this.jobs.attempts(value.id).map(deliveryView)),
          };
        if (operation === "jobs.read")
          return {
            job: jobView(job!, this.jobs.attempts(job!.id)),
            attempts: this.jobs.attempts(job!.id).map(deliveryView),
          };
        if (operation === "jobs.cancel" && requestId)
          return this.jobs.idempotent(
            `${actor.guildId}:job-cancel`,
            requestId,
            { id: objectId, actor: actor.userId, revision: payload.revision },
            () => {
              if (revision(payload.revision) !== job!.revision)
                throw new ControlError(
                  409,
                  "conflict",
                  "Stan zadania zmienił się. Wczytaj aktualną wersję.",
                );
              return { job: jobView(this.jobs.cancel(job!.id)!) };
            },
          );
        throw new ControlError(
          409,
          "reconciliation_required",
          "Wynik wysyłki wymaga sprawdzenia przed ponowieniem.",
        );
      }
      if (!operation.startsWith("announcements."))
        throw new ControlError(
          409,
          "module_unavailable",
          "Ta funkcja jest jeszcze w przygotowaniu.",
        );
      const historical = [
        "announcements.list",
        "announcements.read",
        "announcements.delivery.inspect",
        "announcements.delivery.resolve",
        "announcements.pause",
        "announcements.cancel",
        "announcements.remove",
      ].includes(operation);
      if (!this.beta) throw new AnnouncementError("permission_revoked");
      if (!historical) this.requireAnnouncements();
      switch (operation) {
        case "announcements.delivery.inspect":
          return await this.announcementDeliveries.preview(actor.userId, objectId!, payload);
        case "announcements.delivery.resolve":
          return await this.announcementDeliveries.resolve(
            actor.userId,
            requestId!,
            objectId!,
            payload,
          );
        case "announcements.list":
          this.announcementDeliveries.syncReceipts();
          return {
            announcements: await this.announcements.list(actor.userId, {
              sync: this.settings.read().enabled.announcements,
            }),
          };
        case "announcements.read": {
          this.announcementDeliveries.syncReceipts();
          const announcement = await this.announcements.get(actor.userId, objectId!, {
            sync: this.settings.read().enabled.announcements,
          });
          const jobs = this.jobs.list({
            guildId: actor.guildId,
            type: "announcement.send",
            objectId: announcement.id,
            limit: 100,
          });
          return {
            announcement,
            jobs: jobs.map((job) => jobView(job, this.jobs.attempts(job.id))),
            deliveries: jobs.flatMap((job) => this.jobs.attempts(job.id).map(deliveryView)),
          };
        }
        case "announcements.preview": {
          if (payload.draft !== undefined) {
            if (Object.keys(payload).some((key) => key !== "draft"))
              throw new AnnouncementError("invalid_input");
            return {
              message: await this.announcements.previewMessage(
                actor.userId,
                object(payload.draft) as unknown as AnnouncementDraft,
              ),
            };
          }
          await this.authorizeAnnouncement({
            guildId: actor.guildId,
            actorId: actor.userId,
            operation: "preview",
          });
          if (Object.keys(payload).some((key) => key !== "schedule"))
            throw new AnnouncementError("invalid_input");
          const input = object(payload.schedule);
          const now = Date.now();
          let scheduleInput: ScheduleInput;
          if (input.kind === "once" && "date" in input) {
            if (
              Object.keys(input).some(
                (key) => !["kind", "date", "time", "timeZone"].includes(key),
              ) ||
              typeof input.date !== "string" ||
              typeof input.time !== "string" ||
              typeof input.timeZone !== "string"
            )
              throw new AnnouncementError("invalid_input");
            const occurrence = resolveLocalDateTime(input.date, input.time, input.timeZone);
            scheduleInput = { kind: "once", at: occurrence.at };
            const schedule = normalizeSchedule(scheduleInput, now);
            return {
              schedule,
              occurrences: nextOccurrences(schedule, now).map(() => ({
                ...occurrence,
              })),
            };
          }
          scheduleInput = input as unknown as ScheduleInput;
          const schedule = normalizeSchedule(scheduleInput, now);
          return { schedule, occurrences: nextOccurrences(schedule, now) };
        }
        case "announcements.create":
          return mutationView(
            await this.announcements.create(
              actor.userId,
              requestId!,
              payload as unknown as AnnouncementDraft,
            ),
          );
        case "announcements.update":
          return mutationView(
            await this.announcements.update(
              actor.userId,
              requestId!,
              objectId!,
              revision(payload.revision),
              object(payload.draft) as unknown as AnnouncementDraft,
            ),
          );
        case "announcements.pause":
          return mutationView(
            await this.announcements.pause(
              actor.userId,
              requestId!,
              objectId!,
              revision(payload.revision),
            ),
          );
        case "announcements.resume":
          return mutationView(
            await this.announcements.resume(
              actor.userId,
              requestId!,
              objectId!,
              revision(payload.revision),
            ),
          );
        case "announcements.cancel":
          return mutationView(
            await this.announcements.cancel(
              actor.userId,
              requestId!,
              objectId!,
              revision(payload.revision),
            ),
          );
        case "announcements.test":
          return mutationView(
            await this.announcements.test(
              actor.userId,
              requestId!,
              objectId!,
              revision(payload.revision),
            ),
          );
        case "announcements.remove":
          if (Object.keys(payload).some((field) => field !== "revision"))
            throw new AnnouncementError("invalid_input");
          return await this.announcements.remove(
            actor.userId,
            requestId!,
            objectId!,
            revision(payload.revision),
          );
        default:
          throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
      }
    } catch (error) {
      throw this.controlError(error);
    }
  }

  async execute(job: Job, execution: ExecutionContext): Promise<ExecutionOutcome> {
    if (job.type.startsWith("server-rules.")) return this.rules.execute(job, execution);
    if (
      job.type.startsWith("meeting.") ||
      job.type.startsWith("case.") ||
      job.type.startsWith("community.")
    )
      return this.community.execute(job, execution);
    if (job.guildId !== this.context.guild.id || job.type !== "announcement.send")
      return { state: "failed", error: "unsupported_job" };
    try {
      const prepared = await this.announcements.prepare(job);
      const attachment = prepared.card?.imageAssetId
        ? await this.announcementAssets?.readAsset(prepared.card.imageAssetId)
        : undefined;
      if (prepared.card?.imageAssetId && !attachment) throw new AnnouncementError("invalid_input");
      // Asset IO must not let a cancelled generation or revoked editor reach delivery.
      if (attachment) await this.announcements.prepare(job);
      return await publishDiscord(
        job.id,
        {
          guildId: job.guildId,
          channelId: prepared.channelId,
          content: prepared.content,
          ...(prepared.card
            ? {
                card: {
                  title: prepared.card.title,
                  description: prepared.card.description,
                  color: prepared.card.color,
                  ...(attachment ? { image: { attachmentName: attachment.name } } : {}),
                },
              }
            : {}),
          links: prepared.links,
          ...(attachment ? { attachments: [attachment] } : {}),
          roleIds: prepared.roleIds,
          everyone: prepared.mentionEveryone,
        },
        execution,
        this.transport,
      );
    } catch (error) {
      if (
        error instanceof AnnouncementAssetError &&
        ["asset_not_found", "asset_expired", "invalid_asset"].includes(error.code)
      ) {
        this.announcements.markAssetUnavailable(job);
        return { state: "failed", error: "asset_unavailable" };
      }
      if (error instanceof AnnouncementError) {
        if (["stale_generation", "paused", "cancelled", "expired"].includes(error.code))
          return { state: "expired", reason: error.code };
        if (["permission_revoked", "channel_unavailable", "asset_unavailable"].includes(error.code))
          return { state: "failed", error: error.code };
      }
      throw error;
    }
  }

  private requireAnnouncements(): void {
    if (!this.beta || !this.settings.read().enabled.announcements)
      throw new AnnouncementError("permission_revoked", "Ogłoszenia są wyłączone na tym serwerze.");
  }

  private async authorizeAnnouncement(request: AnnouncementAuthorization): Promise<void> {
    if (!this.beta) throw new AnnouncementError("permission_revoked");
    if (!["read", "list", "pause", "cancel", "remove"].includes(request.operation))
      this.requireAnnouncements();
    let current: Awaited<ReturnType<typeof freshMember>>;
    try {
      current = await freshMember(this.context.guild, request.actorId);
    } catch (error) {
      if (error instanceof ControlError && error.code === "permission_revoked")
        throw new AnnouncementError("permission_revoked");
      throw error;
    }
    const { guild, member, roles, facts } = current;
    const action =
      request.operation === "deliver"
        ? "announcements.create"
        : `announcements.${request.operation}`;
    try {
      requirePermission(action, facts, this.settings.policy(), { guildId: request.guildId });
    } catch (error) {
      if (error instanceof ModulePermissionError) throw new AnnouncementError("permission_revoked");
      throw error;
    }
    if (!request.channelId) return;
    const channel = await guild.channels
      .fetch(request.channelId, { force: true })
      .catch((error: unknown) => {
        if (isDiscordChannelUnavailable(error)) throw new AnnouncementError("channel_unavailable");
        throw error;
      });
    const me = await guild.members.fetchMe({ force: true }).catch((error: unknown) => {
      if (discordErrorCode(error) === 10007) throw new AnnouncementError("permission_revoked");
      throw error;
    });
    if (
      !channel ||
      channel.guildId !== request.guildId ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
      !channel.permissionsFor(member)?.has([P.ViewChannel, P.SendMessages]) ||
      !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory])
    )
      throw new AnnouncementError("channel_unavailable");
    for (const [needed, permission] of [
      [request.hasCard, P.EmbedLinks],
      [request.hasImage, P.AttachFiles],
    ] as const)
      if (
        needed &&
        (!channel.permissionsFor(member)?.has(permission) ||
          !channel.permissionsFor(me)?.has(permission))
      )
        throw new AnnouncementError("permission_revoked");
    for (const id of request.roleIds ?? []) {
      const role = roles.get(id);
      if (
        !role ||
        id === request.guildId ||
        (!role.mentionable &&
          (!channel.permissionsFor(member)?.has(P.MentionEveryone) ||
            !channel.permissionsFor(me)?.has(P.MentionEveryone)))
      )
        throw new AnnouncementError("permission_revoked");
    }
    if (
      request.mentionEveryone &&
      (!channel.permissionsFor(member)?.has(P.MentionEveryone) ||
        !channel.permissionsFor(me)?.has(P.MentionEveryone))
    )
      throw new AnnouncementError("permission_revoked");
  }

  private controlError(error: unknown): unknown {
    if (error instanceof AnnouncementAssetError)
      return new ControlError(
        error.code === "asset_not_found"
          ? 404
          : error.code === "asset_expired"
            ? 410
            : error.code === "asset_storage_unavailable"
              ? 503
              : error.code === "asset_busy" || error.code === "asset_quota"
                ? 429
                : error.code === "idempotency_conflict"
                  ? 409
                  : 400,
        error.code,
        error.code === "asset_quota"
          ? "Brakuje miejsca na kolejne obrazy ogłoszeń."
          : error.code === "asset_expired"
            ? "Ten obraz wygasł. Prześlij go ponownie."
            : "Nie udało się odczytać lub zapisać obrazu ogłoszenia.",
      );
    if (error instanceof ModulePermissionError)
      return new ControlError(403, error.code, error.message);
    if (error instanceof JobError) {
      const status =
        error.code === "job_not_found" ? 404 : error.code === "invalid_input" ? 400 : 409;
      return new ControlError(
        status,
        error.code,
        status === 404
          ? "Nie znaleziono zadania."
          : status === 400
            ? "Sprawdź dane operacji."
            : "Stan operacji zmienił się. Wczytaj aktualną wersję.",
      );
    }
    if (error instanceof AnnouncementError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "limit_exceeded"
            ? 429
            : [
                  "revision_conflict",
                  "state_conflict",
                  "paused",
                  "cancelled",
                  "stale_generation",
                  "delivery_conflict",
                  "message_changed",
                  "already_resolved",
                ].includes(error.code)
              ? 409
              : error.code === "permission_revoked"
                ? 403
                : 400;
      const messages: Partial<Record<typeof error.code, string>> = {
        not_found: "Nie znaleziono ogłoszenia.",
        revision_conflict: "Ogłoszenie zmieniło się. Wczytaj aktualną wersję.",
        permission_revoked:
          "Sprawdź, czy ogłoszenia są włączone i czy masz dostęp do tej czynności.",
        channel_unavailable: "Sprawdź kanał i uprawnienia do publikacji.",
        invalid_input: "Sprawdź treść, kanał i termin ogłoszenia.",
        limit_exceeded: "Zwolnij na chwilę. Wykonano zbyt wiele operacji.",
        schedule_exhausted: "Harmonogram nie ma kolejnego terminu.",
      };
      return new ControlError(
        status,
        error.code,
        messages[error.code] ?? "Nie można teraz wykonać tej czynności dla ogłoszenia.",
      );
    }
    return error;
  }
}
