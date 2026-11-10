import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PermissionFlagsBits as P, RateLimitError } from "discord.js";
import { Store } from "../dist/storage/store.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { serverRulesMigration } from "../dist/modules/server-rules/schema.js";
import { ServerRulesService, RulesError } from "../dist/modules/server-rules/service.js";
import { canonical, digest } from "../dist/shared/utils.js";
import {
  ServerRulesRetention,
  serverRulesRetentionPolicy,
} from "../dist/modules/server-rules/retention.js";
import {
  rulesControlId,
  normalizeRulesDraft,
  rulesParts,
} from "../dist/modules/server-rules/content.js";

const { structuredClone, AbortController } = globalThis;

const guildId = "100000000000000001",
  actorId = "100000000000000002",
  userId = "100000000000000003",
  botId = "100000000000000004",
  roleId = "100000000000000005",
  botRoleId = "100000000000000006",
  channelId = "100000000000000007",
  otherGuild = "200000000000000001";
const code = (name) => (error) => error instanceof RulesError && error.code === name;

function fixture(t, guild = guildId) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-rules-"));
  let now = Date.parse("2026-11-10T12:00:00Z"),
    sequence = 0;
  let admin = {
    guildId: guild,
    userId: actorId,
    owner: true,
    manageGuild: false,
    pending: false,
    timedOut: false,
  };
  let member = {
    guildId: guild,
    userId,
    joinedAt: now - 60000,
    bot: false,
    pending: false,
    timedOut: false,
    roleIds: [],
  };
  let preflight = {
    guildId: guild,
    nativeScreening: true,
    complete: true,
    roles: [
      {
        guildId: guild,
        id: guild,
        permissions: P.ViewChannel | P.ReadMessageHistory,
        position: 0,
        managed: false,
        restricted: false,
      },
      {
        guildId: guild,
        id: roleId,
        permissions: 0n,
        position: 1,
        managed: false,
        restricted: false,
      },
      {
        guildId: guild,
        id: botRoleId,
        permissions: P.ManageRoles | P.SendMessages | P.AddReactions,
        position: 3,
        managed: true,
        restricted: false,
      },
    ],
    channels: [{ guildId: guild, id: channelId, type: "text", overwrites: [] }],
    botRoleIds: [botRoleId],
    interestRoleIds: [],
    staffRoleIds: [],
    staffUserIds: [],
  };
  const messages = new Map(),
    sends = [],
    grants = [],
    retirements = [],
    stores = [];
  const ports = {
    administrator: async () => ({ ...structuredClone(admin), observedAt: now }),
    preflight: async () => ({ ...structuredClone(preflight), observedAt: now }),
    member: async () => (member === null ? null : { ...structuredClone(member), observedAt: now }),
    message: async (channel, message) => messages.get(channel + ":" + message) ?? null,
    sendPart: async (input) => {
      sends.push(input);
      const id = String(300000000000000000n + BigInt(++sequence));
      messages.set(input.channelId + ":" + id, {
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: id,
        authorId: botId,
        webhookId: null,
        content: input.content,
        controlId: input.controlId,
        reactionEmoji: null,
      });
      return { guildId: input.guildId, channelId: input.channelId, messageId: id };
    },
    seedReaction: async (input) => {
      const message = messages.get(input.channelId + ":" + input.messageId);
      message.reactionEmoji = input.emoji;
    },
    addRole: async (input) => {
      grants.push(input);
      member.roleIds.push(input.roleId);
    },
    retireControls: async (input) => {
      retirements.push(input);
      const message = messages.get(input.channelId + ":" + input.messageId);
      message.controlId = null;
      message.reactionEmoji = null;
    },
  };
  const open = () => {
    const store = new Store(join(directory, "guild.sqlite"), guild),
      jobs = new JobStore(store.db, () => now);
    if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='server_rules_settings'").get())
      store.db.exec(serverRulesMigration.sql);
    const service = new ServerRulesService(jobs, {
      guildId: guild,
      botId,
      ports,
      clock: () => now,
    });
    stores.push(store);
    return { store, jobs, service };
  };
  const f = {
    ...open(),
    open,
    ports,
    messages,
    sends,
    grants,
    retirements,
    now: () => now,
    setNow: (value) => {
      now = value;
    },
    get member() {
      return member;
    },
    set member(value) {
      member = value;
    },
    get preflight() {
      return preflight;
    },
    set preflight(value) {
      preflight = value;
    },
    get admin() {
      return admin;
    },
    set admin(value) {
      admin = value;
    },
    draft: (patch = {}) => ({
      channelId,
      roleId,
      label: "2026.1",
      content: "Szanuj innych.\nNie publikuj prywatnych danych.",
      method: "button",
      emoji: null,
      ...patch,
    }),
  };
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* Closed during a restart fixture. */
      }
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return f;
}
function context(f, job) {
  const controller = new AbortController();
  return {
    controller,
    signal: controller.signal,
    now: f.now,
    checkpoint() {
      const current = f.jobs.get(job.id);
      if (
        controller.signal.aborted ||
        current.state !== "running" ||
        current.leaseToken !== job.leaseToken ||
        current.leaseUntil <= f.now() ||
        current.cancelRequested
      )
        throw new RulesError("stale_lease");
    },
    beginAttempt(input) {
      f.jobs.beginAttempt(job.id, job.leaseToken, input);
    },
  };
}
async function run(f, type) {
  const [job] = f.jobs.claim({ guildId: f.service.guildId, types: [type], limit: 1 });
  assert.ok(job, "expected pending " + type);
  const ctx = context(f, job),
    result = await f.service.execute(job, ctx);
  if (result.state === "succeeded") f.jobs.complete(job.id, job.leaseToken, result);
  else if (result.state === "unknown") f.jobs.unknown(job.id, job.leaseToken, result.error);
  else if (result.state === "failed") f.jobs.fail(job.id, job.leaseToken, result.error);
  else if (result.state === "retry") f.jobs.retry(job.id, job.leaseToken, result);
  else assert.fail("Unexpected outcome: " + result.state);
  return { job, result, ctx };
}
async function publish(f, draft = f.draft(), request = "publish") {
  const saved = await f.service.configure(
    actorId,
    "configure-" + request,
    f.service.settings().revision,
    { enabled: true, draft },
  );
  const version = await f.service.publish(actorId, request, saved.revision);
  for (const part of f.service.parts(version.id)) {
    assert.ok(part.jobId);
    await run(f, "server-rules.publish-part");
  }
  if (draft.method === "reaction") await run(f, "server-rules.seed-reaction");
  await run(f, "server-rules.activate");
  return version;
}

function legacyPublication(f, version, draft) {
  const legacy = rulesParts(draft, 1),
    stored = f.service.parts(version.id);
  assert.equal(stored.length, legacy.length);
  f.jobs.db
    .prepare("UPDATE server_rules_versions SET body=?,content_hash=? WHERE guild_id=? AND id=?")
    .run(canonical(draft), digest(draft), f.service.guildId, version.id);
  for (const [index, part] of stored.entries()) {
    f.jobs.db
      .prepare(
        "UPDATE server_rules_parts SET content=?,content_hash=? WHERE guild_id=? AND version_id=? AND part_index=?",
      )
      .run(legacy[index], digest(legacy[index]), f.service.guildId, version.id, index);
    f.messages.get(channelId + ":" + part.messageId).content = legacy[index];
  }
}

