import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../../storage/migrations.js";
import { ControlError } from "../../control/contracts.js";
import type { ModulePolicy } from "../permissions.js";

import {
  newModules,
  type ModuleSettings,
  type NewModule,
  type CaseSettings,
} from "../../contracts/modules.js";
export { newModules, type NewModule, type ModuleSettings } from "../../contracts/modules.js";

const maximumRevision = Number.MAX_SAFE_INTEGER - 1;
const snowflake = (value: unknown): value is string =>
  typeof value === "string" && /^\d{17,20}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function defaultCaseSettings(): CaseSettings {
  return {
    categoryId: "",
    suggestionChannelId: "",
    suggestionVisibility: "approval",
    voting: { enabled: false, statuses: ["new", "in_review"] },
    reasonRequiredStatuses: ["accepted", "rejected"],
    retentionMs: 90 * 86400000,
  };
}
export function parseCaseSettings(input: unknown): CaseSettings {
  const fields = [
    "categoryId",
    "suggestionChannelId",
    "suggestionVisibility",
    "voting",
    "reasonRequiredStatuses",
    "retentionMs",
  ];
  if (
    !record(input) ||
    fields.some((key) => !Object.hasOwn(input, key)) ||
    Object.keys(input).some((key) => !fields.includes(key))
  )
    throw new ControlError(400, "cases_settings", "Sprawdź ustawienia zgłoszeń i pomysłów.");
  for (const field of ["categoryId", "suggestionChannelId"])
    if (input[field] !== "" && !snowflake(input[field]))
      throw new ControlError(400, "cases_channel", "Wybierz kanał tego serwera.");
  const choices = <T extends string>(value: unknown, allowed: readonly T[]): T[] => {
    if (
      !Array.isArray(value) ||
      value.length > allowed.length ||
      Array.from(value).some((entry) => !allowed.includes(entry)) ||
      new Set(value).size !== value.length
    )
      throw new ControlError(
        400,
        "cases_settings",
        "Wybierz prawidłowe stany zgłoszeń i pomysłów.",
      );
    return [...value];
  };
  if (
    typeof input.suggestionVisibility !== "string" ||
    !["approval", "immediate"].includes(input.suggestionVisibility) ||
    !record(input.voting) ||
    Object.keys(input.voting).some((key) => !["enabled", "statuses"].includes(key)) ||
    !Object.hasOwn(input.voting, "statuses") ||
    !Object.hasOwn(input.voting, "enabled") ||
    typeof input.voting.enabled !== "boolean"
  )
    throw new ControlError(400, "cases_settings", "Sprawdź widoczność i głosowanie pomysłów.");
  if (
    input.retentionMs !== null &&
    (!Number.isSafeInteger(input.retentionMs) ||
      Number(input.retentionMs) < 86400000 ||
      Number(input.retentionMs) > 366 * 86400000)
  )
    throw new ControlError(
      400,
      "cases_retention",
      "Sprawdź dane okresu przechowywania prywatnych spraw.",
    );
  return {
    categoryId: input.categoryId as string,
    suggestionChannelId: input.suggestionChannelId as string,
    suggestionVisibility: input.suggestionVisibility as CaseSettings["suggestionVisibility"],
    voting: {
      enabled: input.voting.enabled,
      statuses: choices(input.voting.statuses, ["new", "in_review"] as const),
    },
    reasonRequiredStatuses: choices(input.reasonRequiredStatuses, [
      "accepted",
      "rejected",
    ] as const),
    // Older clients may still send their previous preference; the service policy is fixed.
    retentionMs: 90 * 86400000,
  };
}

