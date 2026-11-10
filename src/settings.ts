import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Store } from "./storage/store.js";
import { fileExtensions } from "./contracts/file-formats.js";

export const supportedExtensions = fileExtensions;
export interface EditableSettings {
  maximum: number;
  creationCooldownSeconds: number;
  emptySeconds: number;
  transferSeconds: number;
  extensions: string[];
}
const ranges = {
  maximum: [1, 45],
  creationCooldownSeconds: [1, 3600],
  emptySeconds: [10, 3600],
  transferSeconds: [10, 3600],
} as const;
const labels: Record<string, string> = {
  maximum: "Maksymalna liczba pokojów",
  creationCooldownSeconds: "Przerwa między tworzeniem",
  emptySeconds: "Usuwanie pustego pokoju",
  transferSeconds: "Przekazanie prowadzenia",
};
export class SettingsError extends Error {}

export function validateSettings(input: unknown): EditableSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new SettingsError("Nieprawidłowe ustawienia.");
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((key) => !Object.hasOwn(ranges, key) && key !== "extensions"))
    throw new SettingsError("To ustawienie nie jest obsługiwane przez panel.");
  for (const [key, [minimum, maximum]] of Object.entries(ranges))
    if (
      !Number.isSafeInteger(values[key]) ||
      Number(values[key]) < minimum ||
      Number(values[key]) > maximum
    )
      throw new SettingsError(
        `${labels[key]}: podaj liczbę całkowitą od ${minimum} do ${maximum}.`,
      );
  const extensions = values.extensions;
  if (
    !Array.isArray(extensions) ||
    !extensions.length ||
    extensions.some(
      (entry) =>
        typeof entry !== "string" ||
        !supportedExtensions.includes(entry as (typeof supportedExtensions)[number]),
    )
  )
    throw new SettingsError("Wybierz co najmniej jeden z obsługiwanych formatów plików.");
  return {
    maximum: Number(values.maximum),
    creationCooldownSeconds: Number(values.creationCooldownSeconds),
    emptySeconds: Number(values.emptySeconds),
    transferSeconds: Number(values.transferSeconds),
    extensions: supportedExtensions.filter((entry) => extensions.includes(entry)),
  };
}

export class SettingsService {
  private revision = 0;
  private readonly defaults: EditableSettings;
  constructor(
    private store: Store,
    private config: Config,
    private guild: string,
  ) {
    this.defaults = validateSettings({
      maximum: config.rooms.maximum,
      creationCooldownSeconds: config.rooms.creationCooldownSeconds,
      emptySeconds: config.rooms.emptySeconds,
      transferSeconds: config.rooms.transferSeconds,
      extensions: config.attachments.extensions,
    });
    this.read();
  }
  read(): { revision: number; values: EditableSettings } {
    const saved = this.store.settings(this.guild);
    const values = validateSettings(saved ? JSON.parse(saved.body) : this.defaults);
    this.revision = saved?.revision ?? 0;
    this.activate(values);
    return { revision: this.revision, values };
  }
  update(patch: Partial<EditableSettings>, expected: number, actor: string) {
    const current = this.read();
    if (expected !== current.revision)
      throw new SettingsError("Ustawienia zostały już zmienione. Otwórz panel ponownie.");
    const values = validateSettings({ ...current.values, ...patch });
    try {
      this.revision = this.store.saveSettings(this.guild, values, expected, actor);
    } catch (error) {
      if (error instanceof Error && error.message === "settings_conflict")
        throw new SettingsError("Ustawienia zostały już zmienione. Otwórz panel ponownie.");
      throw error;
    }
    this.activate(values);
    return { revision: this.revision, values };
  }
  private activate(values: EditableSettings): void {
    const { extensions, ...rooms } = values;
    Object.assign(this.config.rooms, rooms);
    this.config.attachments.extensions = [...extensions];
  }
}

export class FormatDrafts {
  private entries = new Map<
    string,
    { actor: string; guild: string; revision: number; extensions: string[]; expires: number }
  >();
  constructor(private now: () => number = Date.now) {}
  create(actor: string, guild: string, revision: number, extensions: string[]): string {
    for (const [id, draft] of this.entries)
      if (draft.expires <= this.now()) this.entries.delete(id);
    if (this.entries.size >= 100)
      throw new SettingsError("Otwartych jest zbyt wiele formularzy. Spróbuj później.");
    const id = randomUUID();
    this.entries.set(id, {
      actor,
      guild,
      revision,
      extensions: [...extensions],
      expires: this.now() + 600000,
    });
    return id;
  }
  get(id: string, actor: string, guild: string) {
    const draft = this.entries.get(id);
    if (!draft || draft.expires <= this.now() || draft.actor !== actor || draft.guild !== guild)
      throw new SettingsError(
        "Formularz wygasł albo należy do innej osoby. Otwórz Formaty ponownie.",
      );
    return { ...draft, extensions: [...draft.extensions] };
  }
  select(id: string, actor: string, guild: string, extensions: string[]): void {
    const draft = this.get(id, actor, guild);
    this.entries.set(id, { ...draft, extensions: [...extensions] });
  }
  remove(id: string): void {
    this.entries.delete(id);
  }
}
