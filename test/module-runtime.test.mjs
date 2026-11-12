import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ChannelType,
  DiscordjsError,
  GuildChannelManager,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
import { ModuleRuntime } from "../dist/bot/module-runtime.js";
import {
  freshMember,
  isDiscordChannelUnavailable,
  memberFacts,
} from "../dist/bot/module-permissions.js";
import { ControlError } from "../dist/control/contracts.js";
import { pruneDomainData } from "../dist/storage/domain-retention.js";
import { fileFormats, reactionEmojiMaxLength } from "../dist/contracts/index.js";

const guildId = "100000000000000001",
  otherGuildId = "100000000000000002",
  actorId = "200000000000000001",
  botId = "200000000000000002",
  otherOwner = "200000000000000003",
  managerId = "300000000000000001",
  mentionId = "300000000000000002",
  lockedMentionId = "300000000000000003",
  channelId = "400000000000000001",
  privateChannelId = "400000000000000002";
const flags = (...values) => new PermissionsBitField(values);
const publicFlags = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
const isControl = (status, code) => (error) =>
  error instanceof ControlError && error.status === status && error.code === code;

function foreignSdkChannelFetch() {
  const manager = {
    guild: { id: guildId },
    client: {
      rest: {
        async get(route) {
          assert.equal(route, `/channels/${channelId}`);
          return { id: channelId, guild_id: otherGuildId, type: ChannelType.GuildText };
        },
      },
    },
  };
  return (id, options) => GuildChannelManager.prototype.fetch.call(manager, id, options);
}

function fixture(t, { beta = true, enabled = true, integrations, assets } = {}) {
  const db = new DatabaseSync(":memory:"),
    order = [],
    sent = [];
  const state = {
    ownerId: otherOwner,
    rolePermissions: 0n,
    roleIds: [managerId],
    pending: false,
    timedOut: false,
    memberError: undefined,
    channelError: undefined,
    guildError: undefined,
    freshChannelIds: [channelId, privateChannelId],
    memberChannelFlags: publicFlags,
    botChannelFlags: publicFlags,
  };
  const role = (id, mentionable = false) => ({
    id,
    name: id === managerId ? "Ogłoszenia" : "Uczestnicy",
    hexColor: "#abcdef",
    mentionable,
    managed: false,
    permissions: flags(),
  });
  const roles = new Map([
    [guildId, role(guildId)],
    [managerId, role(managerId)],
    [mentionId, role(mentionId, true)],
    [lockedMentionId, role(lockedMentionId)],
  ]);
  const guild = {
    id: guildId,
    ownerId: otherOwner,
    async fetch() {
      order.push("guild");
      if (state.guildError) throw state.guildError;
      this.ownerId = state.ownerId;
      return this;
    },
    roles: {
      cache: roles,
      everyone: roles.get(guildId),
      async fetch() {
        order.push("roles");
        roles.get(managerId).permissions = flags(state.rolePermissions);
        return roles;
      },
    },
  };
  const member = {
    id: actorId,
    user: { bot: false },
    voice: { channelId: null },
    roles: { cache: new Map([[managerId, roles.get(managerId)]]) },
    get permissions() {
      return guild.ownerId === actorId
        ? flags(P.Administrator)
        : flags([...this.roles.cache.values()].map((value) => value.permissions.bitfield));
    },
    get pending() {
      return state.pending;
    },
    isCommunicationDisabled: () => state.timedOut,
  };
  const me = {
    id: botId,
    permissions: flags(P.Administrator),
    roles: { highest: { comparePositionTo: () => 1 } },
  };
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
  const channel = (id, hidden = false) => ({
    id,
    guildId,
    name: hidden ? "prywatny" : "ogłoszenia",
    type: ChannelType.GuildText,
    permissionsFor(subject) {
      if (subject.id === botId) return flags(state.botChannelFlags);
      if (subject.id === actorId) return flags(hidden ? 0n : state.memberChannelFlags);
      return flags(P.ViewChannel);
    },
  });
  const channels = new Map([
    [channelId, channel(channelId)],
    [privateChannelId, channel(privateChannelId, true)],
  ]);
  guild.channels = {
    cache: channels,
    async fetch(id, options) {
      if (id === undefined)
        return new Map(
          [...channels.entries()].filter(([key]) => state.freshChannelIds.includes(key)),
        );
      assert.deepEqual(options, { force: true });
      if (state.channelError) throw state.channelError;
      return channels.get(id) ?? null;
    },
  };
  const context = {
    guild,
    store: { db, event() {} },
    control: { modules: { rooms: true, reactions: true, files: true, reports: true } },
  };
  const runtime = new ModuleRuntime(
    context,
    {
      async post(route, options) {
        sent.push({ route, options });
        return { id: "500000000000000001" };
      },
    },
    beta,
    integrations,
    assets,
  );
  const settings = runtime.settings.read();
  settings.enabled.announcements = enabled;
  settings.announcementManagerRoleIds = [managerId];
  runtime.settings.save(settings, actorId);
  t.after(() => db.close());
  const facts = () => memberFacts(guild, member);
  const admin = () => ({ ...facts(), manageGuild: true });
  const draft = (extra = {}) => ({
    channelId,
    content: "Spotkanie w piątek.",
    schedule: { kind: "once", at: Date.now() + 60000 },
    ...extra,
  });
  const create = (requestId, extra = {}) =>
    runtime.request(facts(), "announcements.create", draft(extra), undefined, requestId);
  return { runtime, guild, member, roles, state, order, sent, facts, admin, draft, create };
}

