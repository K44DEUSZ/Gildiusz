import type { Message, PartialMessage } from "discord.js";
import { extension, fetchHeader, matchesHeader } from "./attachment-policy.js";
import type { BotContext } from "./context.js";
import { errorCode, Pool, SerialQueue } from "../shared/utils.js";

export class AttachmentFilter {
  private readonly pool: Pool;
  private queues = new Map<string, { queue: SerialQueue; active: number }>();
  constructor(private context: BotContext) {
    this.pool = new Pool(
      context.config.attachments.concurrency,
      context.config.attachments.queueLimit,
    );
  }
  private inScope(message: Message | PartialMessage): boolean {
    const parent = message.channel.isThread() ? message.channel.parentId : message.channelId;
    const configuration = this.context.control;
    return (
      configuration.modules.files &&
      (configuration.files.channelIds.includes(parent ?? message.channelId) ||
        (configuration.files.includeRooms &&
          Boolean(this.context.store.room(parent ?? message.channelId))))
    );
  }
  async handle(incoming: Message | PartialMessage): Promise<void> {
    if (incoming.guildId !== this.context.environment.guildId || !this.inScope(incoming)) return;
    const entry = this.queues.get(incoming.id) ?? { queue: new SerialQueue(), active: 0 };
    entry.active++;
    this.queues.set(incoming.id, entry);
    try {
      await entry.queue.run(async () => {
        let message: Message;
        try {
          message = await incoming.fetch(true);
        } catch (error) {
          if (errorCode(error) !== "10008")
            await this.context.alert(
              "attachments",
              incoming.id,
              `message_fetch_failed:${errorCode(error)}`,
            );
          return;
        }
        const settings = this.context.config.attachments;
        if (
          message.applicationId &&
          (message.applicationId === this.context.environment.clientId ||
            settings.excludedApplicationIds.includes(message.applicationId))
        )
          return;
        if (!message.attachments.size) return;
        let failure: "attachmentDenied" | "attachmentFailed" | null = null;
        for (const attachment of message.attachments.values()) {
          if (!extension(attachment.name, settings.extensions)) {
            failure = "attachmentDenied";
            break;
          }
          try {
            const header = await this.pool.run(() => fetchHeader(attachment.url, settings));
            if (!matchesHeader(attachment.name, header, settings.extensions)) {
              failure = "attachmentDenied";
              break;
            }
          } catch {
            failure = "attachmentFailed";
            break;
          }
        }
        if (!failure) return;
        try {
          await message.delete();
        } catch (error) {
          if (errorCode(error) === "10008") return;
          await this.context.alert(
            "attachments",
            message.author.id,
            `delete_failed:${errorCode(error)}`,
            `Kanał: ${message.channelId}`,
          );
          return;
        }
        await this.context.alert(
          "attachments",
          message.author.id,
          failure,
          `Kanał: ${message.channelId}; wiadomość: ${message.id}`,
        );
        await this.context.notify(
          message.author.id,
          message.inGuild() ? message.channel : null,
          failure,
        );
      });
    } finally {
      entry.active--;
      if (!entry.active && this.queues.get(incoming.id) === entry) this.queues.delete(incoming.id);
    }
  }
  async drain(): Promise<void> {
    await Promise.all([...this.queues.values()].map((entry) => entry.queue.drain()));
  }
}
