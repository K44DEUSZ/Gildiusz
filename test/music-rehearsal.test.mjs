import assert from "node:assert/strict";
import { resolve } from "node:path";
import { URL, pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
const base = pathToFileURL(
  resolve(process.env.GILDIUSZ_MUSIC_TEST_DIST ?? "dist/modules/music-rehearsal") + "/",
);
const { MusicRehearsal, RehearsalError } = await import(new URL("service.js", base));
const guild = "100000000000000001",
  channel = "100000000000000002",
  actor = "100000000000000003",
  bot = "100000000000000004",
  app = "100000000000000005";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const code = (expected) => (error) => error instanceof RehearsalError && error.code === expected;
class Scheduler {
  now = 100000;
  tasks = new Set();
  after(milliseconds, callback) {
    const task = { at: this.now + milliseconds, callback };
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  }
  async advance(milliseconds) {
    const end = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks].filter((item) => item.at <= end).sort((a, b) => a.at - b.at)[0];
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
function fixture(t, enabled = true) {
  const scheduler = new Scheduler(),
    playback = deferred(),
    decoderEnd = deferred();
  const state = {
    opens: 0,
    prepares: 0,
    decoders: 0,
    plays: 0,
    closes: 0,
    stops: 0,
    connected: false,
    humanCount: 1,
    role: true,
    inspect: null,
    prepare: null,
    ready: null,
    reconnect: null,
    close: null,
    metricsAt: null,
    playedAt: null,
    udpPingMs: 30,
    emit: () => {},
    inspected: 0,
  };
  const evidence = () => ({
    channelId: channel,
    ready: true,
    daveProtocolVersion: 1,
    hasVoicePrivacyCode: true,
    encryptionMode: "aead_aes256_gcm_rtpsize",
    wsPingMs: 20,
    udpEstablished: true,
    udpPingMs: state.udpPingMs,
    playedMilliseconds: state.playedAt ?? scheduler.now - 100000,
  });
  const decoder = {
    prepare: async (signal) => {
      state.prepares++;
      if (state.prepare) return state.prepare(signal);
      return prepared;
    },
  };
  const prepared = {
    start: (_seconds, signal) => {
      assert.equal(signal.aborted, false);
      state.decoders++;
      return {
        output: new PassThrough(),
        finished: decoderEnd.promise,
        metrics: () => ({
          outputBytes: 10,
          stderrBytes: 0,
          lastOutputAt: state.metricsAt ?? scheduler.now,
        }),
        stop: async () => {
          state.stops++;
          decoderEnd.resolve();
        },
      };
    },
  };
  const ports = {
    identity: () => ({ applicationId: app, botUserId: bot, gatewayReady: true }),
    inspect: async (input, signal) => {
      state.inspected++;
      if (state.inspect) return state.inspect(input, signal);
      return {
        observedAt: scheduler.now,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: input.actorId,
        gatewayReady: true,
        channelKind: "voice",
        memberPresent: true,
        actorIsBot: false,
        owner: state.role,
        manageGuild: false,
        pending: false,
        timedOut: false,
        actorChannelId: state.humanCount > 0 ? input.channelId : null,
        botChannelId: state.connected ? input.channelId : null,
        viewChannel: true,
        connect: true,
        speak: true,
        humanCount: state.humanCount,
        memberCount: Math.max(state.humanCount, 1),
        userLimit: 0,
      };
    },
    open: () => {
      state.opens++;
      state.connected = true;
      return {
        ready: async (signal) => (state.ready ? state.ready(signal) : evidence()),
        evidence,
        play: () => {
          state.plays++;
          return { started: Promise.resolve(), finished: playback.promise };
        },
        reconnect: async (signal) => (state.reconnect ? state.reconnect(signal) : evidence()),
        onEvent: (listener) => {
          state.emit = listener;
          return () => {
            state.emit = () => {};
          };
        },
        close: async () => {
          state.closes++;
          if (state.close) await state.close();
          state.connected = false;
          playback.resolve();
        },
      };
    },
  };
  const guard = {
    applicationId: app,
    botUserId: bot,
    operatorIds: [actor],
    guildChannels: { [guild]: [channel] },
  };
  const runtime = new MusicRehearsal({
    enabled,
    guard,
    ports,
    decoder,
    scheduler,
    clock: () => scheduler.now,
  });
  t.after(async () => {
    if (state.close) state.close = null;
    const stopping = runtime.stopAll();
    await flush();
    await scheduler.advance(5000);
    await stopping;
  });
  const input = {
    actorId: actor,
    guildId: guild,
    channelId: channel,
    requestId: "one",
    sourceId: "synthetic-v1",
    durationSeconds: 120,
  };
  return {
    runtime,
    state,
    scheduler,
    input,
    prepared,
    ports,
    guard,
    playback,
    decoderEnd,
    evidence,
  };
}

test("default OFF and identity/channel guards run before decoder or voice side effects", async (t) => {
  const f = fixture(t, undefined);
  // The fixture's explicit true default is replaced here by omitting enabled entirely.
  const off = new MusicRehearsal({
    guard: f.guard,
    ports: f.ports,
    decoder: { prepare: () => assert.fail("disabled prepare") },
  });
  await assert.rejects(off.start(f.input), code("disabled"));
  await assert.rejects(
    f.runtime.start({ ...f.input, channelId: "200000000000000001" }),
    code("invalid_input"),
  );
  f.ports.identity = () => ({
    applicationId: "200000000000000001",
    botUserId: bot,
    gatewayReady: true,
  });
  await assert.rejects(f.runtime.start(f.input), code("identity_mismatch"));
  assert.equal(f.state.opens + f.state.prepares, 0);
});

test("one session, immutable guard, stable request replay and snapshots cannot start duplicate resources", async (t) => {
  const f = fixture(t);
  const first = await f.runtime.start(f.input);
  const replay = await f.runtime.start({
    durationSeconds: 120,
    sourceId: "synthetic-v1",
    requestId: "one",
    channelId: channel,
    guildId: guild,
    actorId: actor,
  });
  assert.equal(first.id, replay.id);
  assert.equal(f.state.decoders, 1);
  assert.equal(f.state.opens, 1);
  await assert.rejects(f.runtime.start({ ...f.input, requestId: "two" }), code("session_conflict"));
  await assert.rejects(
    f.runtime.start({ ...f.input, durationSeconds: 121 }),
    code("idempotency_conflict"),
  );
  f.guard.guildChannels[guild].push("200000000000000001");
  await assert.rejects(
    f.runtime.start({ ...f.input, channelId: "200000000000000001", requestId: "three" }),
    code("invalid_input"),
  );
  first.state = "failed";
  assert.equal(f.runtime.snapshot(guild).state, "playing");
});

test("permission is rechecked after preparation and unverified DAVE/UDP never starts audio", async (t) => {
  const f = fixture(t);
  f.state.prepare = async () => {
    f.state.role = false;
    return f.prepared;
  };
  await assert.rejects(f.runtime.start(f.input), code("permission_revoked"));
  assert.equal(f.state.opens, 0);
  for (const invalid of [
    { daveProtocolVersion: 0 },
    { udpEstablished: false },
    { udpEstablished: undefined },
    { udpPingMs: Number.NaN },
    { udpPingMs: Infinity },
    { udpPingMs: -1 },
    { udpPingMs: undefined },
    { wsPingMs: undefined },
    { wsPingMs: Number.NaN },
    { encryptionMode: "unsupported" },
    { hasVoicePrivacyCode: false },
  ]) {
    const other = fixture(t);
    other.state.ready = async () => ({ ...other.evidence(), ...invalid });
    await assert.rejects(other.runtime.start(other.input), code("transport_unverified"));
    assert.equal(other.state.decoders, 0);
    assert.equal(other.state.closes, 1);
  }
});

test("established UDP without SDK RTT remains explicit and nullable through controller checks", async (t) => {
  const f = fixture(t);
  f.state.udpPingMs = null;
  const result = await f.runtime.start(f.input);
  assert.equal(result.state, "playing");
  assert.equal(result.voice.udpEstablished, true);
  assert.equal(result.voice.udpPingMs, null);
  await f.scheduler.advance(1000);
  assert.equal(f.runtime.snapshot(guild).state, "playing");
  assert.equal(f.runtime.snapshot(guild).voice.udpPingMs, null);
});

test("natural completion closes all owned resources and a later replay returns the stopped result", async (t) => {
  const f = fixture(t);
  await f.runtime.start(f.input);
  await f.scheduler.advance(120000);
  f.decoderEnd.resolve();
  f.playback.resolve();
  await flush();
  assert.equal(f.runtime.snapshot(guild).state, "stopped");
  assert.equal(f.runtime.snapshot(guild).reason, "completed");
  assert.equal(f.scheduler.tasks.size, 0);
  const replay = await f.runtime.start(f.input);
  assert.equal(replay.state, "stopped");
  assert.equal(f.state.opens, 1);
  assert.equal(f.state.stops, 1);
});

test("premature EOF cannot report completed and a later decoder rejection remains a failed rehearsal", async (t) => {
  for (const elapsed of [0, 60000]) {
    const f = fixture(t);
    await f.runtime.start(f.input);
    await f.scheduler.advance(elapsed);
    f.playback.resolve();
    await flush();
    assert.equal(f.runtime.snapshot(guild).state, "failed");
    assert.equal(f.runtime.snapshot(guild).reason, "playback_incomplete");
    f.decoderEnd.reject(Error("late encoder failure"));
    await flush();
    assert.notEqual(f.runtime.snapshot(guild).reason, "completed");
    assert.equal(f.state.closes, 1);
  }
});

test("full playback duration still waits for the decoder's successful end instead of hiding its failure", async (t) => {
  const f = fixture(t);
  await f.runtime.start(f.input);
  await f.scheduler.advance(120000);
  f.playback.resolve();
  await flush();
  assert.notEqual(f.runtime.snapshot(guild).reason, "completed");
  f.decoderEnd.reject(Error("encoder exit failure"));
  await flush();
  assert.equal(f.runtime.snapshot(guild).state, "failed");
  assert.equal(f.runtime.snapshot(guild).reason, "decoder_failed");
});

test("stopping a delayed prepare or Ready wait cannot create or restart audio later", async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.state.prepare = () => gate.promise;
  const starting = f.runtime.start(f.input),
    rejected = assert.rejects(starting, code("cancelled"));
  await flush();
  await f.runtime.stop(guild);
  gate.resolve(f.prepared);
  await rejected;
  await flush();
  assert.equal(f.state.opens, 0);
  assert.equal(f.state.decoders, 0);
  const other = fixture(t),
    ready = deferred();
  other.state.ready = () => ready.promise;
  const pending = other.runtime.start(other.input),
    pendingRejection = assert.rejects(pending, code("cancelled"));
  await flush();
  await other.runtime.stop(guild);
  ready.resolve(other.evidence());
  await pendingRejection;
  await flush();
  assert.equal(other.state.closes, 1);
  assert.equal(other.state.decoders, 0);
});

test("empty channel grace and loss of current authority stop only the owned session", async (t) => {
  const f = fixture(t);
  await f.runtime.start(f.input);
  f.state.humanCount = 0;
  await f.runtime.notifyVoiceState(guild);
  await f.scheduler.advance(29999);
  assert.equal(f.runtime.snapshot(guild).state, "playing");
  await f.scheduler.advance(1);
  assert.equal(f.runtime.snapshot(guild).reason, "empty_channel");
  assert.equal(f.state.stops, 1);
  assert.equal(f.state.closes, 1);
  const other = fixture(t);
  await other.runtime.start(other.input);
  other.state.role = false;
  await other.runtime.notifyVoiceState(guild);
  assert.equal(other.runtime.snapshot(guild).reason, "permission_revoked");
});

test("disconnect storms coalesce, consume a bounded budget, and reuse the same decoder and voice handle", async (t) => {
  const f = fixture(t);
  await f.runtime.start(f.input);
  let reconnects = 0;
  f.state.reconnect = async () => {
    reconnects++;
    if (reconnects === 1) throw Error("not ready");
    return f.evidence();
  };
  f.state.emit("disconnected");
  f.state.emit("disconnected");
  await flush();
  assert.equal(reconnects, 2);
  assert.equal(f.runtime.snapshot(guild).state, "playing");
  assert.equal(f.state.opens, 1);
  assert.equal(f.state.decoders, 1);
  assert.equal(f.state.plays, 1);
  f.state.emit("disconnected");
  await flush();
  assert.equal(f.runtime.snapshot(guild).reason, "reconnect_exhausted");
});

test("moved/kicked events never rejoin and repeated state notifications do not multiply monitoring timers", async (t) => {
  const f = fixture(t);
  await f.runtime.start(f.input);
  const baseline = f.scheduler.tasks.size;
  for (let i = 0; i < 30; i++) await f.runtime.notifyVoiceState(guild);
  assert.equal(f.scheduler.tasks.size, baseline);
  f.state.emit("moved");
  await flush();
  assert.equal(f.runtime.snapshot(guild).reason, "connection_lost");
  assert.equal(f.state.opens, 1);
});

test("stalled decoder and finite playback deadline both stop the owned process", async (t) => {
  const f = fixture(t);
  await f.runtime.start(f.input);
  f.state.metricsAt = f.scheduler.now;
  await f.scheduler.advance(10000);
  assert.equal(f.runtime.snapshot(guild).reason, "decoder_stalled");
  const other = fixture(t);
  await other.runtime.start(other.input);
  await other.scheduler.advance(130000);
  assert.equal(other.runtime.snapshot(guild).reason, "playback_timeout");
});

test("uncertain cleanup keeps the reservation until actual late closure confirms it", async (t) => {
  const f = fixture(t),
    closing = deferred();
  await f.runtime.start(f.input);
  f.state.close = () => closing.promise;
  const stopping = f.runtime.stop(guild);
  await flush();
  await f.scheduler.advance(5000);
  assert.equal((await stopping).cleanupPending, true);
  await assert.rejects(
    f.runtime.start({ ...f.input, requestId: "two" }),
    code("cleanup_unconfirmed"),
  );
  closing.resolve();
  await flush();
  assert.equal(f.runtime.snapshot(guild).cleanupPending, false);
  f.state.close = null;
});
