import type { Config } from "../config.js";
import type { Store } from "../storage/store.js";
import type { SettingsService } from "../settings.js";
import { roleChoices } from "../role-selection.js";
import { parseConfiguration, type Configuration } from "./contracts.js";

export function publicConfig(): Config {
  return {
    brand: { name: "Gildiusz", description: "", discordDescription: "" },
    roles: [],
    categories: [],
    channels: [],
    onboarding: [],
    rooms: {
      ownerLimit: 1,
      emptySeconds: 60,
      transferSeconds: 30,
      maximum: 10,
      creationCooldownSeconds: 30,
    },
    attachments: {
      uploadsEnabled: true,
      extensions: ["pdf", "png", "jpg", "jpeg", "webp", "gif"],
      maxBytes: 4096,
      timeoutMs: 5000,
      concurrency: 4,
      queueLimit: 100,
      hosts: ["cdn.discordapp.com", "media.discordapp.net"],
      excludedApplicationIds: [],
    },
    moderation: {
      mentionLimit: 5,
      reportCooldownSeconds: 60,
      notificationCooldownSeconds: 60,
      retentionDays: 30,
      spamDomains: [],
    },
  };
}
export function readControlConfiguration(
  store: Store,
  config: Config,
  settings: SettingsService,
  guild: string,
  managedLayout: boolean,
): Configuration {
  const current = settings.read();
  const saved = store.controlConfiguration(guild);
  const resource = (key: string) => store.resource(key)?.id ?? "";
  const value: Configuration = saved
    ? parseConfiguration(saved)
    : {
        revision: 0,
        modules: {
          rooms: managedLayout,
          reactions: managedLayout && Boolean(resource("message.roles.0")),
          files: managedLayout,
          reports: managedLayout,
        },
        rooms: {
          entryChannelId: resource("channel.join"),
          categoryId: resource("category.rooms"),
          maxRooms: config.rooms.maximum,
          userLimit: 0,
          idleSeconds: config.rooms.emptySeconds,
        },
        reactions: {
          channelId: resource("channel.start"),
          choices: managedLayout
            ? roleChoices.flatMap((choice) =>
                resource(`role.${choice.key}`)
                  ? [{ emoji: choice.emoji, roleId: resource(`role.${choice.key}`) }]
                  : [],
              )
            : [],
        },
        files: {
          channelIds: managedLayout
            ? store
                .resources()
                .filter(
                  (entry) =>
                    entry.kind === "channel" &&
                    entry.key.startsWith("channel.") &&
                    !["channel.moderation", "channel.logs"].includes(entry.key),
                )
                .map((entry) => entry.id)
            : [],
          formats: [],
          includeRooms: managedLayout,
        },
        reports: { channelId: resource("channel.moderation") },
      };
  value.revision = current.revision;
  value.rooms.maxRooms = current.values.maximum;
  value.rooms.idleSeconds = current.values.emptySeconds;
  value.files.formats = current.values.extensions.map((entry) =>
    entry.toUpperCase(),
  ) as Configuration["files"]["formats"];
  return value;
}