test("retired job history cannot be recovered through a direct manager API lookup", async (t) => {
  const f = fixture(t);
  f.state.ownerId = actorId;
  const jobs = f.runtime.jobs,
    now = Date.now();
  jobs.db.exec(
    "CREATE TABLE IF NOT EXISTS guild_identity(singleton INTEGER PRIMARY KEY,guild TEXT NOT NULL)",
  );
  jobs.db.prepare("INSERT INTO guild_identity VALUES (1,?)").run(guildId);
  const job = jobs.enqueue({
    guildId,
    type: "announcement.send",
    payload: {},
    dueAt: now - 1,
    dedupeKey: "retired-api-check",
  });
  const [lease] = jobs.claim({ guildId, limit: 1, leaseMs: 30000 });
  assert.equal(lease.id, job.id);
  jobs.complete(job.id, lease.leaseToken, {});
  assert.equal(pruneDomainData(jobs, guildId, { now: now + 31 * 86400000 }).jobsRetired, 1);
  const listed = await f.runtime.request(f.admin(), "jobs.list", {});
  assert.deepEqual(listed.jobs, []);
  await assert.rejects(
    () => f.runtime.request(f.admin(), "jobs.read", {}, job.id),
    isControl(404, "not_found"),
  );
});

test("asset upload and preview require a currently authorized announcement manager", async (t) => {
  const id = "fbd3beb2-ce37-441a-8595-207f3ec67254",
    asset = {
      id,
      guildId,
      mediaType: "image/png",
      size: 1,
      width: 1,
      height: 1,
      createdAt: Date.now(),
      expiresAt: null,
    },
    calls = [];
  const assets = {
    async upload(...args) {
      calls.push("upload");
      await args[4]();
      return asset;
    },
    describeAsset() {
      calls.push("describe");
      return asset;
    },
    async readAsset() {
      calls.push("read");
      return { name: "announcement.png", contentType: "image/png", data: Buffer.from([1]) };
    },
    async validateAsset() {},
    syncAnnouncement() {},
    async prune() {
      return 0;
    },
  };
  const f = fixture(t, { assets });
  const result = await f.runtime.request(
    f.facts(),
    "announcements.assets.upload",
    { mediaType: "image/png", dataBase64: "AQ==" },
    undefined,
    "upload-asset",
  );
  assert.deepEqual(result, { asset });
  const preview = await f.runtime.request(f.facts(), "announcements.assets.read", {}, id);
  assert.equal(preview.dataBase64, "AQ==");
  f.state.roleIds = [];
  calls.length = 0;
  for (const operation of ["announcements.assets.upload", "announcements.assets.read"])
    await assert.rejects(
      () =>
        f.runtime.request(
          { ...f.facts(), manageGuild: true },
          operation,
          { mediaType: "image/png", dataBase64: "AQ==" },
          id,
          "upload-again",
        ),
      isControl(403, "permission_revoked"),
    );
  assert.deepEqual(calls, []);
});

test("role revocation while reading an asset prevents its bytes from returning to the caller", async (t) => {
  const id = "fbd3beb2-ce37-441a-8595-207f3ec67254";
  let f;
  const assets = {
    describeAsset() {
      return {
        id,
        guildId,
        mediaType: "image/png",
        size: 1,
        width: 1,
        height: 1,
        createdAt: 0,
        expiresAt: null,
      };
    },
    async readAsset() {
      f.state.roleIds = [];
      return { name: "announcement.png", contentType: "image/png", data: Buffer.from([1]) };
    },
    async validateAsset() {},
    syncAnnouncement() {},
    async upload() {
      throw Error();
    },
    async prune() {
      return 0;
    },
  };
  f = fixture(t, { assets });
  await assert.rejects(
    () => f.runtime.request(f.facts(), "announcements.assets.read", {}, id),
    isControl(403, "permission_revoked"),
  );
  const missing = fixture(t);
  await assert.rejects(
    () => missing.runtime.request(missing.facts(), "announcements.assets.upload", {}),
    isControl(503, "asset_transport_unavailable"),
  );
});

