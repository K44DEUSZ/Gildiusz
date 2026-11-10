import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  ChannelType,
  GuildChannelManager,
  MessageFlags,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
import {
  communityCommands,
  communityInteraction,
  communityButtonId,
} from "../dist/bot/community-commands.js";
import { ModuleRuntime } from "../dist/bot/module-runtime.js";
import { Store } from "../dist/storage/store.js";
import { noMentions } from "../dist/shared/utils.js";
import { submitReport } from "../dist/bot/reports.js";

const guildId = "700000000000000001",
  ownerId = "700000000000000002",
  botId = "700000000000000003",
  organizerId = "700000000000000004",
  staffId = "700000000000000005",
  userId = "700000000000000006",
  strangerId = "700000000000000007",
  organizerRole = "700000000000000011",
  staffRole = "700000000000000012",
  accessRole = "700000000000000013",
  textId = "700000000000000021",
  categoryId = "700000000000000022",
  voiceId = "700000000000000023";
const access = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.Connect;
const flags = (value = 0n) => new PermissionsBitField(value);
function fixture(t, { beta = true } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-09T12:00:00Z") });
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-community-commands-")),
    path = join(directory, "guild.sqlite");
  const roles = new Map(
    [guildId, organizerRole, staffRole, accessRole].map((id) => [
      id,
      { id, name: "Rola", managed: false, mentionable: false, permissions: flags() },
    ]),
  );
  const people = new Map(),
    order = [],
    requests = [],
    effects = [];
  const state = { memberError: null, channelError: null };
  for (const [id, roleIds] of [
    [ownerId, []],
    [botId, []],
    [organizerId, [organizerRole]],
    [staffId, [staffRole]],
    [userId, []],
    [strangerId, []],
  ])
    people.set(id, {
      id,
      displayName: "Osoba",
      user: { id, bot: id === botId },
      roles: { cache: new Map(roleIds.map((role) => [role, roles.get(role)])) },
      permissions: flags(id === ownerId ? P.ManageGuild : 0n),
      voice: { channelId: null },
      pending: false,
      timedOut: false,
      isCommunicationDisabled() {
        return this.timedOut;
      },
    });
  const channels = new Map(
    [
      [textId, ChannelType.GuildText],
      [categoryId, ChannelType.GuildCategory],
      [voiceId, ChannelType.GuildVoice],
    ].map(([id, type]) => [
      id,
      {
        id,
        type,
        guildId,
        parentId: type === ChannelType.GuildVoice ? categoryId : null,
        name: "Kanał",
        members: new Map(),
        permissionOverwrites: { cache: new Map() },
        permissionsFor(subject) {
          return flags(access | (subject.id === botId ? P.ManageChannels | P.ManageRoles : 0n));
        },
      },
    ]),
  );
  const guild = {
    id: guildId,
    ownerId,
    available: true,
    async fetch() {
      order.push("guild");
      t.mock.timers.tick(2);
      this.ownerId = ownerId;
      return this;
    },
    roles: {
      cache: roles,
      everyone: roles.get(guildId),
      async fetch() {
        order.push("roles");
        return roles;
      },
    },
    members: {
      cache: people,
      async fetch(options) {
        order.push("member");
        assert.equal(options.force, true);
        if (state.memberError) throw state.memberError;
        const value = people.get(options.user);
        if (!value) throw Object.assign(Error("private lookup detail"), { code: 10007 });
        return value;
      },
      async fetchMe(options) {
        assert.equal(options.force, true);
        return people.get(botId);
      },
    },
    channels: {
      cache: channels,
      async fetch(id, options) {
        if (id === undefined) return channels;
        assert.equal(options.force, true);
        if (state.channelError) throw state.channelError;
        return channels.get(id) ?? null;
      },
    },
    voiceStates: { cache: new Map() },
  };
  let store,
    runtime,
    sequence = 0;
  const open = () => {
    store = new Store(path, guildId);
    runtime = new ModuleRuntime(
      {
        guild,
        store,
        environment: { clientId: botId },
        client: { user: { id: botId }, isReady: () => true, ws: { status: 0 } },
        control: { modules: { rooms: true, reactions: true, files: true, reports: true } },
      },
      {
        options: { retries: 0 },
        async post(...args) {
          effects.push(args);
          throw Error("Commands must queue effects");
        },
        async patch(...args) {
          effects.push(args);
          throw Error("Unexpected patch");
        },
      },
      beta,
    );
    if (!runtime.settings.read().revision)
      runtime.settings.save(
        {
          ...runtime.settings.read(),
          organizerRoleIds: [organizerRole],
          caseModeratorRoleIds: [staffRole],
          enabled: { ...runtime.settings.read().enabled, meetings: true, cases: true },
          cases: {
            categoryId,
            suggestionChannelId: textId,
            suggestionVisibility: "approval",
            voting: { enabled: true, statuses: ["new", "in_review"] },
            reasonRequiredStatuses: ["accepted", "rejected"],
            retentionMs: null,
          },
        },
        ownerId,
      );
    const original = runtime.request.bind(runtime);
    runtime.request = async (...args) => {
      requests.push(args);
      return original(...args);
    };
  };
  open();
  t.after(() => {
    store.close();
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-community-commands-")
    )
      throw Error("Unexpected test directory.");
    rmSync(directory, { recursive: true, force: true });
  });
  function interaction(name, action, values = {}, extra = {}) {
    const replies = [],
      deferred = [];
    const value = {
      id: String(800000000000000000n + BigInt(++sequence)),
      createdTimestamp: Date.now(),
      commandName: name,
      guildId,
      user: { id: extra.actorId ?? userId },
      memberPermissions: flags(P.Administrator),
      isChatInputCommand: () => !extra.customId,
      isButton: () => Boolean(extra.customId),
      customId: extra.customId ?? "",
      options: {
        getSubcommand: () => action,
        getString: (key) => values[key] ?? null,
        getInteger: (key) => values[key] ?? null,
        getBoolean: (key) => values[key] ?? null,
        getChannel: (key) =>
          values[key] ? { id: values[key] } : key === "kanal" ? { id: textId } : null,
        getRole: (key) => (values[key] ? { id: values[key] } : null),
        getUser: (key) => (values[key] ? { id: values[key] } : null),
      },
      async deferReply(input) {
        order.push("defer");
        deferred.push(input);
      },
      async editReply(input) {
        replies.push(input);
      },
      ...extra,
    };
    return { value, replies, deferred, last: () => replies.at(-1)?.content ?? "" };
  }
  async function run(name, action, values = {}, extra = {}) {
    const result = interaction(name, action, values, extra);
    assert.equal(await communityInteraction(runtime, result.value), true);
    assert.deepEqual(result.deferred, [{ flags: MessageFlags.Ephemeral }]);
    assert.equal(result.replies.length, 1);
    assert.deepEqual(result.replies[0].allowedMentions, noMentions);
    return result;
  }
  const meetingId = () =>
    store.db.prepare("SELECT id FROM meetings ORDER BY created_at DESC LIMIT 1").get()?.id;
  const caseId = () =>
    store.db.prepare("SELECT id FROM cases ORDER BY created_at DESC LIMIT 1").get()?.id;
  return {
    run,
    interaction,
    people,
    guild,
    roles,
    channels,
    state,
    order,
    requests,
    effects,
    runtime: () => runtime,
    store: () => store,
    meetingId,
    caseId,
    reopen: () => {
      store.close();
      open();
    },
  };
}

