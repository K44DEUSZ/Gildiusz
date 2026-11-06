import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits as P,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
  type Interaction,
  type RepliableInteraction,
} from "discord.js";
import type { BotContext } from "./context.js";
import { FormatDrafts, SettingsError, supportedExtensions } from "../settings.js";
import { errorCode, noMentions } from "../shared/utils.js";
import { profileButton, profileModal } from "./profile-panel.js";

const drafts = new FormatDrafts();
export function canManageSettings(
  owner: string,
  member: Pick<GuildMember, "id" | "permissions">,
): boolean {
  return member.id === owner || member.permissions.has(P.ManageGuild);
}
const button = (id: string, label: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

export function publishedPanel() {
  return {
    content:
      "**🛠️ Ustawienia Gildiusza**\nProfil bota, limity pokojów, czasy sprzątania i dozwolone formaty plików.\nPanel otwiera się prywatnie. Dostęp ma właściciel i osoby z uprawnieniem Zarządzanie serwerem.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("config:open", "Otwórz ustawienia", ButtonStyle.Primary),
      ),
    ],
    allowedMentions: noMentions,
  };
}

function settingsView(context: BotContext, notice = "") {
  const { values } = context.settings.read();
  return {
    content:
      `${notice ? `${notice}\n\n` : ""}**🛠️ Ustawienia Gildiusza**\n` +
      `Aktywnych pokojów: **${context.store.rooms().length}/${values.maximum}**; na osobę: **1**.\n` +
      `Przerwa między tworzeniem: **${values.creationCooldownSeconds} s**.\n` +
      `Usunięcie pustego pokoju po: **${values.emptySeconds} s**.\n` +
      `Przekazanie prowadzenia po nieobecności właściciela: **${values.transferSeconds} s**.\n\n` +
      `Formaty: **${values.extensions.map((value) => value.toUpperCase()).join(", ")}**.\n` +
      (context.config.attachments.uploadsEnabled
        ? "Przesyłanie plików przez członków jest włączone."
        : "Przesyłanie plików przez członków jest obecnie wyłączone. Wybrana lista będzie używana po jego uruchomieniu.") +
      "\n\nZapis działa od razu i pozostaje po restarcie. Zmniejszenie limitu nie usuwa istniejących pokojów.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("config:rooms", "Pokoje", ButtonStyle.Primary),
        button("config:formats", "Formaty plików"),
        button("config:profile", "Profil bota"),
        button("config:refresh", "Odśwież"),
      ),
    ],
    embeds: [],
    attachments: [],
    allowedMentions: noMentions,
  };
}

function formatView(context: BotContext, id: string, actor: string) {
  const draft = drafts.get(id, actor, context.guild.id);
  return {
    content:
      "**Dozwolone formaty plików**\nWybierz co najmniej jeden format i kliknij **Zapisz formaty**. Sama zmiana listy nie włącza przesyłania plików.",
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`config:select:${id}`)
          .setPlaceholder("Wybierz dozwolone formaty")
          .setMinValues(1)
          .setMaxValues(supportedExtensions.length)
          .addOptions(
            supportedExtensions.map((value) => ({
              label: value.toUpperCase(),
              value,
              default: draft.extensions.includes(value),
            })),
          ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`config:save:${id}`, "Zapisz formaty", ButtonStyle.Success),
        button(`config:cancel:${id}`, "Anuluj"),
      ),
    ],
    allowedMentions: noMentions,
  };
}

function roomsModal(context: BotContext): ModalBuilder {
  const { revision, values } = context.settings.read();
  const fields = [
    ["maximum", "Maksymalnie aktywnych pokojów (1-45)"],
    ["creationCooldownSeconds", "Przerwa między tworzeniem, sekundy (1-3600)"],
    ["emptySeconds", "Usuwanie pustego pokoju, sekundy (10-3600)"],
    ["transferSeconds", "Zmiana prowadzącego, sekundy (10-3600)"],
  ] as const;
  return new ModalBuilder()
    .setCustomId(`config:rooms-save:${revision}`)
    .setTitle("Zapisz ustawienia pokojów")
    .addComponents(
      fields.map(([key, label]) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(key)
            .setLabel(label)
            .setStyle(TextInputStyle.Short)
            .setValue(String(values[key]))
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(4),
        ),
      ),
    );
}

function help(context: BotContext) {
  const { values } = context.settings.read();
  return (
    "**Co potrafi Gildiusz?**\n" +
    "• Wejdź na „Utwórz pokój”, aby dostać własny pokój głosowy.\n" +
    "• /pokoj: nazwa, zamknij, otworz, zapros i pomoc.\n" +
    "• /zglos: prywatne zgłoszenie do moderacji.\n" +
    "• /ustawienia i /panel: profil bota, pokoje i formaty plików dla administracji.\n\n" +
    `Limit aktywnych pokojów: **${values.maximum}**, jeden na osobę. Przerwa między tworzeniem: **${values.creationCooldownSeconds} s**.\n` +
    `Pusty pokój znika po **${values.emptySeconds} s**.\n` +
    `Dozwolone formaty: **${values.extensions.map((value) => value.toUpperCase()).join(", ")}**.\n` +
    (context.config.attachments.uploadsEnabled
      ? "Pliki członków są włączone."
      : "Pliki członków są obecnie wyłączone.")
  );
}

