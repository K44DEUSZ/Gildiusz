import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  GuildFeature,
  PermissionFlagsBits as P,
  Routes,
  type Guild,
  type GuildMember,
  type REST,
} from "discord.js";
import type { BotContext } from "./context.js";
import {
  discordErrorCode,
  freshMember,
  isDiscordChannelUnavailable,
} from "./module-permissions.js";
import type { JobStore } from "../core/jobs/store.js";
import type { Job } from "../core/jobs/types.js";
import type { ModuleSettingsStore } from "../core/modules/settings.js";
import type { ExecutionContext, ExecutionOutcome } from "../core/jobs/runner.js";
import { ControlError, type ControlOperation, type ModuleStatus } from "../contracts/index.js";
import { reactionEmojiKey } from "../contracts/emoji.js";
import { ServerRulesService, RulesError } from "../modules/server-rules/service.js";
import {
  ServerRulesRetention,
  type RulesMembershipObservation,
} from "../modules/server-rules/retention.js";
import type {
  RulesAcceptance,
  RulesDraft,
  RulesMemberFacts,
  RulesPorts,
} from "../modules/server-rules/types.js";

const id = (value: unknown): value is string =>
  typeof value === "string" && /^\d{17,20}$/.test(value);
const timeout = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15000)]);
const screening = (guild: Guild) =>
  guild.features.includes(GuildFeature.MemberVerificationGateEnabled);
function pending(guild: Guild, member: GuildMember): boolean | null {
  return typeof member.pending === "boolean" ? member.pending : screening(guild) ? null : false;
}
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RulesError("invalid_input");
  return input as Record<string, unknown>;
}
function only(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new RulesError("invalid_input");
}

