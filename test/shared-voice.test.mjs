import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
import { Store } from "../dist/storage/store.js";
import { loadConfig } from "../dist/config.js";
import { DiscordVoiceRooms, VoiceRoomError } from "../dist/bot/voice-rooms.js";
import { discordRoomService } from "../dist/bot/rooms.js";

const guildId = "600000000000000001",
  botId = "600000000000000002",
  alice = "600000000000000003",
  bob = "600000000000000004",
  categoryId = "600000000000000011",
  otherCategory = "600000000000000012",
  entryId = "600000000000000013";
const access =
  P.ViewChannel |
  P.Connect |
  P.SendMessages |
  P.ReadMessageHistory |
  P.ManageChannels |
  P.ManageRoles;
const flags = (value) => new PermissionsBitField(value);
const isCode = (code) => (error) => error instanceof VoiceRoomError && error.code === code;
function fixture(t, maximum = 2) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-09T12:00:00Z") });
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-voice-")),
    path = join(directory, "guild.sqlite"),
    stores = [],
    channels = new Map(),
    members = new Map(),
    calls = [];
  let serial = 620000000000000000n;
  const state = {
    postError: null,
    createThenFail: false,
    response: null,
    ready: true,
    wrongGuild: false,
  };
  const makeChannel = (id, type = ChannelType.GuildVoice, parentId = categoryId) => {
    const channel = {
      id,
      guildId,
      type,
      parentId,
      name: "Pokój",
      members: new Map(),
      permissionOverwrites: { cache: new Map() },
      permissionsFor: () => flags(access),
    };
    channels.set(id, channel);
    return channel;
  };
  makeChannel(categoryId, ChannelType.GuildCategory, null);
  makeChannel(otherCategory, ChannelType.GuildCategory, null);
  makeChannel(entryId);
  const guild = {
    id: guildId,
    available: true,
    async fetch() {
      calls.push({ method: "guild" });
      return this;
    },
    roles: {
      async fetch() {
        calls.push({ method: "roles" });
        return new Map();
      },
    },
    members: {
      async fetchMe(input) {
        assert.equal(input.force, true);
        calls.push({ method: "me" });
        return members.get(botId);
      },
    },
    voiceStates: { cache: new Map() },
    channels: {
      cache: channels,
      async fetch(id, input) {
        if (id === undefined) {
          calls.push({ method: "channels-all" });
          return channels;
        }
        assert.equal(input.force, true);
        calls.push({ method: "channel", id });
        const channel = channels.get(id);
        if (state.wrongGuild && channel) return { ...channel, guildId: "699999999999999999" };
        return channel ?? null;
      },
      async create() {
        throw Error("SDK channel create must not be used");
      },
    },
  };
  const person = (id) => ({
    id,
    displayName: id,
    user: { bot: id === botId },
    pending: false,
    isCommunicationDisabled: () => false,
    voice: {
      channelId: entryId,
      async setChannel(id) {
        for (const channel of channels.values()) channel.members.delete(id);
        channels.get(id)?.members.set(this.id ?? "", this);
        this.channelId = id;
        guild.voiceStates.cache.set(id, { channelId: id });
      },
    },
    roles: { cache: new Map() },
    permissions: flags(access),
  });
  for (const id of [botId, alice, bob]) {
    const member = person(id);
    member.voice.setChannel = async (channelId) => {
      for (const channel of channels.values()) channel.members.delete(id);
      channels.get(channelId)?.members.set(id, member);
      member.voice.channelId = channelId;
      guild.voiceStates.cache.set(id, { channelId });
    };
    members.set(id, member);
    guild.voiceStates.cache.set(id, { channelId: entryId });
  }
  const rest = {
    options: { retries: 0, rejectOnRateLimit: () => true },
    async post(route, options) {
      assert.equal(route, `/guilds/${guildId}/channels`);
      calls.push({ method: "POST", route, body: options.body, signal: options.signal });
      if (
        options.body.permission_overwrites.some(
          (entry) => (BigInt(entry.allow) & P.ManageRoles) !== 0n,
        )
      )
        throw new DiscordAPIError(
          { code: 50013, message: "Missing Permissions" },
          50013,
          403,
          "POST",
          route,
          { body: options.body, files: [] },
        );
      if (state.postError && !state.createThenFail) throw state.postError;
      const id = (++serial).toString(),
        channel = makeChannel(id, options.body.type, options.body.parent_id);
      channel.permissionOverwrites.cache = new Map(
        options.body.permission_overwrites.map((value) => [
          value.id,
          { ...value, allow: flags(BigInt(value.allow)), deny: flags(BigInt(value.deny)) },
        ]),
      );
      if (state.postError) throw state.postError;
      return state.response ?? { id };
    },
    async delete(route) {
      calls.push({ method: "DELETE", route });
      const id = route.split("/")[2];
      if (!channels.has(id)) throw Object.assign(Error("missing"), { code: 10003, status: 404 });
      assert.ok([...channels.get(id).members.values()].every((member) => member.user.bot));
      channels.delete(id);
    },
    async patch(route, options) {
      calls.push({ method: "PATCH", route, body: options.body });
      if (
        options.body.permission_overwrites?.some(
          (entry) => (BigInt(entry.allow) & P.ManageRoles) !== 0n,
        )
      )
        throw new DiscordAPIError(
          { code: 50013, message: "Missing Permissions" },
          50013,
          403,
          "PATCH",
          route,
          { body: options.body, files: [] },
        );
      const channel = channels.get(route.split("/")[2]);
      if (options.body.name) channel.name = options.body.name;
      if (options.body.permission_overwrites)
        channel.permissionOverwrites.cache = new Map(
          options.body.permission_overwrites.map((value) => [
            value.id,
            { ...value, allow: flags(BigInt(value.allow)), deny: flags(BigInt(value.deny)) },
          ]),
        );
      return { id: channel.id };
    },
  };
  const config = loadConfig();
  config.rooms.maximum = maximum;
  config.rooms.creationCooldownSeconds = 0;
  const control = {
    modules: { rooms: true, reactions: false, files: false, reports: false },
    rooms: { categoryId, entryChannelId: entryId, maxRooms: maximum, userLimit: 0 },
  };
  const open = () => {
    const store = new Store(path, guildId);
    stores.push(store);
    const context = {
      store,
      guild,
      config,
      control,
      managedLayout: false,
      environment: { clientId: botId },
      client: { user: { id: botId }, isReady: () => state.ready, ws: { status: 0 } },
      member: async (id) => members.get(id),
    };
    return { store, context, voice: new DiscordVoiceRooms(context, rest) };
  };
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* Reopened fixture. */
      }
    }
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-voice-")
    )
      throw Error("Unexpected directory");
    rmSync(directory, { recursive: true, force: true });
  });
  const input = (source, operation, extra = {}) => ({
    source,
    operation,
    objectId: source === "temporary" ? alice : "meeting-one",
    categoryId,
    name: "Pokój",
    userLimit: 0,
    overwrites: [
      { id: guildId, type: 0, allow: (P.ViewChannel | P.Connect).toString(), deny: "0" },
      { id: botId, type: 1, allow: access.toString(), deny: "0" },
    ],
    ...extra,
  });
  return {
    ...open(),
    open,
    rest,
    state,
    calls,
    channels,
    members,
    makeChannel,
    control,
    config,
    input,
    advance: (ms) => t.mock.timers.tick(ms),
  };
}

