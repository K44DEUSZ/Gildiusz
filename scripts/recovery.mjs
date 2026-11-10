import { existsSync, readFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadInstallations, healthPath } from "../dist/installations.js";
import { regularFile } from "../dist/storage/recovery/files.js";
import { readDeletionLedger } from "../dist/storage/uninstall-retention.js";
import {
  createSnapshot,
  planSnapshot,
  restoreSnapshot,
  snapshotSchemasUnchanged,
} from "../dist/storage/recovery/index.js";

export function recoveryCredentials(values) {
  return {
    key: values.BACKUP_ENCRYPTION_KEY || "",
    forbiddenKeys: Object.entries(values)
      .filter(
        ([name]) => name !== "BACKUP_ENCRYPTION_KEY" && /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name),
      )
      .map(([, value]) => value)
      .filter(Boolean),
    ...(values.BACKUP_MAX_BYTES ? { maxBytes: Number(values.BACKUP_MAX_BYTES) } : {}),
    ...(values.BACKUP_MAX_FILES ? { maxFiles: Number(values.BACKUP_MAX_FILES) } : {}),
  };
}

export function configuredSnapshot(outputPath, values = process.env) {
  const dataRoot = dirname(healthPath(values));
  const publicRoot = resolve(values.CONTROL_DATA_DIR || join(dataRoot, "public-guilds"));
  const registryPath = join(publicRoot, "installations.json");
  const legacy =
    existsSync(registryPath) && !values.GUILDS_PATH && !values.DISCORD_GUILD_ID
      ? []
      : loadInstallations(values);
  const guilds = legacy.filter((entry) => {
    try {
      lstatSync(entry.databasePath);
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Operator definitions can outlive a deliberately purged legacy installation.
    return !readDeletionLedger(dataRoot, entry.guildId);
  });
  if (existsSync(registryPath)) {
    if (regularFile(registryPath) > 1024 * 1024) throw Error("Invalid public registry size.");
    const entries = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!Array.isArray(entries) || entries.length > 1000) throw Error("Invalid public registry.");
    for (const row of entries) {
      const existing = guilds.find((entry) => entry.guildId === row.guildId);
      if (existing) {
        if (existing.ownerId !== row.ownerId) throw Error("Conflicting configured guild owner.");
        continue;
      }
      guilds.push({
        guildId: row.guildId,
        ownerId: row.ownerId,
        configPath: "",
        databasePath: join(publicRoot, row.guildId, "gildiusz.sqlite"),
        public: true,
      });
    }
  }
  const hubDatabasePath = resolve(
    values.INTEGRATIONS_DATABASE_PATH || join(dataRoot, "integrations.sqlite"),
  );
  return {
    dataRoot,
    guilds,
    outputPath: resolve(outputPath),
    ...recoveryCredentials(values),
    ...(existsSync(hubDatabasePath) ? { hubDatabasePath } : {}),
    assetsRoot: join(dataRoot, "announcement-assets"),
    ...(existsSync(registryPath) ? { registryPath } : {}),
    ...(values.BACKUP_WEB_DATABASE_PATH
      ? { webDatabasePath: resolve(values.BACKUP_WEB_DATABASE_PATH) }
      : {}),
    release: values.DEPLOYMENT_REVISION || undefined,
  };
}

export async function recoveryCommand(command, options, values = process.env, input) {
  if (command === "restore") {
    if (!options.archive || !options.target)
      throw Error("Specify --archive and a new empty --target.");
    const configuration = recoveryCredentials(values);
    const manifest = await restoreSnapshot({
      archivePath: resolve(options.archive),
      targetRoot: resolve(options.target),
      key: configuration.key,
      forbiddenKeys: configuration.forbiddenKeys,
      maxBytes: configuration.maxBytes,
      maxFiles: configuration.maxFiles,
      dryRun: options.dryRun === true,
    });
    return {
      backupId: manifest.id,
      quarantined: options.dryRun !== true,
      dryRun: options.dryRun === true,
      guilds: manifest.guilds.length,
    };
  }
  if (!options.output) throw Error("Specify --output in a private directory.");
  const configuration = configuredSnapshot(options.output, values);
  if (command === "plan") return planSnapshot(configuration);
  if (command === "snapshot") return createSnapshot(configuration);
  if (command === "compatible")
    return {
      compatible: await snapshotSchemasUnchanged(configuration, JSON.parse(input || "null")),
    };
  throw Error("Expected plan, snapshot, restore or compatible.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2),
      options = {};
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index],
        value = args[index + 1];
      if (flag === "--dry-run" && command === "restore" && !options.dryRun) {
        options.dryRun = true;
        index -= 1;
        continue;
      }
      if (!["--output", "--archive", "--target"].includes(flag) || !value || options[flag.slice(2)])
        throw Error("Invalid recovery options.");
      options[flag.slice(2)] = value;
    }
    const result = await recoveryCommand(
      command,
      options,
      process.env,
      command === "compatible" ? readFileSync(0, "utf8") : undefined,
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
