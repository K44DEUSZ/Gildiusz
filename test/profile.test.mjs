import assert from "node:assert/strict";
import test from "node:test";
import { PermissionsBitField, PermissionFlagsBits as P } from "discord.js";
import {
  ProfileService,
  profileRevision,
  profileName,
  downloadAvatar,
  avatarLimit,
} from "../dist/profile.js";
import { settingsInteraction } from "../dist/bot/settings-panel.js";
import { writeProfile } from "../dist/bot/profile-panel.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
  "base64",
);
const url =
  "https://cdn.discordapp.com/ephemeral-attachments/123456789012345678/234567890123456789/avatar.png?ex=123";
const original = {
  nick: null,
  avatar: null,
  defaultName: "Gildiusz",
  avatarURL: "https://cdn.discordapp.com/embed/avatars/0.png",
  defaultAvatarURL: "https://cdn.discordapp.com/embed/avatars/0.png",
};
function fixture() {
  let state = { ...original },
    now = 0,
    allowed = true;
  const writes = [],
    audits = [];
  const service = new ProfileService(
    "guild",
    {
      read: async () => ({ ...state }),
      write: async (patch) => {
        writes.push(patch);
        if (patch.nick !== undefined) state.nick = patch.nick;
        if (patch.avatar !== undefined) state.avatar = patch.avatar ? "new-hash" : null;
      },
      cooldown: () => allowed,
      audit: (actor) => audits.push(actor),
    },
    () => now,
  );
  return {
    service,
    writes,
    audits,
    state: () => state,
    change: (patch) => Object.assign(state, patch),
    advance: () => (now += 300000),
    block: () => (allowed = false),
  };
}

test("profile drafts require the actor and guild, expire, and never write during preview", async () => {
  const f = fixture(),
    expected = profileRevision(await f.service.read());
  const id = await f.service.prepare("alice", expected, { nick: "  Kumpel  " });
  assert.equal(f.service.get(id, "alice", "guild").patch.nick, "Kumpel");
  assert.throws(() => f.service.get(id, "bob", "guild"), /innej osoby/);
  await assert.rejects(f.service.save(id, "alice", "other"), /innej osoby/);
  assert.equal(f.writes.length, 0);
  f.advance();
  assert.throws(() => f.service.get(id, "alice", "guild"), /wygasł/);
  assert.equal(profileName("  "), null);
  assert.throws(() => profileName("x".repeat(33)), /32/);
  assert.throws(() => profileName("x\u202ey"), /sterujących/);
});

test("concurrent profile saves serialize and reject stale previews, including manual Discord edits", async () => {
  const f = fixture(),
    expected = profileRevision(await f.service.read());
  const a = await f.service.prepare("alice", expected, { nick: "Pierwszy" });
  const b = await f.service.prepare("bob", expected, { avatar: png });
  const saved = await Promise.allSettled([
    f.service.save(a, "alice", "guild"),
    f.service.save(b, "bob", "guild"),
  ]);
  assert.equal(saved.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.audits, ["alice"]);
  const c = await f.service.prepare("alice", profileRevision(await f.service.read()), {
    nick: "Trzeci",
  });
  f.change({ nick: "Zmiana ręczna" });
  await assert.rejects(f.service.save(c, "alice", "guild"), /już zmieniony/);
  assert.equal(f.writes.length, 1);
});

test("reset is one guild profile patch; cooldown and ambiguous errors cannot duplicate a write", async () => {
  const f = fixture();
  f.change({ nick: "Inny", avatar: "old-hash" });
  const id = await f.service.prepare("owner", profileRevision(await f.service.read()), {
    nick: null,
    avatar: null,
  });
  await f.service.save(id, "owner", "guild");
  assert.deepEqual(f.writes, [{ nick: null, avatar: null }]);
  await assert.rejects(f.service.save(id, "owner", "guild"), /wygasł/);
  const next = await f.service.prepare("owner", profileRevision(await f.service.read()), {
    nick: "Inny",
  });
  f.block();
  await assert.rejects(f.service.save(next, "owner", "guild"), /raz na minutę/);
  assert.equal(f.writes.length, 1);
  let attempts = 0;
  const failing = new ProfileService("guild", {
    read: async () => original,
    write: async () => {
      attempts++;
      throw Error("Network");
    },
    cooldown: () => true,
    audit: () => assert.fail("No success audit"),
  });
  const token = await failing.prepare("owner", profileRevision(original), { nick: "Nowy" });
  await assert.rejects(failing.save(token, "owner", "guild"), /Network/);
  await assert.rejects(failing.save(token, "owner", "guild"), /wygasł/);
  assert.equal(attempts, 1);
});

