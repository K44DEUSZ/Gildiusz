import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Store } from "../dist/storage/store.js";
import { acquireLock } from "../dist/storage/lock.js";
import { PublicInstallations } from "../dist/control/installations.js";
import { TwitchHubStore } from "../dist/modules/twitch/store.js";
import {
  GuildUninstallRetention,
  recordGuildMembership,
  readUninstallMarker,
  guildUninstallRetentionMs,
} from "../dist/storage/uninstall-retention.js";

const guildA = "900000000000000001",
  guildB = "900000000000000002",
  owner = "900000000000000003",
  channel = "900000000000000004";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-uninstall-")),
    dataRoot = join(root, "data");
  mkdirSync(dataRoot, { mode: 0o700 });
  const registry = new PublicInstallations(join(dataRoot, "public-guilds")),
    installation = registry.add(guildA, owner),
    other = registry.add(guildB, owner);
  let store = new Store(installation.databasePath, guildA),
    otherStore = new Store(other.databasePath, guildB),
    closed = false,
    now = 1000000;
  const release = await acquireLock(installation.databasePath);
  const assetsRoot = join(dataRoot, "announcement-assets"),
    assetA = join(assetsRoot, guildA, `${randomUUID()}.png`),
    assetB = join(assetsRoot, guildB, `${randomUUID()}.png`);
  for (const [guildId, path] of [
    [guildA, assetA],
    [guildB, assetB],
  ]) {
    mkdirSync(join(assetsRoot, guildId), { recursive: true, mode: 0o700 });
    writeFileSync(path, "fixture image", { mode: 0o600 });
  }
  const config = join(dataRoot, "source-config.json");
  writeFileSync(config, "original configuration", { mode: 0o600 });
  const hubDb = new DatabaseSync(join(dataRoot, "integrations.sqlite")),
    hub = new TwitchHubStore(hubDb, { authorize: () => {}, clock: () => now });
  const bindings = [];
  for (const guildId of [guildA, guildB])
    bindings.push(
      await hub.createBinding(guildId, owner, randomUUID(), {
        broadcasterId: "1337",
        channelId: channel,
        roleIds: [],
        mentionEveryone: false,
        enabled: true,
        template: "{name}: {url}",
      }),
    );
  for (const binding of bindings)
    hubDb
      .prepare("INSERT INTO twitch_fanout VALUES (?,?,?,'pending','{}',NULL,NULL,?)")
      .run(randomUUID(), binding.id, "stream", now);
  let hubState = hubDb;
  const options = { dataRoot, assetsRoot, registry, hub: () => hubState, clock: () => now };
  const proof = (state = "absent") => ({ state, observedAt: now, source: "discord-rest" });
  const ports = {
    freshProof: async () => proof(),
    checkFence: () => true,
    withClosedGuild: async (_guild, work) => {
      if (!closed) {
        store.close();
        closed = true;
      }
      return work();
    },
  };
  const reopen = () => {
    if (closed) {
      store = new Store(installation.databasePath, guildA);
      closed = false;
    }
    return store;
  };
  t.after(async () => {
    if (!closed) store.close();
    otherStore.close();
    hubDb.close();
    await release();
    const path = resolve(root);
    assert.ok(path.startsWith(resolve(tmpdir()) + sep) && path.includes("gildiusz-uninstall-"));
    rmSync(path, { recursive: true, force: true });
  });
  return {
    root,
    dataRoot,
    registry,
    installation,
    other,
    assetA,
    assetB,
    config,
    hubDb,
    bindings,
    options,
    ports,
    proof,
    get store() {
      return store;
    },
    get closed() {
      return closed;
    },
    reopen,
    setNow: (value) => {
      now = value;
    },
    get now() {
      return now;
    },
    setHub: (value) => {
      hubState = value;
    },
  };
}
function due(f) {
  recordGuildMembership(f.store, guildA, f.proof(), f.now);
  f.setNow(f.now + guildUninstallRetentionMs);
}