test("the shared module API exposes and delegates only configured Twitch capabilities", async (t) => {
  const calls = [];
  const capability = {
    key: "integrations",
    label: "Powiadomienia z Twitcha",
    availability: "available",
    status: "available",
    schemaVersion: 1,
    requiredPermissions: [],
  };
  const integrations = {
    capability: (id) => {
      assert.equal(id, guildId);
      return capability;
    },
    request: async (...args) => {
      calls.push(args);
      return { integrations: [] };
    },
  };
  const f = fixture(t, { integrations });
  assert.equal(
    f.runtime.capabilities().modules.find((item) => item.key === "integrations").availability,
    "available",
  );
  const integrationPermissions = (view) =>
    view.permissions.filter((value) => value.startsWith("integrations.")).sort();
  const management = [
    "integrations.list",
    "integrations.lookup",
    "integrations.create",
    "integrations.read",
    "integrations.update",
    "integrations.remove",
  ].sort();
  const ordinary = await f.runtime.capabilitiesView(actorId);
  assert.deepEqual(integrationPermissions(ordinary), []);
  f.state.ownerId = actorId;
  const manager = await f.runtime.capabilitiesView(actorId);
  assert.deepEqual(integrationPermissions(manager), management);
  const enabled = f.runtime.settings.read();
  enabled.enabled.integrations = true;
  f.runtime.settings.save(enabled, actorId);
  const active = await f.runtime.request(f.facts(), "capabilities.read", {});
  assert.deepEqual(integrationPermissions(active), [...management, "integrations.test"].sort());
  const disabled = f.runtime.settings.read();
  disabled.enabled.integrations = false;
  f.runtime.settings.save(disabled, actorId);
  assert.deepEqual(integrationPermissions(await f.runtime.capabilitiesView(actorId)), management);
  f.state.ownerId = otherOwner;
  f.state.rolePermissions = P.ManageGuild;
  assert.deepEqual(integrationPermissions(await f.runtime.capabilitiesView(actorId)), management);
  f.state.rolePermissions = 0n;
  assert.deepEqual(integrationPermissions(await f.runtime.capabilitiesView(actorId)), []);
  const payload = {};
  assert.deepEqual(
    await f.runtime.request(f.admin(), "integrations.list", payload, undefined, "request_123"),
    { integrations: [] },
  );
  assert.deepEqual(calls[0], [f.admin(), "integrations.list", payload, undefined, "request_123"]);
  const inactive = fixture(t, { beta: false, integrations });
  await assert.rejects(
    inactive.runtime.request(inactive.admin(), "integrations.list", {}),
    isControl(409, "module_unavailable"),
  );
  assert.equal(
    inactive.runtime.capabilities().modules.find((item) => item.key === "integrations")
      .availability,
    "planned",
  );
  inactive.state.ownerId = actorId;
  assert.deepEqual(integrationPermissions(await inactive.runtime.capabilitiesView(actorId)), []);
  const planned = fixture(t, {
    integrations: {
      ...integrations,
      capability: () => ({ ...capability, availability: "planned" }),
    },
  });
  planned.state.ownerId = actorId;
  assert.deepEqual(integrationPermissions(await planned.runtime.capabilitiesView(actorId)), []);
  const missing = fixture(t);
  missing.state.ownerId = actorId;
  assert.deepEqual(integrationPermissions(await missing.runtime.capabilitiesView(actorId)), []);
});

test("turning Twitch off cancels its queued work in the same settings transaction", async (t) => {
  const integrations = {
    capability: () => ({ key: "integrations", availability: "available", status: "enabled" }),
    request: async () => ({}),
  };
  const f = fixture(t, { integrations });
  f.state.ownerId = actorId;
  const settings = f.runtime.settings.read();
  settings.enabled.integrations = true;
  f.runtime.settings.save(settings, actorId);
  const pending = f.runtime.jobs.enqueue({
    guildId,
    type: "twitch.send",
    dueAt: Date.now() + 60000,
    dedupeKey: "twitch-pending",
    payload: {},
  });
  const next = f.runtime.settings.read();
  next.enabled.integrations = false;
  await f.runtime.request(
    f.admin(),
    "settings.save",
    { scope: "modules", settings: next },
    undefined,
    "settings_123",
  );
  assert.equal(f.runtime.jobs.get(pending.id).state, "cancelled");
});

test("fresh member facts refresh ownership and role definitions before deriving access", async (t) => {
  const f = fixture(t);
  f.guild.ownerId = actorId;
  f.roles.get(managerId).permissions = flags(P.ManageGuild);
  assert.equal(f.facts().owner, true);
  assert.equal(f.facts().manageGuild, true);
  const current = await freshMember(f.guild, actorId);
  assert.deepEqual(f.order, ["guild", "roles", "member"]);
  assert.equal(current.facts.owner, false);
  assert.equal(current.facts.manageGuild, false);
  f.state.memberError = Object.assign(Error("missing"), { code: 10007 });
  await assert.rejects(() => freshMember(f.guild, actorId), isControl(403, "permission_revoked"));
  const outage = Object.assign(Error("offline"), { code: "ECONNRESET" });
  f.state.memberError = outage;
  await assert.rejects(
    () => freshMember(f.guild, actorId),
    (error) => error === outage,
  );
});

