import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
import {
  announcementCommands,
  announcementInteraction,
} from "../dist/bot/announcement-commands.js";
import { commands } from "../dist/bot/commands.js";
import { ModuleRuntime } from "../dist/bot/module-runtime.js";
import { JobRunner } from "../dist/core/jobs/runner.js";
import { noMentions } from "../dist/shared/utils.js";
import { AnnouncementAssetError } from "../dist/modules/announcement-assets/types.js";

const guildId = "100000000000000001",
  actorId = "200000000000000001",
  botId = "200000000000000002",
  managerId = "300000000000000001",
  mentionId = "300000000000000002",
  lockedRoleId = "300000000000000003",
  channelId = "400000000000000001",
  messageId = "500000000000000001";
const publicFlags = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
const flags = (value = 0n) => new PermissionsBitField(value);
const clocks = new WeakSet();

function fixture(t, { enabled = true, beta = true, assets } = {}) {
  if (!clocks.has(t)) {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-09T12:00:00Z") });
    clocks.add(t);
  }
  const db = new DatabaseSync(":memory:"),
    order = [],
    sent = [],
    calls = [];
  const state = {
    roleIds: [managerId],
    pending: false,
    timedOut: false,
    memberError: null,
    sendError: null,
    memberFlags: publicFlags,
    botFlags: publicFlags,
  };
  const roles = new Map(
    [guildId, managerId, mentionId, lockedRoleId].map((id) => [
      id,
      {
        id,
        name: "Rola",
        mentionable: id === mentionId,
        managed: false,
        permissions: flags(),
      },
    ]),
  );
  const guild = {
    id: guildId,
    ownerId: actorId,
    async fetch() {
      order.push("guild");
      // Fresh REST facts take time; an immediate schedule cannot depend on a same-ms lookup.
      t.mock.timers.tick(2);
      this.ownerId = "200000000000000099";
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
  };
  const member = {
      id: actorId,
      user: { bot: false },
      voice: { channelId: null },
      roles: { cache: new Map([[managerId, roles.get(managerId)]]) },
      permissions: flags(),
      get pending() {
        return state.pending;
      },
      isCommunicationDisabled: () => state.timedOut,
    },
    me = { id: botId };
  guild.members = {
    async fetch(options) {
      order.push("member");
      assert.deepEqual(options, { user: actorId, force: true });
      if (state.memberError) throw state.memberError;
      member.roles.cache = new Map(state.roleIds.map((id) => [id, roles.get(id)]));
      return member;
    },
    async fetchMe(options) {
      assert.deepEqual(options, { force: true });
      return me;
    },
  };
  const channel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    permissionsFor(subject) {
      return flags(subject.id === botId ? state.botFlags : state.memberFlags);
    },
  };
  guild.channels = {
    cache: new Map([[channelId, channel]]),
    async fetch(id, options) {
      assert.deepEqual(options, { force: true });
      return id === channelId ? channel : null;
    },
  };
  const runtime = new ModuleRuntime(
    {
      guild,
      store: { db, event() {} },
      control: { modules: { rooms: true, reactions: true, files: true, reports: true } },
    },
    {
      async post(route, options) {
        sent.push({ route, options });
        if (state.sendError) throw state.sendError;
        return { id: messageId };
      },
    },
    beta,
    undefined,
    assets,
  );
  runtime.settings.save(
    {
      ...runtime.settings.read(),
      announcementManagerRoleIds: [managerId],
      enabled: { ...runtime.settings.read().enabled, announcements: enabled },
    },
    actorId,
  );
  const originalRequest = runtime.request.bind(runtime);
  runtime.request = async (...args) => {
    calls.push(args);
    return originalRequest(...args);
  };
  const runner = new JobRunner(
    () => [{ guildId, store: runtime.jobs, available: () => true }],
    (job, execution) => runtime.execute(job, execution),
  );
  t.after(async () => {
    await runner.stop();
    db.close();
  });
  let sequence = 0;
  function interaction(action, values = {}, extra = {}) {
    const replies = [],
      deferred = [];
    const value = {
      id: String(600000000000000000n + BigInt(++sequence)),
      createdTimestamp: Date.now(),
      guildId,
      user: { id: actorId },
      commandName: "ogloszenie",
      // Stale cached administrator claims must have no influence on fresh role checks.
      memberPermissions: flags(P.Administrator),
      isChatInputCommand: () => true,
      options: {
        getSubcommand: () => action,
        getString: (name) => values[name] ?? null,
        getBoolean: (name) => values[name] ?? null,
        getRole: () => (values.rola ? { id: values.rola } : null),
        getChannel: () => ({ id: values.kanal ?? channelId }),
      },
      async deferReply(options) {
        order.push("defer");
        deferred.push(options);
      },
      async editReply(reply) {
        replies.push(reply);
      },
      ...extra,
    };
    return { value, replies, deferred, last: () => replies.at(-1)?.content ?? "" };
  }
  async function run(action, values = {}, extra = {}) {
    const command = interaction(action, values, extra);
    assert.equal(await announcementInteraction(runtime, command.value), true);
    assert.deepEqual(command.deferred, [{ flags: MessageFlags.Ephemeral }]);
    assert.equal(command.replies.length, 1);
    assert.deepEqual(command.replies[0].allowedMentions, noMentions);
    return command;
  }
  return { runtime, runner, db, order, state, sent, calls, interaction, run };
}

