import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredSnapshot } from "./recovery.mjs";
import {
  recoverRulesDeletionLifecycle,
  snapshotRulesDeletionLifecycle,
  upgradeRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";

function summary(scope) {
  return {
    format: 1,
    state: scope.complete ? "ready" : "blocked",
    journalFormat: 2,
    sourceId: scope.sourceId,
    sequence: scope.sequence,
    coveredFrom: scope.coveredFrom,
    activeGuilds: scope.active.length,
    retiredGuilds: scope.retired.length,
    retainedDecisions: scope.entries.length,
    blockers: scope.blockers,
  };
}

/** Stopped-source operations only; scope always comes from the operator's actual configuration. */
export async function rulesDeletionLifecycleCommand(command, options = {}, values = process.env) {
  if (
    !["status", "upgrade", "recover"].includes(command) ||
    Object.keys(options).some((key) => key !== "apply") ||
    (options.apply !== undefined && options.apply !== true) ||
    (command === "status" && options.apply !== undefined)
  )
    throw Error("Expected status, upgrade --apply or recover --apply.");
  if (command !== "status" && options.apply !== true)
    throw Error("Changing the deletion source requires --apply and a stopped bot.");
  const configured = configuredSnapshot(resolve(".unused-lifecycle-inspection"), values);
  const scope = { dataRoot: configured.dataRoot, installations: configured.guilds };
  if (command === "status") {
    try {
      return summary(await snapshotRulesDeletionLifecycle(scope));
    } catch (error) {
      if (error.code !== "journal_upgrade_required") throw error;
      return { format: 1, state: "upgrade_required", journalFormat: 1 };
    }
  }
  const operation =
    command === "upgrade"
      ? await upgradeRulesDeletionLifecycle(scope)
      : await recoverRulesDeletionLifecycle(scope);
  return {
    ...summary(await snapshotRulesDeletionLifecycle(scope)),
    operation: command,
    ...operation,
  };
}

export function parseRulesDeletionLifecycleArguments(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2)
    throw Error("Expected status, upgrade --apply or recover --apply.");
  const [command, flag] = args;
  if (flag !== undefined && flag !== "--apply")
    throw Error(
      "Only --apply is accepted; configuration and credentials belong in the environment.",
    );
  return { command, options: flag === undefined ? {} : { apply: true } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { command, options } = parseRulesDeletionLifecycleArguments(process.argv.slice(2));
    const result = await rulesDeletionLifecycleCommand(command, options);
    console.log(JSON.stringify(result, null, 2));
    if (["blocked", "upgrade_required"].includes(result.state)) process.exitCode = 2;
  } catch (error) {
    console.error(error.code || "rules_deletion_lifecycle_refused");
    process.exitCode = 1;
  }
}
