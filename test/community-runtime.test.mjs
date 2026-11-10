import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import {
  ChannelType,
  DiscordjsError,
  GuildChannelManager,
  PermissionFlagsBits as P,
  PermissionsBitField,
  RateLimitError,
} from "discord.js";
import { Store } from "../dist/storage/store.js";
import { ModuleRuntime } from "../dist/bot/module-runtime.js";
import { JobRunner } from "../dist/core/jobs/runner.js";

const guildId = "700000000000000001",
  ownerId = "700000000000000002",
  botId = "700000000000000003",
  staffId = "700000000000000004",
  userId = "700000000000000005",
  otherId = "700000000000000006",
  staffRole = "700000000000000011",
  organizerRole = "700000000000000012",
  newStaffRole = "700000000000000013",
  categoryId = "700000000000000021",
  textId = "700000000000000022",
  suggestionId = "700000000000000023",
  existingVoice = "700000000000000024";
const access = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.Connect;
const flags = (value) => new PermissionsBitField(value);
const error = (code, status = 404) => Object.assign(Error(String(code)), { code, status });
async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-09T12:00:00Z") });
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-community-")),
    calls = [],
    people = new Map(),
    channels = new Map(),
    roles = new Map(),
    messages = new Map();
  let store = new Store(join(directory, "guild.sqlite"), guildId);
  const state = {
    postError: null,
    patchError: null,
    deleteError: null,
    memberError: null,
    loosenAcl: false,
    connected: true,
  };
  let next = 710000000000000000n;
  for (const id of [guildId, staffRole, organizerRole, newStaffRole])
    roles.set(id, { id, name: "Rola", mentionable: false, managed: false, permissions: flags(0n) });
  const person = (id, roleIds = [], permissions = 0n) => ({
    id,
    user: { id, bot: id === botId },
    displayName: `Osoba ${id.slice(-2)}`,
    roles: { cache: new Map(roleIds.map((role) => [role, roles.get(role)])) },
    permissions: flags(permissions),
    voice: { channelId: null },
    pending: false,
    timedOut: false,
    isCommunicationDisabled() {
      return this.timedOut;
    },
  });
  people.set(ownerId, person(ownerId, [], P.ManageGuild));
  people.set(botId, person(botId, [], P.ManageChannels | P.ManageRoles));
  people.set(staffId, person(staffId, [staffRole, organizerRole]));
  people.set(userId, person(userId));
  people.set(otherId, person(otherId, [newStaffRole]));
  function makeChannel(id, type, parentId = null, overwrites = []) {
    const channel = {
      id,
      guildId,
      type,
      parentId,
      name: `Kanał ${id.slice(-2)}`,
      members: new Map(),
      permissionOverwrites: { cache: new Map() },
      permissionsFor(subject) {
        if (!subject) return null;
        if (subject.id === ownerId) return flags(P.Administrator);
        let bits = access | (subject.id === botId ? P.ManageChannels | P.ManageRoles : 0n);
        const apply = (overwrite) => {
          if (overwrite) bits = (bits & ~overwrite.deny.bitfield) | overwrite.allow.bitfield;
        };
        apply(this.permissionOverwrites.cache.get(guildId));
        let deny = 0n,
          allow = 0n;
        for (const role of subject.roles?.cache.keys() ?? []) {
          const overwrite = this.permissionOverwrites.cache.get(role);
          if (overwrite) {
            deny |= overwrite.deny.bitfield;
            allow |= overwrite.allow.bitfield;
          }
        }
        bits = (bits & ~deny) | allow;
        apply(this.permissionOverwrites.cache.get(subject.id));
        return flags(bits);
      },
    };
    channel.permissionOverwrites.cache = new Map(
      overwrites.map((value) => [
        value.id,
        {
          id: value.id,
          type: value.type,
          allow: flags(BigInt(value.allow)),
          deny: flags(BigInt(value.deny)),
        },
      ]),
    );
    channels.set(id, channel);
    return channel;
  }
  makeChannel(categoryId, ChannelType.GuildCategory);
  makeChannel(textId, ChannelType.GuildText);
  makeChannel(suggestionId, ChannelType.GuildText);
  makeChannel(existingVoice, ChannelType.GuildVoice, categoryId);
  const guild = {
    id: guildId,
    ownerId,
    available: true,
    async fetch() {
      calls.push({ method: "fresh-guild" });
      return this;
    },
    roles: {
      cache: roles,
      everyone: roles.get(guildId),
      async fetch() {
        calls.push({ method: "fresh-roles" });
        return roles;
      },
    },
    members: {
      cache: people,
      async fetch(input) {
        assert.equal(input.force, true);
        calls.push({ method: "fresh-member", id: input.user });
        if (state.memberError) throw state.memberError;
        const member = people.get(input.user);
        if (!member) throw error(10007);
        return member;
      },
      async fetchMe(input) {
        assert.equal(input.force, true);
        return people.get(botId);
      },
    },
    channels: {
      cache: channels,
      async fetch(id, input) {
        if (id === undefined) return channels;
        assert.equal(input.force, true);
        calls.push({ method: "fresh-channel", id });
        return channels.get(id) ?? null;
      },
    },
    voiceStates: { cache: new Map() },
  };
  const rest = {
    options: { retries: 0, rejectOnRateLimit: () => true },
    async post(route, options) {
      calls.push({ method: "POST", route, body: options.body });
      if (state.postError) throw state.postError;
      if (route === `/guilds/${guildId}/channels`) {
        if (
          options.body.permission_overwrites.some(
            (entry) => (BigInt(entry.allow) & P.ManageRoles) !== 0n,
          )
        )
          throw error(50013, 403);
        const id = (++next).toString(),
          body = options.body;
        makeChannel(
          id,
          body.type,
          body.parent_id,
          state.loosenAcl ? [] : body.permission_overwrites,
        );
        return { id };
      }
      const match = /^\/channels\/(\d+)\/messages$/.exec(route);
      if (match) {
        if (!channels.has(match[1])) throw error(10003);
        const id = (++next).toString();
        messages.set(id, {
          id,
          channelId: match[1],
          authorId: botId,
          content: options.body.content,
          components: options.body.components,
        });
        return { id };
      }
      throw Error(`Unexpected POST ${route}`);
    },
    async patch(route, options) {
      calls.push({ method: "PATCH", route, body: options.body });
      if (state.patchError) throw state.patchError;
      const channelMatch = /^\/channels\/(\d+)$/.exec(route);
      if (channelMatch) {
        if (
          options.body.permission_overwrites.some(
            (entry) => (BigInt(entry.allow) & P.ManageRoles) !== 0n,
          )
        )
          throw error(50013, 403);
        const prior = channels.get(channelMatch[1]);
        if (!prior) throw error(10003);
        const updated = makeChannel(
          prior.id,
          prior.type,
          prior.parentId,
          options.body.permission_overwrites,
        );
        updated.members = prior.members;
        return { id: prior.id };
      }
      const messageMatch = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route);
      if (messageMatch) {
        if (!messages.has(messageMatch[2])) throw error(10008);
        messages.set(messageMatch[2], {
          ...messages.get(messageMatch[2]),
          id: messageMatch[2],
          channelId: messageMatch[1],
          ...options.body,
        });
        return { id: messageMatch[2] };
      }
      throw Error(`Unexpected PATCH ${route}`);
    },
    async delete(route) {
      calls.push({ method: "DELETE", route });
      if (state.deleteError) throw state.deleteError;
      const channel = channels.get(route.split("/")[2]);
      if (!channel) throw error(10003);
      assert.ok([...channel.members.values()].every((member) => member.user.bot));
      channels.delete(channel.id);
    },
    async get(route) {
      calls.push({ method: "GET", route });
      const match = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route),
        message = match && messages.get(match[2]);
      if (!message || message.channelId !== match[1]) throw error(10008);
      return { ...message, channel_id: message.channelId, author: { id: message.authorId } };
    },
  };
  const context = {
    config: { rooms: { maximum: 45 } },
    guild,
    store,
    environment: { clientId: botId },
    client: { user: { id: botId }, isReady: () => state.connected, ws: { status: 0 } },
    control: {
      rooms: { maxRooms: 45, categoryId, userLimit: 0 },
      modules: { rooms: true, reactions: true, files: true, reports: true },
    },
  };
  let runtime = new ModuleRuntime(context, rest, options.beta ?? true);
  runtime.settings.save(
    {
      ...runtime.settings.read(),
      organizerRoleIds: [organizerRole],
      caseModeratorRoleIds: [staffRole],
      enabled: { ...runtime.settings.read().enabled, meetings: true, cases: true },
      cases: {
        categoryId: options.noCategory ? "" : categoryId,
        suggestionChannelId: suggestionId,
        suggestionVisibility: "approval",
        voting: { enabled: true, statuses: ["new", "in_review"] },
        reasonRequiredStatuses: ["accepted", "rejected"],
        retentionMs: null,
      },
    },
    ownerId,
  );
  const startRunner = () =>
    new JobRunner(
      () => [{ guildId, store: runtime.jobs, available: () => true }],
      (job, execution) => runtime.execute(job, execution),
    );
  let runner = startRunner();
  t.after(async () => {
    await runner.stop();
    store.close();
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-community-")
    )
      throw Error("Unexpected fixture directory");
    rmSync(directory, { recursive: true, force: true });
  });
  const actor = (id) => ({
    guildId,
    userId: id,
    owner: true,
    manageGuild: true,
    roleIds: [],
    pending: false,
    timedOut: false,
    isBot: false,
  });
  const request = (id, operation, payload = {}, objectId, requestId) =>
    runtime.request(actor(id), operation, payload, objectId, requestId);
  const drain = async (count = 12) => {
    for (let i = 0; i < count; i++) {
      await runner.tick();
      t.mock.timers.tick(1000);
    }
  };
  return {
    get runtime() {
      return runtime;
    },
    get runner() {
      return runner;
    },
    get store() {
      return store;
    },
    rest,
    channels,
    people,
    roles,
    calls,
    messages,
    state,
    makeChannel,
    request,
    actor,
    drain,
    restart: async () => {
      await runner.stop();
      store.close();
      store = new Store(join(directory, "guild.sqlite"), guildId);
      context.store = store;
      runtime = new ModuleRuntime(context, rest, options.beta ?? true);
      runner = startRunner();
    },
    advance: (ms) => t.mock.timers.tick(ms),
    meeting: (extra = {}) => ({
      title: "Wieczorny projekt",
      description: "Przegląd tego, co zrobiliśmy.",
      capacity: 2,
      startsAt: Date.now() + 3600000,
      endsAt: Date.now() + 7200000,
      channelId: textId,
      visibility: "public",
      room: { kind: "none" },
      reminderMinutes: [],
      ...extra,
    }),
    case: (extra = {}) => ({
      kind: "report",
      title: "Prywatna sprawa",
      content: "PRIVATE_BODY",
      ...extra,
    }),
  };
}