test("capabilities expose visible resources and implemented permissions, keeping settings admin-only", async (t) => {
  const f = fixture(t);
  const view = await f.runtime.request(f.facts(), "capabilities.read", {});
  assert.deepEqual(view.resources.configurationCapabilities, {
    fileFormats: [...fileFormats],
    reactionEmojiMaxLength,
  });
  assert.deepEqual(
    view.resources.channels.map((value) => value.id),
    [channelId],
  );
  assert.ok(view.permissions.includes("announcements.create"));
  assert.ok(view.permissions.includes("announcements.remove"));
  assert.ok(!view.permissions.includes("meetings.create"));
  assert.ok(!view.permissions.includes("settings.save"));
  assert.ok(!("moduleSettings" in view));
  assert.deepEqual(view.mentionPermissions, { roleIds: [mentionId], everyone: false });
  f.state.rolePermissions = P.ManageGuild;
  f.state.memberChannelFlags |= P.MentionEveryone;
  f.state.botChannelFlags |= P.MentionEveryone;
  const adminView = await f.runtime.capabilitiesView(actorId);
  assert.ok(adminView.permissions.includes("settings.save"));
  assert.ok("moduleSettings" in adminView);
  assert.ok(adminView.mentionPermissions.roleIds.includes(lockedMentionId));
  assert.equal(adminView.mentionPermissions.everyone, true);
  f.state.rolePermissions = 0n;
  f.state.roleIds = [];
  const revoked = await f.runtime.capabilitiesView(actorId);
  assert.ok(!revoked.permissions.includes("settings.save"));
  assert.ok(!revoked.permissions.includes("announcements.create"));
  f.state.freshChannelIds = [privateChannelId];
  const removed = await f.runtime.capabilitiesView(actorId);
  assert.deepEqual(removed.resources.channels, []);
  assert.deepEqual(removed.mentionPermissions, { roleIds: [], everyone: false });
  f.state.pending = true;
  await assert.rejects(
    () => f.runtime.capabilitiesView(actorId),
    isControl(403, "ineligible_member"),
  );
});

test("beta hides announcement support while module OFF keeps history resolution without scheduling or publishing", async (t) => {
  for (const options of [{ beta: false }, { enabled: false }]) {
    const f = fixture(t, options);
    let calls = 0;
    f.runtime.announcements.sync = () => calls++;
    f.runtime.sync();
    assert.equal(calls, 0);
    const view = await f.runtime.capabilitiesView(actorId);
    if (options.beta === false) {
      assert.ok(!view.permissions.some((value) => value.startsWith("announcements.")));
      assert.equal(view.announcementReconciliation, undefined);
    } else {
      assert.deepEqual(
        view.permissions.filter((value) => value.startsWith("announcements.")).sort(),
        [
          "announcements.list",
          "announcements.read",
          "announcements.delivery.inspect",
          "announcements.delivery.resolve",
          "announcements.pause",
          "announcements.cancel",
          "announcements.remove",
        ].sort(),
      );
      assert.deepEqual(view.announcementReconciliation, { version: 1 });
    }
    await assert.rejects(() => f.create("beta-disabled"), isControl(403, "permission_revoked"));
  }
  const enabled = fixture(t);
  let calls = 0;
  enabled.runtime.announcements.sync = () => calls++;
  enabled.runtime.sync();
  assert.equal(calls, 1);
});

