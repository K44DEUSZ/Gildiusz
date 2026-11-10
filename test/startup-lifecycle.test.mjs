import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { setImmediate } from "node:timers";
import ts from "typescript";

const source = ts.createSourceFile(
  "main.ts",
  readFileSync(new URL("../src/bot/main.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(source);
function instantiate(names, bindings) {
  const functions = names
    .map((name) => {
      const node = declarations.get(name);
      assert.ok(node, `Missing main lifecycle function ${name}`);
      return ts.transpileModule(node.getText(source), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
    })
    .join("\n");
  // Exercise the current main functions with controlled ports; never import its executable entrypoint.
  const factory = new Function(
    ...Object.keys(bindings),
    `let stopping=false,connected=true,uninstallCursor=0,shutdown;${functions};return{${names.join(",")},markStopping(){stopping=true}}`,
  );
  return factory(...Object.values(bindings));
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const guildId = "900000000000000001";
const installation = {
  guildId,
  ownerId: "900000000000000003",
  databasePath: "/private/guild.sqlite",
  configPath: "/private/operator-config.json",
};
function storeBindings(acquireLock, Store) {
  return {
    stores: new Map(),
    openingStores: new Map(),
    guildReleases: new Map(),
    acquireLock,
    Store,
  };
}

test("a stopped startup releases a late-acquired lease without constructing or registering a Store", async () => {
  const lease = deferred();
  let writes = 0,
    released = 0;
  const bindings = storeBindings(
      () => lease.promise,
      class {
        constructor() {
          writes++;
        }
      },
    ),
    runtime = instantiate(["openStore"], bindings);
  const opening = runtime.openStore(installation),
    rejected = assert.rejects(opening, (error) => error.code === "stopping");
  runtime.markStopping();
  lease.resolve(async () => {
    released++;
  });
  await rejected;
  assert.equal(writes, 0);
  assert.equal(released, 1);
  assert.equal(bindings.stores.size, 0);
  assert.equal(bindings.openingStores.size, 0);
  assert.equal(bindings.guildReleases.size, 0);
});

test("actual shutdown waits for pending Store opens before releasing the data-root lease", async () => {
  const lease = deferred(),
    events = [];
  let writes = 0,
    finished = false;
  const bindings = {
    ...storeBindings(
      () => lease.promise,
      class {
        constructor() {
          writes++;
        }
      },
    ),
    timer: undefined,
    controlServer: undefined,
    twitch: undefined,
    twitchIngress: undefined,
    integrationDatabase: undefined,
    registry: { values: () => [] },
    client: {
      removeAllListeners() {},
      destroy: async () => {
        events.push("destroy");
      },
    },
    Events: new Proxy({}, { get: (_target, name) => name }),
    health() {},
    jobRunner: { stop: async () => {} },
    inFlight: new Set(),
    controlTasks: new Set(),
    releases: [
      async () => {
        events.push("data_root_released");
      },
    ],
  };
  const runtime = instantiate(["openStore", "stop"], bindings),
    opening = runtime.openStore(installation);
  const rejected = assert.rejects(opening, (error) => error.code === "stopping");
  const shutdown = runtime.stop().then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  assert.deepEqual(events, []);
  lease.resolve(async () => {
    events.push("guild_lease_released");
  });
  await rejected;
  await shutdown;
  assert.equal(writes, 0);
  assert.deepEqual(events, ["guild_lease_released", "destroy", "data_root_released"]);
});

test("concurrent initialization shares one lease and one Store constructor", async () => {
  const lease = deferred();
  let locks = 0,
    writes = 0,
    released = 0;
  const bindings = storeBindings(
      () => {
        locks++;
        return lease.promise;
      },
      class {
        constructor() {
          writes++;
        }
      },
    ),
    runtime = instantiate(["openStore"], bindings);
  const first = runtime.openStore(installation),
    second = runtime.openStore(installation);
  assert.equal(locks, 1);
  lease.resolve(async () => {
    released++;
  });
  await Promise.all([first, second]);
  assert.equal(writes, 1);
  assert.equal(released, 0);
  assert.equal(bindings.stores.size, 1);
  assert.equal(bindings.guildReleases.size, 1);
  assert.equal(bindings.openingStores.size, 0);
});

function membershipBindings() {
  let opened = 0,
    marks = 0,
    registered = 0,
    epoch = 0;
  const stores = new Map(),
    installations = [installation],
    legacy = [installation],
    uninstalled = new Set([guildId]),
    purgingGuilds = new Set([guildId]);
  const bindings = {
    stores,
    installations,
    legacy,
    uninstalled,
    purgingGuilds,
    changing: new Set([guildId]),
    registry: {
      register() {
        registered++;
      },
    },
    configs: new Map(),
    retentionSchedule: { forget() {} },
    guildReleases: new Map(),
    retentionWarnings: new Map(),
    client: { isReady: () => true, guilds: { cache: { has: () => true } } },
    epoch: () => epoch,
    publicationRest: {},
    freshBotGuildPresence: async () => ({
      state: "present",
      source: "discord-rest",
      observedAt: Date.now(),
    }),
    recordGuildMembership() {
      marks++;
    },
    readUninstallMarker() {},
    jobRunner: { resumeGuild() {} },
    loadConfig: () => ({}),
    openStore: async (entry) => {
      opened++;
      stores.set(entry.guildId, {});
    },
    withClosedGuild() {},
  };
  return {
    bindings,
    get opened() {
      return opened;
    },
    get marks() {
      return marks;
    },
    get registered() {
      return registered;
    },
    leave() {
      epoch++;
      uninstalled.add(guildId);
    },
  };
}

test("a legacy rejoin during committed cleanup starts a fresh installation after the old lease is released", async () => {
  const finish = deferred(),
    state = membershipBindings(),
    order = [];
  let pendingJournal = true;
  state.bindings.guildReleases.set(guildId, async () => {
    order.push("old_lease_released");
  });
  state.bindings.openStore = async (entry) => {
    order.push("fresh_store_opened");
    state.bindings.stores.set(entry.guildId, {});
  };
  state.bindings.uninstallRetention = {
    pendingInstallations: () => (pendingJournal ? [installation] : []),
    status: () => ({ phase: "committed" }),
    purge: async () => {
      const outcome = await finish.promise;
      pendingJournal = false;
      return outcome;
    },
    cancelPrepared: () => true,
  };
  const runtime = instantiate(["presentInstallation", "sweepUninstalled"], state.bindings),
    sweep = runtime.sweepUninstalled();
  await Promise.resolve();
  await runtime.presentInstallation(guildId);
  assert.equal(state.bindings.uninstalled.has(guildId), false);
  assert.deepEqual(order, []);
  finish.resolve({ state: "purged", store: "closed" });
  await sweep;
  assert.deepEqual(order, ["old_lease_released", "fresh_store_opened"]);
  assert.equal(state.bindings.installations.length, 1);
  assert.equal(state.bindings.installations[0], installation);
  assert.equal(state.bindings.stores.has(guildId), true);
  assert.equal(state.marks, 1);
  assert.equal(state.registered, 1);
  assert.equal(pendingJournal, false);
});

test("a new departure during asynchronous open cannot publish stale present facts or register a runtime", async () => {
  const opening = deferred(),
    state = membershipBindings();
  state.bindings.purgingGuilds.clear();
  state.bindings.uninstallRetention = { cancelPrepared: () => true };
  state.bindings.openStore = async (entry) => {
    await opening.promise;
    state.bindings.stores.set(entry.guildId, {});
  };
  const runtime = instantiate(["presentInstallation"], state.bindings),
    present = runtime.presentInstallation(guildId);
  state.leave();
  opening.resolve();
  await present;
  assert.equal(state.marks, 0);
  assert.equal(state.registered, 0);
  assert.equal(state.bindings.uninstalled.has(guildId), true);
});
