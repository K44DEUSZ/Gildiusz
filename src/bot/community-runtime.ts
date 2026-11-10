import {
  ChannelType,
  PermissionFlagsBits as P,
  RateLimitError,
  Routes,
  type REST,
  type GuildBasedChannel,
} from "discord.js";
import type { BotContext } from "./context.js";
import {
  discordErrorCode,
  freshMember,
  isDiscordChannelUnavailable,
  memberFacts,
} from "./module-permissions.js";
import { DiscordVoiceRooms, VoiceRoomError } from "./voice-rooms.js";
import {
  canPerform,
  requirePermission,
  type BoundObject,
  type MemberFacts,
} from "../core/permissions.js";
import type { JobStore } from "../core/jobs/store.js";
import type { Job, JobInput } from "../core/jobs/types.js";
import type { ExecutionContext, ExecutionOutcome } from "../core/jobs/runner.js";
import {
  deliveryNonce,
  publishDiscord,
  validatePublication,
  type DeliveryTransport,
  type TrustedButtonRow,
} from "../core/delivery/discord.js";
import { communityButtonId } from "./community-commands.js";
import { defaultCaseSettings, type ModuleSettingsStore } from "../core/modules/settings.js";
import {
  ControlError,
  type CaseSettings,
  type ControlOperation,
  type ModuleSettings,
  type PublicJob,
} from "../contracts/index.js";
import {
  MeetingService,
  MeetingError,
  type Meeting,
  type MeetingAuthorization,
  type MeetingDraft,
  type MeetingMutation,
  type PreparedMeetingJob,
  type MeetingEffectResult,
} from "../modules/meetings/service.js";
import {
  CaseService,
  allowedCaseStatuses,
  CaseError,
  type CaseDraft,
  type CaseListFilter,
  type CaseTransition,
  type CaseAudienceScope,
  type CaseMutation,
  type CaseOptions,
  type CaseSummary,
} from "../modules/cases/service.js";
import { resolveLocalDateTime } from "../modules/announcements/schedule.js";

type CommunityOperation =
  ControlOperation | "meetings.preview" | "cases.notes" | "cases.note" | "cases.approve";
const emptyCases: CaseSettings = defaultCaseSettings();
const textAccess = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
const voiceAccess = P.ViewChannel | P.Connect;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ControlError(400, "invalid_input", "Sprawdź dane formularza.");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ControlError(400, "unknown_field", "Żądanie zawiera nieobsługiwane pole.");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value))
    throw new ControlError(400, "invalid_input", "Wskaż prawidłowy zasób serwera.");
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new ControlError(400, "revision", "Wczytaj aktualną wersję wpisu.");
  return value as number;
}
function publicJob(job: Job): PublicJob {
  const view = { ...job } as Record<string, unknown>;
  for (const key of ["payload", "result", "leaseToken"]) delete view[key];
  return view as unknown as PublicJob;
}
function deliveryView(attempt: object) {
  const view: Record<string, unknown> = { ...attempt };
  for (const key of ["result", "leaseToken", "nonce"]) delete view[key];
  return view;
}
function meetingMutation(value: MeetingMutation) {
  return { ...value, jobs: value.jobs.map(publicJob) };
}
function caseMutation(value: CaseMutation) {
  return { ...value, job: value.job ? publicJob(value.job) : null };
}
function clip(value: string) {
  return value.length <= 2000 ? value : value.slice(0, 1999).replace(/[\uD800-\uDBFF]$/, "") + "…";
}
function effectError(error: unknown, now: number): ExecutionOutcome {
  if (error instanceof RateLimitError)
    return {
      state: "retry",
      at:
        now +
        Math.ceil(
          Math.max(
            0,
            ...[error.retryAfter, error.timeToReset, error.sublimitTimeout].filter(
              (value) => Number.isFinite(value) && value > 0,
            ),
          ) || 5000,
        ),
      error: "discord_rate_limit",
      rateLimited: true,
    };
  const value = error as { status?: number; rawError?: { retry_after?: number } };
  if (value?.status === 429)
    return {
      state: "retry",
      at:
        now +
        Math.ceil(
          Number.isFinite(value.rawError?.retry_after) && Number(value.rawError?.retry_after) > 0
            ? Number(value.rawError?.retry_after) * 1000
            : 5000,
        ),
      error: "discord_rate_limit",
      rateLimited: true,
    };
  if (value?.status && value.status >= 400 && value.status < 500 && value.status !== 408)
    return { state: "failed", error: "discord_rejected_effect" };
  return { state: "unknown", error: "discord_effect_unconfirmed" };
}