test("announcement commands are guild-only beta commands without administrator-only registration", () => {
  assert.ok(!commands(false).some((command) => command.name === "ogloszenie"));
  const [command] = announcementCommands();
  assert.ok(commands(true).some((item) => item.name === command.name));
  assert.deepEqual(command.contexts, [0]);
  assert.deepEqual(command.integration_types, [0]);
  assert.equal(command.default_member_permissions, undefined);
  for (const action of ["utworz", "lista", "stan", "pomoc", "pauza", "wznow", "anuluj", "proba"])
    assert.ok(command.options.some((item) => item.name === action));
});

test("the card command sends an embed and a real link button through durable Discord delivery", async (t) => {
  const f = fixture(t);
  f.state.memberFlags |= P.EmbedLinks;
  f.state.botFlags |= P.EmbedLinks;
  const command = await f.run("utworz", {
    tytul: "Wieczór z projektem",
    opis: "Pokaż, nad czym pracujesz.",
    kolor: "#d4a437",
    link: "https://example.com/spotkanie",
    przycisk: "Zobacz szczegóły",
  });
  assert.match(command.last(), /Ogłoszenie zapisane/);
  await f.runner.tick();
  assert.equal(f.sent.length, 1);
  const body = f.sent[0].options.body;
  assert.equal(body.content, "");
  assert.deepEqual(body.embeds, [
    { title: "Wieczór z projektem", description: "Pokaż, nad czym pracujesz.", color: 0xd4a437 },
  ]);
  assert.deepEqual(body.components, [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "Zobacz szczegóły", url: "https://example.com/spotkanie" },
      ],
    },
  ]);
  assert.deepEqual(body.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
  assert.equal(body.enforce_nonce, true);
  const [job] = f.runtime.jobs.list();
  assert.equal(job.state, "succeeded");
  assert.equal(f.runtime.jobs.attempts(job.id)[0].messageId, messageId);
});

