import { PermissionFlagsBits as P } from "discord.js";
import {
  RulesError,
  type RulesChannel,
  type RulesDraft,
  type RulesMemberFacts,
  type RulesPreflightFacts,
} from "./types.js";

const read = P.ViewChannel | P.ReadMessageHistory;
const write =
  P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
const ordinary =
  read |
  write |
  P.AddReactions |
  P.AttachFiles |
  P.EmbedLinks |
  P.UseExternalEmojis |
  P.UseExternalStickers |
  P.Connect |
  P.Speak |
  P.Stream |
  P.UseVAD |
  P.UseApplicationCommands |
  P.UseSoundboard |
  P.UseExternalSounds |
  P.SendVoiceMessages |
  P.SendPolls;
const has = (permissions: bigint, bits: bigint) =>
  (permissions & P.Administrator) !== 0n || (permissions & bits) === bits;

export function rulesId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value))
    throw new RulesError("invalid_input");
  return value;
}
export function rulesInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new RulesError("invalid_input");
  return value as number;
}
export function rulesKey(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 200 || value.includes("\0"))
    throw new RulesError("invalid_input");
  return value;
}
export function assertFresh(observedAt: number, now: number, maximum: number): void {
  rulesInteger(observedAt);
  if (observedAt > now || now - observedAt > maximum) throw new RulesError("permission_revoked");
}

function effective(
  facts: RulesPreflightFacts,
  channel: RulesChannel,
  roleIds: string[],
  userId?: string,
): bigint {
  const everyone = facts.roles.find((entry) => entry.id === facts.guildId);
  if (!everyone || roleIds.some((id) => !facts.roles.some((role) => role.id === id)))
    throw new RulesError("incomplete_acl");
  const base = facts.roles
    .filter((role) => roleIds.includes(role.id))
    .reduce((bits, role) => bits | role.permissions, everyone.permissions);
  if ((base & P.Administrator) !== 0n) return base;
  const all = channel.overwrites.find(
    (entry) => entry.type === "role" && entry.id === facts.guildId,
  );
  let result = all ? (base & ~all.deny) | all.allow : base;
  let deny = 0n,
    allow = 0n;
  for (const overwrite of channel.overwrites)
    if (
      overwrite.type === "role" &&
      overwrite.id !== facts.guildId &&
      roleIds.includes(overwrite.id)
    ) {
      deny |= overwrite.deny;
      allow |= overwrite.allow;
    }
  result = (result & ~deny) | allow;
  const personal = channel.overwrites.find(
    (entry) => entry.type === "member" && entry.id === userId,
  );
  return personal ? (result & ~personal.deny) | personal.allow : result;
}

export function assertRulesMemberRead(
  draft: RulesDraft,
  member: RulesMemberFacts,
  facts: RulesPreflightFacts,
): void {
  const channel = facts.channels.find((entry) => entry.id === draft.channelId);
  if (
    !channel ||
    !has(effective(facts, channel, member.roleIds, member.userId), read) ||
    !has(
      effective(facts, channel, [...new Set([...member.roleIds, draft.roleId])], member.userId),
      read,
    )
  )
    throw new RulesError("channel_unavailable");
}

export function assertRulesPreflight(
  guildId: string,
  draft: RulesDraft,
  facts: RulesPreflightFacts,
  now: number,
  maximum: number,
  botId: string,
): void {
  if (facts.guildId !== guildId) throw new RulesError("permission_revoked");
  assertFresh(facts.observedAt, now, maximum);
  if (facts.complete !== true) throw new RulesError("incomplete_acl");
  if (typeof facts.nativeScreening !== "boolean") throw new RulesError("incomplete_acl");
  if (
    facts.roles.some(
      (entry) =>
        typeof entry.permissions !== "bigint" ||
        entry.permissions < 0n ||
        entry.guildId !== guildId ||
        !Number.isSafeInteger(entry.position) ||
        entry.position < 0 ||
        typeof entry.managed !== "boolean" ||
        typeof entry.restricted !== "boolean",
    )
  )
    throw new RulesError("incomplete_acl");
  const role = facts.roles.find((entry) => entry.id === draft.roleId);
  const everyone = facts.roles.find((entry) => entry.id === guildId);
  if (
    !role ||
    !everyone ||
    role.guildId !== guildId ||
    role.id === guildId ||
    role.managed !== false ||
    role.restricted !== false ||
    role.permissions !== 0n ||
    facts.interestRoleIds.includes(role.id) ||
    facts.staffRoleIds.includes(role.id) ||
    facts.botRoleIds.includes(role.id)
  )
    throw new RulesError("role_unavailable");
  const botRoles = facts.roles.filter((entry) => facts.botRoleIds.includes(entry.id));
  const botPermissions = botRoles.reduce(
    (sum, entry) => sum | entry.permissions,
    everyone.permissions,
  );
  if (
    !has(botPermissions, P.ManageRoles) ||
    !botRoles.some((entry) => entry.position > role.position)
  )
    throw new RulesError("role_unavailable");
  if (
    new Set(facts.roles.map((entry) => entry.id)).size !== facts.roles.length ||
    new Set(facts.channels.map((entry) => entry.id)).size !== facts.channels.length ||
    facts.roles.some(
      (entry) => entry.guildId !== guildId || !Number.isSafeInteger(entry.position),
    ) ||
    facts.channels.some((entry) => entry.guildId !== guildId)
  )
    throw new RulesError("incomplete_acl");
  // Zero global bits are insufficient: a base-role channel overwrite must not grant management.
  for (const channel of facts.channels)
    for (const overwrite of channel.overwrites)
      if (
        overwrite.type === "role" &&
        overwrite.id === role.id &&
        (overwrite.allow & ~ordinary) !== 0n
      )
        throw new RulesError("role_unavailable");
  const channel = facts.channels.find((entry) => entry.id === draft.channelId);
  if (!channel || channel.type !== "text") throw new RulesError("channel_unavailable");
  for (const memberRole of facts.roles) {
    if (facts.staffRoleIds.includes(memberRole.id) || facts.botRoleIds.includes(memberRole.id))
      continue;
    if ((memberRole.permissions & (P.Administrator | P.ManageGuild)) !== 0n) continue;
    const permissions = effective(facts, channel, [memberRole.id]);
    if ((permissions & (write | P.Administrator)) !== 0n)
      throw new RulesError("channel_unavailable");
  }
  if (
    channel.overwrites.some(
      (entry) =>
        entry.type === "member" &&
        entry.id !== botId &&
        !facts.staffUserIds.includes(entry.id) &&
        (entry.allow & write) !== 0n,
    )
  )
    throw new RulesError("channel_unavailable");
  if (!has(effective(facts, channel, []), read) || !has(effective(facts, channel, [role.id]), read))
    throw new RulesError("channel_unavailable");
  const required = read | P.SendMessages | (draft.method === "reaction" ? P.AddReactions : 0n);
  if (!has(effective(facts, channel, facts.botRoleIds, botId), required))
    throw new RulesError("channel_unavailable");
}