test("an active legacy publication still accepts without rewriting or reposting its stored messages", async (t) => {
  const f = fixture(t),
    draft = f.draft({ content: "\n" + "Polskie zasady dla uczestników. ".repeat(100) }),
    version = await publish(f, draft);
  legacyPublication(f, version, draft);
  const before = f.service.parts(version.id).map((part) => part.content),
    sends = f.sends.length;
  await f.service.accept(userId, event(f, version));
  await run(f, "server-rules.grant-role");
  assert.equal(f.grants.length, 1);
  assert.equal(f.sends.length, sends);
  assert.deepEqual(
    f.service.parts(version.id).map((part) => part.content),
    before,
  );
});

test("legacy verification still works when the new formatter cannot render a historical single grapheme", async (t) => {
  const f = fixture(t),
    version = await publish(f, f.draft({ content: "Zdanie ".repeat(400) })),
    historical = f.draft({ content: "x" + "\u0301".repeat(2500) });
  assert.throws(() => rulesParts(historical));
  legacyPublication(f, version, historical);
  await f.service.accept(userId, event(f, version));
  assert.equal(f.service.parts(version.id).map((part) => part.content).length, 2);
});

test("mixing old and new message boundaries cannot manufacture a valid rules publication", async (t) => {
  const f = fixture(t),
    draft = f.draft({ content: "\n" + "Polskie zasady dla uczestników. ".repeat(100) }),
    version = await publish(f, draft),
    part = f.service.parts(version.id)[0],
    incompatible = rulesParts(draft, 1)[0];
  assert.notEqual(part.content, incompatible);
  f.jobs.db
    .prepare(
      "UPDATE server_rules_parts SET content=?,content_hash=? WHERE guild_id=? AND version_id=? AND part_index=0",
    )
    .run(incompatible, digest(incompatible), f.service.guildId, version.id);
  f.messages.get(channelId + ":" + part.messageId).content = incompatible;
  await assert.rejects(f.service.accept(userId, event(f, version)), code("publication_not_ready"));
  assert.equal(f.grants.length, 0);
  assert.equal(f.jobs.db.prepare("SELECT COUNT(*) n FROM server_rules_acceptances").get().n, 0);
});
function event(f, version, patch = {}) {
  return {
    guildId: f.service.guildId,
    versionId: version.id,
    channelId,
    messageId: f.service.parts(version.id).at(-1).messageId,
    source: "button",
    controlId: rulesControlId(f.service.guildId, version.id),
    ...patch,
  };
}
const count = (f, table) => Number(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);

test("server rules are OFF by default, have no startup effects, and require fresh administrator authority", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.service.settings(), {
    guildId,
    revision: 0,
    generation: 0,
    enabled: false,
    draft: null,
    activeVersionId: null,
  });
  await assert.rejects(f.service.publish(actorId, "no", 0), code("disabled"));
  f.admin.owner = false;
  await assert.rejects(
    f.service.configure(actorId, "denied", 0, { enabled: true, draft: f.draft() }),
    code("permission_revoked"),
  );
  f.admin.manageGuild = true;
  const saved = await f.service.configure(actorId, "save", 0, { enabled: true, draft: f.draft() });
  assert.equal(saved.revision, 1);
  assert.equal(count(f, "jobs"), 0);
  assert.equal(f.sends.length + f.grants.length + f.retirements.length, 0);
});

test("immutable multi-part publication, request replay and activation preserve one durable version without mentions", async (t) => {
  const f = fixture(t),
    draft = f.draft({
      content: "@everyone <@&100000000000000005>\n" + "💡".repeat(5900),
      label: "Wersja 1",
    });
  const saved = await f.service.configure(actorId, "configure", 0, { enabled: true, draft });
  const version = await f.service.publish(actorId, "publish", saved.revision);
  assert.equal((await f.service.publish(actorId, "publish", saved.revision)).id, version.id);
  assert.equal(count(f, "server_rules_versions"), 1);
  assert.equal(f.service.settings().activeVersionId, null);
  await assert.rejects(f.service.accept(userId, event(f, version)), code("stale_generation"));
  const parts = f.service.parts(version.id);
  assert.ok(parts.length > 1 && parts.length <= 8);
  for (const part of parts) {
    assert.ok(part.content.length <= 2000);
    assert.doesNotMatch(part.content, /[\uD800-\uDBFF]$/);
    await run(f, "server-rules.publish-part");
  }
  assert.equal(f.service.settings().activeVersionId, null);
  await run(f, "server-rules.activate");
  assert.equal(f.service.settings().activeVersionId, version.id);
  for (const send of f.sends) {
    assert.deepEqual(send.allowedMentions, { parse: [], roles: [], users: [] });
    assert.equal(send.enforceNonce, true);
  }
  assert.equal(f.sends.filter((send) => send.controlId).length, 1);
});

test("configuration CAS and conflicting requestIds do not overwrite another administrator's draft", async (t) => {
  const f = fixture(t),
    input = { enabled: true, draft: f.draft() };
  await f.service.configure(actorId, "one", 0, input);
  await assert.rejects(
    f.service.configure(actorId, "stale", 0, { ...input, draft: f.draft({ content: "Zmiana" }) }),
    code("revision_conflict"),
  );
  await assert.rejects(
    f.service.configure(actorId, "one", 0, { ...input, draft: f.draft({ label: "Inny" }) }),
    (error) => error.code === "idempotency_conflict",
  );
  assert.equal(f.service.settings().draft.label, input.draft.label);
});

test("administrator authority revoked during resource fetch is checked again before configuration or publication writes", async (t) => {
  const f = fixture(t),
    preflight = f.ports.preflight;
  f.ports.preflight = async () => {
    const result = await preflight();
    f.admin.owner = false;
    return result;
  };
  await assert.rejects(
    f.service.configure(actorId, "revoked", 0, { enabled: true, draft: f.draft() }),
    code("permission_revoked"),
  );
  assert.equal(count(f, "server_rules_settings"), 0);
  f.admin.owner = true;
  f.ports.preflight = preflight;
  await f.service.configure(actorId, "allowed", 0, { enabled: true, draft: f.draft() });
  f.ports.preflight = async () => {
    const result = await preflight();
    f.admin.owner = false;
    return result;
  };
  await assert.rejects(
    f.service.publish(actorId, "revoked-publish", 1),
    code("permission_revoked"),
  );
  assert.equal(count(f, "jobs"), 0);
});

test("two SQLite connections and duplicate clicks share one acceptance and one grant across restart", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    second = f.open();
  const [a, b] = await Promise.all([
    f.service.accept(userId, event(f, version)),
    second.service.accept(userId, event(f, version)),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.jobId, b.jobId);
  assert.equal(count(f, "server_rules_acceptances"), 1);
  assert.equal(f.jobs.list({ type: "server-rules.grant-role" }).length, 1);
  f.store.close();
  const restarted = f.open(),
    r = { ...f, ...restarted };
  await run(r, "server-rules.grant-role");
  assert.equal((await restarted.service.accept(userId, event(r, version))).grantState, "confirmed");
  assert.equal(f.grants.length, 1);
  assert.equal(f.grants[0].roleId, roleId);
  assert.deepEqual(f.member.roleIds, [roleId]);
});

