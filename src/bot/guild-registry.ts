import type { GuildInstallation } from "../installations.js";

export class GuildRegistry<T> {
  private readonly entries: Map<
    string,
    { installation: GuildInstallation; value?: T; retryAt: number }
  >;
  constructor(installations: GuildInstallation[]) {
    this.entries = new Map(
      installations.map((installation) => [installation.guildId, { installation, retryAt: 0 }]),
    );
  }
  get(guildId: string | null | undefined): T | undefined {
    return guildId ? this.entries.get(guildId)?.value : undefined;
  }
  values(): T[] {
    return [...this.entries.values()].flatMap((entry) => (entry.value ? [entry.value] : []));
  }
  invalidate(guildId: string): T | undefined {
    const entry = this.entries.get(guildId);
    if (!entry) return;
    const previous = entry.value;
    entry.value = undefined;
    entry.retryAt = 0;
    return previous;
  }
  async initialize(
    create: (installation: GuildInstallation) => Promise<T>,
    onError: (guildId: string, error: unknown) => void,
    now = Date.now(),
  ): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.value || entry.retryAt > now) continue;
      entry.retryAt = now + 60000;
      try {
        const value = await create(entry.installation);
        // A leave event may invalidate an installation during asynchronous initialization.
        if (entry.retryAt === now + 60000) entry.value = value;
      } catch (error) {
        onError(entry.installation.guildId, error);
      }
    }
  }
  statuses(ready: (value: T) => boolean): { guildId: string; ready: boolean }[] {
    return [...this.entries.values()].map(({ installation, value }) => ({
      guildId: installation.guildId,
      ready: value !== undefined && ready(value),
    }));
  }
}