export class CommunityRuntime {
  readonly meetings: MeetingService;
  readonly effectsReady: boolean;
  private membershipCheck?: (userId: string) => Promise<void>;
  setMembershipCheck(check: (userId: string) => Promise<void>): void {
    this.membershipCheck = check;
  }
  constructor(
    readonly context: BotContext,
    readonly jobs: JobStore,
    readonly settings: ModuleSettingsStore,
    private readonly rest: REST,
    readonly beta: boolean,
  ) {
    this.effectsReady = beta && rest.options?.retries === 0;
    this.meetings = new MeetingService(jobs, {
      guildId: context.guild.id,
      authorize: (request) => this.authorizeMeeting(request),
      eligible: (user, meeting) => this.eligible(user, meeting),
    });
  }
  private require(module: "meetings" | "cases"): void {
    if (!this.effectsReady || !this.settings.read().enabled[module])
      throw new ControlError(
        409,
        "module_unavailable",
        "Ta funkcja jest wyłączona na tym serwerze.",
      );
  }
  private voice(): DiscordVoiceRooms {
    return new DiscordVoiceRooms(this.context, this.rest);
  }
  private enqueueEffect(input: Omit<JobInput, "dueAt" | "expiresAt">, ttlMs?: number): Job {
    return this.jobs.transaction(() => {
      const row = this.jobs.db
          .prepare("SELECT id FROM jobs WHERE dedupe_key=?")
          .get(input.dedupeKey),
        existing = row ? this.jobs.get(String(row.id)) : undefined,
        dueAt = existing?.dueAt ?? Date.now();
      // A repeated trigger keeps its first schedule, including an expired cleanup deadline.
      // The queue still checks the full identity and payload; a key cannot hide changed work.
      return this.jobs.enqueue({
        ...input,
        dueAt,
        ...(ttlMs === undefined ? {} : { expiresAt: existing?.expiresAt ?? dueAt + ttlMs }),
      });
    });
  }
  private caseSettings(): CaseSettings {
    return this.settings.read().cases ?? emptyCases;
  }
  get cases(): CaseService {
    return this.caseService();
  }
  private caseService(authorize?: CaseOptions["authorize"]): CaseService {
    const settings = this.settings.read(),
      configuration = settings.cases ?? emptyCases;
    const assertConfiguration = () => {
      this.require("cases");
      if (this.settings.read().revision !== settings.revision)
        throw new ControlError(409, "conflict", "Ustawienia spraw zmieniły się. Spróbuj ponownie.");
    };
    return new CaseService(this.jobs, {
      guildId: this.context.guild.id,
      ...configuration,
      authorize: async (request) => {
        assertConfiguration();
        if (authorize) {
          const authority = await authorize(request),
            priorGuard = authority.assertCurrent;
          const assertCurrent = () => {
            assertConfiguration();
            return priorGuard?.();
          };
          assertCurrent();
          return { ...authority, assertCurrent };
        }
        const current = await freshMember(this.context.guild, request.actorId);
        const assertCurrent = () => {
          assertConfiguration();
          // Fresh REST is required above. Cache can only revoke that grant while another await
          // (for example the assignee check) completes; it is never used to grant a new request.
          const member = current.guild.members.cache
            ? current.guild.members.cache.get(request.actorId)
            : current.member;
          if (
            !member ||
            !canPerform(
              request.operation,
              memberFacts(current.guild, member),
              this.settings.policy(),
              request.object,
            )
          )
            throw new ControlError(403, "permission_revoked", "Sprawdź aktualne uprawnienia.");
        };
        assertCurrent();
        return { member: current.facts, policy: this.settings.policy(), assertCurrent };
      },
      onCreated: (value) => {
        if (value.visibility === "private")
          this.enqueueEffect({
            guildId: value.guildId,
            objectId: value.id,
            generation: value.generation,
            type: "community.case-channel",
            dedupeKey: `community:case-channel:${value.id}`,
            payload: { caseId: value.id, ownerId: value.ownerId, generation: value.generation },
          });
      },
    });
  }
  status(module: "meetings" | "cases") {
    if (!this.settings.read().enabled[module]) return "available" as const;
    if (module === "cases" && !this.caseSettings().categoryId)
      return "needs_configuration" as const;
    if (
      module === "cases" &&
      this.jobs
        .list({
          guildId: this.context.guild.id,
          type: "community.case-acl",
          states: ["pending", "retry", "running", "failed", "unknown"],
          limit: 500,
        })
        .some(
          (job) =>
            (job.payload as Record<string, unknown>).settingsRevision ===
            this.settings.read().revision,
        )
    )
      return "degraded" as const;
    return "enabled" as const;
  }
  private async channel(channelId: string): Promise<GuildBasedChannel> {
    const channel = await this.context.guild.channels
      .fetch(id(channelId), { force: true })
      .catch((error: unknown) => {
        if (isDiscordChannelUnavailable(error))
          throw new ControlError(
            409,
            "channel_missing",
            "Wybrany kanał jest niedostępny na tym serwerze. Wybierz go ponownie w ustawieniach.",
          );
        throw error;
      });
    if (!channel || channel.guildId !== this.context.guild.id)
      throw new ControlError(409, "channel_missing", "Nie ma dostępu do wybranego kanału.");
    return channel;
  }
  private async authorizeMeeting(request: MeetingAuthorization): Promise<void> {
    this.require("meetings");
    const current = await freshMember(this.context.guild, request.actorId);
    const value = request.meeting;
    const bound: BoundObject | undefined = value
      ? {
          guildId: value.guildId,
          ownerId: value.organizerId,
          visibility: value.visibility,
          state: value.state,
          participantIds: request.participantIds,
          invitedUserIds: value.invitedUserIds,
          allowedRoleIds: value.allowedRoleIds,
        }
      : undefined;
    const operation =
      request.operation === "deliver" ? "meetings.update" : `meetings.${request.operation}`;
    try {
      requirePermission(operation, current.facts, this.settings.policy(), bound);
    } catch {
      throw new MeetingError("forbidden");
    }
    const definition = request.draft ?? value;
    if (!definition) return;
    if (
      request.operation === "read" &&
      value?.visibility === "private" &&
      !canPerform("meetings.update", current.facts, this.settings.policy(), bound) &&
      !(await this.eligible(request.actorId, value))
    )
      throw new MeetingError("forbidden");
    if (
      ["read", "leave", "cancel", "complete"].includes(request.operation) ||
      (request.operation === "deliver" && request.jobType === "meeting.finish")
    )
      return;
    const channel = await this.channel(definition.channelId);
    if (
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
      !channel.permissionsFor(current.member)?.has(P.ViewChannel)
    )
      throw new MeetingError("forbidden");
    if (request.draft || request.operation === "deliver") {
      const me = await current.guild.members.fetchMe({ force: true });
      if (
        !channel.permissionsFor(me)?.has(textAccess) ||
        !channel.permissionsFor(current.member)?.has(textAccess)
      )
        throw new MeetingError("forbidden");
      for (const roleId of definition.allowedRoleIds ?? [])
        if (
          !current.roles.has(roleId) ||
          roleId === current.guild.id ||
          current.roles.get(roleId)?.managed
        )
          throw new MeetingError("forbidden");
      for (const userId of definition.invitedUserIds ?? []) {
        if (value?.invitedUserIds.includes(userId)) continue;
        const invited = await freshMember(this.context.guild, userId);
        if (
          invited.facts.isBot ||
          invited.facts.pending ||
          invited.facts.timedOut ||
          !channel.permissionsFor(invited.member)?.has(P.ViewChannel)
        )
          throw new MeetingError("forbidden");
      }
      if (definition.room?.kind === "create") {
        if (definition.capacity > 99) throw new MeetingError("invalid_input");
        const category = await this.channel(definition.room.categoryId);
        if (
          category.type !== ChannelType.GuildCategory ||
          !category.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles])
        )
          throw new MeetingError("forbidden");
      } else if (definition.room?.kind === "existing") {
        const voice = await this.channel(definition.room.channelId);
        if (
          voice.type !== ChannelType.GuildVoice ||
          !voice.permissionsFor(me)?.has(voiceAccess) ||
          !voice.permissionsFor(current.member)?.has(voiceAccess)
        )
          throw new MeetingError("forbidden");
      }
    }
    if (request.operation === "join" && !(await this.eligible(request.actorId, value!)))
      throw new MeetingError("forbidden");
  }
  private async eligible(userId: string, meeting: Meeting): Promise<boolean> {
    try {
      const current = await freshMember(this.context.guild, userId);
      if (
        current.facts.pending ||
        current.facts.timedOut ||
        current.facts.isBot ||
        !this.meetingAudienceAllows(meeting, current.facts)
      )
        return false;
      const channel = await this.channel(meeting.channelId);
      return Boolean(channel.permissionsFor(current.member)?.has(P.ViewChannel));
    } catch (error) {
      if (
        error instanceof ControlError &&
        ["permission_revoked", "channel_missing"].includes(error.code)
      )
        return false;
      throw error;
    }
  }
  private meetingAudienceAllows(meeting: Meeting, member: MemberFacts): boolean {
    if (member.owner || member.manageGuild || member.userId === meeting.organizerId) return true;
    const role = meeting.allowedRoleIds.some((role) => member.roleIds.includes(role));
    return meeting.visibility === "private"
      ? meeting.invitedUserIds.includes(member.userId) || role
      : !meeting.allowedRoleIds.length || role;
  }
  private provePrivate(
    channel: GuildBasedChannel,
    users: Set<string>,
    roles: Set<string>,
    botId: string,
  ): void {
    if (!("permissionOverwrites" in channel))
      throw new ControlError(
        409,
        "acl_unconfirmed",
        "Nie udało się potwierdzić prywatności kanału.",
      );
    const overwrites = channel.permissionOverwrites.cache;
    const everyone = overwrites.get(this.context.guild.id);
    if (!everyone || !everyone.deny.has(P.ViewChannel) || everyone.allow.has(P.ViewChannel))
      throw new ControlError(409, "acl_unconfirmed", "Kanał sprawy wymaga prywatnego dostępu.");
    for (const overwrite of overwrites.values())
      if (
        overwrite.allow.has(P.ViewChannel) &&
        !(overwrite.type === 0
          ? roles.has(overwrite.id)
          : users.has(overwrite.id) || overwrite.id === botId)
      )
        throw new ControlError(
          409,
          "acl_unconfirmed",
          "Uprawnienia kanału pozwalają na szerszy dostęp.",
        );
  }
  private async caseTarget(
    scope: CaseAudienceScope,
  ): Promise<{ channelId: string; confirmed: true } & CaseAudienceScope> {
    const configuration = this.caseSettings();
    const current = await freshMember(this.context.guild, scope.ownerId);
    const me = await current.guild.members.fetchMe({ force: true });
    if (scope.visibility === "public") {
      if (!configuration.suggestionChannelId)
        throw new ControlError(
          409,
          "cases_configuration_required",
          "Wybierz kanał publicznych pomysłów.",
        );
      const channel = await this.channel(configuration.suggestionChannelId);
      if (
        ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
        !channel.permissionsFor(me)?.has(textAccess)
      )
        throw new ControlError(409, "acl_unconfirmed", "Sprawdź uprawnienia kanału pomysłów.");
      return { ...scope, confirmed: true, channelId: channel.id };
    }
    const resource = this.context.store.resource(`community.case.${scope.caseId}`);
    if (!resource)
      throw new ControlError(
        409,
        "case_channel_pending",
        "Prywatny kanał sprawy jest przygotowywany.",
      );
    const saved = object(JSON.parse(resource.baseline));
    if (
      resource.kind !== "community-case-channel" ||
      saved.guildId !== scope.guildId ||
      saved.caseId !== scope.caseId ||
      saved.ownerId !== scope.ownerId ||
      saved.createdBy !== me.id ||
      saved.owned !== true
    )
      throw new ControlError(409, "acl_unconfirmed", "Powiązanie kanału wymaga sprawdzenia.");
    const channel = await this.channel(resource.id);
    if (
      channel.type !== ChannelType.GuildText ||
      channel.parentId !== saved.parentId ||
      !channel.permissionsFor(me)?.has(textAccess) ||
      !channel.permissionsFor(current.member)?.has(P.ViewChannel)
    )
      throw new ControlError(
        409,
        "acl_unconfirmed",
        "Nie udało się potwierdzić dostępu do sprawy.",
      );
    const staff = this.settings.read().caseModeratorRoleIds;
    this.proveCaseAccess(channel, scope.ownerId, staff, me.id);
    for (const role of staff)
      if (!current.roles.has(role))
        throw new ControlError(
          409,
          "acl_unconfirmed",
          "Kanał nie ma aktualnych uprawnień obsługi.",
        );
    return { ...scope, confirmed: true, channelId: channel.id };
  }
  private proveCaseAccess(
    channel: GuildBasedChannel,
    ownerId: string,
    staffRoleIds: string[],
    botId: string,
  ): void {
    this.provePrivate(channel, new Set([ownerId]), new Set(staffRoleIds), botId);
    if (
      !("permissionOverwrites" in channel) ||
      ![ownerId, botId, ...staffRoleIds].every((id) =>
        channel.permissionOverwrites.cache.get(id)?.allow.has(textAccess),
      )
    )
      throw new ControlError(
        409,
        "acl_unconfirmed",
        "Nie ma potwierdzonego dostępu autora, obsługi lub bota.",
      );
  }
  private history(objectId: string) {
    const jobs = this.jobs.list({ guildId: this.context.guild.id, objectId, limit: 100 });
    return {
      jobs: jobs.map(publicJob),
      deliveries: jobs.flatMap((job) => this.jobs.attempts(job.id).map(deliveryView)),
    };
  }
  private async listCases(actorId: string, filter: CaseListFilter): Promise<CaseSummary[]> {
    const first = await freshMember(this.context.guild, actorId),
      policy = this.settings.policy();
    const service = this.caseService((request) => {
      if (request.actorId !== actorId || !["cases.list", "cases.read"].includes(request.operation))
        throw new CaseError("permission_revoked");
      return { member: first.facts, policy };
    });
    const values = await service.list(actorId, filter);
    const current = await freshMember(this.context.guild, actorId),
      latest = this.settings.policy();
    this.require("cases");
    requirePermission("cases.list", current.facts, latest);
    return this.jobs.transaction(() =>
      values.filter((value) => {
        const row = this.jobs.db
          .prepare("SELECT revision,generation FROM cases WHERE guild_id=? AND id=?")
          .get(this.context.guild.id, value.id);
        return (
          row?.revision === value.revision &&
          row.generation === value.generation &&
          canPerform("cases.read", current.facts, latest, {
            guildId: value.guildId,
            ownerId: value.ownerId,
            kind: value.kind,
            visibility: value.visibility,
            state: value.status,
          })
        );
      }),
    );
  }
  private async listMeetings(actorId: string): Promise<Meeting[]> {
    const first = await freshMember(this.context.guild, actorId),
      policy = this.settings.policy();
    const service = new MeetingService(this.jobs, {
      guildId: this.context.guild.id,
      authorize: (request) => {
        if (request.actorId !== actorId || !["list", "read"].includes(request.operation))
          throw new MeetingError("forbidden");
        const value = request.meeting,
          bound: BoundObject | undefined = value
            ? {
                guildId: value.guildId,
                ownerId: value.organizerId,
                visibility: value.visibility,
                state: value.state,
                participantIds: request.participantIds,
                invitedUserIds: value.invitedUserIds,
                allowedRoleIds: value.allowedRoleIds,
              }
            : undefined;
        if (!canPerform(`meetings.${request.operation}`, first.facts, policy, bound))
          throw new MeetingError("forbidden");
      },
      eligible: (user, meeting) => this.eligible(user, meeting),
    });
    const values = await service.list(actorId);
    const channels = await first.guild.channels.fetch();
    const current = await freshMember(this.context.guild, actorId),
      latest = this.settings.policy();
    this.require("meetings");
    requirePermission("meetings.list", current.facts, latest);
    return this.jobs.transaction(() =>
      values.filter((value) => {
        const row = this.jobs.db
          .prepare(
            "SELECT revision,generation,participant_version FROM meetings WHERE guild_id=? AND id=?",
          )
          .get(this.context.guild.id, value.id);
        if (
          !row ||
          row.revision !== value.revision ||
          row.generation !== value.generation ||
          row.participant_version !== value.participantVersion
        )
          return false;
        const participantIds = this.jobs.db
          .prepare("SELECT user_id FROM meeting_participants WHERE meeting_id=? AND state<>'left'")
          .all(value.id)
          .map((row) => String(row.user_id));
        const bound: BoundObject = {
          guildId: value.guildId,
          ownerId: value.organizerId,
          visibility: value.visibility,
          state: value.state,
          participantIds,
          invitedUserIds: value.invitedUserIds,
          allowedRoleIds: value.allowedRoleIds,
        };
        if (!canPerform("meetings.read", current.facts, latest, bound)) return false;
        if (
          value.visibility === "public" ||
          canPerform("meetings.update", current.facts, latest, bound)
        )
          return true;
        return (
          this.meetingAudienceAllows(value, current.facts) &&
          Boolean(channels.get(value.channelId)?.permissionsFor(current.member)?.has(P.ViewChannel))
        );
      }),
    );
  }
  private async meetingView(actorId: string, meetingId: string) {
    const detail = await this.meetings.get(actorId, meetingId),
      current = await freshMember(this.context.guild, actorId);
    const meeting = detail.meeting;
    const bound: BoundObject = {
      guildId: meeting.guildId,
      ownerId: meeting.organizerId,
      visibility: meeting.visibility,
      state: meeting.state,
      participantIds: detail.participants
        .filter((value) => value.state !== "left")
        .map((value) => value.userId),
      invitedUserIds: meeting.invitedUserIds,
      allowedRoleIds: meeting.allowedRoleIds,
    };
    requirePermission("meetings.read", current.facts, this.settings.policy(), bound);
    if (
      meeting.visibility === "private" &&
      !canPerform("meetings.update", current.facts, this.settings.policy(), bound)
    ) {
      if (!this.meetingAudienceAllows(meeting, current.facts)) throw new MeetingError("forbidden");
      const channel = await this.channel(meeting.channelId);
      if (!channel.permissionsFor(current.member)?.has(P.ViewChannel))
        throw new MeetingError("forbidden");
    }
    const valid: string[] = ["meetings.read"];
    if (["draft", "open", "starting", "active"].includes(meeting.state))
      valid.push("meetings.update");
    if (meeting.state === "open" && meeting.endsAt > Date.now()) {
      valid.push("meetings.start");
      if (await this.eligible(actorId, meeting)) valid.push("meetings.join");
    }
    if (["open", "starting", "active"].includes(meeting.state)) valid.push("meetings.leave");
    if (["starting", "active"].includes(meeting.state)) valid.push("meetings.complete");
    if (["draft", "open", "starting", "active"].includes(meeting.state))
      valid.push("meetings.cancel");
    return {
      ...detail,
      memberNames: Object.fromEntries(
        [
          ...new Set([
            ...meeting.invitedUserIds,
            ...detail.participants.map((person) => person.userId),
          ]),
        ].flatMap((userId) => {
          const member = current.guild.members.cache.get(userId);
          return member ? [[userId, member.displayName]] : [];
        }),
      ),
      allowedOperations: valid.filter((operation) =>
        canPerform(operation, current.facts, this.settings.policy(), bound),
      ),
      ...this.history(meetingId),
    };
  }
  private async caseView(actorId: string, caseId: string) {
    const detail = await this.cases.get(actorId, caseId),
      current = await freshMember(this.context.guild, actorId),
      value = detail.case;
    const bound: BoundObject = {
      guildId: value.guildId,
      ownerId: value.ownerId,
      kind: value.kind,
      visibility: value.visibility,
      state: value.status,
      votingEnabled:
        this.caseSettings().voting.enabled &&
        this.caseSettings().voting.statuses.includes(value.status as "new" | "in_review"),
    };
    requirePermission("cases.read", current.facts, this.settings.policy(), bound);
    const operations = ["cases.read", "cases.notes", "cases.note"];
    if (!["closed", "rejected", "implemented"].includes(value.status))
      operations.push("cases.reply", "cases.assign", "cases.transition");
    if (
      value.kind === "suggestion" &&
      value.visibility === "private" &&
      !["rejected", "implemented"].includes(value.status)
    )
      operations.push("cases.approve");
    if (bound.votingEnabled) operations.push("cases.vote");
    return {
      ...detail,
      messages: detail.messages.filter(
        (message) =>
          message.visibility === "public" ||
          current.facts.userId === value.ownerId ||
          canPerform("cases.note", current.facts, this.settings.policy(), bound),
      ),
      allowedStatuses: canPerform("cases.transition", current.facts, this.settings.policy(), bound)
        ? allowedCaseStatuses(value.kind, value.status)
        : [],
      allowedOperations: operations.filter((operation) =>
        canPerform(operation, current.facts, this.settings.policy(), bound),
      ),
    };
  }
  async request(
    actor: MemberFacts,
    operation: CommunityOperation,
    input: unknown,
    objectId?: string,
    requestId?: string,
  ): Promise<unknown> {
    if (actor.guildId !== this.context.guild.id)
      throw new ControlError(404, "not_found", "Nie znaleziono obiektu.");
    const payload = object(input);
    try {
      if (operation.startsWith("meetings.")) {
        this.require("meetings");
        switch (operation) {
          case "meetings.list":
            only(payload, []);
            return { meetings: await this.listMeetings(actor.userId) };
          case "meetings.read":
            only(payload, []);
            return await this.meetingView(actor.userId, objectId!);
          case "meetings.preview": {
            only(payload, ["date", "time", "timeZone"]);
            const current = await freshMember(this.context.guild, actor.userId);
            requirePermission("meetings.preview", current.facts, this.settings.policy());
            return resolveLocalDateTime(
              payload.date as string,
              payload.time as string,
              (payload.timeZone ?? this.settings.read().timeZone) as string,
            );
          }
          case "meetings.create":
            return meetingMutation(
              await this.meetings.create(
                actor.userId,
                requestId!,
                payload as unknown as MeetingDraft,
              ),
            );
          case "meetings.update":
            only(payload, ["revision", "draft", "audience"]);
            if (Object.hasOwn(payload, "audience") === Object.hasOwn(payload, "draft"))
              throw new ControlError(
                400,
                "invalid_input",
                "Wybierz jeden zakres zmiany spotkania.",
              );
            {
              const result =
                payload.audience !== undefined
                  ? await this.meetings.updateAudience(
                      actor.userId,
                      requestId!,
                      objectId!,
                      revision(payload.revision),
                      object(
                        payload.audience,
                      ) as unknown as import("../contracts/community.js").MeetingAudience,
                    )
                  : await this.meetings.update(
                      actor.userId,
                      requestId!,
                      objectId!,
                      revision(payload.revision),
                      object(payload.draft) as unknown as MeetingDraft,
                    );
              this.enqueueMeetingAcl(result.meeting.id);
              return meetingMutation(result);
            }
          case "meetings.join":
            only(payload, []);
            await this.membershipCheck?.(actor.userId);
            return meetingMutation(await this.meetings.join(actor.userId, requestId!, objectId!));
          case "meetings.leave":
            only(payload, []);
            return meetingMutation(await this.meetings.leave(actor.userId, requestId!, objectId!));
          case "meetings.start":
          case "meetings.complete":
          case "meetings.cancel":
            only(payload, ["revision"]);
            return meetingMutation(
              await this.meetings.transition(
                actor.userId,
                requestId!,
                objectId!,
                revision(payload.revision),
                operation.slice(9) as "start" | "complete" | "cancel",
              ),
            );
        }
      }
      if (operation.startsWith("cases.")) {
        this.require("cases");
        switch (operation) {
          case "cases.list":
            return { cases: await this.listCases(actor.userId, payload as CaseListFilter) };
          case "cases.read":
            only(payload, []);
            return await this.caseView(actor.userId, objectId!);
          case "cases.create":
            return caseMutation(
              await this.cases.create(actor.userId, requestId!, payload as unknown as CaseDraft),
            );
          case "cases.reply":
          case "cases.note":
            only(payload, ["revision", "content"]);
            return caseMutation(
              await this.cases[operation === "cases.note" ? "note" : "reply"](
                actor.userId,
                requestId!,
                objectId!,
                revision(payload.revision),
                payload.content as string,
              ),
            );
          case "cases.notes":
            only(payload, []);
            return { notes: await this.cases.notes(actor.userId, objectId!) };
          case "cases.assign":
            only(payload, ["revision", "assigneeId"]);
            return caseMutation(
              await this.cases.assign(
                actor.userId,
                requestId!,
                objectId!,
                revision(payload.revision),
                payload.assigneeId as string | null,
              ),
            );
          case "cases.transition":
            only(payload, ["revision", "status", "reason"]);
            return caseMutation(
              await this.cases.transition(
                actor.userId,
                requestId!,
                objectId!,
                revision(payload.revision),
                {
                  status: payload.status,
                  ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
                } as CaseTransition,
              ),
            );
          case "cases.approve":
            only(payload, ["revision"]);
            return caseMutation(
              await this.cases.approve(
                actor.userId,
                requestId!,
                objectId!,
                revision(payload.revision),
              ),
            );
          case "cases.vote":
            only(payload, ["value"]);
            return this.cases.vote(
              actor.userId,
              requestId!,
              objectId!,
              payload.value as 1 | -1 | null,
            );
        }
      }
      throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
    } catch (error) {
      throw this.error(error);
    }
  }
  private error(error: unknown): unknown {
    if (error instanceof MeetingError || error instanceof CaseError)
      return new ControlError(
        error.code === "not_found"
          ? 404
          : ["forbidden", "permission_revoked"].includes(error.code)
            ? 403
            : error.code === "limit_exceeded"
              ? 429
              : error.code === "invalid_input"
                ? 400
                : 409,
        error.code,
        error.code === "not_found"
          ? "Nie znaleziono wpisu."
          : ["forbidden", "permission_revoked"].includes(error.code)
            ? "Nie masz już dostępu do tej czynności."
            : error.code === "invalid_input"
              ? "Sprawdź dane formularza."
              : "Wpis zmienił się. Wczytaj aktualną wersję.",
      );
    return error;
  }
  async validateSettings(actorId: string, settings: ModuleSettings): Promise<void> {
    if ((settings.enabled.cases || settings.enabled.meetings) && !this.effectsReady)
      throw new ControlError(409, "module_unavailable", "Ta funkcja jest jeszcze w przygotowaniu.");
    const current = await freshMember(this.context.guild, actorId);
    requirePermission("settings.save", current.facts, this.settings.policy());
    const me = await current.guild.members.fetchMe({ force: true }),
      configuration = settings.cases ?? emptyCases;
    if (configuration.categoryId) {
      const category = await this.channel(configuration.categoryId);
      if (
        category.type !== ChannelType.GuildCategory ||
        !category.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles])
      )
        throw new ControlError(
          400,
          "cases_category",
          "Sprawdź kategorię prywatnych spraw i uprawnienia bota.",
        );
    }
    if (configuration.suggestionChannelId) {
      const channel = await this.channel(configuration.suggestionChannelId);
      if (
        ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
        !channel.permissionsFor(me)?.has(textAccess) ||
        !channel.permissionsFor(current.member)?.has(P.ViewChannel)
      )
        throw new ControlError(400, "cases_channel", "Wybierz kanał publicznych pomysłów.");
    }
  }
  settingsChanged(actorId: string, previous: ModuleSettings, next: ModuleSettings): void {
    if (!this.effectsReady) return;
    if (next.enabled.meetings && !previous.enabled.meetings) {
      const rows = this.jobs.db
        .prepare(
          "SELECT id FROM meetings WHERE guild_id=? AND state IN ('draft','open','starting','active')",
        )
        .all(this.context.guild.id);
      for (const row of rows) this.enqueueMeetingReconciliation(String(row.id));
    }
    if (JSON.stringify(previous.caseModeratorRoleIds) === JSON.stringify(next.caseModeratorRoleIds))
      return;
    for (const resource of this.context.store.resources()) {
      if (resource.kind !== "community-case-channel") continue;
      const baseline = object(JSON.parse(resource.baseline));
      if (baseline.guildId !== this.context.guild.id || baseline.owned !== true) continue;
      const value = this.jobs.db
        .prepare("SELECT id,generation FROM cases WHERE guild_id=? AND id=?")
        .get(this.context.guild.id, String(baseline.caseId));
      if (value)
        this.enqueueEffect({
          guildId: this.context.guild.id,
          objectId: String(value.id),
          generation: Number(value.generation),
          type: "community.case-acl",
          dedupeKey: `community:case-acl:${value.id}:${value.generation}:${next.revision}:${resource.id}`,
          payload: {
            caseId: value.id,
            channelId: resource.id,
            actorId,
            settingsRevision: next.revision,
          },
        });
    }
  }
  memberUpdated(userId: string): void {
    if (!this.effectsReady) return;
    const rows = this.jobs.db
      .prepare(
        `SELECT m.id FROM meetings m JOIN meeting_participants p ON p.meeting_id=m.id
       WHERE m.guild_id=? AND p.user_id=? AND p.state<>'left'
       AND m.state IN ('draft','open','starting','active')`,
      )
      .all(this.context.guild.id, userId);
    for (const row of rows) this.enqueueMeetingReconciliation(String(row.id));
  }
  private enqueueMeetingReconciliation(meetingId: string): void {
    const value = this.jobs.db
      .prepare("SELECT generation,participant_version FROM meetings WHERE guild_id=? AND id=?")
      .get(this.context.guild.id, meetingId);
    if (!value) return;
    const bucket = Math.floor(Date.now() / 60000);
    const dedupeKey = `community:meeting-reconcile:${meetingId}:${value.generation}:${value.participant_version}:${this.settings.read().revision}:${bucket}`;
    if (
      this.jobs.db
        .prepare("SELECT id FROM jobs WHERE guild_id=? AND dedupe_key=?")
        .get(this.context.guild.id, dedupeKey)
    )
      return;
    this.jobs.enqueue({
      guildId: this.context.guild.id,
      objectId: meetingId,
      generation: Number(value.generation),
      type: "community.meeting-reconcile",
      dueAt: bucket * 60000,
      dedupeKey,
      payload: { meetingId },
    });
  }
  private enqueueLatestCaseAcl(caseId: string): void {
    const settings = this.settings.read(),
      actor = this.jobs.db
        .prepare("SELECT actor FROM guild_module_settings WHERE guild_id=?")
        .get(this.context.guild.id)?.actor;
    const value = this.jobs.db
      .prepare("SELECT generation FROM cases WHERE guild_id=? AND id=?")
      .get(this.context.guild.id, caseId);
    const resource = this.context.store.resource(`community.case.${caseId}`);
    if (actor && value && resource?.kind === "community-case-channel")
      this.enqueueEffect({
        guildId: this.context.guild.id,
        objectId: caseId,
        generation: Number(value.generation),
        type: "community.case-acl",
        dedupeKey: `community:case-acl:${caseId}:${value.generation}:${settings.revision}:${resource.id}`,
        payload: {
          caseId,
          channelId: resource.id,
          actorId: id(actor),
          settingsRevision: settings.revision,
        },
      });
  }
  private async updateCaseAcl(job: Job, execution: ExecutionContext): Promise<ExecutionOutcome> {
    if (!this.effectsReady) return { state: "failed", error: "module_unavailable" };
    const payload = object(job.payload),
      settings = this.settings.read();
    if (payload.settingsRevision !== settings.revision) {
      this.enqueueLatestCaseAcl(String(payload.caseId));
      return { state: "expired", reason: "settings_changed" };
    }
    id(payload.actorId);
    const guild = await this.context.guild.fetch(),
      roles = await guild.roles.fetch();
    const resource = this.context.store.resource(`community.case.${payload.caseId}`);
    if (!resource || resource.kind !== "community-case-channel")
      return { state: "failed", error: "case_channel_missing" };
    if (payload.channelId !== resource.id) {
      this.enqueueLatestCaseAcl(String(payload.caseId));
      return { state: "expired", reason: "case_channel_changed" };
    }
    const baseline = object(JSON.parse(resource.baseline)),
      me = await guild.members.fetchMe({ force: true });
    if (
      baseline.guildId !== job.guildId ||
      baseline.caseId !== payload.caseId ||
      baseline.createdBy !== me.id ||
      baseline.owned !== true
    )
      return { state: "failed", error: "case_channel_not_owned" };
    const channel = await this.channel(resource.id);
    if (channel.type !== ChannelType.GuildText || channel.parentId !== baseline.parentId)
      return { state: "failed", error: "case_channel_identity_changed" };
    if (
      !me.permissions.has([P.ManageChannels, P.ManageRoles]) ||
      !channel.permissionsFor(me)?.has([P.ManageChannels, P.ManageRoles])
    )
      return { state: "failed", error: "case_acl_permission_unavailable" };
    if (settings.caseModeratorRoleIds.some((role) => !roles.has(role)))
      return { state: "failed", error: "cases_roles_unavailable" };
    const overwrites = [
      { id: job.guildId, type: 0, allow: "0", deny: P.ViewChannel.toString() },
      ...settings.caseModeratorRoleIds.map((id) => ({
        id,
        type: 0,
        allow: textAccess.toString(),
        deny: "0",
      })),
      { id: id(baseline.ownerId), type: 1, allow: textAccess.toString(), deny: "0" },
      {
        id: me.id,
        type: 1,
        allow: (textAccess | P.ManageChannels).toString(),
        deny: "0",
      },
    ];
    if (this.settings.read().revision !== settings.revision) {
      this.enqueueLatestCaseAcl(String(payload.caseId));
      return { state: "expired", reason: "settings_changed" };
    }
    execution.checkpoint();
    execution.beginAttempt({ nonce: deliveryNonce(job.id), channelId: channel.id });
    try {
      await this.rest.patch(Routes.channel(channel.id), {
        signal: execution.signal,
        body: { permission_overwrites: overwrites },
      });
      if (
        JSON.stringify(this.settings.read().caseModeratorRoleIds) !==
        JSON.stringify(settings.caseModeratorRoleIds)
      ) {
        this.enqueueLatestCaseAcl(String(payload.caseId));
        return { state: "unknown", error: "case_acl_settings_changed" };
      }
      const fresh = await this.channel(channel.id);
      this.proveCaseAccess(fresh, String(baseline.ownerId), settings.caseModeratorRoleIds, me.id);
      this.context.store.putResource(resource.key, resource.kind, resource.id, {
        ...baseline,
        staffRoleIds: settings.caseModeratorRoleIds,
      });
      return { state: "succeeded", result: { channelId: channel.id } };
    } catch (error) {
      return effectError(error, execution.now());
    }
  }
  private transport(verify: () => Promise<unknown>): DeliveryTransport {
    return {
      check: async () => {
        await verify();
      },
      send: async (publication, options) =>
        this.rest.post(Routes.channelMessages(publication.channelId), {
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)]),
          body: {
            content: publication.content,
            ...(publication.components ? { components: publication.components } : {}),
            nonce: options.nonce,
            enforce_nonce: true,
            allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
          },
        }) as Promise<{ id: string }>,
    };
  }
  private async confirmCreatedResource(
    key: string,
    kind: string,
    channelId: string,
    baseline: Record<string, unknown>,
    operation: string,
    expectedType: ChannelType,
  ): Promise<GuildBasedChannel> {
    this.context.store.putResource(key, `${kind}-unverified`, channelId, {
      ...baseline,
      owned: false,
    });
    const channel = await this.channel(channelId);
    if (
      channel.type !== expectedType ||
      !("parentId" in channel) ||
      channel.parentId !== baseline.parentId
    )
      throw Error("created_channel_identity_unconfirmed");
    this.jobs.transaction(() => {
      this.context.store.putResource(key, kind, channelId, { ...baseline, owned: true });
      this.context.store.endOperation(operation);
    });
    return channel;
  }
  private async provisionCase(job: Job, execution: ExecutionContext): Promise<ExecutionOutcome> {
    this.require("cases");
    const payload = object(job.payload);
    const value = (await this.cases.get(id(payload.ownerId), String(payload.caseId))).case;
    if (
      value.guildId !== job.guildId ||
      value.id !== job.objectId ||
      value.generation !== job.generation ||
      payload.generation !== job.generation ||
      value.visibility !== "private"
    )
      return { state: "expired", reason: "stale_generation" };
    const key = `community.case.${value.id}`,
      prior = this.context.store.resource(key);
    if (prior) {
      await this.caseTarget({
        guildId: value.guildId,
        caseId: value.id,
        ownerId: value.ownerId,
        visibility: value.visibility,
        audience: "staff",
        generation: value.generation,
      });
      return { state: "succeeded", result: { channelId: prior.id } };
    }
    const settings = this.settings.read(),
      configuration = settings.cases ?? emptyCases;
    if (!configuration.categoryId)
      return {
        state: "retry",
        at: execution.now() + 60000,
        error: "cases_configuration_required",
        rateLimited: true,
      };
    const me = await this.context.guild.members.fetchMe({ force: true }),
      category = await this.channel(configuration.categoryId);
    if (
      category.type !== ChannelType.GuildCategory ||
      !me.permissions.has([P.ManageChannels, P.ManageRoles]) ||
      !category.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles])
    )
      return { state: "failed", error: "cases_category_unavailable" };
    const operation = `community:case-channel:${value.id}`;
    if (this.context.store.operations().some((entry) => object(entry).key === operation))
      return { state: "unknown", error: "case_channel_requires_reconciliation" };
    const staffRoles = settings.caseModeratorRoleIds,
      currentRoles = await this.context.guild.roles.fetch();
    if (staffRoles.some((role) => !currentRoles.has(role)))
      return { state: "failed", error: "cases_roles_unavailable" };
    const overwrites = [
      { id: this.context.guild.id, type: 0, allow: "0", deny: P.ViewChannel.toString() },
      ...staffRoles.map((id) => ({ id, type: 0, allow: textAccess.toString(), deny: "0" })),
      { id: value.ownerId, type: 1, allow: textAccess.toString(), deny: "0" },
      {
        id: me.id,
        type: 1,
        allow: (textAccess | P.ManageChannels).toString(),
        deny: "0",
      },
    ];
    const freshCase = this.jobs.db
      .prepare("SELECT generation,visibility FROM cases WHERE guild_id=? AND id=?")
      .get(value.guildId, value.id);
    if (freshCase?.generation !== value.generation || freshCase.visibility !== "private")
      return { state: "expired", reason: "stale_generation" };
    if (this.settings.read().revision !== settings.revision)
      return {
        state: "retry",
        at: execution.now() + 1,
        error: "settings_changed",
        rateLimited: true,
      };
    execution.checkpoint();
    this.context.store.beginOperation(operation, {
      guildId: value.guildId,
      caseId: value.id,
      jobId: job.id,
      generation: value.generation,
    });
    execution.beginAttempt({ nonce: deliveryNonce(job.id), channelId: category.id });
    let responseReceived = false,
      resourceConfirmed = false;
    try {
      const response = await this.rest.post(Routes.guildChannels(value.guildId), {
        signal: AbortSignal.any([execution.signal, AbortSignal.timeout(15000)]),
        body: {
          name: `sprawa-${value.id.slice(0, 8)}`,
          type: ChannelType.GuildText,
          parent_id: category.id,
          topic: "Prywatna rozmowa autora sprawy z moderacją.",
          permission_overwrites: overwrites,
        },
      });
      responseReceived = true;
      const created = object(response);
      const channelId = id(created.id);
      await this.confirmCreatedResource(
        key,
        "community-case-channel",
        channelId,
        {
          guildId: value.guildId,
          caseId: value.id,
          ownerId: value.ownerId,
          createdBy: me.id,
          parentId: category.id,
          jobId: job.id,
          staffRoleIds: staffRoles,
        },
        operation,
        ChannelType.GuildText,
      );
      resourceConfirmed = true;
      if (JSON.stringify(this.settings.read().caseModeratorRoleIds) !== JSON.stringify(staffRoles))
        this.enqueueLatestCaseAcl(value.id);
      execution.checkpoint();
      await this.caseTarget({
        guildId: value.guildId,
        caseId: value.id,
        ownerId: value.ownerId,
        visibility: "private",
        audience: "staff",
        generation: value.generation,
      });
      return { state: "succeeded", result: { channelId } };
    } catch (error) {
      if (responseReceived && !resourceConfirmed)
        return { state: "unknown", error: "created_channel_identity_unconfirmed" };
      if (resourceConfirmed && error instanceof ControlError)
        return { state: "failed", error: error.code };
      const outcome = effectError(error, execution.now());
      if (outcome.state === "retry" || outcome.state === "failed")
        this.context.store.endOperation(operation);
      return outcome;
    }
  }
  private meetingContent(value: PreparedMeetingJob): string {
    const meeting = value.meeting,
      states: Record<string, string> = {
        draft: "Szkic",
        open: "Zapisy otwarte",
        starting: "Przygotowanie pokoju",
        active: "Trwa",
        completed: "Zakończone",
        cancelled: "Odwołane",
      };
    if (meeting.visibility === "private")
      return `**Prywatne spotkanie**\n${states[meeting.state]}. Szczegóły są dostępne dla zaproszonych osób w panelu lub przez /spotkanie stan.`;
    if (value.type === "meeting.reminder")
      return clip(
        `Przypomnienie: ${meeting.title}\nSpotkanie zaczyna się <t:${Math.floor(meeting.startsAt / 1000)}:R>. Zapis pozostaje w panelu spotkania.`,
      );
    if (value.type === "meeting.promoted")
      return clip(
        `Zwolniło się miejsce na „${meeting.title}”. Osoba <@${value.recipientId}> jest teraz na liście uczestników.`,
      );
    const roomLink =
      meeting.roomChannelId &&
      !(meeting.roomCreatedByBot && ["completed", "cancelled"].includes(meeting.state))
        ? `\nPokój: <#${meeting.roomChannelId}>`
        : "";
    return clip(
      `**${meeting.title}**\n${meeting.description}\n\n${states[meeting.state]} · <t:${Math.floor(meeting.startsAt / 1000)}:F>\nMiejsca: ${meeting.confirmedCount}/${meeting.capacity}${meeting.waitlistedCount ? ` · Rezerwa: ${meeting.waitlistedCount}` : ""}${roomLink}`,
    );
  }
  private recordMeetingResult(job: Job, result: MeetingEffectResult): void {
    try {
      this.meetings.recordResult(job, result);
    } catch (error) {
      if (result.messageId && job.leaseToken)
        this.jobs.transaction(() => {
          const receipt = this.jobs.recordReceipt(job.id, job.leaseToken!, {
              messageId: result.messageId,
            }),
            current = this.jobs.db
              .prepare("SELECT channel_id,message_id FROM meetings WHERE guild_id=? AND id=?")
              .get(job.guildId, job.objectId!);
          if (
            job.type === "meeting.publish" &&
            receipt.channelId &&
            (current?.message_id !== result.messageId || current?.channel_id !== receipt.channelId)
          )
            this.enqueueEffect({
              guildId: job.guildId,
              objectId: job.objectId!,
              type: "community.meeting-controls-clear",
              dedupeKey: `community:meeting-controls-clear:${receipt.id}`,
              payload: {
                sourceJobId: job.id,
                attemptId: receipt.id,
                channelId: receipt.channelId,
                messageId: result.messageId,
              },
            });
        });
      if (result.roomChannelId && result.roomCreatedByBot) {
        const current = this.jobs.db
          .prepare("SELECT state FROM meetings WHERE guild_id=? AND id=?")
          .get(job.guildId, job.objectId!);
        if (current && ["completed", "cancelled"].includes(String(current.state)))
          this.enqueueEffect(
            {
              guildId: job.guildId,
              objectId: job.objectId!,
              generation: job.generation,
              type: "community.meeting-cleanup",
              dedupeKey: `community:meeting-cleanup:${result.roomChannelId}`,
              payload: { meetingId: job.objectId, channelId: result.roomChannelId },
            },
            7 * 86400000,
          );
      }
      if (
        !(error instanceof MeetingError) ||
        !["stale_job", "stale_generation", "revision_conflict", "state_conflict"].includes(
          error.code,
        )
      )
        throw error;
    }
  }
  private async clearMeetingControls(
    job: Job,
    execution: ExecutionContext,
  ): Promise<ExecutionOutcome> {
    if (!this.effectsReady) return { state: "failed", error: "module_unavailable" };
    const payload = object(job.payload),
      source = this.jobs.get(String(payload.sourceJobId)),
      receipt =
        source && this.jobs.attempts(source.id).find((item) => item.id === payload.attemptId);
    if (
      !source ||
      source.type !== "meeting.publish" ||
      source.guildId !== job.guildId ||
      !job.objectId ||
      source.objectId !== job.objectId ||
      object(source.payload).meetingId !== job.objectId ||
      !receipt ||
      receipt.state !== "succeeded" ||
      receipt.channelId !== payload.channelId ||
      receipt.messageId !== payload.messageId
    )
      return { state: "failed", error: "meeting_message_not_owned" };
    const channelId = id(payload.channelId),
      messageId = id(payload.messageId),
      isCurrent = () => {
        const current = this.jobs.db
          .prepare("SELECT channel_id,message_id FROM meetings WHERE guild_id=? AND id=?")
          .get(job.guildId, job.objectId!);
        return current?.channel_id === channelId && current?.message_id === messageId;
      };
    if (isCurrent()) return { state: "expired", reason: "meeting_message_is_current" };
    await this.context.guild.fetch();
    await this.channel(channelId);
    const me = await this.context.guild.members.fetchMe({ force: true });
    let message: Record<string, unknown>;
    try {
      message = object(
        await this.rest.get(Routes.channelMessage(channelId, messageId), {
          signal: AbortSignal.any([execution.signal, AbortSignal.timeout(15000)]),
        }),
      );
    } catch (error) {
      if (discordErrorCode(error) === 10008) return { state: "succeeded" };
      throw error;
    }
    if (
      message.id !== messageId ||
      message.channel_id !== channelId ||
      object(message.author).id !== me.id ||
      me.id !== this.context.client.user?.id
    )
      return { state: "failed", error: "meeting_message_not_owned" };
    if (isCurrent()) return { state: "expired", reason: "meeting_message_is_current" };
    execution.checkpoint();
    execution.beginAttempt({ nonce: deliveryNonce(job.id), channelId });
    try {
      const result = object(
        await this.rest.patch(Routes.channelMessage(channelId, messageId), {
          signal: AbortSignal.any([execution.signal, AbortSignal.timeout(15000)]),
          body: {
            components: [],
            allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
          },
        }),
      );
      if (result.id !== messageId)
        return { state: "unknown", error: "meeting_controls_clear_unconfirmed" };
      return { state: "succeeded" };
    } catch (error) {
      return effectError(error, execution.now());
    }
  }
  private async cleanupMeetingRoom(
    job: Job,
    execution: ExecutionContext,
    channelId: string,
  ): Promise<ExecutionOutcome> {
    const resource = this.context.store.resource(`community.meeting.${job.objectId}`);
    if (!resource || resource.id !== channelId || resource.kind !== "community-meeting-room")
      return { state: "failed", error: "meeting_room_not_owned" };
    const baseline = object(JSON.parse(resource.baseline)),
      me = await this.context.guild.members.fetchMe({ force: true });
    if (
      baseline.guildId !== job.guildId ||
      baseline.meetingId !== job.objectId ||
      baseline.createdBy !== me.id ||
      baseline.owned !== true
    )
      return { state: "failed", error: "meeting_room_not_owned" };
    try {
      const result = await this.voice().remove(
        channelId,
        { source: "meeting", objectId: job.objectId!, categoryId: String(baseline.parentId) },
        {
          signal: execution.signal,
          beforeMutation: () => {
            execution.checkpoint();
            execution.beginAttempt({ nonce: deliveryNonce(job.id), channelId });
          },
        },
      );
      return {
        state: "succeeded",
        result: result.removed ? { removedChannelId: channelId } : { alreadyRemoved: channelId },
      };
    } catch (error) {
      if (error instanceof VoiceRoomError)
        return ["voice_occupied", "voice_gateway_unavailable"].includes(error.code)
          ? { state: "retry", at: execution.now() + 60000, error: error.code, rateLimited: true }
          : { state: "failed", error: error.code };
      return effectError(error, execution.now());
    }
  }
  private enqueueMeetingAcl(meetingId: string): void {
    const resource = this.context.store.resource(`community.meeting.${meetingId}`);
    const value = this.jobs.db
      .prepare("SELECT generation,participant_version FROM meetings WHERE guild_id=? AND id=?")
      .get(this.context.guild.id, meetingId);
    if (resource?.kind === "community-meeting-room" && value)
      this.enqueueEffect({
        guildId: this.context.guild.id,
        objectId: meetingId,
        generation: Number(value.generation),
        type: "community.meeting-acl",
        dedupeKey: `community:meeting-acl:${meetingId}:${value.generation}:${value.participant_version}:${resource.id}`,
        payload: {
          meetingId,
          channelId: resource.id,
          participantVersion: value.participant_version,
        },
      });
  }
  async memberRemoved(
    userId: string,
    eventId: string,
    joinedBefore = Number.MAX_SAFE_INTEGER,
  ): Promise<MeetingMutation[]> {
    const changes = await this.meetings.memberRemoved(userId, eventId, joinedBefore, false);
    for (const change of changes) {
      this.enqueueMeetingAcl(change.meeting.id);
      this.enqueueMeetingReconciliation(change.meeting.id);
    }
    return changes;
  }
  private roomOverwrites(
    meeting: Pick<
      Meeting,
      "guildId" | "visibility" | "allowedRoleIds" | "invitedUserIds" | "organizerId"
    >,
    participants: string[],
    botId: string,
    roles = meeting.allowedRoleIds,
    deniedUserIds: string[] = [],
  ) {
    const privateRoom = meeting.visibility === "private" || meeting.allowedRoleIds.length > 0;
    const users = meeting.allowedRoleIds.length
      ? participants.filter((userId) => meeting.invitedUserIds.includes(userId))
      : participants;
    return [
      {
        id: meeting.guildId,
        type: 0,
        allow: privateRoom ? "0" : voiceAccess.toString(),
        deny: privateRoom ? voiceAccess.toString() : "0",
      },
      ...roles.map((id) => ({ id, type: 0, allow: voiceAccess.toString(), deny: "0" })),
      ...[...new Set([meeting.organizerId, ...users])].map((id) => ({
        id,
        type: 1,
        allow: voiceAccess.toString(),
        deny: "0",
      })),
      ...deniedUserIds
        .filter((userId) => userId !== meeting.organizerId && userId !== botId)
        .map((id) => ({ id, type: 1, allow: "0", deny: voiceAccess.toString() })),
      {
        id: botId,
        type: 1,
        allow: (voiceAccess | P.ManageChannels).toString(),
        deny: "0",
      },
    ];
  }
  private async updateMeetingAcl(job: Job, execution: ExecutionContext): Promise<ExecutionOutcome> {
    if (!this.effectsReady) return { state: "failed", error: "module_unavailable" };
    const payload = object(job.payload),
      resource = this.context.store.resource(`community.meeting.${job.objectId}`);
    if (
      resource?.kind !== "community-meeting-room" ||
      resource.id !== payload.channelId ||
      payload.meetingId !== job.objectId
    )
      return { state: "failed", error: "meeting_room_not_owned" };
    const row = this.jobs.db
      .prepare("SELECT * FROM meetings WHERE guild_id=? AND id=?")
      .get(job.guildId, job.objectId!);
    if (
      !row ||
      row.generation !== job.generation ||
      row.participant_version !== payload.participantVersion
    ) {
      if (row) this.enqueueMeetingAcl(String(row.id));
      return { state: "expired", reason: "meeting_changed" };
    }
    const baseline = object(JSON.parse(resource.baseline)),
      guild = await this.context.guild.fetch(),
      roles = await guild.roles.fetch(),
      me = await guild.members.fetchMe({ force: true });
    if (
      baseline.guildId !== job.guildId ||
      baseline.meetingId !== job.objectId ||
      baseline.owned !== true ||
      baseline.createdBy !== me.id
    )
      return { state: "failed", error: "meeting_room_not_owned" };
    let channel: GuildBasedChannel;
    try {
      channel = await this.channel(resource.id);
    } catch (error) {
      if (error instanceof ControlError && error.code === "channel_missing")
        return { state: "succeeded", result: { alreadyRemoved: resource.id } };
      throw error;
    }
    if (channel.type !== ChannelType.GuildVoice || channel.parentId !== baseline.parentId)
      return { state: "failed", error: "meeting_room_identity_changed" };
    const definition = {
      guildId: job.guildId,
      organizerId: String(row.organizer_id),
      visibility: row.visibility as "public" | "private",
      allowedRoleIds: JSON.parse(String(row.allowed_role_ids)) as string[],
      invitedUserIds: this.jobs.db
        .prepare("SELECT user_id FROM meeting_invites WHERE meeting_id=?")
        .all(String(row.id))
        .map((invite) => String(invite.user_id)),
    };
    const participants = this.jobs.db
      .prepare("SELECT user_id FROM meeting_participants WHERE meeting_id=? AND state='confirmed'")
      .all(String(row.id))
      .map((person) => String(person.user_id));
    const currentMeeting = this.meetings.systemDetail(String(row.id));
    const eligibleParticipants: string[] = [];
    for (const userId of participants)
      if (await this.eligible(userId, currentMeeting.meeting)) eligibleParticipants.push(userId);
    const sourceChannel = await this.channel(currentMeeting.meeting.channelId);
    const overwrites = this.roomOverwrites(
      definition,
      eligibleParticipants,
      me.id,
      definition.allowedRoleIds.filter(
        (role) =>
          roles.has(role) && sourceChannel.permissionsFor(roles.get(role)!)?.has(P.ViewChannel),
      ),
      ("permissionOverwrites" in sourceChannel
        ? [...sourceChannel.permissionOverwrites.cache.values()]
        : []
      )
        .filter(
          (overwrite) =>
            overwrite.type === 1 &&
            overwrite.deny.has(P.ViewChannel) &&
            !overwrite.allow.has(P.ViewChannel),
        )
        .map((overwrite) => overwrite.id),
    );
    const current = this.jobs.db
      .prepare("SELECT generation,participant_version FROM meetings WHERE guild_id=? AND id=?")
      .get(job.guildId, job.objectId!);
    if (
      current?.generation !== job.generation ||
      current.participant_version !== payload.participantVersion
    ) {
      this.enqueueMeetingAcl(String(row.id));
      return { state: "expired", reason: "meeting_changed" };
    }
    try {
      const confirmed = await this.voice().permissions(
        channel.id,
        { source: "meeting", objectId: job.objectId!, categoryId: String(baseline.parentId) },
        overwrites,
        {
          signal: execution.signal,
          beforeMutation: () => {
            const latest = this.jobs.db
              .prepare(
                "SELECT generation,participant_version FROM meetings WHERE guild_id=? AND id=?",
              )
              .get(job.guildId, job.objectId!);
            if (
              latest?.generation !== job.generation ||
              latest.participant_version !== payload.participantVersion
            ) {
              this.enqueueMeetingAcl(String(row.id));
              throw new MeetingError("stale_generation");
            }
            execution.checkpoint();
            execution.beginAttempt({ nonce: deliveryNonce(job.id), channelId: channel.id });
          },
        },
      );
      const fresh = this.jobs.db
        .prepare("SELECT generation,participant_version FROM meetings WHERE guild_id=? AND id=?")
        .get(job.guildId, job.objectId!);
      if (
        fresh?.generation !== job.generation ||
        fresh.participant_version !== payload.participantVersion
      ) {
        this.enqueueMeetingAcl(String(row.id));
        return { state: "unknown", error: "meeting_acl_state_changed" };
      }
      if (definition.visibility === "private" || definition.allowedRoleIds.length)
        this.provePrivate(
          confirmed,
          new Set([
            definition.organizerId,
            ...eligibleParticipants.filter(
              (userId) =>
                !definition.allowedRoleIds.length || definition.invitedUserIds.includes(userId),
            ),
          ]),
          new Set(definition.allowedRoleIds),
          me.id,
        );
      this.context.store.putResource(resource.key, resource.kind, resource.id, {
        ...baseline,
        aclParticipantVersion: payload.participantVersion,
      });
      return { state: "succeeded", result: { channelId: channel.id } };
    } catch (error) {
      if (error instanceof MeetingError) return { state: "expired", reason: error.code };
      if (error instanceof VoiceRoomError) return { state: "failed", error: error.code };
      return effectError(error, execution.now());
    }
  }
  private async executeMeeting(job: Job, execution: ExecutionContext): Promise<ExecutionOutcome> {
    this.require("meetings");
    if (job.type === "meeting.publish" && job.objectId) this.enqueueMeetingAcl(job.objectId);
    const prepared = await this.meetings.prepare(job),
      meeting = prepared.meeting;
    if (["meeting.publish", "meeting.reminder", "meeting.promoted"].includes(job.type)) {
      const components: TrustedButtonRow[] =
        job.type === "meeting.publish" && !["completed", "cancelled"].includes(meeting.state)
          ? [
              {
                type: 1,
                components: [
                  ...(meeting.state === "open"
                    ? [
                        {
                          type: 2 as const,
                          style: 1 as const,
                          label:
                            meeting.visibility === "public" && meeting.full
                              ? "Dołącz do rezerwy"
                              : "Dołącz",
                          custom_id: communityButtonId(
                            "meeting",
                            meeting.guildId,
                            meeting.id,
                            "join",
                          ),
                        },
                      ]
                    : []),
                  {
                    type: 2,
                    style: 2,
                    label: "Rezygnuję",
                    custom_id: communityButtonId("meeting", meeting.guildId, meeting.id, "leave"),
                  },
                  {
                    type: 2,
                    style: 2,
                    label: "Szczegóły",
                    custom_id: communityButtonId("meeting", meeting.guildId, meeting.id, "read"),
                  },
                ],
              },
            ]
          : [];
      const publication = {
        guildId: meeting.guildId,
        channelId: meeting.channelId,
        content: this.meetingContent(prepared),
        roleIds: [],
        everyone: false,
        components,
      };
      if (job.type === "meeting.publish" && meeting.messageId) {
        validatePublication(publication);
        await this.authorizeMeeting({
          guildId: meeting.guildId,
          actorId: meeting.organizerId,
          operation: "deliver",
          meeting,
          participantIds: prepared.participants
            .filter((person) => person.state !== "left")
            .map((person) => person.userId),
          jobType: prepared.type,
        });
        execution.checkpoint();
        execution.beginAttempt({ nonce: deliveryNonce(job.id), channelId: meeting.channelId });
        try {
          const result = object(
            await this.rest.patch(Routes.channelMessage(meeting.channelId, meeting.messageId), {
              signal: execution.signal,
              body: {
                content: publication.content,
                components: publication.components,
                allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
              },
            }),
          );
          id(result.id);
          this.recordMeetingResult(job, { messageId: meeting.messageId });
          return { state: "succeeded", messageId: meeting.messageId };
        } catch (error) {
          return effectError(error, execution.now());
        }
      }
      const outcome = await publishDiscord(
        job.id,
        publication,
        execution,
        this.transport(async () => {
          await this.meetings.prepare(job);
        }),
      );
      if (outcome.state === "succeeded" && job.type === "meeting.publish")
        this.recordMeetingResult(job, { messageId: outcome.messageId });
      return outcome;
    }
    if (job.type === "meeting.start") {
      if (prepared.room.kind === "none") {
        this.meetings.recordResult(job, {});
        return { state: "succeeded" };
      }
      if (prepared.room.kind === "existing") {
        const channel = await this.channel(prepared.room.channelId);
        if (channel.type !== ChannelType.GuildVoice)
          return { state: "failed", error: "meeting_room_unavailable" };
        this.meetings.recordResult(job, { roomChannelId: channel.id, roomCreatedByBot: false });
        return { state: "succeeded" };
      }
      const resourceKey = `community.meeting.${meeting.id}`,
        prior = this.context.store.resource(resourceKey);
      if (prior) return { state: "failed", error: "meeting_room_requires_reconciliation" };
      const category = await this.channel(prepared.room.categoryId),
        me = await this.context.guild.members.fetchMe({ force: true });
      if (
        category.type !== ChannelType.GuildCategory ||
        !category.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles])
      )
        return { state: "failed", error: "meeting_category_unavailable" };
      const operation = `community:meeting-room:${meeting.id}`;
      if (this.context.store.operations().some((entry) => object(entry).key === operation))
        return { state: "unknown", error: "meeting_room_requires_reconciliation" };
      const privateRoom = meeting.visibility === "private" || meeting.allowedRoleIds.length > 0;
      const candidates = prepared.participants
        .filter((person) => person.state === "confirmed")
        .map((person) => person.userId);
      const confirmedParticipants: string[] = [];
      for (const userId of candidates)
        if (await this.eligible(userId, meeting)) confirmedParticipants.push(userId);
      const sourceChannel = await this.channel(meeting.channelId),
        currentRoles = await this.context.guild.roles.fetch();
      const overwrites = this.roomOverwrites(
        meeting,
        confirmedParticipants,
        me.id,
        meeting.allowedRoleIds.filter(
          (role) =>
            currentRoles.has(role) &&
            sourceChannel.permissionsFor(currentRoles.get(role)!)?.has(P.ViewChannel),
        ),
        ("permissionOverwrites" in sourceChannel
          ? [...sourceChannel.permissionOverwrites.cache.values()]
          : []
        )
          .filter(
            (overwrite) =>
              overwrite.type === 1 &&
              overwrite.deny.has(P.ViewChannel) &&
              !overwrite.allow.has(P.ViewChannel),
          )
          .map((overwrite) => overwrite.id),
      );
      execution.checkpoint();
      this.context.store.beginOperation(operation, {
        guildId: meeting.guildId,
        meetingId: meeting.id,
        generation: meeting.generation,
        jobId: job.id,
      });
      let responseReceived = false,
        resourceConfirmed = false;
      try {
        const channel = await this.voice().create({
          operation,
          source: "meeting",
          objectId: meeting.id,
          categoryId: category.id,
          name:
            meeting.visibility === "private" ? "Prywatne spotkanie" : meeting.title.slice(0, 90),
          userLimit: meeting.capacity,
          overwrites,
          signal: execution.signal,
          beforeMutation: () => {
            const latest = this.jobs.db
              .prepare(
                "SELECT revision,generation,participant_version FROM meetings WHERE guild_id=? AND id=?",
              )
              .get(meeting.guildId, meeting.id);
            if (
              latest?.revision !== meeting.revision ||
              latest.generation !== meeting.generation ||
              latest.participant_version !== meeting.participantVersion
            )
              throw new VoiceRoomError("meeting_changed", true, 409);
            execution.checkpoint();
            execution.beginAttempt({ nonce: deliveryNonce(job.id), channelId: category.id });
          },
        });
        responseReceived = true;
        const channelId = channel.id;
        this.jobs.transaction(() => {
          this.context.store.putResource(resourceKey, "community-meeting-room", channelId, {
            guildId: meeting.guildId,
            meetingId: meeting.id,
            createdBy: me.id,
            parentId: category.id,
            jobId: job.id,
            owned: true,
          });
          this.context.store.endOperation(operation);
        });
        resourceConfirmed = true;
        if (privateRoom)
          this.provePrivate(
            channel,
            new Set([
              meeting.organizerId,
              ...confirmedParticipants.filter(
                (userId) =>
                  !meeting.allowedRoleIds.length || meeting.invitedUserIds.includes(userId),
              ),
            ]),
            new Set(meeting.allowedRoleIds),
            me.id,
          );
        this.recordMeetingResult(job, { roomChannelId: channelId, roomCreatedByBot: true });
        this.enqueueMeetingAcl(meeting.id);
        execution.checkpoint();
        return { state: "succeeded", result: { channelId } };
      } catch (error) {
        if (error instanceof VoiceRoomError && error.notCreated) {
          this.context.store.endOperation(operation);
          if (error.code === "meeting_changed")
            return {
              state: "retry",
              at: execution.now() + 1000,
              error: "meeting_changed",
              rateLimited: true,
            };
          if (error.code === "voice_capacity")
            return {
              state: "retry",
              at: execution.now() + 60000,
              error: error.code,
              rateLimited: true,
            };
          if (error.status === 429) return effectError(error.cause ?? error, execution.now());
          if (error.status && error.status >= 400 && error.status < 500)
            return { state: "failed", error: error.code };
          throw error;
        }
        if (error instanceof VoiceRoomError) return { state: "unknown", error: error.code };
        if (responseReceived && !resourceConfirmed)
          return { state: "unknown", error: "created_channel_identity_unconfirmed" };
        if (resourceConfirmed && error instanceof ControlError)
          return { state: "failed", error: error.code };
        const outcome = effectError(error, execution.now());
        if (outcome.state === "retry" || outcome.state === "failed")
          this.context.store.endOperation(operation);
        return outcome;
      }
    }
    if (job.type === "meeting.finish") {
      const resource = this.context.store.resource(`community.meeting.${meeting.id}`);
      const channelId = prepared.cleanupRoom?.channelId ?? resource?.id;
      if (!channelId) {
        this.meetings.recordResult(job, {});
        return { state: "succeeded" };
      }
      const outcome = await this.cleanupMeetingRoom(job, execution, channelId);
      if (outcome.state === "succeeded") this.recordMeetingResult(job, {});
      return outcome;
    }
    return { state: "failed", error: "unsupported_job" };
  }
  async execute(job: Job, execution: ExecutionContext): Promise<ExecutionOutcome> {
    if (job.guildId !== this.context.guild.id) return { state: "failed", error: "guild_mismatch" };
    try {
      if (job.type === "community.meeting-reconcile") {
        const payload = object(job.payload);
        if (!this.effectsReady || payload.meetingId !== job.objectId)
          return { state: "failed", error: "meeting_reconciliation_invalid" };
        if (!this.settings.read().enabled.meetings)
          return {
            state: "retry",
            at: execution.now() + 60000,
            error: "module_disabled",
            rateLimited: true,
          };
        execution.checkpoint();
        const result = await this.meetings.reconcileParticipants(job.objectId!, job.id, () =>
          execution.checkpoint(),
        );
        execution.checkpoint();
        this.enqueueMeetingAcl(result.meeting.id);
        return { state: "succeeded", result: { meetingId: result.meeting.id } };
      }
      if (job.type === "community.case-channel") return await this.provisionCase(job, execution);
      if (job.type === "community.case-acl") return await this.updateCaseAcl(job, execution);
      if (job.type === "community.meeting-acl") return await this.updateMeetingAcl(job, execution);
      if (job.type === "community.meeting-controls-clear")
        return await this.clearMeetingControls(job, execution);
      if (job.type === "community.meeting-cleanup") {
        const payload = object(job.payload);
        if (!this.effectsReady || payload.meetingId !== job.objectId)
          return { state: "failed", error: "module_unavailable" };
        const current = this.jobs.db
          .prepare("SELECT state FROM meetings WHERE guild_id=? AND id=?")
          .get(job.guildId, job.objectId!);
        if (!current || !["completed", "cancelled"].includes(String(current.state)))
          return { state: "failed", error: "meeting_cleanup_not_authorized" };
        return this.cleanupMeetingRoom(job, execution, id(payload.channelId));
      }
      if (job.type === "case.notify") {
        this.require("cases");
        const payload = object(job.payload),
          value = this.jobs.db
            .prepare("SELECT visibility FROM cases WHERE guild_id=? AND id=?")
            .get(job.guildId, String(payload.caseId));
        if (
          value?.visibility === "private" &&
          !this.context.store.resource(`community.case.${payload.caseId}`)
        ) {
          const provision = this.jobs.list({
            guildId: job.guildId,
            type: "community.case-channel",
            objectId: String(payload.caseId),
            limit: 1,
          })[0];
          if (!provision) return { state: "failed", error: "case_channel_not_scheduled" };
          if (["failed", "unknown", "cancelled", "expired"].includes(provision.state))
            return { state: "failed", error: "case_channel_requires_reconciliation" };
          return {
            state: "retry",
            at: execution.now() + 5000,
            error: "case_channel_pending",
            rateLimited: true,
          };
        }
        const publication = await this.cases.prepareNotification(job, (scope) =>
          this.caseTarget(scope),
        );
        return await publishDiscord(
          job.id,
          {
            guildId: job.guildId,
            channelId: publication.channelId,
            content: publication.content,
            roleIds: [],
            everyone: false,
          },
          execution,
          this.transport(async () => {
            await this.cases.prepareNotification(job, (scope) => this.caseTarget(scope));
          }),
        );
      }
      if (job.type.startsWith("meeting.")) return await this.executeMeeting(job, execution);
      return { state: "failed", error: "unsupported_job" };
    } catch (error) {
      if (
        error instanceof RateLimitError ||
        (error && typeof error === "object" && "status" in error && error.status === 429)
      )
        return effectError(error, execution.now());
      if (error instanceof MeetingError || error instanceof CaseError)
        return [
          "stale_generation",
          "expired",
          "stale_job",
          "state_conflict",
          "revision_conflict",
        ].includes(error.code)
          ? { state: "expired", reason: error.code }
          : { state: "failed", error: error.code };
      if (error instanceof ControlError)
        return error.code === "cases_configuration_required"
          ? { state: "retry", at: execution.now() + 60000, error: error.code, rateLimited: true }
          : { state: "failed", error: error.code };
      throw error;
    }
  }
}