test("community registration keeps the existing report command registration", () => {
  const values = communityCommands();
  assert.deepEqual(
    values.map((command) => command.name),
    ["spotkanie", "ekipa", "sprawa", "pomysl"],
  );
  for (const command of values) {
    assert.deepEqual(command.contexts, [0]);
    assert.deepEqual(command.integration_types, [0]);
    assert.equal(command.default_member_permissions, undefined);
  }
  assert.ok(
    values
      .find((command) => command.name === "sprawa")
      .options.some((option) => option.name === "notatka"),
  );
  assert.ok(!values.some((command) => command.name === "zglos"));
});

test("unrelated commands and buttons are ignored without a reply or membership fetch", async (t) => {
  const f = fixture(t);
  for (const value of [
    f.interaction("ustawienia", "utworz"),
    f.interaction("", "", {}, { customId: "another:button" }),
  ]) {
    assert.equal(await communityInteraction(f.runtime(), value.value), false);
    assert.equal(value.replies.length, 0);
    assert.equal(value.deferred.length, 0);
  }
  assert.deepEqual(f.order, []);
  assert.equal(f.requests.length, 0);
});

function prepareReport(f) {
  f.people.get(botId).permissions = flags(P.ManageChannels | P.ManageRoles);
  f.runtime().context.config = { moderation: { reportCooldownSeconds: 60 } };
  f.store().putResource("channel.moderation", "channel", textId, {});
  f.store()
    .db.prepare("INSERT OR IGNORE INTO control_configuration VALUES (?,?)")
    .run(guildId, JSON.stringify({ modules: { reports: true }, reports: { channelId: textId } }));
  const channel = f.channels.get(textId);
  channel.isTextBased = () => true;
  channel.isThread = () => false;
  channel.messages = {
    async fetch(options) {
      assert.deepEqual(options, { message: "700000000000000031", force: true });
      return { id: options.message };
    },
  };
  return () =>
    f.store().db.prepare("SELECT body FROM control_configuration WHERE guild=?").get(guildId).body;
}

test("report alias creates one private case through the shared backend and replays after restart", async (t) => {
  const f = fixture(t),
    legacy = prepareReport(f),
    before = legacy(),
    input = { powod: "Opis problemu bez osobnego tematu" },
    result = await f.run("zglos", "", input);
  assert.match(result.last(), /Sprawa została zapisana.*Widoczność: prywatna/);
  assert.deepEqual(f.order.slice(0, 4), ["defer", "guild", "roles", "member"]);
  const row = f.store().db.prepare("SELECT * FROM cases").get();
  assert.equal(row.kind, "report");
  assert.equal(row.title, "Zgłoszenie");
  assert.equal(row.content, input.powod);
  assert.equal(row.visibility, "private");
  assert.equal(f.requests[0][1], "cases.create");
  assert.equal(f.requests[0][4], "discord_" + result.value.id);
  assert.equal(f.requests[0][0].owner, false);
  assert.equal(f.requests[0][0].manageGuild, false);
  assert.equal(
    f.store().db.prepare("SELECT COUNT(*) n FROM events WHERE kind='report'").get().n,
    0,
  );
  assert.equal(
    f.store().db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='community.case-channel'").get().n,
    1,
  );
  assert.equal(legacy(), before);
  f.reopen();
  prepareReport(f);
  assert.equal(await communityInteraction(f.runtime(), result.value), true);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM cases").get().n, 1);
  assert.equal(
    f.store().db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='community.case-channel'").get().n,
    1,
  );
  assert.equal(legacy(), before);
  assert.equal(f.effects.length, 0);
  result.value.options.getString = (key) =>
    key === "powod" ? "Inny opis tej samej interakcji" : null;
  await communityInteraction(f.runtime(), result.value);
  assert.match(result.last(), /Ta próba ma już inne zapisane dane/);
  assert.equal(f.store().db.prepare("SELECT content FROM cases").get().content, input.powod);
});