test("beta and explicit implementation gates keep unavailable modules from operating", async (t) => {
  const f = await fixture(t, { beta: false });
  assert.equal(
    f.runtime.capabilities().modules.find((value) => value.key === "cases").availability,
    "planned",
  );
  await assert.rejects(
    f.request(userId, "cases.create", f.case(), undefined, "disabled"),
    (error) => error.code === "module_unavailable",
  );
  assert.equal(f.calls.filter((value) => value.method === "POST").length, 0);
});
test("requests use current roles rather than caller flags and never cross guild boundaries", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.request(userId, "meetings.create", f.meeting(), undefined, "forged-admin"),
    (error) => error.status === 403,
  );
  const saved = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create");
  f.people.get(staffId).roles.cache.clear();
  await assert.rejects(
    f.request(staffId, "meetings.create", f.meeting(), undefined, "revoked-role"),
    (error) => error.status === 403,
  );
  await assert.rejects(
    f.runtime.request(
      { ...f.actor(ownerId), guildId: "799999999999999999" },
      "meetings.read",
      {},
      saved.meeting.id,
    ),
    (error) => error.status === 404,
  );
  assert.ok(f.calls.some((value) => value.method === "fresh-member" && value.id === staffId));
});
test("meeting lifecycle publishes, updates and exposes per-object actions with redacted jobs", async (t) => {
  const f = await fixture(t);
  const created = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create");
  await f.drain(2);
  const sent = f.calls.find(
    (value) => value.method === "POST" && value.route.includes("/messages"),
  );
  assert.equal(sent.body.enforce_nonce, true);
  assert.deepEqual(sent.body.allowed_mentions.parse, []);
  assert.deepEqual(
    sent.body.components[0].components.map((button) => [button.label, button.custom_id]),
    [
      ["Dołącz", `gildiusz:meeting:${guildId}:${created.meeting.id}:join`],
      ["Rezygnuję", `gildiusz:meeting:${guildId}:${created.meeting.id}:leave`],
      ["Szczegóły", `gildiusz:meeting:${guildId}:${created.meeting.id}:read`],
    ],
  );
  const detail = await f.request(userId, "meetings.read", {}, created.meeting.id);
  assert.ok(detail.allowedOperations.includes("meetings.join"));
  assert.ok(!detail.allowedOperations.includes("meetings.cancel"));
  assert.ok(
    detail.jobs.every(
      (job) =>
        !Object.hasOwn(job, "payload") &&
        !Object.hasOwn(job, "leaseToken") &&
        !Object.hasOwn(job, "result"),
    ),
  );
  await f.request(userId, "meetings.join", {}, created.meeting.id, "join");
  await f.drain(2);
  const fullCard = f.calls.findLast(
    (value) => value.method === "PATCH" && value.route.includes("/messages/"),
  );
  assert.equal(fullCard.body.components[0].components[0].label, "Dołącz do rezerwy");
  assert.deepEqual(fullCard.body.allowed_mentions, {
    parse: [],
    roles: [],
    users: [],
    replied_user: false,
  });
  const fresh = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  await f.request(
    staffId,
    "meetings.start",
    { revision: fresh.meeting.revision },
    created.meeting.id,
    "start",
  );
  await f.drain(3);
  const active = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  assert.equal(active.meeting.state, "active");
  const activeCard = f.calls.findLast(
    (value) => value.method === "PATCH" && value.route.includes("/messages/"),
  );
  assert.deepEqual(
    activeCard.body.components[0].components.map((button) => button.custom_id.split(":").at(-1)),
    ["leave", "read"],
  );
  await f.request(
    staffId,
    "meetings.complete",
    { revision: active.meeting.revision },
    created.meeting.id,
    "complete",
  );
  await f.drain(3);
  assert.equal(
    (await f.request(staffId, "meetings.read", {}, created.meeting.id)).meeting.state,
    "completed",
  );
  const completedCard = f.calls.findLast(
    (value) => value.method === "PATCH" && value.route.includes("/messages/"),
  );
  assert.deepEqual(completedCard.body.components, []);
  assert.match(completedCard.body.content, /Zakończone/);
  assert.equal(
    f.calls.filter((value) => value.method === "POST" && value.route.endsWith("/messages")).length,
    1,
  );
});

test("cancellation clears the existing Discord card instead of leaving actionable buttons", async (t) => {
  const f = await fixture(t),
    created = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create");
  await f.drain(2);
  const current = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  await f.request(
    staffId,
    "meetings.cancel",
    { revision: current.meeting.revision },
    created.meeting.id,
    "cancel",
  );
  await f.drain(3);
  const update = f.calls.findLast(
    (value) => value.method === "PATCH" && value.route.includes("/messages/"),
  );
  assert.equal(update.route, `/channels/${textId}/messages/${current.meeting.messageId}`);
  assert.deepEqual(update.body.components, []);
  assert.match(update.body.content, /Odwołane/);
  assert.equal(
    f.calls.filter((value) => value.method === "POST" && value.route.endsWith("/messages")).length,
    1,
  );
});
test("private meeting cards are neutral on a common channel while lists filter each object", async (t) => {
  const f = await fixture(t);
  const saved = await f.request(
    staffId,
    "meetings.create",
    f.meeting({ visibility: "private" }),
    undefined,
    "private",
  );
  assert.equal((await f.request(userId, "meetings.list")).meetings.length, 0);
  assert.equal((await f.request(staffId, "meetings.list")).meetings.length, 1);
  await assert.rejects(
    f.request(userId, "meetings.read", {}, saved.meeting.id),
    (error) => error.status === 403,
  );
  await f.drain(4);
  const publication = f.calls.find(
    (call) => call.method === "POST" && call.route.endsWith("/messages"),
  );
  assert.match(publication.body.content, /Prywatne spotkanie/);
  assert.ok(!publication.body.content.includes(saved.meeting.title));
  assert.ok(!publication.body.content.includes(saved.meeting.description));
  assert.ok(!publication.body.content.includes("<t:"));
  assert.ok(!publication.body.content.includes(userId));
});

test("explicit people or current invited roles can discover a private meeting before joining", async (t) => {
  const f = await fixture(t),
    saved = await f.request(
      staffId,
      "meetings.create",
      f.meeting({
        visibility: "private",
        invitedUserIds: [userId],
        allowedRoleIds: [newStaffRole],
      }),
      undefined,
      "private-invites",
    );
  assert.equal(
    (await f.request(userId, "meetings.read", {}, saved.meeting.id)).meeting.id,
    saved.meeting.id,
  );
  assert.equal((await f.request(otherId, "meetings.list")).meetings.length, 1);
  const [first, second] = await Promise.all([
    f.request(userId, "meetings.join", {}, saved.meeting.id, "join-invite"),
    f.request(otherId, "meetings.join", {}, saved.meeting.id, "join-role"),
  ]);
  assert.equal(second.meeting.confirmedCount, 2);
  assert.equal(second.meeting.waitlistedCount, 1);
  const changed = await f.request(
    staffId,
    "meetings.update",
    {
      revision: first.meeting.revision,
      audience: { invitedUserIds: [], allowedRoleIds: [newStaffRole] },
    },
    saved.meeting.id,
    "withdraw-person",
  );
  assert.equal(changed.participants.find((person) => person.userId === userId).state, "left");
  assert.equal(changed.participants.find((person) => person.userId === otherId).state, "confirmed");
  await assert.rejects(
    f.request(userId, "meetings.read", {}, saved.meeting.id),
    (error) => error.status === 403,
  );
  assert.equal((await f.request(userId, "meetings.list")).meetings.length, 0);
  f.people.get(otherId).roles.cache.clear();
  await assert.rejects(
    f.request(otherId, "meetings.join", {}, saved.meeting.id, "revoked-role"),
    (error) => error.status === 403,
  );
  assert.equal((await f.request(otherId, "meetings.list")).meetings.length, 0);
});

