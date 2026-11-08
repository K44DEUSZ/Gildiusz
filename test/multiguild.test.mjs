import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadInstallations, selectInstallation } from "../dist/installations.js";
import { GuildRegistry } from "../dist/bot/guild-registry.js";
import { Store } from "../dist/storage/store.js";
import { RoomService } from "../dist/bot/room-service.js";
import { SettingsService } from "../dist/settings.js";
import { loadConfig } from "../dist/config.js";

const guilds = ["100000000000000001", "100000000000000002"];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-multiguild-"));
  t.after(() => {
    assert.ok(directory.startsWith(join(tmpdir(), "gildiusz-multiguild-")));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
test("legacy configuration is preserved and multiple guilds require an explicit CLI target", (t) => {
  const directory = fixture(t),
    path = join(directory, "guilds.json");
  const entries = guilds.map((guildId, index) => ({
    guildId,
    ownerId: guilds[0],
    configPath: "server.json",
    databasePath: `g${index}.sqlite`,
  }));
  writeFileSync(path, JSON.stringify(entries));
  const values = { GUILDS_PATH: path };
  assert.equal(loadInstallations(values)[1].databasePath, join(directory, "g1.sqlite"));
  assert.throws(() => selectInstallation(undefined, values), /--guild/);
  assert.equal(selectInstallation(guilds[1], values).guildId, guilds[1]);
  assert.throws(() => selectInstallation("100000000000000009", values), /not configured/);
  const legacy = loadInstallations({
    DISCORD_GUILD_ID: guilds[0],
    OWNER_USER_ID: guilds[1],
    DATABASE_PATH: "data/legacy.sqlite",
  });
  assert.equal(legacy[0].databasePath, resolve("data/legacy.sqlite"));
  for (const patch of [
    { guildId: guilds[0] },
    { databasePath: "./g0.sqlite" },
    { databasePath: "" },
    { ownerId: "invalid" },
  ]) {
    writeFileSync(path, JSON.stringify([entries[0], { ...entries[1], ...patch }]));
    assert.throws(() => loadInstallations(values));
  }
});

test("one failed guild does not block another, unknown guilds cannot dispatch, and retry is bounded", async () => {
  const registry = new GuildRegistry(guilds.map((guildId) => ({ guildId })));
  let failed = true,
    attempts = 0;
  const errors = [];
  const create = async (entry) => {
    attempts++;
    if (entry.guildId === guilds[0] && failed) throw Error("missing access");
    return { guildId: entry.guildId };
  };
  await registry.initialize(create, (id) => errors.push(id), 1000);
  assert.deepEqual(errors, [guilds[0]]);
  assert.equal(registry.get(guilds[1]).guildId, guilds[1]);
  assert.equal(registry.get(null), undefined);
  assert.equal(registry.get("unknown"), undefined);
  await registry.initialize(create, () => {}, 2000);
  assert.equal(attempts, 2);
  failed = false;
  await registry.initialize(create, () => {}, 61000);
  assert.deepEqual(
    registry.statuses(() => true),
    guilds.map((guildId) => ({ guildId, ready: true })),
  );
  registry.invalidate(guilds[0]);
  assert.equal(registry.get(guilds[0]), undefined);
  assert.equal(registry.get(guilds[1]).guildId, guilds[1]);
});

test("a leave event during initialization cannot reactivate an uninstalled guild", async () => {
  const registry = new GuildRegistry([{ guildId: guilds[0] }]);
  await registry.initialize(
    async () => {
      registry.invalidate(guilds[0]);
      return {};
    },
    () => {},
    1000,
  );
  assert.equal(registry.get(guilds[0]), undefined);
});

test("the same member can own a room in each guild with separate settings, cooldowns and journals", async (t) => {
  const directory = fixture(t);
  const stores = guilds.map((guild, index) => new Store(join(directory, `${index}.sqlite`), guild));
  try {
    const configs = stores.map(() => loadConfig());
    const services = stores.map((store, index) => {
      const members = new Map();
      return new RoomService(
        store,
        configs[index].rooms,
        {
          ready: () => true,
          eligible: async () => true,
          atEntrance: () => true,
          capacity: () => true,
          create: async () => {
            const id = `room-${index}`;
            members.set(id, []);
            return id;
          },
          move: async (id, room) => {
            members.get(room).push({ id, name: id, bot: false });
            return true;
          },
          members: async (id) => members.get(id) ?? null,
          remove: async () => {},
          permissions: async () => {},
          rename: async () => {},
        },
        () => 100000,
      );
    });
    const settings = stores.map(
      (store, index) => new SettingsService(store, configs[index], guilds[index]),
    );
    settings[0].update({ maximum: 1 }, 0, "owner");
    stores[0].putResource("channel.join", "channel", "first", {});
    stores[1].putResource("channel.join", "channel", "second", {});
    assert.deepEqual(
      await Promise.all(
        services.map((service) => service.enter({ id: "alice", name: "Alice", bot: false })),
      ),
      ["room-0", "room-1"],
    );
    await assert.rejects(services[0].enter({ id: "bob", name: "Bob", bot: false }), /capacity/);
    assert.equal(stores[0].id("channel.join"), "first");
    assert.equal(stores[1].id("channel.join"), "second");
    assert.equal(settings[1].read().revision, 0);
    assert.equal(stores[0].cooldown("same-member", 1000, 100), true);
    assert.equal(stores[0].cooldown("same-member", 1000, 200), false);
    assert.equal(stores[1].cooldown("same-member", 1000, 200), true);
    stores[0].beginOperation("same", { guild: "first" });
    stores[1].beginOperation("same", { guild: "second" });
    stores[0].endOperation("same");
    assert.equal(stores[1].operations().length, 1);
    await stores[0].backup(join(directory, "copy.sqlite"));
    assert.throws(() => new Store(join(directory, "copy.sqlite"), guilds[1]), /different guild/);
  } finally {
    stores.forEach((store) => store.close());
  }
  const reopened = new Store(join(directory, "0.sqlite"), guilds[0]);
  assert.equal(reopened.rooms()[0].owner, "alice");
  assert.equal(reopened.settings(guilds[0]).revision, 1);
  reopened.close();
});

test("binding an existing single-guild database preserves all data and supports old schema readers", (t) => {
  const directory = fixture(t),
    path = join(directory, "legacy.sqlite");
  let store = new Store(path);
  store.putResource("channel.join", "channel", "existing", {});
  store.close();
  store = new Store(path, guilds[0]);
  assert.equal(store.id("channel.join"), "existing");
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
  store.close();
  assert.throws(() => new Store(path, guilds[1]), /different guild/);
  store = new Store(path);
  assert.equal(store.id("channel.join"), "existing");
  store.close();
});
