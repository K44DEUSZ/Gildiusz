import assert from "node:assert/strict";
import test from "node:test";
import { Routes } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/storage/store.js";
import { loadConfig } from "../dist/config.js";
import { publications } from "../dist/content.js";
import { commands } from "../dist/bot/commands.js";
import { buildPlan, applyPlan, project } from "../dist/bootstrap/plan.js";
import { auditPermissions } from "../dist/permissions/audit.js";
import {
  bootstrapPermissions,
  memberPermissions,
  moderatorPermissions,
  P,
} from "../dist/permissions/model.js";

const clone = (value) => JSON.parse(JSON.stringify(value));
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "kampus-plans-"));
  const store = new Store(join(directory, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const env = {
    token: "unused",
    guildId: "100000000000000001",
    clientId: "100000000000000002",
    ownerId: "100000000000000003",
    databasePath: store.path,
  };
  const state = {
    guild: { id: env.guildId, owner_id: env.ownerId, features: ["COMMUNITY"] },
    botId: env.clientId,
    roles: [{ id: env.guildId, name: "@everyone", permissions: "0" }],
    channels: [],
    automod: [],
    onboarding: null,
    commands: [],
  };
  const messages = new Map(),
    writes = [];
  let next = 100000000000000010n;
  const list = (route) =>
    route.includes("auto-moderation")
      ? state.automod
      : route.includes("/commands")
        ? state.commands
        : route.includes("/roles")
          ? state.roles
          : state.channels;
  const commandResponse = (value) => {
    if (Array.isArray(value)) return value.map(commandResponse);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key, entry]) =>
              !(key === "required" && entry === false) &&
              !(key === "options" && Array.isArray(entry) && entry.length === 0),
          )
          .map(([key, entry]) => [key, commandResponse(entry)]),
      );
    return value;
  };
  const api = {
    get: async (route) => {
      if (messages.has(route)) return clone(messages.get(route));
      if (route.endsWith("/messages?limit=100")) {
        const channel = route.split("/")[2];
        return clone([...messages.values()].filter((message) => message.channel_id === channel));
      }
      throw Object.assign(Error("missing"), { code: 10008 });
    },
    post: async (route, body) => {
      writes.push(["post", route]);
      const resource = {
        ...(route.endsWith("/roles") ? { permissions: memberPermissions } : {}),
        ...(route.includes("/commands") ? commandResponse(body) : clone(body)),
        id: String(next++),
      };
      if (route.includes("/messages")) {
        resource.author = { id: env.clientId };
        resource.channel_id = route.split("/")[2];
        resource.pinned = false;
        messages.set(`${route}/${resource.id}`, resource);
      } else list(route).push(resource);
      return clone(resource);
    },
    patch: async (route, body) => {
      writes.push(["patch", route]);
      let target = messages.get(route);
      if (!target)
        target =
          route === `/guilds/${env.guildId}`
            ? state.guild
            : list(route).find((entry) => entry.id === route.split("/").pop());
      assert.ok(target, route);
      Object.assign(target, clone(body));
      return clone(target);
    },
    put: async (route, body) => {
      writes.push(["put", route]);
      if (route.endsWith("/onboarding")) {
        const existing = state.onboarding?.prompts ?? [];
        const prompts = body.prompts.map((prompt) => {
          assert.match(prompt.id ?? "", /^\d{17,20}$/);
          const previous = existing.find((entry) => entry.id === prompt.id);
          return {
            ...clone(prompt),
            id: previous?.id ?? String(next++),
            options: prompt.options.map((option) => ({
              ...clone(option),
              id: option.id ?? String(next++),
            })),
          };
        });
        state.onboarding = {
          ...clone(body),
          prompts,
          default_channel_ids: [...body.default_channel_ids].reverse(),
          guild_id: env.guildId,
        };
        return clone(state.onboarding);
      }
      const message = [...messages.values()].find(
        (entry) => route === Routes.channelPin(entry.channel_id, entry.id),
      );
      if (message) {
        if (state.channels.find((channel) => channel.id === message.channel_id)?.type === 2)
          throw Object.assign(Error("This message cannot be pinned in this channel"), {
            code: 50019,
          });
        message.pinned = true;
      }
      return {};
    },
    delete: async () => {
      throw Error("Unexpected deletion");
    },
  };
  const config = loadConfig();
  const plan = (phase) => buildPlan(api, clone(state), store, config, env, phase);
  const apply = (value, options = { allowSensitive: true, allowDrift: false }) =>
    applyPlan(value, value.hash, clone(state), store, config, env, api, options);
  return { store, env, state, messages, writes, api, config, plan, apply };
}