test("invitation withdrawal updates an active owned room without resurrecting a role-only member grant", async (t) => {
  const f = await fixture(t),
    saved = await f.request(
      staffId,
      "meetings.create",
      f.meeting({
        visibility: "private",
        invitedUserIds: [userId],
        allowedRoleIds: [newStaffRole],
        room: { kind: "create", categoryId },
      }),
      undefined,
      "private-room",
    );
  await f.request(userId, "meetings.join", {}, saved.meeting.id, "join");
  await f.request(
    staffId,
    "meetings.start",
    { revision: saved.meeting.revision },
    saved.meeting.id,
    "start",
  );
  await f.drain(8);
  const active = await f.request(staffId, "meetings.read", {}, saved.meeting.id),
    room = f.channels.get(active.meeting.roomChannelId);
  assert.equal(
    f.calls.find((call) => call.method === "POST" && call.route.endsWith("/channels")).body.name,
    "Prywatne spotkanie",
  );
  assert.equal(room.permissionsFor(f.people.get(userId)).has(P.ViewChannel), true);
  assert.equal(room.permissionOverwrites.cache.has(otherId), false);
  await f.request(
    staffId,
    "meetings.update",
    {
      revision: active.meeting.revision,
      audience: { invitedUserIds: [], allowedRoleIds: [newStaffRole] },
    },
    saved.meeting.id,
    "revoke",
  );
  await f.drain(8);
  const updatedRoom = f.channels.get(active.meeting.roomChannelId);
  assert.equal(updatedRoom.permissionsFor(f.people.get(userId)).has(P.ViewChannel), false);
  assert.equal(updatedRoom.permissionOverwrites.cache.has(userId), false);
  assert.equal(updatedRoom.permissionOverwrites.cache.has(otherId), false);
  f.people.get(otherId).roles.cache.clear();
  assert.equal(updatedRoom.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), false);
});

test("a private invitation cannot bypass fresh channel access and prejoin reconciliation runs first", async (t) => {
  const f = await fixture(t),
    saved = await f.request(
      staffId,
      "meetings.create",
      f.meeting({ visibility: "private", invitedUserIds: [userId] }),
      undefined,
      "private",
    );
  let checked = false;
  f.runtime.community.setMembershipCheck(async (actorId) => {
    assert.equal(actorId, userId);
    checked = true;
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM meeting_participants WHERE user_id=?")
        .get(userId).n,
      0,
    );
    f.makeChannel(textId, ChannelType.GuildText, null, [
      { id: userId, type: 1, allow: "0", deny: P.ViewChannel.toString() },
    ]);
  });
  await assert.rejects(
    f.request(userId, "meetings.join", {}, saved.meeting.id, "join"),
    (error) => error.status === 403,
  );
  assert.equal(checked, true);
  assert.equal((await f.request(userId, "meetings.list")).meetings.length, 0);
});

test("security ACL revocation works while the module is off and the organizer's role is gone", async (t) => {
  const f = await fixture(t),
    saved = await f.request(
      staffId,
      "meetings.create",
      f.meeting({
        visibility: "private",
        invitedUserIds: [userId],
        room: { kind: "create", categoryId },
      }),
      undefined,
      "create",
    );
  await f.request(userId, "meetings.join", {}, saved.meeting.id, "join");
  await f.request(
    staffId,
    "meetings.start",
    { revision: saved.meeting.revision },
    saved.meeting.id,
    "start",
  );
  await f.drain(8);
  const active = await f.request(staffId, "meetings.read", {}, saved.meeting.id),
    roomId = active.meeting.roomChannelId;
  assert.equal(
    f.channels.get(roomId).permissionsFor(f.people.get(userId)).has(P.ViewChannel),
    true,
  );
  await f.request(
    ownerId,
    "settings.save",
    {
      scope: "modules",
      settings: {
        ...f.runtime.settings.read(),
        enabled: { ...f.runtime.settings.read().enabled, meetings: false },
      },
    },
    undefined,
    "off",
  );
  f.people.get(staffId).roles.cache.clear();
  f.people.delete(userId);
  const before = f.calls.filter(
    (call) => call.method === "POST" && call.route.endsWith("/messages"),
  ).length;
  await f.runtime.community.memberRemoved(userId, "departure", Date.now());
  await f.drain(8);
  assert.equal(f.channels.get(roomId).permissionOverwrites.cache.has(userId), false);
  assert.equal(
    f.calls.filter((call) => call.method === "POST" && call.route.endsWith("/messages")).length,
    before,
  );
  assert.deepEqual(
    f.runtime.community.meetings.systemDetail(saved.meeting.id).meeting.invitedUserIds,
    [],
  );
});

test("every private reminder and promotion is neutral even on a public channel", async (t) => {
  const f = await fixture(t),
    saved = await f.request(
      staffId,
      "meetings.create",
      f.meeting({
        title: "SECRET_TITLE",
        description: "SECRET_BODY",
        visibility: "private",
        invitedUserIds: [userId],
        capacity: 1,
        reminderMinutes: [30],
      }),
      undefined,
      "private",
    );
  await f.request(userId, "meetings.join", {}, saved.meeting.id, "wait");
  await f.request(staffId, "meetings.leave", {}, saved.meeting.id, "leave");
  await f.drain(5);
  f.advance(30 * 60000);
  await f.drain(5);
  const sent = f.calls.filter(
    (call) => ["POST", "PATCH"].includes(call.method) && call.route.includes("/messages"),
  );
  assert.ok(sent.length >= 3);
  for (const call of sent) {
    assert.ok(!call.body.content.includes("SECRET_"));
    assert.ok(!call.body.content.includes("<t:"));
    assert.ok(!call.body.content.includes(userId));
    assert.ok(!call.body.content.includes("Rezerwa:"));
    assert.deepEqual(call.body.allowed_mentions, {
      parse: [],
      roles: [],
      users: [],
      replied_user: false,
    });
  }
});

test("a role invitation never overrides an explicit channel denial in its created voice room", async (t) => {
  const f = await fixture(t);
  f.makeChannel(textId, ChannelType.GuildText, null, [
    { id: otherId, type: 1, allow: "0", deny: P.ViewChannel.toString() },
  ]);
  const saved = await f.request(
    staffId,
    "meetings.create",
    f.meeting({
      visibility: "private",
      allowedRoleIds: [newStaffRole],
      room: { kind: "create", categoryId },
    }),
    undefined,
    "private",
  );
  await assert.rejects(
    f.request(otherId, "meetings.join", {}, saved.meeting.id, "denied"),
    (error) => error.status === 403,
  );
  await f.request(
    staffId,
    "meetings.start",
    { revision: saved.meeting.revision },
    saved.meeting.id,
    "start",
  );
  await f.drain(8);
  const active = await f.request(staffId, "meetings.read", {}, saved.meeting.id);
  assert.equal(
    f.channels
      .get(active.meeting.roomChannelId)
      .permissionsFor(f.people.get(otherId))
      .has(P.ViewChannel),
    false,
  );
});
test("created meeting rooms are owned and cleanup waits for humans then removes bots-only rooms", async (t) => {
  const f = await fixture(t);
  const saved = await f.request(
    staffId,
    "meetings.create",
    f.meeting({ room: { kind: "create", categoryId } }),
    undefined,
    "create",
  );
  const current = await f.request(staffId, "meetings.read", {}, saved.meeting.id);
  await f.request(
    staffId,
    "meetings.start",
    { revision: current.meeting.revision },
    saved.meeting.id,
    "start",
  );
  await f.drain(4);
  const active = await f.request(staffId, "meetings.read", {}, saved.meeting.id),
    room = f.channels.get(active.meeting.roomChannelId);
  assert.equal(active.meeting.roomCreatedByBot, true);
  assert.equal(room.type, ChannelType.GuildVoice);
  room.members.set(userId, f.people.get(userId));
  await f.request(
    staffId,
    "meetings.complete",
    { revision: active.meeting.revision },
    saved.meeting.id,
    "complete",
  );
  await f.drain(3);
  assert.equal(f.calls.filter((value) => value.method === "DELETE").length, 0);
  room.members.clear();
  room.members.set(botId, f.people.get(botId));
  f.advance(60000);
  await f.drain(3);
  assert.equal(f.calls.filter((value) => value.method === "DELETE").length, 1);
  assert.equal(f.channels.has(room.id), false);
});
test("existing meeting rooms are never deleted and missing rooms never trigger an implicit replacement", async (t) => {
  const f = await fixture(t);
  const saved = await f.request(
    staffId,
    "meetings.create",
    f.meeting({ room: { kind: "existing", channelId: existingVoice } }),
    undefined,
    "create",
  );
  await f.request(
    staffId,
    "meetings.start",
    { revision: saved.meeting.revision },
    saved.meeting.id,
    "start",
  );
  await f.drain(3);
  const active = await f.request(staffId, "meetings.read", {}, saved.meeting.id);
  await f.request(
    staffId,
    "meetings.complete",
    { revision: active.meeting.revision },
    saved.meeting.id,
    "complete",
  );
  await f.drain(3);
  assert.equal(f.calls.filter((value) => value.method === "DELETE").length, 0);
  f.channels.delete(existingVoice);
  assert.equal(
    f.calls.filter((value) => value.method === "POST" && value.route.endsWith("/channels")).length,
    0,
  );
});
test("case creation atomically queues provisioning and notification; content follows confirmed ACL only", async (t) => {
  const f = await fixture(t);
  const saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  const jobs = f.runtime.jobs.list({ objectId: saved.case.id });
  assert.deepEqual(jobs.map((value) => value.type).sort(), [
    "case.notify",
    "community.case-channel",
  ]);
  assert.equal(f.calls.filter((value) => value.method === "POST").length, 0);
  await f.drain();
  const created = f.calls.findIndex(
      (value) => value.method === "POST" && value.route.endsWith("/channels"),
    ),
    sent = f.calls.findIndex(
      (value) => value.method === "POST" && value.route.endsWith("/messages"),
    );
  assert.ok(created >= 0 && sent > created);
  assert.ok(!JSON.stringify(f.calls[created].body).includes("PRIVATE_BODY"));
  const resource = f.store.resource(`community.case.${saved.case.id}`),
    channel = f.channels.get(resource.id);
  assert.equal(channel.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), false);
  assert.equal(channel.permissionsFor(f.people.get(userId)).has(P.ViewChannel), true);
  assert.equal(channel.permissionsFor(f.people.get(staffId)).has(P.ViewChannel), true);
  assert.equal(f.calls[sent].body.content.includes("PRIVATE_BODY"), true);
  assert.deepEqual(f.calls[sent].body.allowed_mentions, {
    parse: [],
    roles: [],
    users: [],
    replied_user: false,
  });
  assert.ok(
    f.runtime.jobs.list({ objectId: saved.case.id }).every((job) => job.state === "succeeded"),
  );
});

