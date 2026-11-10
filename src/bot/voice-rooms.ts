import {
  ChannelType,
  PermissionFlagsBits as P,
  RateLimitError,
  Routes,
  type REST,
  type VoiceChannel,
  type GuildBasedChannel,
  type CategoryChannel,
} from "discord.js";
import type { BotContext } from "./context.js";
import { discordErrorCode } from "./module-permissions.js";
import { transaction } from "../storage/migrations.js";

export type VoiceRoomSource = "temporary" | "meeting";
export interface VoiceRoomIdentity {
  source: VoiceRoomSource;
  objectId?: string;
  categoryId?: string;
}
export interface VoiceOverwrite {
  id: string;
  type: number;
  allow: string | bigint;
  deny: string | bigint;
}
export type VoicePermissions = VoiceOverwrite[] | ((category: CategoryChannel) => VoiceOverwrite[]);
export interface VoiceMutation {
  signal?: AbortSignal;
  beforeMutation?(): void;
}
export interface VoiceRoomCreate extends VoiceMutation {
  operation: string;
  source: VoiceRoomSource;
  objectId: string;
  categoryId: string;
  name: string;
  userLimit: number;
  overwrites: VoicePermissions;
}
export interface VoiceRoomDiagnostics {
  httpStatus?: number;
  discordCode?: number;
  validationFields?: { field: string; code: string }[];
}
export class VoiceRoomError extends Error {
  readonly discordCode?: number;
  readonly validationFields?: VoiceRoomDiagnostics["validationFields"];
  constructor(
    readonly code: string,
    readonly notCreated: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "VoiceRoomError";
    const diagnostic = voiceErrorDiagnostics(options?.cause);
    this.discordCode = diagnostic.discordCode;
    this.validationFields = diagnostic.validationFields;
  }
}
type Metadata = Record<string, unknown>;
function metadata(value: unknown): Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Metadata;
}
export function voiceErrorDiagnostics(error: unknown): VoiceRoomDiagnostics {
  const value = metadata(error),
    status = Number(value.status),
    code = value.discordCode ?? value.code,
    fields: NonNullable<VoiceRoomDiagnostics["validationFields"]> = [];
  const allowedFields = new Set([
    "name",
    "type",
    "parent_id",
    "user_limit",
    "bitrate",
    "rtc_region",
    "permission_overwrites",
  ]);
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 5 || fields.length >= 16) return;
    const item = metadata(node);
    if (Array.isArray(item._errors))
      for (const entry of item._errors.slice(0, 16)) {
        const detail = metadata(entry);
        if (
          typeof detail.code === "string" &&
          /^[A-Z0-9_]{1,80}$/.test(detail.code) &&
          fields.length < 16
        )
          fields.push({ field: path || "$", code: detail.code });
      }
    for (const [key, child] of Object.entries(item)) {
      if (depth === 0 ? !allowedFields.has(key) : !/^(?:\d{1,3}|id|type|allow|deny)$/.test(key))
        continue;
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(metadata(value.rawError).errors, "", 0);
  // Never persist messages, request bodies, names, URLs or the original SDK error.
  return {
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { httpStatus: status } : {}),
    ...(typeof code === "number" && Number.isSafeInteger(code) && code > 0
      ? { discordCode: code }
      : {}),
    ...(fields.length ? { validationFields: fields } : {}),
  };
}
function parse(value: string): Metadata {
  try {
    return metadata(JSON.parse(value));
  } catch {
    return {};
  }
}
function snowflake(value: unknown): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value))
    throw new VoiceRoomError("voice_invalid_input", true, 400);
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 240 || value.includes("\0"))
    throw new VoiceRoomError("voice_invalid_input", true, 400);
  return value;
}
export function definitiveNoVoiceCreate(error: unknown): boolean {
  return error instanceof VoiceRoomError && error.notCreated;
}
function definitiveResponse(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  const status = Number(metadata(error).status);
  return status >= 400 && status < 500 && status !== 408;
}

