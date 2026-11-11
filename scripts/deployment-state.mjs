import { existsSync, readdirSync, lstatSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { configuredSnapshot } from "./recovery.mjs";
import { regularFile } from "../dist/storage/recovery/files.js";
import {
  assertRestoreStartupAllowed,
  assertSourcePreparationComplete,
} from "../dist/storage/recovery/lease.js";
import { currentRecoverySchemaPolicy, schemaOf } from "../dist/storage/recovery/schema.js";
import {
  readRulesDeletionLifecycleJournal,
  snapshotRulesDeletionLifecycle,
} from "../dist/storage/rules-deletion-lifecycle.js";
import {
  pendingRulesDeletions,
  rulesDeletionState,
} from "../dist/modules/server-rules/deletion-outbox.js";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const schema = ({ userVersion, migrations, objects }) => ({ userVersion, migrations, objects });

/** Optimistic live observation; activation repeats it with the writer stopped and leased. */
export async function inspectDeploymentState(
  { quiescent = false, policy = currentRecoverySchemaPolicy() } = {},
  values = process.env,
) {
  const configured = configuredSnapshot(".unused-deployment-inspection", values),
    { dataRoot, guilds, hubDatabasePath } = configured;
  assertRestoreStartupAllowed(dataRoot);
  assertSourcePreparationComplete(dataRoot);
  for (const name of ["source-gap.json", "source-gap-unverified.json"])
    if (existsSync(join(dataRoot, "uninstall-retention", name)))
      throw Error("Deletion source has an unresolved retention gap.");
  if (
    readdirSync(join(dataRoot, "rules-acceptance-deletions")).some(
      (name) => name !== "journal.json",
    )
  )
    throw Error("Deletion journal has pending operator work.");
  const journal = readRulesDeletionLifecycleJournal(dataRoot),
    now = Date.now();
  if (
    journal.globalGap ||
    journal.admitting.length ||
    journal.retiring.length ||
    journal.updatedAt > now ||
    journal.retired.some((row) => row.expiresAt <= now)
  )
    throw Error("Deletion source is blocked or requires maintenance.");
  const inventory = guilds
    .map(({ guildId, databasePath }) => ({
      guildId,
      path: relative(dataRoot, databasePath).replaceAll("\\", "/"),
    }))
    .sort((a, b) => a.guildId.localeCompare(b.guildId));
  if (
    !inventory.length ||
    !equal(
      inventory,
      journal.active
        .map(({ guildId, path }) => ({ guildId, path }))
        .sort((a, b) => a.guildId.localeCompare(b.guildId)),
    )
  )
    throw Error("Deployment inventory differs from the deletion source.");
  function inspect(path, kind, guildId) {
    regularFile(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const actual = schemaOf(db, kind);
      if (!equal(actual, schema(policy[kind])))
        throw Error("Automatic deployment cannot migrate or downgrade a database.");
      if (guildId) {
        const active = journal.active.find((row) => row.guildId === guildId),
          state = rulesDeletionState(db, guildId),
          marker = db
            .prepare("SELECT kind,id,baseline FROM resources WHERE key=?")
            .get("retention.rules-deletion-installation"),
          baseline = marker && JSON.parse(String(marker.baseline)),
          stat = lstatSync(path, { bigint: true });
        if (
          db.prepare("SELECT guild FROM guild_identity WHERE singleton=1").get()?.guild !==
            guildId ||
          marker?.kind !== "retention" ||
          String(stat.dev) !== active.fileIdentity.dev ||
          String(stat.ino) !== active.fileIdentity.ino ||
          marker.id !== active.epoch ||
          baseline?.format !== 1 ||
          baseline?.admittedAt !== active.admittedAt ||
          baseline?.baseSequence > active.through ||
          baseline?.sourceId !== journal.sourceId ||
          state.gapAt !== null ||
          state.sequence !== active.through ||
          state.journaledThrough !== active.through ||
          pendingRulesDeletions(db, guildId, 1).length
        )
          throw Error("Deletion source is incomplete or its installation changed.");
      }
      return actual;
    } finally {
      db.close();
    }
  }
  const databases = guilds
    .map(({ guildId, databasePath }) => ({
      guildId,
      databasePath,
      schema: inspect(databasePath, "guild", guildId),
    }))
    .sort((a, b) => a.guildId.localeCompare(b.guildId));
  const hub = hubDatabasePath
    ? { databasePath: hubDatabasePath, schema: inspect(hubDatabasePath, "hub") }
    : null;
  if (quiescent) {
    const proof = await snapshotRulesDeletionLifecycle({ dataRoot, installations: guilds });
    if (!proof.complete || proof.sourceId !== journal.sourceId)
      throw Error("Quiescent deletion source verification failed.");
  }
  if (!equal(journal, readRulesDeletionLifecycleJournal(dataRoot)))
    throw Error("Deletion source changed during inspection; retry after maintenance.");
  return {
    format: 1,
    policy: { guild: schema(policy.guild), hub: schema(policy.hub) },
    databases,
    hub,
    source: {
      sourceId: journal.sourceId,
      sequence: journal.sequence,
      updatedAt: journal.updatedAt,
      active: journal.active.map(({ guildId, path, epoch }) => ({ guildId, path, epoch })),
      retired: journal.retired,
    },
  };
}

export function assertSameDeploymentState(previous, next) {
  if (
    !equal(previous.policy, next.policy) ||
    !equal(previous.databases, next.databases) ||
    !equal(previous.hub, next.hub) ||
    previous.source.sourceId !== next.source.sourceId ||
    next.source.sequence < previous.source.sequence ||
    !equal(previous.source.active, next.source.active) ||
    !equal(previous.source.retired, next.source.retired)
  )
    throw Error(
      "Deployment schema, inventory or deletion source changed; operator review required.",
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 4 || !["live", "quiescent"].includes(mode))
      throw Error("Expected live or quiescent deployment inspection.");
    const supported = await import(
      pathToFileURL(join(resolve(process.argv[3]), "dist/storage/recovery/schema.js")).href
    );
    console.log(
      JSON.stringify(
        await inspectDeploymentState({
          quiescent: mode === "quiescent",
          policy: supported.currentRecoverySchemaPolicy(),
        }),
      ),
    );
  } catch {
    console.error("Deployment data inspection failed; no migration or backup was performed.");
    process.exitCode = 1;
  }
}