test("private case provisioning and staff ACL updates use inherited global ManageRoles", async (t) => {
  const f = await fixture(t),
    saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain();
  const create = f.calls.find(
    (call) => call.method === "POST" && call.route === `/guilds/${guildId}/channels`,
  );
  assert.ok(create);
  assert.equal(f.people.get(botId).permissions.has(P.ManageRoles), true);
  assert.equal(f.people.get(botId).permissions.has(P.Administrator), false);
  const settings = f.runtime.settings.read();
  await f.request(
    ownerId,
    "settings.save",
    { scope: "modules", settings: { ...settings, caseModeratorRoleIds: [newStaffRole] } },
    undefined,
    "staff-change",
  );
  await f.drain();
  const resource = f.store.resource(`community.case.${saved.case.id}`),
    patch = f.calls.findLast(
      (call) => call.method === "PATCH" && call.route === `/channels/${resource.id}`,
    );
  assert.ok(patch);
  for (const body of [create.body, patch.body])
    assert.ok(
      body.permission_overwrites.every(
        (entry) => (BigInt(entry.allow) & (P.ManageRoles | P.Administrator)) === 0n,
      ),
    );
  assert.ok(
    f.runtime.jobs
      .list({ objectId: saved.case.id })
      .some((job) => job.type === "community.case-acl" && job.state === "succeeded"),
  );
});
test("unconfirmed or stale case ACL never publishes private content", async (t) => {
  const f = await fixture(t);
  f.state.loosenAcl = true;
  const saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain();
  assert.equal(
    f.calls.filter((value) => value.method === "POST" && value.route.endsWith("/messages")).length,
    0,
  );
  assert.ok(
    f.runtime.jobs
      .list({ objectId: saved.case.id })
      .some((job) => job.lastError === "acl_unconfirmed"),
  );
});
test("ambiguous channel creation stays unknown and cannot blindly create a duplicate", async (t) => {
  const f = await fixture(t);
  f.state.postError = { status: 500 };
  const saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain(4);
  const provision = f.runtime.jobs.list({
    objectId: saved.case.id,
    type: "community.case-channel",
  })[0];
  assert.equal(provision.state, "unknown");
  f.state.postError = null;
  f.advance(60000);
  await f.drain(4);
  assert.equal(
    f.calls.filter((value) => value.method === "POST" && value.route.endsWith("/channels")).length,
    1,
  );
  assert.ok(f.store.operations().length > 0);
});
test("missing category preserves panel cases without borrowing the legacy reports channel", async (t) => {
  const f = await fixture(t, { noCategory: true });
  assert.equal(
    f.runtime.capabilities().modules.find((value) => value.key === "cases").status,
    "needs_configuration",
  );
  const saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain(3);
  assert.equal(
    (await f.request(userId, "cases.read", {}, saved.case.id)).case.content,
    "PRIVATE_BODY",
  );
  assert.equal(f.calls.filter((value) => value.method === "POST").length, 0);
});
test("deleted confirmed case channels are reported without silently recreating them", async (t) => {
  const f = await fixture(t),
    saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain();
  const resource = f.store.resource(`community.case.${saved.case.id}`);
  f.channels.delete(resource.id);
  const fresh = await f.request(userId, "cases.read", {}, saved.case.id);
  await f.request(
    userId,
    "cases.reply",
    { revision: fresh.case.revision, content: "Jeszcze jedno" },
    saved.case.id,
    "reply",
  );
  await f.drain(3);
  assert.equal(
    f.calls.filter((value) => value.method === "POST" && value.route.endsWith("/channels")).length,
    1,
  );
  assert.ok(
    f.runtime.jobs
      .list({ objectId: saved.case.id })
      .some((job) => job.lastError === "channel_missing"),
  );
});
test("case author and staff see distinct operations and notes never leak through ordinary reads", async (t) => {
  const f = await fixture(t),
    saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  const owner = await f.request(userId, "cases.read", {}, saved.case.id),
    staff = await f.request(staffId, "cases.read", {}, saved.case.id);
  assert.ok(owner.allowedOperations.includes("cases.reply"));
  assert.ok(!owner.allowedOperations.includes("cases.note"));
  assert.deepEqual(owner.allowedStatuses, []);
  assert.ok(staff.allowedStatuses.includes("resolved"));
  await f.request(
    staffId,
    "cases.note",
    { revision: 1, content: "INTERNAL_ONLY" },
    saved.case.id,
    "note",
  );
  assert.ok(
    !JSON.stringify(await f.request(userId, "cases.read", {}, saved.case.id)).includes(
      "INTERNAL_ONLY",
    ),
  );
  assert.equal(
    (await f.request(staffId, "cases.notes", {}, saved.case.id)).notes[0].content,
    "INTERNAL_ONLY",
  );
  await assert.rejects(
    f.request(userId, "cases.notes", {}, saved.case.id),
    (error) => error.status === 403,
  );
  await assert.rejects(
    f.request(
      userId,
      "cases.reply",
      { revision: 2, content: "test", internal: true },
      saved.case.id,
      "bypass-note",
    ),
    (error) => error.code === "unknown_field",
  );
});
test("explicit staff-role settings changes queue an owned-channel ACL update", async (t) => {
  const f = await fixture(t),
    saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain();
  const previous = f.runtime.settings.read();
  await f.request(
    ownerId,
    "settings.save",
    { scope: "modules", settings: { ...previous, caseModeratorRoleIds: [newStaffRole] } },
    undefined,
    "change-staff",
  );
  await f.drain(4);
  const resource = f.store.resource(`community.case.${saved.case.id}`),
    channel = f.channels.get(resource.id);
  assert.equal(channel.permissionsFor(f.people.get(staffId)).has(P.ViewChannel), false);
  assert.equal(channel.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), true);
  assert.ok(
    f.calls.some((value) => value.method === "PATCH" && value.route === `/channels/${resource.id}`),
  );
  await assert.rejects(
    f.request(staffId, "cases.read", {}, saved.case.id),
    (error) => error.status === 403,
  );
});
test("a failed notification insert rolls back the extra channel job as well", async (t) => {
  const f = await fixture(t);
  f.store.db.exec(
    "CREATE TRIGGER fail_notify BEFORE INSERT ON jobs WHEN NEW.type='case.notify' BEGIN SELECT RAISE(ABORT,'notification insert failed'); END",
  );
  await assert.rejects(
    f.request(userId, "cases.create", f.case(), undefined, "create"),
    /notification insert failed/,
  );
  assert.equal(f.runtime.jobs.list().length, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM cases").get().count, 0);
});

test("role revocation between case-domain read and response serialization strips private reply history", async (t) => {
  const f = await fixture(t);
  const saved = await f.request(
    userId,
    "cases.create",
    f.case({ kind: "suggestion" }),
    undefined,
    "idea",
  );
  await f.request(
    userId,
    "cases.reply",
    { revision: 1, content: "PRIVATE_BEFORE_APPROVAL" },
    saved.case.id,
    "reply",
  );
  await f.request(ownerId, "cases.approve", { revision: 2 }, saved.case.id, "approve");
  const original = f.runtime.context.guild.members.fetch.bind(f.runtime.context.guild.members);
  let reads = 0;
  f.runtime.context.guild.members.fetch = async (input) => {
    const member = await original(input);
    if (input.user === staffId && ++reads === 2) member.roles.cache.clear();
    return member;
  };
  const detail = await f.request(staffId, "cases.read", {}, saved.case.id);
  assert.deepEqual(detail.messages, []);
  assert.ok(!JSON.stringify(detail).includes("PRIVATE_BEFORE_APPROVAL"));
});

test("a late confirmed meeting card loses its controls after cancellation and a worker restart", async (t) => {
  const f = await fixture(t),
    created = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create");
  const original = f.rest.post.bind(f.rest);
  let cancel = true;
  f.rest.post = async (route, options) => {
    const result = await original(route, options);
    if (cancel && route.endsWith("/messages")) {
      cancel = false;
      const current = await f.request(staffId, "meetings.read", {}, created.meeting.id);
      await f.request(
        staffId,
        "meetings.cancel",
        { revision: current.meeting.revision },
        created.meeting.id,
        "cancel-during-send",
      );
    }
    return result;
  };
  await f.runner.tick();
  const pending = f.runtime.jobs.list({ type: "community.meeting-controls-clear" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, "pending");
  await f.restart();
  await f.drain(5);
  const delivered = f.runtime.jobs
    .list({ objectId: created.meeting.id, type: "meeting.publish" })
    .find((job) => job.cancelRequested);
  assert.ok(delivered.messageId);
  assert.ok(
    f.runtime.jobs
      .attempts(delivered.id)
      .some((attempt) => attempt.messageId === delivered.messageId),
  );
  assert.equal(
    (await f.request(staffId, "meetings.read", {}, created.meeting.id)).meeting.state,
    "cancelled",
  );
  const update = f.calls.find(
    (value) => value.method === "PATCH" && value.route.endsWith(`/messages/${delivered.messageId}`),
  );
  assert.deepEqual(update.body.components, []);
  assert.ok(!Object.hasOwn(update.body, "content"));
  assert.equal(f.runtime.jobs.get(pending[0].id).state, "succeeded");
  assert.ok([...f.messages.values()].every((message) => message.components.length === 0));
  assert.ok([...f.messages.values()].some((message) => /Odwołane/.test(message.content)));
});

test("moving the meeting during POST clears the old channel's card and preserves the new controls", async (t) => {
  const f = await fixture(t),
    newChannelId = "700000000000000025",
    created = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create"),
    original = f.rest.post.bind(f.rest);
  f.makeChannel(newChannelId, ChannelType.GuildText);
  let move = true,
    oldMessageId,
    source,
    oldMeeting;
  f.rest.post = async (route, options) => {
    const result = await original(route, options);
    if (move && route.endsWith("/messages")) {
      move = false;
      oldMessageId = result.id;
      source = f.runtime.jobs
        .list({ objectId: created.meeting.id, type: "meeting.publish" })
        .find((job) => job.state === "running");
      const current = await f.request(staffId, "meetings.read", {}, created.meeting.id);
      oldMeeting = { ...current.meeting, messageId: oldMessageId };
      await f.request(
        staffId,
        "meetings.update",
        { revision: current.meeting.revision, draft: f.meeting({ channelId: newChannelId }) },
        created.meeting.id,
        "move-during-send",
      );
    }
    return result;
  };
  await f.runner.tick();
  const cleanup = f.runtime.jobs.list({ type: "community.meeting-controls-clear" });
  assert.equal(cleanup.length, 1);
  f.advance(1000);
  assert.doesNotThrow(() => f.runtime.community.meetings.retireMessage(oldMeeting));
  await f.restart();
  f.advance(1000);
  assert.doesNotThrow(() =>
    f.runtime.community.recordMeetingResult(source, { messageId: oldMessageId }),
  );
  assert.deepEqual(f.runtime.jobs.list({ type: "community.meeting-controls-clear" }), cleanup);
  await f.drain(5);
  const current = await f.request(staffId, "meetings.read", {}, created.meeting.id),
    oldCard = f.messages.get(oldMessageId),
    newCard = f.messages.get(current.meeting.messageId);
  assert.equal(oldCard.channelId, textId);
  assert.deepEqual(oldCard.components, []);
  assert.equal(newCard.channelId, newChannelId);
  assert.equal(newCard.components[0].components[0].custom_id.split(":").at(-1), "join");
  assert.ok(
    f.calls
      .filter((call) => call.method === "PATCH" && call.route.includes("/messages/"))
      .every((call) => call.route === `/channels/${textId}/messages/${oldMessageId}`),
  );
});

test("moving an already published meeting replaces the channel binding and retires old controls", async (t) => {
  const f = await fixture(t),
    newChannelId = "700000000000000025",
    created = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create");
  f.makeChannel(newChannelId, ChannelType.GuildText);
  await f.drain(2);
  const before = await f.request(staffId, "meetings.read", {}, created.meeting.id),
    oldMessageId = before.meeting.messageId;
  assert.ok(f.messages.get(oldMessageId).components[0].components.length);
  const updated = await f.request(
    staffId,
    "meetings.update",
    { revision: before.meeting.revision, draft: f.meeting({ channelId: newChannelId }) },
    created.meeting.id,
    "move-published",
  );
  assert.equal(updated.meeting.messageId, null);
  assert.equal(
    f.runtime.jobs.list({ type: "community.meeting-controls-clear", objectId: created.meeting.id })
      .length,
    1,
  );
  await f.restart();
  await f.drain(5);
  const current = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  assert.notEqual(current.meeting.messageId, oldMessageId);
  assert.equal(f.messages.get(current.meeting.messageId).channelId, newChannelId);
  assert.ok(f.messages.get(current.meeting.messageId).components[0].components.length);
  assert.deepEqual(f.messages.get(oldMessageId).components, []);
  assert.ok(
    !f.calls.some(
      (call) =>
        call.method === "PATCH" &&
        call.route === `/channels/${newChannelId}/messages/${oldMessageId}`,
    ),
  );
  assert.equal(
    f.runtime.jobs.list({ objectId: created.meeting.id }).filter((job) => job.state === "failed")
      .length,
    0,
  );
});

test("stale-card cleanup requires a matching durable receipt and the bot's actual message", async (t) => {
  for (const tamper of ["source", "guild", "object", "attempt", "channel", "message", "author"])
    await t.test(tamper, async (t) => {
      const f = await fixture(t),
        created = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create"),
        original = f.rest.post.bind(f.rest);
      let cancel = true,
        messageId;
      f.rest.post = async (route, options) => {
        const result = await original(route, options);
        if (cancel && route.endsWith("/messages")) {
          cancel = false;
          messageId = result.id;
          const current = await f.request(staffId, "meetings.read", {}, created.meeting.id);
          await f.request(
            staffId,
            "meetings.cancel",
            { revision: current.meeting.revision },
            created.meeting.id,
            "cancel-during-send",
          );
        }
        return result;
      };
      await f.runner.tick();
      const cleanup = f.runtime.jobs.list({ type: "community.meeting-controls-clear" })[0],
        payload = { ...cleanup.payload };
      if (tamper === "source") payload.sourceJobId = randomUUID();
      if (tamper === "guild")
        f.store.db
          .prepare("UPDATE jobs SET guild_id=? WHERE id=?")
          .run("700000000000000099", payload.sourceJobId);
      if (tamper === "attempt") payload.attemptId = randomUUID();
      if (tamper === "channel") payload.channelId = suggestionId;
      if (tamper === "message") payload.messageId = "700000000000000099";
      if (tamper === "object")
        f.store.db.prepare("UPDATE jobs SET object_id=? WHERE id=?").run(randomUUID(), cleanup.id);
      if (tamper === "author") f.messages.get(messageId).authorId = userId;
      f.store.db
        .prepare("UPDATE jobs SET payload=? WHERE id=?")
        .run(JSON.stringify(payload), cleanup.id);
      await f.drain(4);
      assert.equal(f.runtime.jobs.get(cleanup.id).state, "failed");
      assert.equal(f.runtime.jobs.get(cleanup.id).lastError, "meeting_message_not_owned");
      assert.ok(
        !f.calls.some(
          (call) => call.method === "PATCH" && call.route.endsWith(`/messages/${messageId}`),
        ),
      );
      assert.ok(!f.calls.some((call) => call.method === "DELETE"));
    });
});

test("voice creation confirmed after cancellation is journaled and queued for safe owned cleanup", async (t) => {
  const f = await fixture(t),
    created = await f.request(
      staffId,
      "meetings.create",
      f.meeting({ room: { kind: "create", categoryId } }),
      undefined,
      "create",
    );
  await f.request(
    staffId,
    "meetings.start",
    { revision: created.meeting.revision },
    created.meeting.id,
    "start",
  );
  const original = f.rest.post.bind(f.rest);
  let cancel = true,
    source;
  f.rest.post = async (route, options) => {
    const result = await original(route, options);
    if (cancel && route.endsWith("/channels")) {
      cancel = false;
      source = f.runtime.jobs
        .list({ objectId: created.meeting.id, type: "meeting.start" })
        .find((job) => job.state === "running");
      const current = await f.request(staffId, "meetings.read", {}, created.meeting.id);
      await f.request(
        staffId,
        "meetings.cancel",
        { revision: current.meeting.revision },
        created.meeting.id,
        "cancel-during-create",
      );
    }
    return result;
  };
  await f.drain(8);
  const resource = f.store.resource(`community.meeting.${created.meeting.id}`);
  assert.ok(resource);
  assert.equal(f.channels.has(resource.id), false);
  assert.equal(
    f.calls.filter((call) => call.method === "POST" && call.route.endsWith("/channels")).length,
    1,
  );
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.ok(
    f.runtime.jobs
      .list({ objectId: created.meeting.id })
      .some((job) => job.type === "community.meeting-cleanup"),
  );
  const cleanup = f.runtime.jobs.list({ type: "community.meeting-cleanup" });
  f.advance(61000);
  await f.restart();
  assert.doesNotThrow(() =>
    f.runtime.community.recordMeetingResult(source, {
      roomChannelId: resource.id,
      roomCreatedByBot: true,
    }),
  );
  assert.deepEqual(f.runtime.jobs.list({ type: "community.meeting-cleanup" }), cleanup);
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 1);
});

test("an invalid creation response never grants ownership or clears an uncertain journal", async (t) => {
  const f = await fixture(t),
    saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  f.rest.post = async (route, options) => {
    f.calls.push({ method: "POST", route, body: options.body });
    return { id: "invalid" };
  };
  await f.drain(5);
  const job = f.runtime.jobs.list({ objectId: saved.case.id, type: "community.case-channel" })[0];
  assert.equal(job.state, "unknown");
  assert.equal(f.store.resource(`community.case.${saved.case.id}`), undefined);
  assert.ok(f.store.operations().length);
  assert.equal(f.calls.filter((call) => call.route?.endsWith("/channels")).length, 1);
});

test("private meeting participants lose panel access when their current role or channel access is revoked", async (t) => {
  const f = await fixture(t);
  const created = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create");
  await f.request(userId, "meetings.join", {}, created.meeting.id, "join");
  f.people.get(userId).roles.cache.set(newStaffRole, f.roles.get(newStaffRole));
  f.makeChannel(textId, ChannelType.GuildText, null, [
    { id: guildId, type: 0, allow: "0", deny: P.ViewChannel.toString() },
    { id: newStaffRole, type: 0, allow: access.toString(), deny: "0" },
    { id: staffId, type: 1, allow: access.toString(), deny: "0" },
    { id: botId, type: 1, allow: access.toString(), deny: "0" },
  ]);
  const current = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  await f.request(
    staffId,
    "meetings.update",
    {
      revision: current.meeting.revision,
      draft: f.meeting({ visibility: "private", allowedRoleIds: [newStaffRole] }),
    },
    created.meeting.id,
    "make-private",
  );
  assert.equal(
    (await f.request(userId, "meetings.read", {}, created.meeting.id)).meeting.visibility,
    "private",
  );
  f.people.get(userId).roles.cache.clear();
  await assert.rejects(
    f.request(userId, "meetings.read", {}, created.meeting.id),
    (error) => error.status === 403,
  );
  assert.deepEqual((await f.request(userId, "meetings.list")).meetings, []);
  assert.equal(
    (await f.request(staffId, "meetings.read", {}, created.meeting.id)).meeting.visibility,
    "private",
  );
});

test("ACL security housekeeping still removes old access after the saving admin leaves", async (t) => {
  const f = await fixture(t),
    created = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain();
  const settings = f.runtime.settings.read();
  await f.request(
    ownerId,
    "settings.save",
    { scope: "modules", settings: { ...settings, caseModeratorRoleIds: [newStaffRole] } },
    undefined,
    "replace-staff",
  );
  assert.equal(f.runtime.community.status("cases"), "degraded");
  f.people.delete(ownerId);
  await f.drain(3);
  const channel = f.channels.get(f.store.resource(`community.case.${created.case.id}`).id);
  assert.equal(channel.permissionsFor(f.people.get(staffId)).has(P.ViewChannel), false);
  assert.equal(channel.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), true);
  assert.equal(f.runtime.community.status("cases"), "enabled");
});

