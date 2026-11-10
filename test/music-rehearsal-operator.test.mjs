import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const build = path.resolve(process.env.GILDIUSZ_MUSIC_OPERATOR_TEST_DIST ?? "dist");
const { createMusicRehearsalOperator } = await import(
  pathToFileURL(path.join(build, "bot/music-rehearsal-operator.js")).href
);
const { RehearsalError } = await import(
  pathToFileURL(path.join(build, "modules/music-rehearsal/types.js")).href
);
const ids = {
  app: "900000000000000001",
  bot: "900000000000000002",
  guild: "900000000000000101",
  channel: "900000000000000201",
  actor: "900000000000000301",
  foreign: "900000000000000999",
};
const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const code = (expected) => (error) => error?.code === expected;

class Scheduler {
  now = 100000;
  tasks = new Set();
  after(milliseconds, callback) {
    const task = { at: this.now + milliseconds, callback };
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  }
  async advance(milliseconds = 1000) {
    const end = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks].filter((task) => task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.tasks.delete(next);
      this.now = next.at;
      next.callback();
      await flush();
    }
    this.now = end;
    await flush();
  }
}
function fixture(t, options = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), "gildiusz-audio-operator-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const dataRoot = path.join(temporary, "data"),
    tools = path.join(temporary, "tools");
  mkdirSync(dataRoot, { mode: 0o700 });
  mkdirSync(tools, { mode: 0o700 });
  const executablePath = path.join(tools, "ffmpeg"),
    sourcePath = path.join(tools, "synthetic.wav");
  writeFileSync(executablePath, "private-test-binary", { mode: 0o700 });
  writeFileSync(sourcePath, "private-test-source", { mode: 0o600 });
  const directory = path.join(dataRoot, "audio-rehearsal");
  mkdirSync(directory, { mode: 0o700 });
  const configPath = path.join(dataRoot, "operator.json"),
    requestPath = path.join(directory, "request.json"),
    statusPath = path.join(directory, "status.json");
  const config = {
    format: 1,
    guard: {
      applicationId: ids.app,
      botUserId: ids.bot,
      operatorIds: [ids.actor],
      guildChannels: { [ids.guild]: [ids.channel] },
    },
    ffmpeg: { executablePath, executableSha256: "a".repeat(64), sourcePath },
    requestPath,
    statusPath,
  };
  const saveConfig = () => writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  saveConfig();
  const calls = { build: 0, start: [], stop: [], stopAll: [] },
    scheduler = new Scheduler(),
    client = { application: { id: ids.app }, user: { id: ids.bot }, isReady: () => true };
  let current = null,
    authorized = true;
  const controller = {
    start: async (request) => {
      calls.start.push(request);
      if (!authorized) throw new RehearsalError("permission_revoked");
      current = {
        id: "synthetic-session",
        ...request,
        state: "playing",
        createdAt: scheduler.now,
        playingAt: scheduler.now,
        stoppedAt: null,
        reason: null,
        reconnects: 0,
        cleanupPending: false,
        decoder: {
          outputBytes: 120,
          stderrBytes: 0,
          lastOutputAt: scheduler.now,
          privateEnvironment: "secret-sentinel",
        },
        voice: {
          channelId: request.channelId,
          ready: true,
          daveProtocolVersion: 1,
          hasVoicePrivacyCode: true,
          encryptionMode: "aead_aes256_gcm_rtpsize",
          wsPingMs: 5,
          udpEstablished: true,
          udpPingMs: null,
          playedMilliseconds: 20,
          voicePrivacyCode: "privacy-sentinel",
          token: "token-sentinel",
        },
        secret: "secret-sentinel",
      };
      if (options.startGate) return options.startGate.promise;
      return current;
    },
    stop: async (guildId, reason) => {
      calls.stop.push([guildId, reason]);
      if (current) current = { ...current, state: "stopped", stoppedAt: scheduler.now, reason };
      return current;
    },
    stopAll: async (reason) => {
      calls.stopAll.push(reason);
      if (options.stopGate) await options.stopGate.promise;
      if (current)
        current = {
          ...current,
          state: "stopped",
          stoppedAt: scheduler.now,
          reason,
          cleanupPending: options.cleanupPending ?? false,
        };
      return current ? [current] : [];
    },
    snapshot: () => current,
  };
  const runtimeOptions = {
    enabled: true,
    dataRoot,
    configPath,
    expectedApplicationId: ids.app,
    clock: () => scheduler.now,
    scheduler,
    buildController: async () => {
      calls.build++;
      return controller;
    },
    ...options.runtimeOptions,
  };
  const write = (request) => {
    const temporaryRequest = path.join(directory, "next.json");
    writeFileSync(temporaryRequest, JSON.stringify(request), { mode: 0o600 });
    renameSync(temporaryRequest, requestPath);
  };
  const start = (extra = {}) => ({
    command: "start",
    requestId: "start-1",
    createdAt: scheduler.now + 1,
    actorId: ids.actor,
    guildId: ids.guild,
    channelId: ids.channel,
    durationSeconds: 120,
    ...extra,
  });
  const stop = (extra = {}) => ({
    command: "stop",
    requestId: "stop-1",
    createdAt: scheduler.now + 1,
    actorId: ids.actor,
    guildId: ids.guild,
    ...extra,
  });
  return {
    temporary,
    dataRoot,
    tools,
    directory,
    configPath,
    requestPath,
    statusPath,
    config,
    saveConfig,
    calls,
    scheduler,
    client,
    controller,
    runtimeOptions,
    write,
    start,
    stop,
    status: () => JSON.parse(readFileSync(statusPath, "utf8")),
    run: () => createMusicRehearsalOperator(client, runtimeOptions),
    authorize: (value) => {
      authorized = value;
    },
  };
}

