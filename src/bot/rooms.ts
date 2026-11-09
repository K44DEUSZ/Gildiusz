import {
  ChannelType,
  PermissionFlagsBits as P,
  type VoiceChannel,
  type ChatInputCommandInteraction,
} from "discord.js";
import { RoomService, type RoomPort } from "./room-service.js";
import type { BotContext } from "./context.js";
import { overwrites } from "../permissions/model.js";
import { readContent } from "../content.js";
import { errorCode } from "../shared/utils.js";

export function discordRoomService(context: BotContext): RoomService {
  const category = context.control.rooms.categoryId;
  function roomOverwrites(locked = false, allowed: string[] = []) {
    if (context.managedLayout && category === context.store.resource("category.rooms")?.id) {
      const entries = overwrites(
        locked ? "private" : "voice",
        context.guild.id,
        context.store.id("role.moderator"),
        context.environment.clientId,
      );
      if (locked)
        for (const id of allowed)
          entries.push({ id, type: 1, allow: (P.ViewChannel | P.Connect).toString(), deny: "0" });
      return entries.map((entry) => ({
        ...entry,
        allow: BigInt(entry.allow),
        deny: BigInt(entry.deny),
        type: entry.type as 0 | 1,
      }));
    }
    const parent = context.guild.channels.cache.get(category);
    if (parent?.type !== ChannelType.GuildCategory) throw Error("Missing room category");
    const access = P.ViewChannel | P.Connect;
    const entries = [...parent.permissionOverwrites.cache.values()]
      .filter((entry) => entry.id !== context.environment.clientId)
      .map((entry) => ({
        id: entry.id,
        type: entry.type as 0 | 1,
        allow: locked ? entry.allow.bitfield & ~access : entry.allow.bitfield,
        deny: locked ? entry.deny.bitfield | access : entry.deny.bitfield,
      }));
    if (locked && !entries.some((entry) => entry.id === context.guild.id))
      entries.push({ id: context.guild.id, type: 0, allow: 0n, deny: access });
    for (const id of locked ? allowed : []) {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) entries.splice(index, 1);
      entries.push({ id, type: 1, allow: access, deny: 0n });
    }
    entries.push({
      id: context.environment.clientId,
      type: 1,
      allow:
        P.ViewChannel |
        P.Connect |
        P.ManageChannels |
        P.ManageRoles |
        P.MoveMembers |
        P.ReadMessageHistory |
        P.SendMessages |
        P.ManageMessages,
      deny: 0n,
    });
    return entries;
  }
  async function managedChannel(id: string): Promise<VoiceChannel | null> {
    try {
      const channel = await context.guild.channels.fetch(id);
      if (!channel) return null;
      if (
        channel.type !== ChannelType.GuildVoice ||
        channel.parentId !== category ||
        !context.store.room(id)
      )
        throw new Error("Managed room identity differs from the database.");
      return channel;
    } catch (error) {
      if (errorCode(error) === "10003") return null;
      throw error;
    }
  }
  const port: RoomPort = {
    ready: () =>
      context.client.isReady() && context.guild.available && context.client.ws.status === 0,
    members: async (id) => {
      const channel = await managedChannel(id);
      return channel
        ? [...channel.members.values()].map((member) => ({
            id: member.id,
            name: member.displayName,
            bot: member.user.bot,
          }))
        : null;
    },
    eligible: async (id) => {
      try {
        const member = await context.member(id);
        return !member.user.bot;
      } catch (error) {
        if (
          ["pending", "timeout", "10007"].includes(
            error instanceof Error ? error.message : errorCode(error),
          ) ||
          errorCode(error) === "10007"
        )
          return false;
        throw error;
      }
    },
    atEntrance: (id) =>
      context.control.modules.rooms &&
      context.guild.voiceStates.cache.get(id)?.channelId === context.control.rooms.entryChannelId,
    capacity: () =>
      context.guild.channels.cache.size < 490 &&
      [...context.guild.channels.cache.values()].filter((channel) => channel.parentId === category)
        .length < 45,
    create: async (name, operation) =>
      (
        await context.guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: category,
          reason: operation,
          rateLimitPerUser: 0,
          userLimit: context.control.rooms.userLimit,
          permissionOverwrites: roomOverwrites(),
        })
      ).id,
    move: async (id, channel) => {
      const member = await context.member(id);
      if (member.voice.channelId !== context.control.rooms.entryChannelId) return false;
      await member.voice.setChannel(channel, "Pokój projektowy");
      return true;
    },
    remove: async (id) => {
      const channel = await managedChannel(id);
      if (channel && channel.members.size === 0) await channel.delete("Pusty zarządzany pokój");
      else if (channel) throw new Error("Occupied room cannot be removed.");
    },
    permissions: async (room) => {
      const channel = await managedChannel(room.id);
      if (!channel) throw new Error("Room no longer exists.");
      await channel.permissionOverwrites.set(
        roomOverwrites(room.locked, room.allowed),
        "Dostęp do pokoju projektowego",
      );
    },
    rename: async (id, name) => {
      const channel = await managedChannel(id);
      if (!channel) throw new Error("Room no longer exists.");
      await channel.setName(name);
    },
  };
  return new RoomService(context.store, context.config.rooms, port);
}

export async function roomCommand(
  context: BotContext,
  service: RoomService,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const member = await context.member(interaction.user.id);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "pomoc") {
    await interaction.editReply(readContent("room-help.md"));
    return;
  }
  const roomId = member.voice.channelId;
  if (!roomId) throw new Error("Wejdź do swojego pokoju projektowego.");
  if (!context.store.cooldown(`room-control:${member.id}`, 2000)) throw new Error("cooldown");
  const actions = { nazwa: "name", zamknij: "close", otworz: "open", zapros: "invite" } as const;
  const action = actions[subcommand as keyof typeof actions];
  if (!action) throw new Error("Unknown room command.");
  const argument =
    action === "name"
      ? interaction.options.getString("nazwa", true)
      : action === "invite"
        ? interaction.options.getUser("osoba", true).id
        : undefined;
  await service.control(roomId, member.id, context.moderator(member), action, argument);
  const reply = {
    name: context.texts.roomRenamed,
    close: context.texts.roomClosed,
    open: context.texts.roomOpened,
    invite: context.texts.roomInvited.replace(
      "{{room.link}}",
      `https://discord.com/channels/${context.guild.id}/${roomId}`,
    ),
  };
  await interaction.editReply(reply[action]);
}