test("case OFF leaves the original report destination and event-only storage in use", async (t) => {
  const f = fixture(t),
    legacy = prepareReport(f),
    before = legacy();
  const settings = f.runtime().settings.read();
  f.runtime().settings.save(
    { ...settings, enabled: { ...settings.enabled, cases: false } },
    ownerId,
  );
  const command = f.interaction("zglos", "", { powod: "Opis na dawnym kanale" });
  assert.equal(await communityInteraction(f.runtime(), command.value), false);
  assert.equal(command.deferred.length, 0);
  const sent = [];
  f.runtime().context.member = async () => f.people.get(userId);
  f.runtime().context.texts = { reportSent: "Przekazano zgłoszenie." };
  f.runtime().context.textChannel = async (key) => {
    assert.equal(key, "moderation");
    return {
      id: textId,
      send: async (payload) => {
        sent.push(payload);
        return { id: "700000000000000032" };
      },
    };
  };
  await command.value.deferReply({ flags: MessageFlags.Ephemeral });
  await submitReport(f.runtime().context, command.value);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowedMentions, noMentions);
  assert.equal(
    f.store().db.prepare("SELECT channel FROM events WHERE kind='report'").get().channel,
    textId,
  );
  assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM cases").get().n, 0);
  assert.equal(legacy(), before);
});

test("enabled cases never fall back to legacy reports when configuration or bot access is missing", async (t) => {
  for (const missing of ["category", "permissions", "role", "beta"]) {
    await t.test(missing, async (t) => {
      const f = fixture(t, { beta: missing !== "beta" });
      prepareReport(f);
      if (missing === "category") {
        const settings = f.runtime().settings.read();
        f.runtime().settings.save(
          { ...settings, cases: { ...settings.cases, categoryId: "" } },
          ownerId,
        );
      }
      if (missing === "permissions") f.people.get(botId).permissions = flags();
      if (missing === "role") f.roles.delete(staffRole);
      const writes = f.store().db.prepare("SELECT total_changes() n").get().n;
      const result = await f.run("zglos", "", {
        powod: "Prywatny opis nie może trafić na stary kanał",
      });
      assert.ok(/konfiguracji|uprawnienia bota|niedostępna/.test(result.last()));
      assert.equal(f.store().db.prepare("SELECT total_changes() n").get().n, writes);
      assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM cases").get().n, 0);
      assert.equal(f.effects.length, 0);
      assert.equal(f.requests.length, 0);
    });
  }
});

test("report alias checks fresh ordinary-member eligibility before any write", async (t) => {
  for (const kind of ["pending", "timeout", "bot", "departed", "foreign"]) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      prepareReport(f);
      if (kind === "pending") f.people.get(userId).pending = true;
      if (kind === "timeout") f.people.get(userId).timedOut = true;
      if (kind === "bot") f.people.get(userId).user.bot = true;
      if (kind === "departed") f.people.delete(userId);
      const writes = f.store().db.prepare("SELECT total_changes() n").get().n;
      const result = await f.run(
        "zglos",
        "",
        { powod: "Nie zapisuj nieuprawnionej sprawy" },
        kind === "foreign" ? { guildId: strangerId } : {},
      );
      assert.ok(!result.last().includes("została zapisana"));
      assert.equal(f.store().db.prepare("SELECT total_changes() n").get().n, writes);
      assert.equal(f.requests.length, 0);
      assert.equal(f.effects.length, 0);
    });
  }
});

test("report alias preserves old input limits and cooldown without blocking the same receipt", async (t) => {
  const f = fixture(t);
  prepareReport(f);
  for (const powod of ["  ", "ab", "x".repeat(1001)]) {
    const result = await f.run("zglos", "", { powod });
    assert.match(result.last(), /od 3 do 1000/);
  }
  assert.equal(f.requests.length, 0);
  const first = await f.run("zglos", "", { powod: "x".repeat(1000) });
  assert.match(first.last(), /Sprawa została zapisana/);
  assert.equal(await communityInteraction(f.runtime(), first.value), true);
  assert.match(first.last(), /Sprawa została zapisana/);
  assert.match((await f.run("zglos", "", { powod: "Kolejna sprawa" })).last(), /Odczekaj/);
  t.mock.timers.tick(60001);
  assert.match(
    (await f.run("zglos", "", { powod: "Po odczekaniu" })).last(),
    /Sprawa została zapisana/,
  );
  assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM cases").get().n, 2);
  assert.equal(f.effects.length, 0);
});

test("report links remain guild-scoped and require current message visibility", async (t) => {
  const f = fixture(t);
  prepareReport(f);
  const link = `https://discord.com/channels/${guildId}/${textId}/700000000000000031`;
  assert.match(
    (
      await f.run("zglos", "", {
        powod: "Problem z wiadomością",
        wiadomosc: link.replace(guildId, strangerId),
      })
    ).last(),
    /z tego serwera/,
  );
  const channel = f.channels.get(textId),
    original = channel.permissionsFor;
  channel.permissionsFor = (member) => (member.id === userId ? flags() : original(member));
  assert.match(
    (await f.run("zglos", "", { powod: "Problem z wiadomością", wiadomosc: link })).last(),
    /Nie masz dostępu/,
  );
  assert.equal(f.requests.length, 0);
  channel.permissionsFor = original;
  assert.match(
    (await f.run("zglos", "", { powod: "Problem z wiadomością", wiadomosc: link })).last(),
    /Sprawa została zapisana/,
  );
  assert.equal(
    f.store().db.prepare("SELECT content FROM cases").get().content,
    `Problem z wiadomością\n\n${link}`,
  );
  assert.equal(f.effects.length, 0);
});