export function discordRulesPorts(
  context: BotContext,
  settings: ModuleSettingsStore,
  rest: REST,
): RulesPorts {
  const guildId = context.guild.id;
  return {
    administrator: async (userId) => {
      const observedAt = Date.now();
      const { guild, member, facts } = await freshMember(context.guild, userId);
      return {
        guildId: guild.id,
        userId: member.id,
        observedAt,
        owner: !member.user.bot && facts.owner,
        manageGuild: !member.user.bot && facts.manageGuild,
        pending: pending(guild, member),
        timedOut: member.isCommunicationDisabled(),
      };
    },
    preflight: async () => {
      const observedAt = Date.now();
      const guild = await context.guild.fetch(),
        roles = await guild.roles.fetch(),
        channels = await guild.channels.fetch(),
        me = await guild.members.fetchMe({ force: true }),
        policy = settings.read();
      const staffRoleIds = new Set([
        ...policy.organizerRoleIds,
        ...policy.caseModeratorRoleIds,
        ...policy.announcementManagerRoleIds,
        ...policy.djRoleIds,
      ]);
      for (const key of ["role.administration", "role.admin", "role.moderator"])
        if (context.store.resource(key)) staffRoleIds.add(context.store.resource(key)!.id);
      for (const role of roles.values())
        if (role.permissions.has(P.ManageGuild) || role.permissions.has(P.Administrator))
          staffRoleIds.add(role.id);
      return {
        guildId: guild.id,
        observedAt,
        nativeScreening: screening(guild),
        complete: [...channels.values()].every((channel) => channel !== null),
        roles: [...roles.values()].map((role) => ({
          guildId: role.guild.id,
          id: role.id,
          permissions: role.permissions.bitfield,
          position: role.position,
          managed: role.managed,
          restricted: Boolean(role.tags?.premiumSubscriberRole || role.tags?.availableForPurchase),
        })),
        channels: [...channels.values()].flatMap((channel) =>
          channel
            ? [
                {
                  guildId: channel.guildId,
                  id: channel.id,
                  type:
                    channel.type === ChannelType.GuildText ? ("text" as const) : ("other" as const),
                  overwrites: [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
                    id: overwrite.id,
                    type: overwrite.type === 0 ? ("role" as const) : ("member" as const),
                    allow: overwrite.allow.bitfield,
                    deny: overwrite.deny.bitfield,
                  })),
                },
              ]
            : [],
        ),
        botRoleIds: [...me.roles.cache.keys()],
        interestRoleIds: context.control.reactions.choices.map((choice) => choice.roleId),
        staffRoleIds: [...staffRoleIds],
        staffUserIds: [guild.ownerId],
      };
    },
    member: async (userId): Promise<RulesMemberFacts | null> => {
      const observedAt = Date.now();
      const guild = await context.guild.fetch();
      try {
        const member = await guild.members.fetch({ user: userId, force: true });
        return {
          guildId: guild.id,
          userId: member.id,
          observedAt,
          joinedAt: member.joinedTimestamp ?? 0,
          bot: member.user.bot,
          pending: pending(guild, member),
          timedOut: member.isCommunicationDisabled(),
          roleIds: [...member.roles.cache.keys()],
        };
      } catch (error) {
        if (discordErrorCode(error) === 10007) return null;
        throw error;
      }
    },
    message: async (channelId, messageId) => {
      try {
        const channel = await context.guild.channels.fetch(channelId, { force: true });
        if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText)
          return null;
        const message = await channel.messages.fetch({
          message: messageId,
          force: true,
          cache: false,
        });
        const buttons = message.components.flatMap((row) =>
          row.type === ComponentType.ActionRow
            ? row.components.filter(
                (component) =>
                  component.type === ComponentType.Button &&
                  component.style === ButtonStyle.Primary &&
                  !component.disabled &&
                  component.label === "Akceptuję regulamin" &&
                  component.customId?.startsWith("gildiusz:rules:"),
              )
            : [],
        );
        const button = buttons.length === 1 ? buttons[0] : null;
        return {
          guildId: message.guildId!,
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          webhookId: message.webhookId,
          content: message.content,
          controlId: button?.type === ComponentType.Button ? button.customId : null,
          reactionEmoji:
            message.reactions.cache.find((reaction) => reaction.me && !reaction.emoji.id)?.emoji
              .name ?? null,
        };
      } catch (error) {
        if (isDiscordChannelUnavailable(error) || discordErrorCode(error) === 10008) return null;
        throw error;
      }
    },
    sendPart: async (input) => {
      if (input.guildId !== guildId) throw new RulesError("permission_revoked");
      const response = record(
        await rest.post(Routes.channelMessages(input.channelId), {
          signal: timeout(input.signal),
          body: {
            content: input.content,
            components: input.controlId
              ? [
                  {
                    type: ComponentType.ActionRow,
                    components: [
                      {
                        type: ComponentType.Button,
                        style: ButtonStyle.Primary,
                        custom_id: input.controlId,
                        label: "Akceptuję regulamin",
                      },
                    ],
                  },
                ]
              : [],
            nonce: input.nonce,
            enforce_nonce: input.enforceNonce,
            allowed_mentions: input.allowedMentions,
          },
        }),
      );
      if (
        !id(response.id) ||
        response.channel_id !== input.channelId ||
        (response.guild_id !== undefined && response.guild_id !== guildId)
      )
        throw new RulesError("unknown_effect");
      return { guildId, channelId: input.channelId, messageId: response.id };
    },
    seedReaction: async (input) => {
      if (input.guildId !== guildId) throw new RulesError("permission_revoked");
      await rest.put(
        Routes.channelMessageOwnReaction(
          input.channelId,
          input.messageId,
          encodeURIComponent(input.emoji),
        ),
        { signal: timeout(input.signal) },
      );
    },
    addRole: async (input) => {
      if (input.guildId !== guildId) throw new RulesError("permission_revoked");
      await rest.put(Routes.guildMemberRole(guildId, input.userId, input.roleId), {
        signal: timeout(input.signal),
        reason: "Akceptacja aktualnej wersji regulaminu serwera",
      });
    },
    retireControls: async (input) => {
      if (input.guildId !== guildId) throw new RulesError("permission_revoked");
      await rest.patch(Routes.channelMessage(input.channelId, input.messageId), {
        signal: timeout(input.signal),
        body: { components: [], allowed_mentions: { parse: [], users: [], roles: [] } },
      });
    },
  };
}

