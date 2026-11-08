import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, loadCredentials, loadEnvironment } from "./config.js";
import { contentDigest, lintContent, publications, readJson } from "./content.js";
import { Store } from "./storage/store.js";
import { acquireLock } from "./storage/lock.js";
import { desired } from "./bootstrap/desired.js";
import { discordApi, snapshot, type Body } from "./bootstrap/api.js";
import { applyPlan, buildPlan, type Plan } from "./bootstrap/plan.js";
import { auditPermissions } from "./permissions/audit.js";
import { digest, errorCode, requireId, warsawTime } from "./shared/utils.js";
import { selectInstallation, healthPath } from "./installations.js";
import { initializeForumGuides } from "./bootstrap/forum-guides.js";

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function save(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "help") {
    console.log(
      "Commands: validate, check-env, plan [--offline] [--phase core|community|content], apply --file FILE --approve SHA256 [--allow-sensitive] [--allow-drift], forum-guides [--approve SHA256], permissions, status, backup --output FILE, adopt --key KEY --id ID --approve SHA256, resolve-operation --key KEY --approve SHA256, health; use --guild ID with multiple installations",
    );
    return;
  }
  if (command === "health") {
    const path = healthPath();
    const health = JSON.parse(readFileSync(path, "utf8")) as { ready: boolean; updated: number };
    if (!health.ready || Date.now() - health.updated > 60000)
      throw new Error("Bot health is stale or unavailable.");
    console.log("Bot health: ok");
    return;
  }
  const installation = process.env.GUILDS_PATH ? selectInstallation(option("guild")) : undefined;
  if (!installation && option("guild") && option("guild") !== process.env.DISCORD_GUILD_ID)
    throw Error("This guild is not configured.");
  const config = loadConfig(installation?.configPath);
  const errors = lintContent(config);
  if (errors.length) throw new Error(errors.join("\n"));
  if (command === "validate") {
    const messages = publications(config);
    console.log(
      JSON.stringify(
        {
          valid: true,
          roles: config.roles.length,
          categories: config.categories.length,
          channels: config.channels.length,
          messageParts: messages.length,
          contentHash: contentDigest(),
          uploadsEnabled: config.attachments.uploadsEnabled,
        },
        null,
        2,
      ),
    );
    return;
  }
  const phase = option("phase", "core");
  if (!["core", "community", "content"].includes(phase!))
    throw new Error("Phase must be core, community or content.");
  if (command === "plan" && flag("offline")) {
    const draft = {
      offline: true,
      applicable: false,
      phase,
      configHash: digest(config),
      contentHash: contentDigest(),
      requirements: [
        "Real Discord ownership and permissions must be verified before an applicable plan exists.",
        "Owner enables Community, Rules Screening, moderator 2FA and role hierarchy.",
      ],
      resources: desired(
        config,
        {
          guildId: "@{guild.id}",
          clientId: "@{bot.id}",
          ownerId: "@{owner.id}",
          token: "",
          databasePath: "",
        },
        phase as Plan["phase"],
      ),
    };
    const path = resolve(option("output", `reports/deployment-plan.${phase}.offline.json`)!);
    save(path, draft);
    console.log(`Offline draft saved: ${path}`);
    return;
  }
  if (command === "backup") {
    const path =
      installation?.databasePath ?? resolve(process.env.DATABASE_PATH || "data/gildiusz.sqlite");
    if (!existsSync(path)) throw new Error("No database to back up.");
    const output = resolve(option("output") ?? "");
    if (!option("output") || existsSync(output) || output === path)
      throw new Error("Choose a new --output path outside the repository history.");
    const store = new Store(path);
    try {
      await store.backup(output);
      save(`${output}.manifest.json`, {
        created: new Date().toISOString(),
        configHash: digest(config),
        contentHash: contentDigest(),
        schema: Number(
          (store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        ),
        timezone: "Europe/Warsaw",
      });
      console.log(`Backup saved: ${output}`);
    } finally {
      store.close();
    }
    return;
  }
  const environment = installation ? { ...loadCredentials(), ...installation } : loadEnvironment();
  const api = discordApi(environment);
  if (command === "check-env") {
    const state = await snapshot(api, environment);
    console.log(
      JSON.stringify(
        {
          guildId: state.guild.id,
          ownerMatches: true,
          botId: state.botId,
          community: (state.guild.features as string[]).includes("COMMUNITY"),
        },
        null,
        2,
      ),
    );
    return;
  }
  const mutations =
    ["apply", "adopt", "resolve-operation"].includes(command) ||
    (command === "forum-guides" && Boolean(option("approve")));
  const release = mutations ? await acquireLock(environment.databasePath) : null;
  const store = new Store(environment.databasePath, environment.guildId);
  try {
    const state = await snapshot(api, environment);
    if (command === "plan") {
      const plan = await buildPlan(api, state, store, config, environment, phase as Plan["phase"]);
      const output = resolve(option("output", "reports/deployment-plan.json")!);
      save(output, plan);
      console.log(
        JSON.stringify(
          {
            file: output,
            approve: plan.hash,
            expires: warsawTime(plan.expires),
            changes: plan.changes.map(({ item, action, drift }) => ({
              key: item.key,
              action,
              drift,
            })),
            conflicts: plan.conflicts,
            notes: plan.notes,
          },
          null,
          2,
        ),
      );
      if (plan.conflicts.length) process.exitCode = 1;
    } else if (command === "apply") {
      const file = option("file"),
        approval = option("approve");
      if (!file || !approval)
        throw new Error("Provide --file and --approve from the reviewed plan.");
      const plan = JSON.parse(readFileSync(file, "utf8")) as Plan;
      await applyPlan(plan, approval, state, store, config, environment, api, {
        allowSensitive: flag("allow-sensitive"),
        allowDrift: flag("allow-drift"),
      });
      console.log(
        "Approved changes applied. Generate a fresh plan to verify idempotence and inspect manual steps.",
      );
    } else if (command === "forum-guides") {
      console.log(
        JSON.stringify(
          await initializeForumGuides(api, state, store, environment, option("approve")),
          null,
          2,
        ),
      );
    } else if (command === "permissions") {
      const report = auditPermissions(state, store, config);
      save(resolve(option("output", "reports/permissions.json")!), report);
      console.log(
        JSON.stringify({ failures: report.failures, warnings: report.warnings }, null, 2),
      );
      if (report.failures.length) process.exitCode = 1;
    } else if (command === "status") {
      console.log(
        JSON.stringify(
          {
            guildId: state.guild.id,
            features: state.guild.features,
            resources: store.resources().map(({ key, id }) => ({ key, id })),
            rooms: store.rooms().map(({ id, locked }) => ({ id, locked })),
            unfinished: store.operations(),
            rules: readJson<string[]>("rules.json").length,
            uploadsEnabled: config.attachments.uploadsEnabled,
            runtimeSettings: store.settings(environment.guildId) ?? null,
            timezone: "Europe/Warsaw",
          },
          null,
          2,
        ),
      );
    } else if (command === "adopt") {
      const key = option("key"),
        id = requireId(option("id"), "id");
      const expected = desired(config, environment, "community").find((item) => item.key === key);
      if (
        !key ||
        !expected ||
        !["role", "channel", "automod", "command"].includes(expected.kind) ||
        key === "role.everyone"
      )
        throw new Error("Only known, unmanaged configuration resources can be explicitly adopted.");
      if (store.resource(key) || store.resources().some((resource) => resource.id === id))
        throw new Error("The resource or stable key is already managed.");
      const candidate = (
        expected.kind === "role"
          ? state.roles
          : expected.kind === "channel"
            ? state.channels
            : expected.kind === "automod"
              ? state.automod
              : state.commands
      ).find((entry) => entry.id === id);
      if (!candidate || (expected.kind === "channel" && candidate.type !== expected.body.type))
        throw new Error("Resource is absent or has a different type.");
      const approval = digest({ guild: environment.guildId, key, id, current: candidate });
      if (option("approve") !== approval) {
        console.log(
          JSON.stringify({ adoption: { key, id, current: candidate }, approve: approval }, null, 2),
        );
        return;
      }
      store.putResource(key, expected.kind, id, {});
      console.log("Resource adopted. Generate and review a new plan before editing it.");
    } else if (command === "resolve-operation") {
      const key = option("key"),
        operation = store.operations().find((entry) => (entry as Body).key === key);
      if (!key || !operation) throw new Error("Unknown unfinished operation.");
      const approval = digest({ guild: environment.guildId, operation });
      if (option("approve") !== approval) {
        console.log(
          JSON.stringify(
            {
              operation,
              approve: approval,
              instruction:
                "Inspect Discord audit first. Adopt the resulting configuration resource or remove the exact verified orphan manually, then approve clearing this journal entry.",
            },
            null,
            2,
          ),
        );
        return;
      }
      store.endOperation(key);
      console.log("Operation journal entry cleared after explicit reconciliation.");
    } else throw new Error("Unknown command. Run cli help.");
  } finally {
    store.close();
    await release?.();
  }
}

main().catch((error) => {
  const token = process.env.DISCORD_TOKEN;
  const message = error instanceof Error ? error.message : errorCode(error);
  console.error(token ? message.replaceAll(token, "[redacted]") : message);
  process.exitCode = 1;
});
