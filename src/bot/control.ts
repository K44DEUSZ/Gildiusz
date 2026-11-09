import { ChannelType, PermissionFlagsBits as P, type Client, type Guild } from "discord.js";
import { createHash, randomBytes } from "node:crypto";
import type { BotContext } from "./context.js";
import {
  ControlError,
  parseConfiguration,
  validateBindings,
  type Configuration,
  type GuildResources,
} from "../control/contracts.js";
import { noMentions } from "../shared/utils.js";
import { roleChoices } from "../role-selection.js";

export async function authorizeControl(
  client: Client,
  guildId: string | undefined,
  input: unknown,
): Promise<{ actor: string; guild?: Guild; configuration?: unknown }> {
  if (!input || typeof input !== "object")
    throw new ControlError(400, "invalid_request", "Nieprawidłowe żądanie.");
  const body = input as Record<string, unknown>;
  if (
    typeof body.actor !== "string" ||
    !/^\d{17,20}$/.test(body.actor) ||
    typeof body.accessToken !== "string" ||
    !/^[A-Za-z0-9._-]{20,256}$/.test(body.accessToken)
  )
    throw new ControlError(401, "session", "Zaloguj się ponownie.");
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${body.accessToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new ControlError(
      response.status === 401 ? 401 : 503,
      "session",
      "Nie udało się potwierdzić sesji Discorda. Zaloguj się ponownie.",
    );
  const user = (await response.json()) as { id: string };
  if (user.id !== body.actor)
    throw new ControlError(403, "identity", "Konto Discorda nie zgadza się z sesją.");
  if (!guildId) return { actor: user.id };
  let guild: Guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch {
    throw new ControlError(404, "not_installed", "Najpierw dodaj Gildiusza do tego serwera.");
  }
  const member = await guild.members.fetch({ user: user.id, force: true });
  if (
    member.pending ||
    member.isCommunicationDisabled() ||
    (guild.ownerId !== user.id && !member.permissions.has(P.ManageGuild))
  )
    throw new ControlError(403, "permission", "Potrzebujesz uprawnienia Zarządzanie serwerem.");
  return { actor: user.id, guild, configuration: body.configuration };
}

export async function controlResources(guild: Guild): Promise<GuildResources> {
  await guild.channels.fetch();
  const roles = await guild.roles.fetch(),
    me = await guild.members.fetchMe({ force: true });
  return {
    channels: [...guild.channels.cache.values()]
      .filter((channel) =>
        [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
          ChannelType.GuildMedia,
          ChannelType.GuildVoice,
          ChannelType.GuildCategory,
        ].includes(channel.type),
      )
      .map((channel) => {
        const permissions = channel.permissionsFor(me);
        const accessible = Boolean(permissions?.has(P.ViewChannel));
        const uses: ("rooms" | "reactions" | "files" | "reports")[] = [];
        if (
          permissions?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles]) &&
          me.permissions.has(P.MoveMembers) &&
          channel.type === ChannelType.GuildCategory
        )
          uses.push("rooms");
        if (
          permissions?.has([P.ViewChannel, P.Connect, P.MoveMembers]) &&
          channel.type === ChannelType.GuildVoice
        )
          uses.push("rooms");
        if (
          permissions?.has([
            P.ViewChannel,
            P.ReadMessageHistory,
            P.SendMessages,
            P.AddReactions,
            P.ManageMessages,
          ]) &&
          me.permissions.has(P.ManageRoles) &&
          [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
        )
          uses.push("reactions");
        if (
          channel.type !== ChannelType.GuildCategory &&
          permissions?.has([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages])
        )
          uses.push("files");
        if (
          permissions?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]) &&
          !channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel) &&
          [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
        )
          uses.push("reports");
        return {
          id: channel.id,
          name: channel.name,
          kind:
            channel.type === ChannelType.GuildCategory
              ? ("category" as const)
              : channel.type === ChannelType.GuildVoice
                ? ("voice" as const)
                : ("text" as const),
          accessible,
          uses,
        };
      }),
    roles: [...roles.values()]
      .filter((role) => role.id !== guild.id)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.hexColor,
        assignable:
          !role.managed &&
          role.permissions.bitfield === 0n &&
          me.permissions.has(P.ManageRoles) &&
          me.roles.highest.comparePositionTo(role) > 0,
      })),
  };
}
export async function validateControl(context: BotContext, input: unknown): Promise<Configuration> {
  const value = parseConfiguration(input),
    current = context.control;
  if (value.revision !== current.revision)
    throw new ControlError(
      409,
      "conflict",
      "Ustawienia zostały zmienione. Odśwież panel przed zapisem.",
    );
  const errors = validateBindings(value, await controlResources(context.guild));
  if (errors.length) throw new ControlError(400, "bindings", errors.join(" "));
  if (
    context.store.rooms().length &&
    (value.rooms.categoryId !== current.rooms.categoryId ||
      value.rooms.entryChannelId !== current.rooms.entryChannelId)
  )
    throw new ControlError(
      409,
      "active_rooms",
      "Poczekaj, aż istniejące pokoje opustoszeją, zanim zmienisz ich kategorię lub wejście.",
    );
  if (
    value.modules.files &&
    value.files.includeRooms &&
    !value.modules.rooms &&
    !context.store.rooms().length &&
    !value.files.channelIds.length
  )
    throw new ControlError(400, "file_scope", "Wybierz kanały filtra albo włącz pokoje.");
  return value;
}
export function selectionChoices(context: BotContext) {
  return context.control.reactions.choices.map((choice) => ({
    ...choice,
    key:
      roleChoices.find((entry) => context.store.resource(`role.${entry.key}`)?.id === choice.roleId)
        ?.key ?? `custom${choice.roleId}`,
  }));
}
export function rolePanel(context: BotContext) {
  const resource =
    context.store.resource("control.role-panel") ?? context.store.resource("message.roles.0");
  if (!resource) return undefined;
  const saved = JSON.parse(resource.baseline) as { channelId?: string };
  return {
    id: resource.id,
    channelId: saved.channelId ?? context.store.resource("channel.start")?.id ?? "",
  };
}
export async function prepareRolePanel(
  context: BotContext,
  value: Configuration,
): Promise<{ id: string; channelId: string } | undefined> {
  if (!value.modules.reactions) return undefined;
  const previous = context.control,
    panel = rolePanel(context);
  if (
    panel &&
    previous.modules.reactions &&
    value.reactions.channelId === panel.channelId &&
    JSON.stringify(value.reactions.choices) === JSON.stringify(previous.reactions.choices)
  )
    return panel;
  if (
    context.store
      .operations()
      .some((entry) => (entry as { key: string }).key === "control:role-panel")
  )
    throw new ControlError(
      409,
      "panel_pending",
      "Poprzednia publikacja panelu wymaga sprawdzenia przez operatora. Nie utworzono kolejnej wiadomości.",
    );
  const channel = await context.guild.channels.fetch(value.reactions.channelId);
  if (!channel || !channel.isTextBased() || !("send" in channel))
    throw Error("Missing role channel");
  const fingerprint = createHash("sha256").update(JSON.stringify(value.reactions)).digest("hex");
  const staged = context.store.resource("control.staged-role-panel");
  let message;
  if (staged) {
    const baseline = JSON.parse(staged.baseline) as { channelId: string; fingerprint: string };
    if (baseline.channelId !== channel.id || baseline.fingerprint !== fingerprint)
      throw new ControlError(
        409,
        "staged_panel",
        "Dokończ zapis poprzedniego wyboru ról przed kolejną zmianą panelu.",
      );
    message = await channel.messages.fetch(staged.id);
    if (message.author.id !== context.environment.clientId)
      throw Error("Staged panel author differs");
  } else {
    const nonce = BigInt("0x" + randomBytes(8).toString("hex")).toString();
    context.store.beginOperation("control:role-panel", {
      channelId: channel.id,
      nonce,
      fingerprint,
    });
    // An ambiguous send remains in the journal: retries must not create duplicate messages.
    message = await channel.send({
      content: "**Wybór ról**\nPanel jest przygotowywany. Zaczekaj na zakończenie konfiguracji.",
      nonce,
      enforceNonce: true,
      allowedMentions: noMentions,
    });
    context.store.putResource("control.staged-role-panel", "control", message.id, {
      channelId: channel.id,
      fingerprint,
    });
    context.store.endOperation("control:role-panel");
  }
  for (const choice of value.reactions.choices) await message.react(choice.emoji);
  return { id: message.id, channelId: channel.id };
}
export async function finishRolePanel(
  context: BotContext,
  panel: { id: string; channelId: string } | undefined,
): Promise<void> {
  if (!panel) return;
  const channel = await context.guild.channels.fetch(panel.channelId);
  if (!channel?.isTextBased()) throw Error("Missing role channel");
  const message = await channel.messages.fetch(panel.id);
  if (message.author.id !== context.environment.clientId) throw Error("Role panel author differs");
  const roles = await context.guild.roles.fetch();
  await message.edit({
    content:
      "**Wybierz swoje role**\nDodaj reakcję, aby otrzymać rolę. Cofnięcie reakcji ją odbiera. Możesz wybrać kilka.\n\n" +
      context.control.reactions.choices
        .map((choice) => `${choice.emoji} · ${roles.get(choice.roleId)?.name ?? "Rola"}`)
        .join("\n"),
    allowedMentions: noMentions,
  });
}