test("temporary and meeting rooms share one guild quota and confirmed deletion releases exactly one slot", async (t) => {
  const f = fixture(t, 2),
    temporary = await f.voice.create(f.input("temporary", "room-create:alice"));
  f.store.putRoom({
    id: temporary.id,
    owner: alice,
    locked: false,
    allowed: [],
    arrivals: {},
    emptySince: null,
    ownerAbsentSince: null,
  });
  const meeting = await f.voice.create(
    f.input("meeting", "community:meeting-room:one", { categoryId: otherCategory }),
  );
  f.store.putResource("community.meeting.meeting-one", "community-meeting-room", meeting.id, {
    guildId,
    meetingId: "meeting-one",
    parentId: otherCategory,
    createdBy: botId,
    owned: true,
  });
  assert.deepEqual(f.voice.counts(), { occupied: 2, reserved: 0, total: 2 });
  await assert.rejects(f.voice.create(f.input("meeting", "third")), isCode("voice_capacity"));
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 2);
  await f.voice.remove(temporary.id, { source: "temporary", categoryId });
  assert.ok(f.store.room(temporary.id));
  assert.equal(f.voice.counts().total, 1);
  await f.voice.create(f.input("meeting", "replacement"));
  assert.equal(f.voice.counts().total, 2);
  f.control.rooms.maxRooms = 1;
  assert.equal(f.voice.capacity(categoryId), false);
  assert.equal(f.channels.has(meeting.id), true);
});
test("separate SQLite connections cannot oversubscribe the final shared slot", async (t) => {
  const f = fixture(t, 1),
    other = f.open();
  const results = await Promise.allSettled([
    f.voice.create(f.input("temporary", "temporary")),
    other.voice.create(f.input("meeting", "meeting")),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.find((result) => result.status === "rejected").reason.code,
    "voice_capacity",
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(other.voice.counts().total, 1);
});
test("an unknown create keeps its shared reservation through restart and across sources", async (t) => {
  const f = fixture(t, 2);
  f.state.postError = { status: 500 };
  f.store.beginOperation("room-create:alice", { owner: alice });
  await assert.rejects(
    f.voice.create(f.input("temporary", "room-create:alice")),
    (error) => error instanceof VoiceRoomError && !error.notCreated,
  );
  assert.deepEqual(f.voice.counts(), { occupied: 0, reserved: 1, total: 1 });
  assert.equal(f.store.operations().length, 2);
  f.store.close();
  const reopened = f.open();
  f.state.postError = null;
  f.advance(86400000);
  await reopened.voice.create(f.input("meeting", "one-more"));
  assert.equal(reopened.voice.counts().total, 2);
  await assert.rejects(
    reopened.voice.create(f.input("meeting", "too-many")),
    isCode("voice_capacity"),
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 2);
});
test("an invalid successful response cannot be treated as rejection and free a reservation", async (t) => {
  const f = fixture(t, 1);
  f.state.response = { id: "invalid" };
  await assert.rejects(
    f.voice.create(f.input("meeting", "invalid-result")),
    (error) => error instanceof VoiceRoomError && !error.notCreated,
  );
  assert.equal(f.voice.counts().reserved, 1);
  assert.equal(f.store.operations().length, 1);
  f.state.response = null;
  await assert.rejects(f.voice.create(f.input("temporary", "another")), isCode("voice_capacity"));
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});
test("a created channel with unverified identity occupies quota but can never be adopted or deleted", async (t) => {
  const f = fixture(t, 1);
  f.state.wrongGuild = true;
  await assert.rejects(
    f.voice.create(f.input("meeting", "foreign-response")),
    (error) => error instanceof VoiceRoomError && !error.notCreated,
  );
  const resource = f.store
    .resources()
    .find((resource) => resource.kind === "voice-room-unverified");
  assert.ok(resource);
  await assert.rejects(
    f.voice.remove(resource.id, { source: "meeting", objectId: "meeting-one" }),
    isCode("voice_not_owned"),
  );
  assert.equal(f.voice.counts().total, 1);
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 0);
});
test("definitive Discord rejection and429 release slots while5xx never auto-retries", async (t) => {
  const f = fixture(t, 1);
  for (const status of [403, 429]) {
    f.state.postError = { status };
    await assert.rejects(
      f.voice.create(f.input("meeting", `rejected-${status}`)),
      (error) => error instanceof VoiceRoomError && error.notCreated,
    );
    assert.equal(f.voice.counts().total, 0);
  }
  f.state.postError = null;
  await f.voice.create(f.input("meeting", "accepted"));
  assert.equal(f.voice.counts().total, 1);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 3);
  assert.ok(f.calls.filter((call) => call.method === "POST").every((call) => call.signal));
});

