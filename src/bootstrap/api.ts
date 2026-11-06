import { REST, Routes, PermissionFlagsBits as P } from "discord.js";
import type { Environment } from "../config.js";
import { errorCode } from "../shared/utils.js";

export type Body = Record<string, unknown>;
export interface RemoteResource extends Body {
  id: string;
  name?: string;
  type?: number;
}
export interface Snapshot {
  guild: RemoteResource;
  roles: RemoteResource[];
  channels: RemoteResource[];
  automod: RemoteResource[];
  onboarding: RemoteResource | null;
  commands: RemoteResource[];
  botId: string;
  botRoleIds?: string[];
}
export interface Api {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<RemoteResource>;
  patch(path: string, body: unknown): Promise<RemoteResource>;
  put(path: string, body: unknown): Promise<unknown>;
  delete(path: string): Promise<void>;
}

export function discordApi(environment: Environment): Api {
  const rest = new REST({ version: "10", retries: 0, timeout: 15000 }).setToken(environment.token);
  const route = (path: string) => path as `/${string}`;
  return {
    get: (path) => rest.get(route(path)),
    post: async (path, body) => (await rest.post(route(path), { body })) as RemoteResource,
    patch: async (path, body) => (await rest.patch(route(path), { body })) as RemoteResource,
    put: (path, body) => rest.put(route(path), { body }),
    delete: async (path) => {
      await rest.delete(route(path));
    },
  };
}

export async function snapshot(api: Api, environment: Environment): Promise<Snapshot> {
  const guild = (await api.get(Routes.guild(environment.guildId))) as RemoteResource;
  if (guild.owner_id !== environment.ownerId)
    throw new Error("The configured owner does not own this guild.");
  const user = (await api.get(Routes.user("@me"))) as RemoteResource;
  if (user.id !== environment.clientId)
    throw new Error("Token does not belong to DISCORD_CLIENT_ID.");
  const [roles, channels, applicationCommands] = await Promise.all([
    api.get(Routes.guildRoles(environment.guildId)),
    api.get(Routes.guildChannels(environment.guildId)),
    api.get(Routes.applicationGuildCommands(environment.clientId, environment.guildId)),
  ]);
  const member = (await api.get(Routes.guildMember(environment.guildId, user.id))) as {
    roles: string[];
  };
  const base = (roles as RemoteResource[])
    .filter((role) => role.id === environment.guildId || member.roles.includes(role.id))
    .reduce((mask, role) => mask | BigInt(String(role.permissions)), 0n);
  if (base & P.Administrator)
    throw new Error("Remove Administrator from the bot before configuration.");
  const community = (guild.features as string[]).includes("COMMUNITY");
  const automod = community
    ? ((await api.get(Routes.guildAutoModerationRules(environment.guildId))) as RemoteResource[])
    : [];
  const onboarding = community
    ? ((await api.get(Routes.guildOnboarding(environment.guildId))) as RemoteResource)
    : null;
  return {
    guild,
    roles: roles as RemoteResource[],
    channels: channels as RemoteResource[],
    automod,
    onboarding,
    commands: applicationCommands as RemoteResource[],
    botId: user.id,
    botRoleIds: member.roles,
  };
}

export async function optionalGet(api: Api, path: string): Promise<RemoteResource | null> {
  try {
    return (await api.get(path)) as RemoteResource;
  } catch (error) {
    if (["10003", "10008", "404"].includes(errorCode(error))) return null;
    throw error;
  }
}
