import { fileFormats, type FileFormat } from "./file-formats.js";
import { normalizeReactionEmoji, reactionEmojiKey, reactionEmojiValidation } from "./emoji.js";
export { fileFormats } from "./file-formats.js";
export const moduleKeys = ["rooms", "reactions", "files", "reports"] as const;
export type ModuleKey = (typeof moduleKeys)[number];
export const moduleNames: Record<ModuleKey, string> = {
  rooms: "Pokoje głosowe",
  reactions: "Role za reakcje",
  files: "Filtr plików",
  reports: "Zgłoszenia",
};
export interface Configuration {
  revision: number;
  modules: Record<ModuleKey, boolean>;
  rooms: {
    entryChannelId: string;
    categoryId: string;
    maxRooms: number;
    userLimit: number;
    idleSeconds: number;
  };
  reactions: { channelId: string; choices: { emoji: string; roleId: string }[] };
  files: { channelIds: string[]; formats: (typeof fileFormats)[number][]; includeRooms: boolean };
  reports: { channelId: string };
}
export interface GuildChannel {
  id: string;
  name: string;
  kind: "text" | "voice" | "category";
  accessible: boolean;
  uses?: ("rooms" | "reactions" | "files" | "reports")[];
}
export interface GuildRole {
  id: string;
  name: string;
  color: string;
  assignable: boolean;
}
export interface GuildResources {
  channels: GuildChannel[];
  roles: GuildRole[];
  configurationCapabilities?: {
    fileFormats: readonly FileFormat[];
    reactionEmojiMaxLength: number;
  };
}
export interface GuildSummary {
  id: string;
  name: string;
  initials: string;
  description: string;
  accent: string;
  preview: boolean;
  installed?: boolean;
}
export interface ControlSnapshot {
  configuration: Configuration;
  resources: GuildResources;
  installation: {
    ready: boolean;
    managedLayout: boolean;
    activeRooms: number;
    rolePanelUrl?: string;
  };
}
export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ControlError(400, "invalid_configuration", "Nieprawidłowa konfiguracja.");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ControlError(400, "unknown_setting", "Konfiguracja zawiera nieobsługiwane pole.");
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new ControlError(400, "invalid_limit", "Sprawdź limity i czas usuwania pokojów.");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new ControlError(400, "invalid_switch", "Nieprawidłowy stan funkcji.");
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || (value !== "" && !/^\d{17,20}$/.test(value)))
    throw new ControlError(400, "invalid_resource", "Nieprawidłowy identyfikator kanału lub roli.");
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new ControlError(
      400,
      "invalid_list",
      "Lista ustawień jest nieprawidłowa lub zbyt długa.",
    );
  return value;
}
export function parseConfiguration(input: unknown): Configuration {
  const value = record(input, ["revision", "modules", "rooms", "reactions", "files", "reports"]);
  const modules = record(value.modules, [...moduleKeys]);
  const rooms = record(value.rooms, [
    "entryChannelId",
    "categoryId",
    "maxRooms",
    "userLimit",
    "idleSeconds",
  ]);
  const reactions = record(value.reactions, ["channelId", "choices"]);
  const files = record(value.files, ["channelIds", "formats", "includeRooms"]);
  const reports = record(value.reports, ["channelId"]);
  const formats = array(files.formats, fileFormats.length);
  if (
    formats.some((format) => !fileFormats.includes(format as (typeof fileFormats)[number])) ||
    new Set(formats).size !== formats.length
  )
    throw new ControlError(400, "invalid_format", "Wybierz obsługiwane formaty plików.");
  return {
    revision: integer(value.revision, 0, Number.MAX_SAFE_INTEGER - 1),
    modules: {
      rooms: boolean(modules.rooms),
      reactions: boolean(modules.reactions),
      files: boolean(modules.files),
      reports: boolean(modules.reports),
    },
    rooms: {
      entryChannelId: id(rooms.entryChannelId),
      categoryId: id(rooms.categoryId),
      maxRooms: integer(rooms.maxRooms, 1, 45),
      userLimit: integer(rooms.userLimit, 0, 99),
      idleSeconds: integer(rooms.idleSeconds, 10, 3600),
    },
    reactions: {
      channelId: id(reactions.channelId),
      choices: array(reactions.choices, 15).map((input) => {
        const choice = record(input, ["emoji", "roleId"]);
        const emojiStatus = reactionEmojiValidation(choice.emoji);
        if (emojiStatus === "invalid")
          throw new ControlError(400, "invalid_emoji", "Wybierz pojedyncze emoji.");
        return {
          emoji:
            emojiStatus === "valid"
              ? normalizeReactionEmoji(choice.emoji as string)
              : (choice.emoji as string),
          roleId: id(choice.roleId),
        };
      }),
    },
    files: {
      channelIds: array(files.channelIds, 100).map(id),
      formats: formats as Configuration["files"]["formats"],
      includeRooms: boolean(files.includeRooms),
    },
    reports: { channelId: id(reports.channelId) },
  };
}
export function validateBindings(config: Configuration, resources: GuildResources): string[] {
  const errors: string[] = [];
  function channel(id: string, kinds: GuildChannel["kind"][], label: string, purpose?: ModuleKey) {
    if (
      !resources.channels.some(
        (entry) =>
          entry.id === id &&
          kinds.includes(entry.kind) &&
          entry.accessible &&
          (!entry.uses || !purpose || entry.uses.includes(purpose)),
      )
    )
      errors.push("Wybierz dostępny " + label + ".");
  }
  if (config.modules.rooms) {
    channel(config.rooms.entryChannelId, ["voice"], "kanał wejściowy", "rooms");
    channel(config.rooms.categoryId, ["category"], "kategorię pokojów", "rooms");
  }
  if (config.modules.reactions) {
    channel(config.reactions.channelId, ["text"], "kanał wyboru ról", "reactions");
    if (!config.reactions.choices.length) errors.push("Dodaj przynajmniej jedną rolę do wyboru.");
    const emoji = new Set<string>(),
      roles = new Set<string>();
    for (const choice of config.reactions.choices) {
      if (!resources.roles.some((role) => role.id === choice.roleId && role.assignable))
        errors.push("Wybierz rolę, którą Gildiusz może bezpiecznie nadawać.");
      if (reactionEmojiValidation(choice.emoji) === "invalid")
        errors.push("Każdy wybór potrzebuje jednego emoji.");
      const emojiKey = reactionEmojiKey(choice.emoji);
      if (emoji.has(emojiKey) || roles.has(choice.roleId))
        errors.push("Emoji i role nie mogą się powtarzać.");
      emoji.add(emojiKey);
      roles.add(choice.roleId);
    }
  }
  if (config.modules.files) {
    if (!config.files.channelIds.length && !config.files.includeRooms)
      errors.push("Wybierz kanały objęte filtrem.");
    if (!config.files.formats.length) errors.push("Wybierz przynajmniej jeden dozwolony format.");
    if (new Set(config.files.channelIds).size !== config.files.channelIds.length)
      errors.push("Kanały filtra nie mogą się powtarzać.");
    config.files.channelIds.forEach((id) =>
      channel(id, ["text", "voice"], "kanał objęty filtrem", "files"),
    );
  }
  if (config.modules.reports)
    channel(config.reports.channelId, ["text"], "kanał dla zgłoszeń", "reports");
  return [...new Set(errors)];
}

export const installPermissions = (
  16n |
  64n |
  1024n |
  2048n |
  8192n |
  65536n |
  1048576n |
  16777216n |
  268435456n
).toString();