test("OFF-safe pause, cancel and remove stop existing work without changing UNKNOWN evidence or enabling publication", async (t) => {
  for (const operation of ["pause", "cancel", "remove"]) {
    const f = fixture(t),
      created = await f.create(`off-safe-${operation}`),
      jobs = f.runtime.jobs;
    const queued = jobs.enqueue({
      guildId,
      type: "announcement.send",
      objectId: created.announcement.id,
      generation: created.announcement.generation,
      dueAt: Date.now() - 1,
      payload: {
        announcementId: created.announcement.id,
        generation: created.announcement.generation,
      },
      dedupeKey: `off-unknown-${operation}`,
    });
    const [lease] = jobs.claim();
    assert.equal(lease.id, queued.id);
    jobs.beginAttempt(lease.id, lease.leaseToken, { channelId, nonce: "retained-unknown" });
    jobs.unknown(lease.id, lease.leaseToken, "discord_delivery_unconfirmed");
    const before = jobs.get(lease.id),
      attempts = jobs.attempts(lease.id);
    const settings = f.runtime.settings.read();
    settings.enabled.announcements = false;
    f.runtime.settings.save(settings, actorId);
    const settingsBefore = f.runtime.settings.read();
    // Safe cleanup cannot depend on still being able to read or send to the old target.
    f.state.channelError = Object.assign(Error("deleted channel"), { code: 10003 });
    f.state.memberChannelFlags = 0n;
    f.state.botChannelFlags = 0n;
    const requestId = `off-safe-${operation}-request`,
      payload = { revision: created.announcement.revision },
      result = await f.runtime.request(
        f.facts(),
        `announcements.${operation}`,
        payload,
        created.announcement.id,
        requestId,
      );
    assert.deepEqual(
      await f.runtime.request(
        f.facts(),
        `announcements.${operation}`,
        payload,
        created.announcement.id,
        requestId,
      ),
      result,
    );
    assert.equal(jobs.get(created.job.id).state, "cancelled");
    const unknown = jobs.get(lease.id);
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.cancelRequested, true);
    assert.equal(unknown.messageId, before.messageId);
    assert.deepEqual(unknown.result, before.result);
    assert.deepEqual(unknown.payload, before.payload);
    assert.deepEqual(jobs.attempts(lease.id), attempts);
    assert.equal(jobs.list().length, 2);
    assert.equal(jobs.claim().length, 0);
    assert.deepEqual(f.runtime.settings.read(), settingsBefore);
    assert.equal(f.sent.length, 0);
    if (operation === "remove") {
      assert.equal(result.removed, true);
      assert.equal(
        jobs.db.prepare("SELECT content FROM announcements WHERE id=?").get(created.announcement.id)
          .content,
        "",
      );
    } else assert.equal(result.announcement.status, operation === "pause" ? "paused" : "cancelled");
  }
});

test("OFF-safe cleanup still rejects stale revisions and revoked fresh roles despite cached administrator claims", async (t) => {
  for (const operation of ["pause", "cancel", "remove"]) {
    const f = fixture(t),
      created = await f.create(`off-guard-${operation}`);
    f.runtime.settings.save(
      {
        ...f.runtime.settings.read(),
        enabled: { ...f.runtime.settings.read().enabled, announcements: false },
      },
      actorId,
    );
    const before = f.runtime.jobs.db
      .prepare("SELECT * FROM announcements WHERE id=?")
      .get(created.announcement.id);
    await assert.rejects(
      () =>
        f.runtime.request(
          f.facts(),
          `announcements.${operation}`,
          { revision: created.announcement.revision + 1 },
          created.announcement.id,
          `off-stale-${operation}`,
        ),
      isControl(409, "revision_conflict"),
    );
    f.state.roleIds = [];
    await assert.rejects(
      () =>
        f.runtime.request(
          f.admin(),
          `announcements.${operation}`,
          { revision: created.announcement.revision },
          created.announcement.id,
          `off-revoked-${operation}`,
        ),
      isControl(403, "permission_revoked"),
    );
    assert.deepEqual(
      f.runtime.jobs.db
        .prepare("SELECT * FROM announcements WHERE id=?")
        .get(created.announcement.id),
      before,
    );
    assert.equal(f.sent.length, 0);
  }
});

test("OFF still refuses outgoing announcement actions and Beta OFF refuses even safe cleanup", async (t) => {
  const f = fixture(t, { enabled: false });
  for (const operation of ["create", "update", "preview", "test", "resume", "assets.upload"])
    await assert.rejects(
      () =>
        f.runtime.request(
          f.facts(),
          `announcements.${operation}`,
          {},
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          `off-outgoing-${operation}`,
        ),
      isControl(403, "permission_revoked"),
    );
  assert.equal(f.runtime.jobs.list().length, 0);
  assert.equal(f.sent.length, 0);
  const unavailable = fixture(t, { beta: false });
  for (const operation of ["pause", "cancel", "remove"])
    await assert.rejects(
      () =>
        unavailable.runtime.request(
          unavailable.facts(),
          `announcements.${operation}`,
          { revision: 1 },
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          `no-beta-${operation}`,
        ),
      isControl(403, "permission_revoked"),
    );
});

test("raw job authorization precedes lookup and admin responses strip private execution data", async (t) => {
  const f = fixture(t);
  const job = f.runtime.jobs.enqueue({
    guildId,
    type: "announcement.send",
    payload: { privateToken: "not-for-panel" },
    dueAt: Date.now(),
    dedupeKey: "private-job",
  });
  const [lease] = f.runtime.jobs.claim();
  f.runtime.jobs.beginAttempt(lease.id, lease.leaseToken, { nonce: "private-nonce", channelId });
  let lookups = 0;
  const get = f.runtime.jobs.get.bind(f.runtime.jobs);
  f.runtime.jobs.get = (id) => {
    lookups++;
    return get(id);
  };
  for (const id of [job.id, "missing"]) {
    await assert.rejects(
      () => f.runtime.request(f.facts(), "jobs.read", {}, id),
      isControl(403, "forbidden"),
    );
  }
  assert.equal(lookups, 0);
  const view = await f.runtime.request(f.admin(), "jobs.read", {}, job.id);
  assert.ok(!("payload" in view.job));
  assert.ok(!("result" in view.job));
  assert.ok(!("leaseToken" in view.job));
  assert.ok(!("leaseToken" in view.attempts[0]));
  assert.ok(!("nonce" in view.attempts[0]));
  assert.ok(!("result" in view.attempts[0]));
  await assert.rejects(
    () => f.runtime.request(f.admin(), "jobs.read", {}, "missing"),
    isControl(404, "not_found"),
  );
  await assert.rejects(
    () => f.runtime.request({ ...f.admin(), guildId: otherGuildId }, "jobs.read", {}, job.id),
    isControl(403, "guild_mismatch"),
  );
});