test("repeated core, community, and content deployment updates only mapped resources and creates no duplicates", async (t) => {
  const f = setup(t);
  for (const phase of ["core", "community", "content"]) {
    const plan = await f.plan(phase);
    assert.deepEqual(plan.conflicts, []);
    await f.apply(plan);
    if (phase === "core")
      f.state.roles.find((role) => role.id === f.store.id("role.moderator")).permissions =
        moderatorPermissions;
    const repeated = await f.plan(phase);
    assert.deepEqual(repeated.conflicts, []);
    assert.ok(
      repeated.changes.every((change) => change.action === "keep"),
      JSON.stringify(repeated.changes.filter((change) => change.action !== "keep")),
    );
    const before = f.writes.length;
    await f.apply(repeated);
    assert.equal(f.writes.length, before);
  }
  assert.equal(f.state.channels.length, 22);
  assert.equal(f.state.roles.length, 12);
  assert.equal(f.state.automod.length, 2);
  assert.equal(f.state.commands.length, commands().length);
  assert.ok(
    [...f.messages.values()].every(
      (message) => !message.content.includes("@{") && !message.content.includes("{{"),
    ),
  );
  const audit = auditPermissions(f.state, f.store, f.config);
  assert.deepEqual(audit.failures, []);
});

test("publishing repairs a failed text pin without duplicate messages and leaves voice notes unpinned", async (t) => {
  const f = setup(t);
  await f.apply(await f.plan("core"));
  await f.apply(await f.plan("community"));
  const put = f.api.put;
  f.api.put = async (route, body) => {
    if (route.includes("/pins/")) {
      f.api.put = put;
      throw Object.assign(Error("temporary pin failure"), { status: 503 });
    }
    return put(route, body);
  };
  await assert.rejects(f.apply(await f.plan("content")), /pin failure/);
  const messageId = f.store.id("message.start.0");
  const repair = await f.plan("content");
  assert.equal(
    repair.changes.find((change) => change.item.key === "message.start.0").action,
    "update",
  );
  await f.apply(repair);
  assert.equal(f.store.id("message.start.0"), messageId);
  assert.equal(f.messages.size, publications(f.config).length);
  for (const message of f.messages.values())
    assert.equal(
      message.pinned,
      f.state.channels.find((channel) => channel.id === message.channel_id).type !== 2,
    );
  assert.ok((await f.plan("content")).changes.every((change) => change.action === "keep"));
});

test("onboarding sends IDs for new prompts and preserves assigned prompt and option IDs on updates", async (t) => {
  const f = setup(t);
  await f.apply(await f.plan("core"));
  await f.apply(await f.plan("community"));
  const previous = clone(f.state.onboarding.prompts);
  f.config.onboarding[0].options[0].description = "Updated description";
  const put = f.api.put;
  let updated = false;
  f.api.put = async (route, body) => {
    if (route.endsWith("/onboarding")) {
      updated = true;
      assert.deepEqual(
        body.prompts.map((prompt) => prompt.id),
        previous.map((prompt) => prompt.id),
      );
      assert.deepEqual(
        body.prompts.map((prompt) => prompt.options.map((option) => option.id)),
        previous.map((prompt) => prompt.options.map((option) => option.id)),
      );
    }
    return put(route, body);
  };
  await f.apply(await f.plan("community"));
  assert.equal(updated, true);
  assert.ok((await f.plan("community")).changes.every((change) => change.action === "keep"));
});

test("unordered Discord feature and default-channel lists do not invalidate approval, while changed membership does", async (t) => {
  const f = setup(t);
  f.state.guild.features = ["COMMUNITY", "NEWS"];
  const core = await f.plan("core");
  f.state.guild.features.reverse();
  await f.apply(core);
  await f.apply(await f.plan("community"));
  const resource = f.store.resource("guild.onboarding");
  const oldBaseline = JSON.parse(resource.baseline);
  oldBaseline.default_channel_ids.reverse();
  f.store.putResource(resource.key, resource.kind, resource.id, oldBaseline);
  const repeated = await f.plan("community");
  assert.ok(repeated.changes.every((change) => !change.drift));
  f.state.guild.features.reverse();
  f.state.onboarding.default_channel_ids.reverse();
  const before = f.writes.length;
  await f.apply(repeated);
  assert.equal(f.writes.length, before);
  f.state.onboarding.default_channel_ids.pop();
  await assert.rejects(f.apply(repeated), /state changed/);
});