export class ServerRulesRuntime {
  readonly service?: ServerRulesService;
  readonly retention?: ServerRulesRetention;
  private readonly ports?: RulesPorts;
  private readonly accepting = new Map<string, Promise<RulesAcceptance>>();
  private membershipSweepRunning = false;
  private nextMembershipSweepAt = 0;
  private membershipEpoch = 0;
  private readonly observingMembers = new Map<string, number>();
  private stopped = false;
  constructor(
    readonly context: BotContext,
    readonly jobs: JobStore,
    settings: ModuleSettingsStore,
    rest: REST,
    readonly effectsReady: boolean,
  ) {
    const bound =
      context.store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guild_identity'")
        .get() &&
      context.store.db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()
        ?.guild === context.guild.id;
    if (effectsReady || bound) {
      this.ports = discordRulesPorts(context, settings, rest);
      this.retention = new ServerRulesRetention(jobs, { guildId: context.guild.id });
    }
    if (effectsReady) {
      this.service = new ServerRulesService(jobs, {
        guildId: context.guild.id,
        botId: context.client.user!.id,
        ports: this.ports!,
      });
    }
  }
  status(): ModuleStatus {
    const settings = this.service?.settings();
    if (!settings?.enabled) return "available";
    return settings.activeVersionId ? "enabled" : "needs_configuration";
  }
  private ready(): ServerRulesService {
    if (!this.service || this.stopped)
      throw new ControlError(
        409,
        "module_unavailable",
        "Regulamin serwera nie jest jeszcze dostępny.",
      );
    return this.service;
  }
  async request(
    actorId: string,
    operation: ControlOperation,
    input: unknown,
    objectId?: string,
    requestId?: string,
  ) {
    try {
      const service = this.ready(),
        payload = record(input);
      if (operation === "rules.read") {
        only(payload, []);
        const overview = await service.inspect(actorId);
        return {
          ...overview,
          versions: overview.versions.slice(0, 5).map((version) => ({
            ...version,
            parts: service.parts(version.id),
          })),
        };
      }
      if (operation === "rules.configure") {
        only(payload, ["revision", "enabled", "draft"]);
        return {
          settings: await service.configure(actorId, requestId!, payload.revision as number, {
            enabled: payload.enabled as boolean,
            draft: payload.draft as RulesDraft | null,
          }),
        };
      }
      if (operation === "rules.publish") {
        only(payload, ["revision"]);
        const version = await service.publish(actorId, requestId!, payload.revision as number);
        return { version, settings: service.settings(), parts: service.parts(version.id) };
      }
      if (operation === "rules.acceptances.list") {
        only(payload, ["limit", "before"]);
        const entries = await service.listAcceptances(actorId, payload);
        const limit = payload.limit ?? 50,
          last = entries.at(-1);
        return {
          acceptances: entries,
          nextCursor:
            entries.length === limit && last ? { acceptedAt: last.acceptedAt, id: last.id } : null,
        };
      }
      if (operation === "rules.publications.reconcile") {
        only(payload, []);
        const version = await service.reconcilePublication(actorId, objectId!);
        return { version, settings: service.settings(), parts: service.parts(version.id) };
      }
      throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
    } catch (error) {
      throw serverRulesControlError(error);
    }
  }
  async execute(job: Job, execution: ExecutionContext): Promise<ExecutionOutcome> {
    if (!this.service || this.stopped || !job.leaseToken || job.leaseUntil === null)
      return { state: "failed", error: "module_unavailable" };
    return this.service.execute(
      { ...job, leaseToken: job.leaseToken, leaseUntil: job.leaseUntil },
      execution,
    );
  }
  async button(
    userId: string,
    channelId: string,
    messageId: string,
    controlId: string,
  ): Promise<RulesAcceptance> {
    return this.acceptanceWork(`${userId}:${controlId}:${messageId}`, () =>
      this.buttonOnce(userId, channelId, messageId, controlId),
    );
  }
  private async acceptanceWork(
    key: string,
    task: () => Promise<RulesAcceptance>,
  ): Promise<RulesAcceptance> {
    const previous = this.accepting.get(key);
    if (previous) return previous;
    if (this.accepting.size >= 4)
      throw new ControlError(
        429,
        "busy",
        "Trwa obsługa innych akceptacji. Spróbuj ponownie za chwilę.",
      );
    const work = Promise.resolve().then(task);
    this.accepting.set(key, work);
    try {
      return await work;
    } finally {
      if (this.accepting.get(key) === work) this.accepting.delete(key);
    }
  }
  private async buttonOnce(
    userId: string,
    channelId: string,
    messageId: string,
    controlId: string,
  ): Promise<RulesAcceptance> {
    const service = this.ready(),
      match = /^gildiusz:rules:(\d{17,20}):([\da-f-]{36}):accept$/i.exec(controlId);
    if (!match || match[1] !== this.context.guild.id) throw new RulesError("invalid_input");
    const accepted = await service.accept(userId, {
      guildId: this.context.guild.id,
      versionId: match[2],
      channelId,
      messageId,
      source: "button",
      controlId,
    });
    return ["sending", "unknown"].includes(accepted.grantState)
      ? service.reconcileGrant(userId, accepted.id)
      : accepted;
  }
  async reaction(
    userId: string,
    channelId: string,
    messageId: string,
    emoji: string | null,
    added: boolean,
  ): Promise<void> {
    const service = this.service,
      settings = service?.settings();
    if (
      this.stopped ||
      !added ||
      !service ||
      !settings?.enabled ||
      !settings.activeVersionId ||
      !emoji
    )
      return;
    const versionId = settings.activeVersionId;
    const row = this.jobs.db
      .prepare("SELECT body FROM server_rules_versions WHERE guild_id=? AND id=?")
      .get(this.context.guild.id, settings.activeVersionId);
    if (!row) return;
    const draft = JSON.parse(String(row.body)) as RulesDraft;
    if (
      draft.method !== "reaction" ||
      draft.channelId !== channelId ||
      reactionEmojiKey(emoji) !== reactionEmojiKey(draft.emoji!) ||
      service.parts(settings.activeVersionId).at(-1)?.messageId !== messageId
    )
      return;
    await this.acceptanceWork(`${userId}:${settings.activeVersionId}:${messageId}`, async () => {
      const accepted = await service.reaction(
        userId,
        {
          guildId: this.context.guild.id,
          versionId,
          channelId,
          messageId,
          source: "reaction",
          emoji,
        },
        true,
      );
      if (!accepted) throw new RulesError("invalid_input");
      return accepted;
    });
  }
  async memberChanged(userId: string): Promise<void> {
    if (!this.retention || !this.ports || this.stopped) return;
    if (
      !this.jobs.db
        .prepare("SELECT 1 FROM server_rules_memberships WHERE guild_id=? AND user_id=? LIMIT 1")
        .get(this.context.guild.id, userId)
    )
      return;
    this.retention.observe(await this.readMembership(userId));
  }
  private async readMembership(
    userId: string,
    expectedJoinedAt?: number,
  ): Promise<RulesMembershipObservation> {
    const observedAt = Date.now(),
      guildId = this.context.guild.id;
    if (!this.ports || this.stopped) return { guildId, userId, observedAt, presence: "unknown" };
    const epoch = ++this.membershipEpoch;
    this.observingMembers.set(userId, epoch);
    try {
      const member = await this.ports.member(userId);
      if (this.stopped || this.observingMembers.get(userId) !== epoch)
        return { guildId, userId, observedAt, presence: "unknown" };
      return {
        guildId,
        userId,
        observedAt: member?.observedAt ?? observedAt,
        presence: member ? "present" : "absent",
        ...(member ? { joinedAt: member.joinedAt } : {}),
        ...(expectedJoinedAt === undefined ? {} : { expectedJoinedAt }),
      };
    } finally {
      if (this.observingMembers.get(userId) === epoch) this.observingMembers.delete(userId);
    }
  }
  stop(): void {
    this.stopped = true;
    this.observingMembers.clear();
  }
  /** Covers member departures missed while Gateway was unavailable, without fetching the whole guild. */
  async sweepMemberships(): Promise<void> {
    if (
      !this.retention ||
      this.stopped ||
      this.membershipSweepRunning ||
      Date.now() < this.nextMembershipSweepAt
    )
      return;
    this.membershipSweepRunning = true;
    this.nextMembershipSweepAt = Date.now() + 300000;
    try {
      await this.retention.reconcile(
        (userId, expectedJoinedAt) => this.readMembership(userId, expectedJoinedAt),
        { limit: 10 },
      );
    } finally {
      this.membershipSweepRunning = false;
    }
  }
}