test("first confirmed absence survives restart and cannot be advanced by outages or repeated observations", async (t) => {
  const f = await fixture(t),
    first = recordGuildMembership(f.store, guildA, f.proof(), f.now);
  await f.ports.withClosedGuild(guildA, async () => ({ state: "deferred", store: "reopen" }));
  assert.deepEqual(readUninstallMarker(f.reopen(), guildA), first);
  f.setNow(f.now + 5000);
  assert.deepEqual(recordGuildMembership(f.store, guildA, f.proof(), f.now), first);
  assert.deepEqual(recordGuildMembership(f.store, guildA, f.proof("unknown"), f.now), first);
  assert.deepEqual(
    recordGuildMembership(f.store, guildA, { ...f.proof(), source: "gateway-join" }, f.now),
    first,
  );
  assert.deepEqual(
    recordGuildMembership(f.store, guildA, { ...f.proof(), observedAt: f.now - 31000 }, f.now),
    first,
  );
  const retention = new GuildUninstallRetention(f.options);
  assert.equal((await retention.purge(f.installation, f.store, f.ports)).state, "not_due");
  assert.equal(recordGuildMembership(f.store, guildA, f.proof("present"), f.now), null);
  assert.equal(readUninstallMarker(f.store, guildA), null);
  assert.throws(() => recordGuildMembership(f.store, guildB, f.proof(), f.now), /guild mismatch/);
});

test("after 30 days only the departed guild database, UUID assets, registry row and bindings disappear under its lease", async (t) => {
  const f = await fixture(t);
  due(f);
  const retention = new GuildUninstallRetention(f.options);
  const result = await retention.purge(f.installation, f.store, f.ports);
  assert.deepEqual(result, { state: "purged", store: "closed" });
  assert.equal(existsSync(f.installation.databasePath), false);
  assert.equal(existsSync(f.assetA), false);
  assert.equal(existsSync(f.installation.databasePath + ".lock"), true);
  assert.equal(existsSync(f.other.databasePath), true);
  assert.equal(readFileSync(f.assetB, "utf8"), "fixture image");
  assert.equal(readFileSync(f.config, "utf8"), "original configuration");
  assert.deepEqual(
    f.registry.values().map((value) => value.guildId),
    [guildB],
  );
  const reloaded = new PublicInstallations(join(f.dataRoot, "public-guilds"));
  assert.deepEqual(
    reloaded.values().map((value) => value.guildId),
    [guildB],
  );
  assert.equal(f.hubDb.prepare("SELECT COUNT(*) count FROM twitch_sources").get().count, 1);
  assert.equal(f.hubDb.prepare("SELECT guild_id FROM twitch_bindings").get().guild_id, guildB);
  assert.equal(f.hubDb.prepare("SELECT COUNT(*) count FROM twitch_fanout").get().count, 1);
  assert.equal(
    f.hubDb
      .prepare("SELECT COUNT(*) count FROM twitch_mutations WHERE scope GLOB ?")
      .get(`${guildA}:*`).count,
    0,
  );
  assert.equal(
    f.hubDb
      .prepare("SELECT COUNT(*) count FROM twitch_mutations WHERE scope GLOB ?")
      .get(`${guildB}:*`).count,
    1,
  );
  assert.deepEqual(retention.pendingGuilds(), []);
  const ledger = retention.deletionLedger(guildA);
  assert.deepEqual(Object.keys(ledger).sort(), [
    "format",
    "guildId",
    "outcome",
    "purgedAt",
    "removedAt",
  ]);
  assert.equal(JSON.stringify(ledger).includes(owner), false);
  assert.equal(JSON.stringify(ledger).includes("fixture"), false);
});

test("rejoin or a changed membership epoch during drain cancels before irreversible effects", async (t) => {
  const f = await fixture(t);
  due(f);
  const retention = new GuildUninstallRetention(f.options);
  let fenced = true,
    calls = 0;
  const result = await retention.purge(f.installation, f.store, {
    ...f.ports,
    checkFence: () => fenced,
    freshProof: async () => {
      if (++calls === 2) fenced = false;
      return f.proof();
    },
  });
  assert.deepEqual(result, { state: "deferred", store: "reopen", phase: "prepared" });
  assert.equal(retention.status(guildA).phase, "prepared");
  assert.equal(existsSync(f.installation.databasePath), true);
  assert.equal(existsSync(f.assetA), true);
  assert.equal(f.hubDb.prepare("SELECT COUNT(*) count FROM twitch_bindings").get().count, 2);
  assert.equal(retention.cancelPrepared(guildA), true);
  recordGuildMembership(f.reopen(), guildA, f.proof("present"), f.now);
  assert.equal(readUninstallMarker(f.store, guildA), null);
});

