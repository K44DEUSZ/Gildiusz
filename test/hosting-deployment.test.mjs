import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { activateRelease, deploymentHealthy, install, waitReady } from "../scripts/hosting.mjs";

const guildIds = ["900000000000000001", "900000000000000002"];
const health = (patch = {}) => ({
  ready: true,
  degraded: false,
  rulesDeletionProof: { state: "ready" },
  guilds: guildIds.map((guildId) => ({ guildId, ready: true })),
  updated: Date.now(),
  ...patch,
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-code-deployment-")),
    previous = join(root, "releases", "a".repeat(40)),
    release = join(root, "releases", "b".repeat(40)),
    shared = join(root, "shared");
  for (const path of [previous, release, join(shared, "data"), join(shared, "logs")])
    mkdirSync(path, { recursive: true });
  const select = (target) => {
    if (existsSync(join(root, "current"))) unlinkSync(join(root, "current"));
    symlinkSync(target, join(root, "current"), process.platform === "win32" ? "junction" : "dir");
  };
  select(previous);
  const healthy = () => {
    const now = Date.now();
    writeFileSync(join(shared, "data/health.json"), JSON.stringify(health({ updated: now })));
    writeFileSync(
      join(shared, "supervisor.json"),
      JSON.stringify({
        release: basename(realpathSync(join(root, "current"))),
        started: now,
      }),
    );
  };
  healthy();
  // Any accidental use of the old backup path would fail on this invalid key and missing PC pin.
  writeFileSync(join(shared, "backup-key.env"), "deliberately-invalid");
  const baseline = {
      format: 1,
      policy: { guild: {}, hub: {} },
      databases: guildIds.map((guildId) => ({ guildId, schema: {} })),
      hub: null,
      source: { sourceId: "fixture", sequence: 5, active: [], retired: [] },
    },
    calls = [];
  const services = {
    inspect: async (target, quiescent) => {
      calls.push(["inspect", basename(target), quiescent]);
      return globalThis.structuredClone(baseline);
    },
    stop: async () => {
      calls.push(["stop"]);
    },
    start: async () => {
      calls.push(["start"]);
      healthy();
    },
    select: (target) => {
      calls.push(["select", basename(target)]);
      select(target);
    },
    wait: async (revision, after, ids) => {
      calls.push(["wait", revision]);
      assert.deepEqual(ids, guildIds);
      return waitReady(root, revision, after, ids, 50);
    },
    currentMain: async () => basename(release),
  };
  t.after(() => {
    unlinkSync(join(root, "current"));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, shared, previous, release, baseline, calls, services };
}

test("new code activates after live and stopped checks with no backup key, PC, snapshot or catalogue", async (t) => {
  const f = fixture(t);
  await activateRelease(f.root, f.release, f.services);
  assert.equal(realpathSync(join(f.root, "current")), f.release);
  assert.deepEqual(
    f.calls.filter(([name]) => name === "inspect"),
    [
      ["inspect", "a".repeat(40), false],
      ["inspect", "b".repeat(40), false],
      ["inspect", "b".repeat(40), true],
    ],
  );
  assert.equal(existsSync(join(f.shared, "backups")), false);
  assert.equal(existsSync(join(f.shared, "paused")), false);
  assert.equal(readFileSync(join(f.shared, "backup-key.env"), "utf8"), "deliberately-invalid");
});

test("live schema mismatch and pending legacy upgrade leave the old healthy worker untouched", async (t) => {
  const f = fixture(t),
    inspect = f.services.inspect;
  f.services.inspect = async (target, quiescent) => {
    const state = await inspect(target, quiescent);
    if (target === f.release) state.policy.guild = { migration: "new" };
    return state;
  };
  await assert.rejects(activateRelease(f.root, f.release, f.services), /operator review/);
  assert.equal(
    f.calls.some(([name]) => name === "stop"),
    false,
  );
  writeFileSync(join(f.shared, "pending-upgrade.json"), "malformed old pending");
  await assert.rejects(install(f.root, basename(f.release)), /Pending maintenance/);
  assert.equal(realpathSync(join(f.root, "current")), f.previous);
  assert.equal(
    deploymentHealthy(JSON.parse(readFileSync(join(f.shared, "data/health.json"))), guildIds),
    true,
  );
});

test("quiescent change is refused before selection and only verified old code resumes", async (t) => {
  const f = fixture(t),
    inspect = f.services.inspect;
  f.services.inspect = async (target, quiescent) => {
    const state = await inspect(target, quiescent);
    if (target === f.release && quiescent) state.source.sourceId = "changed";
    return state;
  };
  await assert.rejects(activateRelease(f.root, f.release, f.services), /previous code is healthy/);
  assert.equal(
    f.calls.some(([name]) => name === "select"),
    false,
  );
  assert.equal(existsSync(join(f.shared, "paused")), false);
});

test("even a dangling legacy pending entry cannot be ignored", async (t) => {
  const f = fixture(t),
    pending = join(f.shared, "pending-upgrade.json");
  symlinkSync(
    join(f.root, "missing-pending-target"),
    pending,
    process.platform === "win32" ? "junction" : "file",
  );
  try {
    assert.equal(existsSync(pending), false);
    await assert.rejects(install(f.root, "b".repeat(40)), /Pending maintenance/);
    assert.equal(
      f.calls.some(([name]) => name === "stop"),
      false,
    );
  } finally {
    unlinkSync(pending);
  }
});

test("failed candidate rolls code back without restoring current user data", async (t) => {
  const f = fixture(t),
    wait = f.services.wait,
    file = join(f.shared, "data/new-user-write.txt");
  f.services.wait = async (revision, after, ids) => {
    if (revision === basename(f.release)) {
      writeFileSync(file, "keep newer data");
      return false;
    }
    return wait(revision, after, ids);
  };
  await assert.rejects(activateRelease(f.root, f.release, f.services), /previous code is healthy/);
  assert.equal(realpathSync(join(f.root, "current")), f.previous);
  assert.equal(readFileSync(file, "utf8"), "keep newer data");
  assert.equal(readFileSync(join(f.shared, "failed-revision"), "utf8"), basename(f.release));
});

test("failed candidate with changed schema or source cannot roll code back", async (t) => {
  const f = fixture(t),
    inspect = f.services.inspect;
  let candidateRan = false;
  f.services.wait = async () => {
    candidateRan = true;
    return false;
  };
  f.services.inspect = async (target, quiescent) => {
    const state = await inspect(target, quiescent);
    if (candidateRan) state.source.sequence--;
    return state;
  };
  await assert.rejects(activateRelease(f.root, f.release, f.services), /rollback is not verified/);
  assert.equal(realpathSync(join(f.root, "current")), f.release);
  assert.equal(existsSync(join(f.shared, "paused")), true);
});

test("main advancing after package retrieval cannot select the stale release", async (t) => {
  const f = fixture(t);
  f.services.currentMain = async () => "c".repeat(40);
  await assert.rejects(activateRelease(f.root, f.release, f.services), /Main advanced/);
  assert.equal(
    f.calls.some(([name]) => name === "select"),
    false,
  );
  assert.equal(
    f.calls.some(([name]) => name === "stop"),
    false,
  );
});

test("main advancing during quiescence resumes only the verified previous release", async (t) => {
  const f = fixture(t);
  let checks = 0;
  f.services.currentMain = async () => (++checks === 1 ? "b".repeat(40) : "c".repeat(40));
  await assert.rejects(activateRelease(f.root, f.release, f.services), /previous code is healthy/);
  assert.equal(
    f.calls.some(([name]) => name === "select"),
    false,
  );
});

test("readiness requires exact guilds, fresh proof and no degradation", () => {
  const now = Date.now(),
    valid = health({ updated: now });
  assert.equal(deploymentHealthy(valid, guildIds, now, now), true);
  for (const patch of [
    { guilds: [] },
    { guilds: valid.guilds.slice(0, 1) },
    { guilds: [...valid.guilds, valid.guilds[0]] },
    { degraded: true },
    { rulesDeletionProof: { state: "blocked" } },
    { updated: now - 60001 },
    { updated: now + 1 },
    { guilds: valid.guilds.map((guild) => ({ ...guild, ready: false })) },
  ])
    assert.equal(deploymentHealthy({ ...valid, ...patch }, guildIds, now, now - 1000), false);
});
