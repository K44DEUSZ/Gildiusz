import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { GuildInstallation } from "../installations.js";
import { requireId } from "../shared/utils.js";
import { privateDirectory, regularFile, syncDirectory } from "../storage/recovery/files.js";

class RegistryPersistenceError extends Error {
  constructor(
    readonly committed: boolean,
    cause: unknown,
  ) {
    super("Could not persist the public installation registry.", { cause });
  }
}

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
  private save(): void {
    this.validateRemoval();
    const temporary = this.path + `.${randomUUID()}.tmp`;
    let committed = false;
    try {
      writeFileSync(
        temporary,
        JSON.stringify(this.values().map(({ guildId, ownerId }) => ({ guildId, ownerId }))) + "\n",
        { flag: "wx", mode: 0o600, flush: true },
      );
      renameSync(temporary, this.path);
      committed = true;
      syncDirectory(this.directory);
    } catch (error) {
      throw new RegistryPersistenceError(committed, error);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  remove(guildId: string): boolean {
    requireId(guildId, "guildId");
    const previous = this.entries.get(guildId);
    if (!previous) {
      this.save();
      return false;
    }
    this.entries.delete(guildId);
    try {
      this.save();
    } catch (error) {
      if (!(error instanceof RegistryPersistenceError) || !error.committed)
        this.entries.set(guildId, previous);
      throw error;
    }
    return true;
  }
  validateRemoval(): void {
    privateDirectory(this.directory);
    if (existsSync(this.path)) regularFile(this.path);
  }
  add(guildId: string, ownerId: string): GuildInstallation {
    const existing = this.entries.get(guildId);
    if (existing) {
      this.save();
      return existing;
    }
    if (this.entries.size >= 1000) throw Error("Public installation limit");
    const value = this.installation(guildId, ownerId);
    this.entries.set(guildId, value);
    try {
      this.save();
    } catch (error) {
      if (!(error instanceof RegistryPersistenceError) || !error.committed)
        this.entries.delete(guildId);
      throw error;
    }
    return value;
  }
}
