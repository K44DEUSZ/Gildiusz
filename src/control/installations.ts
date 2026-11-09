import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GuildInstallation } from "../installations.js";
import { requireId } from "../shared/utils.js";

export class PublicInstallations {
  private readonly path: string;
  private readonly entries = new Map<string, GuildInstallation>();
  constructor(private directory: string) {
    directory = this.directory = resolve(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, "installations.json");
    if (existsSync(this.path)) {
      const rows: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(rows) || rows.length > 1000) throw Error("Invalid public installations");
      for (const row of rows)
        this.entries.set(
          requireId(row.guildId, "guildId"),
          this.installation(row.guildId, requireId(row.ownerId, "ownerId")),
        );
    }
  }
  private installation(guildId: string, ownerId: string): GuildInstallation {
    requireId(guildId, "guildId");
    requireId(ownerId, "ownerId");
    return {
      guildId,
      ownerId,
      configPath: "",
      databasePath: join(this.directory, guildId, "gildiusz.sqlite"),
      public: true,
    };
  }
  values(): GuildInstallation[] {
    return [...this.entries.values()];
  }
  add(guildId: string, ownerId: string): GuildInstallation {
    const existing = this.entries.get(guildId);
    if (existing) return existing;
    if (this.entries.size >= 1000) throw Error("Public installation limit");
    const value = this.installation(guildId, ownerId);
    this.entries.set(guildId, value);
    try {
      writeFileSync(
        this.path + ".tmp",
        JSON.stringify(this.values().map(({ guildId, ownerId }) => ({ guildId, ownerId }))) + "\n",
        { mode: 0o600 },
      );
      renameSync(this.path + ".tmp", this.path);
    } catch (error) {
      this.entries.delete(guildId);
      throw error;
    }
    return value;
  }
}