test("announcement history is object-scoped and all mutation jobs are sanitized", async (t) => {
  const f = fixture(t);
  const first = await f.create("first-announcement"),
    second = await f.create("second-announcement");
  assert.ok(!("payload" in first.job));
  assert.ok(!("leaseToken" in first.job));
  const trial = await f.runtime.request(
    f.facts(),
    "announcements.test",
    { revision: first.announcement.revision },
    first.announcement.id,
    "test-announcement",
  );
  const [lease] = f.runtime.jobs.claim();
  assert.equal(lease.id, trial.job.id);
  f.runtime.jobs.beginAttempt(lease.id, lease.leaseToken, { nonce: "private-nonce", channelId });
  const view = await f.runtime.request(f.facts(), "announcements.read", {}, first.announcement.id);
  assert.equal(view.announcement.id, first.announcement.id);
  assert.equal(view.jobs.length, 2);
  assert.ok(view.jobs.every((value) => value.objectId === first.announcement.id));
  assert.ok(
    view.jobs.every(
      (value) => value.id !== second.job.id && !("payload" in value) && !("leaseToken" in value),
    ),
  );
  assert.equal(view.deliveries.length, 1);
  assert.ok(!("nonce" in view.deliveries[0]));
  f.state.roleIds = [];
  await assert.rejects(
    () => f.runtime.request(f.facts(), "announcements.read", {}, first.announcement.id),
    isControl(403, "permission_revoked"),
  );
});

test("schedule-only preview normalizes recurring and local one-time dates with DST policy", async (t) => {
  const f = fixture(t);
  const preview = (schedule) => f.runtime.request(f.facts(), "announcements.preview", { schedule });
  const recurring = await preview({
    kind: "weekly",
    weekdays: [5, 1],
    time: "19:30",
    timeZone: "Europe/Warsaw",
    startDate: "2027-01-01",
  });
  assert.deepEqual(recurring.schedule.weekdays, [1, 5]);
  assert.equal(recurring.occurrences.length, 5);
  assert.equal(recurring.occurrences[0].localTime, "2027-01-01T19:30");
  const once = await preview({
    kind: "once",
    date: "2027-03-28",
    time: "02:30",
    timeZone: "Europe/Warsaw",
  });
  assert.deepEqual(once.schedule, { kind: "once", at: Date.parse("2027-03-28T01:00:00Z") });
  assert.equal(once.occurrences[0].localTime, "2027-03-28T03:00");
  assert.equal(once.occurrences[0].adjusted, true);
  assert.equal(once.occurrences[0].timeZone, "Europe/Warsaw");
  await assert.rejects(
    () => preview({ kind: "once", date: "2027-02-30", time: "12:00", timeZone: "Europe/Warsaw" }),
    isControl(400, "invalid_input"),
  );
  await assert.rejects(
    () =>
      f.runtime.request(f.facts(), "announcements.preview", {
        schedule: { kind: "once", at: Date.now() + 60000 },
        content: "unexpected",
      }),
    isControl(400, "invalid_input"),
  );
});

test("current role and channel mention permissions are enforced before scheduling", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () => f.create("locked-role", { roleIds: [lockedMentionId] }),
    isControl(403, "permission_revoked"),
  );
  await assert.rejects(
    () => f.create("everyone", { mentionEveryone: true }),
    isControl(403, "permission_revoked"),
  );
  await f.create("mentionable-role", { roleIds: [mentionId] });
  f.state.memberChannelFlags |= P.MentionEveryone;
  f.state.botChannelFlags |= P.MentionEveryone;
  await f.create("explicit-everyone", { mentionEveryone: true });
  f.state.memberChannelFlags = 0n;
  await assert.rejects(() => f.create("hidden-channel"), isControl(400, "channel_unavailable"));
  f.state.memberChannelFlags = publicFlags;
  f.state.roleIds = [];
  await assert.rejects(() => f.create("revoked-role"), isControl(403, "permission_revoked"));
});

