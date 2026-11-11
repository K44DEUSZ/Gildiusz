import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  existsSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { backupV2Fixture } from "./backup-v2-fixture.mjs";
import { BackupCatalog } from "../scripts/backup-catalog.mjs";
import { createSnapshot } from "../dist/storage/recovery/index.js";
import { snapshotRulesDeletionLifecycle } from "../dist/storage/rules-deletion-lifecycle.js";
import { beginUpgrade, advanceUpgrade, releaseAwaitingUpgrade } from "../scripts/hosting.mjs";
import {
  runDailyBackup,
  prepareBeforeUpgrade,
  importOffsiteAck,
} from "../scripts/backup-scheduler.mjs";
import { verifyOffsiteAck, writeOffsiteFile } from "../scripts/backup-offsite.mjs";
import {
  acceptUpgradeAck,
  selectBackupOffer,
  streamBackupArtifact,
  validateBackupRequest,
  validateBackupOffer,
  cleanBackupEnvironment,
} from "../scripts/backup-relay.mjs";
import {
  backupSshArguments,
  collectPcBackupOffer,
  createSshBackupTransport,
  runPcBackup,
} from "../scripts/backup-pc.mjs";

async function hostFixture(t, purpose = "daily") {
  const f = await backupV2Fixture(t),
    root = join(f.root, "hosting"),
    shared = join(root, "shared");
  mkdirSync(shared, { recursive: true, mode: 0o700 });
  const host = new BackupCatalog({ root: join(shared, "backups"), clock: () => f.now });
  const pc = new BackupCatalog({ root: join(f.root, "physical-pc"), clock: () => f.now });
  const locationId = (await pc.read()).locationId;
  writeOffsiteFile(
    join(shared, "offsite-location.json"),
    Buffer.from(JSON.stringify({ format: 1, locationId })),
  );
  let result;
  if (purpose === "daily") {
    const calls = { pause: 0, stop: 0, resume: 0, seal: 0 };
    result = await runDailyBackup({
      catalog: host,
      key: f.key,
      dailyOffsite: {
        path: join(shared, "offsite-daily-offer.json"),
        destinationLocationId: locationId,
      },
      snapshotPort: {
        preflight() {},
        create: ({ outputPath }) => createSnapshot({ ...f.options, outputPath }),
        sealLatestProof: () => {
          calls.seal++;
          f.now = Math.max(Date.now(), f.now);
          return f.seal();
        },
      },
      lifecyclePort: {
        hasPendingUpgrade: () => false,
        pause: () => {
          calls.pause++;
          return { owned: true, release() {} };
        },
        stop() {
          calls.stop++;
        },
        resume() {
          calls.resume++;
        },
      },
    });
    assert.deepEqual(calls, { pause: 1, stop: 1, resume: 1, seal: 1 });
  } else {
    f.now = Math.max(f.now, Date.now());
    const sealed = await f.seal(),
      previous = "a".repeat(40),
      revision = "b".repeat(40);
    const release = join(root, "releases", previous);
    mkdirSync(release, { recursive: true, mode: 0o700 });
    symlinkSync(release, join(root, "current"), process.platform === "win32" ? "junction" : "dir");
    let pending = beginUpgrade(root, revision, previous, locationId);
    result = await prepareBeforeUpgrade({
      catalog: host,
      key: f.key,
      archivePath: f.options.outputPath,
      manifest: f.manifest,
      targetRevision: revision,
      upgradeId: pending.upgradeId,
      destinationLocationId: locationId,
      latestProof: sealed.envelope,
      proofRequirements: sealed.proofRequirements,
    });
    pending = advanceUpgrade(root, pending, {
      state: "awaiting_offsite",
      backupId: result.entry.id,
      sha256: result.entry.sha256,
    });
    writeOffsiteFile(
      join(shared, "offsite-transfer.json"),
      Buffer.from(JSON.stringify(result.transfer)),
    );
    await releaseAwaitingUpgrade(root, pending, () => {});
  }
  const offer = selectBackupOffer(root, f.now);
  const sourceId = offer.transfer.proof.sourceId;
  return { ...f, root, shared, host, pc, offer, sourceId, result };
}
function bridge(f, ack) {
  return {
    stream: (request) => streamBackupArtifact(f.root, request, () => f.now),
    json: (request) =>
      request.operation === "offer" ? selectBackupOffer(f.root, f.now) : ack(request),
  };
}
async function all(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const fixtureLock = (task) => task(() => {});

test("daily capture persists the exact sealed proof offer; real PC collection never sends an upgrade ACK", async (t) => {
  const f = await hostFixture(t);
  const before = readFileSync(join(f.shared, "offsite-daily-offer.json"));
  let ack = 0;
  const result = await collectPcBackupOffer({
    catalog: f.pc,
    key: f.key,
    offer: f.offer,
    sourceId: f.sourceId,
    transport: bridge(f, () => {
      ack++;
      throw Error("Daily must not ACK");
    }),
  });
  assert.equal(result.state, "daily_physical_pc_verified");
  assert.equal(result.physicalPcCopyVerified, true);
  assert.equal(result.hostOffsiteSuccess, false);
  assert.equal(ack, 0);
  assert.equal((await f.host.read()).entries[0].checkpoint, null);
  assert.deepEqual(readFileSync(join(f.shared, "offsite-daily-offer.json")), before);
  const actual = await f.pc.confirmArchive(f.offer.transfer.backup);
  assert.equal(actual.locationId, f.offer.transfer.destinationLocationId);
  assert.equal(
    createHash("sha256")
      .update(readFileSync(f.pc.archivePath(actual.id)))
      .digest("hex"),
    actual.sha256,
  );
  const repeated = await runDailyBackup({
    catalog: f.host,
    key: f.key,
    dailyOffsite: {
      path: join(f.shared, "offsite-daily-offer.json"),
      destinationLocationId: actual.locationId,
    },
    snapshotPort: new Proxy(
      {},
      {
        get() {
          throw Error("No fresh seal on not_due");
        },
      },
    ),
    lifecyclePort: { hasPendingUpgrade: () => false },
  });
  assert.equal(repeated.state, "not_due");
  assert.deepEqual(readFileSync(join(f.shared, "offsite-daily-offer.json")), before);
});

test("upgrade stream uses the existing signed ACK and source verifier; exact retry does not import twice", async (t) => {
  const f = await hostFixture(t, "upgrade");
  let imported = 0;
  const accept = (request) =>
    acceptUpgradeAck(f.root, request, {
      withLock: fixtureLock,
      verify({ transfer, envelope }) {
        verifyOffsiteAck({ transfer, envelope, key: f.key, now: f.now });
        return { verified: true };
      },
      async importAck(path) {
        imported++;
        const checked = await importOffsiteAck({
          catalog: f.host,
          key: f.key,
          id: f.offer.transfer.backup.id,
          targetRevision: f.offer.transfer.targetRevision,
          upgradeId: f.offer.transfer.upgradeId,
          destinationLocationId: f.offer.transfer.destinationLocationId,
          envelope: readFileSync(path),
          sourceSnapshot: () =>
            snapshotRulesDeletionLifecycle({
              dataRoot: f.dataRoot,
              installations: f.installations,
              now: f.now,
            }),
        });
        return { state: "offsite_verified", ...checked };
      },
    });
  let request;
  const transport = bridge(f, (value) => {
    request = value;
    return accept(value);
  });
  const result = await collectPcBackupOffer({
    catalog: f.pc,
    key: f.key,
    offer: f.offer,
    sourceId: f.sourceId,
    transport,
  });
  assert.equal(result.hostOffsiteSuccess, true);
  assert.equal(imported, 1);
  assert.equal((await accept(request)).state, "already_verified");
  assert.equal(imported, 1);
  assert.equal(existsSync(join(f.shared, "paused")), false);
});

test("PC runs persist the exact verified receipt before a lost response and reuse it across process restart", async (t) => {
  const f = await hostFixture(t, "upgrade"),
    receiptPath = join(f.root, "operator-state", "pc-ack.json"),
    config = {
      host: "example.invalid",
      user: "fixture",
      port: 2222,
      identityPath: join(f.root, "key"),
      knownHostsPath: join(f.root, "hosts"),
      catalogRoot: f.pc.root,
      locationId: (await f.pc.read()).locationId,
      sourceId: f.sourceId,
      receiptPath,
    };
  f.host.clock = Date.now;
  let imported = 0,
    loseResponse = true;
  const requests = [],
    transport = bridge(f, async (request) => {
      requests.push(request);
      const result = await acceptUpgradeAck(f.root, request, {
        withLock: fixtureLock,
        verify({ transfer, envelope }) {
          verifyOffsiteAck({ transfer, envelope, key: f.key });
          return { verified: true };
        },
        async importAck(path) {
          imported++;
          const checked = await importOffsiteAck({
            catalog: f.host,
            key: f.key,
            id: f.offer.transfer.backup.id,
            targetRevision: f.offer.transfer.targetRevision,
            upgradeId: f.offer.transfer.upgradeId,
            destinationLocationId: f.offer.transfer.destinationLocationId,
            envelope: readFileSync(path),
            sourceSnapshot: () =>
              snapshotRulesDeletionLifecycle({
                dataRoot: f.dataRoot,
                installations: f.installations,
                now: Date.now(),
              }),
          });
          return { state: "offsite_verified", ...checked };
        },
      });
      if (loseResponse) {
        loseResponse = false;
        throw Error("lost_response");
      }
      return result;
    });
  await assert.rejects(runPcBackup({ config, key: f.key, transport }), /lost_response/);
  assert.equal(imported, 1);
  const saved = readFileSync(receiptPath);
  assert.equal(saved.toString("base64url"), requests[0].envelope);
  assert.equal((await f.pc.inspectLocation()).complete, true);
  assert.equal((await runPcBackup({ config, key: f.key, transport })).hostOffsiteSuccess, true);
  assert.equal(imported, 1);
  assert.equal(requests[1].envelope, requests[0].envelope);
  assert.deepEqual(readFileSync(receiptPath), saved);

  const childSource = `
    import { readFileSync } from "node:fs";
    import { runPcBackup } from ${JSON.stringify(new URL("../scripts/backup-pc.mjs", import.meta.url).href)};
    import { acceptUpgradeAck, selectBackupOffer, streamBackupArtifact } from ${JSON.stringify(new URL("../scripts/backup-relay.mjs", import.meta.url).href)};
    import { verifyOffsiteAck } from ${JSON.stringify(new URL("../scripts/backup-offsite.mjs", import.meta.url).href)};
    const value = JSON.parse(readFileSync(0, "utf8")), key = Buffer.from(value.key, "base64url");
    let envelope;
    const result = await runPcBackup({config:value.config, key, transport:{
      stream:request=>streamBackupArtifact(value.root,request),
      async json(request){
        if(request.operation === "offer")return selectBackupOffer(value.root);
        envelope = request.envelope;
        return acceptUpgradeAck(value.root,request,{
          withLock:task=>task(()=>{}),
          verify({transfer,envelope}){verifyOffsiteAck({transfer,envelope,key});return {verified:true}},
          importAck(){throw Error("A restarted client must reuse the accepted receipt")}
        });
      }
    }});
    process.stdout.write(JSON.stringify({result,envelope}));
  `;
  const restarted = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
    env: cleanBackupEnvironment(),
    input: JSON.stringify({ root: f.root, config, key: f.key.toString("base64url") }),
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  const retried = JSON.parse(restarted.stdout);
  assert.equal(retried.result.hostOffsiteSuccess, true);
  assert.equal(retried.envelope, requests[0].envelope);
  assert.deepEqual(readFileSync(receiptPath), saved);

  const changed = { ...f.offer, id: "f".repeat(64) },
    noRequests = {
      stream() {
        throw Error("Invalid bindings must fail before transfer");
      },
      json() {
        throw Error("Invalid bindings must not replay a saved receipt");
      },
    },
    options = {
      catalog: f.pc,
      key: f.key,
      sourceId: f.sourceId,
      receiptPath,
      transport: noRequests,
    };
  await assert.rejects(collectPcBackupOffer({ ...options, offer: changed }), /transport_offer/);
  f.pc.clock = () => f.offer.transfer.proof.expiresAt;
  await assert.rejects(collectPcBackupOffer({ ...options, offer: f.offer }), /proof_expired/);
  f.pc.clock = Date.now;
  const archive = f.pc.archivePath(f.offer.transfer.backup.id),
    damaged = readFileSync(archive);
  damaged[damaged.length - 1] ^= 1;
  writeFileSync(archive, damaged);
  await assert.rejects(runPcBackup({ config, key: f.key, transport }), /retention_blocked/);
  assert.equal(requests.length, 2);
  assert.deepEqual(readFileSync(receiptPath), saved);
});

test("a changed persisted receipt fails authentication before it can be replayed or replaced", async (t) => {
  const f = await hostFixture(t, "upgrade"),
    receiptPath = join(f.root, "operator-state", "pc-ack.json");
  await assert.rejects(
    collectPcBackupOffer({
      catalog: f.pc,
      key: f.key,
      offer: f.offer,
      sourceId: f.sourceId,
      receiptPath,
      transport: bridge(f, () => {
        throw Error("offline");
      }),
    }),
    /offline/,
  );
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.body.transfer.targetRevision = "c".repeat(40);
  writeOffsiteFile(receiptPath, Buffer.from(JSON.stringify(receipt)));
  const saved = readFileSync(receiptPath);
  let sent = 0;
  await assert.rejects(
    collectPcBackupOffer({
      catalog: f.pc,
      key: f.key,
      offer: f.offer,
      sourceId: f.sourceId,
      receiptPath,
      transport: bridge(f, () => {
        sent++;
      }),
    }),
    /authentication_failed/,
  );
  assert.equal(sent, 0);
  assert.deepEqual(readFileSync(receiptPath), saved);
});

test("wrong source, wrong key, proof metadata tampering and short encrypted streams cannot verify a PC copy", async (t) => {
  for (const scenario of ["source", "key", "proof", "short"]) {
    await t.test(scenario, async (t) => {
      const f = await hostFixture(t),
        transport = bridge(f, () => {
          throw Error("No ACK");
        });
      let key = f.key,
        sourceId = f.sourceId,
        offer = f.offer;
      if (scenario === "source") sourceId = "00000000-0000-4000-8000-000000000001";
      if (scenario === "key") key = randomBytes(32);
      if (scenario === "proof") {
        offer = globalThis.structuredClone(f.offer);
        offer.transfer.proof.sha256 = "f".repeat(64);
        offer.id = createHash("sha256")
          .update(JSON.stringify({ purpose: offer.purpose, transfer: offer.transfer }))
          .digest("hex");
        transport.stream = (request) => bridge(f).stream({ ...request, id: f.offer.id });
      }
      if (scenario === "short") {
        const original = transport.stream;
        transport.stream = async function* (request) {
          const value = await all(original(request));
          yield request.operation === "archive" ? value.subarray(0, value.length - 1) : value;
        };
      }
      await assert.rejects(
        collectPcBackupOffer({ catalog: f.pc, key, offer, sourceId, transport }),
      );
    });
  }
});

test("daily offers cannot use receipt operation and invalid HMAC cannot reach import or create a receipt file", async (t) => {
  const daily = await hostFixture(t);
  await assert.rejects(
    acceptUpgradeAck(daily.root, {
      operation: "ack",
      id: daily.offer.id,
      envelope: Buffer.from("{}").toString("base64url"),
    }),
  );
  const f = await hostFixture(t, "upgrade");
  let imported = 0;
  await assert.rejects(
    acceptUpgradeAck(
      f.root,
      { operation: "ack", id: f.offer.id, envelope: Buffer.from("{}").toString("base64url") },
      {
        withLock: fixtureLock,
        verify({ transfer, envelope }) {
          verifyOffsiteAck({ transfer, envelope, key: f.key, now: f.now });
        },
        importAck() {
          imported++;
        },
      },
    ),
  );
  assert.equal(imported, 0);
  assert.equal(existsSync(join(f.shared, "offsite-received-ack.json")), false);
});

test("relay rejects arbitrary paths, stale offer IDs, oversized ACKs, linked archives and expiry", async (t) => {
  const f = await hostFixture(t),
    path = f.host.archivePath(f.offer.transfer.backup.id);
  for (const request of [
    { operation: "archive", id: "../.env" },
    { operation: "archive", id: f.offer.id, path: "/etc/passwd" },
    { operation: "ack", id: f.offer.id, envelope: Buffer.alloc(8193).toString("base64url") },
    { operation: "exec", command: "env" },
  ])
    assert.throws(() => validateBackupRequest(request));
  await assert.rejects(
    all(streamBackupArtifact(f.root, { operation: "archive", id: "a".repeat(64) }, () => f.now)),
  );
  const hardlink = join(f.root, "hardlink.gldbak");
  linkSync(path, hardlink);
  await assert.rejects(
    all(streamBackupArtifact(f.root, { operation: "archive", id: f.offer.id }, () => f.now)),
  );
  unlinkSync(hardlink);
  assert.throws(() => validateBackupOffer(f.offer, f.offer.transfer.proof.expiresAt));
  const pending = join(f.shared, "pending-upgrade.json");
  writeFileSync(pending, "{}", { mode: 0o600 });
  assert.throws(() => selectBackupOffer(f.root, f.now));
});

test("PC child SSH has a dedicated identity, host pin, no web multiplexing/forwarding and no recovery key", () => {
  const config = {
    host: "example.invalid",
    user: "fixture",
    port: 2222,
    identityPath: join(process.cwd(), "fixture-key"),
    knownHostsPath: join(process.cwd(), "known-hosts"),
    catalogRoot: process.cwd(),
    locationId: "00000000-0000-4000-8000-000000000001",
    sourceId: "00000000-0000-4000-8000-000000000002",
  };
  const args = backupSshArguments(config);
  for (const expected of [
    "ControlPath=none",
    "ControlMaster=no",
    "ClearAllForwardings=yes",
    "IdentitiesOnly=yes",
    "StrictHostKeyChecking=yes",
  ])
    assert.ok(args.includes(expected));
  assert.ok(args.includes(config.identityPath));
  for (const receiptPath of ["relative-ack.json", join(config.catalogRoot, "pc-ack.json")])
    assert.throws(() => backupSshArguments({ ...config, receiptPath }), /configuration/);
  assert.equal(
    cleanBackupEnvironment({
      PATH: "fixture",
      BACKUP_ENCRYPTION_KEY: "secret",
      DISCORD_TOKEN: "token",
      NODE_OPTIONS: "unsafe",
    }).BACKUP_ENCRYPTION_KEY,
    undefined,
  );
});

test("SSH adapter refuses successful-looking bytes when remote exits nonzero", async () => {
  const config = {
    host: "example.invalid",
    user: "fixture",
    port: 2222,
    identityPath: process.cwd(),
    knownHostsPath: process.cwd(),
    catalogRoot: process.cwd(),
    locationId: "00000000-0000-4000-8000-000000000001",
    sourceId: "00000000-0000-4000-8000-000000000002",
  };
  const transport = createSshBackupTransport(config, () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.exitCode = 1;
    process.nextTick(() => {
      child.stdout.end("{}");
      child.emit("close", 1);
    });
    return child;
  });
  await assert.rejects(transport.json({ operation: "offer" }), /connection_failed/);
});

