import { randomUUID } from "node:crypto";
import { bounded, checkpoint, nativeScheduler, safeCode } from "./bounded.js";
import {
  RehearsalError,
  type DecoderMetrics,
  type RehearsalDecoderSession,
  type RehearsalFacts,
  type RehearsalGuard,
  type RehearsalOptions,
  type RehearsalRequest,
  type RehearsalScheduler,
  type RehearsalSnapshot,
  type RehearsalVoice,
  type VoiceEvidence,
  type VoiceEvent,
} from "./types.js";

export * from "./types.js";
const defaults = Object.freeze({
  prepareTimeoutMs: 15000,
  voiceTimeoutMs: 20000,
  playbackStartTimeoutMs: 10000,
  inspectTimeoutMs: 5000,
  inspectIntervalMs: 1000,
  emptyGraceMs: 30000,
  stallMs: 10000,
  reconnectTimeoutMs: 15000,
  maxReconnects: 2,
  stopTimeoutMs: 5000,
  overrunMs: 10000,
});
const limits: Record<keyof typeof defaults, number> = {
  prepareTimeoutMs: 15000,
  voiceTimeoutMs: 20000,
  playbackStartTimeoutMs: 10000,
  inspectTimeoutMs: 5000,
  inspectIntervalMs: 5000,
  emptyGraceMs: 30000,
  stallMs: 30000,
  reconnectTimeoutMs: 15000,
  maxReconnects: 2,
  stopTimeoutMs: 5000,
  overrunMs: 10000,
};
interface Session {
  input: RehearsalRequest;
  view: RehearsalSnapshot;
  abort: AbortController;
  timers: Set<() => void>;
  voice?: RehearsalVoice;
  decoder?: RehearsalDecoderSession;
  unsubscribe?: () => void;
  stopping?: Promise<RehearsalSnapshot>;
  checking?: Promise<void>;
  reconnecting?: Promise<void>;
  completing?: Promise<void>;
  playRequestedAt?: number;
  baselinePlayed?: number;
  emptyCancel?: () => void;
  checkCancel?: () => void;
  lastProgressAt: number;
  lastPlayed: number;
}
const snowflake = (value: unknown) => typeof value === "string" && /^\d{17,20}$/.test(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const active = (session: Session) =>
  !["stopped", "failed"].includes(session.view.state) || session.view.cleanupPending;

/** Operator-only rehearsal. Nothing here logs in, publishes a capability, or resumes after restart. */
export class MusicRehearsal {
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<
    string,
    { hash: string; promise: Promise<RehearsalSnapshot>; session: Session }
  >();
  private readonly scheduler: RehearsalScheduler;
  private readonly clock: () => number;
  private readonly policy: { [K in keyof typeof defaults]: number };
  private readonly guard: RehearsalGuard;
  private readonly enabled: boolean;
  private closed = false;
  private lastTime = 0;
  constructor(private readonly options: RehearsalOptions) {
    this.scheduler = options.scheduler ?? nativeScheduler;
    this.clock = options.clock ?? Date.now;
    this.enabled = options.enabled === true;
    this.policy = { ...defaults, ...options.policy };
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[])
      if (
        !Number.isSafeInteger(this.policy[key]) ||
        this.policy[key] < 1 ||
        this.policy[key] > limits[key]
      )
        throw new RehearsalError("invalid_input");
    const guard = options.guard;
    if (
      !guard ||
      !snowflake(guard.applicationId) ||
      !snowflake(guard.botUserId) ||
      !Array.isArray(guard.operatorIds) ||
      guard.operatorIds.length < 1 ||
      guard.operatorIds.length > 16 ||
      guard.operatorIds.some((id) => !snowflake(id)) ||
      new Set(guard.operatorIds).size !== guard.operatorIds.length ||
      !guard.guildChannels ||
      Object.keys(guard.guildChannels).length < 1 ||
      Object.keys(guard.guildChannels).length > 2 ||
      Object.entries(guard.guildChannels).some(
        ([guild, channels]) =>
          !snowflake(guild) ||
          !Array.isArray(channels) ||
          !channels.length ||
          channels.length > 2 ||
          channels.some((id) => !snowflake(id)) ||
          new Set(channels).size !== channels.length,
      )
    )
      throw new RehearsalError("invalid_input");
    this.guard = {
      applicationId: guard.applicationId,
      botUserId: guard.botUserId,
      operatorIds: [...guard.operatorIds],
      guildChannels: Object.fromEntries(
        Object.entries(guard.guildChannels).map(([guild, channels]) => [guild, [...channels]]),
      ),
    };
  }
  private now(): number {
    const value = this.clock();
    if (!integer(value) || value < this.lastTime) throw new RehearsalError("stale_facts");
    this.lastTime = value;
    return value;
  }
  private identity(): void {
    const value = this.options.ports.identity(),
      guard = this.guard;
    if (
      value.applicationId !== guard.applicationId ||
      value.botUserId !== guard.botUserId ||
      value.gatewayReady !== true
    )
      throw new RehearsalError("identity_mismatch");
  }
  private live(session: Session): void {
    checkpoint(session.abort.signal);
    if (this.sessions.get(session.input.guildId) !== session || session.stopping)
      throw new RehearsalError("cancelled");
  }
  private facts(session: Session, value: RehearsalFacts, initial: boolean): void {
    const now = this.now(),
      input = session.input;
    if (!integer(value.observedAt) || value.observedAt > now || now - value.observedAt > 5000)
      throw new RehearsalError("stale_facts");
    if (
      value.guildId !== input.guildId ||
      value.channelId !== input.channelId ||
      value.actorId !== input.actorId ||
      value.gatewayReady !== true ||
      value.memberPresent !== true ||
      value.actorIsBot !== false ||
      (value.owner !== true && value.manageGuild !== true) ||
      value.pending !== false ||
      value.timedOut !== false ||
      value.viewChannel !== true ||
      value.connect !== true ||
      value.speak !== true
    )
      throw new RehearsalError("permission_revoked");
    if (
      value.channelKind !== "voice" ||
      !integer(value.humanCount) ||
      !integer(value.userLimit) ||
      !integer(value.memberCount) ||
      value.humanCount > value.memberCount
    )
      throw new RehearsalError("channel_unavailable");
    if (initial) {
      if (value.actorChannelId !== input.channelId || value.humanCount < 1)
        throw new RehearsalError("channel_unavailable");
      if (
        value.botChannelId !== null ||
        (value.userLimit > 0 && value.memberCount >= value.userLimit)
      )
        throw new RehearsalError("channel_busy");
    } else if (value.botChannelId !== input.channelId) throw new RehearsalError("connection_lost");
  }
  private async inspect(
    session: Session,
    initial: boolean,
    parent = session.abort.signal,
  ): Promise<RehearsalFacts> {
    this.identity();
    const value = await bounded(
      this.scheduler,
      this.policy.inspectTimeoutMs,
      "voice_timeout",
      parent,
      (signal) =>
        this.options.ports.inspect(
          {
            actorId: session.input.actorId,
            guildId: session.input.guildId,
            channelId: session.input.channelId,
          },
          signal,
        ),
    );
    this.live(session);
    this.facts(session, value, initial);
    return value;
  }
  private evidence(session: Session, value: VoiceEvidence | null): VoiceEvidence {
    if (
      !value ||
      value.channelId !== session.input.channelId ||
      value.ready !== true ||
      !integer(value.daveProtocolVersion) ||
      value.daveProtocolVersion < 1 ||
      value.hasVoicePrivacyCode !== true ||
      !["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"].includes(
        value.encryptionMode,
      ) ||
      !Number.isFinite(value.wsPingMs) ||
      value.wsPingMs < 0 ||
      value.udpEstablished !== true ||
      (value.udpPingMs !== null && (!Number.isFinite(value.udpPingMs) || value.udpPingMs < 0)) ||
      !integer(value.playedMilliseconds)
    )
      throw new RehearsalError("transport_unverified");
    return {
      channelId: value.channelId,
      ready: true,
      daveProtocolVersion: value.daveProtocolVersion,
      hasVoicePrivacyCode: true,
      encryptionMode: value.encryptionMode,
      wsPingMs: value.wsPingMs,
      udpEstablished: true,
      udpPingMs: value.udpPingMs,
      playedMilliseconds: value.playedMilliseconds,
    };
  }
  private metrics(session: Session): DecoderMetrics | null {
    if (!session.decoder) return null;
    const value = session.decoder.metrics();
    if (
      !integer(value.outputBytes) ||
      !integer(value.stderrBytes) ||
      !integer(value.lastOutputAt) ||
      value.lastOutputAt > this.now()
    )
      throw new RehearsalError("decoder_failed");
    return {
      outputBytes: value.outputBytes,
      stderrBytes: value.stderrBytes,
      lastOutputAt: value.lastOutputAt,
    };
  }
  private later(session: Session, milliseconds: number, work: () => void): () => void {
    let cancel = () => {};
    const release = this.scheduler.after(milliseconds, () => {
      session.timers.delete(cancel);
      work();
    });
    cancel = () => {
      release();
      session.timers.delete(cancel);
    };
    session.timers.add(cancel);
    return cancel;
  }
  async start(request: RehearsalRequest): Promise<RehearsalSnapshot> {
    if (!this.enabled || this.closed) throw new RehearsalError("disabled");
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new RehearsalError("invalid_input");
    const input = {
        actorId: request.actorId,
        guildId: request.guildId,
        channelId: request.channelId,
        requestId: request.requestId,
        sourceId: request.sourceId,
        durationSeconds: request.durationSeconds,
      },
      guard = this.guard;
    if (
      Object.keys(request).some(
        (key) =>
          !["actorId", "guildId", "channelId", "requestId", "sourceId", "durationSeconds"].includes(
            key,
          ),
      ) ||
      !guard.operatorIds.includes(input.actorId) ||
      !Object.hasOwn(guard.guildChannels, input.guildId) ||
      !guard.guildChannels[input.guildId].includes(input.channelId) ||
      input.sourceId !== "synthetic-v1" ||
      typeof input.requestId !== "string" ||
      !input.requestId.length ||
      input.requestId.length > 200 ||
      /[\p{Cc}]/u.test(input.requestId) ||
      !Number.isSafeInteger(input.durationSeconds) ||
      input.durationSeconds < 120 ||
      input.durationSeconds > 3600
    )
      throw new RehearsalError("invalid_input");
    this.identity();
    const key = `${input.guildId}:${input.actorId}:${input.requestId}`,
      hash = JSON.stringify(input),
      previous = this.requests.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new RehearsalError("idempotency_conflict");
      await previous.promise;
      return structuredClone(previous.session.view);
    }
    if ([...this.sessions.values()].some(active))
      throw new RehearsalError(
        [...this.sessions.values()].some((session) => session.view.cleanupPending)
          ? "cleanup_unconfirmed"
          : "session_conflict",
      );
    const now = this.now();
    const session: Session = {
      input,
      abort: new AbortController(),
      timers: new Set(),
      lastProgressAt: now,
      lastPlayed: 0,
      view: {
        id: randomUUID(),
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: input.actorId,
        sourceId: "synthetic-v1",
        durationSeconds: input.durationSeconds,
        state: "preparing",
        createdAt: now,
        playingAt: null,
        stoppedAt: null,
        reason: null,
        reconnects: 0,
        cleanupPending: false,
        decoder: null,
        voice: null,
      },
    };
    this.sessions.set(input.guildId, session);
    this.later(session, Math.min(3900000, input.durationSeconds * 1000 + 70000), () => {
      void this.finish(session, "failed", "playback_timeout");
    });
    const promise = this.launch(session).catch(async (error) => {
      const code = safeCode(error, "decoder_failed");
      await this.finish(session, "failed", code);
      throw new RehearsalError(code);
    });
    this.requests.set(key, { hash, promise, session });
    while (this.requests.size > 32) this.requests.delete(this.requests.keys().next().value!);
    return promise;
  }
  private async launch(session: Session): Promise<RehearsalSnapshot> {
    await this.inspect(session, true);
    const prepared = await bounded(
      this.scheduler,
      this.policy.prepareTimeoutMs,
      "prepare_timeout",
      session.abort.signal,
      (signal) => this.options.decoder.prepare(signal),
    );
    this.live(session);
    await this.inspect(session, true);
    this.live(session);
    session.view.state = "connecting";
    session.voice = this.options.ports.open(
      { guildId: session.input.guildId, channelId: session.input.channelId },
      session.abort.signal,
    );
    session.unsubscribe = session.voice.onEvent((event) => this.event(session, event));
    const ready = await bounded(
      this.scheduler,
      this.policy.voiceTimeoutMs,
      "voice_timeout",
      session.abort.signal,
      (signal) => session.voice!.ready(signal),
    );
    this.live(session);
    session.view.voice = this.evidence(session, ready);
    await this.inspect(session, false);
    this.live(session);
    session.decoder = prepared.start(session.input.durationSeconds, session.abort.signal);
    void session.decoder.finished.catch((error) => {
      if (!session.stopping) void this.finish(session, "failed", safeCode(error, "decoder_failed"));
    });
    session.playRequestedAt = this.now();
    session.baselinePlayed = session.view.voice.playedMilliseconds;
    const playback = session.voice.play(session.decoder.output, session.abort.signal);
    void playback.finished.then(
      () => {
        if (!session.stopping) void this.playbackFinished(session);
      },
      () => {
        if (!session.stopping) void this.finish(session, "failed", "decoder_failed");
      },
    );
    await bounded(
      this.scheduler,
      this.policy.playbackStartTimeoutMs,
      "playback_timeout",
      session.abort.signal,
      () => playback.started,
    );
    this.live(session);
    this.identity();
    session.view.voice = this.evidence(session, session.voice.evidence());
    session.view.state = "playing";
    session.view.playingAt = this.now();
    session.lastProgressAt = this.now();
    session.lastPlayed = session.view.voice.playedMilliseconds;
    session.view.decoder = this.metrics(session);
    this.later(session, session.input.durationSeconds * 1000 + this.policy.overrunMs, () => {
      void this.finish(session, "failed", "playback_timeout");
    });
    this.scheduleCheck(session);
    return structuredClone(session.view);
  }
  private playbackFinished(session: Session): Promise<void> {
    if (session.stopping) return Promise.resolve();
    if (session.completing) return session.completing;
    session.completing = (async () => {
      try {
        this.live(session);
        const evidence = this.evidence(session, session.voice!.evidence());
        const duration = session.input.durationSeconds * 1000;
        const elapsed =
          session.playRequestedAt === undefined ? 0 : this.now() - session.playRequestedAt;
        const played =
          session.baselinePlayed === undefined
            ? 0
            : evidence.playedMilliseconds - session.baselinePlayed;
        // At most two Opus frames and a small scheduling margin; an early Idle is not completion.
        if (session.view.playingAt === null || played < duration - 40 || elapsed < duration - 250)
          throw new RehearsalError("playback_incomplete");
        session.view.voice = evidence;
        await bounded(
          this.scheduler,
          Math.min(5000, this.policy.overrunMs),
          "decoder_failed",
          session.abort.signal,
          () => session.decoder!.finished,
        );
        this.live(session);
        session.view.decoder = this.metrics(session);
        if (!session.view.decoder || session.view.decoder.outputBytes < 1)
          throw new RehearsalError("playback_incomplete");
        await this.finish(session, "stopped", "completed");
      } catch (error) {
        if (!session.stopping)
          await this.finish(session, "failed", safeCode(error, "decoder_failed"));
      }
    })();
    return session.completing;
  }
  private scheduleCheck(session: Session): void {
    session.checkCancel?.();
    if (!session.stopping)
      session.checkCancel = this.later(session, this.policy.inspectIntervalMs, () => {
        session.checkCancel = undefined;
        void this.check(session);
      });
  }
  private check(session: Session): Promise<void> {
    if (session.stopping) return Promise.resolve();
    if (session.checking) return session.checking;
    session.checking = (async () => {
      try {
        const facts = await this.inspect(session, false);
        if (facts.humanCount === 0 && !session.emptyCancel)
          session.emptyCancel = this.later(session, this.policy.emptyGraceMs, () => {
            void this.finish(session, "stopped", "empty_channel");
          });
        if (facts.humanCount > 0) {
          session.emptyCancel?.();
          session.emptyCancel = undefined;
        }
        if (session.reconnecting) return;
        const evidence = session.voice!.evidence();
        if (!evidence?.ready) {
          await this.reconnect(session);
          return;
        }
        session.view.voice = this.evidence(session, evidence);
        session.view.decoder = this.metrics(session);
        const now = this.now();
        if (evidence.playedMilliseconds > session.lastPlayed) {
          session.lastPlayed = evidence.playedMilliseconds;
          session.lastProgressAt = now;
        }
        if (
          now - session.lastProgressAt >= this.policy.stallMs ||
          (session.view.decoder && now - session.view.decoder.lastOutputAt >= this.policy.stallMs)
        )
          throw new RehearsalError("decoder_stalled");
      } catch (error) {
        if (!session.stopping)
          await this.finish(session, "failed", safeCode(error, "connection_lost"));
      } finally {
        session.checking = undefined;
        this.scheduleCheck(session);
      }
    })();
    return session.checking;
  }
  private event(session: Session, event: VoiceEvent): void {
    if (session.stopping || this.sessions.get(session.input.guildId) !== session) return;
    if (event === "disconnected" && ["playing", "reconnecting"].includes(session.view.state)) {
      void this.reconnect(session);
      return;
    }
    void this.finish(
      session,
      "failed",
      event === "permission_lost" ? "permission_revoked" : "connection_lost",
    );
  }
  private reconnect(session: Session): Promise<void> {
    if (session.stopping) return Promise.resolve();
    if (session.reconnecting) return session.reconnecting;
    session.view.state = "reconnecting";
    session.view.voice = null;
    session.reconnecting = (async () => {
      try {
        await bounded(
          this.scheduler,
          30000,
          "reconnect_exhausted",
          session.abort.signal,
          async (signal) => {
            while (session.view.reconnects < this.policy.maxReconnects) {
              session.view.reconnects++;
              await this.inspect(session, false, signal);
              try {
                const evidence = await bounded(
                  this.scheduler,
                  this.policy.reconnectTimeoutMs,
                  "voice_timeout",
                  signal,
                  (attempt) => session.voice!.reconnect(attempt),
                );
                this.live(session);
                session.view.voice = this.evidence(session, evidence);
                session.lastProgressAt = this.now();
                session.lastPlayed = evidence.playedMilliseconds;
                session.view.state = "playing";
                return;
              } catch (error) {
                if (safeCode(error, "voice_timeout") !== "voice_timeout") throw error;
              }
            }
            throw new RehearsalError("reconnect_exhausted");
          },
        );
      } catch (error) {
        if (!session.stopping)
          await this.finish(session, "failed", safeCode(error, "reconnect_exhausted"));
      } finally {
        session.reconnecting = undefined;
      }
    })();
    return session.reconnecting;
  }
  private finish(
    session: Session,
    state: "stopped" | "failed",
    reason: string,
  ): Promise<RehearsalSnapshot> {
    if (session.stopping) return session.stopping;
    let resolveStop: (value: RehearsalSnapshot) => void = () => {};
    session.stopping = new Promise((resolve) => {
      resolveStop = resolve;
    });
    session.view.state = "stopping";
    session.view.reason = reason;
    try {
      session.unsubscribe?.();
    } catch {
      /* Still close the owned transport if listener cleanup failed. */
    }
    try {
      session.view.decoder = this.metrics(session);
    } catch {
      /* Preserve the last confirmed metrics on failure. */
    }
    session.abort.abort();
    for (const cancel of [...session.timers]) cancel();
    if (session.view.voice) session.view.voice.ready = false;
    const closing = Promise.all([
      Promise.resolve().then(() => session.voice?.close()),
      Promise.resolve().then(() => session.decoder?.stop()),
    ]);
    const finalize = () => {
      session.view.state = state;
      session.view.cleanupPending = false;
      try {
        session.view.stoppedAt = this.now();
      } catch {
        session.view.stoppedAt = this.lastTime;
      }
      session.voice = undefined;
      session.decoder = undefined;
    };
    void closing.then(finalize, () => {});
    void (async () => {
      try {
        await bounded(
          this.scheduler,
          this.policy.stopTimeoutMs,
          "cleanup_unconfirmed",
          new AbortController().signal,
          () => closing,
        );
      } catch {
        session.view.state = "failed";
        session.view.cleanupPending = true;
        session.view.stoppedAt = this.lastTime;
      }
      return structuredClone(session.view);
    })().then(resolveStop);
    return session.stopping;
  }
  snapshot(guildId: string): RehearsalSnapshot | null {
    const session = this.sessions.get(guildId);
    return session ? structuredClone(session.view) : null;
  }
  stop(guildId: string, reason = "operator"): Promise<RehearsalSnapshot | null> {
    const session = this.sessions.get(guildId);
    return session ? this.finish(session, "stopped", reason) : Promise.resolve(null);
  }
  notifyVoiceState(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    return session && ["playing", "reconnecting"].includes(session.view.state)
      ? this.check(session)
      : Promise.resolve();
  }
  async stopAll(reason = "shutdown"): Promise<RehearsalSnapshot[]> {
    this.closed = true;
    return Promise.all(
      [...this.sessions.values()].map((session) => this.finish(session, "stopped", reason)),
    );
  }
}