test("missing members and channels are permanent while network failures remain retryable", async (t) => {
  const f = fixture(t);
  f.state.memberError = Object.assign(Error("missing member"), { code: 10007 });
  await assert.rejects(() => f.create("missing-member"), isControl(403, "permission_revoked"));
  f.state.memberError = undefined;
  f.state.channelError = Object.assign(Error("missing channel"), { code: 10003 });
  await assert.rejects(() => f.create("missing-channel"), isControl(400, "channel_unavailable"));
  const outage = Object.assign(Error("offline"), { code: "ETIMEDOUT" });
  f.state.channelError = outage;
  await assert.rejects(
    () => f.create("network-failure"),
    (error) => error === outage,
  );
});

test("actual SDK foreign-guild channel errors become a client rejection before announcement or job writes", async (t) => {
  const f = fixture(t),
    fetch = foreignSdkChannelFetch();
  await assert.rejects(
    () => fetch(channelId, { force: true }),
    (error) => {
      assert.ok(error instanceof DiscordjsError);
      assert.equal(error.code, "GuildChannelUnowned");
      assert.equal(isDiscordChannelUnavailable(error), true);
      return true;
    },
  );
  f.guild.channels.fetch = fetch;
  const db = f.runtime.jobs.db,
    before = db.prepare("SELECT total_changes() AS count").get().count;
  await assert.rejects(
    () => f.create("foreign-sdk-channel"),
    isControl(400, "channel_unavailable"),
  );
  assert.equal(db.prepare("SELECT total_changes() AS count").get().count, before);
  for (const table of [
    "announcements",
    "jobs",
    "schedules",
    "delivery_attempts",
    "announcement_actions",
    "idempotency_keys",
  ])
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  assert.equal(f.sent.length, 0);
});

test("channel-unavailable classification is exact and leaves network or rate-limit failures unchanged", async (t) => {
  assert.equal(isDiscordChannelUnavailable({ code: 10003 }), true);
  for (const error of [
    null,
    undefined,
    "GuildChannelUnowned",
    { code: "guildchannelunowned" },
    { code: "10003" },
    { code: 50001 },
    { code: 50013 },
    { status: 403 },
    { status: 429 },
  ])
    assert.equal(isDiscordChannelUnavailable(error), false);
  const f = fixture(t),
    db = f.runtime.jobs.db,
    before = db.prepare("SELECT total_changes() AS count").get().count;
  for (const error of [
    Object.assign(Error("temporary network outage"), { code: "ETIMEDOUT" }),
    Object.assign(Error("rate limited"), { status: 429, code: 0 }),
  ]) {
    f.state.channelError = error;
    assert.equal(isDiscordChannelUnavailable(error), false);
    await assert.rejects(
      () => f.create("transient-channel-failure"),
      (actual) => actual === error,
    );
  }
  assert.equal(db.prepare("SELECT total_changes() AS count").get().count, before);
  assert.equal(f.sent.length, 0);
});

test("a foreign SDK channel result during the final transport check never begins a delivery attempt", async (t) => {
  const f = fixture(t),
    created = await f.create("foreign-channel-before-send");
  await f.runtime.request(
    f.facts(),
    "announcements.test",
    { revision: created.announcement.revision },
    created.announcement.id,
    "foreign-channel-trial",
  );
  const [lease] = f.runtime.jobs.claim(),
    originalFetch = f.guild.channels.fetch,
    foreignFetch = foreignSdkChannelFetch();
  let checks = 0;
  f.guild.channels.fetch = (id, options) =>
    ++checks === 1 ? originalFetch(id, options) : foreignFetch(id, options);
  assert.deepEqual(
    await f.runtime.execute(lease, {
      signal: globalThis.AbortSignal.timeout(5000),
      now: Date.now,
      checkpoint() {},
      beginAttempt(metadata) {
        f.runtime.jobs.beginAttempt(lease.id, lease.leaseToken, metadata);
      },
    }),
    { state: "failed", error: "channel_unavailable" },
  );
  assert.equal(checks, 2);
  assert.equal(f.runtime.jobs.attempts(lease.id).length, 0);
  assert.equal(f.sent.length, 0);
});

test("job conflicts keep stable client errors and do not expose internal database messages", async (t) => {
  const f = fixture(t),
    job = f.runtime.jobs.enqueue({
      guildId,
      type: "test",
      payload: {},
      dueAt: Date.now() + 60000,
      dedupeKey: "cancel-job",
    });
  await f.runtime.request(
    f.admin(),
    "jobs.cancel",
    { revision: job.revision },
    job.id,
    "cancel-request",
  );
  await assert.rejects(
    () =>
      f.runtime.request(
        f.admin(),
        "jobs.cancel",
        { revision: job.revision + 1 },
        job.id,
        "cancel-request",
      ),
    isControl(409, "idempotency_conflict"),
  );
});