test("a role that was already present records consent without claiming the bot granted it", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  f.member.roleIds.push(roleId);
  const accepted = await f.service.accept(userId, event(f, version));
  assert.equal(accepted.grantState, "already_present");
  assert.equal(accepted.jobId, null);
  assert.equal(f.grants.length, 0);
  assert.equal(accepted.acceptedAt, f.now());
  assert.equal("nativeAcceptedAt" in accepted, false);
});

test("settings/history and acceptance lists require fresh manager authority on every read", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    accepted = await f.service.accept(userId, event(f, version));
  assert.equal((await f.service.inspect(actorId)).versions[0].id, version.id);
  assert.equal((await f.service.listAcceptances(actorId))[0].id, accepted.id);
  assert.deepEqual(
    await f.service.listAcceptances(actorId, {
      before: { acceptedAt: accepted.acceptedAt, id: accepted.id },
    }),
    [],
  );
  f.admin.owner = false;
  await assert.rejects(f.service.inspect(actorId), code("permission_revoked"));
  await assert.rejects(f.service.listAcceptances(actorId), code("permission_revoked"));
  f.admin.owner = true;
  await assert.rejects(f.service.listAcceptances(actorId, { limit: 101 }), code("invalid_input"));
});

test("native screening, bots, timeout, absent membership and ambiguous pending never receive a role", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    good = structuredClone(f.member);
  for (const patch of [{ pending: true }, { pending: null }, { bot: true }, { timedOut: true }]) {
    f.member = { ...structuredClone(good), ...patch };
    await assert.rejects(
      f.service.accept(userId, event(f, version)),
      code(patch.pending !== undefined ? "native_pending" : "member_unavailable"),
    );
  }
  f.member = null;
  await assert.rejects(f.service.accept(userId, event(f, version)), code("member_unavailable"));
  assert.equal(count(f, "server_rules_acceptances"), 0);
  f.member = { ...good, pending: null };
  f.preflight.nativeScreening = false;
  const accepted = await f.service.accept(userId, event(f, version));
  assert.equal(accepted.grantState, "pending");
  assert.equal(f.grants.length, 0);
});

test("unsafe roles, incomplete ACL and ordinary-member write access fail before any settings or job write", async (t) => {
  const f = fixture(t),
    original = structuredClone(f.preflight);
  const invalid = [
    [
      "role_unavailable",
      (p) => {
        p.roles[1].permissions = P.ManageRoles;
      },
    ],
    [
      "role_unavailable",
      (p) => {
        p.roles[1].managed = true;
      },
    ],
    [
      "role_unavailable",
      (p) => {
        p.roles[1].restricted = true;
      },
    ],
    [
      "role_unavailable",
      (p) => {
        p.roles[1].position = 3;
      },
    ],
    [
      "role_unavailable",
      (p) => {
        p.interestRoleIds = [roleId];
      },
    ],
    [
      "role_unavailable",
      (p) => {
        p.roles[2].permissions &= ~P.ManageRoles;
      },
    ],
    [
      "role_unavailable",
      (p) => {
        p.channels.push({
          guildId,
          id: "100000000000000008",
          type: "other",
          overwrites: [{ id: roleId, type: "role", allow: P.ManageWebhooks, deny: 0n }],
        });
      },
    ],
    [
      "incomplete_acl",
      (p) => {
        p.complete = false;
      },
    ],
    [
      "channel_unavailable",
      (p) => {
        p.channels[0].overwrites.push({
          id: roleId,
          type: "role",
          allow: P.SendMessages,
          deny: 0n,
        });
      },
    ],
    [
      "channel_unavailable",
      (p) => {
        p.channels[0].overwrites.push({
          id: userId,
          type: "member",
          allow: P.CreatePublicThreads,
          deny: 0n,
        });
      },
    ],
    [
      "channel_unavailable",
      (p) => {
        p.channels[0].overwrites.push({ id: roleId, type: "role", allow: 0n, deny: P.ViewChannel });
      },
    ],
  ];
  for (const [error, mutate] of invalid) {
    f.preflight = structuredClone(original);
    mutate(f.preflight);
    const changes = f.store.db.prepare("SELECT total_changes() n").get().n;
    await assert.rejects(
      f.service.configure(actorId, "invalid", 0, { enabled: true, draft: f.draft() }),
      code(error),
    );
    assert.equal(f.store.db.prepare("SELECT total_changes() n").get().n, changes);
  }
  assert.equal(f.sends.length + f.grants.length + f.retirements.length, 0);
});

test("fresh role hierarchy and pending changes after acceptance block the queued grant", async (t) => {
  for (const change of ["role", "pending", "readonly"]) {
    const f = fixture(t),
      version = await publish(f);
    await f.service.accept(userId, event(f, version));
    if (change === "role") f.preflight.roles[1].permissions = P.Administrator;
    if (change === "pending") f.member.pending = true;
    if (change === "readonly")
      f.preflight.channels[0].overwrites.push({
        id: roleId,
        type: "role",
        allow: P.SendMessages,
        deny: 0n,
      });
    const { result } = await run(f, "server-rules.grant-role");
    assert.equal(result.state, "failed");
    assert.equal(f.grants.length, 0);
    assert.equal(
      f.store.db.prepare("SELECT grant_state FROM server_rules_acceptances").get().grant_state,
      "blocked",
    );
  }
});

test("effective member and bot channel overwrites are checked before consent or grant", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  f.preflight.channels[0].overwrites.push({
    id: userId,
    type: "member",
    allow: 0n,
    deny: P.ReadMessageHistory,
  });
  await assert.rejects(f.service.accept(userId, event(f, version)), code("channel_unavailable"));
  f.preflight.channels[0].overwrites = [];
  f.preflight.roles.push({
    guildId,
    id: "100000000000000099",
    position: 2,
    permissions: 0n,
    managed: false,
    restricted: false,
  });
  f.member.roleIds = ["100000000000000099"];
  f.preflight.channels[0].overwrites.push({
    id: "100000000000000099",
    type: "role",
    allow: 0n,
    deny: P.ViewChannel,
  });
  await assert.rejects(f.service.accept(userId, event(f, version)), code("channel_unavailable"));
  f.preflight.channels[0].overwrites = [];
  await f.service.accept(userId, event(f, version));
  f.preflight.channels[0].overwrites.push({
    id: userId,
    type: "member",
    allow: 0n,
    deny: P.ViewChannel,
  });
  assert.equal((await run(f, "server-rules.grant-role")).result.error, "channel_unavailable");
  assert.equal(f.grants.length, 0);
  f.preflight.channels[0].overwrites = [
    { id: botId, type: "member", allow: 0n, deny: P.SendMessages },
  ];
  await assert.rejects(
    f.service.configure(actorId, "bot-denied", f.service.settings().revision, {
      enabled: true,
      draft: f.draft(),
    }),
    code("channel_unavailable"),
  );
});

test("foreign guild, wrong message, webhook or edited publication cannot create consent or a grant", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    base = event(f, version);
  for (const patch of [
    { guildId: otherGuild },
    { channelId: otherGuild },
    { messageId: otherGuild },
    { controlId: rulesControlId(otherGuild, version.id) },
  ])
    await assert.rejects(f.service.accept(userId, { ...base, ...patch }), RulesError);
  const key = channelId + ":" + base.messageId,
    original = structuredClone(f.messages.get(key));
  for (const patch of [
    { content: "Podmienione zasady" },
    { authorId: actorId },
    { webhookId: actorId },
    { guildId: otherGuild },
  ]) {
    f.messages.set(key, { ...structuredClone(original), ...patch });
    await assert.rejects(f.service.accept(userId, base), code("publication_unavailable"));
  }
  f.messages.delete(key);
  await assert.rejects(f.service.accept(userId, base), code("publication_unavailable"));
  assert.equal(count(f, "server_rules_acceptances"), 0);
  assert.equal(f.grants.length, 0);
});

