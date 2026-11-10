import type { Client } from "discord.js";
import { createHash, randomUUID } from "node:crypto";
import type { MusicRehearsal } from "../modules/music-rehearsal/service.js";
import {
  RehearsalError,
  type RehearsalGuard,
  type RehearsalRequest,
  type RehearsalScheduler,
  type RehearsalSnapshot,
} from "../modules/music-rehearsal/types.js";
import { MusicOperatorError, MusicOperatorFiles } from "./music-rehearsal-operator-files.js";

export interface MusicRehearsalOperatorConfig {
  format: 1;
  guard: RehearsalGuard;
  ffmpeg: { executablePath: string; executableSha256: string; sourcePath: string };
  requestPath: string;
  statusPath: string;
}
type Controller = Pick<MusicRehearsal, "start" | "stop" | "stopAll" | "snapshot">;
export interface MusicRehearsalOperatorOptions {
  /** The caller must derive this from the explicit GILDIUSZ_AUDIO_REHEARSAL=1 opt-in. */
  enabled?: boolean;
  expectedApplicationId: string;
  dataRoot: string;
  configPath?: string;
  clock?: () => number;
  pollMs?: number;
  /** Offline tests substitute the timer and controller, never a second Discord client. */
  scheduler?: RehearsalScheduler;
  buildController?: (
    client: Client,
    config: MusicRehearsalOperatorConfig,
    clock: () => number,
  ) => Promise<Controller>;
}
export interface MusicRehearsalOperator {
  stop(): Promise<void>;
}
type Start = RehearsalRequest & { command: "start"; createdAt: number };
type Stop = {
  command: "stop";
  requestId: string;
  createdAt: number;
  actorId: string;
  guildId: string;
};
type Request = Start | Stop;
interface Receipt {
  requestId: string;
  command: Request["command"];
  state: "accepted" | "succeeded" | "failed";
  code: string | null;
}
interface Entry {
  hash: string;
  receipt: Receipt;
}
const instances = new WeakSet<Client>();
const snowflake = (value: unknown): value is string =>
  typeof value === "string" && /^\d{17,20}$/.test(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new MusicOperatorError("operator_config_invalid");
  return value as Record<string, unknown>;
}
function guardInput(value: unknown): RehearsalGuard {
  const guard = object(value, ["applicationId", "botUserId", "operatorIds", "guildChannels"]);
  if (
    !snowflake(guard.applicationId) ||
    !snowflake(guard.botUserId) ||
    !Array.isArray(guard.operatorIds) ||
    guard.operatorIds.length < 1 ||
    guard.operatorIds.length > 16 ||
    guard.operatorIds.some((id) => !snowflake(id)) ||
    new Set(guard.operatorIds).size !== guard.operatorIds.length ||
    !guard.guildChannels ||
    typeof guard.guildChannels !== "object" ||
    Array.isArray(guard.guildChannels)
  )
    throw new MusicOperatorError("operator_config_invalid");
  const guildChannels: Record<string, string[]> = {};
  const entries = Object.entries(guard.guildChannels);
  if (entries.length < 1 || entries.length > 2)
    throw new MusicOperatorError("operator_config_invalid");
  for (const [guildId, channels] of entries) {
    if (
      !snowflake(guildId) ||
      !Array.isArray(channels) ||
      channels.length < 1 ||
      channels.length > 2 ||
      channels.some((id) => !snowflake(id)) ||
      new Set(channels).size !== channels.length
    )
      throw new MusicOperatorError("operator_config_invalid");
    guildChannels[guildId] = [...channels];
  }
  return {
    applicationId: guard.applicationId,
    botUserId: guard.botUserId,
    operatorIds: [...guard.operatorIds],
    guildChannels,
  };
}
function configInput(value: unknown, files: MusicOperatorFiles): MusicRehearsalOperatorConfig {
  const input = object(value, ["format", "guard", "ffmpeg", "requestPath", "statusPath"]);
  const ffmpeg = object(input.ffmpeg, ["executablePath", "executableSha256", "sourcePath"]);
  if (
    input.format !== 1 ||
    input.requestPath !== files.requestPath ||
    input.statusPath !== files.statusPath ||
    typeof ffmpeg.executablePath !== "string" ||
    typeof ffmpeg.sourcePath !== "string" ||
    typeof ffmpeg.executableSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(ffmpeg.executableSha256)
  )
    throw new MusicOperatorError("operator_config_invalid");
  return {
    format: 1,
    guard: guardInput(input.guard),
    ffmpeg: {
      executablePath: files.privateFile(ffmpeg.executablePath, 268435456),
      executableSha256: ffmpeg.executableSha256,
      sourcePath: files.privateFile(ffmpeg.sourcePath, 192044),
    },
    requestPath: files.requestPath,
    statusPath: files.statusPath,
  };
}
function requestInput(value: unknown, guard: RehearsalGuard): Request {
  try {
    const mode =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).command
        : null;
    if (mode !== "start" && mode !== "stop") throw Error();
    const input = object(
      value,
      mode === "start"
        ? [
            "command",
            "requestId",
            "createdAt",
            "actorId",
            "guildId",
            "channelId",
            "durationSeconds",
          ]
        : ["command", "requestId", "createdAt", "actorId", "guildId"],
    );
    if (
      typeof input.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId) ||
      !integer(input.createdAt) ||
      !snowflake(input.actorId) ||
      !guard.operatorIds.includes(input.actorId) ||
      !snowflake(input.guildId) ||
      !Object.hasOwn(guard.guildChannels, input.guildId)
    )
      throw Error();
    const common = {
      requestId: input.requestId,
      createdAt: input.createdAt,
      actorId: input.actorId,
      guildId: input.guildId,
    };
    if (mode === "stop") return { command: "stop", ...common };
    if (
      !snowflake(input.channelId) ||
      !guard.guildChannels[input.guildId].includes(input.channelId) ||
      !Number.isSafeInteger(input.durationSeconds) ||
      typeof input.durationSeconds !== "number" ||
      input.durationSeconds < 120 ||
      input.durationSeconds > 3600
    )
      throw Error();
    return {
      command: "start",
      ...common,
      channelId: input.channelId,
      durationSeconds: input.durationSeconds,
      sourceId: "synthetic-v1",
    };
  } catch {
    throw new MusicOperatorError("operator_request_invalid");
  }
}
function snapshot(value: RehearsalSnapshot | null): RehearsalSnapshot | null {
  if (!value) return null;
  // Explicit projection: no raw SDK state, credentials, paths or future private fields.
  return {
    id: value.id,
    guildId: value.guildId,
    channelId: value.channelId,
    actorId: value.actorId,
    sourceId: value.sourceId,
    durationSeconds: value.durationSeconds,
    state: value.state,
    createdAt: value.createdAt,
    playingAt: value.playingAt,
    stoppedAt: value.stoppedAt,
    reason: value.reason,
    reconnects: value.reconnects,
    cleanupPending: value.cleanupPending,
    decoder: value.decoder
      ? {
          outputBytes: value.decoder.outputBytes,
          stderrBytes: value.decoder.stderrBytes,
          lastOutputAt: value.decoder.lastOutputAt,
        }
      : null,
    voice: value.voice
      ? {
          channelId: value.voice.channelId,
          ready: value.voice.ready,
          daveProtocolVersion: value.voice.daveProtocolVersion,
          hasVoicePrivacyCode: value.voice.hasVoicePrivacyCode,
          encryptionMode: value.voice.encryptionMode,
          wsPingMs: value.voice.wsPingMs,
          udpEstablished: value.voice.udpEstablished,
          udpPingMs: value.voice.udpPingMs,
          playedMilliseconds: value.voice.playedMilliseconds,
        }
      : null,
  };
}
const failure = (error: unknown) =>
  error instanceof RehearsalError || error instanceof MusicOperatorError
    ? error.code
    : "operator_unavailable";
