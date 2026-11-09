import {
  GuildMember,
  PermissionFlagsBits as P,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import type { Config, Environment } from "../config.js";
import type { Store } from "../storage/store.js";
import { readJson } from "../content.js";
import { noMentions, errorCode } from "../shared/utils.js";
import { SettingsService } from "../settings.js";
import { ProfileService } from "../profile.js";
import { writeProfile } from "./profile-panel.js";
import { readControlConfiguration } from "../control/configuration.js";

export class BotContext {
  readonly texts = readJson<Record<string, string>>("bot-messages.json");
  readonly settings: SettingsService;
  readonly profile: ProfileService;
  constructor(
    readonly client: Client,
    readonly guild: Guild,
    readonly store: Store,
    readonly config: Config,
    readonly environment: Environment,
    readonly managedLayout = true,
  ) {
    this.settings = new SettingsService(store, config, guild.id);
    this.profile = new ProfileService(guild.id, {
      read: async () => {
        const member = await guild.members.fetchMe({ force: true });
        const user = await client.users.fetch(client.user!.id, { force: true });
        return {
          nick: member.nickname,
          avatar: member.avatar,
          defaultName: user.username,
          avatarURL: member.avatarURL({ size: 256 }) ?? user.displayAvatarURL({ size: 256 }),
          defaultAvatarURL: user.displayAvatarURL({ size: 256 }),
        };
      },
      write: (patch, actor) => writeProfile(this, patch, actor),
      cooldown: () => store.cooldown(`profile:${guild.id}`, 60000),
      audit: (actor) => {
        store.event("profile", guild.id, `updated;actor:${actor}`);
      },
    });
  }
  get control() {
    return readControlConfiguration(
      this.store,
      this.config,
      this.settings,
      this.guild.id,
      this.managedLayout,
    );
  }
  moderator(member: GuildMember): boolean {
    return (
      member.id === this.guild.ownerId ||
      member.permissions.has(P.ManageGuild) ||
      member.roles.cache.has(this.store.resource("role.moderator")?.id ?? "")
    );
  }
  async member(id: string): Promise<GuildMember> {
    const member = await this.guild.members.fetch({ user: id, force: true });
    if (member.pending) throw new Error("pending");
    if (member.isCommunicationDisabled()) throw new Error("timeout");
    return member;
  }
  async textChannel(key: string): Promise<GuildTextBasedChannel> {
    const id =
      key === "moderation"
        ? this.control.reports.channelId
        : key === "start"
          ? this.control.reactions.channelId
          : this.store.id(`channel.${key}`);
    const channel = id ? await this.guild.channels.fetch(id) : null;
    if (!channel?.isTextBased()) throw new Error("Missing text channel.");
    return channel;
  }
  async alert(kind: string, subject: string, result: string, detail?: string): Promise<void> {
    if (!this.store.cooldown(`alert:${kind}:${subject}`, 60000)) {
      this.store.event(kind, subject, result);
      return;
    }
    try {
      const channel = await this.textChannel("moderation");
      const sent = await channel.send({
        content:
          `${kind}: ${result}\nOsoba lub zasób: ${subject}${detail ? `\n${detail}` : ""}`.slice(
            0,
            1900,
          ),
        allowedMentions: noMentions,
      });
      this.store.event(kind, subject, result, channel.id, sent.id);
    } catch (error) {
      this.store.event(kind, subject, `alert_failed:${errorCode(error)}`);
    }
  }
  async notify(id: string, channel: GuildTextBasedChannel | null, key: string): Promise<void> {
    if (
      !this.store.cooldown(
        `notice:${id}`,
        this.config.moderation.notificationCooldownSeconds * 1000,
      )
    )
      return;
    const content = this.texts[key];
    try {
      await (await this.client.users.fetch(id)).send({ content, allowedMentions: noMentions });
    } catch {
      if (channel?.permissionsFor(this.guild.members.me!)?.has(P.SendMessages)) {
        const sent = await channel.send({
          content: `<@${id}> ${content}`,
          allowedMentions: noMentions,
        });
        this.store.event("notification", id, key, channel.id, sent.id);
      }
    }
  }
  async retention(now = Date.now()): Promise<void> {
    const before = now - this.config.moderation.retentionDays * 86400000;
    for (const event of this.store.oldEvents(before)) {
      if (event.channel && event.message) {
        try {
          const channel = await this.guild.channels.fetch(event.channel);
          if (channel?.isTextBased()) {
            const message = await channel.messages.fetch(event.message);
            if (message.author.id !== this.client.user!.id)
              throw new Error("Log message is no longer owned by this bot.");
            await message.delete();
          }
        } catch (error) {
          if (!["10003", "10008"].includes(errorCode(error))) {
            console.error(`Log retention failed: ${errorCode(error)}`);
            continue;
          }
        }
      }
      this.store.deleteEvent(event.id);
    }
    this.store.cleanCooldowns(now);
  }
}
