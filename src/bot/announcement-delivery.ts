import { ChannelType, PermissionFlagsBits as P, Routes, type REST } from "discord.js";
import type { BotContext } from "./context.js";
import type { ModuleSettingsStore } from "../core/modules/settings.js";
import { requirePermission } from "../core/permissions.js";
import { freshMember, discordErrorCode } from "./module-permissions.js";
import { AnnouncementError } from "../modules/announcements/types.js";
import {
  inspectedMessageFingerprint,
  type InspectedDeliveryMessage,
} from "../modules/announcements/delivery-resolution.js";

export function announcementDeliveryAccess(
  context: BotContext,
  settings: ModuleSettingsStore,
  rest: REST,
) {
  return {
    async authorize(actorId: string, channelIds: readonly string[]): Promise<void> {
      const { guild, member, facts } = await freshMember(context.guild, actorId);
      requirePermission("announcements.delivery.resolve", facts, settings.policy(), {
        guildId: guild.id,
      });
      const me = channelIds.length ? await guild.members.fetchMe({ force: true }) : undefined;
      for (const id of channelIds) {
        const channel = await guild.channels.fetch(id, { force: true });
        if (
          !channel ||
          channel.guildId !== guild.id ||
          ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
          !channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]) ||
          !channel.permissionsFor(me!)?.has([P.ViewChannel, P.ReadMessageHistory])
        )
          throw new AnnouncementError("channel_unavailable");
      }
    },
    async fetchMessage(channelId: string, messageId: string): Promise<InspectedDeliveryMessage> {
      let message: Record<string, unknown>;
      try {
        message = (await rest.get(Routes.channelMessage(channelId, messageId), {
          signal: AbortSignal.timeout(15000),
        })) as Record<string, unknown>;
      } catch (error) {
        if ([10003, 10008, 50001, 50013].includes(discordErrorCode(error) ?? 0))
          throw new AnnouncementError("channel_unavailable");
        throw error;
      }
      if (
        !message ||
        typeof message !== "object" ||
        typeof message.id !== "string" ||
        typeof message.channel_id !== "string" ||
        !message.author ||
        typeof message.author !== "object" ||
        typeof (message.author as { id?: unknown }).id !== "string" ||
        typeof message.content !== "string" ||
        message.content.length > 2000 ||
        typeof message.timestamp !== "string" ||
        message.type !== 0
      )
        throw new AnnouncementError("delivery_conflict");
      return {
        id: message.id,
        channelId: message.channel_id,
        authorId: (message.author as { id: string }).id,
        webhook: message.webhook_id !== undefined && message.webhook_id !== null,
        content: message.content,
        createdAt: Date.parse(message.timestamp),
        // This binds two inspections of the fetched message, not the lost outgoing body.
        fingerprint: inspectedMessageFingerprint({
          id: message.id,
          channelId: message.channel_id,
          authorId: (message.author as { id: string }).id,
          content: message.content,
          timestamp: message.timestamp,
          editedTimestamp: message.edited_timestamp ?? null,
          embeds: message.embeds ?? [],
          attachments: message.attachments ?? [],
          components: message.components ?? [],
        }),
      };
    },
  };
}
