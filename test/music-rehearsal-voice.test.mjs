import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  ChannelType,
  Events,
  GatewayIntentBits,
  IntentsBitField,
  PermissionFlagsBits as P,
  Status,
} from "discord.js";
import {
  AudioPlayerStatus,
  NetworkingStatusCode,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import * as actualVoice from "@discordjs/voice";

const { AbortController } = globalThis;

const build = path.resolve(process.env.GILDIUSZ_MUSIC_VOICE_TEST_DIST ?? "dist");
const { createMusicRehearsalPorts } = await import(
  pathToFileURL(path.join(build, "bot/music-rehearsal-voice.js")).href
);
const ids = {
  app: "900000000000000001",
  bot: "900000000000000002",
  guild: "900000000000000101",
  channel: "900000000000000201",
  otherChannel: "900000000000000202",
  actor: "900000000000000301",
  otherOperator: "900000000000000302",
  stranger: "900000000000000303",
};
const request = { guildId: ids.guild, channelId: ids.channel, actorId: ids.actor };
const signal = () => new AbortController().signal;
const code = (value) => (error) => error?.code === value;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function fixture(options = {}) {
  let now = 100000;
  const calls = {
    guild: 0,
    roles: 0,
    channels: [],
    members: [],
    me: [],
    join: [],
    resources: [],
    players: [],
    payloads: [],
    unsubscribe: 0,
    stops: [],
    destroys: [],
    rejoins: [],
  };
  const client = new EventEmitter();
  client.user = { id: ids.bot };
  client.application = { id: ids.app };
  client.ws = { status: Status.Ready };
  client.isReady = () => true;
  client.options = {
    intents: new IntentsBitField([GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]),
  };
  client.voice = { adapters: new Map() };
  client.guilds = { cache: new Map() };
  const guild = {
    id: ids.guild,
    client,
    ownerId: ids.stranger,
    available: true,
    shard: { status: Status.Ready },
    features: [],
    voiceStates: { cache: new Map() },
    fetch: async () => {
      calls.guild++;
      if (options.onGuildFetch) await options.onGuildFetch();
      return guild;
    },
  };
  client.guilds.cache.set(guild.id, guild);
  const members = new Map();
  const permissions = new Map();
  const member = (memberId, bot = false) => {
    const allowed = new Set([P.ViewChannel, P.Connect, P.Speak]);
    const global = new Set([P.ManageGuild]);
    const value = {
      id: memberId,
      guild,
      user: { id: memberId, bot },
      pending: false,
      timeout: false,
      isCommunicationDisabled() {
        return this.timeout;
      },
      permissions: { has: (flag) => global.has(flag) },
      global,
    };
    permissions.set(memberId, allowed);
    members.set(memberId, value);
    return value;
  };
  const actor = member(ids.actor),
    me = member(ids.bot, true);
  const channel = {
    id: ids.channel,
    guild,
    type: ChannelType.GuildVoice,
    userLimit: 4,
    permissionsFor: (value) => ({ has: (flag) => permissions.get(value.id)?.has(flag) ?? false }),
  };
  guild.channels = {
    cache: new Map([[channel.id, channel]]),
    fetch: async (channelId, args) => {
      calls.channels.push([channelId, args]);
      if (options.onChannelFetch) await options.onChannelFetch();
      return guild.channels.cache.get(channelId);
    },
  };
  guild.roles = {
    fetch: async () => {
      calls.roles++;
      if (options.onRolesFetch) await options.onRolesFetch();
      return new Map();
    },
  };
  guild.members = {
    cache: members,
    fetch: async (args) => {
      calls.members.push(args);
      if (options.onMemberFetch) await options.onMemberFetch(args);
      return members.get(args.user);
    },
    fetchMe: async (args) => {
      calls.me.push(args);
      return me;
    },
  };
  const state = (memberId, channelId = ids.channel, extra = {}) => ({
    id: memberId,
    guild,
    member: members.get(memberId),
    channelId,
    selfMute: false,
    selfDeaf: memberId === ids.bot,
    serverMute: false,
    serverDeaf: false,
    ...extra,
  });
  const putState = (memberId, channelId = ids.channel, extra) => {
    const value = state(memberId, channelId, extra);
    guild.voiceStates.cache.set(memberId, value);
    return value;
  };
  putState(ids.actor);
  guild.voiceAdapterCreator = (methods) => {
    client.voice.adapters.set(guild.id, methods);
    return {
      sendPayload: (value) => {
        calls.payloads.push(value);
        return true;
      },
      destroy: () => {
        client.voice.adapters.delete(guild.id);
      },
    };
  };
  const defaultGroup = new Map(),
    groups = new Map([["default", defaultGroup]]);
  const connections = [];
  function readyState() {
    return {
      status: VoiceConnectionStatus.Ready,
      networking: {
        state: {
          code: NetworkingStatusCode.Ready,
          dave: { protocolVersion: 1, privateKey: "private-sentinel" },
          connectionData: {
            encryptionMode: "aead_aes256_gcm_rtpsize",
            secretKey: "secret-sentinel",
          },
          token: "token-sentinel",
        },
      },
    };
  }
  class Connection extends EventEmitter {
    constructor(config) {
      super();
      this.joinConfig = { ...config, group: "default" };
      this.state = readyState();
      this.ping = { ws: 12, udp: 19 };
      this.voicePrivacyCode = "privacy-sentinel";
      this.methods = { onVoiceServerUpdate() {}, onVoiceStateUpdate() {}, destroy() {} };
      this.adapter = config.adapterCreator(this.methods);
      Object.defineProperty(this, "receiver", {
        get() {
          throw new Error("Audio receiver must never be used");
        },
      });
    }
    setState(next) {
      const old = this.state;
      this.state = next;
      this.emit("stateChange", old, next);
    }
    subscribe(player) {
      this.player = player;
      return {
        unsubscribe: () => {
          calls.unsubscribe++;
          if (options.unsubscribeThrows) throw new Error("private-unsubscribe-detail");
        },
      };
    }
    rejoin(config) {
      calls.rejoins.push(config);
      this.setState({ status: VoiceConnectionStatus.Signalling });
      if (options.autoReconnect !== false) this.setState(readyState());
      return true;
    }
    destroy(available = true) {
      calls.destroys.push(available);
      if (options.destroyThrows) throw new Error("private-destroy-detail");
      if (available) this.adapter.sendPayload({ d: { channel_id: null } });
      this.setState({ status: VoiceConnectionStatus.Destroyed });
      this.adapter.destroy();
      if (defaultGroup.get(guild.id) === this) defaultGroup.delete(guild.id);
    }
  }
  class Player extends EventEmitter {
    constructor() {
      super();
      this.state = { status: AudioPlayerStatus.Idle };
    }
    setState(next) {
      const old = this.state;
      this.state = next;
      this.emit("stateChange", old, next);
    }
    play(resource) {
      this.resource = resource;
      this.setState({ status: AudioPlayerStatus.Buffering, resource });
    }
    start() {
      this.setState({
        status: AudioPlayerStatus.Playing,
        resource: this.resource,
        playbackDuration: 999999,
      });
    }
    idle() {
      this.setState({ status: AudioPlayerStatus.Idle });
    }
    stop(force) {
      calls.stops.push(force);
      this.idle();
      return true;
    }
  }
  const voice = {
    getGroups: () => groups,
    getVoiceConnections: () => defaultGroup,
    joinVoiceChannel(config) {
      calls.join.push(config);
      const connection = new Connection(config);
      connections.push(connection);
      defaultGroup.set(guild.id, connection);
      putState(ids.bot);
      return connection;
    },
    createAudioResource(input, args) {
      calls.resources.push(args);
      input.resume();
      return { playStream: new PassThrough(), playbackDuration: 0, ended: false };
    },
    createAudioPlayer(args) {
      calls.players.push(args);
      return new Player();
    },
  };
  const ports = createMusicRehearsalPorts(client, {
    operatorIds: [ids.actor, ids.otherOperator],
    clock: () => now,
    readyTimeoutMs: 2000,
    pollIntervalMs: 2,
    voice,
    ...options.adapterOptions,
  });
  async function openReady() {
    await ports.inspect(request, signal());
    const handle = ports.open(request, signal());
    await handle.ready(signal());
    return { handle, connection: connections.at(-1) };
  }
  async function play(handle) {
    await ports.inspect(request, signal());
    const input = new PassThrough();
    const playback = handle.play(input, signal());
    return {
      input,
      playback,
      player: connections.at(-1).player,
      resource: connections.at(-1).player.resource,
    };
  }
  return {
    client,
    guild,
    channel,
    actor,
    me,
    member,
    members,
    permissions,
    calls,
    ports,
    groups,
    defaultGroup,
    connections,
    readyState,
    putState,
    state,
    openReady,
    play,
    setNow: (value) => {
      now = value;
    },
  };
}

test("fresh inspection forces identity, resources and members, with timestamp before REST", async () => {
  let f;
  f = fixture({ onGuildFetch: () => f.setNow(100400) });
  assert.equal(f.calls.join.length, 0);
  assert.deepEqual(f.ports.identity(), {
    applicationId: ids.app,
    botUserId: ids.bot,
    gatewayReady: true,
  });
  const facts = await f.ports.inspect(request, signal());
  assert.equal(facts.observedAt, 100000);
  assert.equal(facts.actorChannelId, ids.channel);
  assert.equal(facts.humanCount, 1);
  assert.equal(f.calls.guild, 1);
  assert.equal(f.calls.roles, 1);
  assert.deepEqual(f.calls.channels, [[ids.channel, { force: true }]]);
  assert.deepEqual(f.calls.members, [{ user: ids.actor, force: true }]);
  assert.deepEqual(f.calls.me, [{ force: true }]);
  assert.equal(f.client.listenerCount(Events.VoiceStateUpdate), 0);
  f.actor.global.delete(P.ManageGuild);
  const revoked = await f.ports.inspect(request, signal());
  assert.equal(revoked.manageGuild, false);
  assert.throws(() => f.ports.open(request, signal()), code("permission_revoked"));
  assert.equal(f.calls.join.length, 0);
});

test("Gateway readiness, voice intent and known member facts are mandatory before a join", async () => {
  for (const change of [
    (f) => {
      f.client.ws.status = Status.Disconnected;
    },
    (f) => {
      f.client.options.intents = new IntentsBitField([GatewayIntentBits.Guilds]);
    },
    (f) => {
      f.guild.shard.status = Status.Connecting;
    },
    (f) => {
      f.guild.available = false;
    },
    (f) => {
      f.guild.voiceStates.cache.get(ids.actor).selfDeaf = null;
    },
    (f) => {
      f.guild.voiceStates.cache.get(ids.actor).member = null;
    },
    (f) => {
      f.actor.pending = true;
    },
    (f) => {
      f.actor.timeout = true;
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(f.ports.inspect(request, signal()));
    assert.equal(f.calls.join.length, 0);
  }
});

test("only known human operators may share the rehearsal channel", async () => {
  for (const [memberId, bot] of [
    [ids.stranger, false],
    [ids.otherOperator, true],
  ]) {
    const f = fixture();
    f.member(memberId, bot);
    f.putState(memberId);
    await assert.rejects(f.ports.inspect(request, signal()), code("channel_unavailable"));
    assert.equal(f.calls.join.length, 0);
  }
  const f = fixture();
  f.member(ids.otherOperator);
  f.putState(ids.otherOperator);
  assert.equal((await f.ports.inspect(request, signal())).humanCount, 2);
  assert.deepEqual(
    f.calls.members.map((value) => value.user),
    [ids.actor, ids.otherOperator],
  );
});

test("a voice out-and-back while REST is pending invalidates the inspection", async () => {
  const gate = deferred();
  const f = fixture({ onRolesFetch: () => gate.promise });
  const inspecting = f.ports.inspect(request, signal());
  await delay(0);
  const before = f.guild.voiceStates.cache.get(ids.actor);
  const away = f.putState(ids.actor, ids.otherChannel);
  f.client.emit(Events.VoiceStateUpdate, before, away);
  const back = f.putState(ids.actor);
  f.client.emit(Events.VoiceStateUpdate, away, back);
  gate.resolve();
  await assert.rejects(inspecting, code("stale_facts"));
  assert.equal(f.client.listenerCount(Events.VoiceStateUpdate), 0);
  assert.throws(() => f.ports.open(request, signal()), code("stale_facts"));
});

test("abort removes pending inspection listeners and a late REST result cannot authorize open", async () => {
  const gate = deferred(),
    abort = new AbortController();
  const f = fixture({ onGuildFetch: () => gate.promise });
  const inspecting = f.ports.inspect(request, abort.signal);
  assert.equal(f.client.listenerCount(Events.VoiceStateUpdate), 1);
  abort.abort();
  await assert.rejects(inspecting, code("cancelled"));
  assert.equal(f.client.listenerCount(Events.VoiceStateUpdate), 0);
  gate.resolve();
  await delay(0);
  assert.throws(() => f.ports.open(request, signal()), code("stale_facts"));
});

test("join admission is fresh, single-use and rechecks known permission changes", async () => {
  const f = fixture();
  assert.throws(() => f.ports.open(request, signal()), code("stale_facts"));
  await f.ports.inspect(request, signal());
  f.setNow(105001);
  assert.throws(() => f.ports.open(request, signal()), code("stale_facts"));
  f.setNow(100000);
  await f.ports.inspect(request, signal());
  f.permissions.get(ids.bot).delete(P.Speak);
  assert.throws(() => f.ports.open(request, signal()), code("permission_revoked"));
  f.permissions.get(ids.bot).add(P.Speak);
  assert.throws(() => f.ports.open(request, signal()), code("stale_facts"));
  await f.ports.inspect(request, signal());
  f.putState(ids.actor, ids.otherChannel);
  assert.throws(() => f.ports.open(request, signal()), code("stale_facts"));
  assert.equal(f.calls.join.length, 0);
});

test("existing default or alternate-group sessions cannot be adopted or bypassed", async () => {
  for (const groupName of ["default", "foreign"]) {
    const f = fixture(),
      foreign = { destroy: () => assert.fail("foreign connection destroyed") };
    if (groupName === "default") f.defaultGroup.set(ids.guild, foreign);
    else f.groups.set(groupName, new Map([[ids.guild, foreign]]));
    await f.ports.inspect(request, signal());
    assert.throws(() => f.ports.open(request, signal()), code("channel_busy"));
    assert.equal(f.calls.join.length, 0);
    assert.equal(f.groups.get(groupName).get(ids.guild), foreign);
  }
});

test("an adapter registered outside this SDK instance blocks join and later replacement revokes ownership", async () => {
  const blocked = fixture(),
    foreign = {};
  blocked.client.voice.adapters.set(ids.guild, foreign);
  await blocked.ports.inspect(request, signal());
  assert.throws(() => blocked.ports.open(request, signal()), code("channel_busy"));
  assert.equal(blocked.calls.join.length, 0);
  assert.equal(blocked.client.voice.adapters.get(ids.guild), foreign);
  const f = fixture(),
    { handle } = await f.openReady();
  f.client.voice.adapters.set(ids.guild, foreign);
  assert.equal(handle.evidence(), null);
  await f.ports.inspect(request, signal());
  assert.throws(() => handle.play(new PassThrough(), signal()), code("transport_unverified"));
  await f.ports.inspect(request, signal());
  await assert.rejects(handle.reconnect(signal()), code("session_conflict"));
  await assert.rejects(handle.ready(signal()), code("connection_lost"));
  await handle.close();
  assert.deepEqual(f.calls.destroys, [false]);
  assert.equal(f.client.voice.adapters.get(ids.guild), foreign);
  assert.equal(f.calls.payloads.length, 0);
});

test("an actual SDK join throwing after tracking is reclaimed without opening a network", async () => {
  const f = fixture({ adapterOptions: { voice: actualVoice } });
  let tracked;
  f.guild.voiceAdapterCreator = (methods) => {
    f.client.voice.adapters.set(ids.guild, methods);
    return {
      sendPayload() {
        tracked = actualVoice.getVoiceConnections().get(ids.guild);
        throw new Error("private-gateway-detail");
      },
      destroy() {
        f.client.voice.adapters.delete(ids.guild);
      },
    };
  };
  await f.ports.inspect(request, signal());
  assert.throws(() => f.ports.open(request, signal()), code("connection_lost"));
  assert.ok(tracked);
  assert.equal(tracked.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(actualVoice.getVoiceConnections().has(ids.guild), false);
  assert.equal(f.client.voice.adapters.has(ids.guild), false);
  assert.equal(tracked.listenerCount("error"), 0);
});

test("Ready waits for DAVE, privacy-code presence and a finite WebSocket ping", async () => {
  const f = fixture();
  await f.ports.inspect(request, signal());
  const handle = f.ports.open(request, signal()),
    connection = f.connections.at(-1);
  assert.equal(f.calls.join[0].selfDeaf, true);
  assert.equal(f.calls.join[0].selfMute, false);
  connection.state.networking.state.dave.protocolVersion = 0;
  connection.voicePrivacyCode = "";
  connection.ping.ws = undefined;
  connection.ping.udp = 20;
  let resolved = false;
  const ready = handle.ready(signal()).then((value) => {
    resolved = true;
    return value;
  });
  await delay(8);
  assert.equal(resolved, false);
  assert.equal(handle.evidence(), null);
  connection.state.networking.state.dave.protocolVersion = 1;
  connection.voicePrivacyCode = "privacy-sentinel";
  await delay(8);
  assert.equal(resolved, false);
  connection.ping.ws = 12;
  const evidence = await ready;
  assert.deepEqual(evidence, {
    channelId: ids.channel,
    ready: true,
    daveProtocolVersion: 1,
    hasVoicePrivacyCode: true,
    encryptionMode: "aead_aes256_gcm_rtpsize",
    wsPingMs: 12,
    udpEstablished: true,
    udpPingMs: 20,
    playedMilliseconds: 0,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /sentinel|secretKey|token|privateKey/);
  await handle.close();
});

test("the real SDK ping getter's absent UDP RTT is nullable only after NetworkingReady", async () => {
  const f = fixture();
  await f.ports.inspect(request, signal());
  const handle = f.ports.open(request, signal()),
    connection = f.connections.at(-1);
  const network = connection.state.networking.state;
  network.ws = { ping: 12 };
  // SDK0.19.2 declares this deprecated field, but never assigns a UDP RTT.
  network.udp = {};
  const getPing = Object.getOwnPropertyDescriptor(
    actualVoice.VoiceConnection.prototype,
    "ping",
  ).get;
  Object.defineProperty(connection, "ping", { get: () => getPing.call(connection) });
  assert.equal(connection.ping.udp, undefined);
  for (const code of [
    NetworkingStatusCode.UdpHandshaking,
    NetworkingStatusCode.SelectingProtocol,
    NetworkingStatusCode.Resuming,
  ]) {
    network.code = code;
    assert.equal(handle.evidence(), null);
  }
  network.code = NetworkingStatusCode.Ready;
  const evidence = await handle.ready(signal());
  assert.equal(evidence.udpEstablished, true);
  assert.equal(evidence.udpPingMs, null);
  assert.equal(evidence.wsPingMs, 12);
  for (const invalid of [Number.NaN, Infinity, -1, null, "12"]) {
    network.udp.ping = invalid;
    assert.equal(handle.evidence(), null);
  }
  delete network.udp.ping;
  network.ws.ping = undefined;
  assert.equal(handle.evidence(), null);
  network.ws.ping = 12;
  assert.equal(handle.evidence().udpPingMs, null);
  await handle.close();
});

test("unverified ready is bounded and abort/close cleans waits", async () => {
  const f = fixture({ adapterOptions: { readyTimeoutMs: 12 } });
  await f.ports.inspect(request, signal());
  const handle = f.ports.open(request, signal());
  f.connections.at(-1).voicePrivacyCode = "";
  await assert.rejects(handle.ready(signal()), code("voice_timeout"));
  const abort = new AbortController(),
    waiting = handle.ready(abort.signal);
  abort.abort();
  await assert.rejects(waiting, code("cancelled"));
  const waitingOnClose = handle.ready(signal());
  await handle.close();
  await assert.rejects(waitingOnClose, code("cancelled"));
  assert.equal(f.client.listenerCount(Events.VoiceStateUpdate), 0);
});

test("Ogg Opus playback counts real resource progress and completes only after EOF plus own Idle", async () => {
  const f = fixture(),
    { handle } = await f.openReady();
  const { input, playback, player, resource } = await f.play(handle);
  assert.deepEqual(f.calls.resources, [{ inputType: StreamType.OggOpus, inlineVolume: false }]);
  assert.deepEqual(f.calls.players, [{ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }]);
  let started = false,
    finished = false;
  void playback.started.then(() => {
    started = true;
  });
  void playback.finished.then(() => {
    finished = true;
  });
  await delay(0);
  assert.equal(started, false);
  player.start();
  await playback.started;
  resource.playbackDuration = 40;
  assert.equal(handle.evidence().playedMilliseconds, 40);
  assert.equal(player.state.playbackDuration, 999999);
  input.end(Buffer.from([1, 2, 3]));
  await delay(0);
  assert.equal(finished, false);
  resource.ended = true;
  player.idle();
  await playback.finished;
  assert.equal(handle.evidence().playedMilliseconds, 40);
  await handle.close();
  assert.equal(resource.playStream.destroyed, true);
  assert.equal(input.destroyed, true);
});

test("premature Idle and decoder/player errors reject rather than report successful completion", async () => {
  for (const mode of ["premature", "player", "decoder"]) {
    const f = fixture(),
      { handle } = await f.openReady();
    const { input, playback, player } = await f.play(handle);
    player.start();
    await playback.started;
    if (mode === "premature") player.idle();
    else if (mode === "player") player.emit("error", new Error("private-player-message"));
    else input.emit("error", new Error("private-decoder-message"));
    await assert.rejects(
      playback.finished,
      code(mode === "premature" ? "playback_incomplete" : "decoder_failed"),
    );
    await handle.close();
  }
});

test("reconnect keeps the owned connection and does not duplicate SDK automatic recovery", async () => {
  const f = fixture(),
    { handle, connection } = await f.openReady();
  connection.setState({
    status: VoiceConnectionStatus.Disconnected,
    reason: VoiceConnectionDisconnectReason.EndpointRemoved,
  });
  await f.ports.inspect(request, signal());
  await handle.reconnect(signal());
  assert.equal(f.calls.join.length, 1);
  assert.equal(f.calls.rejoins.length, 1);
  connection.setState({ status: VoiceConnectionStatus.Signalling });
  await f.ports.inspect(request, signal());
  const reconnecting = handle.reconnect(signal());
  connection.setState(f.readyState());
  await reconnecting;
  assert.equal(f.calls.rejoins.length, 1);
  connection.setState({
    status: VoiceConnectionStatus.Disconnected,
    reason: VoiceConnectionDisconnectReason.WebSocketClose,
    closeCode: 4014,
  });
  await f.ports.inspect(request, signal());
  await assert.rejects(handle.reconnect(signal()), code("connection_lost"));
  assert.equal(f.calls.rejoins.length, 1);
  await handle.close();
});

test("foreign members, bot moves and repeated recovery emit bounded terminal events", async () => {
  const f = fixture(),
    { handle, connection } = await f.openReady(),
    events = [];
  handle.onEvent((event) => events.push(event));
  f.member(ids.stranger);
  const stranger = f.putState(ids.stranger);
  f.client.emit(Events.VoiceStateUpdate, { ...stranger, channelId: null }, stranger);
  assert.equal(events.at(-1), "permission_lost");
  f.guild.voiceStates.cache.delete(ids.stranger);
  const old = f.guild.voiceStates.cache.get(ids.bot),
    moved = f.putState(ids.bot, ids.otherChannel);
  f.client.emit(Events.VoiceStateUpdate, old, moved);
  assert.equal(events.at(-1), "moved");
  for (let index = 0; index < 3; index++) {
    connection.setState({ status: VoiceConnectionStatus.Signalling });
    connection.setState(f.readyState());
  }
  assert.equal(events.includes("error"), true);
  await handle.close();
  assert.deepEqual(f.calls.destroys, [false]);
  assert.equal(f.calls.payloads.length, 0);
});

test("cleanup is idempotent and removes only owned listeners and resources", async () => {
  const f = fixture(),
    otherVoiceListener = () => {},
    { handle, connection } = await f.openReady();
  f.client.on(Events.VoiceStateUpdate, otherVoiceListener);
  const { input, playback, player, resource } = await f.play(handle);
  player.start();
  await playback.started;
  await Promise.all([handle.close(), handle.close()]);
  await assert.rejects(playback.finished, code("cancelled"));
  assert.deepEqual(f.calls.stops, [true]);
  assert.equal(f.calls.unsubscribe, 1);
  assert.deepEqual(f.calls.destroys, [true]);
  assert.equal(connection.listenerCount("error"), 0);
  assert.equal(connection.listenerCount("stateChange"), 0);
  assert.equal(player.listenerCount("error"), 0);
  assert.equal(player.listenerCount("stateChange"), 0);
  assert.equal(f.client.listenerCount(Events.VoiceStateUpdate), 1);
  assert.equal(f.client.listeners(Events.VoiceStateUpdate)[0], otherVoiceListener);
  assert.equal(resource.playStream.destroyed, true);
  assert.equal(input.destroyed, true);
  assert.equal(f.defaultGroup.has(ids.guild), false);
  assert.equal(f.client.voice.adapters.has(ids.guild), false);
});

test("closing an old connection preserves a replacement connection and guild adapter", async () => {
  const f = fixture(),
    { handle } = await f.openReady();
  const replacement = { destroy: () => assert.fail("replacement destroyed") },
    foreignMethods = {};
  f.defaultGroup.set(ids.guild, replacement);
  f.client.voice.adapters.set(ids.guild, foreignMethods);
  await handle.close();
  assert.deepEqual(f.calls.destroys, [false]);
  assert.equal(f.calls.payloads.length, 0);
  assert.equal(f.defaultGroup.get(ids.guild), replacement);
  assert.equal(f.client.voice.adapters.get(ids.guild), foreignMethods);
});

test("cleanup failure still attempts the remaining resources and stays failed on repeated close", async () => {
  const f = fixture({ unsubscribeThrows: true }),
    { handle, connection } = await f.openReady();
  const { input, resource } = await f.play(handle);
  await assert.rejects(handle.close(), code("cleanup_unconfirmed"));
  assert.deepEqual(f.calls.stops, [true]);
  assert.deepEqual(f.calls.destroys, [true]);
  assert.equal(connection.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(resource.playStream.destroyed, true);
  assert.equal(input.destroyed, true);
  await assert.rejects(handle.close(), code("cleanup_unconfirmed"));
  assert.equal(f.calls.unsubscribe, 1);
  f.guild.voiceStates.cache.delete(ids.bot);
  await f.ports.inspect(request, signal());
  assert.throws(() => f.ports.open(request, signal()), code("channel_busy"));
});
