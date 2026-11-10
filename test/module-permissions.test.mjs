import test from "node:test";
import assert from "node:assert/strict";
import {
  canPerform,
  permissionDecision,
  requirePermission,
  ModulePermissionError,
  moduleActions,
} from "../dist/core/permissions.js";

const guild = "100000000000000001",
  otherGuild = "100000000000000002";
const author = "200000000000000001",
  visitor = "200000000000000002",
  moderator = "200000000000000003";
const organizerRole = "300000000000000001",
  staffRole = "300000000000000002",
  announcementRole = "300000000000000003",
  djRole = "300000000000000004";
const channel = "400000000000000001",
  otherChannel = "400000000000000002";
const facts = (userId = visitor, patch = {}) => ({
  guildId: guild,
  userId,
  owner: false,
  manageGuild: false,
  roleIds: [],
  pending: false,
  timedOut: false,
  isBot: false,
  voiceChannelId: null,
  ...patch,
});
const policy = {
  guildId: guild,
  organizerRoleIds: [organizerRole],
  caseModeratorRoleIds: [staffRole],
  announcementManagerRoleIds: [announcementRole],
  djRoleIds: [djRole],
  allowMemberMusic: true,
};
const meeting = { guildId: guild, ownerId: author, visibility: "public", state: "open" };
const privateCase = {
  guildId: guild,
  ownerId: author,
  kind: "report",
  visibility: "private",
  state: "new",
};
const suggestion = {
  ...privateCase,
  kind: "suggestion",
  visibility: "public",
  votingEnabled: true,
};
const music = { guildId: guild, ownerId: author, voiceChannelId: channel, state: "playing" };

test("server rules configuration and acceptance history require a current guild administrator", () => {
  const actions = [
    "rules.read",
    "rules.configure",
    "rules.publish",
    "rules.acceptances.list",
    "rules.publications.reconcile",
  ];
  for (const action of actions) {
    assert.equal(canPerform(action, facts(visitor), policy), false);
    assert.equal(
      canPerform(
        action,
        facts(moderator, { roleIds: [staffRole, announcementRole, organizerRole, djRole] }),
        policy,
      ),
      false,
    );
    assert.equal(canPerform(action, facts(author, { owner: true }), policy), true);
    assert.equal(canPerform(action, facts(author, { manageGuild: true }), policy), true);
    for (const patch of [
      { pending: true },
      { timedOut: true },
      { isBot: true },
      { guildId: otherGuild },
    ])
      assert.equal(canPerform(action, facts(author, { owner: true, ...patch }), policy), false);
  }
  assert.equal(canPerform("rules.accept", facts(author, { owner: true }), policy), false);
});

test("unknown operations, malformed facts and missing bound objects fail closed", () => {
  for (const action of [
    "music.actions",
    "cases.deleteEverything",
    "constructor",
    "",
    "settings.destroy",
  ])
    assert.equal(permissionDecision(action, facts(), policy).code, "unknown_action");
  assert.equal(
    permissionDecision("settings.save", facts(visitor, { manageGuild: "true" }), policy).code,
    "invalid_member",
  );
  assert.equal(
    permissionDecision("settings.save", facts(visitor, { manageGuild: true }), {
      ...policy,
      djRoleIds: "everyone",
    }).code,
    "invalid_policy",
  );
  for (const action of [
    "meetings.cancel",
    "cases.read",
    "cases.note",
    "announcements.update",
    "music.stop",
    "jobs.retry",
  ])
    assert.equal(
      permissionDecision(action, facts(visitor, { owner: true }), policy).code,
      "object_required",
    );
});

test("a valid object identifier or elevated role never crosses guild boundaries", () => {
  const admin = facts(visitor, { owner: true });
  for (const action of [
    "cases.read",
    "cases.note",
    "meetings.cancel",
    "announcements.update",
    "jobs.retry",
    "music.stop",
  ])
    assert.equal(
      permissionDecision(action, admin, policy, { ...privateCase, guildId: otherGuild }).code,
      "guild_mismatch",
    );
  assert.equal(
    permissionDecision("settings.save", { ...admin, guildId: otherGuild }, policy).code,
    "guild_mismatch",
  );
});