test("a fresh confirmed return during drain is the only rejoined outcome", async (t) => {
  const f = await fixture(t);
  due(f);
  const retention = new GuildUninstallRetention(f.options);
  let calls = 0;
  const result = await retention.purge(f.installation, f.store, {
    ...f.ports,
    freshProof: async () => f.proof(++calls === 1 ? "absent" : "present"),
  });
  assert.deepEqual(result, { state: "rejoined", store: "reopen" });
  assert.equal(retention.status(guildA), null);
  assert.equal(existsSync(f.installation.databasePath), true);
  assert.equal(existsSync(f.assetA), true);
  recordGuildMembership(f.reopen(), guildA, f.proof("present"), f.now);
  assert.equal(readUninstallMarker(f.store, guildA), null);
});

test("uncertain proof, failed runner drain and unavailable hub cannot delete files", async (t) => {
  const f = await fixture(t);
  due(f);
  const retention = new GuildUninstallRetention(f.options);
  const unknown = await retention.purge(f.installation, f.store, {
    ...f.ports,
    freshProof: async () => f.proof("unknown"),
  });
  assert.equal(unknown.state, "deferred");
  assert.equal(f.closed, false);
  const unready = await retention.purge(f.installation, f.store, {
    ...f.ports,
    withClosedGuild: async () => undefined,
  });
  assert.equal(unready.state, "deferred");
  assert.equal(retention.status(guildA).phase, "prepared");
  assert.equal(f.closed, false);
  f.setHub(undefined);
  const unavailable = await retention.purge(f.installation, f.store, f.ports);
  assert.equal(unavailable.state, "deferred");
  assert.equal(unavailable.store, "reopen");
  assert.equal(existsSync(f.assetA), true);
  assert.equal(existsSync(f.installation.databasePath), true);
  assert.equal(retention.cancelPrepared(guildA), true);
  recordGuildMembership(f.reopen(), guildA, f.proof("present"), f.now);
});

test("durable hub wipe outbox survives a crash and resumes old-data deletion before a fresh installation", async (t) => {
  const f = await fixture(t);
  due(f);
  let crash = true;
  const retention = new GuildUninstallRetention({
    ...f.options,
    onStage: (phase) => {
      if (phase === "committed" && crash) {
        crash = false;
        throw Error("crash");
      }
    },
  });
  const interrupted = await retention.purge(f.installation, f.store, f.ports);
  assert.equal(interrupted.state, "pending");
  assert.equal(interrupted.phase, "committed");
  assert.equal(retention.cancelPrepared(guildA), false);
  assert.equal(existsSync(f.installation.databasePath), true);
  f.setHub(undefined);
  const retry = new GuildUninstallRetention(f.options);
  const unavailable = await retry.purge(f.installation, undefined, f.ports);
  assert.equal(unavailable.phase, "committed");
  assert.equal(unavailable.state, "pending");
  f.setHub(f.hubDb);
  const result = await retry.purge(f.installation, undefined, {
    ...f.ports,
    checkFence: () => false,
    freshProof: async () => {
      throw Error("old wipe does not inspect a new incarnation");
    },
  });
  assert.equal(result.state, "purged");
  assert.equal(retry.status(guildA), null);
  assert.equal(existsSync(f.other.databasePath), true);
});

test("registry failure after file removal resumes without recreating SQLite or touching another guild", async (t) => {
  const f = await fixture(t);
  due(f);
  const first = new GuildUninstallRetention({
    ...f.options,
    registry: {
      remove: () => {
        throw Error("disk");
      },
    },
  });
  const pending = await first.purge(f.installation, f.store, f.ports);
  assert.equal(pending.phase, "files_done");
  assert.equal(pending.store, "closed");
  assert.equal(existsSync(f.installation.databasePath), false);
  assert.equal(f.registry.values().length, 2);
  const restarted = new GuildUninstallRetention(f.options);
  assert.equal((await restarted.purge(f.installation, undefined, f.ports)).state, "purged");
  assert.deepEqual(
    f.registry.values().map((value) => value.guildId),
    [guildB],
  );
  assert.equal(existsSync(f.installation.databasePath), false);
});

