import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits as P } from "discord.js";
import { RoleSelectionService, roleChoices } from "../dist/role-selection.js";
import { discordRoleSelection } from "../dist/bot/role-selection.js";
import { BotContext } from "../dist/bot/context.js";
import { Store } from "../dist/storage/store.js";
import { loadConfig } from "../dist/config.js";
import { publications } from "../dist/content.js";

const panel = {
  guild: "100000000000000001",
  channel: "100000000000000002",
  message: "100000000000000003",
};
const user = "100000000000000004";
const event = (active, emoji = "💻") => ({ ...panel, user, emoji, active });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-role-selection-"));
  const path = join(directory, "guild.sqlite");
  const store = new Store(path, panel.guild);
  t.after(() => {
    store.close();
    assert.ok(directory.startsWith(join(tmpdir(), "gildiusz-role-selection-")));
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, path };
}
test("reaction selection is confined to its guild, channel, managed message and emoji allowlist", async (t) => {
  const { store } = fixture(t);
  const calls = [];
  const service = new RoleSelectionService(store, panel, {
    reactors: async () => [],
    apply: async (...args) => {
      calls.push(args);
      return true;
    },
  });
  for (const patch of [
    { guild: null },
    { guild: "other" },
    { channel: "other" },
    { message: "other" },
    { emoji: "🛡️" },
  ])
    await service.handle({ ...event(true), ...patch });
  assert.deepEqual(calls, []);
  await Promise.all([
    service.handle(event(true)),
    service.handle(event(true, "🎨")),
    service.handle(event(false)),
  ]);
  assert.deepEqual(calls, [
    [user, "programming", true],
    [user, "design", true],
    [user, "programming", false],
  ]);
  assert.deepEqual(store.roleSelections("programming"), []);
  assert.deepEqual(store.roleSelections("design"), [user]);
});
test("restart reconciliation repairs interrupted writes and offline removals without adopting unrelated native choices", async (t) => {
  const { store, path } = fixture(t);
  const broken = new RoleSelectionService(store, panel, {
    reactors: async () => [],
    apply: async () => {
      throw Error("network");
    },
  });
  await assert.rejects(broken.handle(event(true)), /network/);
  const reopened = new Store(path, panel.guild);
  const calls = [];
  try {
    assert.deepEqual(reopened.roleSelections("programming"), [user]);
    const service = new RoleSelectionService(reopened, panel, {
      reactors: async (emoji) => (emoji === "🎨" ? [user] : []),
      apply: async (...args) => {
        calls.push(args);
        return true;
      },
    });
    await service.reconcile();
    assert.deepEqual(calls, [
      [user, "programming", false],
      [user, "design", true],
    ]);
    assert.deepEqual(reopened.roleSelections("programming"), []);
    assert.deepEqual(reopened.roleSelections("design"), [user]);
    const failedRead = new RoleSelectionService(reopened, panel, {
      reactors: async () => {
        throw Error("pagination");
      },
      apply: async () => assert.fail("must not infer removals from failed reads"),
    });
    await assert.rejects(failedRead.reconcile(), /pagination/);
    assert.deepEqual(reopened.roleSelections("design"), [user]);
  } finally {
    reopened.close();
  }
});
test("the Discord adapter refuses pending, timed-out and bot accounts, elevated roles and lost hierarchy", async (t) => {
  const { store } = fixture(t);
  const config = loadConfig();
  store.putResource("message.roles.0", "message", panel.message, {});
  store.putResource("role.programming", "role", "programming", {});
  const held = new Set();
  const writes = [];
  const member = {
    user: { bot: false },
    pending: false,
    disabled: false,
    isCommunicationDisabled() {
      return this.disabled;
    },
    roles: {
      cache: held,
      add: async (id) => {
        writes.push([id, true]);
        held.add(id);
      },
      remove: async (id) => {
        writes.push([id, false]);
        held.delete(id);
      },
    },
  };
  const role = { id: "programming", managed: false, position: 1, permissions: { bitfield: 0n } };
  const bot = {
    allowed: true,
    position: 10,
    permissions: { has: () => bot.allowed },
    roles: { highest: { comparePositionTo: (target) => bot.position - target.position } },
  };
  const message = {
    author: { id: "bot" },
    react: async () => {},
    reactions: { cache: { find: () => undefined } },
  };
  const context = {
    config,
    store,
    environment: { clientId: "bot" },
    guild: {
      id: panel.guild,
      roles: { fetch: async () => new Map([[role.id, role]]) },
      members: { fetch: async () => member, fetchMe: async () => bot },
    },
    textChannel: async () => ({ id: panel.channel, messages: { fetch: async () => message } }),
    member: BotContext.prototype.member,
  };
  const service = await discordRoleSelection(context);
  for (const [target, field] of [
    [member, "pending"],
    [member, "disabled"],
    [member.user, "bot"],
  ]) {
    target[field] = true;
    await service.handle(event(true));
    target[field] = false;
  }
  assert.deepEqual(writes, []);
  for (const patch of [
    { managed: true },
    { permissions: { bitfield: P.Administrator } },
    { position: 10 },
  ]) {
    const original = { ...role };
    Object.assign(role, patch);
    await assert.rejects(service.handle(event(true)), /not safe/);
    Object.assign(role, original);
  }
  bot.allowed = false;
  await assert.rejects(service.handle(event(true)), /not safe/);
  bot.allowed = true;
  assert.deepEqual(writes, []);
  await service.handle(event(true));
  await service.handle(event(true));
  await service.handle(event(false));
  assert.deepEqual(writes, [
    ["programming", true],
    ["programming", false],
  ]);
});
test("informational publications separate every consecutive message and include the complete role panel", () => {
  const config = loadConfig();
  const messages = publications(config);
  const seen = new Set();
  for (const message of messages) {
    assert.equal(message.text.startsWith("\u200b\n\n"), seen.has(message.channel));
    assert.ok(message.text.length <= 2000);
    seen.add(message.channel);
  }
  const roles = messages.find((message) => message.key === "message.roles.0");
  for (const choice of roleChoices) {
    assert.ok(roles.text.includes(choice.emoji));
    assert.ok(roles.text.includes(config.roles.find((role) => role.key === choice.key).name));
  }
});
