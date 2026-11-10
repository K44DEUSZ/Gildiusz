import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ModuleSettingsStore,
  parseModuleSettings,
  newModules,
  parseCaseSettings,
  defaultCaseSettings,
} from "../dist/core/modules/settings.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { ControlError } from "../dist/control/contracts.js";

const guild = "100000000000000001",
  otherGuild = "100000000000000002";
const actor = "200000000000000001",
  role = "300000000000000001";
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  const jobs = new JobStore(db, () => 10000);
  t.after(() => db.close());
  return { db, jobs, settings: new ModuleSettingsStore(db, guild, () => 10000) };
}
const rejects = (work, code) =>
  assert.throws(work, (error) => error instanceof ControlError && error.code === code);

test("legacy module settings gain private approval defaults and the approved 90-day policy", (t) => {
  const f = fixture(t);
  const legacy = f.settings.read();
  delete legacy.cases;
  f.db
    .prepare("INSERT INTO guild_module_settings VALUES (?,?,?,?,?)")
    .run(guild, 3, JSON.stringify(legacy), actor, 10000);
  const value = f.settings.read();
  assert.equal(value.revision, 3);
  assert.equal(value.cases.categoryId, "");
  assert.equal(value.cases.suggestionVisibility, "approval");
  assert.equal(value.cases.voting.enabled, false);
  assert.equal(value.cases.retentionMs, 90 * 86400000);
  value.cases.voting.statuses.length = 0;
  assert.deepEqual(f.settings.read().cases.voting.statuses, ["new", "in_review"]);
});

test("old retention preferences cannot disable or lengthen the service's fixed 90-day policy", () => {
  for (const retentionMs of [null, 86400000, 90 * 86400000, 366 * 86400000])
    assert.equal(
      parseCaseSettings({ ...defaultCaseSettings(), retentionMs }).retentionMs,
      90 * 86400000,
    );
});

test("case settings reject coercion, foreign fields, sparse states and unbounded retention without a write", (t) => {
  const f = fixture(t);
  const initial = f.settings.read();
  for (const patch of [
    { suggestionVisibility: { toString: () => "approval" } },
    { categoryId: "../other" },
    { retentionMs: 0 },
    { retentionMs: 367 * 86400000 },
    { purgeImmediately: true },
    { voting: { enabled: true, statuses: ["closed"] } },
    { voting: { enabled: true, statuses: Object.assign(Array(2), { 1: "new" }) } },
  ])
    rejects(
      () => f.settings.save({ ...initial, cases: { ...initial.cases, ...patch } }, actor),
      patch.categoryId !== undefined
        ? "cases_channel"
        : patch.retentionMs !== undefined
          ? "cases_retention"
          : "cases_settings",
    );
  assert.deepEqual(f.settings.read(), initial);
  const chosen = { ...initial, cases: { ...initial.cases, retentionMs: 90 * 86400000 } };
  assert.equal(f.settings.save(chosen, actor).cases.retentionMs, 90 * 86400000);
});

test("new module settings are disabled without persistent writes and reads do not share mutable defaults", (t) => {
  const f = fixture(t),
    first = f.settings.read();
  assert.deepEqual(first.enabled, Object.fromEntries(newModules.map((key) => [key, false])));
  assert.equal(first.revision, 0);
  assert.equal(first.timeZone, "Europe/Warsaw");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM guild_module_settings").get().count, 0);
  first.enabled.music = true;
  first.organizerRoleIds.push(role);
  assert.equal(f.settings.read().enabled.music, false);
  assert.deepEqual(f.settings.read().organizerRoleIds, []);
});

test("settings use revision CAS, record the actor and remain isolated between guilds sharing one database", (t) => {
  const f = fixture(t),
    other = new ModuleSettingsStore(f.db, otherGuild, () => 10001);
  const draft = f.settings.read();
  draft.enabled.announcements = true;
  draft.organizerRoleIds = [role];
  const saved = f.settings.save(draft, actor);
  assert.equal(saved.revision, 1);
  rejects(() => f.settings.save(draft, actor), "conflict");
  assert.deepEqual(other.read().enabled, Object.fromEntries(newModules.map((key) => [key, false])));
  const otherSaved = other.save(other.read(), actor);
  assert.equal(otherSaved.revision, 1);
  assert.equal(f.settings.read().enabled.announcements, true);
  const row = f.db
    .prepare("SELECT actor,updated_at FROM guild_module_settings WHERE guild_id=?")
    .get(guild);
  assert.deepEqual({ ...row }, { actor, updated_at: 10000 });
  saved.enabled.music = true;
  saved.organizerRoleIds.push("300000000000000002");
  assert.equal(f.settings.read().enabled.music, false);
  assert.deepEqual(f.settings.policy().organizerRoleIds, [role]);
});

test("unknown fields, modules, missing fields and inherited input are rejected", (t) => {
  const f = fixture(t),
    baseline = f.settings.read();
  for (const draft of [
    null,
    [],
    { ...baseline, admin: true },
    { ...baseline, enabled: { ...baseline.enabled, unknown: true } },
    { ...baseline, enabled: [] },
    { ...baseline, allowMemberMusic: "true" },
  ])
    rejects(() => parseModuleSettings(draft), "module_settings");
  const missing = { ...baseline };
  delete missing.timeZone;
  rejects(() => parseModuleSettings(missing), "module_settings");
  rejects(() => parseModuleSettings(Object.create(baseline)), "module_settings");
  rejects(
    () => parseModuleSettings({ ...baseline, enabled: Object.create(baseline.enabled) }),
    "module_settings",
  );
  const missingModule = { ...baseline.enabled };
  delete missingModule.music;
  rejects(() => parseModuleSettings({ ...baseline, enabled: missingModule }), "module_settings");
  const nullPrototype = Object.assign(Object.create(null), baseline);
  assert.deepEqual(parseModuleSettings(nullPrototype), baseline);
});