test("pending, timed-out and bot accounts cannot operate modules even with management flags", () => {
  for (const patch of [{ pending: true }, { timedOut: true }, { isBot: true }]) {
    const member = facts(visitor, { manageGuild: true, voiceChannelId: channel, ...patch });
    for (const action of [
      "settings.save",
      "meetings.create",
      "cases.read",
      "announcements.create",
      "music.vote",
    ])
      assert.equal(permissionDecision(action, member, policy, music).code, "ineligible_member");
  }
});

test("configuration, integrations and raw job diagnostics are restricted to current server managers", () => {
  const specialist = facts(visitor, {
    roleIds: [organizerRole, staffRole, announcementRole, djRole],
  });
  for (const action of [
    "settings.read",
    "settings.save",
    "integrations.create",
    "integrations.read",
    "jobs.list",
    "jobs.retry",
    "deliveries.list",
  ]) {
    assert.equal(canPerform(action, specialist, policy, { guildId: guild }), false);
    assert.equal(
      canPerform(action, facts(visitor, { manageGuild: true }), policy, { guildId: guild }),
      true,
    );
    assert.equal(
      canPerform(action, facts(visitor, { owner: true }), policy, { guildId: guild }),
      true,
    );
  }
});

test("ordinary members join eligible meetings while organizer and creator authority remain distinct", () => {
  assert.equal(canPerform("meetings.create", facts(), policy), false);
  assert.equal(
    canPerform("meetings.create", facts(visitor, { roleIds: [organizerRole] }), policy),
    true,
  );
  assert.equal(canPerform("meetings.join", facts(), policy, meeting), true);
  assert.equal(canPerform("meetings.cancel", facts(), policy, meeting), false);
  assert.equal(canPerform("meetings.cancel", facts(author), policy, meeting), true);
  assert.equal(
    canPerform("meetings.start", facts(moderator, { roleIds: [organizerRole] }), policy, meeting),
    true,
  );
  assert.equal(
    canPerform("meetings.join", facts(), policy, { ...meeting, state: "completed" }),
    false,
  );
  assert.equal(
    canPerform("meetings.join", facts(), policy, { ...meeting, state: undefined }),
    false,
  );
  assert.equal(
    canPerform("meetings.read", facts(), policy, { ...meeting, ownerId: undefined }),
    false,
  );
});

test("private meetings and drafts require ownership, organizer authority or a current participant binding", () => {
  const privateMeeting = { ...meeting, visibility: "private", participantIds: [moderator] };
  assert.equal(canPerform("meetings.read", facts(), policy, privateMeeting), false);
  assert.equal(canPerform("meetings.join", facts(moderator), policy, privateMeeting), true);
  assert.equal(canPerform("meetings.read", facts(), policy, { ...meeting, state: "draft" }), false);
  assert.equal(
    canPerform("meetings.read", facts(author), policy, { ...meeting, state: "draft" }),
    true,
  );
  assert.equal(
    canPerform("meetings.read", facts(), policy, { ...meeting, visibility: undefined }),
    false,
  );
});

test("private cases belong to their author and staff; public case metadata cannot turn a report public", () => {
  assert.equal(canPerform("cases.read", facts(), policy, privateCase), false);
  assert.equal(canPerform("cases.reply", facts(author), policy, privateCase), true);
  assert.equal(
    canPerform("cases.read", facts(moderator, { roleIds: [staffRole] }), policy, privateCase),
    true,
  );
  assert.equal(canPerform("cases.read", facts(), policy, suggestion), true);
  assert.equal(
    canPerform("cases.read", facts(), policy, { ...privateCase, visibility: "public" }),
    false,
  );
  assert.equal(
    canPerform("cases.read", facts(), policy, { ...suggestion, kind: undefined }),
    false,
  );
  assert.equal(
    canPerform("cases.read", facts(), policy, { ...suggestion, ownerId: undefined }),
    false,
  );
});

test("case authors cannot read internal notes or assign/transition their own case", () => {
  for (const action of ["cases.note", "cases.assign", "cases.transition"]) {
    assert.equal(canPerform(action, facts(author), policy, privateCase), false);
    assert.equal(
      canPerform(action, facts(moderator, { roleIds: [staffRole] }), policy, privateCase),
      true,
    );
  }
  assert.equal(canPerform("cases.note", facts(), policy, suggestion), false);
});

