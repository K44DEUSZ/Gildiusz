import {
  ChannelType,
  Events,
  GatewayIntentBits,
  GuildFeature,
  PermissionFlagsBits as P,
  Status,
  type Client,
  type Guild,
  type GuildMember,
  type VoiceChannel,
  type VoiceState,
} from "discord.js";
import * as sdk from "@discordjs/voice";
import type { Readable } from "node:stream";
import {
  RehearsalError,
  type RehearsalFacts,
  type RehearsalPlayback,
  type RehearsalPorts,
  type VoiceEvent,
  type VoiceEvidence,
} from "../modules/music-rehearsal/types.js";

type VoiceBindings = Pick<
  typeof sdk,
  | "joinVoiceChannel"
  | "getGroups"
  | "getVoiceConnections"
  | "createAudioPlayer"
  | "createAudioResource"
>;
export interface MusicRehearsalVoiceOptions {
  operatorIds: readonly string[];
  clock?: () => number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /** An SDK substitute for offline tests. The default is the pinned @discordjs/voice package. */
  voice?: VoiceBindings;
}
interface Inspection {
  facts: RehearsalFacts;
  guild: Guild;
  channel: VoiceChannel;
  stamp: string;
}
interface Playback {
  resource?: sdk.AudioResource;
  input: Readable;
  started: boolean;
  ended: boolean;
  settleStarted(error?: RehearsalError): void;
  settleFinished(error?: RehearsalError): void;
  detach(): void;
}
const id = (value: unknown): value is string =>
  typeof value === "string" && /^\d{17,20}$/.test(value);
const destroyed = (connection: sdk.VoiceConnection) =>
  connection.state.status === sdk.VoiceConnectionStatus.Destroyed;
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new RehearsalError("cancelled");
};
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new RehearsalError("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(new RehearsalError("cancelled"));
        else resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(new RehearsalError("channel_unavailable"));
      },
    );
  });
}
function completion(): { promise: Promise<void>; settle(error?: RehearsalError): void } {
  let done = false,
    yes: () => void = () => {},
    no: (error: RehearsalError) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    yes = resolve;
    no = reject;
  });
  void promise.catch(() => {});
  return {
    promise,
    settle(error) {
      if (done) return;
      done = true;
      if (error) no(error);
      else yes();
    },
  };
}

