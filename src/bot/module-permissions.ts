import {
  PermissionFlagsBits as P,
  type Collection,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import type { MemberFacts } from "../core/permissions.js";
import { ControlError } from "../control/contracts.js";

export function discordErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

export function isDiscordChannelUnavailable(error: unknown): boolean {
  // The guild channel manager rejects another guild's REST result before returning a channel.
  return (
    discordErrorCode(error) === 10003 ||
    Boolean(
      error && typeof error === "object" && "code" in error && error.code === "GuildChannelUnowned",
    )
  );
}

export async function freshMember(
  guild: Guild,
  userId: string,
): Promise<{
  guild: Guild;
  member: GuildMember;
  roles: Collection<string, Role>;
  facts: MemberFacts;
}> {
  // Member permissions also depend on the current owner and role definitions.
  const current = await guild.fetch();
  const roles = await current.roles.fetch();
  let member: GuildMember;
  try {
    member = await current.members.fetch({ user: userId, force: true });
  } catch (error) {
    if (discordErrorCode(error) === 10007)
      throw new ControlError(403, "permission_revoked", "Nie należysz już do tego serwera.");
    throw error;
  }
  return { guild: current, member, roles, facts: memberFacts(current, member) };
}

export function memberFacts(guild: Guild, member: GuildMember): MemberFacts {
  return {
    guildId: guild.id,
    userId: member.id,
    owner: guild.ownerId === member.id,
    manageGuild: member.permissions.has(P.ManageGuild),
    roleIds: [...member.roles.cache.keys()],
    pending: Boolean(member.pending),
    timedOut: member.isCommunicationDisabled(),
    isBot: member.user.bot,
    voiceChannelId: member.voice.channelId,
  };
}