test("disabled bridge returns before reading paths or loading a controller", async () => {
  const runtime = await createMusicRehearsalOperator(
    {},
    {
      enabled: false,
      expectedApplicationId: "invalid",
      dataRoot: "public_html/not-an-absolute-path",
      buildController: () => assert.fail("disabled controller import"),
    },
  );
  assert.equal(runtime, null);
});

test("identity and strict private configuration are verified before the controller is built", async (t) => {
  const f = fixture(t);
  f.config.guard.applicationId = ids.foreign;
  f.saveConfig();
  await assert.rejects(f.run(), code("identity_mismatch"));
  assert.equal(f.calls.build, 0);
  f.config.guard.applicationId = ids.app;
  f.config.ffmpeg.url = "https://example.invalid/audio";
  f.saveConfig();
  await assert.rejects(f.run(), code("operator_config_invalid"));
  assert.equal(f.calls.build, 0);
  delete f.config.ffmpeg.url;
  f.config.statusPath = path.join(f.temporary, "outside.json");
  f.saveConfig();
  await assert.rejects(f.run(), code("operator_config_invalid"));
  assert.equal(existsSync(f.config.statusPath), false);
});

test("stale or pre-start request files never start audio, including after a restart", async (t) => {
  const f = fixture(t);
  f.write(f.start({ createdAt: f.scheduler.now }));
  const runtime = await f.run();
  await f.scheduler.advance();
  assert.equal(f.calls.start.length, 0);
  assert.equal(f.status().lastError, "operator_request_stale");
  f.write(f.start());
  await f.scheduler.advance();
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.status().request.state, "succeeded");
  await runtime.stop();
  assert.equal(f.scheduler.tasks.size, 0);
  const restarted = await f.run();
  await f.scheduler.advance();
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.status().lastError, "operator_request_stale");
  await restarted.stop();
});

test("preexisting or rejected future-dated files cannot become a delayed automatic start", async (t) => {
  const f = fixture(t);
  f.write(f.start({ createdAt: f.scheduler.now + 5001 }));
  const runtime = await f.run();
  await f.scheduler.advance(7000);
  assert.equal(f.calls.start.length, 0);
  f.write(f.start({ requestId: "future-after-start", createdAt: f.scheduler.now + 5001 }));
  await f.scheduler.advance(7000);
  assert.equal(f.calls.start.length, 0);
  f.write(f.start({ requestId: "fresh-intent" }));
  await f.scheduler.advance();
  assert.equal(f.calls.start.length, 1);
  await runtime.stop();
});

test("duplicate request is idempotent, and reusing its ID with a different payload is rejected", async (t) => {
  const f = fixture(t),
    runtime = await f.run(),
    original = f.start();
  f.write(original);
  await f.scheduler.advance();
  f.write(Object.fromEntries(Object.entries(original).reverse()));
  await f.scheduler.advance();
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.status().request.state, "succeeded");
  f.write({ ...original, durationSeconds: 121 });
  await f.scheduler.advance();
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.status().lastError, "idempotency_conflict");
  assert.equal(f.status().sessions[0].durationSeconds, 120);
  await runtime.stop();
});

test("foreign, malformed, oversized and future requests have no controller effects", async (t) => {
  const f = fixture(t),
    runtime = await f.run();
  for (const change of [
    { actorId: ids.foreign },
    { guildId: ids.foreign },
    { channelId: ids.foreign },
    { durationSeconds: 119 },
    { durationSeconds: 3601 },
    { sourceId: "untrusted" },
    { createdAt: 9999999 },
    { requestId: "\n" },
  ]) {
    f.write(f.start(change));
    await f.scheduler.advance();
    assert.equal(f.calls.start.length, 0);
  }
  writeFileSync(f.requestPath, '{"secret":', { mode: 0o600 });
  await f.scheduler.advance();
  assert.equal(f.status().lastError, "operator_request_invalid");
  writeFileSync(f.requestPath, "x".repeat(4097), { mode: 0o600 });
  await f.scheduler.advance();
  assert.equal(f.calls.start.length, 0);
  assert.equal(f.calls.stop.length, 0);
  await runtime.stop();
});