test("role lists reject duplicates, sparse arrays, wrong IDs and excessive membership", (t) => {
  const f = fixture(t),
    baseline = f.settings.read();
  for (const field of [
    "organizerRoleIds",
    "caseModeratorRoleIds",
    "announcementManagerRoleIds",
    "djRoleIds",
  ])
    for (const values of [
      [role, role],
      ["bad-role"],
      [1],
      [null],
      new Array(1),
      role,
      Array.from({ length: 21 }, (_, index) => String(300000000000000001n + BigInt(index))),
    ])
      rejects(() => parseModuleSettings({ ...baseline, [field]: values }), "roles");
  assert.deepEqual(
    parseModuleSettings({ ...baseline, organizerRoleIds: [role], djRoleIds: [role] }).djRoleIds,
    [],
  );
});

test("legacy music preferences cannot reactivate playback or retain DJ access", (t) => {
  const f = fixture(t),
    legacy = f.settings.read();
  legacy.enabled.music = true;
  legacy.allowMemberMusic = true;
  legacy.djRoleIds = [role];
  f.db
    .prepare("INSERT INTO guild_module_settings VALUES (?,?,?,?,?)")
    .run(guild, 4, JSON.stringify(legacy), actor, 10000);
  const current = f.settings.read();
  assert.equal(current.revision, 4);
  assert.equal(current.enabled.music, false);
  assert.equal(current.allowMemberMusic, false);
  assert.deepEqual(current.djRoleIds, []);
  rejects(() => f.settings.save(legacy, actor), "module_unavailable");
  assert.equal(f.settings.read().revision, 4);
  assert.equal(f.settings.save(current, actor).revision, 5);
});

test("timezone validation requires a supported named IANA zone rather than an offset or host default", (t) => {
  const f = fixture(t),
    baseline = f.settings.read();
  for (const timeZone of [
    "",
    "Not/A_Zone",
    "Europe/Warsaw ",
    "+01:00",
    "-05:00",
    "Europe/Warsaw\0",
    null,
    1,
  ])
    rejects(() => parseModuleSettings({ ...baseline, timeZone }), "timezone");
  for (const timeZone of ["UTC", "Europe/Warsaw", "America/New_York", "Etc/GMT+1"])
    assert.equal(parseModuleSettings({ ...baseline, timeZone }).timeZone, timeZone);
});

test("revision overflow is rejected without corrupting the last readable revision", (t) => {
  const f = fixture(t),
    baseline = f.settings.read();
  for (const revision of [
    -1,
    1.2,
    NaN,
    Infinity,
    "0",
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    rejects(() => parseModuleSettings({ ...baseline, revision }), "module_settings");
  f.settings.save(baseline, actor);
  f.db
    .prepare("UPDATE guild_module_settings SET revision=? WHERE guild_id=?")
    .run(Number.MAX_SAFE_INTEGER - 2, guild);
  const saved = f.settings.save(f.settings.read(), actor);
  assert.equal(saved.revision, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(f.settings.read().revision, saved.revision);
  rejects(() => f.settings.save(saved, actor), "revision_exhausted");
  assert.equal(f.settings.read().revision, saved.revision);
});

test("invalid actor, guild and clock cannot write settings", (t) => {
  const f = fixture(t),
    baseline = f.settings.read();
  for (const invalid of ["", "../guild", actor + "x", 123, null, "1".repeat(21)]) {
    rejects(() => new ModuleSettingsStore(f.db, invalid), "guild");
    rejects(() => f.settings.save(baseline, invalid), "actor");
  }
  for (const value of [NaN, Infinity, -1, 1.5])
    rejects(() => new ModuleSettingsStore(f.db, guild, () => value).save(baseline, actor), "clock");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM guild_module_settings").get().count, 0);
});

test("nested settings writes roll back with jobs and idempotency while replaying a successful request exactly", (t) => {
  const f = fixture(t),
    draft = f.settings.read();
  draft.enabled.announcements = true;
  assert.throws(() =>
    f.jobs.idempotent("settings", "request-one", draft, () => {
      f.settings.save(draft, actor);
      f.jobs.enqueue({
        guildId: guild,
        type: "announcement.send",
        payload: {},
        dueAt: 10000,
        dedupeKey: "one",
      });
      throw Error("rollback all operations");
    }),
  );
  assert.equal(f.settings.read().revision, 0);
  assert.equal(f.jobs.list().length, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get().count, 0);
  let calls = 0;
  const work = () => {
    calls++;
    return f.settings.save(draft, actor);
  };
  const saved = f.jobs.idempotent("settings", "request-one", draft, work);
  assert.deepEqual(f.jobs.idempotent("settings", "request-one", draft, work), saved);
  assert.equal(calls, 1);
  assert.equal(f.settings.read().revision, 1);
  assert.throws(
    () => f.jobs.idempotent("settings", "request-one", { ...draft, timeZone: "UTC" }, work),
    (error) => error.code === "idempotency_conflict",
  );
  assert.equal(f.settings.read().revision, 1);
});