test("rejoin invalidates an old grant and requires fresh explicit consent for the new membership", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    old = await f.service.accept(userId, event(f, version));
  const joinedAt = f.member.joinedAt;
  f.member.joinedAt += 1000;
  assert.equal((await run(f, "server-rules.grant-role")).result.error, "membership_changed");
  assert.equal(f.grants.length, 0);
  const fresh = await f.service.accept(userId, event(f, version));
  assert.notEqual(fresh.id, old.id);
  assert.notEqual(fresh.jobId, old.jobId);
  f.service.memberLeft(userId, joinedAt);
  await run(f, "server-rules.grant-role");
  assert.equal(f.grants.length, 1);
  await assert.rejects(f.service.ownAcceptance(userId, old.id), code("membership_changed"));
  await assert.rejects(f.service.ownAcceptance(actorId, fresh.id), code("not_found"));
});

test("rejoin while reading publication prevents consent and an old member-remove event cannot cancel a new membership", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    oldJoinedAt = f.member.joinedAt,
    message = f.ports.message;
  let once = true;
  f.ports.message = async (...args) => {
    if (once) {
      once = false;
      f.member.joinedAt += 1000;
    }
    return message(...args);
  };
  await assert.rejects(f.service.accept(userId, event(f, version)), code("membership_changed"));
  assert.equal(count(f, "server_rules_acceptances"), 0);
  f.ports.message = message;
  const accepted = await f.service.accept(userId, event(f, version));
  f.service.memberLeft(userId, oldJoinedAt);
  assert.equal(f.jobs.get(accepted.jobId).state, "pending");
  await run(f, "server-rules.grant-role");
  assert.equal(f.grants.length, 1);
});

test("a moderator's role removal is not undone by old clicks, restart or a new version", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  await f.service.accept(userId, event(f, version));
  await run(f, "server-rules.grant-role");
  f.member.roleIds = [];
  await assert.rejects(f.service.accept(userId, event(f, version)), code("role_revoked"));
  const newer = await publish(f, f.draft({ label: "2026.2", content: "Nowa wersja" }), "new");
  await assert.rejects(f.service.accept(userId, event(f, newer)), code("role_revoked"));
  const restarted = f.open();
  await assert.rejects(restarted.service.accept(userId, event(f, newer)), code("role_revoked"));
  assert.equal(f.grants.length, 1);
});

test("unknown role PUT is never retried blindly, but a current positive observation resolves it", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  f.ports.addRole = async (input) => {
    f.grants.push(input);
    throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  };
  const accepted = await f.service.accept(userId, event(f, version));
  assert.equal((await run(f, "server-rules.grant-role")).result.state, "unknown");
  assert.equal((await f.service.accept(userId, event(f, version))).id, accepted.id);
  assert.equal((await f.service.reconcileGrant(userId, accepted.id)).grantState, "unknown");
  assert.equal(f.grants.length, 1);
  assert.equal(f.jobs.claim({ types: ["server-rules.grant-role"] }).length, 0);
  f.member.roleIds.push(roleId);
  assert.equal((await f.service.reconcileGrant(userId, accepted.id)).grantState, "confirmed");
  assert.equal(f.jobs.get(accepted.jobId).state, "succeeded");
  assert.equal(f.grants.length, 1);
});

test("new text does not turn an unresolved old role PUT into a second attempt", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  f.ports.addRole = async (input) => {
    f.grants.push(input);
    throw Error("outage");
  };
  await f.service.accept(userId, event(f, version));
  await run(f, "server-rules.grant-role");
  const newer = await publish(f, f.draft({ label: "2" }), "new");
  await assert.rejects(f.service.accept(userId, event(f, newer)), code("unknown_effect"));
  assert.equal(f.grants.length, 1);
});

test("unknown publication without a receipt is not reposted or treated as active after restart", async (t) => {
  const f = fixture(t),
    saved = await f.service.configure(actorId, "settings", 0, { enabled: true, draft: f.draft() });
  const version = await f.service.publish(actorId, "publish", saved.revision),
    send = f.ports.sendPart;
  f.ports.sendPart = async (input) => {
    await send(input);
    throw Error("lost POST response");
  };
  const [job] = f.jobs.claim({ types: ["server-rules.publish-part"] });
  await assert.rejects(f.service.execute(job, context(f, job)), /lost POST/);
  f.jobs.unknown(job.id, job.leaseToken, "response_lost");
  const reopened = f.open();
  assert.equal(reopened.jobs.claim({ types: ["server-rules.publish-part"] }).length, 0);
  await assert.rejects(
    reopened.service.reconcilePublication(actorId, version.id),
    code("publication_not_ready"),
  );
  assert.equal(f.sends.length, 1);
  assert.equal(reopened.service.settings().activeVersionId, null);
});

test("a mismatched POST receipt or changed returned message is unknown after delivery began, never definite non-delivery", async (t) => {
  for (const mismatch of ["foreign", "edited"]) {
    const f = fixture(t),
      settings = await f.service.configure(actorId, "settings", 0, {
        enabled: true,
        draft: f.draft(),
      });
    await f.service.publish(actorId, "publish", settings.revision);
    const send = f.ports.sendPart;
    f.ports.sendPart = async (input) => {
      const receipt = await send(input);
      if (mismatch === "foreign") return { ...receipt, guildId: otherGuild };
      f.messages.get(input.channelId + ":" + receipt.messageId).content = "Zmieniona treść";
      return receipt;
    };
    const { result } = await run(f, "server-rules.publish-part");
    assert.equal(result.state, "unknown");
    assert.equal(result.error, "publication_unavailable");
    assert.equal(f.jobs.claim({ types: ["server-rules.publish-part"] }).length, 0);
    assert.equal(f.sends.length, 1);
    assert.equal(f.service.settings().activeVersionId, null);
  }
});

test("a known POST receipt survives a later read outage and reconciles without another POST", async (t) => {
  const f = fixture(t),
    saved = await f.service.configure(actorId, "settings", 0, { enabled: true, draft: f.draft() });
  const version = await f.service.publish(actorId, "publish", saved.revision),
    message = f.ports.message;
  f.ports.message = async () => {
    throw Error("read outage");
  };
  const [job] = f.jobs.claim({ types: ["server-rules.publish-part"] });
  await assert.rejects(f.service.execute(job, context(f, job)), /read outage/);
  f.jobs.unknown(job.id, job.leaseToken, "read_outage");
  assert.equal(f.service.parts(version.id)[0].state, "unverified");
  assert.ok(f.service.parts(version.id)[0].messageId);
  f.ports.message = message;
  await f.service.reconcilePublication(actorId, version.id);
  await run(f, "server-rules.activate");
  assert.equal(f.sends.length, 1);
  assert.equal(f.jobs.get(job.id).state, "succeeded");
  assert.equal(f.service.settings().activeVersionId, version.id);
});

