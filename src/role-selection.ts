import type { Store } from "./storage/store.js";
import { SerialQueue } from "./shared/utils.js";

export const roleChoices = [
  { key: "programming", emoji: "💻" },
  { key: "design", emoji: "🎨" },
  { key: "marketing", emoji: "📣" },
  { key: "business", emoji: "💼" },
  { key: "media", emoji: "🎬" },
  { key: "hasProject", emoji: "🚀" },
  { key: "seeksTeam", emoji: "🤝" },
  { key: "joinsProject", emoji: "🧩" },
  { key: "seeksFeedback", emoji: "💬" },
  { key: "seeksInspiration", emoji: "💡" },
] as const;

export interface RoleReaction {
  guild: string | null;
  channel: string;
  message: string;
  emoji: string | null;
  user: string;
  active: boolean;
}
export interface RoleSelectionPort {
  reactors(emoji: string): Promise<string[]>;
  apply(user: string, key: string, active: boolean): Promise<boolean>;
}

export class RoleSelectionService {
  readonly queue = new SerialQueue();
  constructor(
    private store: Store,
    private panel: { guild: string; channel: string; message: string },
    private port: RoleSelectionPort,
  ) {}
  handle(event: RoleReaction): Promise<void> {
    const choice = roleChoices.find((entry) => entry.emoji === event.emoji);
    if (
      !choice ||
      event.guild !== this.panel.guild ||
      event.channel !== this.panel.channel ||
      event.message !== this.panel.message
    )
      return Promise.resolve();
    return this.queue.run(() => this.apply(event.user, choice.key, event.active));
  }
  reconcile(): Promise<void> {
    return this.queue.run(async () => {
      for (const choice of roleChoices) {
        // Read a complete page set before treating absent reactions as removals.
        const current = new Set(await this.port.reactors(choice.emoji));
        const members = new Set([...current, ...this.store.roleSelections(choice.key)]);
        for (const member of members) await this.apply(member, choice.key, current.has(member));
      }
    });
  }
  private async apply(user: string, key: string, active: boolean): Promise<void> {
    // Remember intent before the API call so a restart can repair an interrupted write.
    if (active) this.store.setRoleSelection(user, key, true);
    const eligible = await this.port.apply(user, key, active);
    if (!active || !eligible) this.store.setRoleSelection(user, key, false);
  }
}
