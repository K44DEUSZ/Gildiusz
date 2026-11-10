import {
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits as P,
} from "discord.js";
import { announcementCommands } from "./announcement-commands.js";
import { communityCommands } from "./community-commands.js";

export function commands(beta = process.env.GILDIUSZ_BETA_MODULES === "1") {
  const room = new SlashCommandBuilder()
    .setName("pokoj")
    .setDescription("Zarządzaj swoim pokojem projektowym.")
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addSubcommand((command) =>
      command
        .setName("nazwa")
        .setDescription("Zmień nazwę pokoju.")
        .addStringOption((option) =>
          option
            .setName("nazwa")
            .setDescription("Nazwa projektu lub pokoju.")
            .setMinLength(1)
            .setMaxLength(80)
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName("zamknij")
        .setDescription("Zachowaj dostęp uczestników i zamknij pokój dla nowych osób."),
    )
    .addSubcommand((command) =>
      command.setName("otworz").setDescription("Otwórz pokój dla członków serwera."),
    )
    .addSubcommand((command) =>
      command
        .setName("zapros")
        .setDescription("Udziel dostępu członkowi tego serwera.")
        .addUserOption((option) =>
          option
            .setName("osoba")
            .setDescription("Osoba, której chcesz udzielić dostępu.")
            .setRequired(true),
        ),
    )
    .addSubcommand((command) => command.setName("pomoc").setDescription("Pokaż instrukcję pokoi."));
  const report = new SlashCommandBuilder()
    .setName("zglos")
    .setDescription("Przekaż moderatorom opis problemu.")
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addStringOption((option) =>
      option
        .setName("powod")
        .setDescription("Krótki opis problemu, także na głosowym.")
        .setMinLength(3)
        .setMaxLength(1000)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("wiadomosc")
        .setDescription("Opcjonalny odnośnik do wiadomości z tego serwera.")
        .setMaxLength(200),
    );
  const settings = new SlashCommandBuilder()
    .setName("ustawienia")
    .setDescription("Otwórz prywatny panel ustawień bota.")
    .setDefaultMemberPermissions(P.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  const panel = new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Opublikuj przycisk otwierający ustawienia bota.")
    .setDefaultMemberPermissions(P.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addChannelOption((option) =>
      option
        .setName("kanal")
        .setDescription("Kanał tekstowy na panel. Domyślnie bieżący.")
        .addChannelTypes(ChannelType.GuildText),
    );
  const help = new SlashCommandBuilder()
    .setName("pomoc")
    .setDescription("Pokaż funkcje bota i aktualne limity.")
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  const configure = new SlashCommandBuilder()
    .setName("konfiguracja")
    .setDescription("Otwórz ustawienia serwera w panelu WWW.")
    .setDefaultMemberPermissions(P.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  return [
    ...[room, report, settings, panel, help, configure].map((command) => command.toJSON()),
    ...(beta ? [...announcementCommands(), ...communityCommands()] : []),
  ];
}
