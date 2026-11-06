import { MessageType, Routes } from "discord.js";
import type { Api } from "../bootstrap/api.js";

export interface PinNotice {
  id: string;
  type: number;
  channel_id: string;
  author?: { id: string };
  message_reference?: { message_id?: string; channel_id?: string };
}

export function isManagedPinNotice(
  message: PinNotice,
  channelId: string,
  botId: string,
  managedIds: ReadonlySet<string>,
): boolean {
  return (
    message.type === MessageType.ChannelPinnedMessage &&
    message.channel_id === channelId &&
    message.author?.id === botId &&
    (!message.message_reference?.channel_id ||
      message.message_reference.channel_id === channelId) &&
    managedIds.has(message.message_reference?.message_id ?? "")
  );
}

export async function removePinNotices(
  api: Api,
  channelId: string,
  botId: string,
  managedIds: ReadonlySet<string>,
): Promise<number> {
  const messages = (await api.get(`${Routes.channelMessages(channelId)}?limit=100`)) as PinNotice[];
  const notices = messages.filter((message) =>
    isManagedPinNotice(message, channelId, botId, managedIds),
  );
  for (const notice of notices) await api.delete(Routes.channelMessage(channelId, notice.id));
  return notices.length;
}
