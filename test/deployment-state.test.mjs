import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  cpSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { activateRelease, waitReady } from "../scripts/hosting.mjs";
import { prepareRuntimePackage } from "../scripts/build-package.mjs";
import { Store } from "../dist/storage/store.js";
import { transaction } from "../dist/storage/migrations.js";
import { acquireDataRootLease } from "../dist/storage/recovery/lease.js";
import { initializeRulesDeletionJournal } from "../dist/storage/rules-deletion-journal.js";
import { upgradeRulesDeletionLifecycle } from "../dist/storage/rules-deletion-lifecycle.js";
import { recordRulesDeletion } from "../dist/modules/server-rules/deletion-outbox.js";
import { currentRecoverySchemaPolicy } from "../dist/storage/recovery/schema.js";
import { inspectDeploymentState, assertSameDeploymentState } from "../scripts/deployment-state.mjs";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-deployment-state-")),
    dataRoot = join(root, "data"),
    guildId = "900000000000000001";
  mkdirSync(dataRoot, { mode: 0o700 });
  const databasePath = join(dataRoot, "guild.sqlite"),
    installations = [{ guildId, databasePath }];
  const store = new Store(databasePath, guildId);
  store.close();
  await initializeRulesDeletionJournal({ dataRoot, installations });
  await upgradeRulesDeletionLifecycle({ dataRoot, installations });
  const values = {
    DISCORD_GUILD_ID: guildId,
    OWNER_USER_ID: "900000000000000002",
    DATABASE_PATH: databasePath,
    HEALTH_PATH: join(dataRoot, "health.json"),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dataRoot,
    guildId,
    databasePath,
    values,
    inspect: (options) => inspectDeploymentState(options, values),
  };
}

test("deployment inspections leave database, journal, source policy and backup storage unchanged", async (t) => {
  const f = await fixture(t),
    files = [
      f.databasePath,
      join(f.dataRoot, "rules-acceptance-deletions/journal.json"),
      join(f.dataRoot, "uninstall-retention/source-policy.json"),
    ],
    before = files.map((file) => readFileSync(file));
  const live = await f.inspect(),
    stopped = await f.inspect({ quiescent: true });
  assertSameDeploymentState(live, stopped);
  assert.equal(live.databases[0].schema.migrations.length, 13);
  for (const [index, file] of files.entries()) assert.deepEqual(readFileSync(file), before[index]);
  assert.equal(existsSync(join(f.root, "backups")), false);
  assert.equal(existsSync(join(f.dataRoot, "source.gldbak")), false);
});

test("live gate is read only while the worker lease is held; stopped gate requires quiescence", async (t) => {
  const f = await fixture(t),
    release = await acquireDataRootLease(f.dataRoot);
  try {
    await f.inspect();
    await assert.rejects(f.inspect({ quiescent: true }), (error) => error.code === "writer_active");
  } finally {
    await release();
  }
});

test("same migration number cannot hide altered SQL or checksums", async (t) => {
  const f = await fixture(t),
    policy = currentRecoverySchemaPolicy();
  policy.guild.migrations[0].checksum = "0".repeat(64);
  await assert.rejects(f.inspect({ policy }), /cannot migrate or downgrade/);
  const store = new Store(f.databasePath, f.guildId);
  store.db.exec("CREATE INDEX unexpected_deployment_index ON events(created)");
  store.close();
  await assert.rejects(f.inspect(), /cannot migrate or downgrade/);
});

test("a deletion not yet journaled blocks deployment before stopping the worker", async (t) => {
  const f = await fixture(t),
    store = new Store(f.databasePath, f.guildId),
    now = Date.now();
  transaction(store.db, () =>
    recordRulesDeletion(store.db, f.guildId, randomUUID(), now, now + 35 * 86400000),
  );
  store.close();
  await assert.rejects(f.inspect(), /source is incomplete/);
});

