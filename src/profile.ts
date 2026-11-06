import { randomUUID } from "node:crypto";
import { SettingsError } from "./settings.js";
import { digest, SerialQueue } from "./shared/utils.js";
import { attachmentUrl, matchesHeader, sniff } from "./bot/attachment-policy.js";

export const avatarLimit = 2 * 1024 * 1024;
export interface BotProfile {
  nick: string | null;
  avatar: string | null;
  defaultName: string;
  avatarURL: string;
  defaultAvatarURL: string;
}
export interface ProfilePatch {
  nick?: string | null;
  avatar?: Buffer | null;
}
export function profileRevision(profile: BotProfile): string {
  return digest(profile);
}
export function profileName(input: string): string | null {
  const name = input.normalize("NFC").trim();
  if (name.length > 32 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new SettingsError("Nazwa może mieć do 32 znaków, bez znaków sterujących.");
  return name || null;
}

export async function downloadAvatar(
  file: { name: string; size: number; url: string },
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > avatarLimit)
    throw new SettingsError("Awatar może mieć maksymalnie 2 MB.");
  const url = attachmentUrl(file.url, ["cdn.discordapp.com", "media.discordapp.net"]);
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Accept-Encoding": "identity" },
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new SettingsError("Nie udało się pobrać awatara. Wgraj plik ponownie.");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > file.size || length > avatarLimit)
        throw new SettingsError("Awatar przekracza dopuszczalny rozmiar.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (length !== file.size || !matchesHeader(file.name, bytes, ["png", "jpg", "jpeg", "gif"]))
    throw new SettingsError(
      "Wgraj kompletny obraz PNG, JPG lub GIF. Format musi pasować do pliku.",
    );
  return bytes;
}

interface ProfileDraft {
  actor: string;
  expected: string;
  profile: BotProfile;
  patch: ProfilePatch;
  expires: number;
}
export class ProfileService {
  private drafts = new Map<string, ProfileDraft>();
  private queue = new SerialQueue();
  constructor(
    readonly guild: string,
    private adapter: {
      read(): Promise<BotProfile>;
      write(patch: ProfilePatch, actor: string): Promise<void>;
      cooldown(): boolean;
      audit(actor: string): void;
    },
    private now: () => number = Date.now,
  ) {}
  read(): Promise<BotProfile> {
    return this.adapter.read();
  }
  async prepare(actor: string, expected: string, patch: ProfilePatch): Promise<string> {
    const profile = await this.read();
    if (profileRevision(profile) !== expected)
      throw new SettingsError("Profil został już zmieniony. Otwórz go ponownie.");
    if (patch.nick !== undefined && patch.nick !== null) patch.nick = profileName(patch.nick);
    if (
      patch.avatar &&
      (patch.avatar.length > avatarLimit ||
        !["png", "jpeg", "gif"].includes(sniff(patch.avatar) ?? ""))
    )
      throw new SettingsError("Nieprawidłowy obraz awatara.");
    if (patch.nick === profile.nick) delete patch.nick;
    if (patch.avatar === null && profile.avatar === null) delete patch.avatar;
    if (!Object.keys(patch).length) throw new SettingsError("Profil już ma wybrane ustawienia.");
    this.clean();
    for (const [id, entry] of this.drafts) if (entry.actor === actor) this.drafts.delete(id);
    const bytes = [...this.drafts.values()].reduce(
      (sum, entry) => sum + (entry.patch.avatar?.length ?? 0),
      patch.avatar?.length ?? 0,
    );
    if (this.drafts.size >= 10 || bytes > 8 * 1024 * 1024)
      throw new SettingsError("Otwartych jest zbyt wiele podglądów. Spróbuj później.");
    const id = randomUUID();
    this.drafts.set(id, {
      actor,
      expected,
      profile,
      patch: { ...patch, ...(patch.avatar ? { avatar: Buffer.from(patch.avatar) } : {}) },
      expires: this.now() + 300000,
    });
    return id;
  }
  get(id: string, actor: string, guild: string): ProfileDraft {
    this.clean();
    const draft = this.drafts.get(id);
    if (!draft || draft.actor !== actor || guild !== this.guild)
      throw new SettingsError(
        "Podgląd wygasł albo należy do innej osoby. Otwórz Profil bota ponownie.",
      );
    return {
      ...draft,
      profile: { ...draft.profile },
      patch: {
        ...draft.patch,
        ...(draft.patch.avatar ? { avatar: Buffer.from(draft.patch.avatar) } : {}),
      },
    };
  }
  cancel(id: string, actor: string, guild: string): void {
    this.get(id, actor, guild);
    this.drafts.delete(id);
  }
  async save(id: string, actor: string, guild: string): Promise<void> {
    await this.queue.run(async () => {
      const draft = this.get(id, actor, guild);
      if (profileRevision(await this.read()) !== draft.expected) {
        this.drafts.delete(id);
        throw new SettingsError("Profil został już zmieniony. Otwórz go ponownie.");
      }
      if (!this.adapter.cooldown())
        throw new SettingsError(
          "Profil można zapisywać raz na minutę. Odczekaj i spróbuj ponownie.",
        );
      // Po niejednoznacznym błędzie API nie ponawiamy zapisu z tego samego podglądu.
      this.drafts.delete(id);
      await this.adapter.write(draft.patch, actor);
      this.adapter.audit(actor);
    });
  }
  private clean(): void {
    for (const [id, draft] of this.drafts) if (draft.expires <= this.now()) this.drafts.delete(id);
  }
}