test("non-admin voice creation, ACL updates and the entrance inherit ManageRoles without granting it", async (t) => {
  const f = fixture(t, 2),
    me = f.members.get(botId),
    channel = await f.voice.create(f.input("meeting", "guild-role-management"));
  assert.equal(me.permissions.has(P.ManageRoles), true);
  assert.equal(me.permissions.has(P.Administrator), false);
  await f.voice.permissions(
    channel.id,
    { source: "meeting", objectId: "meeting-one" },
    f.input("meeting", "acl").overwrites,
  );
  const entrance = discordRoomService(f.context, f.rest);
  await entrance.enter({ id: alice, name: "Alice", bot: false });
  const requests = f.calls.filter((call) => call.method === "POST" || call.method === "PATCH");
  assert.equal(requests.filter((call) => call.method === "POST").length, 2);
  assert.equal(requests.filter((call) => call.method === "PATCH").length, 1);
  for (const request of requests)
    assert.ok(
      request.body.permission_overwrites.every(
        (entry) => (BigInt(entry.allow) & (P.ManageRoles | P.Administrator)) === 0n,
      ),
    );
});

test("a channel-level grant cannot replace missing global management permissions", async (t) => {
  const f = fixture(t, 2),
    me = f.members.get(botId),
    channel = await f.voice.create(f.input("meeting", "before-revocation"));
  me.permissions = flags(access & ~P.ManageRoles);
  const mutations = f.calls.filter(
    (call) => call.method === "POST" || call.method === "PATCH",
  ).length;
  await assert.rejects(
    f.voice.create(f.input("meeting", "after-revocation")),
    isCode("voice_permission_unavailable"),
  );
  await assert.rejects(
    f.voice.permissions(
      channel.id,
      { source: "meeting", objectId: "meeting-one" },
      f.input("meeting", "acl").overwrites,
    ),
    isCode("voice_permission_unavailable"),
  );
  assert.equal(
    f.calls.filter((call) => call.method === "POST" || call.method === "PATCH").length,
    mutations,
  );
});

