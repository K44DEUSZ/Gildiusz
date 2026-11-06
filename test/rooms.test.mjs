import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/storage/store.js";
import { RoomService } from "../dist/bot/room-service.js";
import { loadConfig } from "../dist/config.js";
import { SettingsService } from "../dist/settings.js";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "kampus-rooms-"));
  const path = join(directory, "state.sqlite");
  const store = new Store(path),
    rooms = new Map(),
    blocked = new Set(),
    entrance = new Set(["alice", "bob", "carol"]);
  let clock = 100000,
    created = 0,
    failMove = false,
    ready = true;
  const port = {
    ready: () => ready,
    members: async (id) => rooms.get(id) ?? null,
    eligible: async (id) => !blocked.has(id),
    atEntrance: (id) => entrance.has(id),
    capacity: () => true,
    create: async () => {
      const id = String(++created);
      rooms.set(id, []);
      return id;
    },
    move: async (id, room) => {
      if (failMove) return false;
      entrance.delete(id);
      rooms.get(room).push({ id, name: id, bot: false });
      return true;
    },
    remove: async (id) => {
      assert.equal(rooms.get(id)?.length, 0);
      rooms.delete(id);
    },
    permissions: async () => {},
    rename: async () => {},
  };
  const config = loadConfig();
  const service = new RoomService(store, config.rooms, port, () => clock);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    config,
    service,
    rooms,
    blocked,
    entrance,
    port,
    path,
    tick: (ms) => {
      clock += ms;
    },
    created: () => created,
    failMove: () => {
      failMove = true;
    },
    disconnect: () => {
      ready = false;
    },
  };
}
const member = (id) => ({ id, name: id, bot: false });

test("saved room limits take effect immediately without removing existing rooms", async (t) => {
  const f = setup(t);
  const settings = new SettingsService(f.store, f.config, "guild");
  settings.update({ maximum: 1 }, 0, "owner");
  await f.service.enter(member("alice"));
  await assert.rejects(f.service.enter(member("bob")), /capacity/);
  settings.update({ maximum: 2 }, 1, "owner");
  f.tick(30001);
  await f.service.enter(member("bob"));
  settings.update({ maximum: 1 }, 2, "owner");
  assert.equal(f.store.rooms().length, 2);
  await assert.rejects(f.service.enter(member("carol")), /capacity/);
});

test("concurrent duplicate entrance events create one room and reuse it", async (t) => {
  const f = setup(t);
  const ids = await Promise.all([
    f.service.enter(member("alice")),
    f.service.enter(member("alice")),
  ]);
  assert.equal(ids[0], ids[1]);
  assert.equal(f.created(), 1);
  assert.equal(f.store.rooms().length, 1);
});

test("empty countdown survives a service restart and a returning participant cancels deletion", async (t) => {
  const f = setup(t),
    id = await f.service.enter(member("alice"));
  f.rooms.set(id, []);
  await f.service.reconcile();
  f.tick(59000);
  await f.service.reconcile();
  assert.ok(f.store.room(id));
  f.rooms.set(id, [member("bob")]);
  await f.service.reconcile();
  f.tick(10000);
  await f.service.reconcile();
  assert.ok(f.rooms.has(id));
  f.rooms.set(id, []);
  await f.service.reconcile();
  f.tick(60001);
  const restarted = new RoomService(f.store, loadConfig().rooms, f.port);
  await restarted.reconcile();
  assert.equal(f.store.room(id), undefined);
  assert.equal(f.rooms.has(id), false);
});

test("closed rooms preserve eligible participants, reject outsiders, and transfer control without retaining old ownership", async (t) => {
  const f = setup(t),
    id = await f.service.enter(member("alice"));
  f.rooms.get(id).push(member("bob"));
  await f.service.reconcile();
  f.tick(1);
  f.rooms.get(id).push(member("carol"));
  await f.service.reconcile();
  await f.service.control(id, "alice", false, "close");
  assert.deepEqual(new Set(f.store.room(id).allowed), new Set(["alice", "bob", "carol"]));
  await assert.rejects(f.service.control(id, "outsider", false, "open"), /roomDenied/);
  f.rooms.set(id, [member("bob"), member("carol")]);
  await f.service.reconcile();
  f.tick(30001);
  await f.service.reconcile();
  assert.equal(f.store.room(id).owner, "bob");
  await assert.rejects(f.service.control(id, "alice", false, "open"), /roomDenied/);
  f.blocked.add("carol");
  await f.service.reconcile();
  assert.equal(f.store.room(id).allowed.includes("carol"), false);
  await assert.rejects(f.service.control(id, "bob", false, "invite", "carol"));
});

test("failed moves clean only the newly created empty room and pending members create nothing", async (t) => {
  const f = setup(t);
  f.failMove();
  await assert.rejects(f.service.enter(member("alice")));
  assert.equal(f.rooms.size, 0);
  assert.equal(f.store.rooms().length, 0);
  f.blocked.add("bob");
  await assert.rejects(f.service.enter(member("bob")));
  assert.equal(f.created(), 1);
});

test("disconnects suspend deletion and an unrelated channel is never adopted or removed", async (t) => {
  const f = setup(t),
    id = await f.service.enter(member("alice"));
  f.rooms.set(id, []);
  f.rooms.set("unmanaged", []);
  await f.service.reconcile();
  f.tick(60001);
  f.disconnect();
  await f.service.reconcile();
  assert.ok(f.rooms.has(id));
  assert.ok(f.rooms.has("unmanaged"));
});

test("recorded voice event times choose the earliest participant and the owner's return cancels handover", async (t) => {
  const f = setup(t),
    id = await f.service.enter(member("alice"));
  f.rooms.get(id).push(member("carol"), member("bob"));
  await f.service.recordPresence("carol", null, id, 100010);
  await f.service.recordPresence("bob", null, id, 100020);
  f.rooms.set(id, [member("carol"), member("bob")]);
  await f.service.recordPresence("alice", id, null, 100030);
  f.tick(31000);
  f.rooms.get(id).push(member("alice"));
  await f.service.recordPresence("alice", null, id, 131000);
  await f.service.reconcile();
  assert.equal(f.store.room(id).owner, "alice");
  f.rooms.set(id, [member("carol"), member("bob")]);
  await f.service.recordPresence("alice", id, null, 131001);
  f.tick(31001);
  await f.service.reconcile();
  assert.equal(f.store.room(id).owner, "carol");
});