export function rulesAcceptanceText(acceptance: RulesAcceptance): string {
  if (acceptance.grantState === "confirmed")
    return "Regulamin zaakceptowany. Rola członka została nadana.";
  if (acceptance.grantState === "already_present")
    return "Akceptacja zapisana. Masz już wskazaną rolę członka.";
  if (acceptance.grantState === "pending" || acceptance.grantState === "sending")
    return "Akceptacja regulaminu została zapisana. Trwa nadawanie roli członka.";
  return "Akceptacja jest zapisana, ale nie udało się potwierdzić nadania roli. Poproś administrację o sprawdzenie dostępu.";
}
export function serverRulesControlError(error: unknown): unknown {
  if (!(error instanceof RulesError)) return error;
  const messages: Partial<Record<RulesError["code"], string>> = {
    native_pending:
      "Najpierw dokończ akceptację zasad wyświetlaną przez Discorda. Potem wróć do tej wiadomości.",
    disabled: "Akceptacja regulaminu jest teraz wyłączona. Poproś administrację o pomoc.",
    stale_generation:
      "To starsza wersja regulaminu. Otwórz aktualną wiadomość na kanale regulaminu.",
    revision_conflict: "Regulamin zmienił się. Wczytaj aktualną treść przed publikacją.",
    channel_unavailable:
      "Nie można użyć tego kanału. Sprawdź dostęp bota i nowych członków oraz ograniczenie pisania.",
    role_unavailable:
      "Nie można nadać tej roli. Sprawdź jej uprawnienia i pozycję względem Gildiusza.",
    unknown_effect: "Nie udało się potwierdzić operacji. Sprawdź jej wynik przed ponowieniem.",
    role_revoked: "Rola została odebrana. Poproś administrację o sprawdzenie dostępu.",
  };
  const status =
    error.code === "not_found"
      ? 404
      : ["invalid_input"].includes(error.code)
        ? 400
        : [
              "native_pending",
              "permission_revoked",
              "member_unavailable",
              "membership_changed",
              "role_revoked",
            ].includes(error.code)
          ? 403
          : 409;
  return new ControlError(
    status,
    error.code,
    messages[error.code] ??
      "Nie można teraz wykonać tej czynności. Sprawdź ustawienia i aktualny stan regulaminu.",
  );
}
