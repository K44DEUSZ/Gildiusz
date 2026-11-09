import { readFileSync, realpathSync, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { requireId } from "./shared/utils.js";

export interface GuildInstallation {
  guildId: string;
  ownerId: string;
  configPath: string;
  databasePath: string;
  public?: boolean;
}

function databaseIdentity(path: string): string {
  // Resolve existing parents too: two aliases must never open the same SQLite file.
  let parent = path;
  const tail = [];
  while (!existsSync(parent) && dirname(parent) !== parent) {
    tail.unshift(basename(parent));
    parent = dirname(parent);
  }
  const canonical = resolve(realpathSync(parent), ...tail);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function loadInstallations(values = process.env): GuildInstallation[] {
  if (values.PUBLIC_INSTALLS === "1" && !values.GUILDS_PATH && !values.DISCORD_GUILD_ID) return [];
  if (!values.GUILDS_PATH)
    return [
      {
        guildId: requireId(values.DISCORD_GUILD_ID, "DISCORD_GUILD_ID"),
        ownerId: requireId(values.OWNER_USER_ID, "OWNER_USER_ID"),
        configPath: resolve(values.CONFIG_PATH || "config/server.json"),
        databasePath: resolve(values.DATABASE_PATH || "data/gildiusz.sqlite"),
      },
    ];
  const path = resolve(values.GUILDS_PATH);
  const entries: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(entries) || !entries.length)
    throw Error("GUILDS_PATH must contain a non-empty list of installations.");
  const guilds = new Set<string>(),
    databases = new Set<string>();
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") throw Error("Invalid guild installation.");
    const item = entry as Record<string, string>;
    const guildId = requireId(item.guildId, "guildId");
    const ownerId = requireId(item.ownerId, "ownerId");
    if (
      typeof item.configPath !== "string" ||
      !item.configPath.trim() ||
      typeof item.databasePath !== "string" ||
      !item.databasePath.trim()
    )
      throw Error("Each guild requires explicit configPath and databasePath.");
    const databasePath = resolve(dirname(path), item.databasePath);
    const identity = databaseIdentity(databasePath);
    if (guilds.has(guildId) || databases.has(identity))
      throw Error("Guild IDs and database paths must be unique.");
    guilds.add(guildId);
    databases.add(identity);
    return { guildId, ownerId, databasePath, configPath: resolve(dirname(path), item.configPath) };
  });
}

export function selectInstallation(
  guildId: string | undefined,
  values = process.env,
): GuildInstallation {
  const entries = loadInstallations(values);
  if (!guildId && entries.length !== 1)
    throw Error("Choose the target guild explicitly with --guild ID.");
  const selected = guildId ? entries.find((entry) => entry.guildId === guildId) : entries[0];
  if (!selected) throw Error("This guild is not configured.");
  return selected;
}

export function healthPath(values = process.env): string {
  return resolve(
    values.HEALTH_PATH ||
      resolve(dirname(resolve(values.DATABASE_PATH || "data/gildiusz.sqlite")), "health.json"),
  );
}