test("the panel API roundtrips card drafts, server preview, edits and a no-ping test payload", async (t) => {
  const f = fixture(t);
  f.state.memberFlags |= P.EmbedLinks;
  f.state.botFlags |= P.EmbedLinks;
  await f.run("utworz", { tresc: "Zapisuję wersję roboczą", szkic: true });
  const actor = f.calls[0][0],
    [record] = (await f.runtime.request(actor, "announcements.list", {})).announcements,
    draft = {
      channelId,
      content: "@everyone",
      roleIds: [mentionId],
      mentionEveryone: false,
      card: { title: "Nowa karta", description: "Zwykły opis.", color: 0x5865f2 },
      links: [{ label: "Strona", url: "https://example.com" }],
      saveAsDraft: true,
      schedule: { kind: "once", at: Date.now() + 60000 },
    };
  assert.equal(record.status, "draft");
  assert.equal(f.runtime.jobs.list().length, 0);
  const preview = await f.runtime.request(actor, "announcements.preview", { draft });
  const saved = await f.runtime.request(
    actor,
    "announcements.update",
    { revision: record.revision, draft },
    record.id,
    "panel-edit-card",
  );
  const detail = await f.runtime.request(actor, "announcements.read", {}, record.id);
  assert.deepEqual(saved.announcement.card, preview.message.card);
  assert.deepEqual(detail.announcement.links, preview.message.links);
  assert.equal(detail.announcement.status, "draft");
  const attempt = await f.runtime.request(
    actor,
    "announcements.test",
    { revision: detail.announcement.revision },
    record.id,
    "panel-test-card",
  );
  await f.runner.tick();
  const sent = f.sent[0].options.body;
  assert.deepEqual(sent.embeds[0], preview.message.card);
  assert.equal(sent.components[0].components[0].url, preview.message.links[0].url);
  assert.deepEqual(sent.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
  assert.match(sent.content, /^Próba ogłoszenia/);
  assert.equal(f.runtime.jobs.get(attempt.job.id).state, "succeeded");
  assert.equal(
    (await f.runtime.request(actor, "announcements.read", {}, record.id)).announcement.status,
    "draft",
  );
});

test("controlled image bytes become a multipart attachment and external image URLs never reach Discord", async (t) => {
  const assetId = "00000000-0000-4000-8000-000000000001",
    data = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFjMAAAAASUVORK5CYII=",
      "base64",
    ),
    checked = [],
    assets = {
      validateAsset: async (id) => {
        checked.push(id);
        assert.equal(id, assetId);
      },
      syncAnnouncement: () => {},
      readAsset: async (id) => {
        assert.equal(id, assetId);
        return { name: "announcement.png", contentType: "image/png", data };
      },
    },
    f = fixture(t, { assets });
  f.state.memberFlags |= P.EmbedLinks | P.AttachFiles;
  f.state.botFlags |= P.EmbedLinks | P.AttachFiles;
  await f.run("utworz", { tresc: "Szkic", szkic: true });
  const actor = f.calls[0][0],
    [record] = (await f.runtime.request(actor, "announcements.list", {})).announcements;
  await f.runtime.request(
    actor,
    "announcements.update",
    {
      revision: record.revision,
      draft: {
        channelId,
        content: "",
        card: { title: "Obraz", description: "", color: 0, imageAssetId: assetId },
        schedule: { kind: "once", at: Date.now() + 1000 },
      },
    },
    record.id,
    "image-card",
  );
  t.mock.timers.tick(1000);
  await f.runner.tick();
  const request = f.sent[0].options;
  assert.equal(request.body.embeds[0].image.url, "attachment://announcement.png");
  assert.deepEqual(request.body.attachments, [{ id: 0, filename: "announcement.png" }]);
  assert.equal(request.files[0].contentType, "image/png");
  assert.deepEqual(request.files[0].data, data);
  assert.ok(checked.length >= 3);
});

test("card and image permissions are checked for both the editor and bot before queuing", async (t) => {
  const f = fixture(t),
    command = await f.run("utworz", { tytul: "Karta", opis: "Opis." });
  assert.ok(!/Ogłoszenie zapisane/.test(command.last()));
  assert.equal(f.runtime.jobs.list().length, 0);
  assert.equal(f.sent.length, 0);
});

test("asset IO cannot send an announcement after its editor is revoked or its generation is cancelled", async (t) => {
  for (const change of ["revoke", "cancel"])
    await t.test(change, async (t) => {
      const assetId = "00000000-0000-4000-8000-000000000001";
      let f, recordId, actor;
      const assets = {
        validateAsset: async () => {},
        syncAnnouncement: () => {},
        readAsset: async () => {
          if (change === "revoke") f.state.roleIds = [];
          else {
            const detail = await f.runtime.request(actor, "announcements.read", {}, recordId);
            await f.runtime.request(
              actor,
              "announcements.cancel",
              { revision: detail.announcement.revision },
              recordId,
              "cancel-during-asset",
            );
          }
          return {
            name: "announcement.png",
            contentType: "image/png",
            data: new Uint8Array([137, 80, 78, 71]),
          };
        },
      };
      f = fixture(t, { assets });
      f.state.memberFlags |= P.EmbedLinks | P.AttachFiles;
      f.state.botFlags |= P.EmbedLinks | P.AttachFiles;
      await f.run("utworz", { tresc: "Szkic", szkic: true });
      actor = f.calls[0][0];
      recordId = (await f.runtime.request(actor, "announcements.list", {})).announcements[0].id;
      const queued = await f.runtime.request(
        actor,
        "announcements.update",
        {
          revision: 1,
          draft: {
            channelId,
            content: "",
            card: { title: "Obraz", description: "", color: 0, imageAssetId: assetId },
            schedule: { kind: "once", at: Date.now() + 1000 },
          },
        },
        recordId,
        "queue-image",
      );
      t.mock.timers.tick(1000);
      await f.runner.tick();
      assert.equal(f.sent.length, 0);
      assert.equal(f.runtime.jobs.attempts(queued.job.id).length, 0);
      assert.equal(
        f.runtime.jobs.get(queued.job.id).state,
        change === "cancel" ? "cancelled" : "failed",
      );
    });
});