export function parseModuleSettings(input: unknown): ModuleSettings {
  if (!record(input))
    throw new ControlError(400, "module_settings", "Nieprawidłowe ustawienia modułów.");
  const value = input;
  const fields = [
    "revision",
    "timeZone",
    "organizerRoleIds",
    "caseModeratorRoleIds",
    "announcementManagerRoleIds",
    "djRoleIds",
    "allowMemberMusic",
    "enabled",
  ];
  if (
    Object.keys(value).some((key) => !fields.includes(key) && key !== "cases") ||
    fields.some((key) => !Object.hasOwn(value, key)) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    Number(value.revision) > maximumRevision
  )
    throw new ControlError(400, "module_settings", "Nieprawidłowe ustawienia modułów.");
  if (
    typeof value.timeZone !== "string" ||
    value.timeZone.length > 80 ||
    !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(value.timeZone)
  )
    throw new ControlError(400, "timezone", "Wybierz prawidłową strefę czasową.");
  try {
    new Intl.DateTimeFormat("pl", { timeZone: value.timeZone });
  } catch {
    throw new ControlError(400, "timezone", "Wybierz prawidłową strefę czasową.");
  }
  const roles = (key: string): string[] => {
    const values = value[key];
    if (
      !Array.isArray(values) ||
      values.length > 20 ||
      Array.from(values).some((id) => !snowflake(id)) ||
      new Set(values).size !== values.length
    )
      throw new ControlError(400, "roles", "Wybierz prawidłowe role dla obsługi modułu.");
    return [...values] as string[];
  };
  if (typeof value.allowMemberMusic !== "boolean" || !record(value.enabled))
    throw new ControlError(400, "module_settings", "Nieprawidłowe ustawienia modułów.");
  const enabled = value.enabled as Record<string, unknown>;
  if (
    Object.keys(enabled).some((key) => !newModules.includes(key as NewModule)) ||
    newModules.some((key) => !Object.hasOwn(enabled, key) || typeof enabled[key] !== "boolean")
  )
    throw new ControlError(400, "module_settings", "Wskaż funkcje serwera.");
  roles("djRoleIds");
  return {
    revision: value.revision as number,
    timeZone: value.timeZone,
    organizerRoleIds: roles("organizerRoleIds"),
    caseModeratorRoleIds: roles("caseModeratorRoleIds"),
    announcementManagerRoleIds: roles("announcementManagerRoleIds"),
    // Reserved by contracts 0.9; the withdrawn module cannot retain active policy.
    djRoleIds: [],
    allowMemberMusic: false,
    cases: Object.hasOwn(value, "cases") ? parseCaseSettings(value.cases) : defaultCaseSettings(),
    enabled: Object.fromEntries(newModules.map((key) => [key, enabled[key]])) as Record<
      NewModule,
      boolean
    >,
  };
}

export class ModuleSettingsStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly guildId: string,
    private readonly clock = Date.now,
  ) {
    if (!snowflake(guildId))
      throw new ControlError(400, "guild", "Wskaż prawidłowy serwer Discorda.");
  }

  read(): ModuleSettings {
    const row = this.db
      .prepare("SELECT revision,body FROM guild_module_settings WHERE guild_id=?")
      .get(this.guildId);
    if (row) {
      const value = parseModuleSettings({
        ...JSON.parse(String(row.body)),
        revision: Number(row.revision),
      });
      value.enabled.music = false;
      return value;
    }
    return {
      revision: 0,
      timeZone: "Europe/Warsaw",
      organizerRoleIds: [],
      caseModeratorRoleIds: [],
      announcementManagerRoleIds: [],
      djRoleIds: [],
      allowMemberMusic: false,
      cases: defaultCaseSettings(),
      enabled: {
        meetings: false,
        cases: false,
        announcements: false,
        integrations: false,
        music: false,
      },
    };
  }

  save(input: unknown, actor: string): ModuleSettings {
    if (!snowflake(actor))
      throw new ControlError(
        400,
        "actor",
        "Nie udało się potwierdzić osoby zmieniającej ustawienia.",
      );
    const value = parseModuleSettings(input);
    if (value.enabled.music)
      throw new ControlError(409, "module_unavailable", "Ta funkcja nie jest dostępna.");
    return transaction(this.db, () => {
      if (value.revision !== this.read().revision)
        throw new ControlError(
          409,
          "conflict",
          "Ustawienia zmieniły się. Wczytaj aktualną wersję.",
        );
      if (value.revision === maximumRevision)
        throw new ControlError(
          409,
          "revision_exhausted",
          "Nie można teraz zmienić tej wersji ustawień.",
        );
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0)
        throw new ControlError(503, "clock", "Nie można teraz zapisać ustawień.");
      const next = { ...value, revision: value.revision + 1 };
      this.db
        .prepare(
          "INSERT INTO guild_module_settings (guild_id,revision,body,actor,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,actor=excluded.actor,updated_at=excluded.updated_at",
        )
        .run(this.guildId, next.revision, JSON.stringify(next), actor, now);
      return next;
    });
  }

  policy(): ModulePolicy {
    return { guildId: this.guildId, ...this.read() };
  }
}