test("queued deliveries recheck membership and channel access without converting outages to permanent failures", async (t) => {
  for (const [failure, expected] of [
    ["member", "permission_revoked"],
    ["channel", "channel_unavailable"],
    ["role", "permission_revoked"],
    ["timeout", "permission_revoked"],
    ["disabled", "permission_revoked"],
    ["network", null],
  ]) {
    const f = fixture(t),
      created = await f.create(`queued-${failure}`);
    await f.runtime.request(
      f.facts(),
      "announcements.test",
      { revision: created.announcement.revision },
      created.announcement.id,
      `trial-${failure}`,
    );
    const [lease] = f.runtime.jobs.claim();
    const outage = Object.assign(Error("offline"), { code: "ECONNRESET" });
    if (failure === "member")
      f.state.memberError = Object.assign(Error("missing"), { code: 10007 });
    if (failure === "channel")
      f.state.channelError = Object.assign(Error("missing"), { code: 10003 });
    if (failure === "role") f.state.roleIds = [];
    if (failure === "timeout") f.state.timedOut = true;
    if (failure === "network") f.state.memberError = outage;
    if (failure === "disabled") {
      const settings = f.runtime.settings.read();
      settings.enabled.announcements = false;
      f.runtime.settings.save(settings, actorId);
    }
    const execution = {
      signal: globalThis.AbortSignal.timeout(5000),
      now: Date.now,
      checkpoint() {},
      beginAttempt(metadata) {
        f.runtime.jobs.beginAttempt(lease.id, lease.leaseToken, metadata);
      },
    };
    if (expected)
      assert.deepEqual(await f.runtime.execute(lease, execution), {
        state: "failed",
        error: expected,
      });
    else
      await assert.rejects(
        () => f.runtime.execute(lease, execution),
        (error) => error === outage,
      );
    assert.equal(f.sent.length, 0);
    assert.equal(f.runtime.jobs.attempts(lease.id).length, 0);
  }
});

test("a permitted queued test publishes only explicit Discord mentions through the transport", async (t) => {
  const f = fixture(t),
    created = await f.create("permitted-delivery");
  await f.runtime.request(
    f.facts(),
    "announcements.test",
    { revision: created.announcement.revision },
    created.announcement.id,
    "permitted-trial",
  );
  const [lease] = f.runtime.jobs.claim();
  const outcome = await f.runtime.execute(lease, {
    signal: globalThis.AbortSignal.timeout(5000),
    now: Date.now,
    checkpoint() {},
    beginAttempt(metadata) {
      f.runtime.jobs.beginAttempt(lease.id, lease.leaseToken, metadata);
    },
  });
  assert.deepEqual(outcome, { state: "succeeded", messageId: "500000000000000001" });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].route, `/channels/${channelId}/messages`);
  const body = f.sent[0].options.body;
  assert.equal(body.enforce_nonce, true);
  assert.match(body.nonce, /^\d+$/);
  assert.deepEqual(body.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
  assert.match(body.content, /^Próba ogłoszenia/);
});

test("remove uses fresh manager authority, retains published Discord messages and replays its receipt", async (t) => {
  const f = fixture(t),
    created = await f.create("create-remove");
  await f.runtime.request(
    f.facts(),
    "announcements.test",
    { revision: created.announcement.revision },
    created.announcement.id,
    "test-before-remove",
  );
  const [lease] = f.runtime.jobs.claim();
  const sent = await f.runtime.execute(lease, {
    signal: globalThis.AbortSignal.timeout(5000),
    now: Date.now,
    checkpoint() {},
    beginAttempt(metadata) {
      f.runtime.jobs.beginAttempt(lease.id, lease.leaseToken, metadata);
    },
  });
  f.runtime.jobs.complete(lease.id, lease.leaseToken, { messageId: sent.messageId });
  const before = (
    await f.runtime.request(f.facts(), "announcements.read", {}, created.announcement.id)
  ).announcement;
  const removed = await f.runtime.request(
    f.facts(),
    "announcements.remove",
    { revision: before.revision },
    before.id,
    "remove-rule",
  );
  assert.deepEqual(removed, {
    removed: true,
    announcementId: before.id,
    revision: before.revision + 1,
  });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].route, `/channels/${channelId}/messages`);
  assert.deepEqual(
    await f.runtime.request(
      f.facts(),
      "announcements.remove",
      { revision: before.revision },
      before.id,
      "remove-rule",
    ),
    removed,
  );
  await assert.rejects(
    f.runtime.request(f.facts(), "announcements.read", {}, before.id),
    isControl(404, "not_found"),
  );
  assert.deepEqual(
    (await f.runtime.request(f.facts(), "announcements.list", {})).announcements,
    [],
  );
  f.state.roleIds = [];
  await assert.rejects(
    f.runtime.request(
      f.admin(),
      "announcements.remove",
      { revision: before.revision },
      before.id,
      "remove-rule",
    ),
    isControl(403, "permission_revoked"),
  );
});