test("late publication after OFF retains its receipt and durably clears its old controls", async (t) => {
  const f = fixture(t),
    saved = await f.service.configure(actorId, "settings", 0, { enabled: true, draft: f.draft() });
  const version = await f.service.publish(actorId, "publish", saved.revision),
    send = f.ports.sendPart;
  f.ports.sendPart = async (input) => {
    const settings = f.service.settings();
    await f.service.configure(actorId, "off-before-response", settings.revision, {
      enabled: false,
      draft: settings.draft,
    });
    // The original cleanup can finish before Discord returns the old POST.
    await run(f, "server-rules.retire-controls");
    return send(input);
  };
  const [job] = f.jobs.claim({ types: ["server-rules.publish-part"] });
  await assert.rejects(f.service.execute(job, context(f, job)), code("stale_lease"));
  assert.ok(f.service.parts(version.id)[0].messageId);
  assert.equal(f.jobs.attempts(job.id)[0].state, "succeeded");
  assert.equal(f.service.settings().activeVersionId, null);
  await run(f, "server-rules.retire-controls");
  assert.equal(f.retirements.length, 1);
  assert.equal(f.messages.values().next().value.controlId, null);
  assert.equal(f.sends.length, 1);
  await assert.rejects(f.service.accept(userId, event(f, version)), code("disabled"));
});

test("disable during publication verification prevents acceptance; OFF cancels queued grants without removing roles", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    message = f.ports.message;
  let once = true;
  f.ports.message = async (...args) => {
    if (once) {
      once = false;
      const settings = f.service.settings();
      await f.service.configure(actorId, "disable", settings.revision, {
        enabled: false,
        draft: settings.draft,
      });
    }
    return message(...args);
  };
  await assert.rejects(f.service.accept(userId, event(f, version)), code("disabled"));
  assert.equal(count(f, "server_rules_acceptances"), 0);
  assert.equal(f.grants.length, 0);
  assert.equal(f.service.settings().activeVersionId, null);
});

test("confirmed in-flight role success after OFF is retained as a fact, without reviving the cancelled generation", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    accepted = await f.service.accept(userId, event(f, version)),
    add = f.ports.addRole;
  f.ports.addRole = async (input) => {
    const settings = f.service.settings();
    await f.service.configure(actorId, "off-in-flight", settings.revision, {
      enabled: false,
      draft: settings.draft,
    });
    await add(input);
  };
  const [job] = f.jobs.claim({ types: ["server-rules.grant-role"] });
  await assert.rejects(f.service.execute(job, context(f, job)), code("stale_lease"));
  const row = f.store.db
    .prepare("SELECT grant_state,confirmed_at FROM server_rules_acceptances WHERE id=?")
    .get(accepted.id);
  assert.equal(row.grant_state, "confirmed");
  assert.equal(row.confirmed_at, f.now());
  assert.equal(f.service.settings().enabled, false);
  assert.equal(f.jobs.get(job.id).cancelRequested, true);
  assert.equal(f.grants.length, 1);
});

test("reaction acceptance is bound to one current message and records observation time without toggle revocation", async (t) => {
  const f = fixture(t),
    version = await publish(f, f.draft({ method: "reaction", emoji: "❤️" }));
  for (const emoji of ["💚", "a\u20e3", "❤\u200d"])
    await assert.rejects(
      f.service.accept(userId, event(f, version, { source: "reaction", emoji })),
      code("invalid_input"),
    );
  const accepted = await f.service.accept(
    userId,
    event(f, version, {
      source: "reaction_reconcile",
      emoji: "❤",
      observedAt: f.now() - 1000,
      reconciliationComplete: true,
    }),
  );
  assert.equal(accepted.source, "reaction_reconcile");
  assert.equal(accepted.acceptedAt, f.now() - 1000);
  await run(f, "server-rules.grant-role");
  assert.equal(f.grants.length, 1);
  assert.deepEqual(f.member.roleIds, [roleId]);
  const changes = f.store.db.prepare("SELECT total_changes() n").get().n;
  assert.equal(
    await f.service.reaction(userId, event(f, version, { source: "reaction", emoji: "❤" }), false),
    null,
  );
  assert.equal(f.store.db.prepare("SELECT total_changes() n").get().n, changes);
  assert.deepEqual(f.member.roleIds, [roleId]);
});

test("incomplete reaction reconciliation does not invent consent", async (t) => {
  const f = fixture(t),
    version = await publish(f, f.draft({ method: "reaction", emoji: "✅" }));
  await assert.rejects(
    f.service.accept(
      userId,
      event(f, version, {
        source: "reaction_reconcile",
        emoji: "✅",
        observedAt: f.now(),
        reconciliationComplete: false,
      }),
    ),
    code("invalid_input"),
  );
  assert.equal(count(f, "server_rules_acceptances"), 0);
});

test("reaction seeding follows a durable verified POST and an uncertain seed reconciles without repeating either effect", async (t) => {
  const f = fixture(t),
    draft = f.draft({ method: "reaction", emoji: "✅" });
  const saved = await f.service.configure(actorId, "settings", 0, { enabled: true, draft });
  const version = await f.service.publish(actorId, "publish", saved.revision),
    seed = f.ports.seedReaction;
  let seedCalls = 0;
  f.ports.seedReaction = async (input) => {
    seedCalls++;
    const part = f.service.parts(version.id)[0];
    assert.equal(part.messageId, input.messageId);
    assert.equal(f.jobs.attempts(part.jobId)[0].state, "succeeded");
    await seed(input);
    throw Error("reaction response lost");
  };
  await run(f, "server-rules.publish-part");
  const { job, result } = await run(f, "server-rules.seed-reaction");
  assert.equal(result.state, "unknown");
  assert.equal(f.jobs.get(job.id).state, "unknown");
  assert.equal(f.service.settings().activeVersionId, null);
  const restarted = f.open(),
    r = { ...f, ...restarted };
  await restarted.service.reconcilePublication(actorId, version.id);
  await run(r, "server-rules.activate");
  assert.equal(f.sends.length, 1);
  assert.equal(seedCalls, 1);
  assert.equal(restarted.service.settings().activeVersionId, version.id);
});

test("OFF between POST verification and the seed PUT prevents the new reaction effect", async (t) => {
  const f = fixture(t),
    saved = await f.service.configure(actorId, "settings", 0, {
      enabled: true,
      draft: f.draft({ method: "reaction", emoji: "✅" }),
    });
  const version = await f.service.publish(actorId, "publish", saved.revision),
    message = f.ports.message;
  let seedCalls = 0,
    once = true;
  f.ports.seedReaction = async () => {
    seedCalls++;
  };
  f.ports.message = async (...args) => {
    if (once) {
      once = false;
      const current = f.service.settings();
      await f.service.configure(actorId, "off", current.revision, {
        enabled: false,
        draft: current.draft,
      });
    }
    return message(...args);
  };
  const [job] = f.jobs.claim({ types: ["server-rules.publish-part"] });
  await assert.rejects(f.service.execute(job, context(f, job)), code("stale_lease"));
  assert.equal(seedCalls, 0);
  assert.equal(f.sends.length, 1);
  assert.ok(f.service.parts(version.id)[0].messageId);
  assert.equal(f.jobs.attempts(job.id)[0].state, "succeeded");
});

