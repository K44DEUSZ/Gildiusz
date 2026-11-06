import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionsBitField, PermissionFlagsBits as P } from "discord.js";
import { Store } from "../dist/storage/store.js";
import { loadConfig } from "../dist/config.js";
import { FormatDrafts, SettingsService } from "../dist/settings.js";
import { canManageSettings, settingsInteraction } from "../dist/bot/settings-panel.js";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "kampus-settings-"));
  const path = join(directory, "db.sqlite");
  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const config = loadConfig();
  return { store, config, path, service: new SettingsService(store, config, "guild") };
}

test("settings migration preserves version-one mappings and rooms", (t) => {
  const f = setup(t);
  f.store.putResource("channel.general", "channel", "id", {});
  f.store.putRoom({
    id: "room",
    owner: "member",
    locked: false,
    allowed: [],
    arrivals: {},
    emptySince: null,
    ownerAbsentSince: null,
  });
  f.store.db.exec("DROP TABLE runtime_settings; PRAGMA user_version=1;");
  const migrated = new Store(f.path);
  assert.equal(migrated.id("channel.general"), "id");
  assert.equal(migrated.room("room").owner, "member");
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(migrated.settings("guild"), undefined);
  migrated.close();
});

test("settings are durable, guild-scoped, apply live, and reject stale edits", (t) => {
  const f = setup(t);
  const rooms = f.config.rooms;
  f.service.update({ maximum: 7, extensions: ["pdf", "png", "pdf"] }, 0, "owner");
  assert.equal(f.config.rooms, rooms);
  assert.equal(rooms.maximum, 7);
  assert.deepEqual(f.config.attachments.extensions, ["pdf", "png"]);
  assert.equal(f.config.attachments.uploadsEnabled, false);
  assert.equal(rooms.ownerLimit, 1);
  const other = new SettingsService(f.store, loadConfig(), "other-guild");
  assert.equal(other.read().values.maximum, 20);
  const reopened = new Store(f.path),
    config = loadConfig();
  const restarted = new SettingsService(reopened, config, "guild");
  assert.equal(config.rooms.maximum, 7);
  assert.equal(restarted.read().revision, 1);
  assert.throws(() => restarted.update({ maximum: 8 }, 0, "owner"), /już zmienione/);
  assert.equal(f.service.read().values.maximum, 7);
  reopened.close();
});

test("invalid values and unsupported files never partly update settings", (t) => {
  const f = setup(t);
  for (const patch of [
    { maximum: 0 },
    { maximum: 46 },
    { maximum: 1.5 },
    { emptySeconds: 9 },
    { transferSeconds: Infinity },
    { creationCooldownSeconds: 3601 },
    { extensions: [] },
    { extensions: ["exe"] },
    { uploadsEnabled: true },
    { ownerLimit: 2 },
    { constructor: "tampered" },
  ])
    assert.throws(() => f.service.update(patch, 0, "owner"));
  assert.equal(f.service.read().revision, 0);
  assert.equal(f.store.settings("guild"), undefined);
  assert.equal(f.config.rooms.maximum, 20);
});

test("format drafts are private to the actor and guild and expire", () => {
  let clock = 0;
  const drafts = new FormatDrafts(() => clock);
  const id = drafts.create("alice", "guild", 3, ["pdf"]);
  assert.throws(() => drafts.get(id, "bob", "guild"), /innej osoby/);
  assert.throws(() => drafts.get(id, "alice", "other"), /innej osoby/);
  drafts.select(id, "alice", "guild", ["png"]);
  assert.deepEqual(drafts.get(id, "alice", "guild").extensions, ["png"]);
  clock = 600000;
  assert.throws(() => drafts.get(id, "alice", "guild"), /wygasł/);
});

test("every panel click checks current permissions and refuses other guilds", async (t) => {
  const f = setup(t);
  const replies = [];
  const member = { id: "member", permissions: new PermissionsBitField(P.ManageMessages) };
  assert.equal(canManageSettings("owner", member), false);
  assert.equal(canManageSettings("member", member), true);
  assert.equal(
    canManageSettings("owner", { ...member, permissions: new PermissionsBitField(P.ManageGuild) }),
    true,
  );
  let fetches = 0;
  const context = {
    guild: { id: "guild", ownerId: "owner" },
    settings: f.service,
    member: async () => {
      fetches++;
      return member;
    },
    alert: async () => {
      throw Error("Unexpected alert");
    },
  };
  const interaction = {
    guildId: "guild",
    user: { id: "member" },
    customId: "config:rooms",
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isRepliable: () => true,
    reply: async (value) => {
      replies.push(value);
    },
    showModal: async () => {
      throw Error("Unauthorized modal");
    },
  };
  assert.equal(await settingsInteraction(context, interaction), true);
  assert.equal(fetches, 1);
  assert.match(replies[0].content, /Zarządzanie serwerem/);
  assert.equal(replies[0].flags, 64);
  interaction.guildId = "other";
  await settingsInteraction(context, interaction);
  assert.equal(fetches, 1);
  assert.match(replies[1].content, /innego serwera/);
  assert.equal(f.store.settings("guild"), undefined);
});