export class DiscordVoiceRooms {
  constructor(
    readonly context: BotContext,
    private readonly rest: REST,
  ) {
    if (rest.options?.retries !== 0 || typeof rest.options?.rejectOnRateLimit !== "function")
      throw new VoiceRoomError("voice_unsafe_transport", true);
    const identity = context.store.db
      .prepare("SELECT name FROM sqlite_master WHERE name='guild_identity'")
      .get();
    if (
      identity &&
      context.store.db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()
        ?.guild !== context.guild.id
    )
      throw new VoiceRoomError("voice_guild_mismatch", true);
  }
  ready(): boolean {
    return (
      this.context.client.isReady() &&
      this.context.guild.available &&
      this.context.client.ws.status === 0
    );
  }
  private maximum(requested?: number): number {
    const value = Math.min(
      requested ?? 45,
      this.context.config?.rooms?.maximum ?? 45,
      this.context.control.rooms?.maxRooms ?? 45,
    );
    if (!Number.isSafeInteger(value) || value < 1 || value > 45)
      throw new VoiceRoomError("voice_invalid_limit", true);
    return value;
  }
  private occupancy() {
    const ids = new Set<string>(),
      deleted = new Set<string>(),
      represented = new Set<string>(),
      pending = new Map<string, string | null>();
    const resources = this.context.store.resources();
    for (const resource of resources) {
      if (!["voice-room", "voice-room-unverified"].includes(resource.kind)) continue;
      const value = parse(resource.baseline);
      if (value.guildId !== this.context.guild.id) continue;
      if (value.deleted === true) {
        deleted.add(resource.id);
        if (typeof value.operation === "string") represented.add(value.operation);
        continue;
      }
      ids.add(resource.id);
      if (typeof value.operation === "string") represented.add(value.operation);
    }
    for (const room of this.context.store.rooms()) if (!deleted.has(room.id)) ids.add(room.id);
    for (const resource of resources) {
      if (
        !["community-meeting-room", "community-meeting-room-unverified"].includes(resource.kind) ||
        deleted.has(resource.id)
      )
        continue;
      const value = parse(resource.baseline);
      if (value.guildId !== this.context.guild.id) continue;
      ids.add(resource.id);
      if (typeof value.meetingId === "string")
        represented.add(`community:meeting-room:${value.meetingId}`);
    }
    for (const entry of this.context.store.operations()) {
      const operation = metadata(entry),
        name = String(operation.key),
        value = parse(String(operation.body));
      if (name.startsWith("voice:create:")) {
        if (
          value.guildId === this.context.guild.id &&
          typeof value.operation === "string" &&
          !represented.has(value.operation)
        )
          pending.set(
            value.operation,
            typeof value.categoryId === "string" ? value.categoryId : null,
          );
      } else if (
        (name.startsWith("room-create:") || name.startsWith("community:meeting-room:")) &&
        !represented.has(name)
      ) {
        let categoryId: string | null = null;
        if (name.startsWith("room-create:"))
          categoryId = this.context.control.rooms?.categoryId ?? null;
        else if (typeof value.meetingId === "string") {
          const row = this.context.store.db
            .prepare("SELECT room FROM meetings WHERE guild_id=? AND id=?")
            .get(this.context.guild.id, value.meetingId);
          const room = row ? parse(String(row.room)) : {};
          if (room.kind === "create" && typeof room.categoryId === "string")
            categoryId = room.categoryId;
        }
        if (!pending.has(name)) pending.set(name, categoryId);
      }
    }
    return { ids, pending, total: ids.size + pending.size };
  }
  counts(): { occupied: number; reserved: number; total: number } {
    const value = this.occupancy();
    return { occupied: value.ids.size, reserved: value.pending.size, total: value.total };
  }
  capacity(categoryId: string, maximum?: number): boolean {
    const value = this.occupancy();
    return value.total < this.maximum(maximum) && this.physicalCapacity(categoryId, value);
  }
  private physicalCapacity(
    categoryId: string,
    value: ReturnType<DiscordVoiceRooms["occupancy"]>,
    excludedOperation?: string,
    channels: ReadonlyMap<string, GuildBasedChannel> = this.context.guild.channels.cache,
  ): boolean {
    const unknown = [...value.pending].filter(([operation]) => operation !== excludedOperation);
    const missing = [...value.ids].filter((id) => !channels.has(id));
    const siblings = [...channels.values()].filter(
      (channel) => channel.parentId === categoryId,
    ).length;
    return (
      channels.size + missing.length + unknown.length < 490 &&
      siblings +
        unknown.filter(([, category]) => category === null || category === categoryId).length <
        45
    );
  }
  private reserve(
    input: VoiceRoomCreate,
    botId: string,
    channels: ReadonlyMap<string, GuildBasedChannel>,
  ): void {
    transaction(this.context.store.db, () => {
      const reservation = `voice:create:${input.operation}`;
      if (this.context.store.operations().some((entry) => metadata(entry).key === reservation))
        throw new VoiceRoomError("voice_unknown_create", false);
      if (
        this.context.store
          .resources()
          .some(
            (resource) =>
              ["voice-room", "voice-room-unverified"].includes(resource.kind) &&
              parse(resource.baseline).guildId === this.context.guild.id &&
              parse(resource.baseline).operation === input.operation &&
              parse(resource.baseline).deleted !== true,
          )
      )
        throw new VoiceRoomError("voice_existing_operation", false);
      const value = this.occupancy(),
        count = value.total - (value.pending.has(input.operation) ? 1 : 0);
      if (
        count >= this.maximum() ||
        !this.physicalCapacity(input.categoryId, value, input.operation, channels)
      )
        throw new VoiceRoomError("voice_capacity", true);
      this.context.store.beginOperation(reservation, {
        guildId: this.context.guild.id,
        source: input.source,
        objectId: input.objectId,
        categoryId: input.categoryId,
        operation: input.operation,
        createdBy: botId,
      });
    });
  }
  private overwrites(values: VoiceOverwrite[], botId: string) {
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length > 1000 ||
      new Set(values.map((value) => value.id)).size !== values.length
    )
      throw new VoiceRoomError("voice_invalid_permissions", true, 400);
    return values.map((value) => {
      snowflake(value.id);
      if (value.type !== 0 && value.type !== 1)
        throw new VoiceRoomError("voice_invalid_permissions", true, 400);
      let allow = BigInt(value.allow);
      const deny = BigInt(value.deny);
      if (allow < 0n || deny < 0n || (value.id === botId && (allow & P.Administrator) !== 0n))
        throw new VoiceRoomError("voice_invalid_permissions", true, 400);
      // Non-admin bots inherit ManageRoles from guild roles; Discord forbids granting
      // it through a channel overwrite even when the bot already holds it globally.
      if (value.id === botId) allow &= ~P.ManageRoles;
      return { id: value.id, type: value.type, allow: allow.toString(), deny: deny.toString() };
    });
  }
  async create(input: VoiceRoomCreate): Promise<VoiceChannel> {
    snowflake(input.categoryId);
    key(input.operation);
    key(input.objectId);
    if (
      !["temporary", "meeting"].includes(input.source) ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 100 ||
      !Number.isInteger(input.userLimit) ||
      input.userLimit < 0 ||
      input.userLimit > 99
    )
      throw new VoiceRoomError("voice_invalid_input", true, 400);
    let reserved = false,
      requested = false,
      responseReceived = false;
    try {
      if (!this.ready()) throw new VoiceRoomError("voice_gateway_unavailable", true);
      const guild = await this.context.guild.fetch();
      await guild.roles.fetch();
      const channels = new Map<string, GuildBasedChannel>();
      for (const [id, channel] of await guild.channels.fetch())
        if (channel) channels.set(id, channel);
      const me = await guild.members.fetchMe({ force: true }),
        category = channels.get(input.categoryId);
      if (
        guild.id !== this.context.guild.id ||
        category?.guildId !== guild.id ||
        category.type !== ChannelType.GuildCategory ||
        !me.permissions.has([P.ManageChannels, P.ManageRoles]) ||
        !category.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles])
      )
        throw new VoiceRoomError("voice_permission_unavailable", true, 403);
      const permissionOverwrites = this.overwrites(
        typeof input.overwrites === "function" ? input.overwrites(category) : input.overwrites,
        me.id,
      );
      this.reserve(input, me.id, channels);
      reserved = true;
      input.signal?.throwIfAborted();
      input.beforeMutation?.();
      requested = true;
      const rawResponse = await this.rest.post(Routes.guildChannels(guild.id), {
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
        reason: input.operation,
        body: {
          name: input.name,
          type: ChannelType.GuildVoice,
          parent_id: input.categoryId,
          user_limit: input.userLimit,
          permission_overwrites: permissionOverwrites,
        },
      });
      responseReceived = true;
      const response = metadata(rawResponse);
      const channelId = snowflake(response.id),
        baseline = {
          guildId: guild.id,
          source: input.source,
          objectId: input.objectId,
          categoryId: input.categoryId,
          createdBy: me.id,
          operation: input.operation,
          owned: false,
          deleted: false,
        };
      this.context.store.putResource(
        `voice.room.${channelId}`,
        "voice-room-unverified",
        channelId,
        baseline,
      );
      const channel = await guild.channels.fetch(channelId, { force: true });
      if (
        !channel ||
        channel.guildId !== guild.id ||
        channel.type !== ChannelType.GuildVoice ||
        channel.parentId !== input.categoryId
      )
        throw new VoiceRoomError("voice_identity_unconfirmed", false);
      if (!this.confirmedPermissions(channel, permissionOverwrites))
        throw new VoiceRoomError("voice_permissions_unconfirmed", false);
      transaction(this.context.store.db, () => {
        this.context.store.putResource(`voice.room.${channelId}`, "voice-room", channelId, {
          ...baseline,
          owned: true,
        });
        this.context.store.endOperation(`voice:create:${input.operation}`);
      });
      return channel;
    } catch (error) {
      const notCreated =
        !requested ||
        (!responseReceived && !(error instanceof VoiceRoomError) && definitiveResponse(error));
      if (reserved && notCreated)
        this.context.store.endOperation(`voice:create:${input.operation}`);
      const failure =
        error instanceof VoiceRoomError && (!requested || !error.notCreated)
          ? error
          : new VoiceRoomError(
              notCreated ? "voice_request_rejected" : "voice_unknown_create",
              notCreated,
              error instanceof RateLimitError ? 429 : Number(metadata(error).status) || undefined,
              { cause: error },
            );
      if (requested) {
        const diagnostic = voiceErrorDiagnostics(error);
        try {
          this.context.store.event(
            "voice-create",
            input.operation,
            JSON.stringify({ error: failure.code, ...diagnostic }),
          );
        } catch {
          // A diagnostic failure must not change a known or uncertain create outcome.
        }
      }
      throw failure;
    }
  }
  private tombstone(channelId: string, baseline: Metadata): void {
    this.context.store.putResource(`voice.room.${channelId}`, "voice-room", channelId, {
      ...baseline,
      owned: true,
      deleted: true,
    });
  }
  private confirmedPermissions(
    channel: VoiceChannel,
    values: { id: string; type: number; allow: string; deny: string }[],
  ): boolean {
    const actual = channel.permissionOverwrites.cache;
    return (
      actual.size === values.length &&
      values.every((value) => {
        const saved = actual.get(value.id);
        return (
          saved?.type === value.type &&
          saved.allow.bitfield === BigInt(value.allow) &&
          saved.deny.bitfield === BigInt(value.deny)
        );
      })
    );
  }
  async inspect(
    channelId: string,
    expected: VoiceRoomIdentity,
    options: { fresh?: boolean } = {},
  ): Promise<VoiceChannel | null> {
    snowflake(channelId);
    if (!["temporary", "meeting"].includes(expected.source))
      throw new VoiceRoomError("voice_not_owned", false);
    const resource = this.context.store.resource(`voice.room.${channelId}`);
    let baseline = resource ? parse(resource.baseline) : undefined;
    if (resource && resource.kind !== "voice-room")
      throw new VoiceRoomError("voice_not_owned", false);
    if (resource && baseline?.guildId !== this.context.guild.id)
      throw new VoiceRoomError("voice_not_owned", false);
    if (resource && baseline?.deleted === true) return null;
    let legacy = false;
    if (!resource) {
      if (expected.source === "temporary" && this.context.store.room(channelId)) {
        baseline = {
          guildId: this.context.guild.id,
          source: "temporary",
          categoryId: expected.categoryId ?? this.context.control.rooms.categoryId,
          owned: true,
          legacy: true,
        };
        legacy = true;
      } else if (expected.source === "meeting" && expected.objectId) {
        const old = this.context.store.resource(`community.meeting.${expected.objectId}`),
          saved = old ? parse(old.baseline) : {};
        if (
          old?.id === channelId &&
          old.kind === "community-meeting-room" &&
          saved.guildId === this.context.guild.id &&
          saved.meetingId === expected.objectId &&
          saved.owned === true
        ) {
          baseline = {
            guildId: saved.guildId,
            source: "meeting",
            objectId: saved.meetingId,
            categoryId: saved.parentId,
            createdBy: saved.createdBy,
            owned: true,
            legacy: true,
          };
          legacy = true;
        }
      }
    }
    if (
      !baseline ||
      baseline.owned !== true ||
      baseline.source !== expected.source ||
      (expected.source === "meeting" && baseline.objectId !== expected.objectId) ||
      (expected.categoryId !== undefined && baseline.categoryId !== expected.categoryId)
    )
      throw new VoiceRoomError("voice_not_owned", false);
    if (options.fresh === false && !legacy) {
      const cached = this.context.guild.channels.cache.get(channelId),
        botId = this.context.client.user?.id ?? this.context.environment.clientId;
      if (baseline.createdBy !== botId) throw new VoiceRoomError("voice_not_owned", false);
      if (cached) {
        if (
          cached.guildId !== this.context.guild.id ||
          cached.type !== ChannelType.GuildVoice ||
          cached.parentId !== baseline.categoryId
        )
          throw new VoiceRoomError("voice_identity_changed", false);
        return cached;
      }
    }
    const guild = await this.context.guild.fetch();
    if (guild.id !== this.context.guild.id) throw new VoiceRoomError("voice_guild_mismatch", false);
    await guild.roles.fetch();
    const me = await guild.members.fetchMe({ force: true });
    if (!legacy && baseline.createdBy !== me.id) throw new VoiceRoomError("voice_not_owned", false);
    if (legacy && baseline.createdBy !== undefined && baseline.createdBy !== me.id)
      throw new VoiceRoomError("voice_not_owned", false);
    let channel;
    try {
      channel = await guild.channels.fetch(channelId, { force: true });
    } catch (error) {
      if (discordErrorCode(error) !== 10003) throw error;
    }
    if (!channel) {
      this.tombstone(channelId, { ...baseline, createdBy: me.id });
      return null;
    }
    if (
      channel.guildId !== guild.id ||
      channel.type !== ChannelType.GuildVoice ||
      channel.parentId !== baseline.categoryId
    )
      throw new VoiceRoomError("voice_identity_changed", false);
    if (legacy) {
      this.context.store.putResource(`voice.room.${channelId}`, "voice-room", channelId, {
        ...baseline,
        createdBy: me.id,
        owned: true,
        deleted: false,
      });
    }
    return channel;
  }
  async remove(
    channelId: string,
    expected: VoiceRoomIdentity,
    mutation: VoiceMutation = {},
  ): Promise<{ removed: boolean }> {
    const channel = await this.inspect(channelId, expected);
    if (!channel) return { removed: false };
    const me = await this.context.guild.members.fetchMe({ force: true });
    if (!channel.permissionsFor(me)?.has(P.ManageChannels))
      throw new VoiceRoomError("voice_permission_unavailable", false, 403);
    if (!this.ready()) throw new VoiceRoomError("voice_gateway_unavailable", false);
    if ([...channel.members.values()].some((member) => !member.user.bot))
      throw new VoiceRoomError("voice_occupied", false);
    mutation.signal?.throwIfAborted();
    mutation.beforeMutation?.();
    try {
      await this.rest.delete(Routes.channel(channelId), {
        signal: mutation.signal
          ? AbortSignal.any([mutation.signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
        reason: "Pusty zarządzany pokój",
      });
    } catch (error) {
      if (discordErrorCode(error) !== 10003) throw error;
    }
    this.tombstone(
      channelId,
      parse(this.context.store.resource(`voice.room.${channelId}`)!.baseline),
    );
    return { removed: true };
  }
  async permissions(
    channelId: string,
    expected: VoiceRoomIdentity,
    overwrites: VoicePermissions,
    mutation: VoiceMutation = {},
  ): Promise<VoiceChannel> {
    const channel = await this.inspect(channelId, expected);
    if (!channel) throw new VoiceRoomError("voice_missing", false);
    const me = await this.context.guild.members.fetchMe({ force: true });
    if (
      !me.permissions.has([P.ManageChannels, P.ManageRoles]) ||
      !channel.permissionsFor(me)?.has([P.ManageChannels, P.ManageRoles])
    )
      throw new VoiceRoomError("voice_permission_unavailable", false, 403);
    let selected: VoiceOverwrite[];
    if (typeof overwrites === "function") {
      const categoryId =
        expected.categoryId ??
        parse(this.context.store.resource(`voice.room.${channelId}`)!.baseline).categoryId;
      const category = await this.context.guild.channels.fetch(snowflake(categoryId), {
        force: true,
      });
      if (
        !category ||
        category.guildId !== this.context.guild.id ||
        category.type !== ChannelType.GuildCategory
      )
        throw new VoiceRoomError("voice_identity_changed", false);
      selected = overwrites(category);
    } else selected = overwrites;
    const values = this.overwrites(selected, me.id);
    mutation.signal?.throwIfAborted();
    mutation.beforeMutation?.();
    await this.rest.patch(Routes.channel(channelId), {
      signal: mutation.signal
        ? AbortSignal.any([mutation.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      body: { permission_overwrites: values },
    });
    const confirmed = await this.inspect(channelId, expected);
    if (!confirmed) throw new VoiceRoomError("voice_missing", false);
    if (!this.confirmedPermissions(confirmed, values))
      throw new VoiceRoomError("voice_permissions_unconfirmed", false);
    return confirmed;
  }
  async rename(channelId: string, expected: VoiceRoomIdentity, name: string): Promise<void> {
    if (typeof name !== "string" || !name.trim() || name.length > 100)
      throw new VoiceRoomError("voice_invalid_input", false, 400);
    const channel = await this.inspect(channelId, expected);
    if (!channel) throw new VoiceRoomError("voice_missing", false);
    const me = await this.context.guild.members.fetchMe({ force: true });
    if (!channel.permissionsFor(me)?.has(P.ManageChannels))
      throw new VoiceRoomError("voice_permission_unavailable", false, 403);
    await this.rest.patch(Routes.channel(channelId), {
      signal: AbortSignal.timeout(15000),
      body: { name },
    });
  }
}