test("local retention runs before an offline PC request and never reports physical copy success", async (t) => {
  const f = await hostFixture(t),
    before = await f.pc.read();
  let called = 0;
  const config = {
    host: "example.invalid",
    user: "fixture",
    port: 2222,
    identityPath: join(f.root, "key"),
    knownHostsPath: join(f.root, "hosts"),
    catalogRoot: f.pc.root,
    locationId: before.locationId,
    sourceId: f.sourceId,
  };
  await assert.rejects(
    runPcBackup({
      config,
      key: f.key,
      transport: {
        json() {
          called++;
          throw Error("offline");
        },
      },
    }),
    /offline/,
  );
  assert.equal(called, 1);
  assert.equal((await f.pc.read()).transfers.length, 0);
});

test("pending defers the optional daily offer without changing its bytes or sealing again", async (t) => {
  const f = await hostFixture(t),
    path = join(f.shared, "offsite-daily-offer.json"),
    before = readFileSync(path);
  const result = await runDailyBackup({
    catalog: f.host,
    key: f.key,
    dailyOffsite: { path, destinationLocationId: f.offer.transfer.destinationLocationId },
    lifecyclePort: { hasPendingUpgrade: () => true },
    snapshotPort: new Proxy(
      {},
      {
        get() {
          throw Error("No pending seal");
        },
      },
    ),
  });
  assert.equal(result.state, "deferred_pending_upgrade");
  assert.deepEqual(readFileSync(path), before);
});