test("voting requires a published suggestion with explicit voting enabled and an open state", () => {
  assert.equal(canPerform("cases.vote", facts(), policy, suggestion), true);
  for (const patch of [
    { votingEnabled: false },
    { votingEnabled: undefined },
    { visibility: "private" },
    { state: "closed" },
    { state: "rejected" },
    { state: "implemented" },
    { state: undefined },
  ])
    assert.equal(canPerform("cases.vote", facts(), policy, { ...suggestion, ...patch }), false);
});

test("revoked operational roles remove access; authorship alone does not preserve recurring announcement authority", () => {
  assert.equal(
    canPerform("announcements.create", facts(author, { roleIds: [announcementRole] }), policy),
    true,
  );
  for (const action of [
    "announcements.list",
    "announcements.preview",
    "announcements.update",
    "announcements.resume",
    "announcements.test",
  ]) {
    assert.equal(
      canPerform(action, facts(author), policy, { guildId: guild, ownerId: author }),
      false,
    );
    assert.equal(
      canPerform(action, facts(author, { roleIds: [announcementRole] }), policy, {
        guildId: guild,
        ownerId: author,
      }),
      true,
    );
  }
  assert.equal(canPerform("meetings.create", facts(moderator), policy), false);
  assert.equal(canPerform("cases.read", facts(moderator), policy, privateCase), false);
});

test("ordinary playback cannot move or replace a session in another channel, even implicitly for an administrator", () => {
  assert.equal(canPerform("music.play", facts(visitor, { voiceChannelId: channel }), policy), true);
  assert.equal(canPerform("music.play", facts(), policy), false);
  assert.equal(
    canPerform("music.join", facts(visitor, { voiceChannelId: channel }), {
      ...policy,
      allowMemberMusic: false,
    }),
    false,
  );
  for (const member of [
    facts(visitor, { voiceChannelId: otherChannel }),
    facts(author, { manageGuild: true, voiceChannelId: otherChannel }),
  ])
    assert.equal(
      permissionDecision("music.play", member, policy, music).code,
      "different_voice_channel",
    );
  assert.equal(
    canPerform("music.play", facts(visitor, { voiceChannelId: channel }), policy, music),
    true,
  );
});

test("music votes require a current human in the active channel while destructive controls require host or DJ", () => {
  assert.equal(
    canPerform("music.vote", facts(visitor, { voiceChannelId: channel }), policy, music),
    true,
  );
  for (const member of [
    facts(visitor),
    facts(visitor, { manageGuild: true, voiceChannelId: otherChannel }),
    facts(visitor, { voiceChannelId: channel, isBot: true }),
  ])
    assert.equal(canPerform("music.vote", member, policy, music), false);
  for (const action of ["music.pause", "music.resume", "music.skip", "music.stop", "music.move"]) {
    assert.equal(
      canPerform(action, facts(visitor, { voiceChannelId: channel }), policy, music),
      false,
    );
    assert.equal(canPerform(action, facts(author), policy, music), true);
    assert.equal(canPerform(action, facts(visitor, { roleIds: [djRole] }), policy, music), true);
    assert.equal(canPerform(action, facts(visitor, { manageGuild: true }), policy, music), true);
  }
  assert.equal(
    canPerform("music.stop", facts(author), policy, { ...music, voiceChannelId: undefined }),
    false,
  );
  for (const state of ["completed", "stopped", undefined])
    assert.equal(
      canPerform("music.vote", facts(visitor, { voiceChannelId: channel }), policy, {
        ...music,
        state,
      }),
      false,
    );
});

test("requirePermission provides a typed rejection and every declared action has an explicit policy path", () => {
  assert.throws(
    () => requirePermission("cases.read", facts(), policy, privateCase),
    (error) => error instanceof ModulePermissionError && error.code === "forbidden",
  );
  assert.doesNotThrow(() => requirePermission("cases.read", facts(author), policy, privateCase));
  const admin = facts(author, { owner: true, voiceChannelId: channel });
  const objects = { ...music, ...suggestion, participantIds: [author], state: "open" };
  for (const action of moduleActions)
    assert.equal(
      permissionDecision(action, admin, policy, action.startsWith("music.") ? music : objects)
        .allowed,
      true,
      action,
    );
});
