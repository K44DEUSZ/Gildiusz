import assert from "node:assert/strict";
import test from "node:test";
import {
  ButtonStyle,
  ChannelType,
  Collection,
  ComponentType,
  GuildFeature,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { ModuleSettingsStore } from "../dist/core/modules/settings.js";
import { serverRulesMigration } from "../dist/modules/server-rules/schema.js";
import { rulesControlId } from "../dist/modules/server-rules/content.js";
import {
  ServerRulesRuntime,
  discordRulesPorts,
  rulesAcceptanceText,
} from "../dist/bot/server-rules-runtime.js";
import { serverRulesInteraction } from "../dist/bot/server-rules-interactions.js";
const { AbortController } = globalThis;

const guildId = "100000000000000001",
  actorId = "100000000000000002",
  userId = "100000000000000003",
  botId = "100000000000000004",
  roleId = "100000000000000005",
  botRoleId = "100000000000000006",
  channelId = "100000000000000007";
const flags = (value = 0n) => new PermissionsBitField(value);
function fixture(t) {
  const store = new Store(":memory:", guildId),
    jobs = new JobStore(store.db);
  if (
    !store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_rules_settings'")
      .get()
  )
    store.db.exec(serverRulesMigration.sql);
  t.after(() => store.close());
  const reads = [],
    writes = [],
    messages = new Map(),
    members = new Map();
  const guild = {
    id: guildId,
    ownerId: actorId,
    features: [],
    async fetch() {
      reads.push("guild");
      return this;
    },
  };
  const role = (id, position, permissions = 0n, managed = false) => ({
    id,
    guild,
    position,
    permissions: flags(permissions),
    managed,
    tags: null,
  });
  const roles = new Map([
    [guildId, role(guildId, 0, P.ViewChannel | P.ReadMessageHistory | P.SendMessages)],
    [roleId, role(roleId, 1)],
    [botRoleId, role(botRoleId, 2, P.ManageRoles, true)],
  ]);
  guild.roles = {
    async fetch() {
      reads.push("roles");
      return roles;
    },
  };
  const member = (id, roleIds, admin = false) => ({
    id,
    voice: { channelId: null },
    user: { bot: id === botId },
    pending: false,
    joinedTimestamp: Date.now() - 60000,
    roles: { cache: new Map(roleIds.map((id) => [id, roles.get(id)])) },
    permissions: flags(admin ? P.ManageGuild : 0n),
    isCommunicationDisabled() {
      return false;
    },
  });
  members.set(actorId, member(actorId, [], true));
  members.set(userId, member(userId, []));
  members.set(botId, member(botId, [botRoleId]));
  guild.members = {
    async fetch({ user, force }) {
      assert.equal(force, true);
      reads.push("member:" + user);
      if (!members.has(user)) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
      return members.get(user);
    },
    async fetchMe({ force }) {
      assert.equal(force, true);
      reads.push("me");
      return members.get(botId);
    },
  };
  const channel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    permissionOverwrites: {
      cache: new Map([
        [
          guildId,
          {
            id: guildId,
            type: 0,
            allow: flags(),
            deny: flags(
              P.SendMessages |
                P.SendMessagesInThreads |
                P.CreatePublicThreads |
                P.CreatePrivateThreads,
            ),
          },
        ],
        [
          botRoleId,
          { id: botRoleId, type: 0, allow: flags(P.SendMessages | P.AddReactions), deny: flags() },
        ],
      ]),
    },
    messages: {
      async fetch({ message, force, cache }) {
        assert.equal(force, true);
        assert.equal(cache, false);
        reads.push("message:" + message);
        if (!messages.has(message))
          throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        return messages.get(message);
      },
    },
  };
  guild.channels = {
    async fetch(id, options) {
      reads.push("channels");
      if (id === undefined) return new Map([[channelId, channel]]);
      assert.equal(options.force, true);
      return id === channelId ? channel : null;
    },
  };
  const context = {
    guild,
    client: { user: { id: botId } },
    store: {
      db: store.db,
      resource() {
        return undefined;
      },
    },
    control: { reactions: { choices: [] } },
  };
  const settings = new ModuleSettingsStore(store.db, guildId);
  const rest = {
    async post(route, options) {
      writes.push({ method: "POST", route, options });
      const id = String(500000000000000001n + BigInt(messages.size));
      messages.set(id, {
        id,
        guildId,
        channelId,
        author: { id: botId },
        webhookId: null,
        content: options.body.content,
        components: options.body.components.map((row) => ({
          type: row.type,
          components: row.components.map((c) => ({
            type: c.type,
            style: c.style,
            label: c.label,
            customId: c.custom_id,
            disabled: false,
          })),
        })),
        reactions: { cache: new Collection() },
      });
      return { id, channel_id: channelId };
    },
    async put(route, options) {
      writes.push({ method: "PUT", route, options });
      if (route.includes("/roles/")) {
        members.get(userId).roles.cache.set(roleId, roles.get(roleId));
      } else {
        const parts = route.split("/"),
          message = messages.get(parts[4]);
        const emoji = decodeURIComponent(parts[6]);
        message.reactions.cache.set(emoji, { me: true, emoji: { id: null, name: emoji } });
      }
    },
    async patch(route, options) {
      writes.push({ method: "PATCH", route, options });
      messages.get(route.split("/")[4]).components = [];
    },
  };
  const ports = discordRulesPorts(context, settings, rest),
    runtime = new ServerRulesRuntime(context, jobs, settings, rest, true);
  const draft = (extra = {}) => ({
    channelId,
    roleId,
    label: "1",
    content: "Szanuj innych.",
    method: "button",
    emoji: null,
    ...extra,
  });
  return {
    store,
    jobs,
    context,
    guild,
    members,
    roles,
    channel,
    settings,
    rest,
    ports,
    runtime,
    reads,
    writes,
    messages,
    draft,
  };
}
async function pump(f) {
  for (let i = 0; i < 15; i++) {
    const [job] = f.jobs.claim({ guildId, limit: 1 });
    if (!job) return;
    const controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      now: Date.now,
      checkpoint() {},
      beginAttempt(input) {
        f.jobs.beginAttempt(job.id, job.leaseToken, input);
      },
    };
    const outcome = await f.runtime.execute(job, ctx);
    if (outcome.state === "succeeded") f.jobs.complete(job.id, job.leaseToken, outcome);
    else if (outcome.state === "failed") f.jobs.fail(job.id, job.leaseToken, outcome.error);
    else if (outcome.state === "unknown") f.jobs.unknown(job.id, job.leaseToken, outcome.error);
    else assert.fail(JSON.stringify(outcome));
  }
  assert.fail("job pump exceeded bounded work");
}
async function publish(f, draft = f.draft()) {
  const saved = await f.runtime.request(
    actorId,
    "rules.configure",
    { revision: 0, enabled: true, draft },
    undefined,
    "configure",
  );
  const result = await f.runtime.request(
    actorId,
    "rules.publish",
    { revision: saved.settings.revision },
    undefined,
    "publish",
  );
  await pump(f);
  return result.version;
}

