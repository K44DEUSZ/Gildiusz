import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type Interaction,
} from "discord.js";
import { ControlError } from "../control/contracts.js";
import type { PublicDelivery, PublicJob } from "../contracts/jobs.js";
import type { Announcement } from "../modules/announcements/types.js";
import { resolveLocalDateTime } from "../modules/announcements/schedule.js";
import { noMentions } from "../shared/utils.js";
import { freshMember } from "./module-permissions.js";
import type { ModuleRuntime } from "./module-runtime.js";

export function announcementCommands() {
  const command = new SlashCommandBuilder()
    .setName("ogloszenie")
    .setDescription("Zaplanuj ogłoszenie lub sprawdź jego wysyłkę.")
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addSubcommand((item) =>
      item
        .setName("utworz")
        .setDescription("Wyślij teraz lub zaplanuj jednorazowe ogłoszenie.")
        .addChannelOption((option) =>
          option
            .setName("kanal")
            .setDescription("Miejsce publikacji.")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("tresc")
            .setDescription("Treść wiadomości.")
            .setMinLength(1)
            .setMaxLength(1900),
        )
        .addStringOption((option) =>
          option
            .setName("termin")
            .setDescription("RRRR-MM-DD GG:MM w strefie serwera. Puste: wyślij teraz.")
            .setMinLength(16)
            .setMaxLength(16),
        )
        .addRoleOption((option) =>
          option
            .setName("rola")
            .setDescription("Opcjonalne oznaczenie roli, jeśli masz do niego uprawnienia."),
        )
        .addStringOption((option) =>
          option
            .setName("tytul")
            .setDescription("Tytuł karty wiadomości.")
            .setMinLength(1)
            .setMaxLength(256),
        )
        .addStringOption((option) =>
          option
            .setName("opis")
            .setDescription("Opis w karcie wiadomości.")
            .setMinLength(1)
            .setMaxLength(4096),
        )
        .addStringOption((option) =>
          option
            .setName("kolor")
            .setDescription("Kolor paska karty, np. #5865F2.")
            .setMinLength(6)
            .setMaxLength(7),
        )
        .addStringOption((option) =>
          option
            .setName("link")
            .setDescription("Adres HTTPS przycisku pod wiadomością.")
            .setMaxLength(512),
        )
        .addStringOption((option) =>
          option.setName("przycisk").setDescription("Podpis przycisku z linkiem.").setMaxLength(80),
        )
        .addBooleanOption((option) =>
          option.setName("szkic").setDescription("Zapisz bez planowania wysyłki."),
        ),
    )
    .addSubcommand((item) =>
      item.setName("lista").setDescription("Pokaż ostatnie ogłoszenia i ich identyfikatory."),
    )
    .addSubcommand((item) =>
      item
        .setName("stan")
        .setDescription("Sprawdź ogłoszenie i historię jego wysyłki.")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("Identyfikator z listy ogłoszeń.")
            .setMinLength(36)
            .setMaxLength(36)
            .setRequired(true),
        ),
    )
    .addSubcommand((item) =>
      item.setName("pomoc").setDescription("Pokaż sposób publikacji i ustawiania harmonogramu."),
    );
  for (const [name, description] of [
    ["pauza", "Wstrzymaj kolejne publikacje."],
    ["wznow", "Wznów harmonogram jako jego redaktor."],
    ["anuluj", "Anuluj kolejne publikacje."],
    ["proba", "Wyślij oznaczoną próbę bez pingowania ról."],
  ] as const)
    command.addSubcommand((item) =>
      item
        .setName(name)
        .setDescription(description)
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("Identyfikator ogłoszenia.")
            .setMinLength(36)
            .setMaxLength(36)
            .setRequired(true),
        ),
    );
  return [command.toJSON()];
}