test("ACL jobs recheck the committed revision immediately before PATCH", async (t) => {
  const f = await fixture(t),
    created = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain();
  await f.request(
    ownerId,
    "settings.save",
    {
      scope: "modules",
      settings: { ...f.runtime.settings.read(), caseModeratorRoleIds: [newStaffRole] },
    },
    undefined,
    "first-change",
  );
  const original = f.runtime.context.guild.members.fetchMe.bind(f.runtime.context.guild.members);
  let change = true;
  f.runtime.context.guild.members.fetchMe = async (input) => {
    if (change) {
      change = false;
      await f.request(
        ownerId,
        "settings.save",
        { scope: "modules", settings: { ...f.runtime.settings.read(), caseModeratorRoleIds: [] } },
        undefined,
        "newest-change",
      );
    }
    return original(input);
  };
  await f.drain(5);
  const patches = f.calls.filter(
    (call) => call.method === "PATCH" && call.body.permission_overwrites,
  );
  assert.ok(patches.length > 0);
  assert.ok(
    patches.every(
      (call) => !call.body.permission_overwrites.some((overwrite) => overwrite.id === newStaffRole),
    ),
  );
  const channel = f.channels.get(f.store.resource(`community.case.${created.case.id}`).id);
  assert.equal(channel.permissionsFor(f.people.get(staffId)).has(P.ViewChannel), false);
  assert.equal(channel.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), false);
});

