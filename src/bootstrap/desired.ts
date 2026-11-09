import {
  Routes,
  ChannelType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
} from "discord.js";
import type { Config, Environment } from "../config.js";
import { readContent, readJson, render, publications } from "../content.js";
import { commands } from "../bot/commands.js";
import { memberPermissions, overwrites, P } from "../permissions/model.js";
import type { Body } from "./api.js";

export interface Desired {
  key: string;
  kind: "role" | "channel" | "guild" | "onboarding" | "automod" | "command" | "message";
  body: Body;
  parent?: string;
  sensitive?: boolean;
  pin?: boolean;
}
export const reference = (key: string) => `@{${key}}`;

const roleColors: Record<string, number> = {
  programming: 0x7cb8ff,
  design: 0xc89bff,
  marketing: 0xff9ec4,
  business: 0xf3b46c,
  media: 0x68d6ce,
  hasProject: 0x8bd49c,
  seeksTeam: 0x83cedb,
  joinsProject: 0xa9b8ff,
  seeksFeedback: 0xd5aaf0,
  seeksInspiration: 0xd1d5db,
  moderator: 0x66d9a6,
};

export function desired(
  config: Config,
  environment: Environment,
  phase: "core" | "community" | "content",
): Desired[] {
  const result: Desired[] = [];
  const everyone = environment.guildId,
    moderator = reference("role.moderator"),
    bot = environment.clientId;
  if (phase !== "content") {
    result.push({
      key: "role.everyone",
      kind: "role",
      body: {
        permissions: (
          BigInt(memberPermissions) & (config.attachments.uploadsEnabled ? ~0n : ~P.AttachFiles)
        ).toString(),
      },
      sensitive: true,
    });
    for (const role of config.roles)
      result.push({
        key: `role.${role.key}`,
        kind: "role",
        body: {
          name: role.name,
          permissions: "0",
          hoist: false,
          mentionable: false,
          color: roleColors[role.key] ?? 0,
        },
      });
    result.push({
      key: "role.moderator",
      kind: "role",
      body: {
        name: "Moderator",
        color: roleColors.moderator,
        hoist: true,
        mentionable: false,
      },
      sensitive: true,
    });
    for (const [index, category] of config.categories.entries())
      result.push({
        key: `category.${category.key}`,
        kind: "channel",
        body: {
          name: category.name,
          type: ChannelType.GuildCategory,
          position: index,
          permission_overwrites: overwrites(
            category.key === "admin" ? "private" : "category",
            everyone,
            moderator,
            bot,
          ),
        },
        sensitive: category.key === "admin",
      });
    const topics = readJson<Record<string, string>>("channel-topics.json");
    for (const [index, channel] of config.channels.entries()) {
      if (phase === "core" && channel.kind === "forum") continue;
      const body: Body = {
        name: channel.name,
        type:
          channel.kind === "forum"
            ? ChannelType.GuildForum
            : channel.kind === "voice"
              ? ChannelType.GuildVoice
              : ChannelType.GuildText,
        parent_id: reference(`category.${channel.category}`),
        position: index,
        permission_overwrites: overwrites(
          channel.key === "join" ? "entrance" : channel.kind,
          everyone,
          moderator,
          bot,
        ),
        rate_limit_per_user: 0,
        nsfw: false,
      };
      if (channel.key === "start") {
        const entries = body.permission_overwrites as { id: string; allow: string }[];
        const botEntry = entries.find((entry) => entry.id === bot)!;
        botEntry.allow = (BigInt(botEntry.allow) | P.AddReactions).toString();
      }
      if (channel.kind === "voice") {
        body.user_limit = 0;
        body.bitrate = 64000;
      } else if (topics[channel.key]) body.topic = render(topics[channel.key], config);
      if (channel.kind === "forum") {
        body.topic = render(
          readContent(`${channel.key}-guidelines.md`) +
            "\n\n```text\n" +
            readContent(`${channel.key}-template.txt`) +
            "\n```",
          config,
        );
        body.default_forum_layout = 1;
        body.default_reaction_emoji = { emoji_id: null, emoji_name: "👍" };
        body.default_thread_rate_limit_per_user = 0;
        body.flags = 16;
        body.available_tags = (
          channel.key === "showcase"
            ? ["Pomysł", "W budowie", "Działa", "Szukam opinii", "Start"]
            : ["Hobbystycznie", "Płatnie", "Udziały", "Szukam współtwórcy", "Zamknięte", "Start"]
        ).map((name) => ({ name, moderated: false, emoji_id: null, emoji_name: null }));
      }
      result.push({ key: `channel.${channel.key}`, kind: "channel", body, sensitive: true });
    }
    if (phase === "community") {
      result.push({
        key: "guild.settings",
        kind: "guild",
        sensitive: true,
        body: {
          name: config.brand.name,
          description: config.brand.discordDescription,
          verification_level: 2,
          explicit_content_filter: 2,
          default_message_notifications: 1,
          preferred_locale: "pl",
          rules_channel_id: reference("channel.rules"),
          public_updates_channel_id: reference("channel.logs"),
          safety_alerts_channel_id: reference("channel.moderation"),
        },
      });
      result.push({
        key: "guild.onboarding",
        kind: "onboarding",
        sensitive: true,
        body: {
          enabled: true,
          mode: 0,
          default_channel_ids: config.channels
            .filter((channel) => !["admin", "voice"].includes(channel.kind))
            .map((channel) => reference(`channel.${channel.key}`)),
          prompts: config.onboarding.map((prompt) => ({
            title: prompt.title,
            type: 0,
            single_select: false,
            required: false,
            in_onboarding: true,
            options: prompt.options.map((option) => ({
              title: option.title,
              description: option.description ?? "",
              role_ids: option.role ? [reference(`role.${option.role}`)] : [],
              channel_ids: option.channel ? [reference(`channel.${option.channel}`)] : [],
            })),
          })),
        },
      });
      for (const [key, name, trigger, metadata] of [
        ["spam", "spam", AutoModerationRuleTriggerType.Spam, {}],
        [
          "mentions",
          "nadmierne oznaczenia",
          AutoModerationRuleTriggerType.MentionSpam,
          {
            mention_total_limit: config.moderation.mentionLimit,
            mention_raid_protection_enabled: true,
          },
        ],
        ...(config.moderation.spamDomains.length
          ? [
              [
                "domains",
                "potwierdzone domeny spamowe",
                AutoModerationRuleTriggerType.Keyword,
                { keyword_filter: config.moderation.spamDomains },
              ],
            ]
          : []),
      ] as [string, string, AutoModerationRuleTriggerType, Body][])
        result.push({
          key: `automod.${key}`,
          kind: "automod",
          body: {
            name: `${config.brand.name}: ${name}`.slice(0, 100),
            event_type: AutoModerationRuleEventType.MessageSend,
            trigger_type: trigger,
            trigger_metadata: metadata,
            enabled: true,
            exempt_roles: [],
            exempt_channels: [],
            actions: [
              { type: AutoModerationActionType.BlockMessage },
              {
                type: AutoModerationActionType.SendAlertMessage,
                metadata: { channel_id: reference("channel.moderation") },
              },
            ],
          },
        });
      for (const command of commands()) {
        const body = { ...command };
        delete body.contexts;
        delete body.integration_types;
        result.push({ key: `command.${command.name}`, kind: "command", body: { ...body } });
      }
    }
  } else
    for (const publication of publications(config))
      result.push({
        key: publication.key,
        kind: "message",
        parent: reference(`channel.${publication.channel}`),
        pin: publication.pin,
        body: {
          content: publication.text,
          allowed_mentions: { parse: [], replied_user: false },
          flags: 4,
        },
        sensitive: false,
      });
  const ordered: Desired[] = [];
  const visiting = new Set<string>();
  function visit(item: Desired): void {
    if (ordered.some((entry) => entry.key === item.key)) return;
    if (visiting.has(item.key)) throw new Error(`Cyclic resource dependency: ${item.key}`);
    visiting.add(item.key);
    for (const [, key] of JSON.stringify(item).matchAll(/@\{([^{}]+)\}/g)) {
      const dependency = result.find((entry) => entry.key === key);
      if (dependency) visit(dependency);
    }
    visiting.delete(item.key);
    ordered.push(item);
  }
  result.forEach(visit);
  return ordered.map((item) => ({ ...item, body: JSON.parse(JSON.stringify(item.body)) as Body }));
}

export function resourceRoute(environment: Environment, item: Desired, id?: string): string {
  switch (item.kind) {
    case "role":
      return id
        ? Routes.guildRole(environment.guildId, id)
        : Routes.guildRoles(environment.guildId);
    case "channel":
      return id ? Routes.channel(id) : Routes.guildChannels(environment.guildId);
    case "guild":
      return Routes.guild(environment.guildId);
    case "onboarding":
      return Routes.guildOnboarding(environment.guildId);
    case "automod":
      return id
        ? Routes.guildAutoModerationRule(environment.guildId, id)
        : Routes.guildAutoModerationRules(environment.guildId);
    case "command":
      return id
        ? Routes.applicationGuildCommand(environment.clientId, environment.guildId, id)
        : Routes.applicationGuildCommands(environment.clientId, environment.guildId);
    case "message":
      return id ? Routes.channelMessage(item.parent!, id) : Routes.channelMessages(item.parent!);
  }
}