test("report preflight preserves Discord network failures instead of writing or falling back", async (t) => {
  const f = fixture(t);
  prepareReport(f);
  for (const error of [
    Object.assign(Error("private transport detail"), { status: 429 }),
    Error("private network detail"),
  ]) {
    f.state.channelError = error;
    const writes = f.store().db.prepare("SELECT total_changes() n").get().n;
    const result = await f.run("zglos", "", { powod: "Nie publikuj podczas awarii" });
    assert.match(result.last(), /Nie udało się potwierdzić wyniku/);
    assert.equal(result.last().includes("private"), false);
    assert.equal(f.store().db.prepare("SELECT total_changes() n").get().n, writes);
    assert.equal(f.requests.length, 0);
    assert.equal(f.effects.length, 0);
  }
});

test("report alias rejects a foreign category returned through the actual Discord SDK before writing", async (t) => {
  const f = fixture(t);
  prepareReport(f);
  const manager = {
    guild: { id: guildId },
    client: {
      rest: {
        async get() {
          return { id: categoryId, guild_id: strangerId, type: ChannelType.GuildCategory };
        },
      },
    },
  };
  f.guild.channels.fetch = (id, options) =>
    GuildChannelManager.prototype.fetch.call(manager, id, options);
  const writes = f.store().db.prepare("SELECT total_changes() n").get().n;
  assert.match(
    (await f.run("zglos", "", { powod: "Nie zapisuj w obcym serwerze" })).last(),
    /uprawnienia bota/,
  );
  assert.equal(f.store().db.prepare("SELECT total_changes() n").get().n, writes);
  assert.equal(f.requests.length, 0);
  assert.equal(f.effects.length, 0);
});

test("a private-thread report requires a forced membership read and never copies source message text", async (t) => {
  const f = fixture(t);
  prepareReport(f);
  const channel = f.channels.get(textId);
  channel.type = ChannelType.PrivateThread;
  channel.isThread = () => true;
  let reads = 0;
  channel.members = {
    async fetch(options) {
      assert.deepEqual(options, { member: userId, force: true });
      reads++;
      return reads === 1 ? null : { id: userId };
    },
  };
  channel.messages.fetch = async (options) => {
    assert.equal(options.force, true);
    return { id: options.message, content: "Source content must not be copied" };
  };
  const input = {
    powod: "Sprawdź wiadomość z prywatnego wątku",
    wiadomosc: `https://discord.com/channels/${guildId}/${textId}/700000000000000031`,
  };
  assert.match((await f.run("zglos", "", input)).last(), /Nie masz dostępu/);
  assert.equal(f.requests.length, 0);
  assert.match((await f.run("zglos", "", input)).last(), /Sprawa została zapisana/);
  assert.equal(
    f.store().db.prepare("SELECT content FROM cases").get().content.includes("Source content"),
    false,
  );
  assert.equal(f.effects.length, 0);
});

test("a module-settings change during report preflight is rejected without a silent legacy send", async (t) => {
  const f = fixture(t);
  prepareReport(f);
  f.guild.members.fetchMe = async () => {
    const settings = f.runtime().settings.read();
    f.runtime().settings.save(
      { ...settings, enabled: { ...settings.enabled, cases: false } },
      ownerId,
    );
    return f.people.get(botId);
  };
  assert.match(
    (await f.run("zglos", "", { powod: "Nie wysyłaj po zmianie konfiguracji" })).last(),
    /Dane zostały zmienione/,
  );
  assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM cases").get().n, 0);
  assert.equal(f.effects.length, 0);
  assert.equal(f.requests.length, 0);
});

test("delegated organizer creates an immediate team from a stable timestamp and replays after restart", async (t) => {
  const f = fixture(t),
    created = await f.run(
      "ekipa",
      "",
      { temat: "Ekipa do projektu", opis: "Prywatny opis formularza", miejsca: 3, czas: 90 },
      { actorId: organizerId },
    );
  assert.deepEqual(f.order.slice(0, 4), ["defer", "guild", "roles", "member"]);
  assert.match(created.last(), /Spotkanie zapisane/);
  const [call] = f.requests;
  assert.equal(call[0].owner, false);
  assert.equal(call[0].manageGuild, false);
  assert.equal(call[1], "meetings.create");
  assert.equal(call[2].startsAt, created.value.createdTimestamp);
  assert.equal(call[2].endsAt, created.value.createdTimestamp + 90 * 60000);
  assert.equal(Object.hasOwn(call[2], "mentionEveryone"), false);
  const before = f.meetingId();
  t.mock.timers.tick(120000);
  f.reopen();
  assert.equal(await communityInteraction(f.runtime(), created.value), true);
  assert.match(created.last(), /Spotkanie zapisane/);
  assert.equal(f.meetingId(), before);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 1);
  assert.equal(f.effects.length, 0);
  const metadata = f
    .store()
    .db.prepare("SELECT result FROM idempotency_keys WHERE scope LIKE 'discord-community:%'")
    .all();
  assert.ok(!JSON.stringify(metadata).includes("Prywatny opis formularza"));
});