test("Discord adapter snapshots fresh ACL and retains unknown native screening state", async (t) => {
  const f = fixture(t),
    facts = await f.ports.preflight();
  assert.equal(facts.complete, true);
  assert.equal(facts.nativeScreening, false);
  assert.equal(facts.channels[0].overwrites[0].deny & P.SendMessages, P.SendMessages);
  assert.ok(f.reads.includes("roles") && f.reads.includes("me") && f.reads.includes("channels"));
  f.members.get(userId).pending = null;
  assert.equal((await f.ports.member(userId)).pending, false);
  f.guild.features = [GuildFeature.MemberVerificationGateEnabled];
  assert.equal((await f.ports.member(userId)).pending, null);
  f.members.delete(userId);
  assert.equal(await f.ports.member(userId), null);
});

test("rules runtime publishes one bound button, defers grant, and only PUTs the selected role", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    message = [...f.messages.values()][0];
  const posts = f.writes.filter((w) => w.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].options.body.allowed_mentions, { parse: [], users: [], roles: [] });
  assert.equal(posts[0].options.body.enforce_nonce, true);
  assert.equal(message.components[0].components[0].type, ComponentType.Button);
  assert.equal(message.components[0].components[0].style, ButtonStyle.Primary);
  assert.equal(message.components[0].components[0].customId, rulesControlId(guildId, version.id));
  const accepted = await f.runtime.button(
    userId,
    channelId,
    message.id,
    rulesControlId(guildId, version.id),
  );
  assert.equal(accepted.grantState, "pending");
  assert.match(rulesAcceptanceText(accepted), /Trwa nadawanie/);
  await pump(f);
  assert.equal(f.writes.filter((w) => w.method === "PUT").length, 1);
  assert.equal(f.writes.at(-1).route, `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  assert.equal(f.writes.at(-1).options.body, undefined);
  assert.equal(
    (await f.runtime.button(userId, channelId, message.id, rulesControlId(guildId, version.id)))
      .grantState,
    "confirmed",
  );
  await pump(f);
  assert.equal(f.writes.filter((w) => w.method === "PUT").length, 1);
  const view = await f.runtime.request(actorId, "rules.read", {});
  assert.equal(view.versions[0].parts[0].messageId, message.id);
  await assert.rejects(f.runtime.request(userId, "rules.acceptances.list", {}), { status: 403 });
  const page = await f.runtime.request(actorId, "rules.acceptances.list", { limit: 1 });
  assert.equal(page.acceptances[0].userId, userId);
});

test("reaction acceptance uses a separate encoded seed PUT and removing a reaction never removes membership", async (t) => {
  const f = fixture(t);
  await publish(f, f.draft({ method: "reaction", emoji: "✅" }));
  const message = [...f.messages.values()][0];
  assert.equal(f.writes[0].method, "POST");
  assert.deepEqual(f.writes[0].options.body.components, []);
  assert.equal(f.writes[1].method, "PUT");
  assert.match(f.writes[1].route, /%E2%9C%85\/@me$/);
  await f.runtime.reaction(userId, channelId, message.id, "❎", true);
  assert.equal(f.jobs.list({ type: "server-rules.grant-role" }).length, 0);
  await f.runtime.reaction(userId, channelId, message.id, "✅", true);
  await pump(f);
  const count = f.writes.length;
  await f.runtime.reaction(userId, channelId, message.id, "✅", false);
  assert.equal(f.writes.length, count);
  assert.ok(f.members.get(userId).roles.cache.has(roleId));
});

test("native pending and forged cross-guild controls cannot grant roles", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    message = [...f.messages.values()][0];
  f.members.get(userId).pending = true;
  await assert.rejects(
    f.runtime.button(userId, channelId, message.id, rulesControlId(guildId, version.id)),
    { code: "native_pending" },
  );
  f.members.get(userId).pending = false;
  await assert.rejects(
    f.runtime.button(
      userId,
      channelId,
      message.id,
      rulesControlId("200000000000000001", version.id),
    ),
    { code: "invalid_input" },
  );
  assert.equal(f.jobs.list({ type: "server-rules.grant-role" }).length, 0);
});

test("button responses stay ephemeral and never claim a queued grant is confirmed", async () => {
  const calls = [],
    interaction = {
      customId: "gildiusz:rules:any",
      guildId,
      channelId,
      user: { id: userId, bot: false },
      message: { id: "500000000000000001" },
      isButton() {
        return true;
      },
      async deferReply(value) {
        calls.push(value);
      },
      async editReply(value) {
        calls.push(value);
      },
    };
  assert.equal(
    await serverRulesInteraction(
      {
        context: { guild: { id: guildId } },
        async button() {
          return { grantState: "pending" };
        },
      },
      interaction,
    ),
    true,
  );
  assert.equal(calls[0].flags, 64);
  assert.match(calls[1].content, /Trwa nadawanie/);
  assert.deepEqual(calls[1].allowedMentions, { parse: [] });
});

test("acceptance work deduplicates active clicks and bounds concurrent Discord lookups", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    message = [...f.messages.values()][0];
  let release,
    calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.runtime.service.accept = async () => {
    calls++;
    await gate;
    return { grantState: "pending" };
  };
  const control = rulesControlId(guildId, version.id);
  const first = f.runtime.button(userId, channelId, message.id, control);
  const duplicate = f.runtime.button(userId, channelId, message.id, control);
  const others = [1, 2, 3].map((index) =>
    f.runtime.button(String(200000000000000001n + BigInt(index)), channelId, message.id, control),
  );
  await assert.rejects(f.runtime.button("300000000000000001", channelId, message.id, control), {
    status: 429,
  });
  release();
  await Promise.all([first, duplicate, ...others]);
  assert.equal(calls, 4);
  await f.runtime.button(userId, channelId, message.id, control);
  assert.equal(calls, 5, "settled operations release their slot");
});

test("uninstalled runtime drops late observations and cannot accept new member actions", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    message = [...f.messages.values()][0];
  f.runtime.stop();
  await assert.rejects(
    f.runtime.button(userId, channelId, message.id, rulesControlId(guildId, version.id)),
    { status: 409, code: "module_unavailable" },
  );
  await f.runtime.reaction(userId, channelId, message.id, "✅", true);
  await f.runtime.memberChanged(userId);
  assert.equal(f.jobs.list({ type: "server-rules.grant-role" }).length, 0);
});

test("membership reconciliation distinguishes a REST outage from confirmed absence", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    message = [...f.messages.values()][0];
  await f.runtime.button(userId, channelId, message.id, rulesControlId(guildId, version.id));
  await pump(f);
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async () => {
    throw Object.assign(new Error("network"), { code: "ECONNRESET" });
  };
  await assert.rejects(f.runtime.memberChanged(userId), { code: "ECONNRESET" });
  assert.equal(
    f.jobs.db.prepare("SELECT left_at FROM server_rules_memberships WHERE user_id=?").get(userId)
      .left_at,
    null,
  );
  f.guild.members.fetch = fetch;
  f.members.delete(userId);
  await f.runtime.memberChanged(userId);
  assert.equal(
    typeof f.jobs.db
      .prepare("SELECT left_at FROM server_rules_memberships WHERE user_id=?")
      .get(userId).left_at,
    "number",
  );
});

test("a newer fresh membership observation fences a late absent response", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    message = [...f.messages.values()][0];
  await f.runtime.button(userId, channelId, message.id, rulesControlId(guildId, version.id));
  await pump(f);
  const fetch = f.guild.members.fetch;
  let release,
    started,
    count = 0;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    entered = new Promise((resolve) => {
      started = resolve;
    });
  f.guild.members.fetch = async (input) => {
    if (input.user === userId && count++ === 0) {
      started();
      await gate;
      throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    }
    return fetch(input);
  };
  const old = f.runtime.memberChanged(userId);
  await entered;
  await f.runtime.memberChanged(userId);
  release();
  await old;
  assert.equal(
    f.jobs.db.prepare("SELECT left_at FROM server_rules_memberships WHERE user_id=?").get(userId)
      .left_at,
    null,
  );
});

test("turning beta effects off does not stop read-only departure retention", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    message = [...f.messages.values()][0];
  await f.runtime.button(userId, channelId, message.id, rulesControlId(guildId, version.id));
  await pump(f);
  const writesBefore = f.writes.length;
  const disabled = new ServerRulesRuntime(f.context, f.jobs, f.settings, f.rest, false);
  assert.equal(disabled.service, undefined);
  assert.ok(disabled.retention);
  f.members.delete(userId);
  await disabled.sweepMemberships();
  const row = f.jobs.db
    .prepare("SELECT left_at FROM server_rules_memberships WHERE user_id=?")
    .get(userId);
  assert.equal(typeof row.left_at, "number");
  const readsAfter = f.reads.length;
  await disabled.sweepMemberships();
  assert.equal(f.reads.length, readsAfter, "repeat ticks respect the bounded observation interval");
  assert.equal(f.writes.length, writesBefore, "retention must not create Discord effects");
  await assert.rejects(disabled.request(actorId, "rules.read", {}), { code: "module_unavailable" });
});