async function defaultController(
  client: Client,
  config: MusicRehearsalOperatorConfig,
  clock: () => number,
): Promise<Controller> {
  const [{ MusicRehearsal }, { FfmpegRehearsalDecoder }, { createMusicRehearsalPorts }] =
    await Promise.all([
      import("../modules/music-rehearsal/service.js"),
      import("../modules/music-rehearsal/ffmpeg.js"),
      import("./music-rehearsal-voice.js"),
    ]);
  return new MusicRehearsal({
    enabled: true,
    guard: config.guard,
    clock,
    ports: createMusicRehearsalPorts(client, { operatorIds: config.guard.operatorIds, clock }),
    decoder: new FfmpegRehearsalDecoder({ ...config.ffmpeg, clock }),
  });
}

/** Local opt-in bridge. It never resumes a request file left by a previous process. */
export async function createMusicRehearsalOperator(
  client: Client,
  options: MusicRehearsalOperatorOptions,
): Promise<MusicRehearsalOperator | null> {
  if (options.enabled !== true) return null;
  if (instances.has(client)) throw new MusicOperatorError("operator_unavailable");
  instances.add(client);
  let controller: Controller | undefined;
  try {
    const clock = options.clock ?? Date.now,
      pollMs = options.pollMs ?? 1000;
    if (
      !snowflake(options.expectedApplicationId) ||
      !Number.isSafeInteger(pollMs) ||
      pollMs < 1000 ||
      pollMs > 5000 ||
      typeof options.configPath !== "string"
    )
      throw new MusicOperatorError("operator_config_invalid");
    const files = new MusicOperatorFiles(options.dataRoot);
    const config = configInput(files.read(files.configPath(options.configPath), 16384), files);
    if (
      config.guard.applicationId !== options.expectedApplicationId ||
      client.application?.id !== options.expectedApplicationId ||
      client.user?.id !== config.guard.botUserId ||
      !client.isReady()
    )
      throw new RehearsalError("identity_mismatch");
    controller = await (options.buildController ?? defaultController)(client, config, clock);
    const active = controller;
    let lastTime = 0;
    const now = () => {
      const value = clock();
      if (!integer(value) || value < lastTime) throw new MusicOperatorError("operator_unavailable");
      lastTime = value;
      return value;
    };
    const startedAt = now(),
      runtimeId = randomUUID(),
      entries = new Map<string, Entry>();
    let phase: "ready" | "stop_only" | "stopping" | "stopped" | "failed" = "ready";
    let lastRequest: Receipt | null = null,
      lastError: string | null = null;
    const fingerprint = (value: unknown) =>
      value === undefined ? null : createHash("sha256").update(JSON.stringify(value)).digest("hex");
    let lastRead: string | null = null;
    try {
      lastRead = fingerprint(files.read(files.requestPath, 4096, true));
      if (lastRead) lastError = "operator_request_stale";
    } catch (error) {
      if (error instanceof MusicOperatorError && error.code === "operator_path_invalid")
        throw error;
      lastError = "operator_request_invalid";
    }
    let closed = false,
      stopPromise: Promise<void> | undefined,
      cancelTimer: (() => void) | undefined;
    const scheduler =
      options.scheduler ??
      ({
        after: (milliseconds, callback) => {
          const timer = setTimeout(callback, milliseconds);
          return () => clearTimeout(timer);
        },
      } satisfies RehearsalScheduler);
    const persist = () =>
      files.writeStatus({
        format: 1,
        runtimeId,
        startedAt,
        updatedAt: now(),
        state: phase,
        lastError,
        request: lastRequest,
        sessions: Object.keys(config.guard.guildChannels)
          .map((guildId) => snapshot(active.snapshot(guildId)))
          .filter((value) => value !== null),
      });
    const shutdown = (reason: string): Promise<void> => {
      if (stopPromise) return stopPromise;
      closed = true;
      cancelTimer?.();
      cancelTimer = undefined;
      phase = "stopping";
      stopPromise = (async () => {
        let failed: boolean;
        try {
          const result = await active.stopAll(reason);
          failed = result.some((value) => value.cleanupPending);
        } catch {
          failed = true;
        }
        phase = failed ? "failed" : "stopped";
        if (failed) lastError = "cleanup_unconfirmed";
        try {
          persist();
        } catch {
          failed = true;
        }
        if (failed) throw new MusicOperatorError("operator_unavailable");
        instances.delete(client);
      })();
      void stopPromise.catch(() => {});
      return stopPromise;
    };
    const persistSafely = () => {
      if (closed) return;
      try {
        persist();
      } catch {
        lastError = "operator_unavailable";
        void shutdown("operator");
      }
    };
    const complete = (entry: Entry, result?: RehearsalSnapshot | null, error?: unknown) => {
      entry.receipt.state = error || result?.cleanupPending ? "failed" : "succeeded";
      entry.receipt.code = error
        ? failure(error)
        : result?.cleanupPending
          ? "cleanup_unconfirmed"
          : null;
      persistSafely();
    };
    const process = (request: Request) => {
      const at = now();
      if (
        request.createdAt <= startedAt ||
        request.createdAt > at ||
        at - request.createdAt > 60000
      ) {
        lastError = "operator_request_stale";
        return;
      }
      const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        existing = entries.get(request.requestId);
      if (existing) {
        if (existing.hash !== hash) {
          lastError = "idempotency_conflict";
          return;
        }
        lastRequest = existing.receipt;
        lastError = null;
        return;
      }
      if (phase === "stop_only" || entries.size >= 128) {
        phase = "stop_only";
        lastError = "operator_request_capacity";
        // No future start is possible. Emergency cleanup remains available without growing a ledger.
        if (request.command === "stop") void shutdown("operator");
        return;
      }
      const entry: Entry = {
        hash,
        receipt: {
          requestId: request.requestId,
          command: request.command,
          state: "accepted",
          code: null,
        },
      };
      entries.set(request.requestId, entry);
      lastRequest = entry.receipt;
      lastError = null;
      try {
        const operation =
          request.command === "start"
            ? active.start({
                actorId: request.actorId,
                guildId: request.guildId,
                channelId: request.channelId,
                requestId: request.requestId,
                sourceId: "synthetic-v1",
                durationSeconds: request.durationSeconds,
              })
            : active.stop(request.guildId, "operator");
        // Start must not block the polling loop: an operator can stop an in-flight Ready wait.
        void operation.then(
          (result) => complete(entry, result),
          (error) => complete(entry, undefined, error),
        );
      } catch (error) {
        complete(entry, undefined, error);
      }
    };
    const poll = () => {
      cancelTimer = undefined;
      if (closed) return;
      try {
        const input = files.read(files.requestPath, 4096, true),
          digest = fingerprint(input);
        if (digest !== lastRead) {
          lastRead = digest;
          if (input !== undefined) process(requestInput(input, config.guard));
        }
      } catch (error) {
        lastError = failure(error);
        if (error instanceof MusicOperatorError && error.code === "operator_path_invalid") {
          void shutdown("operator");
          return;
        }
      }
      persistSafely();
      if (!closed) cancelTimer = scheduler.after(pollMs, poll);
    };
    persist();
    cancelTimer = scheduler.after(pollMs, poll);
    return { stop: () => shutdown("shutdown") };
  } catch (error) {
    if (controller) {
      try {
        await controller.stopAll("shutdown");
      } catch {
        /* Preserve the sanitized initialization error after attempting owned cleanup. */
      }
    }
    instances.delete(client);
    if (error instanceof MusicOperatorError || error instanceof RehearsalError) throw error;
    throw new MusicOperatorError("operator_unavailable");
  }
}
