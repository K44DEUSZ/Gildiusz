import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { SerialQueue } from "../dist/shared/utils.js";
import { regularFile } from "../dist/storage/recovery/files.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import { acquireLock } from "../dist/storage/lock.js";
import { PublicInstallations } from "../dist/control/installations.js";
import { GuildRegistry } from "../dist/bot/guild-registry.js";
import { GuildActivity } from "../dist/bot/guild-activity.js";
import { ControlError, parseControlPath } from "../dist/control/contracts.js";
import { loadInstallations } from "../dist/installations.js";
import { initializeRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import {
  openRulesDeletionLifecycle,
  rulesDeletionInstallationKey,
} from "../dist/storage/rules-deletion-lifecycle.js";
import {
  recordRulesDeletion,
  rulesDeletionState,
} from "../dist/modules/server-rules/deletion-outbox.js";
import {
  GuildUninstallRetention,
  recordGuildMembership,
  guildUninstallRetentionMs,
  unverifiedRulesDeletionGapFile,
} from "../dist/storage/uninstall-retention.js";

const A = "900000000000000001",
  B = "900000000000000002",
  C = "900000000000000003",
  D = "900000000000000004",
  owner = "900000000000000005",
  day = 86400000;
const code = (value) => (error) => error.code === value;
const source = ts.createSourceFile(
    "main.ts",
    readFileSync(new URL("../src/bot/main.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  ),
  declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(source);
const names = [
  "rulesSourceError",
  "sourceExists",
  "rulesJournalMode",
  "canonicalRulesInstallations",
  "rulesLifecycle",
  "assertLegacyRulesDatabase",
  "beforeStoreOpen",
  "deferPublicRulesReservation",
  "assertRulesInstallationReady",
  "rulesPurgeBridge",
  "repairRulesSources",
  "finishCommittedUninstalls",
  "presentInstallation",
  "openStore",
  "controlRequest",
];
function instantiate(bindings) {
  const functions = names
    .map((name) => {
      assert.ok(declarations.has(name), name);
      return declarations.get(name).getText(source);
    })
    .join("\n");
  const js = ts.transpileModule(functions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(
    ...Object.keys(bindings),
    `let deletionLifecycle,stopping=false,connected=false,initializing=false;${js};return{${names.join(",")},useRetention(value){uninstallRetention=value}}`,
  )(...Object.values(bindings));
}
async function fixture(t, { publicOnly = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-main-deletion-")),
    dataRoot = join(directory, "data");
  mkdirSync(dataRoot, { mode: 0o700 });
  const publicDirectory = join(dataRoot, "public-guilds"),
    publicInstallations = new PublicInstallations(publicDirectory),
    values = { PUBLIC_INSTALLS: "1" },
    configFile = join(directory, "guilds.json");
  const installations = [A, B].map((guildId) =>
    publicOnly
      ? publicInstallations.add(guildId, owner)
      : {
          guildId,
          ownerId: owner,
          configPath: join(directory, "config.json"),
          databasePath: join(dataRoot, "guilds", guildId, "gildiusz.sqlite"),
        },
  );
  writeFileSync(join(directory, "config.json"), "{}", { mode: 0o600 });
  if (!publicOnly) {
    writeFileSync(configFile, JSON.stringify(installations), { mode: 0o600 });
    values.GUILDS_PATH = configFile;
  }
  const stores = new Map(
    installations.map((i) => [i.guildId, new Store(i.databasePath, i.guildId)]),
  );
  for (const i of installations) {
    chmodSync(dirname(dirname(i.databasePath)), 0o700);
    chmodSync(dirname(i.databasePath), 0o700);
  }
  await initializeRulesDeletionJournal({ dataRoot, installations });
  const releaseRoot = await acquireDataRootLease(dataRoot),
    guildReleases = new Map(),
    guildLeasePaths = new Map();
  for (const i of installations) {
    guildReleases.set(i.guildId, await acquireLock(i.databasePath, { createTarget: false }));
    guildLeasePaths.set(i.guildId, resolve(i.databasePath));
  }
  const registry = new GuildRegistry(installations),
    activity = new GuildActivity(),
    tracked = [],
    epochs = new Map(),
    effects = [];
  const bindings = {
    dataRoot,
    publicDirectory,
    publicInstallations,
    process: { env: values },
    loadInstallations: () => loadInstallations(values),
    existsSync,
    lstatSync,
    readFileSync,
    regularFile,
    join,
    resolve,
    randomUUID,
    openRulesDeletionLifecycle,
    rulesDeletionInstallationKey,
    DatabaseSync,
    ownsDataRoot: true,
    guildReleases,
    guildLeasePaths,
    stores,
    openingStores: new Map(),
    deletionQueue: new SerialQueue(),
    controlTasks: new Set(),
    purgingGuilds: new Set(),
    uninstalled: new Set(),
    legacy: [...installations],
    loadConfig: () => ({}),
    recordGuildMembership,
    jobRunner: { resumeGuild() {} },
    uninstallRetention: undefined,
    Store,
    JobStore,
    acquireLock,
    installations,
    configs: new Map(),
    changing: new Set(),
    registry,
    client: {},
    track(task, guildId) {
      tracked.push(task);
      if (guildId) activity.track(guildId, task);
      return task;
    },
    withClosedGuild: async (guildId, work) => {
      await Promise.resolve();
      if (!(await activity.drain(guildId, 20))) return;
      return f.ports.withClosedGuild(guildId, work);
    },
    ControlError,
    parseControlPath,
    epoch: (gid) => epochs.get(gid) ?? 0,
    bumpEpoch: (gid) => epochs.set(gid, (epochs.get(gid) ?? 0) + 1),
    lookup: (gid) => registry.get(gid),
    publicConfig: () => ({}),
    authorizeControl: async () => ({ actor: owner, guild: { ownerId: owner } }),
    snapshot: async (runtime) => ({ guildId: runtime.guildId }),
    createRuntime: async (installation) => {
      const j = JSON.parse(readFileSync(join(dataRoot, "rules-acceptance-deletions/journal.json")));
      assert.ok(j.active.some((row) => row.guildId === installation.guildId));
      assert.ok(stores.get(installation.guildId).resource("retention.rules-deletion-installation"));
      effects.push(installation.guildId);
      return { guildId: installation.guildId };
    },
  };
  const runtime = instantiate(bindings),
    f = {
      directory,
      dataRoot,
      configFile,
      values,
      installations,
      stores,
      guildReleases,
      guildLeasePaths,
      publicInstallations,
      runtime,
      bindings,
      effects,
      tracked,
      now: Date.now(),
    };
  f.journal = () =>
    JSON.parse(readFileSync(join(dataRoot, "rules-acceptance-deletions/journal.json")));
  f.upgrade = () => runtime.rulesLifecycle().upgradeFormat1({ checkFence: () => true });
  f.close = (gid) => {
    stores.get(gid)?.close();
    stores.delete(gid);
  };
  f.retention = (extra) => {
    const retention = new GuildUninstallRetention({
      dataRoot,
      registry: publicInstallations,
      hub: () => null,
      clock: () => f.now,
      rulesDeletion: {
        prepareRetirement: (i) => runtime.rulesPurgeBridge(i, false),
        confirmRetired: (i) => runtime.rulesPurgeBridge(i, true),
      },
      ...extra,
    });
    runtime.useRetention(retention);
    return retention;
  };
  f.ports = {
    freshProof: async () => ({ state: "absent", observedAt: f.now, source: "discord-rest" }),
    checkFence: () => true,
    withClosedGuild: async (gid, work) => {
      f.close(gid);
      return work();
    },
  };
  f.due = () => {
    f.now = Date.now();
    return recordGuildMembership(
      stores.get(A),
      A,
      { state: "absent", observedAt: f.now - guildUninstallRetentionMs, source: "discord-rest" },
      f.now - guildUninstallRetentionMs,
    );
  };
  t.after(async () => {
    for (const store of stores.values()) {
      try {
        store.close();
      } catch {
        /* A test may already close it. */
      }
    }
    for (const release of guildReleases.values()) await release();
    await releaseRoot();
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}

test("main canonical inventory follows configuration and durable registry, never the current Stores or HTTP list", async (t) => {
  const f = await fixture(t);
  await f.upgrade();
  f.stores.set(D, { db: {} });
  assert.deepEqual(
    f.runtime.canonicalRulesInstallations().map((i) => i.guildId),
    [A, B],
  );
  f.stores.delete(D);
  f.publicInstallations.add(C, owner);
  assert.deepEqual(
    f.runtime.canonicalRulesInstallations().map((i) => i.guildId),
    [A, B, C],
  );
  writeFileSync(f.configFile, JSON.stringify([f.installations[0]]));
  assert.deepEqual(
    f.runtime.canonicalRulesInstallations().map((i) => i.guildId),
    [A, C],
  );
  assert.equal((await f.runtime.rulesLifecycle().snapshot()).complete, false);
});
test("main pre-open guard cannot recreate missing historical DBs or open a journal2 source after its journal disappeared", async (t) => {
  const f = await fixture(t),
    missing = { guildId: D, databasePath: join(f.dataRoot, "guilds", D, "gildiusz.sqlite") };
  await assert.rejects(f.runtime.openStore(missing));
  assert.equal(existsSync(missing.databasePath), false);
  await f.upgrade();
  f.close(A);
  unlinkSync(f.installations[0].databasePath);
  await assert.rejects(f.runtime.openStore(f.installations[0]), code("installation_file_missing"));
  assert.equal(existsSync(f.installations[0].databasePath), false);
  unlinkSync(join(f.dataRoot, "rules-acceptance-deletions/journal.json"));
  await assert.rejects(
    f.runtime.beforeStoreOpen(f.installations[1], false),
    code("source_unavailable"),
  );
  await assert.rejects(
    f.runtime.assertRulesInstallationReady(f.installations[1]),
    code("source_unavailable"),
  );
  unlinkSync(join(f.dataRoot, "uninstall-retention/source-policy.json"));
  await assert.rejects(
    f.runtime.beforeStoreOpen(f.installations[1], false),
    code("source_unavailable"),
  );
  await assert.rejects(
    f.runtime.assertRulesInstallationReady(f.installations[1]),
    code("source_unavailable"),
  );
});
test("main repairs every active ACK before the active-ready check after a durable-journal crash", async (t) => {
  const f = await fixture(t);
  await f.upgrade();
  const db = f.stores.get(A).db,
    now = Date.now();
  new JobStore(db).transaction(() => recordRulesDeletion(db, A, randomUUID(), now, now + 35 * day));
  await assert.rejects(
    f.runtime.rulesLifecycle().drainActiveOutbox({
      stores: [...f.stores].map(([guildId, s]) => ({ guildId, jobs: new JobStore(s.db) })),
      checkpoint() {
        throw Error("crash");
      },
    }),
    /crash/,
  );
  await assert.rejects(
    f.runtime.assertRulesInstallationReady(f.installations[0]),
    code("source_gap"),
  );
  const repaired = await f.runtime.repairRulesSources([...f.stores]);
  assert.equal(repaired.complete, true);
  assert.equal(rulesDeletionState(db, A).journaledThrough, 1);
  await f.runtime.assertRulesInstallationReady(f.installations[0]);
});

test("truly legacy missing-source mode permits only known existing data and never initializes a journal", async (t) => {
  const f = await fixture(t),
    journal = join(f.dataRoot, "rules-acceptance-deletions/journal.json");
  unlinkSync(journal);
  assert.equal(f.runtime.rulesJournalMode(), "legacy");
  await f.runtime.beforeStoreOpen(f.installations[0], false);
  await f.runtime.assertRulesInstallationReady(f.installations[0]);
  await assert.rejects(
    f.runtime.beforeStoreOpen(
      { guildId: D, databasePath: join(f.dataRoot, "missing.sqlite") },
      false,
    ),
  );
  await assert.rejects(f.runtime.controlRequest(`/guilds/${C}`, {}), code("source_not_ready"));
  assert.equal(existsSync(journal), false);
  assert.deepEqual(f.effects, []);
});
test("public setup requires journal2 and durable pristine admission before its first runtime effect", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.controlRequest(`/guilds/${C}`, {}), code("source_not_ready"));
  assert.equal(f.publicInstallations.values().length, 0);
  assert.equal(f.effects.length, 0);
  await f.upgrade();
  const results = await Promise.allSettled([
    f.runtime.controlRequest(`/guilds/${C}`, {}),
    f.runtime.controlRequest(`/guilds/${C}`, {}),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual(f.effects, [C]);
  await f.runtime.controlRequest(`/guilds/${C}`, {});
  assert.deepEqual(f.effects, [C]);
  assert.equal(f.journal().active.filter((row) => row.guildId === C).length, 1);
});

test("registry-only or empty-DB reservation crash waits for fresh authorization without blocking existing runtimes", async (t) => {
  for (const emptyDatabase of [false, true]) {
    const f = await fixture(t);
    await f.upgrade();
    const reserved = f.publicInstallations.add(C, owner);
    if (emptyDatabase) new Store(reserved.databasePath, C).close();
    f.installations.push(reserved);
    f.bindings.registry.register(reserved);
    assert.equal(await f.runtime.deferPublicRulesReservation(reserved), true);
    assert.equal(
      f.installations.some((entry) => entry.guildId === C),
      false,
    );
    assert.equal(f.stores.has(C), false);
    assert.equal(
      f.publicInstallations.values().some((entry) => entry.guildId === C),
      true,
    );
    assert.equal((await f.runtime.repairRulesSources([...f.stores])).complete, false);
    await f.runtime.assertRulesInstallationReady(f.installations[0]);
    assert.deepEqual(f.effects, []);
    await f.runtime.controlRequest(`/guilds/${C}`, {});
    assert.deepEqual(f.effects, [C]);
    assert.equal(f.journal().active.filter((row) => row.guildId === C).length, 1);
  }
});

test("an untracked nonempty public database cannot be adopted by reservation replay", async (t) => {
  const f = await fixture(t);
  await f.upgrade();
  const reserved = f.publicInstallations.add(C, owner),
    old = new Store(reserved.databasePath, C);
  old.db
    .prepare("INSERT INTO events VALUES(?,0,'fixture','member','old',NULL,NULL)")
    .run(randomUUID());
  old.close();
  f.installations.push(reserved);
  assert.equal(await f.runtime.deferPublicRulesReservation(reserved), true);
  await assert.rejects(f.runtime.controlRequest(`/guilds/${C}`, {}), code("not_pristine"));
  assert.deepEqual(f.effects, []);
  assert.equal(
    f.journal().active.some((row) => row.guildId === C),
    false,
  );
});
test("a revoked public admission fence leaves a recoverable intent and never reaches runtime effects", async (t) => {
  const f = await fixture(t);
  await f.upgrade();
  const port = f.runtime.rulesLifecycle(),
    admit = port.admitPristine.bind(port);
  let revoked = false;
  port.admitPristine = (options) =>
    admit({
      ...options,
      checkpoint(stage) {
        if (stage === "db_seeded" && !revoked) {
          revoked = true;
          f.bindings.bumpEpoch(C);
        }
      },
    });
  await assert.rejects(f.runtime.controlRequest(`/guilds/${C}`, {}), code("operation_obsolete"));
  const epoch = f.journal().admitting[0].epoch;
  assert.deepEqual(f.effects, []);
  await f.runtime.controlRequest(`/guilds/${C}`, {});
  assert.deepEqual(f.effects, [C]);
  assert.equal(f.journal().active.find((r) => r.guildId === C).epoch, epoch);
});
test("committed purge bridges its exact epoch before unlink and recovers the same retirement after a crash", async (t) => {
  const f = await fixture(t, { publicOnly: true });
  await f.upgrade();
  f.due();
  let once = true;
  let retention = f.retention({
    onStage(stage) {
      if (stage === "hub_done" && once) {
        once = false;
        assert.equal(f.journal().retiring[0].guildId, A);
        assert.equal(existsSync(f.installations[0].databasePath), true);
        throw Error("crash");
      }
    },
  });
  const old = f.journal().active.find((r) => r.guildId === A).epoch;
  assert.equal(
    (await retention.purge(f.installations[0], f.stores.get(A), f.ports)).state,
    "pending",
  );
  await assert.rejects(f.runtime.beforeStoreOpen(f.installations[0], true));
  retention = f.retention();
  assert.equal((await retention.purge(f.installations[0], undefined, f.ports)).state, "purged");
  assert.equal(existsSync(f.installations[0].databasePath), false);
  assert.equal(f.journal().retired[0].lastEpoch, old);
  assert.equal(retention.status(A), null);
  assert.equal((await f.runtime.rulesLifecycle().snapshot()).complete, true);
});

test("startup committed housekeeping is globally tracked and cannot deadlock on its own guild drain", async (t) => {
  const f = await fixture(t, { publicOnly: true });
  await f.upgrade();
  f.due();
  const paused = f.retention({
    onStage(stage) {
      if (stage === "committed") throw Error("crash");
    },
  });
  assert.equal((await paused.purge(f.installations[0], f.stores.get(A), f.ports)).state, "pending");
  f.retention();
  await f.runtime.finishCommittedUninstalls();
  assert.equal(f.tracked.length, 1);
  assert.equal(existsSync(join(f.dataRoot, "public-guilds", A, "gildiusz.sqlite")), false);
  assert.equal(f.journal().retired[0].guildId, A);
  assert.equal((await f.runtime.rulesLifecycle().snapshot()).complete, true);
});
test("source outage cannot retain 30-day data; restart keeps first purge time and hard35 drops terminal IDs behind a global blocker", async (t) => {
  const f = await fixture(t, { publicOnly: true });
  await f.upgrade();
  f.due();
  const outage = {
    prepareRetirement: async () => {
      throw Error("source outage");
    },
    confirmRetired: async () => {
      throw Error("source outage");
    },
  };
  let retention = f.retention({ rulesDeletion: outage });
  const result = await retention.purge(f.installations[0], f.stores.get(A), f.ports);
  assert.equal(result.state, "pending");
  assert.equal(result.phase, "registry_done");
  assert.equal(existsSync(f.installations[0].databasePath), false);
  const first = retention.deletionLedger(A).purgedAt,
    markerPath = join(f.dataRoot, "uninstall-retention", unverifiedRulesDeletionGapFile),
    marker = JSON.parse(readFileSync(markerPath));
  assert.equal(JSON.stringify(marker).includes(A), false);
  assert.equal(marker.reason, "lifecycle_unavailable");
  f.now += day;
  retention = f.retention({ rulesDeletion: outage });
  await retention.purge(f.installations[0], undefined, f.ports);
  assert.equal(retention.deletionLedger(A).purgedAt, first);
  f.now = first + 35 * day - 1;
  const ownTemp = join(f.dataRoot, "uninstall-retention", `${A}.pending.json.${randomUUID()}.tmp`),
    unknownTemp = join(f.dataRoot, "uninstall-retention", "operator-note.tmp");
  writeFileSync(ownTemp, "unpromoted writer fixture", { mode: 0o600 });
  writeFileSync(unknownTemp, "operator data", { mode: 0o600 });
  assert.equal(retention.pruneTerminalMetadata().removed, 0);
  assert.equal(existsSync(ownTemp), false);
  assert.equal(readFileSync(unknownTemp, "utf8"), "operator data");
  f.now++;
  assert.equal(retention.pruneTerminalMetadata().removed, 1);
  assert.equal(retention.status(A), null);
  assert.equal(retention.deletionLedger(A), null);
  assert.equal(existsSync(markerPath), true);
  await assert.rejects(
    f.runtime.assertRulesInstallationReady(f.installations[1]),
    code("unverified_retention_gap"),
  );
});
test("a failed durable fallback marker leaves a committed wipe explicitly pending before unlink", async (t) => {
  const f = await fixture(t, { publicOnly: true });
  await f.upgrade();
  f.due();
  mkdirSync(join(f.dataRoot, "uninstall-retention"), { mode: 0o700, recursive: true });
  writeFileSync(
    join(f.dataRoot, "uninstall-retention", unverifiedRulesDeletionGapFile),
    "invalid",
    { mode: 0o600 },
  );
  const retention = f.retention({
    rulesDeletion: {
      prepareRetirement: async () => {
        throw Error("outage");
      },
      confirmRetired: async () => {
        throw Error("outage");
      },
    },
  });
  const result = await retention.purge(f.installations[0], f.stores.get(A), f.ports);
  assert.equal(result.state, "pending");
  assert.equal(result.phase, "committed");
  assert.equal(existsSync(f.installations[0].databasePath), true);
});

test("failed legacy return after a wipe cannot poison the in-memory row before fresh enrollment", async (t) => {
  const f = await fixture(t);
  await f.upgrade();
  f.due();
  const installation = f.installations[0],
    retention = f.retention();
  assert.equal((await retention.purge(installation, f.stores.get(A), f.ports)).state, "purged");
  f.installations.splice(
    f.installations.findIndex((row) => row.guildId === A),
    1,
  );
  f.bindings.configs.delete(A);
  await assert.rejects(f.runtime.presentInstallation(A));
  assert.equal(
    f.installations.some((row) => row.guildId === A),
    false,
  );
  assert.equal(f.bindings.configs.has(A), false);
  assert.equal(existsSync(installation.databasePath), false);
});

test("terminal metadata hard35 survives removal of a legacy custom parent without inspecting its current DB path", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-custom-terminal-")),
    dataRoot = join(directory, "data"),
    custom = join(directory, "old-custom");
  mkdirSync(dataRoot, { mode: 0o700 });
  mkdirSync(custom, { mode: 0o700 });
  const installation = { guildId: A, databasePath: join(custom, "gildiusz.sqlite") },
    definitions = join(directory, "guilds.json");
  writeFileSync(definitions, JSON.stringify([installation]), { mode: 0o600 });
  const store = new Store(installation.databasePath, A),
    rootRelease = await acquireDataRootLease(dataRoot),
    guildRelease = await acquireLock(store.path, { createTarget: false });
  let now = Date.now(),
    closed = false;
  t.after(async () => {
    if (!closed) store.close();
    await guildRelease();
    await rootRelease();
    rmSync(directory, { recursive: true, force: true });
  });
  recordGuildMembership(
    store,
    A,
    { state: "absent", observedAt: now, source: "discord-rest" },
    now,
  );
  now += guildUninstallRetentionMs;
  const outage = {
      prepareRetirement: async () => {
        throw Error("source unavailable");
      },
      confirmRetired: async () => {
        throw Error("source unavailable");
      },
    },
    retention = new GuildUninstallRetention({
      dataRoot,
      databaseRoots: [custom],
      hub: () => null,
      clock: () => now,
      rulesDeletion: outage,
    });
  const result = await retention.purge(installation, store, {
    freshProof: async () => ({ state: "absent", observedAt: now, source: "discord-rest" }),
    checkFence: () => true,
    withClosedGuild: async (_gid, work) => {
      store.close();
      closed = true;
      return work();
    },
  });
  assert.equal(result.phase, "registry_done");
  assert.equal(existsSync(installation.databasePath), false);
  const first = retention.deletionLedger(A).purgedAt;
  unlinkSync(definitions);
  writeFileSync(installation.databasePath, "unrelated current external file", { mode: 0o600 });
  const restarted = new GuildUninstallRetention({ dataRoot, hub: () => null, clock: () => now });
  assert.throws(() => restarted.status(A), /Unsafe uninstall database scope/);
  now = first + 35 * day - 1;
  assert.equal(restarted.pruneTerminalMetadata().removed, 0);
  now++;
  assert.equal(restarted.pruneTerminalMetadata().removed, 1);
  assert.equal(readFileSync(installation.databasePath, "utf8"), "unrelated current external file");
  assert.equal(restarted.status(A), null);
  assert.equal(restarted.deletionLedger(A), null);
  const blocker = readFileSync(
    join(dataRoot, "uninstall-retention", unverifiedRulesDeletionGapFile),
    "utf8",
  );
  assert.equal(blocker.includes(A), false);
  assert.equal(blocker.includes(custom), false);
});
