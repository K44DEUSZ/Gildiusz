import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits as P,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { BotContext } from "./context.js";
import { downloadAvatar, profileName, profileRevision, type ProfilePatch } from "../profile.js";
import { sniff } from "./attachment-policy.js";
import { Pool, noMentions } from "../shared/utils.js";
import { SettingsError } from "../settings.js";

const downloads = new Pool(2, 4);
const button = (id: string, label: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(`config:profile-${id}`).setLabel(label).setStyle(style);

export async function profileView(context: BotContext, notice = "") {
  const profile = await context.profile.read();
  return {
    content: `${notice ? `${notice}\n\n` : ""}**Profil bota na tym serwerze**\nZmień nazwę lub awatar, a następnie zatwierdź podgląd. Własny profil zachowuje się po restarcie.`,
    embeds: [
      new EmbedBuilder()
        .setTitle(profile.nick ?? profile.defaultName)
        .setThumbnail(profile.avatarURL)
        .setDescription(
          `Nazwa: ${profile.nick === null ? "domyślna" : "własna"}\nAwatar: ${profile.avatar === null ? "domyślny" : "własny"}`,
        ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("name", "Zmień nazwę", ButtonStyle.Primary),
        button("avatar", "Zmień awatar"),
        button("reset", "Przywróć domyślne"),
        new ButtonBuilder()
          .setCustomId("config:refresh")
          .setLabel("Wróć")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    attachments: [],
    allowedMentions: noMentions,
  };
}

export function profilePreview(context: BotContext, id: string, actor: string) {
  const { profile, patch } = context.profile.get(id, actor, context.guild.id);
  const name =
    patch.nick === undefined
      ? (profile.nick ?? profile.defaultName)
      : (patch.nick ?? profile.defaultName);
  const file = patch.avatar;
  const filename = `awatar.${file ? sniff(file) : "png"}`;
  const avatar = file
    ? `attachment://${filename}`
    : patch.avatar === null
      ? profile.defaultAvatarURL
      : profile.avatarURL;
  return {
    content: `**Podgląd profilu**\nNazwa: **${escapeMarkdown(name)}**. Zmiana dotyczy tego serwera.\nPodgląd wygasa po 5 minutach. Profil można zapisywać raz na minutę.`,
    embeds: [
      new EmbedBuilder()
        .setTitle(name)
        .setThumbnail(avatar)
        .setFooter({ text: "Gildiusz · podgląd przed zapisem" }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`save:${id}`, "Zapisz profil", ButtonStyle.Success),
        button(`cancel:${id}`, "Anuluj"),
      ),
    ],
    files: file ? [{ attachment: file, name: filename }] : [],
    attachments: [],
    allowedMentions: noMentions,
  };
}

export async function profileButton(
  context: BotContext,
  interaction: ButtonInteraction,
): Promise<void> {
  const [, action, id] = interaction.customId.split(":");
  if (action === "profile-name" || action === "profile-avatar") {
    const profile = await context.profile.read();
    const revision = profileRevision(profile);
    const name = action === "profile-name";
    const label = name
      ? new LabelBuilder().setLabel("Nazwa na serwerze (puste = domyślna)").setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("name")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(32)
            .setValue(profile.nick ?? ""),
        )
      : new LabelBuilder()
          .setLabel("Awatar: PNG, JPG lub GIF, do 2 MB")
          .setFileUploadComponent(
            new FileUploadBuilder()
              .setCustomId("avatar")
              .setFileTypes(".png", ".jpg", ".jpeg", ".gif")
              .setMinValues(1)
              .setMaxValues(1)
              .setRequired(true),
          );
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`config:profile-${name ? "name" : "avatar"}-submit:${revision}`)
        .setTitle(name ? "Nazwa Gildiusza na serwerze" : "Awatar Gildiusza na serwerze")
        .addLabelComponents(label),
    );
    return;
  }
  await interaction.deferUpdate();
  if (action === "profile-reset") {
    const profile = await context.profile.read();
    const token = await context.profile.prepare(interaction.user.id, profileRevision(profile), {
      nick: null,
      avatar: null,
    });
    await interaction.editReply(profilePreview(context, token, interaction.user.id));
  } else if (action === "profile-save") {
    await context.profile.save(id ?? "", interaction.user.id, context.guild.id);
    await interaction.editReply(
      await profileView(context, "✅ Profil został zapisany na tym serwerze."),
    );
  } else if (action === "profile-cancel") {
    context.profile.cancel(id ?? "", interaction.user.id, context.guild.id);
    await interaction.editReply(await profileView(context));
  } else if (action === "profile") await interaction.editReply(await profileView(context));
  else throw new SettingsError("Nieznane działanie profilu.");
}

export async function profileModal(
  context: BotContext,
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.isFromMessage())
    throw new SettingsError("Otwórz Profil bota z panelu ustawień.");
  await interaction.deferUpdate();
  const [, action, expected] = interaction.customId.split(":");
  let patch;
  if (action === "profile-name-submit")
    patch = { nick: profileName(interaction.fields.getTextInputValue("name")) };
  else if (action === "profile-avatar-submit") {
    const files = interaction.fields.getUploadedFiles("avatar", true);
    if (files.size !== 1) throw new SettingsError("Wgraj jeden obraz awatara.");
    const file = files.first()!;
    patch = { avatar: await downloads.run(() => downloadAvatar(file)) };
  } else throw new SettingsError("Nieznany formularz profilu.");
  const token = await context.profile.prepare(interaction.user.id, expected ?? "", patch);
  await interaction.editReply(profilePreview(context, token, interaction.user.id));
}

export async function writeProfile(
  context: BotContext,
  patch: ProfilePatch,
  actor: string,
): Promise<void> {
  const member = await context.member(actor);
  if (member.id !== context.guild.ownerId && !member.permissions.has(P.ManageGuild))
    throw new SettingsError("Brak uprawnienia Zarządzanie serwerem do zapisu profilu.");
  const me = await context.guild.members.fetchMe({ force: true });
  if (patch.nick !== undefined && !me.permissions.has(P.ChangeNickname))
    throw new SettingsError(
      "Bot potrzebuje uprawnienia Zmiana pseudonimu, aby zmienić własną nazwę.",
    );
  await context.guild.members.editMe({ ...patch, reason: `Profil Gildiusza: ${actor}` });
}
