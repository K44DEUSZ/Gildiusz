import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type Interaction,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import {
  ControlError,
  type ControlOperation,
  type MeetingDraft,
  type MeetingDetail,
  type Meeting,
  type CaseView,
  type CaseRecord,
} from "../control/contracts.js";
import { JobError } from "../core/jobs/types.js";
import { MeetingError } from "../modules/meetings/types.js";
import { CaseError } from "../modules/cases/types.js";
import { AnnouncementError } from "../modules/announcements/types.js";
import { resolveLocalDateTime } from "../modules/announcements/schedule.js";
import { noMentions } from "../shared/utils.js";
import { freshMember } from "./module-permissions.js";
import type { ModuleRuntime } from "./module-runtime.js";

function command(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
}
function reference(item: SlashCommandSubcommandBuilder) {
  return item.addStringOption((option) =>
    option
      .setName("id")
      .setDescription("Pełny identyfikator z listy lub szczegółów.")
      .setMinLength(36)
      .setMaxLength(36)
      .setRequired(true),
  );
}
function meetingOptions<T extends SlashCommandBuilder | SlashCommandSubcommandBuilder>(item: T): T {
  item
    .addStringOption((option) =>
      option
        .setName("temat")
        .setDescription("Temat spotkania.")
        .setMinLength(1)
        .setMaxLength(120)
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("kanal")
        .setDescription("Kanał ogłoszenia spotkania.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("opis").setDescription("O czym jest spotkanie.").setMaxLength(1500),
    )
    .addIntegerOption((option) =>
      option
        .setName("miejsca")
        .setDescription("Liczba miejsc, razem z organizatorem, jeśli bierze udział.")
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addIntegerOption((option) =>
      option
        .setName("czas")
        .setDescription("Planowany czas w minutach. Domyślnie 60.")
        .setMinValue(5)
        .setMaxValue(10080),
    )
    .addBooleanOption((option) =>
      option
        .setName("moj-udzial")
        .setDescription("Czy organizator zajmuje jedno miejsce. Domyślnie tak."),
    )
    .addBooleanOption((option) =>
      option
        .setName("prywatne")
        .setDescription("Prywatne spotkanie wymaga właściwych uprawnień kanału."),
    )
    .addRoleOption((option) =>
      option
        .setName("rola")
        .setDescription(
          "Dla prywatnego: zaproszona rola. Dla publicznego: rola wymagana do zapisu.",
        ),
    )
    .addUserOption((option) =>
      option
        .setName("osoba")
        .setDescription("Osoba zaproszona do prywatnego spotkania. Bez wiadomości prywatnej."),
    )
    .addChannelOption((option) =>
      option
        .setName("pokoj")
        .setDescription("Istniejący pokój głosowy.")
        .addChannelTypes(ChannelType.GuildVoice),
    )
    .addChannelOption((option) =>
      option
        .setName("kategoria")
        .setDescription("Kategoria nowego pokoju. Wybierz pokój albo kategorię.")
        .addChannelTypes(ChannelType.GuildCategory),
    );
  return item;
}
function caseOptions(item: SlashCommandSubcommandBuilder) {
  return item
    .addStringOption((option) =>
      option
        .setName("temat")
        .setDescription("Krótki temat.")
        .setMinLength(1)
        .setMaxLength(140)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("tresc")
        .setDescription("Opis sprawy lub pomysłu.")
        .setMinLength(1)
        .setMaxLength(4000)
        .setRequired(true),
    );
}
export function communityCommands() {
  const meeting = command("spotkanie", "Utwórz spotkanie albo sprawdź i zmień swój zapis.")
    .addSubcommand((item) =>
      meetingOptions(
        item.setName("utworz").setDescription("Zbierz ekipę teraz lub utwórz spotkanie na termin."),
      ).addStringOption((option) =>
        option
          .setName("termin")
          .setDescription("RRRR-MM-DD GG:MM w strefie serwera. Puste: teraz.")
          .setMinLength(16)
          .setMaxLength(16),
      ),
    )
    .addSubcommand((item) =>
      item.setName("lista").setDescription("Pokaż dostępne spotkania i ich identyfikatory."),
    );
  for (const [name, description] of [
    ["stan", "Pokaż spotkanie i swój zapis."],
    ["dolacz", "Zapisz się na spotkanie lub do rezerwy."],
    ["rezygnuj", "Wycofaj swój zapis."],
    ["rozpocznij", "Rozpocznij spotkanie jako organizator."],
    ["zakoncz", "Zakończ spotkanie jako organizator."],
    ["odwolaj", "Odwołaj spotkanie jako organizator."],
  ] as const)
    meeting.addSubcommand((item) => reference(item.setName(name).setDescription(description)));
  for (const [name, description] of [
    ["zapros", "Zaproś osobę lub rolę do prywatnego spotkania."],
    ["cofnij-zaproszenie", "Wycofaj zaproszenie osoby lub roli."],
  ] as const)
    meeting.addSubcommand((item) =>
      reference(item.setName(name).setDescription(description))
        .addUserOption((option) =>
          option.setName("osoba").setDescription("Wybierz osobę albo rolę."),
        )
        .addRoleOption((option) =>
          option.setName("rola").setDescription("Wybierz rolę albo osobę."),
        ),
    );
  const crew = meetingOptions(command("ekipa", "Zbierz ekipę na teraz."));
  const support = command("sprawa", "Utwórz sprawę albo odpowiedz w istniejącym zgłoszeniu.")
    .addSubcommand((item) =>
      caseOptions(
        item.setName("utworz").setDescription("Przekaż zgłoszenie lub pytanie obsłudze."),
      ).addStringOption((option) =>
        option
          .setName("rodzaj")
          .setDescription("Zgłoszenie albo pytanie. Domyślnie zgłoszenie.")
          .addChoices(
            { name: "Zgłoszenie", value: "report" },
            { name: "Pytanie", value: "question" },
          ),
      ),
    )
    .addSubcommand((item) => item.setName("moje").setDescription("Pokaż twoje sprawy i pomysły."))
    .addSubcommand((item) =>
      reference(item.setName("stan").setDescription("Pokaż stan i dostępne działania sprawy.")),
    )
    .addSubcommand((item) =>
      reference(
        item.setName("odpowiedz").setDescription("Dodaj odpowiedź do sprawy."),
      ).addStringOption((option) =>
        option
          .setName("tresc")
          .setDescription("Twoja odpowiedź.")
          .setMinLength(1)
          .setMaxLength(4000)
          .setRequired(true),
      ),
    )
    .addSubcommand((item) =>
      reference(item.setName("przejmij").setDescription("Przejmij sprawę do obsługi.")),
    )
    .addSubcommand((item) =>
      reference(
        item.setName("notatka").setDescription("Zapisz notatkę widoczną tylko dla obsługi."),
      ).addStringOption((option) =>
        option
          .setName("tresc")
          .setDescription("Treść notatki dla obsługi.")
          .setMinLength(1)
          .setMaxLength(4000)
          .setRequired(true),
      ),
    )
    .addSubcommand((item) =>
      reference(item.setName("status").setDescription("Zmień status sprawy lub pomysłu."))
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Nowy status.")
            .setRequired(true)
            .addChoices(
              { name: "W trakcie", value: "in_progress" },
              { name: "Oczekuje na autora", value: "waiting_author" },
              { name: "Rozwiązane", value: "resolved" },
              { name: "Zamknięte", value: "closed" },
              { name: "W ocenie", value: "in_review" },
              { name: "Przyjęte", value: "accepted" },
              { name: "Odrzucone", value: "rejected" },
              { name: "Zrealizowane", value: "implemented" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("powod")
            .setDescription("Uzasadnienie zmiany, jeśli jest wymagane.")
            .setMaxLength(1000),
        ),
    );
  const suggestion = command("pomysl", "Zaproponuj zmianę lub zagłosuj na pomysł.")
    .addSubcommand((item) =>
      caseOptions(
        item.setName("utworz").setDescription("Dodaj pomysł zgodnie z zasadami serwera."),
      ),
    )
    .addSubcommand((item) =>
      reference(item.setName("stan").setDescription("Pokaż pomysł, jego status i głosy.")),
    )
    .addSubcommand((item) =>
      reference(item.setName("glos").setDescription("Oddaj lub zmień swój głos.")).addStringOption(
        (option) =>
          option
            .setName("wybor")
            .setDescription("Twój głos.")
            .setRequired(true)
            .addChoices({ name: "Za", value: "up" }, { name: "Przeciw", value: "down" }),
      ),
    )
    .addSubcommand((item) =>
      reference(item.setName("wycofaj").setDescription("Wycofaj swój głos.")),
    )
    .addSubcommand((item) =>
      reference(
        item.setName("zatwierdz").setDescription("Zatwierdź pomysł do publicznego pokazania."),
      ),
    );
  return [meeting, crew, support, suggestion].map((item) => item.toJSON());
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const meetingActions = ["read", "join", "leave", "start", "complete", "cancel"] as const;
const caseActions = ["read", "assign", "approve", "up", "down", "unvote"] as const;
export function communityButtonId(
  kind: "meeting" | "case",
  guildId: string,
  id: string,
  action: string,
): string {
  if (
    !["meeting", "case"].includes(kind) ||
    !/^\d{17,20}$/.test(guildId) ||
    !uuid.test(id) ||
    !(kind === "meeting" ? meetingActions : caseActions).some((item) => item === action)
  )
    throw new ControlError(400, "invalid_action", "Nie można przygotować przycisku.");
  return `gildiusz:${kind}:${guildId}:${id}:${action}`;
}
const meetingStates: Record<string, string> = {
  draft: "szkic",
  open: "zapisy otwarte",
  starting: "przygotowanie",
  active: "trwa",
  completed: "zakończone",
  cancelled: "odwołane",
};
const caseStates: Record<string, string> = {
  new: "nowe",
  in_progress: "w trakcie",
  waiting_author: "oczekuje na autora",
  resolved: "rozwiązane",
  closed: "zamknięte",
  in_review: "w ocenie",
  accepted: "przyjęte",
  rejected: "odrzucone",
  implemented: "zrealizowane",
};
const labels: Record<string, string> = {
  "meetings.join": "Dołącz",
  "meetings.leave": "Rezygnuję",
  "meetings.update": "Zmień spotkanie",
  "meetings.start": "Rozpocznij spotkanie",
  "meetings.complete": "Zakończ spotkanie",
  "meetings.cancel": "Odwołaj spotkanie",
  "cases.reply": "Odpowiedz",
  "cases.assign": "Przejmij",
  "cases.transition": "Zmień status",
  "cases.note": "Dodaj notatkę",
  "cases.approve": "Zatwierdź pomysł",
  "cases.vote": "Zagłosuj",
};
const errorMessages: Record<string, string> = {
  guild: "Ta czynność dotyczy innego serwera.",
  invalid_id: "Wklej pełny identyfikator z listy lub szczegółów.",
  invalid_action: "Ten przycisk nie obsługuje już takiej czynności.",
  invalid_term: "Podaj termin w formacie RRRR-MM-DD GG:MM.",
  invalid_input: "Sprawdź treść, termin i wybrane ustawienia.",
  invalid_room: "Wybierz istniejący pokój albo kategorię nowego pokoju.",
  forbidden: "Nie masz uprawnień do tej czynności.",
  permission_revoked: "Sprawdź dostęp do serwera i uprawnienia swojej roli.",
  ineligible_member: "Nie możesz teraz korzystać z tej czynności na serwerze.",
  closed: "Ta czynność nie jest już dostępna w obecnym stanie.",
  revision_conflict: "Dane zostały zmienione. Sprawdź aktualny stan i wywołaj nową komendę.",
  conflict: "Dane zostały zmienione. Sprawdź aktualny stan przed kolejną próbą.",
  state_conflict: "Stan tego elementu zmienił się. Sprawdź aktualny stan.",
  not_found: "Nie znaleziono tego elementu na serwerze.",
  module_unavailable: "Ta funkcja jest wyłączona lub jeszcze niedostępna na tym serwerze.",
  capacity_conflict: "Liczba miejsc jest mniejsza niż liczba zapisanych uczestników.",
  visibility_conflict:
    "To spotkanie mogło już być widoczne publicznie. Utwórz nowe prywatne spotkanie.",
  expired: "Termin tej czynności minął. Sprawdź stan spotkania.",
  limit_exceeded: "Wykonano zbyt wiele takich czynności. Spróbuj później.",
  approval_required: "Ten pomysł czeka na zatwierdzenie przed głosowaniem.",
  voting_closed: "Głosowanie na ten pomysł jest zamknięte.",
  idempotency_conflict:
    "Ta próba ma już inne zapisane dane. Sprawdź wynik przed wywołaniem nowej komendy.",
};
function safeError(error: unknown): string {
  if (
    error instanceof ControlError ||
    error instanceof MeetingError ||
    error instanceof CaseError ||
    error instanceof JobError ||
    error instanceof AnnouncementError
  )
    return (
      errorMessages[error.code] ??
      "Nie można teraz wykonać tej czynności. Sprawdź aktualny stan i uprawnienia."
    );
  return "Nie udało się potwierdzić wyniku. Sprawdź aktualny stan przed kolejną próbą.";
}
function actions(value: { allowedOperations?: string[] }) {
  const available = value.allowedOperations?.map((item) => labels[item]).filter(Boolean);
  return available?.length ? "\nDostępne działania: " + available.join(", ") + "." : "";
}
function meetingStatus(
  detail: MeetingDetail & { allowedOperations?: string[]; jobs?: { state: string }[] },
  actorId: string,
): string {
  const value = detail.meeting,
    own = detail.participants.find(
      (person) => person.userId === actorId && person.state !== "left",
    );
  const waiting = detail.participants
    .filter((person) => person.state === "waitlisted")
    .sort((a, b) => a.sequence - b.sequence);
  return (
    `**${escapeMarkdown(value.title)}**\nIdentyfikator: \`${value.id}\`\nStan: ${meetingStates[value.state] ?? "nieznany"}.\nPoczątek: <t:${Math.floor(value.startsAt / 1000)}:F>.\nUczestnicy: ${value.confirmedCount}/${value.capacity}. Rezerwa: ${value.waitlistedCount}.` +
    (own?.state === "confirmed"
      ? "\nJesteś na liście uczestników."
      : own?.state === "waitlisted"
        ? `\nJesteś w rezerwie. Miejsce w kolejce: ${waiting.findIndex((person) => person.userId === actorId) + 1}.`
        : "\nNie masz aktywnego zapisu.") +
    (detail.jobs?.some((job) => job.state === "unknown")
      ? "\nWynik części wysyłek jest niepotwierdzony. Sprawdź kanał przed ponowieniem."
      : "") +
    actions(detail)
  );
}
function caseStatus(detail: CaseView & { allowedOperations?: string[] }): string {
  return (
    `**${escapeMarkdown(detail.case.title)}**\nIdentyfikator: \`${detail.case.id}\`\nStatus: ${caseStates[detail.case.status] ?? "nieznany"}.\nWidoczność: ${detail.case.visibility === "private" ? "prywatna" : "publiczna"}.` +
    (detail.case.kind === "suggestion"
      ? `\nGłosy za: ${detail.votes.positive}. Przeciw: ${detail.votes.negative}.`
      : "") +
    actions(detail)
  );
}

export async function communityInteraction(
  runtime: ModuleRuntime,
  interaction: Interaction,
): Promise<boolean> {
  const slash =
    interaction.isChatInputCommand() &&
    ["spotkanie", "ekipa", "sprawa", "pomysl"].includes(interaction.commandName);
  const button = interaction.isButton() && /^gildiusz:(meeting|case):/.test(interaction.customId);
  if (!slash && !button) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = (content: string) =>
    interaction.editReply({
      content:
        content.length <= 2000
          ? content
          : content.slice(0, 1999).replace(/[\uD800-\uDBFF]$/, "") + "…",
      allowedMentions: noMentions,
    });
  try {
    if (interaction.guildId !== runtime.context.guild.id) throw new ControlError(403, "guild", "");
    const { facts } = await freshMember(runtime.context.guild, interaction.user.id);
    const requestId = "discord_" + interaction.id;
    const call = (operation: ControlOperation, payload: unknown = {}, objectId?: string) =>
      runtime.request(facts, operation, payload, objectId, requestId);
    const mutate = (
      operation: ControlOperation,
      payload: unknown,
      objectId?: string,
      input: unknown = {},
    ) => {
      // Freeze CAS/timezone inputs without duplicating free-form text in command receipts.
      const stable = runtime.jobs.idempotent(
        `discord-community:${facts.guildId}:${facts.userId}:${operation}`,
        requestId,
        { objectId: objectId ?? null, input },
        () =>
          Object.fromEntries(
            Object.entries(payload as Record<string, unknown>).filter(
              ([key]) => !["content", "title", "description"].includes(key),
            ),
          ),
      );
      return call(operation, { ...(payload as Record<string, unknown>), ...stable }, objectId);
    };
    let kind: "meeting" | "case", action: string, objectId: string | undefined;
    if (interaction.isButton()) {
      const match = /^gildiusz:(meeting|case):(\d{17,20}):([a-fA-F0-9-]{36}):([a-z]+)$/.exec(
        interaction.customId,
      );
      if (!match || !uuid.test(match[3])) throw new ControlError(400, "invalid_action", "");
      kind = match[1] as "meeting" | "case";
      objectId = match[3];
      action = match[4];
      if (match[2] !== runtime.context.guild.id) throw new ControlError(403, "guild", "");
      if (!(kind === "meeting" ? meetingActions : caseActions).some((item) => item === action))
        throw new ControlError(400, "invalid_action", "");
    } else if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      action = name === "ekipa" ? "utworz" : interaction.options.getSubcommand();
      kind = name === "spotkanie" || name === "ekipa" ? "meeting" : "case";
      if (kind === "meeting" && action === "lista") {
        const result = (await call("meetings.list")) as { meetings: Meeting[] };
        await reply(
          result.meetings
            .slice(0, 10)
            .map(
              (value) =>
                `\`${value.id}\` · ${escapeMarkdown(value.title)} · ${value.confirmedCount}/${value.capacity} · ${meetingStates[value.state]} · <t:${Math.floor(value.startsAt / 1000)}:f>`,
            )
            .join("\n") || "Nie ma dostępnych spotkań.",
        );
        return true;
      }
      if (name === "sprawa" && action === "moje") {
        const result = (await call("cases.list", { mine: true })) as { cases: CaseRecord[] };
        await reply(
          result.cases
            .slice(0, 10)
            .map(
              (value) =>
                `\`${value.id}\` · ${escapeMarkdown(value.title)} · ${caseStates[value.status]}`,
            )
            .join("\n") || "Nie masz jeszcze zapisanych spraw.",
        );
        return true;
      }
      if (kind === "meeting" && action === "utworz") {
        const raw = {
          title: interaction.options.getString("temat", true),
          description: interaction.options.getString("opis") ?? "",
          term: name === "ekipa" ? null : interaction.options.getString("termin"),
          channelId: interaction.options.getChannel("kanal", true).id,
          capacity: interaction.options.getInteger("miejsca") ?? 5,
          duration: interaction.options.getInteger("czas") ?? 60,
          participates: interaction.options.getBoolean("moj-udzial") ?? true,
          private: interaction.options.getBoolean("prywatne") ?? false,
          invitedUserId: interaction.options.getUser("osoba")?.id ?? null,
          roleId: interaction.options.getRole("rola")?.id ?? null,
          roomId: interaction.options.getChannel("pokoj")?.id ?? null,
          categoryId: interaction.options.getChannel("kategoria")?.id ?? null,
          createdTimestamp: interaction.createdTimestamp,
        };
        if (raw.roomId && raw.categoryId) throw new ControlError(400, "invalid_room", "");
        if (raw.term !== null && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw.term))
          throw new ControlError(400, "invalid_term", "");
        const startsAt =
          raw.term !== null
            ? resolveLocalDateTime(
                raw.term.slice(0, 10),
                raw.term.slice(11),
                runtime.settings.read().timeZone,
              ).at
            : raw.createdTimestamp;
        const draft: MeetingDraft = {
          title: raw.title,
          description: raw.description,
          channelId: raw.channelId,
          capacity: raw.capacity,
          startsAt,
          endsAt: startsAt + raw.duration * 60000,
          visibility: raw.private ? "private" : "public",
          allowedRoleIds: raw.roleId ? [raw.roleId] : [],
          invitedUserIds: raw.invitedUserId ? [raw.invitedUserId] : [],
          organizerParticipates: raw.participates,
          reminderMinutes: [30, 10],
          state: "open",
          room: raw.roomId
            ? { kind: "existing", channelId: raw.roomId }
            : raw.categoryId
              ? { kind: "create", categoryId: raw.categoryId }
              : { kind: "none" },
        };
        const result = (await mutate("meetings.create", draft, undefined, raw)) as MeetingDetail;
        await reply(
          `Spotkanie zapisane: \`${result.meeting.id}\`. Stan ogłoszenia i swój zapis sprawdzisz przez \`/spotkanie stan\`.`,
        );
        return true;
      }
      if (kind === "case" && action === "utworz") {
        const draft = {
          kind:
            name === "pomysl"
              ? "suggestion"
              : (interaction.options.getString("rodzaj") ?? "report"),
          title: interaction.options.getString("temat", true),
          content: interaction.options.getString("tresc", true),
        };
        if (
          !["report", "question", "suggestion"].includes(draft.kind) ||
          (name !== "pomysl" && draft.kind === "suggestion")
        )
          throw new ControlError(400, "invalid_input", "");
        const result = (await mutate("cases.create", draft, undefined, draft)) as {
          case: CaseRecord;
        };
        await reply(
          `${name === "pomysl" ? "Pomysł został zapisany" : "Sprawa została zapisana"}: \`${result.case.id}\`. Widoczność: ${result.case.visibility === "private" ? "prywatna" : "publiczna"}.`,
        );
        return true;
      }
      objectId = interaction.options.getString("id", true);
      action =
        kind === "meeting"
          ? ((
              {
                stan: "read",
                dolacz: "join",
                rezygnuj: "leave",
                rozpocznij: "start",
                zakoncz: "complete",
                odwolaj: "cancel",
              } as Record<string, string>
            )[action] ?? action)
          : ((
              {
                stan: "read",
                przejmij: "assign",
                zatwierdz: "approve",
                wycofaj: "unvote",
              } as Record<string, string>
            )[action] ?? action);
    } else return false;
    if (!objectId || !uuid.test(objectId)) throw new ControlError(400, "invalid_id", "");
    if (kind === "meeting") {
      const detail = (await call("meetings.read", {}, objectId)) as MeetingDetail & {
        allowedOperations?: string[];
      };
      if (action === "read") {
        await reply(meetingStatus(detail, facts.userId));
        return true;
      }
      if (["zapros", "cofnij-zaproszenie"].includes(action) && interaction.isChatInputCommand()) {
        const userId = interaction.options.getUser("osoba")?.id,
          roleId = interaction.options.getRole("rola")?.id;
        if (Boolean(userId) === Boolean(roleId) || detail.meeting.visibility !== "private")
          throw new ControlError(400, "invalid_input", "");
        const adding = action === "zapros";
        const change = (values: string[], selected: string | undefined) =>
          selected
            ? adding
              ? [...new Set([...values, selected])]
              : values.filter((id) => id !== selected)
            : values;
        await mutate(
          "meetings.update",
          {
            revision: detail.meeting.revision,
            audience: {
              invitedUserIds: change(detail.meeting.invitedUserIds, userId),
              allowedRoleIds: change(detail.meeting.allowedRoleIds, roleId),
            },
          },
          objectId,
          { action, userId: userId ?? null, roleId: roleId ?? null },
        );
        await reply(
          adding
            ? "Zaproszenie zapisane. Osoba musi nadal mieć dostęp do kanału i spełniać zasady serwera. Gildiusz nie wysyła zaproszenia w wiadomości prywatnej."
            : "Zaproszenie wycofane. Osoba może nadal mieć dostęp przez inne zaproszenie lub wybraną rolę.",
        );
        return true;
      }
      if (!["join", "leave", "start", "complete", "cancel"].includes(action))
        throw new ControlError(400, "invalid_action", "");
      const result = (await mutate(
        `meetings.${action}` as ControlOperation,
        action === "join" || action === "leave" ? {} : { revision: detail.meeting.revision },
        objectId,
        { action },
      )) as MeetingDetail;
      await reply(meetingStatus(result, facts.userId));
      return true;
    }
    const detail = (await call("cases.read", {}, objectId)) as CaseView & {
      allowedOperations?: string[];
    };
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "pomysl" &&
      detail.case.kind !== "suggestion"
    )
      throw new ControlError(404, "not_found", "");
    if (action === "read") {
      await reply(caseStatus(detail));
      return true;
    }
    if (action === "assign" || action === "approve") {
      const result = (await mutate(
        action === "assign" ? "cases.assign" : "cases.approve",
        {
          revision: detail.case.revision,
          ...(action === "assign" ? { assigneeId: facts.userId } : {}),
        },
        objectId,
        { action },
      )) as { case: CaseRecord };
      await reply(
        action === "assign"
          ? "Przypisanie sprawy zostało zapisane."
          : `Widoczność pomysłu: ${result.case.visibility === "public" ? "publiczna" : "prywatna"}.`,
      );
      return true;
    }
    if (["up", "down", "unvote", "glos"].includes(action)) {
      if (
        action === "glos" &&
        interaction.isChatInputCommand() &&
        !["up", "down"].includes(interaction.options.getString("wybor", true))
      )
        throw new ControlError(400, "invalid_input", "");
      const value =
        action === "unvote"
          ? null
          : action === "down" ||
              (interaction.isChatInputCommand() &&
                interaction.options.getString("wybor") === "down")
            ? -1
            : 1;
      const result = (await mutate("cases.vote", { value }, objectId, { value })) as {
        votes: { positive: number; negative: number };
        ownVote: number | null;
      };
      await reply(
        `Twój głos: ${result.ownVote === null ? "wycofany" : result.ownVote === 1 ? "za" : "przeciw"}. Głosy za: ${result.votes.positive}. Przeciw: ${result.votes.negative}.`,
      );
      return true;
    }
    if (!interaction.isChatInputCommand()) throw new ControlError(400, "invalid_action", "");
    if (action === "odpowiedz" || action === "notatka") {
      const content = interaction.options.getString("tresc", true);
      await mutate(
        action === "notatka" ? "cases.note" : "cases.reply",
        { revision: detail.case.revision, content },
        objectId,
        { action, content },
      );
      await reply(
        action === "notatka"
          ? "Notatka została zapisana. Jest dostępna tylko dla obsługi sprawy."
          : "Odpowiedź została zapisana.",
      );
      return true;
    }
    if (action === "status") {
      const status = interaction.options.getString("status", true),
        reason = interaction.options.getString("powod");
      const result = (await mutate(
        "cases.transition",
        { revision: detail.case.revision, status, ...(reason ? { reason } : {}) },
        objectId,
        { status, reason },
      )) as { case: CaseRecord };
      await reply(`Status sprawy: ${caseStates[result.case.status] ?? "nieznany"}.`);
      return true;
    }
    throw new ControlError(400, "invalid_action", "");
  } catch (error) {
    await reply(safeError(error));
  }
  return true;
}