test("local scheduled time and selected room/category are validated before queuing effects", async (t) => {
  const f = fixture(t);
  const first = await f.run(
    "spotkanie",
    "utworz",
    { temat: "Na termin", termin: "2027-01-01 18:00", pokoj: voiceId, rola: accessRole },
    { actorId: organizerId },
  );
  assert.match(first.last(), /Spotkanie zapisane/);
  const draft = f.requests.find((call) => call[1] === "meetings.create")[2];
  assert.equal(draft.startsAt, Date.parse("2027-01-01T17:00:00Z"));
  assert.deepEqual(draft.room, { kind: "existing", channelId: voiceId });
  assert.deepEqual(draft.allowedRoleIds, [accessRole]);
  const settings = f.runtime().settings.read();
  f.runtime().settings.save({ ...settings, timeZone: "Europe/London" }, ownerId);
  await communityInteraction(f.runtime(), first.value);
  assert.match(first.last(), /Spotkanie zapisane/);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 1);
  for (const values of [
    { termin: "2027/01/01 18:00" },
    { termin: "2027-02-30 18:00" },
    { pokoj: voiceId, kategoria: categoryId },
  ]) {
    const failed = await f.run(
      "spotkanie",
      "utworz",
      { temat: "Błędne", ...values },
      { actorId: organizerId },
    );
    assert.doesNotMatch(failed.last(), /Spotkanie zapisane/);
  }
  assert.equal(f.effects.length, 0);
});

test("ordinary member can join the waitlist and sees own place plus permitted actions", async (t) => {
  const f = fixture(t);
  await f.run(
    "spotkanie",
    "utworz",
    { temat: "Jedno miejsce", miejsca: 1, termin: "2027-01-01 18:00" },
    { actorId: organizerId },
  );
  const id = f.meetingId(),
    joined = await f.run("spotkanie", "dolacz", { id });
  assert.match(joined.last(), /Jesteś w rezerwie/);
  assert.match(joined.last(), /Miejsce w kolejce: 1/);
  const status = await f.run("spotkanie", "stan", { id });
  assert.match(status.last(), /Dostępne działania/);
  assert.match(status.last(), /Rezygnuję/);
  assert.doesNotMatch(status.last(), /Rozpocznij spotkanie/);
  await f.run("spotkanie", "rezygnuj", { id });
  assert.equal(
    f
      .store()
      .db.prepare("SELECT state FROM meeting_participants WHERE meeting_id=? AND user_id=?")
      .get(id, userId).state,
    "left",
  );
});

test("fresh role revocation, member removal and pending state reject cached-admin creation", async (t) => {
  const f = fixture(t);
  f.people.get(organizerId).roles.cache.clear();
  const revoked = await f.run("ekipa", "", { temat: "Nie wolno" }, { actorId: organizerId });
  assert.doesNotMatch(revoked.last(), /Spotkanie zapisane/);
  f.people.get(userId).pending = true;
  const pending = await f.run("sprawa", "utworz", { temat: "Sprawa", tresc: "Opis" });
  assert.doesNotMatch(pending.last(), /Sprawa została zapisana/);
  f.people.get(userId).pending = false;
  f.people.delete(userId);
  const removed = await f.run("sprawa", "utworz", { temat: "Sprawa", tresc: "Opis" });
  assert.doesNotMatch(removed.last(), /private lookup detail/);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 0);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) AS n FROM cases").get().n, 0);
});

test("beta-off runtime refuses community mutations even for an administrator", async (t) => {
  const f = fixture(t, { beta: false });
  const meeting = await f.run("ekipa", "", { temat: "Wyłączona beta" }, { actorId: ownerId });
  const support = await f.run(
    "sprawa",
    "utworz",
    { temat: "Sprawa", tresc: "Opis" },
    { actorId: ownerId },
  );
  assert.match(meeting.last(), /wyłączona|niedostępna/);
  assert.match(support.last(), /wyłączona|niedostępna/);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 0);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) AS n FROM cases").get().n, 0);
});

test("authorized start, completion and cancellation change durable state with replay-safe revisions", async (t) => {
  const f = fixture(t);
  await f.run(
    "spotkanie",
    "utworz",
    { temat: "Rozpoczęcie", termin: "2027-01-01 18:00" },
    { actorId: organizerId },
  );
  const id = f.meetingId(),
    started = await f.run("spotkanie", "rozpocznij", { id }, { actorId: organizerId });
  assert.match(started.last(), /przygotowanie/);
  assert.equal(
    f.store().db.prepare("SELECT state FROM meetings WHERE id=?").get(id).state,
    "starting",
  );
  const [lease] = f.runtime().jobs.claim({ types: ["meeting.start"], limit: 1 });
  await f.runtime().community.meetings.prepare(lease);
  f.runtime().community.meetings.recordResult(lease, {});
  const completed = await f.run("spotkanie", "zakoncz", { id }, { actorId: organizerId });
  assert.match(completed.last(), /zakończone/);
  const revision = f
    .store()
    .db.prepare("SELECT revision FROM meetings WHERE id=?")
    .get(id).revision;
  f.reopen();
  await communityInteraction(f.runtime(), completed.value);
  assert.equal(
    f.store().db.prepare("SELECT revision FROM meetings WHERE id=?").get(id).revision,
    revision,
  );
  await f.run(
    "spotkanie",
    "utworz",
    { temat: "Odwołanie", termin: "2027-01-01 18:00" },
    { actorId: organizerId },
  );
  const cancelled = await f.run(
    "spotkanie",
    "odwolaj",
    { id: f.meetingId() },
    { actorId: organizerId },
  );
  assert.match(cancelled.last(), /odwołane/);
  assert.equal(f.effects.length, 0);
});