async function fail(context: BotContext, interaction: RepliableInteraction, error: unknown) {
  const content =
    error instanceof SettingsError
      ? error.message
      : "Nie udało się wykonać działania. Otwórz panel ponownie i sprawdź aktualne ustawienia.";
  if (!(error instanceof SettingsError))
    await context.alert("settings", interaction.user.id, errorCode(error));
  if (interaction.deferred)
    await interaction.editReply({ content, components: [], embeds: [], attachments: [] });
  else if (interaction.replied)
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

export async function settingsInteraction(
  context: BotContext,
  interaction: Interaction,
): Promise<boolean> {
  const command =
    interaction.isChatInputCommand() &&
    ["ustawienia", "panel", "pomoc"].includes(interaction.commandName);
  const component =
    (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) &&
    interaction.customId.startsWith("config:");
  if ((!command && !component) || !interaction.isRepliable()) return false;
  try {
    if (interaction.guildId !== context.guild.id)
      throw new SettingsError("Ten panel należy do innego serwera.");
    const member = await context.member(interaction.user.id);
    if (interaction.isChatInputCommand() && interaction.commandName === "pomoc") {
      await interaction.reply({ content: help(context), flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!canManageSettings(context.guild.ownerId, member))
      throw new SettingsError(
        "Ustawienia może zmieniać właściciel lub osoba z uprawnieniem Zarządzanie serwerem.",
      );
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.commandName === "panel") {
        const target = interaction.options.getChannel("kanal")?.id ?? interaction.channelId;
        const channel = target ? await context.guild.channels.fetch(target) : null;
        const me = await context.guild.members.fetchMe();
        if (
          channel?.type !== ChannelType.GuildText ||
          !channel.permissionsFor(member)?.has([P.ViewChannel, P.SendMessages]) ||
          !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages])
        )
          throw new SettingsError("Wybierz kanał tekstowy dostępny dla ciebie i bota.");
        const sent = await channel.send(publishedPanel());
        context.store.event("settings-panel", member.id, `published:${channel.id}`);
        await interaction.editReply({ content: `Panel został opublikowany: ${sent.url}` });
      } else await interaction.editReply(settingsView(context));
    } else if (interaction.isButton()) {
      if (interaction.customId.startsWith("config:profile")) {
        await profileButton(context, interaction);
        return true;
      }
      const [, action, id] = interaction.customId.split(":");
      if (action === "open")
        await interaction.reply({ ...settingsView(context), flags: MessageFlags.Ephemeral });
      else if (action === "rooms") await interaction.showModal(roomsModal(context));
      else if (action === "formats") {
        const current = context.settings.read();
        const token = drafts.create(
          member.id,
          context.guild.id,
          current.revision,
          current.values.extensions,
        );
        await interaction.update(formatView(context, token, member.id));
      } else if (action === "save") {
        const draft = drafts.get(id ?? "", member.id, context.guild.id);
        context.settings.update({ extensions: draft.extensions }, draft.revision, member.id);
        drafts.remove(id!);
        await interaction.update(settingsView(context, "✅ Formaty zostały zapisane."));
      } else if (action === "cancel") {
        drafts.get(id ?? "", member.id, context.guild.id);
        drafts.remove(id!);
        await interaction.update(settingsView(context));
      } else if (action === "refresh") await interaction.update(settingsView(context));
      else throw new SettingsError("Nieznane działanie panelu. Otwórz ustawienia ponownie.");
    } else if (interaction.isStringSelectMenu()) {
      const id = interaction.customId.split(":")[2] ?? "";
      drafts.select(id, member.id, context.guild.id, interaction.values);
      await interaction.update(formatView(context, id, member.id));
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("config:profile-")) {
        await profileModal(context, interaction);
        return true;
      }
      if (!interaction.customId.startsWith("config:rooms-save:"))
        throw new SettingsError("Nieznany formularz.");
      const patch = Object.fromEntries(
        ["maximum", "creationCooldownSeconds", "emptySeconds", "transferSeconds"].map((key) => {
          const value = interaction.fields.getTextInputValue(key).trim();
          if (!/^\d+$/.test(value))
            throw new SettingsError("Wpisz liczby całkowite bez jednostek i ułamków.");
          return [key, Number(value)];
        }),
      );
      context.settings.update(patch, Number(interaction.customId.split(":")[2]), member.id);
      if (interaction.isFromMessage())
        await interaction.update(settingsView(context, "✅ Ustawienia pokojów zostały zapisane."));
      else
        await interaction.reply({
          ...settingsView(context, "✅ Ustawienia pokojów zostały zapisane."),
          flags: MessageFlags.Ephemeral,
        });
    }
  } catch (error) {
    await fail(context, interaction, error);
  }
  return true;
}