const statuses: Record<Announcement["status"], string> = {
  draft: "szkic",
  scheduled: "zaplanowane",
  paused: "wstrzymane",
  cancelled: "anulowane",
  completed: "zakończone",
  expired: "termin minął",
  blocked: "wymaga uwagi",
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function announcementInteraction(
  runtime: ModuleRuntime,
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "ogloszenie") return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (interaction.guildId !== runtime.context.guild.id)
      throw new ControlError(403, "guild", "Ta komenda nie jest dostępna na tym serwerze.");
    const { facts } = await freshMember(runtime.context.guild, interaction.user.id);
    const action = interaction.options.getSubcommand();
    const call = (
      operation: Parameters<ModuleRuntime["request"]>[1],
      payload: unknown = {},
      objectId?: string,
    ) => runtime.request(facts, operation, payload, objectId, "discord_" + interaction.id);
    if (action === "pomoc") {
      await call("capabilities.read");
      const origin = process.env.WEB_ORIGIN;
      await interaction.editReply({
        content:
          "Ogłoszenia może tworzyć administracja i osoby z rolami wskazanymi w ustawieniach.\n`/ogloszenie utworz` pozwala dodać treść lub kartę oraz przycisk z linkiem. Bez terminu zleca publikację od razu. Termin podaj w formacie RRRR-MM-DD GG:MM, według strefy serwera. Opcja `szkic` zapisuje ogłoszenie bez planowania wysyłki.\nIdentyfikator znajdziesz w `/ogloszenie lista`. Wynik sprawdzisz przez `/ogloszenie stan`. `/ogloszenie proba` zleca próbę bez oznaczania odbiorców." +
          (origin
            ? "\n" + new URL(`/panel/${facts.guildId}/ogloszenia`, origin).href
            : "\nPubliczny adres panelu nie jest jeszcze ustawiony."),
        allowedMentions: noMentions,
      });
      return true;
    }
    if (action === "lista") {
      const result = (await call("announcements.list")) as { announcements: Announcement[] };
      const content = result.announcements
        .slice(0, 10)
        .map(
          (item) =>
            `\`${item.id}\` · ${statuses[item.status]}${item.channelId ? ` · <#${item.channelId}>` : ""}`,
        )
        .join("\n");
      await interaction.editReply({
        content: content || "Nie ma tu jeszcze ogłoszeń.",
        allowedMentions: noMentions,
      });
      return true;
    }
    if (action === "utworz") {
      const term = interaction.options.getString("termin");
      if (term && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(term))
        throw new ControlError(400, "term", "Podaj termin w formacie RRRR-MM-DD GG:MM.");
      const at = term
        ? resolveLocalDateTime(term.slice(0, 10), term.slice(11), runtime.settings.read().timeZone)
            .at
        : undefined;
      const role = interaction.options.getRole("rola");
      const title = interaction.options.getString("tytul") ?? "",
        description = interaction.options.getString("opis") ?? "",
        color = interaction.options.getString("kolor"),
        url = interaction.options.getString("link"),
        label = interaction.options.getString("przycisk");
      if (color && (!/^#?[a-f0-9]{6}$/i.test(color) || !(title || description)))
        throw new ControlError(
          400,
          "color",
          "Podaj tytuł lub opis karty i kolor w formacie #5865F2.",
        );
      if (Boolean(url) !== Boolean(label))
        throw new ControlError(400, "link", "Podaj adres HTTPS i podpis przycisku.");
      const saveAsDraft = interaction.options.getBoolean("szkic") ?? false;
      const content = interaction.options.getString("tresc") ?? "";
      if (!saveAsDraft && !content.trim() && !title.trim() && !description.trim())
        throw new ControlError(400, "content", "Wpisz treść wiadomości albo tytuł lub opis karty.");
      const result = (await call("announcements.create", {
        channelId: interaction.options.getChannel("kanal", true).id,
        content,
        ...(title || description
          ? {
              card: {
                title,
                description,
                color: color ? Number.parseInt(color.replace(/^#/, ""), 16) : 0x5865f2,
              },
            }
          : {}),
        ...(url && label ? { links: [{ label, url }] } : {}),
        saveAsDraft,
        roleIds: role ? [role.id] : [],
        mentionEveryone: false,
        schedule: at === undefined ? { kind: "now" } : { kind: "once", at },
      })) as { announcement: Announcement };
      await interaction.editReply({
        content: saveAsDraft
          ? `Szkic zapisany: \`${result.announcement.id}\`. Nie zaplanowano wysyłki.`
          : `Ogłoszenie zapisane: \`${result.announcement.id}\`.\nWynik wysyłki sprawdzisz komendą \`/ogloszenie stan\`.`,
        allowedMentions: noMentions,
      });
      return true;
    }
    const id = interaction.options.getString("id", true);
    if (!uuid.test(id))
      throw new ControlError(400, "id", "Wklej pełny identyfikator z listy ogłoszeń.");
    const detail = (await call("announcements.read", {}, id)) as {
      announcement: Announcement;
      jobs: PublicJob[];
      deliveries: PublicDelivery[];
    };
    if (action === "stan") {
      const record = detail.announcement;
      const unconfirmed = detail.jobs.some(
        (job) => job.state === "unknown" && !job.manualResolution,
      );
      const resolutions = detail.jobs.flatMap((job) => job.manualResolution ?? []);
      const decisions = resolutions.flatMap((resolution) => resolution.decisions);
      const linked = decisions.filter((decision) => decision.linkedMessage);
      const lastDelivery = detail.deliveries.find(
        (delivery) => delivery.messageId === record.lastMessageId,
      );
      const lastLinked = linked.find(
        (decision) => decision.linkedMessage?.messageId === record.lastMessageId,
      )?.linkedMessage;
      const links = [
        ...new Set([
          ...linked.map(
            (decision) =>
              `https://discord.com/channels/${record.guildId}/${decision.linkedMessage!.channelId}/${decision.linkedMessage!.messageId}`,
          ),
          ...(record.lastMessageId && (lastDelivery?.channelId || lastLinked?.channelId)
            ? [
                `https://discord.com/channels/${record.guildId}/${lastDelivery?.channelId || lastLinked?.channelId}/${record.lastMessageId}`,
              ]
            : []),
        ]),
      ];
      await interaction.editReply({
        content:
          `Ogłoszenie \`${record.id}\`: ${statuses[record.status]}.\nPotwierdzone publikacje: ${record.publishedCount}.` +
          (record.nextDueAt
            ? `\nNajbliższy termin: <t:${Math.floor(record.nextDueAt / 1000)}:F>.`
            : "") +
          (unconfirmed
            ? "\nNie udało się potwierdzić ostatniej wysyłki. Sprawdź kanał przed ponowieniem."
            : "") +
          (resolutions.length
            ? `\nPróby z ręcznie wskazaną wiadomością: ${linked.length}. Zamknięte bez potwierdzenia: ${decisions.length - linked.length}. Stan techniczny wysyłki pozostaje niepewny.`
            : "") +
          (resolutions.some((resolution) => resolution.conflictingMessageIds.length)
            ? "\nHistoria zawiera różne identyfikatory wiadomości. Sprawdź szczegóły w panelu."
            : "") +
          (links.length ? "\n" + links.slice(0, 5).join("\n") : ""),
        allowedMentions: noMentions,
      });
      return true;
    }
    const operations = {
      pauza: "announcements.pause",
      wznow: "announcements.resume",
      anuluj: "announcements.cancel",
      proba: "announcements.test",
    } as const;
    if (!Object.hasOwn(operations, action))
      throw new ControlError(400, "action", "Nie znaleziono tej czynności.");
    await call(
      operations[action as keyof typeof operations],
      { revision: detail.announcement.revision },
      id,
    );
    const messages: Record<string, string> = {
      pauza: "Kolejne publikacje zostały wstrzymane.",
      wznow: "Harmonogram został wznowiony.",
      anuluj:
        "Kolejne publikacje zostały anulowane. Wiadomość już przyjęta przez Discorda może pozostać na kanale.",
      proba: "Próba zapisana do wysyłki. Role nie będą pingowane. Sprawdź wynik w historii.",
    };
    await interaction.editReply({ content: messages[action], allowedMentions: noMentions });
  } catch (error) {
    await interaction.editReply({
      content:
        error instanceof ControlError
          ? error.message
          : "Nie udało się wykonać tej czynności. Sprawdź uprawnienia i spróbuj ponownie.",
      allowedMentions: noMentions,
    });
  }
  return true;
}