test("configuration succeeds without granting the bot moderation powers and preserves owner-managed moderator rights", async (t) => {
  const f = setup(t);
  const post = f.api.post;
  const botPermissions = BigInt(bootstrapPermissions) | BigInt(memberPermissions);
  f.api.post = async (route, body) => {
    if (route.endsWith("/roles") && (BigInt(body.permissions ?? "0") & ~botPermissions) !== 0n)
      throw Object.assign(Error("Missing Permissions"), { code: 50013 });
    if (route.endsWith("/channels"))
      for (const overwrite of body.permission_overwrites ?? []) {
        const flags = BigInt(overwrite.allow) | BigInt(overwrite.deny);
        if ((flags & ~botPermissions) !== 0n || (flags & P.ManageRoles) !== 0n)
          throw Object.assign(Error("Missing Permissions"), { code: 50013 });
      }
    return post(route, body);
  };
  await f.apply(await f.plan("core"));
  const moderator = f.state.roles.find((role) => role.id === f.store.id("role.moderator"));
  assert.equal(moderator.permissions, "0");
  moderator.permissions = moderatorPermissions;
  const repeated = await f.plan("core");
  assert.deepEqual(repeated.conflicts, []);
  assert.ok(repeated.changes.every((change) => change.action === "keep" && !change.drift));
  await f.apply(repeated);
  assert.equal(moderator.permissions, moderatorPermissions);
});

test("the plan rejects modified hashes, stale Discord state, privacy edits without approval, and name collisions", async (t) => {
  const f = setup(t),
    plan = await f.plan("core");
  const tampered = clone(plan);
  tampered.changes[0].item.body.permissions = "8";
  await assert.rejects(f.apply(tampered), /hash/);
  await assert.rejects(f.apply(plan, { allowSensitive: false, allowDrift: false }), /sensitive/);
  f.state.guild.name = "changed";
  await assert.rejects(f.apply(plan), /state changed/);
  f.state.roles.push({ id: "100000000000000009", name: "Programowanie", permissions: "8" });
  const conflicted = await f.plan("core");
  assert.ok(conflicted.conflicts.some((conflict) => conflict.includes("same name")));
  await assert.rejects(f.apply(conflicted), /conflicts/);
  assert.equal(f.writes.length, 0);
});

test("manual text edits are surfaced and publishing never modifies a member's message", async (t) => {
  const f = setup(t);
  await f.apply(await f.plan("core"));
  await f.apply(await f.plan("community"));
  await f.apply(await f.plan("content"));
  const target = [...f.messages.values()][0];
  target.content = "Human edited this managed message";
  const changed = await f.plan("content");
  assert.ok(changed.changes.some((change) => change.drift));
  await assert.rejects(f.apply(changed), /Human changes/);
  target.author.id = "100000000000000099";
  const foreign = await f.plan("content");
  assert.ok(foreign.conflicts.some((conflict) => conflict.includes("not owned")));
  await assert.rejects(f.apply(foreign), /conflicts/);
});

test("ambiguous API errors leave a journal and block automatic retries", async (t) => {
  const f = setup(t),
    plan = await f.plan("core");
  f.api.post = async () => {
    throw Object.assign(Error("rate limited"), { status: 429 });
  };
  await assert.rejects(f.apply(plan));
  assert.equal(f.store.operations().length, 1);
  const next = await f.plan("core");
  assert.ok(next.conflicts.some((conflict) => conflict.includes("Unfinished")));
  await assert.rejects(f.apply(next), /conflicts|state changed/);
});

test("comparison includes the alert destination instead of comparing only the first AutoMod action", () => {
  const shape = { actions: [{ type: 1 }, { type: 2, metadata: { channel_id: "expected" } }] };
  assert.deepEqual(
    project({ actions: [{ type: 1 }, { type: 2, metadata: { channel_id: "other" } }] }, shape),
    { actions: [{ type: 1 }, { type: 2, metadata: { channel_id: "other" } }] },
  );
});