test("a prepared journal cannot reuse the timer after a rejoin and a later uninstall", async (t) => {
  const f = await fixture(t);
  due(f);
  const retention = new GuildUninstallRetention(f.options);
  await retention.purge(f.installation, f.store, {
    ...f.ports,
    withClosedGuild: async () => undefined,
  });
  recordGuildMembership(f.store, guildA, f.proof("present"), f.now);
  f.setNow(f.now + 1000);
  const newer = recordGuildMembership(f.store, guildA, f.proof(), f.now);
  const result = await retention.purge(f.installation, f.store, f.ports);
  assert.equal(result.state, "not_due");
  assert.equal(result.store, "reopen");
  assert.equal(retention.status(guildA), null);
  assert.deepEqual(readUninstallMarker(f.reopen(), guildA), newer);
  assert.equal(existsSync(f.assetA), true);
});

test("replacement database identity stays closed and cannot be deleted as an old installation", async (t) => {
  const f = await fixture(t);
  due(f);
  const retention = new GuildUninstallRetention(f.options);
  const result = await retention.purge(f.installation, f.store, {
    ...f.ports,
    withClosedGuild: async (guildId, work) =>
      f.ports.withClosedGuild(guildId, async () => {
        renameSync(f.installation.databasePath, f.installation.databasePath + ".old");
        const replacement = new Store(f.installation.databasePath, guildA);
        replacement.close();
        return work();
      }),
  });
  assert.deepEqual(result, { state: "pending", store: "closed", phase: "prepared" });
  assert.equal(retention.cancelPrepared(guildA), false);
  assert.equal(existsSync(f.installation.databasePath), true);
  assert.equal(existsSync(f.assetA), true);
  assert.equal(f.hubDb.prepare("SELECT COUNT(*) count FROM twitch_bindings").get().count, 2);
});

test("unapproved paths and unexpected files fail before deleting any guild data", async (t) => {
  const f = await fixture(t);
  due(f);
  const retention = new GuildUninstallRetention(f.options);
  await assert.rejects(
    retention.purge(
      { ...f.installation, databasePath: join(f.root, "outside.sqlite") },
      f.store,
      f.ports,
    ),
    /database scope/,
  );
  writeFileSync(join(f.dataRoot, "announcement-assets", guildA, "unexpected.txt"), "leave intact");
  await assert.rejects(retention.purge(f.installation, f.store, f.ports), /Unexpected files/);
  assert.equal(existsSync(f.installation.databasePath), true);
  assert.equal(existsSync(f.assetA), true);
  assert.equal(f.closed, false);
});

test(
  "linked assets and a symlinked sidecar are rejected without removing other files",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    due(f);
    const retention = new GuildUninstallRetention(f.options),
      victim = join(f.root, "victim");
    writeFileSync(victim, "untouched");
    const linked = join(f.dataRoot, "announcement-assets", guildA, `${randomUUID()}.png`);
    linkSync(victim, linked);
    await assert.rejects(retention.purge(f.installation, f.store, f.ports), /unlinked files/);
    rmSync(linked);
    // Closing inside the test callback removes normal SQLite sidecars, then a foreign link appears.
    const result = await retention.purge(f.installation, f.store, {
      ...f.ports,
      withClosedGuild: async (guild, work) =>
        f.ports.withClosedGuild(guild, async () => {
          symlinkSync(victim, f.installation.databasePath + "-wal");
          return work();
        }),
    });
    assert.equal(result.state, "pending");
    assert.equal(result.store, "reopen");
    assert.equal(readFileSync(victim, "utf8"), "untouched");
    assert.equal(existsSync(f.assetA), true);
  },
);

test("public registry remove is idempotent and rollback keeps in-memory installations on failed persistence", async (t) => {
  const f = await fixture(t),
    registryFile = join(f.dataRoot, "public-guilds", "installations.json");
  rmSync(registryFile);
  mkdirSync(registryFile);
  assert.throws(() => f.registry.remove(guildA));
  assert.equal(
    f.registry.values().some((value) => value.guildId === guildA),
    true,
  );
  assert.equal(
    readdirSync(join(f.dataRoot, "public-guilds")).some((value) => value.endsWith(".tmp")),
    false,
  );
});