test("avatar upload restricts CDN destinations and redirects, size, complete body and image format", async () => {
  let calls = 0;
  const fetcher = async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    return new globalThis.Response(png);
  };
  const file = { name: "awatar.png", size: png.length, url };
  assert.deepEqual(await downloadAvatar(file, fetcher), png);
  for (const address of [
    "http://127.0.0.1/a.png",
    "https://cdn.discordapp.com.evil.test/attachments/123456789012345678/234567890123456789/a.png",
    "https://cdn.discordapp.com/api/test",
  ])
    await assert.rejects(downloadAvatar({ ...file, url: address }, fetcher));
  await assert.rejects(downloadAvatar({ ...file, size: avatarLimit + 1 }, fetcher), /2 MB/);
  assert.equal(calls, 1);
  await assert.rejects(downloadAvatar({ ...file, size: png.length - 1 }, fetcher), /rozmiar/);
  await assert.rejects(downloadAvatar({ ...file, size: png.length + 1 }, fetcher), /kompletny/);
  await assert.rejects(downloadAvatar({ ...file, name: "awatar.jpg" }, fetcher), /kompletny/);
  await assert.rejects(
    downloadAvatar(file, async () => new globalThis.Response(null, { status: 302 })),
    /pobrać/,
  );
});

test("profile write rechecks revoked administration and requires nickname permission only when needed", async () => {
  const writes = [];
  let admin = false;
  const context = {
    member: async () => ({
      id: "admin",
      permissions: new PermissionsBitField(admin ? P.ManageGuild : 0n),
    }),
    guild: {
      ownerId: "owner",
      members: {
        fetchMe: async () => ({ permissions: new PermissionsBitField() }),
        editMe: async (patch) => writes.push(patch),
      },
    },
  };
  await assert.rejects(writeProfile(context, { avatar: png }, "admin"), /Zarządzanie/);
  admin = true;
  await assert.rejects(writeProfile(context, { nick: "Nowy" }, "admin"), /pseudonimu/);
  await writeProfile(context, { avatar: png }, "admin");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].avatar, png);
  assert.equal(writes[0].nick, undefined);
});

test("panel name modal and file upload produce private previews and save only after a fresh authorized click", async () => {
  const f = fixture();
  let admin = true,
    modal,
    preview;
  const context = {
    guild: { id: "guild", ownerId: "owner" },
    profile: f.service,
    member: async () => ({
      id: "admin",
      permissions: new PermissionsBitField(admin ? P.ManageGuild : 0n),
    }),
    alert: async () => assert.fail("Unexpected error"),
  };
  const base = {
    guildId: "guild",
    user: { id: "admin" },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    isRepliable: () => true,
    isStringSelectMenu: () => false,
    reply: async (value) => {
      preview = value;
    },
    editReply: async (value) => {
      preview = value;
    },
  };
  const click = (id) => ({
    ...base,
    customId: id,
    isButton: () => true,
    isModalSubmit: () => false,
    showModal: async (value) => {
      modal = value.toJSON();
    },
    deferUpdate: async () => {},
  });
  await settingsInteraction(context, click("config:profile-name"));
  assert.ok(modal.custom_id.length <= 100);
  const submit = {
    ...base,
    customId: modal.custom_id,
    isButton: () => false,
    isModalSubmit: () => true,
    isFromMessage: () => true,
    deferUpdate: async () => {},
    fields: { getTextInputValue: () => "Serwerowy Kumpel" },
  };
  await settingsInteraction(context, submit);
  assert.match(preview.content, /Podgląd profilu/);
  assert.equal(f.writes.length, 0);
  const save = preview.components[0].toJSON().components[0].custom_id;
  admin = false;
  await settingsInteraction(context, click(save));
  assert.equal(f.writes.length, 0);
  assert.equal(preview.flags, 64);
  admin = true;
  await settingsInteraction(context, click(save));
  assert.deepEqual(f.writes, [{ nick: "Serwerowy Kumpel" }]);
  await settingsInteraction(context, click("config:profile-avatar"));
  assert.equal(modal.components[0].type, 18);
  assert.equal(modal.components[0].component.type, 19);
  assert.equal(modal.components[0].component.max_values, 1);
  assert.ok(modal.custom_id.length <= 100);
});
