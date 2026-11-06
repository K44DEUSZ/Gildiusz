import { PermissionFlagsBits as P, PermissionsBitField } from "discord.js";
import type { ChannelKind } from "../config.js";

export { P };
export function bits(...values: bigint[]): string {
  return values.reduce((sum, value) => sum | value, 0n).toString();
}
export const memberPermissions = bits(
  P.ViewChannel,
  P.ReadMessageHistory,
  P.SendMessages,
  P.SendMessagesInThreads,
  P.CreatePublicThreads,
  P.AddReactions,
  P.EmbedLinks,
  P.AttachFiles,
  P.UseApplicationCommands,
  P.Connect,
  P.Speak,
  P.Stream,
  P.UseVAD,
);
export const moderatorPermissions = bits(
  P.ViewAuditLog,
  P.ManageMessages,
  P.ManageThreads,
  P.PinMessages,
  P.ModerateMembers,
  P.KickMembers,
  P.BanMembers,
  P.MoveMembers,
  P.MuteMembers,
  P.DeafenMembers,
);
export const bootstrapPermissions = bits(
  P.ManageGuild,
  P.ManageRoles,
  P.ManageChannels,
  P.ManageMessages,
  P.PinMessages,
  P.MoveMembers,
  P.ViewChannel,
  P.ReadMessageHistory,
  P.SendMessages,
  P.Connect,
);
export const runtimePermissions = bits(
  P.ManageChannels,
  P.ManageRoles,
  P.MoveMembers,
  P.ViewChannel,
  P.ReadMessageHistory,
  P.SendMessages,
  P.Connect,
);
export interface Overwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

export function overwrites(
  kind: ChannelKind | "category" | "private" | "entrance",
  everyone: string,
  moderator: string,
  bot: string,
): Overwrite[] {
  // Restricted flags are absent from @everyone; the bot cannot deny flags it does not hold.
  let deny = 0n;
  let allow = 0n;
  if (kind === "private" || kind === "admin") deny |= P.ViewChannel | P.Connect;
  else allow |= P.ViewChannel;
  if (kind === "readonly")
    deny |= P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.AddReactions;
  if (kind === "entrance")
    deny |=
      P.Speak |
      P.Stream |
      P.UseVAD |
      P.SendMessages |
      P.SendMessagesInThreads |
      P.CreatePublicThreads |
      P.AddReactions;
  const moderatorAllow =
    P.ViewChannel |
    P.Connect |
    P.ReadMessageHistory |
    (kind === "entrance" ? 0n : P.SendMessages | P.SendMessagesInThreads);
  return [
    { id: everyone, type: 0, allow: allow.toString(), deny: deny.toString() },
    { id: moderator, type: 0, allow: moderatorAllow.toString(), deny: "0" },
    {
      id: bot,
      type: 1,
      allow: bits(
        P.ViewChannel,
        P.ReadMessageHistory,
        P.SendMessages,
        P.ManageMessages,
        P.PinMessages,
        P.ManageChannels,
        P.MoveMembers,
        P.Connect,
        P.SendMessagesInThreads,
      ),
      deny: "0",
    },
  ];
}

export function effectivePermissions(
  base: bigint,
  memberId: string,
  roleIds: string[],
  everyone: string,
  entries: Overwrite[],
  timeout = false,
): bigint {
  if (base & P.Administrator) return PermissionsBitField.All;
  let result = base;
  const apply = (allow: bigint, deny: bigint) => {
    result = (result & ~deny) | allow;
  };
  const guild = entries.find((entry) => entry.id === everyone && entry.type === 0);
  if (guild) apply(BigInt(guild.allow), BigInt(guild.deny));
  let allow = 0n,
    deny = 0n;
  for (const entry of entries)
    if (entry.type === 0 && entry.id !== everyone && roleIds.includes(entry.id)) {
      allow |= BigInt(entry.allow);
      deny |= BigInt(entry.deny);
    }
  apply(allow, deny);
  const member = entries.find((entry) => entry.type === 1 && entry.id === memberId);
  if (member) apply(BigInt(member.allow), BigInt(member.deny));
  if (!(result & P.ViewChannel)) return 0n;
  if (!(result & P.SendMessages)) result &= ~(P.AttachFiles | P.EmbedLinks | P.MentionEveryone);
  if (timeout) result &= P.ViewChannel | P.ReadMessageHistory;
  return result;
}

export function permissionNames(value: string | bigint): string[] {
  const mask = BigInt(value);
  return Object.entries(P)
    .filter(([, flag]) => Boolean(mask & flag))
    .map(([name]) => name);
}