test("case buttons are stateless, role-checked references and never leak private case titles", async (t) => {
  const f = fixture(t);
  await f.run("sprawa", "utworz", {
    temat: "Tytuł prywatnej sprawy",
    tresc: "Opis tylko dla autora",
  });
  const privateId = f.caseId();
  const denied = await f.run("sprawa", "stan", { id: privateId }, { actorId: strangerId });
  assert.doesNotMatch(denied.last(), /Tytuł prywatnej sprawy|Opis tylko dla autora/);
  const assigned = await f.run(
    "",
    "",
    {},
    { customId: communityButtonId("case", guildId, privateId, "assign"), actorId: staffId },
  );
  assert.match(assigned.last(), /Przypisanie sprawy/);
  await f.run("pomysl", "utworz", { temat: "Pomysł z przyciskami", tresc: "Propozycja zmiany" });
  const id = f.caseId();
  f.reopen();
  const approved = await f.run(
    "",
    "",
    {},
    { customId: communityButtonId("case", guildId, id, "approve"), actorId: staffId },
  );
  assert.match(approved.last(), /publiczna/);
  const voted = await f.run(
    "",
    "",
    {},
    { customId: communityButtonId("case", guildId, id, "up"), actorId: strangerId },
  );
  assert.match(voted.last(), /Twój głos: za/);
  const removed = await f.run(
    "",
    "",
    {},
    { customId: communityButtonId("case", guildId, id, "unvote"), actorId: strangerId },
  );
  assert.match(removed.last(), /wycofany/);
  assert.equal(f.effects.length, 0);
});

test("ordinary authors can reply to private cases but only fresh staff may add notes", async (t) => {
  const f = fixture(t),
    created = await f.run("sprawa", "utworz", {
      temat: "Potrzebna pomoc",
      tresc: "Prywatny opis",
      rodzaj: "question",
    });
  assert.match(created.last(), /Sprawa została zapisana/);
  const id = f.caseId();
  const reply = await f.run("sprawa", "odpowiedz", { id, tresc: "Dodatkowe wyjaśnienie" });
  assert.match(reply.last(), /Odpowiedź została zapisana/);
  await communityInteraction(f.runtime(), reply.value);
  assert.match(reply.last(), /Odpowiedź została zapisana/);
  assert.equal(
    f.store().db.prepare("SELECT COUNT(*) AS n FROM case_messages WHERE kind='reply'").get().n,
    1,
  );
  const denied = await f.run("sprawa", "notatka", { id, tresc: "Autor nie jest obsługą" });
  assert.doesNotMatch(denied.last(), /Notatka została zapisana/);
  const note = await f.run(
    "sprawa",
    "notatka",
    { id, tresc: "Tylko dla obsługi" },
    { actorId: staffId },
  );
  assert.match(note.last(), /Notatka została zapisana/);
  const status = await f.run("sprawa", "stan", { id });
  assert.doesNotMatch(status.last(), /Tylko dla obsługi/);
  assert.doesNotMatch(status.last(), /Dodaj notatkę/);
  f.people.get(staffId).roles.cache.clear();
  const revoked = await f.run(
    "sprawa",
    "notatka",
    { id, tresc: "Nie wolno" },
    { actorId: staffId },
  );
  assert.doesNotMatch(revoked.last(), /Notatka została zapisana/);
  assert.equal(
    f.store().db.prepare("SELECT COUNT(*) AS n FROM case_messages WHERE kind='note'").get().n,
    1,
  );
});

test("staff assignment and status CAS replay reuse frozen revisions without extra changes", async (t) => {
  const f = fixture(t);
  await f.run("sprawa", "utworz", { temat: "Sprawa", tresc: "Opis" });
  const id = f.caseId();
  const assigned = await f.run("sprawa", "przejmij", { id }, { actorId: staffId });
  assert.match(assigned.last(), /Przypisanie sprawy zostało zapisane/);
  const changed = await f.run(
    "sprawa",
    "status",
    { id, status: "in_progress" },
    { actorId: staffId },
  );
  assert.match(changed.last(), /w trakcie/);
  const prior = f.store().db.prepare("SELECT revision FROM cases WHERE id=?").get(id).revision;
  f.reopen();
  await communityInteraction(f.runtime(), changed.value);
  assert.match(changed.last(), /w trakcie/);
  assert.equal(
    f.store().db.prepare("SELECT revision FROM cases WHERE id=?").get(id).revision,
    prior,
  );
  const calls = f.requests.filter((call) => call[1] === "cases.transition");
  assert.deepEqual(calls[0][2], calls.at(-1)[2]);
});

test("suggestion approval and ordinary-member vote/withdraw use the actual case domain", async (t) => {
  const f = fixture(t);
  await f.run("pomysl", "utworz", { temat: "Lepszy projekt", tresc: "Pomysł do oceny" });
  const id = f.caseId();
  const denied = await f.run("pomysl", "glos", { id, wybor: "up" });
  assert.doesNotMatch(denied.last(), /Twój głos: za/);
  const approved = await f.run("pomysl", "zatwierdz", { id }, { actorId: staffId });
  assert.match(approved.last(), /publiczna/);
  const vote = await f.run("pomysl", "glos", { id, wybor: "up" }, { actorId: strangerId });
  assert.match(vote.last(), /Twój głos: za/);
  await communityInteraction(f.runtime(), vote.value);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) AS n FROM case_votes").get().n, 1);
  const withdrawn = await f.run("pomysl", "wycofaj", { id }, { actorId: strangerId });
  assert.match(withdrawn.last(), /wycofany/);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) AS n FROM case_votes").get().n, 0);
  assert.equal(f.effects.length, 0);
});