test("an image that disappears between preparation and reading fails without a Discord attempt", async (t) => {
  for (const failure of ["asset_not_found", "asset_storage_unavailable"])
    await t.test(failure, async (t) => {
      const assets = {
          validateAsset: async () => {},
          syncAnnouncement: () => {},
          readAsset: async () => {
            throw new AnnouncementAssetError(failure);
          },
        },
        f = fixture(t, { assets });
      f.state.memberFlags |= P.EmbedLinks | P.AttachFiles;
      f.state.botFlags |= P.EmbedLinks | P.AttachFiles;
      await f.run("utworz", { tresc: "Szkic", szkic: true });
      const actor = f.calls[0][0],
        [record] = (await f.runtime.request(actor, "announcements.list", {})).announcements;
      const queued = await f.runtime.request(
        actor,
        "announcements.update",
        {
          revision: record.revision,
          draft: {
            channelId,
            content: "",
            card: {
              title: "Obraz",
              description: "",
              color: 0,
              imageAssetId: "00000000-0000-4000-8000-000000000001",
            },
            schedule: { kind: "once", at: Date.now() + 1000 },
          },
        },
        record.id,
        "image",
      );
      t.mock.timers.tick(1000);
      await f.runner.tick();
      const job = f.runtime.jobs.get(queued.job.id),
        detail = await f.runtime.request(actor, "announcements.read", {}, record.id);
      assert.equal(f.sent.length, 0);
      assert.equal(f.runtime.jobs.attempts(job.id).length, 0);
      assert.equal(job.state, failure === "asset_not_found" ? "failed" : "retry");
      assert.equal(
        detail.announcement.status,
        failure === "asset_not_found" ? "blocked" : "scheduled",
      );
    });
});

test("unrelated interactions are ignored without replying or fetching membership", async (t) => {
  const f = fixture(t);
  for (const extra of [{ commandName: "pokoj" }, { isChatInputCommand: () => false }]) {
    const command = f.interaction("utworz", {}, extra);
    assert.equal(await announcementInteraction(f.runtime, command.value), false);
    assert.equal(command.deferred.length, 0);
    assert.equal(command.replies.length, 0);
  }
  assert.deepEqual(f.order, []);
  assert.equal(f.calls.length, 0);
});

test("delegated role creates queued work after a private defer and fresh membership, without immediate publication", async (t) => {
  const f = fixture(t),
    command = await f.run("utworz", { tresc: "Wieczorem pracujemy razem.", rola: mentionId });
  assert.deepEqual(f.order.slice(0, 4), ["defer", "guild", "roles", "member"]);
  assert.match(command.last(), /Ogłoszenie zapisane/);
  const [call] = f.calls;
  assert.equal(call[0].owner, false);
  assert.equal(call[0].manageGuild, false);
  assert.equal(call[1], "announcements.create");
  assert.deepEqual(call[2].schedule, { kind: "now" });
  assert.deepEqual(call[2].roleIds, [mentionId]);
  assert.equal(call[2].mentionEveryone, false);
  assert.equal(call[4], "discord_" + command.value.id);
  const [job] = f.runtime.jobs.list();
  assert.equal(job.state, "pending");
  assert.equal(f.sent.length, 0);
  const savedReply = command.last();
  t.mock.timers.tick(60000);
  assert.equal(await announcementInteraction(f.runtime, command.value), true);
  assert.equal(command.last(), savedReply);
  assert.equal(f.runtime.jobs.list().length, 1);
});

test("current role revocation, pending, timeout and removal deny creation despite cached admin claims", async (t) => {
  for (const mode of ["role", "pending", "timeout", "removed", "disabled", "beta"]) {
    const f = fixture(t, { enabled: mode !== "disabled", beta: mode !== "beta" });
    if (mode === "role") f.state.roleIds = [];
    if (mode === "pending") f.state.pending = true;
    if (mode === "timeout") f.state.timedOut = true;
    if (mode === "removed")
      f.state.memberError = Object.assign(Error("private member details"), { code: 10007 });
    const command = await f.run("utworz", { tresc: "Nie wolno opublikować." });
    assert.doesNotMatch(command.last(), /Ogłoszenie zapisane/);
    assert.doesNotMatch(command.last(), /private member details/);
    assert.equal(f.runtime.jobs.list().length, 0);
    assert.equal(f.sent.length, 0);
  }
});