test("expired proof and oversized or symbolic proof files are never exported", async (t) => {
  const f = await hostFixture(t),
    request = { operation: "proof", id: f.offer.id };
  await assert.rejects(
    all(streamBackupArtifact(f.root, request, () => f.offer.transfer.proof.expiresAt)),
  );
  const path = join(
    f.shared,
    "backups/deletion-ledger",
    "deletion-proof-" + f.offer.transfer.proof.id + ".gldproof",
  );
  const saved = join(f.root, "saved-proof");
  copyFileSync(path, saved);
  writeFileSync(path, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(all(streamBackupArtifact(f.root, request, () => f.now)));
  if (process.platform !== "win32") {
    unlinkSync(path);
    symlinkSync(saved, path);
    await assert.rejects(all(streamBackupArtifact(f.root, request, () => f.now)));
  }
});

test("the real short recovery child verifies HMAC before the import callback", async (t) => {
  const f = await hostFixture(t, "upgrade");
  writeFileSync(
    join(f.shared, "backup-key.env"),
    "BACKUP_ENCRYPTION_KEY=" + f.key.toString("base64url") + "\n",
    { mode: 0o600 },
  );
  const { collectForOffsiteAck } = await import("../scripts/backup-collector.mjs");
  const proof = await all(
    streamBackupArtifact(f.root, { operation: "proof", id: f.offer.id }, () => f.now),
  );
  const collected = await collectForOffsiteAck({
    catalog: f.pc,
    key: f.key,
    transfer: f.offer.transfer,
    envelope: proof,
    fetchStream: () =>
      streamBackupArtifact(f.root, { operation: "archive", id: f.offer.id }, () => f.now),
  });
  let imported = 0;
  const request = {
    operation: "ack",
    id: f.offer.id,
    envelope: collected.ack.toString("base64url"),
  };
  const result = await acceptUpgradeAck(f.root, request, {
    withLock: fixtureLock,
    importAck() {
      imported++;
      return { state: "offsite_verified", id: f.offer.transfer.backup.id, offsiteSuccess: true };
    },
  });
  assert.equal(result.offsiteSuccess, true);
  assert.equal(imported, 1);
  const bad = JSON.parse(collected.ack.toString("utf8"));
  bad.hmac = "0".repeat(64);
  await assert.rejects(
    acceptUpgradeAck(
      f.root,
      { ...request, envelope: Buffer.from(JSON.stringify(bad)).toString("base64url") },
      {
        withLock: fixtureLock,
        importAck() {
          imported++;
        },
      },
    ),
  );
  assert.equal(imported, 1);
});

test(
  "Linux forced-command CLI serves only a bound offer and rejects command or environment escalation",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await hostFixture(t),
      script = join(process.cwd(), "scripts/backup-relay.mjs");
    const invoke = (command, input, extra = {}) =>
      spawnSync(process.execPath, [script, "serve", f.root], {
        env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: command, ...extra },
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout: 10000,
      });
    const good = invoke("gildiusz-backup-v1", { operation: "offer" });
    assert.equal(good.status, 0);
    assert.equal(JSON.parse(good.stdout).id, f.offer.id);
    for (const result of [
      invoke("cat /etc/passwd", { operation: "offer" }),
      invoke(
        "gildiusz-backup-v1",
        { operation: "offer" },
        { BACKUP_ENCRYPTION_KEY: "fixture-must-not-be-echoed" },
      ),
      invoke("gildiusz-backup-v1", { operation: "archive", id: "../.env" }),
    ]) {
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.ok(!result.stderr.includes("fixture-must-not-be-echoed"));
    }
  },
);