test("duplicate execution of a claimed publication or grant cannot repeat its external effect", async (t) => {
  const f = fixture(t),
    settings = await f.service.configure(actorId, "settings", 0, {
      enabled: true,
      draft: f.draft(),
    });
  const version = await f.service.publish(actorId, "publish", settings.revision),
    [partJob] = f.jobs.claim({ types: ["server-rules.publish-part"] });
  const publications = await Promise.all([
    f.service.execute(partJob, context(f, partJob)),
    f.service.execute(partJob, context(f, partJob)),
  ]);
  assert.equal(f.sends.length, 1);
  assert.equal(publications.filter((result) => result.state === "succeeded").length, 1);
  f.jobs.complete(
    partJob.id,
    partJob.leaseToken,
    publications.find((result) => result.state === "succeeded"),
  );
  await run(f, "server-rules.activate");
  await f.service.accept(userId, event(f, version));
  const [grantJob] = f.jobs.claim({ types: ["server-rules.grant-role"] });
  await Promise.all([
    f.service.execute(grantJob, context(f, grantJob)),
    f.service.execute(grantJob, context(f, grantJob)),
  ]);
  assert.equal(f.grants.length, 1);
});

test("fresh permissions, lease cancellation and transient outages do not turn into membership absence or effects", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  await f.service.accept(userId, event(f, version));
  const [job] = f.jobs.claim({ types: ["server-rules.grant-role"] }),
    ctx = context(f, job);
  ctx.controller.abort();
  await assert.rejects(f.service.execute(job, ctx), code("stale_lease"));
  assert.equal(f.grants.length, 0);
  const network = Object.assign(new Error("retry later"), { status: 429 });
  f.ports.preflight = async () => {
    throw network;
  };
  await assert.rejects(f.service.accept(userId, event(f, version)), (error) => error === network);
  assert.equal(f.grants.length, 0);
  assert.equal(count(f, "server_rules_acceptances"), 1);
});

test("stale authority snapshots and missing native-gate evidence fail closed without inventing completion", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    preflight = f.ports.preflight,
    member = f.ports.member;
  f.ports.preflight = async () => ({ ...(await preflight()), observedAt: f.now() - 15001 });
  await assert.rejects(f.service.accept(userId, event(f, version)), code("permission_revoked"));
  f.ports.preflight = preflight;
  f.ports.member = async () => ({ ...(await member()), pending: undefined });
  await assert.rejects(f.service.accept(userId, event(f, version)), code("member_unavailable"));
  f.ports.member = async () => ({ ...(await member()), observedAt: f.now() + 1 });
  await assert.rejects(f.service.accept(userId, event(f, version)), code("permission_revoked"));
  assert.equal(count(f, "server_rules_acceptances"), 0);
});

test("a forged job cannot mark another acceptance blocked, and malformed queued payloads do not produce effects", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    accepted = await f.service.accept(userId, event(f, version));
  const [job] = f.jobs.claim({ types: ["server-rules.grant-role"] }),
    before = f.store.db.prepare("SELECT total_changes() n").get().n;
  const forged = { ...job, payload: { versionId: version.id, acceptanceId: "foreign" } };
  assert.equal((await f.service.execute(forged, context(f, job))).state, "failed");
  assert.equal(f.store.db.prepare("SELECT total_changes() n").get().n, before);
  assert.equal((await f.service.ownAcceptance(userId, accepted.id)).grantState, "pending");
  const malformed = f.jobs.enqueue({
    guildId,
    type: "server-rules.grant-role",
    payload: null,
    dueAt: f.now(),
    dedupeKey: "malformed",
  });
  const [bad] = f.jobs.claim({ types: ["server-rules.grant-role"] });
  assert.equal(bad.id, malformed.id);
  assert.deepEqual(await f.service.execute(bad, context(f, bad)), {
    state: "failed",
    error: "invalid_input",
  });
  assert.equal(f.grants.length, 0);
});

test("two guild databases cannot borrow a version, acceptance or job from each other", async (t) => {
  const a = fixture(t),
    b = fixture(t, otherGuild),
    version = await publish(a);
  const accepted = await a.service.accept(userId, event(a, version));
  const changes = b.store.db.prepare("SELECT total_changes() n").get().n;
  await assert.rejects(b.service.accept(userId, event(a, version)), code("invalid_input"));
  await assert.rejects(b.service.ownAcceptance(userId, accepted.id), code("not_found"));
  const [job] = a.jobs.claim({ types: ["server-rules.grant-role"] });
  assert.equal((await b.service.execute(job, context(a, job))).state, "failed");
  assert.equal(b.store.db.prepare("SELECT total_changes() n").get().n, changes);
  assert.equal(a.grants.length + b.grants.length, 0);
});

test("draft normalization rejects unknown fields, custom emoji and oversized content", () => {
  const base = { channelId, roleId, label: "1", content: "Zasady", method: "button", emoji: null };
  for (const patch of [
    { userId },
    { content: "x".repeat(12001) },
    { method: "reaction", emoji: "<:ok:100000000000000001>" },
    { label: "a\nb" },
  ])
    assert.throws(() => normalizeRulesDraft({ ...base, ...patch }), code("invalid_input"));
  const max = normalizeRulesDraft({
    ...base,
    label: "x".repeat(80),
    content: "x".repeat(12000),
    method: "reaction",
    emoji: "👨‍👩‍👧‍👦",
  });
  assert.ok(rulesParts(max).every((part) => part.length <= 2000));
});

test("a preflight which ages out during the final member fetch cannot authorize a now-unsafe role PUT", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  await f.service.accept(userId, event(f, version));
  const member = f.ports.member;
  let reads = 0;
  f.ports.member = async (...args) => {
    if (++reads === 2) {
      f.setNow(f.now() + 16000);
      f.preflight.roles[1].permissions = P.Administrator;
    }
    return member(...args);
  };
  const { result } = await run(f, "server-rules.grant-role");
  assert.deepEqual(result, { state: "failed", error: "permission_revoked" });
  assert.equal(f.grants.length, 0);
  assert.equal(count(f, "delivery_attempts"), f.sends.length);
});

test("queued publication, seed and activation refresh the original publisher's management authority", async (t) => {
  for (const stage of ["publish-part", "seed-reaction", "activate"]) {
    const f = fixture(t),
      draft = f.draft(stage === "seed-reaction" ? { method: "reaction", emoji: "✅" } : {});
    const settings = await f.service.configure(actorId, "settings", 0, { enabled: true, draft });
    await f.service.publish(actorId, "publish", settings.revision);
    if (stage !== "publish-part") await run(f, "server-rules.publish-part");
    let seedCalls = 0;
    f.ports.seedReaction = async () => {
      seedCalls++;
    };
    f.admin.owner = false;
    const { result } = await run(f, "server-rules." + stage);
    assert.deepEqual(result, { state: "failed", error: "permission_revoked" });
    assert.equal(f.sends.length, stage === "publish-part" ? 0 : 1);
    assert.equal(seedCalls, 0);
    assert.equal(f.service.settings().activeVersionId, null);
  }
});

function rateError(kind) {
  return kind === "http"
    ? { status: 429, rawError: { retry_after: 2.5 } }
    : new RateLimitError({
        timeToReset: 900,
        retryAfter: 1200,
        sublimitTimeout: 2500,
        limit: 1,
        method: "PUT",
        hash: "fixture",
        url: "https://discord.com/api/fixture",
        route: "/fixture",
        majorParameter: guildId,
        global: false,
        scope: "user",
      });
}

