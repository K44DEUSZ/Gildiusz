import type { Config } from "../config.js";
import type { Snapshot } from "../bootstrap/api.js";
import type { Store } from "../storage/store.js";
import {
  effectivePermissions,
  P,
  permissionNames,
  moderatorPermissions,
  type Overwrite,
} from "./model.js";

export function auditPermissions(state: Snapshot, store: Store, config: Config) {
  const failures: string[] = [];
  const rows: {
    channel: string;
    persona: string;
    permissions: string[];
    overwrites: { id: string; type: number; Allow: string[]; Deny: string[]; Inherit: string[] }[];
  }[] = [];
  const everyone = state.roles.find((role) => role.id === state.guild.id);
  if (!everyone) throw new Error("Missing @everyone role.");
  const interests = config.roles.map((role) => store.id(`role.${role.key}`));
  for (const role of state.roles.filter((role) => interests.includes(role.id)))
    if (role.permissions !== "0" || role.hoist || role.mentionable)
      failures.push(`Interest role grants privileges: ${role.id}`);
  const personas = [[], [interests[0]], interests];
  const adminMask =
    P.Administrator |
    P.ManageGuild |
    P.ManageRoles |
    P.ManageChannels |
    P.ManageWebhooks |
    P.ManageMessages |
    P.ManageThreads |
    P.KickMembers |
    P.BanMembers |
    P.ModerateMembers |
    P.MentionEveryone |
    P.CreateInstantInvite |
    P.CreatePrivateThreads |
    P.UseExternalApps;
  const allNames = Object.keys(P);
  for (const channel of config.channels) {
    const resource = store.resource(`channel.${channel.key}`);
    const actual = state.channels.find((entry) => entry.id === resource?.id);
    if (!actual) {
      failures.push(`Missing channel: ${channel.key}`);
      continue;
    }
    const entries = actual.permission_overwrites as Overwrite[];
    for (const roles of personas) {
      const base = roles.reduce(
        (mask, id) =>
          mask | BigInt(String(state.roles.find((role) => role.id === id)?.permissions ?? "0")),
        BigInt(String(everyone.permissions)),
      );
      const effective = effectivePermissions(
        base,
        "ordinary-member",
        roles,
        state.guild.id,
        entries,
      );
      if (effective & adminMask) failures.push(`${channel.key}: unexpected member privilege`);
      if (channel.kind === "admin" && effective & P.ViewChannel)
        failures.push(`${channel.key}: administration is visible`);
      if (channel.kind !== "admin" && !(effective & P.ViewChannel))
        failures.push(`${channel.key}: public channel is hidden`);
      if (
        channel.kind === "readonly" &&
        effective &
          (P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.AttachFiles)
      )
        failures.push(`${channel.key}: read-only channel permits participation`);
      if (
        (["text", "forum"].includes(channel.kind) && !(effective & P.SendMessages)) ||
        (channel.kind === "forum" && !(effective & P.SendMessagesInThreads))
      )
        failures.push(`${channel.key}: publishing is blocked`);
      if (
        channel.kind === "voice" &&
        channel.key !== "join" &&
        (effective & (P.Connect | P.Speak | P.Stream)) !== (P.Connect | P.Speak | P.Stream)
      )
        failures.push(`${channel.key}: voice permissions are incomplete`);
      if (
        channel.key === "join" &&
        (!(effective & P.Connect) ||
          effective & (P.Speak | P.Stream | P.SendMessages | P.SendMessagesInThreads))
      )
        failures.push(`${channel.key}: technical entrance permits conversation or blocks entry`);
      rows.push({
        channel: channel.key,
        persona: roles.length
          ? roles.length === 1
            ? "one-interest"
            : "all-interests"
          : "no-interest",
        permissions: permissionNames(effective),
        overwrites: entries.map((entry) => {
          const Allow = permissionNames(entry.allow),
            Deny = permissionNames(entry.deny);
          return {
            id: entry.id,
            type: entry.type,
            Allow,
            Deny,
            Inherit: allNames.filter((name) => !Allow.includes(name) && !Deny.includes(name)),
          };
        }),
      });
    }
    if (
      actual.rate_limit_per_user !== 0 ||
      (channel.kind === "forum" && actual.default_thread_rate_limit_per_user !== 0)
    )
      failures.push(`${channel.key}: slowmode enabled`);
  }
  const moderator = state.roles.find((role) => role.id === store.id("role.moderator"));
  if (
    !moderator ||
    BigInt(String(moderator.permissions)) &
      (P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageWebhooks)
  )
    failures.push("Moderator has excessive permissions or is missing.");
  const botRole = state.roles.find(
    (role) => (role.tags as { bot_id?: string } | undefined)?.bot_id === state.botId,
  );
  if (botRole && BigInt(String(botRole.permissions)) & P.Administrator)
    failures.push("Bot has Administrator.");
  if (
    moderator &&
    (BigInt(String(moderator.permissions)) & BigInt(moderatorPermissions)) !==
      BigInt(moderatorPermissions)
  )
    failures.push("Moderator is missing a required moderation flag.");
  for (const actual of state.channels) {
    const mapped = store
      .resources()
      .find((resource) => resource.kind === "channel" && resource.id === actual.id);
    const room = store.room(actual.id);
    const configured = config.channels.some((channel) => `channel.${channel.key}` === mapped?.key);
    const entries = (actual.permission_overwrites ?? []) as Overwrite[];
    const identities = [
      ...(!configured
        ? personas.map((roles) => ({
            id: "ordinary-member",
            label: roles.length
              ? roles.length === 1
                ? "one-interest"
                : "all-interests"
              : "no-interest",
            roles,
          }))
        : []),
      { id: "moderator-member", label: "moderator", roles: moderator ? [moderator.id] : [] },
      { id: state.botId, label: "bot", roles: state.botRoleIds ?? (botRole ? [botRole.id] : []) },
      ...(room?.locked ? room.allowed : []).map((id) => ({
        id,
        label: "room-participant",
        roles: [],
      })),
    ];
    for (const identity of identities) {
      const base = state.roles
        .filter((role) => role.id === everyone.id || identity.roles.includes(role.id))
        .reduce((mask, role) => mask | BigInt(String(role.permissions)), 0n);
      const effective = effectivePermissions(
        base,
        identity.id,
        identity.roles,
        state.guild.id,
        entries,
      );
      if (
        (mapped?.key === "category.admin" || room?.locked) &&
        identity.id === "ordinary-member" &&
        effective & P.ViewChannel
      )
        failures.push(
          `${mapped?.key ?? actual.id}: private channel is visible to an ordinary member`,
        );
      if (
        (room?.locked || mapped?.key === "category.admin") &&
        identity.label === "moderator" &&
        !(effective & P.ViewChannel)
      )
        failures.push(`${actual.id}: moderator cannot access a private channel`);
      rows.push({
        channel: mapped?.key ?? `room-or-unmanaged.${actual.id}`,
        persona: identity.label,
        permissions: permissionNames(effective),
        overwrites: entries.map((entry) => {
          const Allow = permissionNames(entry.allow),
            Deny = permissionNames(entry.deny);
          return {
            id: entry.id,
            type: entry.type,
            Allow,
            Deny,
            Inherit: allNames.filter((name) => !Allow.includes(name) && !Deny.includes(name)),
          };
        }),
      });
    }
  }
  const warnings = state.roles
    .filter(
      (role) =>
        !interests.includes(role.id) &&
        role.id !== everyone.id &&
        role.id !== moderator?.id &&
        role.id !== botRole?.id,
    )
    .map(
      (role) =>
        `Unmanaged role ${role.id}: review member assignments and effective permissions separately.`,
    );
  if (botRole && BigInt(String(botRole.permissions)) & (P.ManageGuild | P.ManageRoles))
    warnings.push(
      "The bot still has global configuration permissions. Reduce them after deployment acceptance.",
    );
  if (moderator && botRole && Number(moderator.position) <= Number(botRole.position))
    warnings.push("Owner must place Moderator above the bot role manually.");
  return {
    failures: [...new Set(failures)],
    warnings,
    rows,
    runtimeBotRolePermissions: botRole ? permissionNames(String(botRole.permissions)) : null,
  };
}