test("stable buttons survive reopen and reject other guilds or unauthorized management", async (t) => {
  const f = fixture(t);
  await f.run(
    "spotkanie",
    "utworz",
    { temat: "Z przycisku", termin: "2027-01-01 18:00" },
    { actorId: organizerId },
  );
  const id = f.meetingId();
  const customId = communityButtonId("meeting", guildId, id, "join");
  assert.ok(customId.length <= 100);
  f.reopen();
  const joined = await f.run("", "", {}, { customId });
  assert.match(joined.last(), /Jesteś na liście uczestników/);
  const denied = await f.run(
    "",
    "",
    {},
    { customId: communityButtonId("meeting", guildId, id, "start") },
  );
  assert.doesNotMatch(denied.last(), /przygotowanie/);
  const before = f.requests.length;
  const foreign = await f.run(
    "",
    "",
    {},
    { customId: communityButtonId("meeting", "700000000000000099", id, "cancel") },
  );
  assert.match(foreign.last(), /innego serwera/);
  assert.equal(f.requests.length, before);
  const badGuild = await f.run("spotkanie", "stan", { id }, { guildId: "700000000000000099" });
  assert.match(badGuild.last(), /innego serwera/);
  assert.throws(() => communityButtonId("meeting", guildId, id, "assign"));
});

test("missing IDs and transport failures return controlled private errors without exposing content", async (t) => {
  const f = fixture(t);
  const bad = await f.run("sprawa", "stan", { id: "broken" });
  assert.match(bad.last(), /pełny identyfikator/);
  f.state.memberError = Object.assign(Error("sensitive endpoint and private content"), {
    code: "ECONNRESET",
  });
  const failed = await f.run("sprawa", "utworz", { temat: "Temat", tresc: "Prywatna treść" });
  assert.doesNotMatch(failed.last(), /sensitive endpoint|Prywatna treść/);
  assert.match(failed.last(), /Nie udało się potwierdzić/);
  assert.equal(f.effects.length, 0);
});

test("private meeting invitations have a usable fresh-member join and replay-safe withdrawal", async (t) => {
  const f = fixture(t);
  await f.run(
    "spotkanie",
    "utworz",
    {
      temat: "Prywatny plan",
      prywatne: true,
      osoba: userId,
      termin: "2026-11-09 15:00",
      miejsca: 2,
    },
    { actorId: organizerId },
  );
  const id = f.meetingId();
  assert.deepEqual(
    (await f.runtime().community.meetings.get(organizerId, id)).meeting.invitedUserIds,
    [userId],
  );
  assert.match((await f.run("spotkanie", "stan", { id })).last(), /Prywatny plan/);
  assert.match((await f.run("spotkanie", "dolacz", { id })).last(), /Jesteś na liście uczestników/);
  assert.ok(
    !(await f.run("spotkanie", "stan", { id }, { actorId: strangerId }))
      .last()
      .includes("Prywatny plan"),
  );
  const removal = f.interaction(
    "spotkanie",
    "cofnij-zaproszenie",
    { id, osoba: userId },
    { actorId: organizerId },
  );
  await communityInteraction(f.runtime(), removal.value);
  assert.match(removal.last(), /Zaproszenie wycofane/);
  f.reopen();
  const replay = { ...removal.value, editReply: async (value) => removal.replies.push(value) };
  await communityInteraction(f.runtime(), replay);
  const detail = await f.runtime().community.meetings.get(organizerId, id);
  assert.deepEqual(detail.meeting.invitedUserIds, []);
  assert.equal(detail.participants.find((person) => person.userId === userId).state, "left");
  assert.equal(
    f
      .store()
      .db.prepare(
        "SELECT COUNT(*) AS n FROM meeting_audit WHERE meeting_id=? AND action='audience'",
      )
      .get(id).n,
    1,
  );
  assert.ok(!(await f.run("spotkanie", "stan", { id })).last().includes("Prywatny plan"));
});

test("role invitations are OR with explicit people and neither can bypass revoked channel access", async (t) => {
  const f = fixture(t);
  await f.run(
    "spotkanie",
    "utworz",
    { temat: "Spotkanie", prywatne: true, termin: "2026-11-09 15:00" },
    { actorId: organizerId },
  );
  const id = f.meetingId();
  await f.run("spotkanie", "zapros", { id, rola: accessRole }, { actorId: organizerId });
  f.people.get(userId).roles.cache.set(accessRole, f.roles.get(accessRole));
  assert.match((await f.run("spotkanie", "dolacz", { id })).last(), /Jesteś na liście uczestników/);
  f.people.get(userId).roles.cache.clear();
  assert.ok(!(await f.run("spotkanie", "stan", { id })).last().includes("**Spotkanie**"));
  await f.run("spotkanie", "zapros", { id, osoba: userId }, { actorId: organizerId });
  assert.match((await f.run("spotkanie", "stan", { id })).last(), /\*\*Spotkanie\*\*/);
  const source = f.channels.get(textId).permissionsFor;
  f.channels.get(textId).permissionsFor = (member) =>
    member.id === userId ? flags() : source(member);
  assert.ok(!(await f.run("spotkanie", "stan", { id })).last().includes("**Spotkanie**"));
});