test("a role change while PATCH is in flight queues the latest ACL instead of claiming synchronization", async (t) => {
  const f = await fixture(t),
    created = await f.request(userId, "cases.create", f.case(), undefined, "create");
  await f.drain();
  await f.request(
    ownerId,
    "settings.save",
    {
      scope: "modules",
      settings: { ...f.runtime.settings.read(), caseModeratorRoleIds: [newStaffRole] },
    },
    undefined,
    "first-change",
  );
  const original = f.rest.patch.bind(f.rest);
  let change = true;
  f.rest.patch = async (route, options) => {
    const result = await original(route, options);
    if (change && options.body.permission_overwrites) {
      change = false;
      await f.request(
        ownerId,
        "settings.save",
        { scope: "modules", settings: { ...f.runtime.settings.read(), caseModeratorRoleIds: [] } },
        undefined,
        "newest-change",
      );
    }
    return result;
  };
  await f.drain(6);
  const channel = f.channels.get(f.store.resource(`community.case.${created.case.id}`).id);
  assert.equal(channel.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), false);
  assert.ok(
    f.runtime.jobs
      .list({ objectId: created.case.id, type: "community.case-acl" })
      .some((job) => job.state === "unknown" && job.lastError === "case_acl_settings_changed"),
  );
  assert.equal(f.runtime.community.status("cases"), "enabled");
});