test("a stop is read while start is pending, and does not require renewed membership", async (t) => {
  const gate = deferred(),
    f = fixture(t, { startGate: gate }),
    runtime = await f.run();
  f.write(f.start());
  await f.scheduler.advance();
  assert.equal(f.status().request.state, "accepted");
  assert.equal(f.calls.start.length, 1);
  f.authorize(false);
  f.client.isReady = () => false;
  f.write(f.stop());
  await f.scheduler.advance();
  assert.deepEqual(f.calls.stop, [[ids.guild, "operator"]]);
  assert.equal(f.status().request.command, "stop");
  assert.equal(f.status().request.state, "succeeded");
  gate.reject(new RehearsalError("cancelled"));
  await flush();
  assert.equal(f.status().request.command, "stop");
  await runtime.stop();
});

test("fresh start failures expose stable codes and never write decoder/SDK private fields", async (t) => {
  const f = fixture(t),
    runtime = await f.run();
  f.write(f.start());
  await f.scheduler.advance();
  const raw = readFileSync(f.statusPath, "utf8");
  assert.doesNotMatch(raw, /sentinel|executablePath|sourcePath|secret|voicePrivacyCode|token/);
  assert.equal(f.status().sessions[0].voice.hasVoicePrivacyCode, true);
  assert.equal(f.status().sessions[0].voice.udpEstablished, true);
  assert.equal(f.status().sessions[0].voice.udpPingMs, null);
  f.authorize(false);
  f.write(f.start({ requestId: "start-2" }));
  await f.scheduler.advance();
  assert.equal(f.status().request.code, "permission_revoked");
  assert.equal(f.status().request.state, "failed");
  assert.equal(
    readdirSync(f.directory).some((name) => name.endsWith(".tmp")),
    false,
  );
  if (process.platform !== "win32") assert.equal(lstatSync(f.statusPath).mode & 0o777, 0o600);
  await runtime.stop();
});

test("the command budget cannot block emergency stop or shutdown", async (t) => {
  const f = fixture(t),
    runtime = await f.run();
  for (let index = 0; index < 128; index++) {
    f.write(f.start({ requestId: `start-${index}` }));
    await f.scheduler.advance();
  }
  assert.equal(f.calls.start.length, 128);
  f.write(f.start({ requestId: "over-budget" }));
  await f.scheduler.advance();
  assert.equal(f.calls.start.length, 128);
  assert.equal(f.status().state, "stop_only");
  f.authorize(false);
  f.write(f.stop());
  await f.scheduler.advance();
  assert.equal(f.status().state, "stopped");
  assert.equal(f.calls.stopAll.length, 1);
  assert.equal(f.scheduler.tasks.size, 0);
  await runtime.stop();
  assert.equal(f.calls.stopAll.length, 1);
});

test("shutdown is awaited, cancels polling and does not accept later requests", async (t) => {
  const gate = deferred(),
    f = fixture(t, { stopGate: gate }),
    runtime = await f.run();
  let stopped = false;
  const stop = runtime.stop().then(() => {
    stopped = true;
  });
  await flush();
  assert.equal(stopped, false);
  assert.equal(f.scheduler.tasks.size, 0);
  f.write(f.start());
  await f.scheduler.advance(5000);
  assert.equal(f.calls.start.length, 0);
  gate.resolve();
  await stop;
  assert.equal(f.status().state, "stopped");
  await runtime.stop();
  assert.equal(f.calls.stopAll.length, 1);
});

test("a hardlinked status target is not overwritten, and owned playback is still stopped", async (t) => {
  const f = fixture(t),
    runtime = await f.run();
  const original = readFileSync(f.statusPath);
  const outside = path.join(f.temporary, "foreign-status.json");
  linkSync(f.statusPath, outside);
  await f.scheduler.advance();
  await assert.rejects(runtime.stop(), code("operator_unavailable"));
  assert.equal(f.calls.stopAll.length, 1);
  assert.deepEqual(readFileSync(outside), original);
  assert.deepEqual(readFileSync(f.statusPath), original);
  assert.equal(f.scheduler.tasks.size, 0);
});

test("a directory link substituted after initialization fails closed before reading requests", async (t) => {
  const f = fixture(t),
    runtime = await f.run(),
    saved = path.join(f.dataRoot, "original-audio"),
    outside = path.join(f.temporary, "foreign");
  mkdirSync(outside, { mode: 0o700 });
  renameSync(f.directory, saved);
  symlinkSync(outside, f.directory, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(path.join(outside, "request.json"), JSON.stringify(f.start()), { mode: 0o600 });
  await f.scheduler.advance();
  await assert.rejects(runtime.stop(), code("operator_unavailable"));
  assert.equal(f.calls.start.length, 0);
  assert.equal(f.calls.stopAll.length, 1);
  assert.equal(existsSync(path.join(outside, "status.json")), false);
});

test(
  "POSIX group-readable config is refused before building the controller",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    chmodSync(f.configPath, 0o640);
    await assert.rejects(f.run(), code("operator_path_invalid"));
    assert.equal(f.calls.build, 0);
  },
);