test("foreign guild, malformed identifier and malformed local date never queue work", async (t) => {
  const f = fixture(t);
  for (const [action, values, extra] of [
    ["utworz", { tresc: "Tekst" }, { guildId: "100000000000000999" }],
    ["stan", { id: "not-an-id" }, {}],
    ["utworz", { tresc: "Tekst", termin: "2027/01/01 18:00" }, {}],
    ["utworz", { tresc: "Tekst", termin: "2027-02-30 18:00" }, {}],
  ]) {
    const command = await f.run(action, values, extra);
    assert.doesNotMatch(command.last(), /Ogłoszenie zapisane/);
  }
  assert.equal(f.runtime.jobs.list().length, 0);
});

test("scheduled command converts the server timezone and rejects an unmentionable role", async (t) => {
  const f = fixture(t);
  const denied = await f.run("utworz", {
    tresc: "Tekst",
    termin: "2027-01-01 18:00",
    rola: lockedRoleId,
  });
  assert.doesNotMatch(denied.last(), /Ogłoszenie zapisane/);
  assert.equal(f.runtime.jobs.list().length, 0);
  const accepted = await f.run("utworz", {
    tresc: "Tekst",
    termin: "2027-01-01 18:00",
    rola: mentionId,
  });
  assert.match(accepted.last(), /Ogłoszenie zapisane/);
  assert.equal(f.runtime.jobs.list()[0].dueAt, Date.parse("2027-01-01T17:00:00Z"));
});

test("pause, resume, test and cancellation go through fresh domain revisions and stable interaction keys", async (t) => {
  const f = fixture(t);
  await f.run("utworz", { tresc: "Tekst", termin: "2027-01-01 18:00", rola: mentionId });
  const id = f.runtime.jobs.list()[0].objectId;
  await f.run("pauza", { id });
  await f.run("wznow", { id });
  const trial = await f.run("proba", { id });
  assert.match(trial.last(), /Próba zapisana/);
  assert.equal(f.sent.length, 0);
  await f.runner.tick();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].options.body.allowed_mentions, {
    parse: [],
    roles: [],
    users: [],
    replied_user: false,
  });
  assert.match(f.sent[0].options.body.content, /^Próba ogłoszenia/);
  assert.equal(f.sent[0].options.body.enforce_nonce, true);
  await f.run("anuluj", { id });
  assert.equal((await f.runtime.announcements.get(actorId, id)).status, "cancelled");
  for (const operation of [
    "announcements.pause",
    "announcements.resume",
    "announcements.test",
    "announcements.cancel",
  ]) {
    const call = f.calls.find((item) => item[1] === operation);
    assert.ok(Number.isInteger(call[2].revision));
    assert.match(call[4], /^discord_\d+$/);
  }
});

test("status warns about the latest unknown delivery even when an older scheduled job is still first", async (t) => {
  const f = fixture(t);
  await f.run("utworz", { tresc: "Tekst", termin: "2027-01-01 18:00" });
  const [scheduled] = f.runtime.jobs.list();
  t.mock.timers.tick(10);
  await f.run("proba", { id: scheduled.objectId });
  f.state.sendError = Object.assign(Error("private response details"), { status: 503 });
  await f.runner.tick();
  const jobs = f.runtime.jobs.list({ objectId: scheduled.objectId });
  assert.equal(jobs[0].state, "pending");
  assert.equal(jobs.at(-1).state, "unknown");
  const status = await f.run("stan", { id: scheduled.objectId });
  assert.match(status.last(), /Nie udało się potwierdzić ostatniej wysyłki/);
  assert.doesNotMatch(status.last(), /private response details/);
  assert.equal(f.sent.length, 1);
  await f.runner.tick();
  assert.equal(f.sent.length, 1);
});

test("network membership failure stays private and never turns into a successful command reply", async (t) => {
  const f = fixture(t);
  f.state.memberError = Object.assign(Error("sensitive internal endpoint"), { code: "ECONNRESET" });
  const command = await f.run("utworz", { tresc: "Tekst" });
  assert.match(command.last(), /Nie udało się wykonać/);
  assert.doesNotMatch(command.last(), /sensitive internal endpoint/);
  assert.equal(f.runtime.jobs.list().length, 0);
});