test("one hundred cases use two request-local fresh snapshots and final role revocation filters every private row", async (t) => {
  const f = await fixture(t),
    saved = await f.request(userId, "cases.create", f.case(), undefined, "create");
  const row = f.store.db.prepare("SELECT * FROM cases WHERE id=?").get(saved.case.id),
    keys = Object.keys(row),
    insert = f.store.db.prepare(
      `INSERT INTO cases (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    );
  for (let index = 1; index < 100; index++)
    insert.run(...keys.map((key) => (key === "id" ? randomUUID() : row[key])));
  f.calls.length = 0;
  assert.equal((await f.request(staffId, "cases.list")).cases.length, 100);
  assert.equal(f.calls.filter((call) => call.method === "fresh-member").length, 2);
  assert.equal(f.calls.filter((call) => call.method === "fresh-guild").length, 2);
  assert.equal(f.calls.filter((call) => call.method === "fresh-roles").length, 2);
  const original = f.runtime.context.guild.members.fetch.bind(f.runtime.context.guild.members);
  let reads = 0;
  f.runtime.context.guild.members.fetch = async (input) => {
    const member = await original(input);
    if (input.user === staffId && ++reads === 2) member.roles.cache.clear();
    return member;
  };
  f.calls.length = 0;
  assert.deepEqual((await f.request(staffId, "cases.list")).cases, []);
  assert.equal(f.calls.filter((call) => call.method === "fresh-member").length, 2);
  f.people.get(staffId).roles.cache.set(staffRole, f.roles.get(staffRole));
  assert.equal((await f.request(staffId, "cases.list")).cases.length, 100);
  assert.equal(f.calls.filter((call) => call.method === "fresh-member").length, 4);
});

test("meeting lists fetch current channel definitions once and do not refresh each object", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++)
    await f.request(staffId, "meetings.create", f.meeting(), undefined, `create-${index}`);
  const original = f.runtime.context.guild.channels.fetch.bind(f.runtime.context.guild.channels);
  let allChannels = 0;
  f.runtime.context.guild.channels.fetch = async (...args) => {
    if (args[0] === undefined) allChannels++;
    return original(...args);
  };
  f.calls.length = 0;
  assert.equal((await f.request(userId, "meetings.list")).meetings.length, 5);
  assert.equal(allChannels, 1);
  assert.equal(f.calls.filter((call) => call.method === "fresh-member").length, 2);
});

test("a rate limit during fresh membership preflight defers work without spending its failure budget", async (t) => {
  const f = await fixture(t),
    created = await f.request(staffId, "meetings.create", f.meeting(), undefined, "create");
  const start = Date.now();
  f.state.memberError = { status: 429, rawError: { retry_after: 2.5 } };
  await f.runner.tick();
  const delayed = f.runtime.jobs.list({ objectId: created.meeting.id, type: "meeting.publish" })[0];
  assert.equal(delayed.state, "retry");
  assert.equal(delayed.failures, 0);
  assert.equal(delayed.nextAttemptAt, start + 2500);
  assert.deepEqual(f.runtime.jobs.attempts(delayed.id), []);
  f.state.memberError = null;
  f.advance(2499);
  assert.equal(await f.runner.tick(), 0);
  f.advance(1);
  await f.runner.tick();
  assert.equal(f.runtime.jobs.get(delayed.id).state, "succeeded");
});

test("leaving a private meeting removes direct access to its bot-owned voice room", async (t) => {
  const f = await fixture(t),
    created = await f.request(
      staffId,
      "meetings.create",
      f.meeting({ room: { kind: "create", categoryId } }),
      undefined,
      "create",
    );
  await f.request(userId, "meetings.join", {}, created.meeting.id, "join");
  f.makeChannel(textId, ChannelType.GuildText, null, [
    { id: guildId, type: 0, allow: "0", deny: P.ViewChannel.toString() },
    { id: staffId, type: 1, allow: access.toString(), deny: "0" },
    { id: userId, type: 1, allow: access.toString(), deny: "0" },
    { id: botId, type: 1, allow: access.toString(), deny: "0" },
  ]);
  const before = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  const updated = await f.request(
    staffId,
    "meetings.update",
    {
      revision: before.meeting.revision,
      draft: f.meeting({
        visibility: "private",
        invitedUserIds: [userId],
        room: { kind: "create", categoryId },
      }),
    },
    created.meeting.id,
    "private",
  );
  await f.request(
    staffId,
    "meetings.start",
    { revision: updated.meeting.revision },
    created.meeting.id,
    "start",
  );
  await f.drain(8);
  const active = await f.request(staffId, "meetings.read", {}, created.meeting.id),
    roomId = active.meeting.roomChannelId;
  assert.equal(
    f.channels.get(roomId).permissionsFor(f.people.get(userId)).has(P.ViewChannel),
    true,
  );
  await f.request(userId, "meetings.leave", {}, created.meeting.id, "leave");
  await f.drain(8);
  assert.equal(
    f.channels.get(roomId).permissionsFor(f.people.get(userId)).has(P.ViewChannel),
    false,
  );
  assert.equal(
    f.channels.get(roomId).permissionsFor(f.people.get(staffId)).has(P.ViewChannel),
    true,
  );
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 0);
});

test("role-restricted voice rooms do not retain per-user grants after role removal", async (t) => {
  const f = await fixture(t),
    created = await f.request(
      staffId,
      "meetings.create",
      f.meeting({ allowedRoleIds: [newStaffRole], room: { kind: "create", categoryId } }),
      undefined,
      "create",
    );
  await f.request(otherId, "meetings.join", {}, created.meeting.id, "join");
  const before = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  assert.ok(before.allowedOperations.includes("meetings.start"));
  await f.request(
    staffId,
    "meetings.start",
    { revision: before.meeting.revision },
    created.meeting.id,
    "start",
  );
  await f.drain(8);
  const active = await f.request(staffId, "meetings.read", {}, created.meeting.id),
    room = f.channels.get(active.meeting.roomChannelId);
  assert.equal(room.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), true);
  assert.equal(room.permissionOverwrites.cache.has(otherId), false);
  f.people.get(otherId).roles.cache.clear();
  assert.equal(room.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), false);
});

test("a hundred-person meeting is allowed without creation, while a new voice room requires at most99", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.request(
      staffId,
      "meetings.create",
      f.meeting({ capacity: 100, room: { kind: "create", categoryId } }),
      undefined,
      "too-large-room",
    ),
    (error) => error.status === 400 && error.code === "invalid_input",
  );
  assert.equal(
    (
      await f.request(
        staffId,
        "meetings.create",
        f.meeting({ capacity: 100 }),
        undefined,
        "large-meeting",
      )
    ).meeting.capacity,
    100,
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
});

test("disabled meetings defer waitlist promotion durably and reconcile once after re-enabling", async (t) => {
  const f = await fixture(t);
  const created = await f.request(
    staffId,
    "meetings.create",
    f.meeting({ capacity: 1, organizerParticipates: false }),
    undefined,
    "create-defer",
  );
  await f.request(userId, "meetings.join", {}, created.meeting.id, "join-first");
  await f.request(otherId, "meetings.join", {}, created.meeting.id, "join-reserve");
  const disable = f.runtime.settings.read();
  disable.enabled.meetings = false;
  await f.request(
    ownerId,
    "settings.save",
    { scope: "modules", settings: disable },
    undefined,
    "disable-meetings",
  );
  f.people.delete(userId);
  const changes = await f.runtime.community.memberRemoved(userId, "left-disabled", Date.now());
  assert.equal(
    changes[0].participants.find((person) => person.userId === otherId).state,
    "waitlisted",
  );
  await f.drain(3);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  assert.ok(
    f.runtime.jobs
      .list({ guildId, type: "community.meeting-reconcile" })
      .some((job) => job.state === "retry"),
  );
  await f.restart();
  const enable = f.runtime.settings.read();
  enable.enabled.meetings = true;
  await f.request(
    ownerId,
    "settings.save",
    { scope: "modules", settings: enable },
    undefined,
    "enable-meetings",
  );
  await f.drain(8);
  const detail = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  assert.equal(detail.participants.find((person) => person.userId === userId).state, "left");
  assert.equal(detail.participants.find((person) => person.userId === otherId).state, "confirmed");
  f.advance(60000);
  await f.drain(8);
  assert.equal(
    f.runtime.jobs.list({ guildId, objectId: created.meeting.id, type: "meeting.promoted" }).length,
    1,
  );
});

test("repeated membership checks in the same minute schedule one immutable reconciliation job", async (t) => {
  const f = await fixture(t);
  await f.request(staffId, "meetings.create", f.meeting(), undefined, "reconcile-dedupe");
  f.runtime.community.memberUpdated(staffId);
  f.advance(1000);
  assert.doesNotThrow(() => f.runtime.community.memberUpdated(staffId));
  assert.equal(f.runtime.jobs.list({ guildId, type: "community.meeting-reconcile" }).length, 1);
});

test("a room start and later card refresh share one durable ACL job across a restart", async (t) => {
  const f = await fixture(t),
    created = await f.request(
      staffId,
      "meetings.create",
      f.meeting({ room: { kind: "create", categoryId } }),
      undefined,
      "acl-create",
    );
  await f.request(
    staffId,
    "meetings.start",
    { revision: created.meeting.revision },
    created.meeting.id,
    "acl-start",
  );
  await f.drain(8);
  const jobs = f.runtime.jobs.list({ objectId: created.meeting.id }),
    acl = jobs.filter((job) => job.type === "community.meeting-acl");
  assert.equal(acl.length, 1);
  assert.equal(acl[0].state, "succeeded");
  assert.ok(jobs.every((job) => job.lastError !== "dedupe_conflict"));
  assert.match(
    f.messages.get(f.runtime.community.meetings.systemDetail(created.meeting.id).meeting.messageId)
      .content,
    /Trwa/,
  );
  f.advance(61000);
  await f.restart();
  assert.doesNotThrow(() => f.runtime.community.enqueueMeetingAcl(created.meeting.id));
  assert.deepEqual(
    f.runtime.jobs.list({ objectId: created.meeting.id, type: "community.meeting-acl" }),
    acl,
  );
  const active = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  assert.ok(
    f.messages.get(active.meeting.messageId).content.includes(active.meeting.roomChannelId),
  );
  await f.request(
    staffId,
    "meetings.complete",
    { revision: active.meeting.revision },
    created.meeting.id,
    "acl-complete",
  );
  await f.drain(8);
  assert.equal(f.channels.has(active.meeting.roomChannelId), false);
  assert.ok(
    !f.messages.get(active.meeting.messageId).content.includes(active.meeting.roomChannelId),
  );
  assert.ok(
    f.runtime.jobs
      .list({ objectId: created.meeting.id })
      .every((job) => job.lastError !== "dedupe_conflict"),
  );
});

test("equivalent case ACL callbacks retain the first schedule after time passes and restart", async (t) => {
  const f = await fixture(t),
    created = await f.request(userId, "cases.create", f.case(), undefined, "case-acl-create");
  await f.drain(8);
  const previous = f.runtime.settings.read(),
    next = f.runtime.settings.save({ ...previous, caseModeratorRoleIds: [newStaffRole] }, ownerId);
  f.runtime.community.settingsChanged(ownerId, previous, next);
  const before = f.runtime.jobs.list({ objectId: created.case.id, type: "community.case-acl" });
  f.advance(61000);
  await f.restart();
  assert.doesNotThrow(() => f.runtime.community.enqueueLatestCaseAcl(created.case.id));
  assert.doesNotThrow(() => f.runtime.community.settingsChanged(ownerId, previous, next));
  assert.deepEqual(
    f.runtime.jobs.list({ objectId: created.case.id, type: "community.case-acl" }),
    before,
  );
  const existing = before[0];
  assert.throws(
    () =>
      f.runtime.community.enqueueEffect({
        guildId: existing.guildId,
        objectId: existing.objectId,
        generation: existing.generation,
        type: existing.type,
        dedupeKey: existing.dedupeKey,
        payload: { ...existing.payload, actorId: otherId },
      }),
    (error) => error.code === "dedupe_conflict",
  );
  await f.drain(3);
  const channel = f.channels.get(f.store.resource(`community.case.${created.case.id}`).id);
  assert.equal(channel.permissionsFor(f.people.get(staffId)).has(P.ViewChannel), false);
  assert.equal(channel.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), true);
});

test("a terminal card keeps its selected existing voice channel instead of treating it as deleted", async (t) => {
  const f = await fixture(t),
    created = await f.request(
      staffId,
      "meetings.create",
      f.meeting({ room: { kind: "existing", channelId: existingVoice } }),
      undefined,
      "existing-create",
    );
  await f.request(
    staffId,
    "meetings.start",
    { revision: created.meeting.revision },
    created.meeting.id,
    "existing-start",
  );
  await f.drain(5);
  const active = await f.request(staffId, "meetings.read", {}, created.meeting.id);
  await f.request(
    staffId,
    "meetings.complete",
    { revision: active.meeting.revision },
    created.meeting.id,
    "existing-complete",
  );
  await f.drain(5);
  assert.ok(f.channels.has(existingVoice));
  assert.ok(f.messages.get(active.meeting.messageId).content.includes(`<#${existingVoice}>`));
  assert.ok(!f.calls.some((call) => call.method === "DELETE"));
});

test("unrelated settings edits cannot discard a committed staff-access revocation", async (t) => {
  for (const stage of ["queued", "before-patch"])
    await t.test(stage, async (t) => {
      const f = await fixture(t),
        created = await f.request(userId, "cases.create", f.case(), undefined, "acl-create");
      await f.drain(8);
      await f.request(
        ownerId,
        "settings.save",
        {
          scope: "modules",
          settings: { ...f.runtime.settings.read(), caseModeratorRoleIds: [newStaffRole] },
        },
        undefined,
        "acl-revoke",
      );
      const changeTimezone = () =>
        f.request(
          ownerId,
          "settings.save",
          {
            scope: "modules",
            settings: { ...f.runtime.settings.read(), timeZone: "Europe/London" },
          },
          undefined,
          "unrelated-timezone",
        );
      if (stage === "queued") await changeTimezone();
      else {
        const original = f.runtime.context.guild.members.fetchMe.bind(
          f.runtime.context.guild.members,
        );
        let change = true;
        f.runtime.context.guild.members.fetchMe = async (input) => {
          if (change) {
            change = false;
            await changeTimezone();
          }
          return original(input);
        };
      }
      await f.drain(5);
      const channel = f.channels.get(f.store.resource(`community.case.${created.case.id}`).id);
      assert.equal(channel.permissionsFor(f.people.get(staffId)).has(P.ViewChannel), false);
      assert.equal(channel.permissionsFor(f.people.get(otherId)).has(P.ViewChannel), true);
      assert.equal(f.runtime.community.status("cases"), "enabled");
      assert.ok(
        f.runtime.jobs
          .list({ objectId: created.case.id, type: "community.case-acl" })
          .some(
            (job) =>
              job.state === "succeeded" &&
              job.payload.settingsRevision === f.runtime.settings.read().revision,
          ),
      );
    });
});

test("case ACL work remains bound to the channel identity captured when it was queued", async (t) => {
  const f = await fixture(t),
    created = await f.request(userId, "cases.create", f.case(), undefined, "identity-create");
  await f.drain(8);
  await f.request(
    ownerId,
    "settings.save",
    {
      scope: "modules",
      settings: { ...f.runtime.settings.read(), caseModeratorRoleIds: [newStaffRole] },
    },
    undefined,
    "identity-revoke",
  );
  const resource = f.store.resource(`community.case.${created.case.id}`),
    newChannelId = "700000000000000025",
    oldJob = f.runtime.jobs.list({ objectId: created.case.id, type: "community.case-acl" })[0];
  f.makeChannel(newChannelId, ChannelType.GuildText, categoryId);
  f.store.putResource(resource.key, resource.kind, newChannelId, JSON.parse(resource.baseline));
  await f.drain(5);
  assert.equal(f.runtime.jobs.get(oldJob.id).state, "expired");
  assert.equal(f.runtime.jobs.get(oldJob.id).lastError, "case_channel_changed");
  const current = f.runtime.jobs
    .list({ objectId: created.case.id, type: "community.case-acl" })
    .find((job) => job.payload.channelId === newChannelId);
  assert.equal(current.state, "succeeded");
  assert.notEqual(current.dedupeKey, oldJob.dedupeKey);
  const patched = f.calls.filter(
    (call) => call.method === "PATCH" && call.body.permission_overwrites,
  );
  assert.deepEqual(
    patched.map((call) => call.route),
    [`/channels/${newChannelId}`],
  );
});

test("actual SDK foreign-guild channels reject meeting creation before rows, jobs or Discord effects", async (t) => {
  for (const [label, channelId, change] of [
    ["publication", textId, {}],
    ["created-room category", categoryId, { room: { kind: "create", categoryId } }],
    [
      "existing voice room",
      existingVoice,
      { room: { kind: "existing", channelId: existingVoice } },
    ],
  ])
    await t.test(label, async (t) => {
      const f = await fixture(t),
        calls = [],
        manager = {
          guild: { id: guildId },
          client: {
            rest: {
              async get(route) {
                calls.push(route);
                assert.equal(route, `/channels/${channelId}`);
                return {
                  id: channelId,
                  guild_id: "700000000000000099",
                  type: f.channels.get(channelId).type,
                };
              },
            },
          },
        },
        sdkFetch = (id, options) => GuildChannelManager.prototype.fetch.call(manager, id, options);
      await assert.rejects(
        () => sdkFetch(channelId, { force: true }),
        (error) => error instanceof DiscordjsError && error.code === "GuildChannelUnowned",
      );
      const channels = f.runtime.context.guild.channels,
        original = channels.fetch.bind(channels);
      channels.fetch = (id, options) =>
        id === channelId ? sdkFetch(id, options) : original(id, options);
      const db = f.runtime.jobs.db,
        before = db.prepare("SELECT total_changes() AS n").get().n;
      await assert.rejects(
        () => f.request(staffId, "meetings.create", f.meeting(change), undefined, "sdk-foreign"),
        (error) => error.status === 409 && error.code === "channel_missing",
      );
      await f.drain(2);
      assert.equal(calls.length, 2);
      assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
      for (const table of [
        "meetings",
        "meeting_participants",
        "meeting_invites",
        "meeting_audit",
        "meeting_effect_receipts",
        "jobs",
        "delivery_attempts",
        "idempotency_keys",
      ])
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
      assert.equal(f.messages.size, 0);
      assert.equal(
        f.calls.filter((call) => ["POST", "PATCH", "DELETE"].includes(call.method)).length,
        0,
      );
    });
});

test("community channel lookups propagate network and actual SDK rate-limit errors without writes", async (t) => {
  const f = await fixture(t),
    db = f.runtime.jobs.db,
    before = db.prepare("SELECT total_changes() AS n").get().n;
  for (const failure of [
    Object.assign(Error("temporary network failure"), { code: "ECONNRESET" }),
    new RateLimitError({
      timeToReset: 900,
      retryAfter: 1200,
      sublimitTimeout: 0,
      limit: 1,
      method: "GET",
      hash: "community-channel",
      url: `https://discord.com/api/v10/channels/${textId}`,
      route: "/channels/:id",
      majorParameter: textId,
      global: false,
      scope: "user",
    }),
  ]) {
    const manager = {
      guild: { id: guildId },
      client: {
        rest: {
          async get() {
            throw failure;
          },
        },
      },
    };
    f.runtime.context.guild.channels.fetch = (id, options) =>
      GuildChannelManager.prototype.fetch.call(manager, id, options);
    await assert.rejects(
      () => f.request(staffId, "meetings.create", f.meeting(), undefined, "sdk-transient"),
      (error) => error === failure,
    );
  }
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, before);
  assert.equal(f.runtime.jobs.list().length, 0);
  assert.equal(f.messages.size, 0);
  assert.equal(
    f.calls.filter((call) => ["POST", "PATCH", "DELETE"].includes(call.method)).length,
    0,
  );
});