test("a request replaced before acquiring the deployment lock cannot reach HMAC verification or import", async (t) => {
  const f = await hostFixture(t, "upgrade"),
    path = join(f.shared, "pending-upgrade.json");
  let verified = 0,
    imported = 0;
  await assert.rejects(
    acceptUpgradeAck(
      f.root,
      { operation: "ack", id: f.offer.id, envelope: Buffer.from("{}").toString("base64url") },
      {
        withLock(work) {
          const pending = JSON.parse(readFileSync(path, "utf8"));
          pending.backupId = "00000000-0000-4000-8000-000000000001";
          writeOffsiteFile(path, Buffer.from(JSON.stringify(pending)));
          return work(() => {});
        },
        verify() {
          verified++;
          return { verified: true };
        },
        importAck() {
          imported++;
        },
      },
    ),
  );
  assert.equal(verified, 0);
  assert.equal(imported, 0);
  assert.equal(existsSync(join(f.shared, "paused")), false);
  assert.equal(existsSync(join(f.shared, "offsite-received-ack.json")), false);
});

test(
  "Linux ACK keeps the same kernel deployment lock across pre-MAC verification; a competing pending writer cannot enter",
  { skip: process.platform !== "linux" },
  async (t) => {
    const f = await hostFixture(t, "upgrade"),
      path = join(f.shared, "pending-upgrade.json"),
      before = readFileSync(path);
    let imported = 0,
      competed = 0;
    await assert.rejects(
      acceptUpgradeAck(
        f.root,
        { operation: "ack", id: f.offer.id, envelope: Buffer.from("{}").toString("base64url") },
        {
          verify() {
            const child = spawnSync(
              "flock",
              [
                "-n",
                join(f.shared, "deploy.lock"),
                process.execPath,
                "--input-type=module",
                "-e",
                'import {writeFileSync} from "node:fs";writeFileSync(process.argv[1],"replaced")',
                path,
              ],
              { timeout: 10000 },
            );
            assert.equal(child.status, 1);
            competed++;
            assert.deepEqual(readFileSync(path), before);
            return { verified: false };
          },
          importAck() {
            imported++;
          },
        },
      ),
    );
    assert.equal(competed, 1);
    assert.equal(imported, 0);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(join(f.shared, "paused")), false);
  },
);