test("SDK and HTTP429 safely retry publication, one-role PUT and reaction seed in their own durable jobs", async (t) => {
  for (const kind of ["sdk", "http"])
    for (const stage of ["publish-part", "grant-role", "seed-reaction"]) {
      const f = fixture(t),
        draft = f.draft(stage === "seed-reaction" ? { method: "reaction", emoji: "✅" } : {});
      const settings = await f.service.configure(actorId, "settings", 0, { enabled: true, draft });
      const version = await f.service.publish(actorId, "publish", settings.revision);
      if (stage !== "publish-part") await run(f, "server-rules.publish-part");
      if (stage === "grant-role") {
        await run(f, "server-rules.activate");
        await f.service.accept(userId, event(f, version));
      }
      const portName =
        stage === "publish-part" ? "sendPart" : stage === "grant-role" ? "addRole" : "seedReaction";
      const effect = f.ports[portName];
      let calls = 0;
      f.ports[portName] = async (...args) => {
        if (++calls === 1) throw rateError(kind);
        return effect(...args);
      };
      const before = f.now(),
        first = await run(f, "server-rules." + stage);
      assert.equal(first.result.state, "retry");
      assert.equal(first.result.at, before + 2500);
      assert.equal(f.jobs.get(first.job.id).failures, 0);
      assert.equal(f.jobs.get(first.job.id).state, "retry");
      f.setNow(first.result.at);
      const retried = await run(f, "server-rules." + stage);
      assert.equal(retried.job.id, first.job.id);
      assert.equal(retried.result.state, "succeeded");
      assert.equal(calls, 2);
      assert.equal(f.sends.length, 1);
      assert.equal(f.grants.length, stage === "grant-role" ? 1 : 0);
      if (stage === "seed-reaction") {
        await run(f, "server-rules.activate");
        assert.equal(f.service.settings().activeVersionId, version.id);
      }
    }
});

test("408,5xx and network failures after role PUT begins remain unknown instead of automatic retry", async (t) => {
  for (const status of [408, 500, 503, null]) {
    const f = fixture(t),
      version = await publish(f);
    const accepted = await f.service.accept(userId, event(f, version));
    let calls = 0;
    f.ports.addRole = async () => {
      calls++;
      throw status === null ? Error("network") : { status };
    };
    const { result } = await run(f, "server-rules.grant-role");
    assert.equal(result.state, "unknown");
    assert.equal(f.jobs.get(accepted.jobId).state, "unknown");
    assert.equal(f.jobs.claim({ types: ["server-rules.grant-role"] }).length, 0);
    assert.equal((await f.service.reconcileGrant(userId, accepted.id)).grantState, "unknown");
    assert.equal(calls, 1);
  }
});

const day = 86400000;
const retention = (f) =>
  new ServerRulesRetention(f.jobs, { guildId: f.service.guildId, clock: f.now });
const observation = (f, presence, patch = {}) => ({
  guildId: f.service.guildId,
  userId,
  observedAt: f.now(),
  presence,
  ...patch,
});

test("consent is kept throughout membership, including module OFF, and local prune needs no Discord availability", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  await f.service.accept(userId, event(f, version));
  const settings = f.service.settings();
  await f.service.configure(actorId, "off", settings.revision, {
    enabled: false,
    draft: settings.draft,
  });
  f.setNow(f.now() + 40 * day);
  f.ports.member = async () => {
    throw Error("offline");
  };
  assert.equal(retention(f).prune().acceptancesRemoved, 0);
  assert.equal(count(f, "server_rules_acceptances"), 1);
});

test("the first verified departure survives restart and consent/member identifiers disappear at exactly30days", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    accepted = await f.service.accept(userId, event(f, version));
  const departedAt = f.now();
  assert.equal(retention(f).observe(observation(f, "absent")).departed, 1);
  f.setNow(f.now() + day);
  retention(f).observe(observation(f, "absent"));
  assert.equal(
    f.store.db.prepare("SELECT left_at FROM server_rules_memberships").get().left_at,
    departedAt,
  );
  f.store.close();
  const restarted = f.open(),
    r = { ...f, ...restarted };
  f.setNow(departedAt + 30 * day - 1);
  assert.equal(retention(r).prune().acceptancesRemoved, 0);
  f.setNow(f.now() + 1);
  assert.deepEqual(retention(r).prune(), {
    acceptancesRemoved: 1,
    membershipsRemoved: 1,
    jobsScrubbed: 1,
    fencesExpired: 0,
  });
  assert.equal(count(r, "server_rules_acceptances"), 0);
  assert.equal(count(r, "server_rules_memberships"), 0);
  const fence = r.store.db.prepare("SELECT * FROM server_rules_retired_acceptances").get();
  assert.deepEqual(Object.keys(fence).sort(), ["expires_at", "guild_id", "id", "retired_at"]);
  assert.equal(fence.id, accepted.id);
  for (const table of [
    "server_rules_acceptances",
    "server_rules_memberships",
    "server_rules_retired_acceptances",
    "jobs",
    "delivery_attempts",
    "idempotency_keys",
  ])
    assert.equal(
      JSON.stringify(r.store.db.prepare(`SELECT * FROM ${table}`).all()).includes(userId),
      false,
      table,
    );
  assert.equal(retention(r).prune().acceptancesRemoved, 0);
});

test("unknown, stale, future and outage membership proofs never start or postpone the departure clock", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  await f.service.accept(userId, event(f, version));
  const r = retention(f);
  for (const proof of [
    observation(f, "unknown"),
    observation(f, "absent", { observedAt: f.now() - 15001 }),
    observation(f, "absent", { observedAt: f.now() + 1 }),
  ])
    r.observe(proof);
  await r.reconcile(async () => {
    throw { status: 403 };
  });
  assert.equal(
    f.store.db.prepare("SELECT left_at FROM server_rules_memberships").get().left_at,
    null,
  );
  r.observe(observation(f, "absent"));
  const first = f.store.db.prepare("SELECT left_at FROM server_rules_memberships").get().left_at;
  f.setNow(f.now() + day);
  r.observe(observation(f, "unknown"));
  assert.equal(
    f.store.db.prepare("SELECT left_at FROM server_rules_memberships").get().left_at,
    first,
  );
});

test("bounded fresh REST reconciliation discovers a missed offline departure and cancels its old queued role", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    accepted = await f.service.accept(userId, event(f, version));
  let expected;
  const result = await retention(f).reconcile(
    async (id, joinedAt) => {
      assert.equal(id, userId);
      expected = joinedAt;
      return observation(f, "absent");
    },
    { limit: 1 },
  );
  assert.equal(expected, f.member.joinedAt);
  assert.deepEqual(result, { checked: 1, departed: 1, restored: 0, unknown: 0 });
  assert.equal(f.jobs.get(accepted.jobId).state, "cancelled");
  assert.equal(f.grants.length, 0);
});

test("a later verified presence of the same membership cancels an erroneous departure marker without resuming a grant", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    accepted = await f.service.accept(userId, event(f, version));
  const r = retention(f);
  r.observe(observation(f, "absent"));
  f.setNow(f.now() + 1000);
  assert.equal(r.observe(observation(f, "present", { joinedAt: f.member.joinedAt })).restored, 1);
  f.setNow(f.now() + 31 * day);
  assert.equal(r.prune().acceptancesRemoved, 0);
  assert.equal(f.jobs.get(accepted.jobId).state, "cancelled");
  assert.equal(f.grants.length, 0);
});