test("real SDK validation errors retain numeric diagnostics without persisting the request or message", async (t) => {
  const f = fixture(t, 1),
    privateValue = "UNRELATED_PRIVATE_REQUEST_CONTENT",
    raw = {
      code: 50035,
      message: privateValue,
      errors: {
        name: { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: privateValue }] },
        permission_overwrites: {
          1: { id: { _errors: [{ code: "ROLE_NOT_FOUND", message: privateValue }] } },
        },
        token: { _errors: [{ code: "PRIVATE_VALUE", message: privateValue }] },
      },
    };
  f.state.postError = new DiscordAPIError(
    raw,
    50035,
    400,
    "POST",
    `https://discord.com/api/guilds/${guildId}/channels?private=${privateValue}`,
    { body: { name: privateValue, token: privateValue }, files: [] },
  );
  await assert.rejects(f.voice.create(f.input("meeting", "invalid-discord-body")), (error) => {
    assert.ok(error instanceof VoiceRoomError);
    assert.equal(error.code, "voice_request_rejected");
    assert.equal(error.notCreated, true);
    assert.equal(error.status, 400);
    assert.equal(error.discordCode, 50035);
    assert.deepEqual(error.validationFields, [
      { field: "name", code: "BASE_TYPE_BAD_LENGTH" },
      { field: "permission_overwrites.1.id", code: "ROLE_NOT_FOUND" },
    ]);
    return true;
  });
  assert.equal(f.voice.counts().total, 0);
  const events = f.store.db.prepare("SELECT * FROM events WHERE kind='voice-create'").all();
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].result), {
    error: "voice_request_rejected",
    httpStatus: 400,
    discordCode: 50035,
    validationFields: [
      { field: "name", code: "BASE_TYPE_BAD_LENGTH" },
      { field: "permission_overwrites.1.id", code: "ROLE_NOT_FOUND" },
    ],
  });
  assert.ok(!JSON.stringify(events).includes(privateValue));
  assert.ok(!JSON.stringify(events).includes("https://"));
});

