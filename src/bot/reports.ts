import { PermissionFlagsBits as P, type ChatInputCommandInteraction } from "discord.js";
import type { BotContext } from "./context.js";
import { noMentions, requireId } from "../shared/utils.js";

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
