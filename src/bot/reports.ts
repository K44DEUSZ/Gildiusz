import {
  ChannelType,
  PermissionFlagsBits as P,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { BotContext } from "./context.js";
import { noMentions, requireId } from "../shared/utils.js";
import { ControlError, type CaseRecord } from "../control/contracts.js";
import { canPerform } from "../core/permissions.js";
import { freshMember, isDiscordChannelUnavailable } from "./module-permissions.js";
import type { ModuleRuntime } from "./module-runtime.js";

export function parseMessageLink(
  link: string,
  guildId: string,
): { channel: string; message: string } {
  const match =
    /^https:\/\/(?:www\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/.exec(
      link,
    );
  if (!match || match[1] !== guildId)
    throw new Error("Podaj odnośnik do wiadomości z tego serwera.");
  return { channel: requireId(match[2], "channel"), message: requireId(match[3], "message") };
}

/** The legacy destination remains unchanged; only new enabled-case submissions use this bridge. */
export async function submitCaseReport(
  runtime: ModuleRuntime,
  interaction: ChatInputCommandInteraction,
): Promise<CaseRecord> {
  const { context } = runtime,
    settings = runtime.settings.read();
  if (interaction.guildId !== context.guild.id)
    throw new ControlError(403, "guild", "Ta czynność dotyczy innego serwera.");
  if (!settings.enabled.cases || !runtime.community.effectsReady)
    throw new ControlError(409, "module_unavailable", "Obsługa spraw jest niedostępna.");
  const reason = interaction.options.getString("powod", true).trim(),
    link = interaction.options.getString("wiadomosc");
  if (reason.length < 3 || reason.length > 1000 || (link !== null && link.length > 200))
    throw new ControlError(400, "report_input", "Podaj opis problemu od 3 do 1000 znaków.");
  const current = await freshMember(context.guild, interaction.user.id);
  if (!canPerform("cases.create", current.facts, runtime.settings.policy()))
    throw new ControlError(403, "permission_revoked", "Nie możesz teraz utworzyć sprawy.");
  const categoryId = settings.cases?.categoryId;
  if (!categoryId)
    throw new ControlError(409, "cases_configuration_required", "Wybierz kategorię spraw.");
  let category;
  try {
    category = await current.guild.channels.fetch(categoryId, { force: true });
  } catch (error) {
    if (!isDiscordChannelUnavailable(error)) throw error;
    throw new ControlError(409, "cases_category_unavailable", "Kategoria spraw jest niedostępna.");
  }
  const me = await current.guild.members.fetchMe({ force: true });
  if (
    !category ||
    category.guildId !== current.guild.id ||
    category.type !== ChannelType.GuildCategory ||
    !me.permissions.has([P.ManageChannels, P.ManageRoles]) ||
    !category.permissionsFor(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles]) ||
    settings.caseModeratorRoleIds.some((roleId) => !current.roles.has(roleId))
  )
    throw new ControlError(409, "cases_category_unavailable", "Sprawdź kategorię i role obsługi.");
  if (link !== null) {
    let target;
    try {
      target = parseMessageLink(link, current.guild.id);
    } catch {
      throw new ControlError(400, "report_link", "Podaj odnośnik do wiadomości z tego serwera.");
    }
    const channel = await current.guild.channels.fetch(target.channel, { force: true });
    if (
      !channel?.isTextBased() ||
      channel.guildId !== current.guild.id ||
      !channel.permissionsFor(current.member)?.has([P.ViewChannel, P.ReadMessageHistory]) ||
      (channel.isThread() &&
        channel.type === ChannelType.PrivateThread &&
        !(await channel.members.fetch({ member: current.member.id, force: true })))
    )
      throw new ControlError(403, "report_message_unavailable", "Nie masz dostępu do wiadomości.");
    await channel.messages.fetch({ message: target.message, force: true });
  }
  if (runtime.settings.read().revision !== settings.revision)
    throw new ControlError(409, "conflict", "Ustawienia spraw zmieniły się. Spróbuj ponownie.");
  const requestId = "discord_" + interaction.id,
    existing = runtime.jobs.db
      .prepare("SELECT 1 FROM idempotency_keys WHERE scope=? AND request_id=?")
      .get(`case:${current.guild.id}:${current.member.id}:create`, requestId);
  // A replay still goes through domain authorization and input-hash validation.
  if (
    !existing &&
    !context.store.cooldown(
      `report:${current.member.id}`,
      context.config.moderation.reportCooldownSeconds * 1000,
    )
  )
    throw new ControlError(429, "report_cooldown", "Odczekaj przed kolejnym zgłoszeniem.");
  const result = (await runtime.request(
    current.facts,
    "cases.create",
    { kind: "report", title: "Zgłoszenie", content: reason + (link ? `\n\n${link}` : "") },
    undefined,
    requestId,
  )) as { case: CaseRecord };
  return result.case;
}

export async function submitReport(
  context: BotContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const member = await context.member(interaction.user.id);
  if (
    !context.store.cooldown(
      `report:${member.id}`,
      context.config.moderation.reportCooldownSeconds * 1000,
    )
  )
    throw new Error("cooldown");
  const link = interaction.options.getString("wiadomosc");
  if (link) {
    const target = parseMessageLink(link, context.guild.id);
    const channel = await context.guild.channels.fetch(target.channel);
    if (
      !channel?.isTextBased() ||
      !channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory])
    )
      throw new Error("Nie masz dostępu do wskazanej wiadomości.");
    if (
      channel.isThread() &&
      channel.type === 12 &&
      !(await channel.members.fetch(member.id).catch(() => null))
    )
      throw new Error("Nie masz dostępu do wskazanego wątku.");
    await channel.messages.fetch(target.message);
  }
  const moderation = await context.textChannel("moderation");
  const sent = await moderation.send({
    content: `Zgłoszenie od <@${member.id}> (${member.id})\n${interaction.options.getString("powod", true)}${link ? `\n${link}` : ""}`,
    allowedMentions: noMentions,
    flags: 4,
  });
  context.store.event("report", member.id, "submitted", moderation.id, sent.id);
  await interaction.editReply(context.texts.reportSent);
}