test("safe diagnostics preserve the same definitive and uncertain create classifications", async (t) => {
  for (const [status, discordCode] of [
    [403, 50013],
    [408, 0],
    [500, 0],
  ])
    await t.test(String(status), async (t) => {
      const f = fixture(t, 1);
      f.state.postError = new DiscordAPIError(
        { code: discordCode, message: "Synthetic SDK error" },
        discordCode,
        status,
        "POST",
        `https://discord.com/api/guilds/${guildId}/channels`,
        { body: {}, files: [] },
      );
      await assert.rejects(f.voice.create(f.input("meeting", `sdk-${status}`)), (error) => {
        assert.ok(error instanceof VoiceRoomError);
        assert.equal(error.notCreated, status === 403);
        assert.equal(error.status, status);
        assert.equal(error.discordCode, discordCode || undefined);
        return true;
      });
      assert.equal(f.voice.counts().total, status === 403 ? 0 : 1);
      const journal = JSON.parse(
        f.store.db.prepare("SELECT result FROM events WHERE kind='voice-create'").get().result,
      );
      assert.equal(journal.httpStatus, status);
      assert.equal(
        journal.error,
        status === 403 ? "voice_request_rejected" : "voice_unknown_create",
      );
    });
});
test("the real entrance factory shares meeting quota and uses the no-retry REST adapter", async (t) => {
  const f = fixture(t, 1),
    meeting = await f.voice.create(f.input("meeting", "meeting-first")),
    entrance = discordRoomService(f.context, f.rest);
  await assert.rejects(entrance.enter({ id: alice, name: "Alice", bot: false }), /capacity/);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  await f.voice.remove(meeting.id, { source: "meeting", objectId: "meeting-one" });
  const temporary = await entrance.enter({ id: alice, name: "Alice", bot: false });
  assert.ok(f.store.room(temporary));
  assert.deepEqual(f.voice.counts(), { occupied: 1, reserved: 0, total: 1 });
  await assert.rejects(
    f.voice.create(f.input("meeting", "blocked-by-entrance")),
    isCode("voice_capacity"),
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 2);
});
test("entrance429 clears only a confirmed non-create while unknown reservations remain durable", async (t) => {
  const f = fixture(t, 1),
    entrance = discordRoomService(f.context, f.rest);
  f.state.postError = { status: 429 };
  await assert.rejects(entrance.enter({ id: alice, name: "Alice", bot: false }));
  assert.equal(f.store.operations().length, 0);
  f.state.postError = { status: 500 };
  await assert.rejects(entrance.enter({ id: bob, name: "Bob", bot: false }));
  assert.equal(f.voice.counts().reserved, 1);
  assert.equal(f.store.operations().length, 2);
});
test("inspection never adopts an arbitrary existing voice channel, even in the same category", async (t) => {
  const f = fixture(t),
    foreign = f.makeChannel("630000000000000001");
  await assert.rejects(
    f.voice.inspect(foreign.id, { source: "meeting", objectId: "selected-existing" }),
    isCode("voice_not_owned"),
  );
  await assert.rejects(
    f.voice.remove(foreign.id, { source: "temporary", categoryId }),
    isCode("voice_not_owned"),
  );
  assert.equal(f.store.resources().length, 0);
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 0);
});
test("legacy trusted room rows are migrated lazily but wrong category is never adopted", async (t) => {
  const f = fixture(t),
    legacy = f.makeChannel("630000000000000001"),
    wrong = f.makeChannel("630000000000000002", ChannelType.GuildVoice, otherCategory);
  for (const channel of [legacy, wrong])
    f.store.putRoom({
      id: channel.id,
      owner: channel.id === legacy.id ? alice : bob,
      locked: false,
      allowed: [],
      arrivals: {},
      emptySince: null,
      ownerAbsentSince: null,
    });
  assert.equal(
    (await f.voice.inspect(legacy.id, { source: "temporary", categoryId })).id,
    legacy.id,
  );
  assert.equal(f.store.resource(`voice.room.${legacy.id}`).kind, "voice-room");
  await assert.rejects(
    f.voice.inspect(wrong.id, { source: "temporary", categoryId }),
    isCode("voice_identity_changed"),
  );
  assert.equal(f.store.resource(`voice.room.${wrong.id}`), undefined);
});
test("humans and disconnected gateway stop deletion, while bots-only owned rooms can be removed", async (t) => {
  const f = fixture(t),
    channel = await f.voice.create(f.input("meeting", "room")),
    identity = { source: "meeting", objectId: "meeting-one" };
  channel.members.set(alice, f.members.get(alice));
  await assert.rejects(f.voice.remove(channel.id, identity), isCode("voice_occupied"));
  channel.members.clear();
  f.state.ready = false;
  await assert.rejects(f.voice.remove(channel.id, identity), isCode("voice_gateway_unavailable"));
  f.state.ready = true;
  channel.members.set(botId, f.members.get(botId));
  await f.voice.remove(channel.id, identity);
  assert.equal(f.voice.counts().total, 0);
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 1);
});
test("cached presence inspection avoids per-poll REST, but mutations force fresh identity checks", async (t) => {
  const f = fixture(t),
    channel = await f.voice.create(f.input("meeting", "room")),
    identity = { source: "meeting", objectId: "meeting-one" };
  f.calls.length = 0;
  for (let index = 0; index < 10; index++)
    await f.voice.inspect(channel.id, identity, { fresh: false });
  assert.equal(f.calls.length, 0);
  await f.voice.rename(channel.id, identity, "Nowa nazwa");
  assert.ok(f.calls.some((call) => call.method === "channel"));
  assert.equal(channel.name, "Nowa nazwa");
  channel.parentId = otherCategory;
  await assert.rejects(f.voice.remove(channel.id, identity), isCode("voice_identity_changed"));
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 0);
});
test("physical channel/category limits are shared even when unrelated channels consume the space", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 44; index++)
    f.makeChannel((640000000000000000n + BigInt(index)).toString(), ChannelType.GuildText);
  assert.equal(f.voice.capacity(categoryId), false);
  await assert.rejects(
    f.voice.create(f.input("meeting", "full-category")),
    isCode("voice_capacity"),
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
});
test("unsafe transports are rejected before any mutation", async (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      new DiscordVoiceRooms(f.context, { options: { retries: 3, rejectOnRateLimit: () => true } }),
    isCode("voice_unsafe_transport"),
  );
  assert.throws(
    () => new DiscordVoiceRooms(f.context, { options: { retries: 0 } }),
    isCode("voice_unsafe_transport"),
  );
});

