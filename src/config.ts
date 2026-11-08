import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireId } from "./shared/utils.js";

export type ChannelKind = "readonly" | "text" | "forum" | "voice" | "admin";
export interface Config {
  brand: { name: string; description: string; discordDescription: string };
  roles: { key: string; name: string }[];
  categories: { key: string; name: string }[];
  channels: { key: string; name: string; category: string; kind: ChannelKind }[];
  rooms: {
    ownerLimit: number;
    emptySeconds: number;
    transferSeconds: number;
    maximum: number;
    creationCooldownSeconds: number;
  };
  attachments: {
    uploadsEnabled: boolean;
    extensions: string[];
    maxBytes: number;
    timeoutMs: number;
    concurrency: number;
    queueLimit: number;
    hosts: string[];
    excludedApplicationIds: string[];
  };
  moderation: {
    mentionLimit: number;
    reportCooldownSeconds: number;
    notificationCooldownSeconds: number;
    retentionDays: number;
    spamDomains: string[];
  };
  onboarding: {
    key: string;
    title: string;
    options: { title: string; description?: string; role?: string; channel?: string }[];
  }[];
}
export interface Environment {
  token: string;
  clientId: string;
  guildId: string;
  ownerId: string;
  databasePath: string;
}

export function loadCredentials(values = process.env): Pick<Environment, "token" | "clientId"> {
  const token = values.DISCORD_TOKEN;
  if (!token || token.trim() !== token)
    throw new Error("Set DISCORD_TOKEN in the local environment.");
  return {
    token,
    clientId: requireId(values.DISCORD_CLIENT_ID, "DISCORD_CLIENT_ID"),
  };
}

export function loadEnvironment(values = process.env): Environment {
  return {
    ...loadCredentials(values),
    guildId: requireId(values.DISCORD_GUILD_ID, "DISCORD_GUILD_ID"),
    ownerId: requireId(values.OWNER_USER_ID, "OWNER_USER_ID"),
    databasePath: resolve(values.DATABASE_PATH || "data/gildiusz.sqlite"),
  };
}

export function loadConfig(path = process.env.CONFIG_PATH || "config/server.json"): Config {
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  validateConfig(config);
  return config;
}

export function validateConfig(config: Config): void {
  if (
    !config.brand?.name ||
    config.brand.name.length > 100 ||
    config.brand.discordDescription.length > 120
  )
    throw new Error("Brand name or description exceeds Discord limits.");
  // Guild descriptions allow 120 characters. The original prose is retained as content.
  const groups = [config.roles, config.categories, config.channels];
  for (const group of groups) {
    if (!Array.isArray(group)) throw new Error("Missing configuration group.");
    const keys = group.map((entry) => entry.key);
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key))
    )
      throw new Error("Duplicate or invalid stable key.");
    if (group.some((entry) => !entry.name || entry.name.length > 100))
      throw new Error("Invalid display name.");
  }
  if (config.roles.length !== 10 || config.categories.length !== 7 || config.channels.length !== 15)
    throw new Error("Server layout differs from the agreed first version.");
  for (const channel of config.channels) {
    if (!config.categories.some((category) => category.key === channel.category))
      throw new Error("Unknown category.");
    if (!["readonly", "text", "forum", "voice", "admin"].includes(channel.kind))
      throw new Error("Invalid channel kind.");
  }
  const numeric = [
    config.rooms,
    config.moderation,
    {
      maxBytes: config.attachments.maxBytes,
      timeoutMs: config.attachments.timeoutMs,
      concurrency: config.attachments.concurrency,
      queueLimit: config.attachments.queueLimit,
    },
  ];
  for (const group of numeric)
    for (const value of Object.values(group)) {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1))
        throw new Error("Invalid numeric limit.");
    }
  if (
    config.rooms.ownerLimit !== 1 ||
    config.rooms.maximum > 45 ||
    config.moderation.mentionLimit > 50 ||
    config.attachments.maxBytes > 65536
  )
    throw new Error("Configured limits are outside the supported range.");
  if (
    config.attachments.extensions.some(
      (ext) => !["pdf", "png", "jpg", "jpeg", "webp", "gif"].includes(ext),
    )
  )
    throw new Error("Unsupported attachment type.");
  if (
    config.attachments.hosts.some(
      (host) => !["cdn.discordapp.com", "media.discordapp.net"].includes(host),
    )
  )
    throw new Error("Untrusted attachment host.");
  config.attachments.excludedApplicationIds.forEach((id) =>
    requireId(id, "excludedApplicationIds"),
  );
  for (const prompt of config.onboarding)
    for (const option of prompt.options) {
      if (option.role && !config.roles.some((role) => role.key === option.role))
        throw new Error("Unknown onboarding role.");
      if (option.channel && !config.channels.some((channel) => channel.key === option.channel))
        throw new Error("Unknown onboarding channel.");
    }
}