/** No client construction/login and no audio receiver. All effects use this exact existing Client. */
export function createMusicRehearsalPorts(
  client: Client,
  options: MusicRehearsalVoiceOptions,
): RehearsalPorts {
  if (
    !Array.isArray(options.operatorIds) ||
    !options.operatorIds.length ||
    options.operatorIds.length > 16 ||
    options.operatorIds.some((value) => !id(value)) ||
    new Set(options.operatorIds).size !== options.operatorIds.length
  )
    throw new RehearsalError("invalid_input");
  const operators = new Set(options.operatorIds),
    voice = options.voice ?? sdk,
    clock = options.clock ?? Date.now;
  const timeoutMs = options.readyTimeoutMs ?? 20000,
    pollMs = options.pollIntervalMs ?? 50;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 20000 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 250
  )
    throw new RehearsalError("invalid_input");
  const inspections = new Map<string, Inspection>();
  const owned = new Map<string, sdk.VoiceConnection>();
  const currentTime = () => {
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new RehearsalError("stale_facts");
    return now;
  };
  const clientReady = () =>
    client.isReady() &&
    client.ws.status === Status.Ready &&
    client.options.intents.has(GatewayIntentBits.GuildVoiceStates) &&
    id(client.user?.id) &&
    id(client.application?.id);
  function guildReady(guild: Guild): boolean {
    return Boolean(
      clientReady() &&
      guild.client === client &&
      guild.available === true &&
      guild.shard.status === Status.Ready &&
      client.guilds.cache.get(guild.id) === guild,
    );
  }
  function roster(guild: Guild, channelId: string): VoiceState[] {
    if (!guildReady(guild)) throw new RehearsalError("identity_mismatch");
    const entries = [...guild.voiceStates.cache.values()].filter(
      (value) => value.channelId === channelId,
    );
    if (entries.length > operators.size + 1) throw new RehearsalError("channel_unavailable");
    const seen = new Set<string>();
    for (const state of entries) {
      const member = state.member;
      if (
        !id(state.id) ||
        state.guild.id !== guild.id ||
        seen.has(state.id) ||
        (state.id !== client.user!.id && !operators.has(state.id)) ||
        !member ||
        member.guild.id !== guild.id ||
        member.id !== state.id ||
        member.user.id !== state.id ||
        typeof member.user.bot !== "boolean" ||
        (state.id === client.user!.id ? !member.user.bot : member.user.bot) ||
        ![true, false].includes(state.selfMute as boolean) ||
        ![true, false].includes(state.selfDeaf as boolean) ||
        ![true, false].includes(state.serverDeaf as boolean) ||
        ![true, false].includes(state.serverMute as boolean)
      )
        throw new RehearsalError("channel_unavailable");
      seen.add(state.id);
    }
    return entries;
  }
  const stamp = (entries: readonly VoiceState[]) =>
    entries
      .map((state) =>
        [
          state.id,
          state.channelId,
          state.selfMute,
          state.selfDeaf,
          state.serverDeaf,
          state.serverMute,
        ].join(":"),
      )
      .sort()
      .join("|");
  const pending = (guild: Guild, member: GuildMember) =>
    typeof member.pending === "boolean"
      ? member.pending
      : guild.features.includes(GuildFeature.MemberVerificationGateEnabled)
        ? null
        : false;
  function safeMember(guild: Guild, member: GuildMember, memberId: string): void {
    if (
      member.guild.id !== guild.id ||
      member.id !== memberId ||
      member.user.id !== memberId ||
      typeof member.user.bot !== "boolean" ||
      member.isCommunicationDisabled() ||
      pending(guild, member) !== false ||
      (memberId === client.user!.id ? !member.user.bot : member.user.bot)
    )
      throw new RehearsalError("permission_revoked");
  }
  function registryOwns(
    guildId: string,
    connection: sdk.VoiceConnection,
    adapterMethods: unknown,
  ): boolean {
    return (
      adapterMethods !== undefined &&
      client.voice.adapters.get(guildId) === adapterMethods &&
      voice.getVoiceConnections()?.get(guildId) === connection &&
      [...voice.getGroups().values()].every(
        (group) => !group.has(guildId) || group.get(guildId) === connection,
      )
    );
  }
  function consume(guildId: string, channelId: string, running: boolean): Inspection {
    const inspection = inspections.get(guildId);
    inspections.delete(guildId);
    if (
      !inspection ||
      inspection.facts.channelId !== channelId ||
      !guildReady(inspection.guild) ||
      currentTime() < inspection.facts.observedAt ||
      currentTime() - inspection.facts.observedAt > 5000 ||
      inspection.stamp !== stamp(roster(inspection.guild, channelId))
    )
      throw new RehearsalError("stale_facts");
    const facts = inspection.facts;
    const actor = inspection.guild.members.cache.get(facts.actorId),
      me = inspection.guild.members.cache.get(client.user!.id);
    if (!actor || !me || inspection.guild.channels.cache.get(channelId) !== inspection.channel)
      throw new RehearsalError("stale_facts");
    safeMember(inspection.guild, actor, actor.id);
    safeMember(inspection.guild, me, me.id);
    const actorPermissions = inspection.channel.permissionsFor(actor),
      botPermissions = inspection.channel.permissionsFor(me);
    if (
      (inspection.guild.ownerId !== actor.id && !actor.permissions.has(P.ManageGuild)) ||
      !actorPermissions?.has(P.ViewChannel) ||
      !actorPermissions.has(P.Connect) ||
      !botPermissions?.has(P.ViewChannel) ||
      !botPermissions.has(P.Connect) ||
      !botPermissions.has(P.Speak)
    )
      throw new RehearsalError("permission_revoked");
    if (
      !facts.memberPresent ||
      facts.actorIsBot ||
      (!facts.owner && !facts.manageGuild) ||
      facts.pending !== false ||
      facts.timedOut ||
      !facts.viewChannel ||
      !facts.connect ||
      !facts.speak ||
      facts.humanCount < 1 ||
      (running
        ? facts.botChannelId !== channelId
        : facts.botChannelId !== null ||
          facts.actorChannelId !== channelId ||
          (facts.userLimit > 0 && facts.memberCount >= facts.userLimit))
    )
      throw new RehearsalError("permission_revoked");
    return inspection;
  }
  return {
    identity: () => ({
      applicationId: client.application?.id ?? "",
      botUserId: client.user?.id ?? "",
      gatewayReady: Boolean(clientReady()),
    }),
    inspect: async (input, signal) => {
      check(signal);
      inspections.delete(input.guildId);
      if (
        !operators.has(input.actorId) ||
        !id(input.guildId) ||
        !id(input.channelId) ||
        !clientReady()
      )
        throw new RehearsalError("permission_revoked");
      const cached = client.guilds.cache.get(input.guildId);
      if (!cached || !guildReady(cached)) throw new RehearsalError("channel_unavailable");
      const observedAt = currentTime(),
        before = stamp(roster(cached, input.channelId));
      let changed = false;
      const changing = (old: VoiceState, next: VoiceState) => {
        if (
          next.guild.id === input.guildId &&
          (old.channelId === input.channelId ||
            next.channelId === input.channelId ||
            next.id === input.actorId ||
            next.id === client.user!.id)
        )
          changed = true;
      };
      client.on(Events.VoiceStateUpdate, changing);
      try {
        const guild = await abortable(cached.fetch(), signal);
        if (guild.id !== input.guildId || !guildReady(guild))
          throw new RehearsalError("channel_unavailable");
        const [roles, channel, actor, me] = await abortable(
          Promise.all([
            guild.roles.fetch(),
            guild.channels.fetch(input.channelId, { force: true }),
            guild.members.fetch({ user: input.actorId, force: true }),
            guild.members.fetchMe({ force: true }),
          ]),
          signal,
        );
        check(signal);
        if (
          !roles ||
          !channel ||
          channel.guild.id !== guild.id ||
          channel.id !== input.channelId ||
          channel.type !== ChannelType.GuildVoice
        )
          throw new RehearsalError("channel_unavailable");
        safeMember(guild, actor, input.actorId);
        safeMember(guild, me, client.user!.id);
        const entries = roster(guild, channel.id);
        if (changed || before !== stamp(entries)) throw new RehearsalError("stale_facts");
        const members = new Map([
          [actor.id, actor],
          [me.id, me],
        ]);
        for (const state of entries)
          if (!members.has(state.id))
            members.set(
              state.id,
              await abortable(guild.members.fetch({ user: state.id, force: true }), signal),
            );
        for (const [memberId, member] of members) safeMember(guild, member, memberId);
        check(signal);
        const after = roster(guild, channel.id);
        if (
          changed ||
          before !== stamp(after) ||
          currentTime() < observedAt ||
          currentTime() - observedAt > 5000
        )
          throw new RehearsalError("stale_facts");
        const botPermissions = channel.permissionsFor(me),
          actorPermissions = channel.permissionsFor(actor);
        const botState = guild.voiceStates.cache.get(me.id);
        const facts: RehearsalFacts = {
          observedAt,
          guildId: guild.id,
          channelId: channel.id,
          actorId: actor.id,
          gatewayReady: guildReady(guild),
          channelKind: "voice",
          memberPresent: true,
          actorIsBot: actor.user.bot,
          owner: actor.id === guild.ownerId,
          manageGuild: actor.permissions.has(P.ManageGuild),
          pending: pending(guild, actor),
          timedOut: actor.isCommunicationDisabled(),
          actorChannelId: guild.voiceStates.cache.get(actor.id)?.channelId ?? null,
          botChannelId: botState?.channelId ?? null,
          viewChannel: Boolean(
            botPermissions?.has(P.ViewChannel) && actorPermissions?.has(P.ViewChannel),
          ),
          connect: Boolean(botPermissions?.has(P.Connect) && actorPermissions?.has(P.Connect)),
          speak: Boolean(
            botPermissions?.has(P.Speak) &&
            (botState?.channelId !== channel.id || botState.serverMute === false),
          ),
          humanCount: after.filter(
            (state) => state.id !== me.id && state.selfDeaf === false && state.serverDeaf === false,
          ).length,
          userLimit: channel.userLimit,
          memberCount: after.length,
        };
        inspections.set(guild.id, { facts, guild, channel, stamp: before });
        return { ...facts };
      } catch (error) {
        if (error instanceof RehearsalError) throw error;
        throw new RehearsalError("channel_unavailable");
      } finally {
        client.off(Events.VoiceStateUpdate, changing);
      }
    },
    open: (input, signal) => {
      check(signal);
      const inspection = consume(input.guildId, input.channelId, false),
        guild = inspection.guild;
      if (
        owned.has(guild.id) ||
        client.voice.adapters.has(guild.id) ||
        voice.getVoiceConnections()?.has(guild.id) ||
        [...voice.getGroups().values()].some((group) => group.has(guild.id))
      )
        throw new RehearsalError("channel_busy");
      let adapterMethods: Parameters<typeof guild.voiceAdapterCreator>[0] | undefined;
      let adapter: ReturnType<typeof guild.voiceAdapterCreator> | undefined;
      let ownedAdapter: ReturnType<typeof guild.voiceAdapterCreator> | undefined;
      let connection: sdk.VoiceConnection;
      try {
        connection = voice.joinVoiceChannel({
          guildId: guild.id,
          channelId: input.channelId,
          selfDeaf: true,
          selfMute: false,
          adapterCreator: (methods) => {
            adapterMethods = methods;
            adapter = guild.voiceAdapterCreator(methods);
            ownedAdapter = {
              sendPayload: (payload) =>
                client.voice.adapters.get(guild.id) === methods && adapter!.sendPayload(payload),
              destroy: () => {
                if (client.voice.adapters.get(guild.id) === methods) adapter!.destroy();
              },
            };
            return ownedAdapter;
          },
        });
      } catch {
        // SDK tracks before sending the Gateway payload; a throw can precede the return handoff.
        const candidate = voice.getVoiceConnections()?.get(guild.id);
        let failed = false;
        if (
          candidate &&
          ownedAdapter &&
          candidate.joinConfig.guildId === guild.id &&
          candidate.joinConfig.channelId === input.channelId &&
          candidate.state.status !== sdk.VoiceConnectionStatus.Destroyed &&
          candidate.state.adapter === ownedAdapter
        ) {
          const guardError = () => {};
          candidate.on("error", guardError);
          try {
            candidate.destroy(false);
          } catch {
            failed = true;
          }
          if (!destroyed(candidate)) failed = true;
          if (failed) owned.set(guild.id, candidate);
          else candidate.off("error", guardError);
        }
        if (adapterMethods && client.voice.adapters.get(guild.id) === adapterMethods) {
          try {
            adapter?.destroy();
          } catch {
            failed = true;
          }
        }
        if (failed) throw new RehearsalError("cleanup_unconfirmed");
        throw new RehearsalError("connection_lost");
      }
      owned.set(guild.id, connection);
      let closed = false,
        closePromise: Promise<void> | undefined,
        player: sdk.AudioPlayer | undefined,
        subscription: sdk.PlayerSubscription | undefined,
        playback: Playback | undefined;
      let everReady = false,
        recoveries = 0;
      const lifetime = new AbortController(),
        listeners = new Set<(event: VoiceEvent) => void>();
      const emit = (event: VoiceEvent) => {
        if (!closed) for (const listener of [...listeners]) listener(event);
      };
      const evidence = (): VoiceEvidence | null => {
        if (
          closed ||
          !guildReady(guild) ||
          !registryOwns(guild.id, connection, adapterMethods) ||
          connection.joinConfig.channelId !== input.channelId
        )
          return null;
        const state = connection.state;
        if (state.status !== sdk.VoiceConnectionStatus.Ready) return null;
        const network = state.networking.state;
        if (network.code !== sdk.NetworkingStatusCode.Ready) return null;
        const protocol = network.dave?.protocolVersion,
          mode = network.connectionData.encryptionMode,
          ping = connection.ping;
        if (
          !Number.isSafeInteger(protocol) ||
          !protocol ||
          protocol < 1 ||
          !connection.voicePrivacyCode ||
          !["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"].includes(mode) ||
          !Number.isFinite(ping.ws) ||
          ping.ws === undefined ||
          ping.ws < 0 ||
          (ping.udp !== undefined && (!Number.isFinite(ping.udp) || ping.udp < 0))
        )
          return null;
        const playedMilliseconds = playback?.resource?.playbackDuration ?? 0;
        if (!Number.isSafeInteger(playedMilliseconds) || playedMilliseconds < 0) return null;
        return {
          channelId: input.channelId,
          ready: true,
          daveProtocolVersion: protocol,
          hasVoicePrivacyCode: true,
          encryptionMode:
            mode === "aead_aes256_gcm_rtpsize" ? mode : "aead_xchacha20_poly1305_rtpsize",
          wsPingMs: ping.ws,
          // SDK0.19.2 no longer updates UDP RTT. Ready is reached after UDP IP discovery.
          udpEstablished: true,
          udpPingMs: ping.udp === undefined ? null : ping.udp,
          playedMilliseconds,
        };
      };
      const failPlayback = (code: "cancelled" | "decoder_failed" | "playback_incomplete") => {
        playback?.settleStarted(new RehearsalError(code));
        playback?.settleFinished(new RehearsalError(code));
      };
      const onConnectionError = () => {
        failPlayback("decoder_failed");
        emit("error");
      };
      const onConnectionState = (old: sdk.VoiceConnectionState, next: sdk.VoiceConnectionState) => {
        if (closed) return;
        if (next.status === sdk.VoiceConnectionStatus.Ready) everReady = true;
        if (next.status === sdk.VoiceConnectionStatus.Signalling && everReady && ++recoveries > 2) {
          emit("error");
          return;
        }
        if (
          next.status === sdk.VoiceConnectionStatus.Destroyed ||
          (next.status === sdk.VoiceConnectionStatus.Disconnected &&
            next.reason === sdk.VoiceConnectionDisconnectReason.WebSocketClose &&
            next.closeCode === 4014)
        )
          emit("kicked");
        else if (
          next.status === sdk.VoiceConnectionStatus.Disconnected ||
          (old.status === sdk.VoiceConnectionStatus.Ready &&
            next.status !== sdk.VoiceConnectionStatus.Ready)
        )
          emit("disconnected");
      };
      const onVoiceState = (old: VoiceState, next: VoiceState) => {
        if (closed || next.guild.id !== guild.id) return;
        if (next.id === client.user!.id) {
          if (next.channelId !== input.channelId) emit(next.channelId ? "moved" : "kicked");
          else if (next.serverMute !== false) emit("permission_lost");
        } else if (old.channelId === input.channelId || next.channelId === input.channelId) {
          try {
            roster(guild, input.channelId);
          } catch {
            emit("permission_lost");
          }
        }
      };
      connection.on("error", onConnectionError);
      connection.on("stateChange", onConnectionState);
      client.on(Events.VoiceStateUpdate, onVoiceState);
      const wait = (inputSignal: AbortSignal): Promise<VoiceEvidence> =>
        new Promise((resolve, reject) => {
          const combined = AbortSignal.any([inputSignal, lifetime.signal]);
          let poll: ReturnType<typeof setTimeout> | undefined;
          const clear = () => {
            clearTimeout(poll);
            clearTimeout(deadline);
            combined.removeEventListener("abort", abort);
          };
          const fail = (code: "cancelled" | "voice_timeout" | "connection_lost") => {
            clear();
            reject(new RehearsalError(code));
          };
          const abort = () => fail("cancelled");
          const deadline = setTimeout(() => fail("voice_timeout"), timeoutMs);
          const checkReady = () => {
            if (combined.aborted) {
              fail("cancelled");
              return;
            }
            if (
              closed ||
              !guildReady(guild) ||
              !registryOwns(guild.id, connection, adapterMethods)
            ) {
              fail("connection_lost");
              return;
            }
            const value = evidence();
            if (value) {
              everReady = true;
              clear();
              resolve(value);
            } else poll = setTimeout(checkReady, pollMs);
          };
          combined.addEventListener("abort", abort, { once: true });
          checkReady();
        });
      const onPlayerError = () => {
        failPlayback("decoder_failed");
        emit("error");
      };
      const onPlayerState = (old: sdk.AudioPlayerState, next: sdk.AudioPlayerState) => {
        if (!playback || closed) return;
        if (next.status === sdk.AudioPlayerStatus.Playing && next.resource === playback.resource) {
          playback.started = true;
          playback.settleStarted();
        }
        if (
          next.status === sdk.AudioPlayerStatus.Idle &&
          "resource" in old &&
          old.resource === playback.resource
        ) {
          if (playback.started && playback.ended && playback.resource?.ended)
            playback.settleFinished();
          else failPlayback("playback_incomplete");
        }
      };
      return {
        ready: wait,
        evidence,
        reconnect: async (inputSignal) => {
          check(inputSignal);
          if (closed) throw new RehearsalError("cancelled");
          consume(guild.id, input.channelId, true);
          if (!registryOwns(guild.id, connection, adapterMethods))
            throw new RehearsalError("session_conflict");
          if (connection.state.status === sdk.VoiceConnectionStatus.Destroyed)
            throw new RehearsalError("connection_lost");
          if (connection.state.status === sdk.VoiceConnectionStatus.Disconnected) {
            if (
              connection.state.reason === sdk.VoiceConnectionDisconnectReason.WebSocketClose &&
              connection.state.closeCode === 4014
            )
              throw new RehearsalError("connection_lost");
            if (!connection.rejoin({ channelId: input.channelId, selfDeaf: true, selfMute: false }))
              throw new RehearsalError("connection_lost");
          }
          return wait(inputSignal);
        },
        play: (opus, inputSignal): RehearsalPlayback => {
          check(inputSignal);
          if (closed || playback) throw new RehearsalError("session_conflict");
          consume(guild.id, input.channelId, true);
          if (!evidence()) throw new RehearsalError("transport_unverified");
          const started = completion(),
            finished = completion();
          const ended = () => {
            if (playback) playback.ended = true;
          };
          const failed = () => onPlayerError();
          const aborted = () => failPlayback("cancelled");
          playback = {
            input: opus,
            started: false,
            ended: opus.readableEnded,
            settleStarted: started.settle,
            settleFinished: finished.settle,
            detach: () => {
              opus.off("end", ended);
              opus.off("error", failed);
              inputSignal.removeEventListener("abort", aborted);
            },
          };
          opus.on("end", ended);
          opus.on("error", failed);
          inputSignal.addEventListener("abort", aborted, { once: true });
          try {
            playback.resource = voice.createAudioResource(opus, {
              inputType: sdk.StreamType.OggOpus,
              inlineVolume: false,
            });
            player = voice.createAudioPlayer({
              behaviors: { noSubscriber: sdk.NoSubscriberBehavior.Pause },
            });
            player.on("error", onPlayerError);
            player.on("stateChange", onPlayerState);
            subscription = connection.subscribe(player);
            if (!subscription) throw new RehearsalError("connection_lost");
            player.play(playback.resource);
          } catch {
            failPlayback("decoder_failed");
            emit("error");
          }
          return { started: started.promise, finished: finished.promise };
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        close: () => {
          if (closePromise) return closePromise;
          closePromise = (async () => {
            closed = true;
            let failed = false;
            const cleanup = (operation: () => void) => {
              try {
                operation();
              } catch {
                failed = true;
              }
            };
            cleanup(() => lifetime.abort());
            failPlayback("cancelled");
            cleanup(() => playback?.detach());
            client.off(Events.VoiceStateUpdate, onVoiceState);
            connection.off("stateChange", onConnectionState);
            player?.off("stateChange", onPlayerState);
            cleanup(() => subscription?.unsubscribe());
            cleanup(() => {
              if (
                !player ||
                !("resource" in player.state) ||
                player.state.resource === playback?.resource
              )
                player?.stop(true);
            });
            cleanup(() => {
              playback?.resource?.playStream.destroy();
            });
            cleanup(() => {
              playback?.input.destroy();
            });
            cleanup(() => {
              if (connection.state.status !== sdk.VoiceConnectionStatus.Destroyed) {
                const channelNow = guild.voiceStates.cache.get(client.user!.id)?.channelId;
                connection.destroy(
                  registryOwns(guild.id, connection, adapterMethods) &&
                    client.voice.adapters.get(guild.id) === adapterMethods &&
                    (!channelNow || channelNow === input.channelId),
                );
              }
            });
            if (connection.state.status !== sdk.VoiceConnectionStatus.Destroyed) failed = true;
            else connection.off("error", onConnectionError);
            if (!player || player.state.status === sdk.AudioPlayerStatus.Idle)
              player?.off("error", onPlayerError);
            listeners.clear();
            inspections.delete(guild.id);
            if (failed) throw new RehearsalError("cleanup_unconfirmed");
            if (owned.get(guild.id) === connection) owned.delete(guild.id);
          })();
          return closePromise;
        },
      };
    },
  };
}