test("source policy mismatch, pending journal work and restoration quarantine are refused", async (t) => {
  const f = await fixture(t),
    file = join(f.dataRoot, "uninstall-retention/source-policy.json"),
    original = readFileSync(file);
  const policy = JSON.parse(original);
  policy.sourceId = randomUUID();
  writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  await assert.rejects(f.inspect(), (error) => error.code === "source_policy_conflict");
  writeFileSync(file, original, { mode: 0o600 });
  writeFileSync(join(f.dataRoot, "rules-acceptance-deletions/pending.tmp"), "pending", {
    mode: 0o600,
  });
  await assert.rejects(f.inspect(), /pending operator work/);
  rmSync(join(f.dataRoot, "rules-acceptance-deletions/pending.tmp"));
  writeFileSync(join(f.dataRoot, "restore-quarantine.json"), "{}", { mode: 0o600 });
  await assert.rejects(f.inspect(), /quarantined/);
});

test("compatibility allows advanced deletion sequence but never source, epoch or schema rollback", async (t) => {
  const f = await fixture(t),
    before = await f.inspect(),
    next = globalThis.structuredClone(before);
  next.source.sequence++;
  assertSameDeploymentState(before, next);
  for (const change of [
    (value) => value.source.sequence--,
    (value) => (value.source.sourceId = randomUUID()),
    (value) => (value.source.active[0].epoch = randomUUID()),
    (value) => value.databases[0].schema.userVersion++,
    (value) => value.policy.hub.migrations.push({ version: 99, checksum: "different" }),
  ]) {
    const value = globalThis.structuredClone(before);
    change(value);
    assert.throws(() => assertSameDeploymentState(before, value), /operator review/);
  }
});

test("packaged deployment inspector supports a previous runtime without the new deployment port", async (t) => {
  const f = await fixture(t),
    hosting = join(f.root, "hosting"),
    shared = join(hosting, "shared"),
    previous = join(hosting, "releases", "a".repeat(40)),
    next = join(hosting, "releases", "b".repeat(40)),
    source = fileURLToPath(new URL("..", import.meta.url));
  mkdirSync(previous, { recursive: true });
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(shared, "logs"));
  mkdirSync(join(shared, "data"));
  cpSync(join(source, "dist"), join(previous, "dist"), { recursive: true });
  mkdirSync(next);
  prepareRuntimePackage(source, next);
  cpSync(join(next, "node_modules"), join(previous, "node_modules"), { recursive: true });
  const current = join(hosting, "current"),
    select = (target) => {
      if (existsSync(current)) unlinkSync(current);
      symlinkSync(target, current, process.platform === "win32" ? "junction" : "dir");
    };
  select(previous);
  writeFileSync(
    join(shared, ".env"),
    Object.entries(f.values)
      .map(([name, value]) => `${name}=${value.replaceAll("\\", "/")}`)
      .join("\n"),
    { mode: 0o600 },
  );
  const start = () => {
    const now = Date.now();
    writeFileSync(
      join(shared, "supervisor.json"),
      JSON.stringify({
        release: realpathSync(current) === previous ? "a".repeat(40) : "b".repeat(40),
        started: now,
      }),
    );
    writeFileSync(
      join(shared, "data/health.json"),
      JSON.stringify({
        ready: true,
        updated: now,
        degraded: false,
        rulesDeletionProof: { state: "ready" },
        guilds: [{ guildId: f.guildId, ready: true }],
      }),
    );
  };
  start();
  assert.equal(existsSync(join(previous, "scripts/deployment-state.mjs")), false);
  try {
    await activateRelease(hosting, next, {
      select,
      start,
      stop: () => {},
      currentMain: () => "b".repeat(40),
      wait: (revision, after, guilds) => waitReady(hosting, revision, after, guilds, 50),
    });
    assert.equal(realpathSync(current), next);
    assert.equal(existsSync(join(shared, "backups")), false);
  } finally {
    unlinkSync(current);
  }
});