test("a forbidden confirmation GET after successful POST remains unknown and keeps its slot", async (t) => {
  const f = fixture(t, 1),
    original = f.context.guild.channels.fetch.bind(f.context.guild.channels);
  f.context.guild.channels.fetch = async (id, ...args) => {
    if (id && ![categoryId, otherCategory, entryId].includes(id))
      throw Object.assign(Error("confirmation denied"), { status: 403, code: 50001 });
    return original(id, ...args);
  };
  await assert.rejects(
    f.voice.create(f.input("meeting", "accepted-but-unconfirmed")),
    (error) => error instanceof VoiceRoomError && !error.notCreated,
  );
  assert.equal(f.voice.counts().total, 1);
  assert.equal(f.store.operations().length, 1);
  assert.ok(f.store.resources().some((resource) => resource.kind === "voice-room-unverified"));
  await assert.rejects(f.voice.create(f.input("temporary", "next")), isCode("voice_capacity"));
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});
test("an already completed active operation never creates twice, while confirmed deletion permits a new entrance cycle", async (t) => {
  const f = fixture(t, 2),
    input = f.input("temporary", "repeat-operation"),
    channel = await f.voice.create(input);
  await assert.rejects(f.voice.create(input), isCode("voice_existing_operation"));
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  await f.voice.remove(channel.id, { source: "temporary", categoryId });
  await f.voice.create(input);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 2);
  assert.equal(f.voice.counts().total, 1);
});
test("fresh create snapshots override stale cached siblings and reject a category absent from the current list", async (t) => {
  const f = fixture(t),
    original = f.context.guild.channels.fetch.bind(f.context.guild.channels),
    fresh = new Map(f.channels);
  for (let index = 0; index < 44; index++)
    f.makeChannel((650000000000000000n + BigInt(index)).toString(), ChannelType.GuildText);
  assert.equal(f.voice.capacity(categoryId), false);
  f.context.guild.channels.fetch = async (id, ...args) =>
    id === undefined ? fresh : original(id, ...args);
  const created = await f.voice.create(f.input("meeting", "fresh-list"));
  assert.ok(created);
  fresh.delete(categoryId);
  await assert.rejects(
    f.voice.create(f.input("meeting", "removed-category")),
    isCode("voice_permission_unavailable"),
  );
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
});
test("voice user limits follow the Discord0..99 contract without silently clamping", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.voice.create(f.input("meeting", "too-large", { userLimit: 100 })),
    isCode("voice_invalid_input"),
  );
  assert.equal(f.store.operations().length, 0);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
  await f.voice.create(f.input("meeting", "ninety-nine", { userLimit: 99 }));
  assert.equal(f.calls.find((call) => call.method === "POST").body.user_limit, 99);
});
test("permission changes are not acknowledged when the forced reread disagrees with the requested ACL", async (t) => {
  const f = fixture(t),
    channel = await f.voice.create(f.input("meeting", "room"));
  f.rest.patch = async () => ({ id: channel.id });
  await assert.rejects(
    f.voice.permissions(channel.id, { source: "meeting", objectId: "meeting-one" }, [
      { id: guildId, type: 0, allow: "0", deny: P.ViewChannel.toString() },
      { id: botId, type: 1, allow: access.toString(), deny: "0" },
    ]),
    isCode("voice_permissions_unconfirmed"),
  );
});