test("an ordinary invited member cannot invite others or submit an ambiguous invitation target", async (t) => {
  const f = fixture(t);
  await f.run(
    "spotkanie",
    "utworz",
    { temat: "Spotkanie", prywatne: true, osoba: userId, termin: "2026-11-09 15:00" },
    { actorId: organizerId },
  );
  const id = f.meetingId();
  assert.match(
    (await f.run("spotkanie", "zapros", { id, osoba: strangerId })).last(),
    /Nie masz uprawnień/,
  );
  assert.match(
    (
      await f.run(
        "spotkanie",
        "zapros",
        { id, osoba: strangerId, rola: accessRole },
        { actorId: organizerId },
      )
    ).last(),
    /Sprawdź treść/,
  );
  assert.deepEqual(
    (await f.runtime().community.meetings.get(organizerId, id)).meeting.invitedUserIds,
    [userId],
  );
});

test("disabling cases during the final domain member fetch prevents a new report and its receipt", async (t) => {
  const f = fixture(t);
  prepareReport(f);
  const fetch = f.guild.members.fetch.bind(f.guild.members);
  let reads = 0;
  f.guild.members.fetch = async (options) => {
    if (++reads === 2) {
      const settings = f.runtime().settings.read();
      f.runtime().settings.save(
        { ...settings, enabled: { ...settings.enabled, cases: false } },
        ownerId,
      );
    }
    return fetch(options);
  };
  const result = await f.run("zglos", "", { powod: "Nie zapisuj po wyłączeniu modułu." });
  assert.equal(reads, 2);
  assert.equal(f.runtime().settings.read().enabled.cases, false);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM cases").get().n, 0);
  assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM jobs").get().n, 0);
  assert.equal(
    f.store().db.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE scope LIKE 'case:%'").get()
      .n,
    0,
  );
  assert.equal(
    f.store().db.prepare("SELECT COUNT(*) n FROM events WHERE kind='report'").get().n,
    0,
  );
  assert.match(result.last(), /wyłączona lub jeszcze niedostępna/);
  assert.equal(f.effects.length, 0);
  const settings = f.runtime().settings.read();
  f.runtime().settings.save(
    { ...settings, enabled: { ...settings.enabled, cases: true } },
    ownerId,
  );
  t.mock.timers.tick(60001);
  assert.match(
    (await f.run("zglos", "", { powod: "Nowa próba po ponownym włączeniu." })).last(),
    /Sprawa została zapisana/,
  );
});

test("changing case configuration during final authorization rejects create and exact replay", async (t) => {
  for (const replay of [false, true]) {
    await t.test(replay ? "existing receipt" : "new request", async (t) => {
      const f = fixture(t);
      prepareReport(f);
      const first = replay ? await f.run("zglos", "", { powod: "Zachowaj dokładny zapis." }) : null;
      const before = {
        cases: f.store().db.prepare("SELECT COUNT(*) n FROM cases").get().n,
        jobs: f.store().db.prepare("SELECT COUNT(*) n FROM jobs").get().n,
        receipts: f
          .store()
          .db.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE scope LIKE 'case:%'")
          .get().n,
      };
      const fetch = f.guild.members.fetch.bind(f.guild.members);
      let reads = 0;
      f.guild.members.fetch = async (options) => {
        if (++reads === 2) {
          const settings = f.runtime().settings.read();
          f.runtime().settings.save(
            { ...settings, cases: { ...settings.cases, categoryId: "" } },
            ownerId,
          );
        }
        return fetch(options);
      };
      const result =
        first ?? f.interaction("zglos", "", { powod: "Nie używaj wcześniejszej kategorii." });
      await communityInteraction(f.runtime(), result.value);
      assert.match(result.last(), /Dane zostały zmienione/);
      assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM cases").get().n, before.cases);
      assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM jobs").get().n, before.jobs);
      assert.equal(
        f
          .store()
          .db.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE scope LIKE 'case:%'")
          .get().n,
        before.receipts,
      );
      assert.equal(f.effects.length, 0);
    });
  }
});

test("assignment rechecks the actor's earlier grant after awaiting the assignee", async (t) => {
  const f = fixture(t);
  await f.run("sprawa", "utworz", { temat: "Sprawa do obsługi", tresc: "Opis." });
  const service = f.runtime().community.cases,
    caseId = f.caseId();
  const fetch = f.guild.members.fetch.bind(f.guild.members);
  let reads = 0;
  f.guild.members.fetch = async (options) => {
    if (++reads === 2) f.people.get(staffId).roles.cache.clear();
    return fetch(options);
  };
  const before = f.store().db.prepare("SELECT COUNT(*) n FROM jobs").get().n;
  await assert.rejects(
    service.assign(staffId, "assignment-after-revocation", caseId, 1, ownerId),
    (error) => error.code === "permission_revoked",
  );
  assert.equal(reads, 2);
  assert.equal(
    f.store().db.prepare("SELECT assignee_id FROM cases WHERE id=?").get(caseId).assignee_id,
    null,
  );
  assert.equal(f.store().db.prepare("SELECT COUNT(*) n FROM jobs").get().n, before);
  assert.equal(
    f
      .store()
      .db.prepare(
        "SELECT COUNT(*) n FROM idempotency_keys WHERE request_id='assignment-after-revocation'",
      )
      .get().n,
    0,
  );
  assert.equal(f.effects.length, 0);
});
