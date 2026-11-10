import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../dist/storage/store.js";
import { PublicInstallations } from "../dist/control/installations.js";
import { acquireLock } from "../dist/storage/lock.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import { initializeRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import {
  openRulesDeletionLifecycle,
  rulesDeletionInstallationKey,
} from "../dist/storage/rules-deletion-lifecycle.js";
import {
  rulesDeletionLifecycleCommand,
  parseRulesDeletionLifecycleArguments,
} from "../scripts/rules-deletion-lifecycle.mjs";

const A = "100000000000000001",
  B = "200000000000000001",
  owner = "300000000000000001";
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-lifecycle-cli-"));
  const dataRoot = join(directory, "data");
  mkdirSync(dataRoot, { mode: 0o700 });
  const registry = new PublicInstallations(join(dataRoot, "guilds"));
  registry.add(A, owner);
  registry.add(B, owner);
  const installations = registry.values();
  for (const i of installations) {
    const store = new Store(i.databasePath, i.guildId);
    chmodSync(dirname(store.path), 0o700);
    store.putResource("existing-work", "test", i.guildId, { keep: true });
    store.close();
  }
  const initial = await initializeRulesDeletionJournal({ dataRoot, installations });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const values = {
    HEALTH_PATH: join(dataRoot, "health.json"),
    CONTROL_DATA_DIR: join(dataRoot, "guilds"),
    PUBLIC_INSTALLS: "0",
  };
  const file = join(dataRoot, "rules-acceptance-deletions", "journal.json");
  return { directory, dataRoot, registry, installations, initial, values, file };
}

test("operator status does not upgrade; explicit upgrade preserves existing work and source coverage", async (t) => {
  const f = await fixture(t),
    before = readFileSync(f.file);
  assert.deepEqual(await rulesDeletionLifecycleCommand("status", {}, f.values), {
    format: 1,
    state: "upgrade_required",
    journalFormat: 1,
  });
  assert.deepEqual(readFileSync(f.file), before);
  await assert.rejects(rulesDeletionLifecycleCommand("upgrade", {}, f.values), /requires --apply/);
  assert.deepEqual(readFileSync(f.file), before);
  const upgraded = await rulesDeletionLifecycleCommand("upgrade", { apply: true }, f.values);
  assert.equal(upgraded.state, "ready");
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.sourceId, f.initial.sourceId);
  assert.equal(upgraded.coveredFrom, f.initial.coveredFrom);
  assert.equal(upgraded.activeGuilds, 2);
  assert.equal(upgraded.retainedDecisions, 0);
  const after = readFileSync(f.file),
    status = await rulesDeletionLifecycleCommand("status", {}, f.values);
  assert.equal(status.sequence, upgraded.sequence);
  assert.deepEqual(readFileSync(f.file), after);
  for (const i of f.installations) {
    const store = new Store(i.databasePath, i.guildId);
    try {
      assert.deepEqual(JSON.parse(store.resource("existing-work").baseline), { keep: true });
      assert.ok(store.resource(rulesDeletionInstallationKey));
    } finally {
      store.close();
    }
  }
});

test("operator recovery resumes the original durable upgrade intents without recreating a source", async (t) => {
  const f = await fixture(t),
    releases = [await acquireDataRootLease(f.dataRoot)];
  try {
    for (const i of f.installations)
      releases.push(await acquireLock(i.databasePath, { createTarget: false }));
    const port = openRulesDeletionLifecycle({
      dataRoot: f.dataRoot,
      readCanonicalInstallations: () => f.installations,
      ownership: { assertHeld() {}, assertGuildLease() {}, assertQuiescent() {} },
    });
    await assert.rejects(
      port.upgradeFormat1({
        checkFence: () => true,
        checkpoint(stage) {
          if (stage === "intents_durable") throw Error("simulated_crash");
        },
      }),
      /simulated_crash/,
    );
  } finally {
    for (const release of releases.reverse()) await release();
  }
  const pending = JSON.parse(readFileSync(f.file, "utf8"));
  assert.equal(pending.admitting.length, 2);
  const epochs = pending.admitting.map((i) => i.epoch).sort();
  await assert.rejects(
    rulesDeletionLifecycleCommand("upgrade", { apply: true }, f.values),
    (e) => e.code === "upgrade_recovery_required",
  );
  const recovered = await rulesDeletionLifecycleCommand("recover", { apply: true }, f.values);
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.admissions, 2);
  assert.equal(recovered.retirementsPending, 0);
  const done = JSON.parse(readFileSync(f.file, "utf8"));
  assert.deepEqual(done.active.map((i) => i.epoch).sort(), epochs);
  assert.equal(done.sourceId, f.initial.sourceId);
  assert.equal(done.coveredFrom, f.initial.coveredFrom);
});

test("operator upgrade refuses an active writer and never creates a missing historical database", async (t) => {
  const f = await fixture(t),
    release = await acquireDataRootLease(f.dataRoot),
    before = readFileSync(f.file);
  try {
    await assert.rejects(
      rulesDeletionLifecycleCommand("upgrade", { apply: true }, f.values),
      (e) => e.code === "writer_active",
    );
  } finally {
    await release();
  }
  assert.deepEqual(readFileSync(f.file), before);
  unlinkSync(f.installations[0].databasePath);
  await assert.rejects(rulesDeletionLifecycleCommand("upgrade", { apply: true }, f.values));
  assert.equal(existsSync(f.installations[0].databasePath), false);
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(existsSync(join(f.dataRoot, "uninstall-retention", "source-policy.json")), false);
});

test("operator scope cannot silently omit a configured guild from the existing source", async (t) => {
  const f = await fixture(t),
    before = readFileSync(f.file);
  f.registry.remove(B);
  await assert.rejects(
    rulesDeletionLifecycleCommand("upgrade", { apply: true }, f.values),
    (e) => e.code === "inventory_changed",
  );
  assert.deepEqual(readFileSync(f.file), before);
});

test("operator arguments reject secrets, target overrides, conflicting or duplicated mutation flags", async () => {
  for (const args of [
    [],
    ["upgrade", "--key=private"],
    ["upgrade", "--apply", "--apply"],
    ["status", "--target"],
    ["recover", "--guild"],
  ])
    assert.throws(() => parseRulesDeletionLifecycleArguments(args));
  for (const [command, options] of [
    ["status", { apply: true }],
    ["upgrade", { key: "private" }],
    ["recover", { apply: false }],
    ["initialize", { apply: true }],
  ])
    await assert.rejects(rulesDeletionLifecycleCommand(command, options, {}));
});