test("the entrance inherits fresh parent permissions rather than re-granting a stale cached overwrite", async (t) => {
  const f = fixture(t),
    cached = f.channels.get(categoryId),
    oldRole = "660000000000000001";
  cached.permissionOverwrites.cache.set(oldRole, {
    id: oldRole,
    type: 0,
    allow: flags(P.ViewChannel | P.Connect),
    deny: flags(0n),
  });
  const currentCategory = { ...cached, permissionOverwrites: { cache: new Map() } },
    fresh = new Map(f.channels);
  fresh.set(categoryId, currentCategory);
  const original = f.context.guild.channels.fetch.bind(f.context.guild.channels);
  f.context.guild.channels.fetch = async (id, ...args) =>
    id === undefined ? fresh : id === categoryId ? currentCategory : original(id, ...args);
  const entrance = discordRoomService(f.context, f.rest);
  const roomId = await entrance.enter({ id: alice, name: "Alice", bot: false });
  const create = f.calls.find((call) => call.method === "POST");
  assert.ok(!create.body.permission_overwrites.some((overwrite) => overwrite.id === oldRole));
  await entrance.control(roomId, alice, false, "close");
  const changed = f.calls.find(
    (call) => call.method === "PATCH" && call.body.permission_overwrites,
  );
  assert.ok(!changed.body.permission_overwrites.some((overwrite) => overwrite.id === oldRole));
});