test("rejoin keeps a new explicit consent while retiring the old membership, and late old departure proofs cannot cancel it", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    old = await f.service.accept(userId, event(f, version));
  const r = retention(f),
    oldJoin = f.member.joinedAt,
    leftAt = f.now();
  r.observe(observation(f, "absent", { expectedJoinedAt: oldJoin }));
  f.setNow(f.now() + 1000);
  f.member.joinedAt = f.now();
  r.observe(observation(f, "present", { joinedAt: f.member.joinedAt }));
  const fresh = await f.service.accept(userId, event(f, version));
  r.observe(observation(f, "absent", { expectedJoinedAt: oldJoin }));
  assert.equal(f.jobs.get(fresh.jobId).state, "pending");
  await run(f, "server-rules.grant-role");
  f.setNow(leftAt + 30 * day);
  assert.equal(r.prune().acceptancesRemoved, 1);
  assert.equal((await f.service.listAcceptances(actorId))[0].id, fresh.id);
  assert.equal(
    f.store.db.prepare("SELECT 1 FROM server_rules_acceptances WHERE id=?").get(old.id),
    undefined,
  );
  assert.equal(f.grants.length, 1);
});

test("persisted reconciliation order advances past unavailable users and reaches every known membership", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    original = structuredClone(f.member);
  const ids = Array.from({ length: 8 }, (_, index) => String(100000000000000100n + BigInt(index)));
  for (const id of ids) {
    f.member = { ...structuredClone(original), userId: id };
    await f.service.accept(id, event(f, version));
  }
  const seen = [];
  for (let tick = 0; tick < 4; tick++) {
    f.setNow(f.now() + 1000);
    await retention(f).reconcile(
      async (id) => {
        seen.push(id);
        if (seen.length % 2) throw Error("outage");
        return observation(f, "unknown", { userId: id });
      },
      { limit: 2 },
    );
  }
  assert.deepEqual([...new Set(seen)].sort(), ids.sort());
  assert.equal(seen.length, 8);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) n FROM server_rules_memberships WHERE left_at IS NOT NULL")
      .get().n,
    0,
  );
});

test("a departed old cohort cannot monopolize reconciliation and starve a different member", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  await f.service.accept(userId, event(f, version));
  f.member.joinedAt += 1000;
  await f.service.accept(userId, event(f, version));
  const secondId = "100000000000000033";
  f.member.userId = secondId;
  await f.service.accept(secondId, event(f, version));
  const seen = [];
  for (let tick = 0; tick < 3; tick++) {
    f.setNow(f.now() + 1000);
    await retention(f).reconcile(
      async (id, expectedJoinedAt) => {
        seen.push(id);
        return observation(f, "absent", { userId: id, expectedJoinedAt });
      },
      { limit: 1 },
    );
  }
  assert.deepEqual(seen, [userId, secondId, userId]);
  assert.notEqual(
    f.store.db.prepare("SELECT left_at FROM server_rules_memberships WHERE user_id=?").get(secondId)
      .left_at,
    null,
  );
});

test("retiring unknown role work scrubs its identifiers while preserving uncertainty and blocking replay from an old row", async (t) => {
  const f = fixture(t),
    version = await publish(f),
    accepted = await f.service.accept(userId, event(f, version));
  f.ports.addRole = async () => {
    throw Error("unknown network effect");
  };
  await run(f, "server-rules.grant-role");
  const oldRow = f.store.db
    .prepare("SELECT * FROM server_rules_acceptances WHERE id=?")
    .get(accepted.id);
  retention(f).observe(observation(f, "absent"));
  f.setNow(f.now() + 30 * day);
  retention(f).prune();
  const oldJob = f.jobs.get(accepted.jobId);
  assert.equal(oldJob.state, "unknown");
  assert.equal(oldJob.cancelRequested, true);
  assert.deepEqual(oldJob.payload, {});
  assert.equal(oldJob.result, null);
  assert.equal(oldJob.dedupeKey.includes(userId), false);
  f.store.db
    .prepare(
      `INSERT INTO server_rules_acceptances VALUES(${Object.keys(oldRow)
        .map(() => "?")
        .join(",")})`,
    )
    .run(...Object.values(oldRow));
  assert.deepEqual(await f.service.listAcceptances(actorId), []);
  await assert.rejects(f.service.ownAcceptance(userId, accepted.id), code("not_found"));
  const replay = f.jobs.enqueue({
    guildId,
    type: "server-rules.grant-role",
    objectId: version.id,
    generation: version.generation,
    payload: { versionId: version.id, acceptanceId: accepted.id },
    dueAt: f.now(),
    dedupeKey: "old-row-replay",
  });
  const [job] = f.jobs.claim({ types: ["server-rules.grant-role"] });
  assert.equal(job.id, replay.id);
  assert.deepEqual(await f.service.execute(job, context(f, job)), {
    state: "failed",
    error: "not_found",
  });
  assert.equal(retention(f).prune().acceptancesRemoved, 1);
  assert.equal(count(f, "server_rules_acceptances"), 0);
  assert.equal(f.grants.length, 0);
});

test("opaque retired-operation fences expire after their bounded window without recreating old consent or resuming work", async (t) => {
  const f = fixture(t),
    version = await publish(f);
  await f.service.accept(userId, event(f, version));
  retention(f).observe(observation(f, "absent"));
  f.setNow(f.now() + 30 * day);
  retention(f).prune();
  const erasedAt = f.now();
  f.setNow(erasedAt + serverRulesRetentionPolicy.retiredAcceptanceFenceMs - 1);
  assert.equal(retention(f).prune().fencesExpired, 0);
  f.setNow(f.now() + 1);
  assert.equal(retention(f).prune().fencesExpired, 1);
  assert.equal(count(f, "server_rules_acceptances"), 0);
  assert.equal(f.jobs.claim({ types: ["server-rules.grant-role"] }).length, 0);
  assert.equal(f.grants.length, 0);
});

test("retention is guild scoped and an invalid foreign proof makes no database change", async (t) => {
  const a = fixture(t),
    b = fixture(t, otherGuild),
    av = await publish(a),
    bv = await publish(b);
  await a.service.accept(userId, event(a, av));
  await b.service.accept(userId, event(b, bv));
  const changes = b.store.db.prepare("SELECT total_changes() n").get().n;
  assert.throws(() => retention(b).observe(observation(a, "absent")), code("invalid_input"));
  retention(a).observe(observation(a, "absent"));
  a.setNow(a.now() + 30 * day);
  retention(a).prune();
  assert.equal(count(a, "server_rules_acceptances"), 0);
  assert.equal(count(b, "server_rules_acceptances"), 1);
  assert.equal(b.store.db.prepare("SELECT total_changes() n").get().n, changes);
});

test("retention limits acceptance work even when one membership accepted many versions", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 3; index++) {
    const version = await publish(f, f.draft({ label: String(index) }), "version-" + index);
    await f.service.accept(userId, event(f, version));
  }
  retention(f).observe(observation(f, "absent"));
  f.setNow(f.now() + 30 * day);
  for (let index = 0; index < 3; index++) {
    const result = retention(f).prune({ limit: 1 });
    assert.equal(result.acceptancesRemoved, 1);
    assert.equal(count(f, "server_rules_memberships"), index === 2 ? 0 : 1);
  }
});
