import type { Readable } from "node:stream";

export type RehearsalErrorCode =
  | "disabled"
  | "invalid_input"
  | "identity_mismatch"
  | "permission_revoked"
  | "channel_unavailable"
  | "channel_busy"
  | "stale_facts"
  | "session_conflict"
  | "idempotency_conflict"
  | "cancelled"
  | "prepare_timeout"
  | "voice_timeout"
  | "playback_timeout"
  | "playback_incomplete"
  | "transport_unverified"
  | "decoder_unavailable"
  | "source_invalid"
  | "decoder_failed"
  | "decoder_stalled"
  | "decoder_output_limit"
  | "decoder_stderr_limit"
  | "reconnect_exhausted"
  | "empty_channel"
  | "connection_lost"
  | "cleanup_unconfirmed";
export class RehearsalError extends Error {
  constructor(readonly code: RehearsalErrorCode) {
    super(code);
    this.name = "RehearsalError";
  }
}
export interface RehearsalRequest {
  actorId: string;
  guildId: string;
  channelId: string;
  requestId: string;
  sourceId: "synthetic-v1";
  durationSeconds: number;
}
export interface RehearsalGuard {
  applicationId: string;
  botUserId: string;
  operatorIds: readonly string[];
  guildChannels: Readonly<Record<string, readonly string[]>>;
}
export interface RehearsalIdentity {
  applicationId: string;
  botUserId: string;
  gatewayReady: boolean;
}
/** Obtained from the existing client and fresh Discord facts, never a request body. */
export interface RehearsalFacts {
  observedAt: number;
  guildId: string;
  channelId: string;
  actorId: string;
  gatewayReady: boolean;
  channelKind: "voice" | "other";
  memberPresent: boolean;
  actorIsBot: boolean;
  owner: boolean;
  manageGuild: boolean;
  pending: boolean | null;
  timedOut: boolean;
  actorChannelId: string | null;
  botChannelId: string | null;
  viewChannel: boolean;
  connect: boolean;
  speak: boolean;
  humanCount: number;
  userLimit: number;
  memberCount: number;
}
export interface VoiceEvidence {
  channelId: string;
  ready: boolean;
  daveProtocolVersion: number;
  hasVoicePrivacyCode: boolean;
  encryptionMode: "aead_aes256_gcm_rtpsize" | "aead_xchacha20_poly1305_rtpsize";
  wsPingMs: number;
  /** SDK NetworkingReady follows successful UDP IP discovery; this is not an RTT or audio receipt. */
  udpEstablished: true;
  udpPingMs: number | null;
  playedMilliseconds: number;
}
export type VoiceEvent = "disconnected" | "moved" | "kicked" | "permission_lost" | "error";
export interface RehearsalPlayback {
  started: Promise<void>;
  finished: Promise<void>;
}
/** open() synchronously returns ownership, before any asynchronous Ready wait. */
export interface RehearsalVoice {
  ready(signal: AbortSignal): Promise<VoiceEvidence>;
  play(opus: Readable, signal: AbortSignal): RehearsalPlayback;
  reconnect(signal: AbortSignal): Promise<VoiceEvidence>;
  evidence(): VoiceEvidence | null;
  onEvent(listener: (event: VoiceEvent) => void): () => void;
  close(): Promise<void>;
}
export interface RehearsalPorts {
  identity(): RehearsalIdentity;
  inspect(
    input: Pick<RehearsalRequest, "actorId" | "guildId" | "channelId">,
    signal: AbortSignal,
  ): Promise<RehearsalFacts>;
  /** Must refuse an unowned existing connection and must use the already logged-in client. */
  open(input: Pick<RehearsalRequest, "guildId" | "channelId">, signal: AbortSignal): RehearsalVoice;
}
export interface DecoderMetrics {
  outputBytes: number;
  stderrBytes: number;
  lastOutputAt: number;
}
export interface RehearsalDecoderSession {
  output: Readable;
  finished: Promise<void>;
  metrics(): DecoderMetrics;
  /** Resolves only after the owned child has closed; idempotent. */
  stop(): Promise<void>;
}
export interface PreparedRehearsalDecoder {
  /** Synchronous ownership handoff; no child may be created after this returns. */
  start(durationSeconds: number, signal: AbortSignal): RehearsalDecoderSession;
}
export interface RehearsalDecoder {
  /** File validation only. Abandoning prepare must not spawn a child. */
  prepare(signal: AbortSignal): Promise<PreparedRehearsalDecoder>;
}
export type RehearsalState =
  "preparing" | "connecting" | "playing" | "reconnecting" | "stopping" | "stopped" | "failed";
export interface RehearsalSnapshot {
  id: string;
  guildId: string;
  channelId: string;
  actorId: string;
  sourceId: "synthetic-v1";
  durationSeconds: number;
  state: RehearsalState;
  createdAt: number;
  playingAt: number | null;
  stoppedAt: number | null;
  reason: string | null;
  reconnects: number;
  cleanupPending: boolean;
  decoder: DecoderMetrics | null;
  voice: VoiceEvidence | null;
}
export interface RehearsalScheduler {
  after(milliseconds: number, callback: () => void): () => void;
}
export interface RehearsalOptions {
  enabled?: boolean;
  guard: RehearsalGuard;
  ports: RehearsalPorts;
  decoder: RehearsalDecoder;
  clock?: () => number;
  scheduler?: RehearsalScheduler;
  policy?: Partial<{
    prepareTimeoutMs: number;
    voiceTimeoutMs: number;
    playbackStartTimeoutMs: number;
    inspectTimeoutMs: number;
    inspectIntervalMs: number;
    emptyGraceMs: number;
    stallMs: number;
    reconnectTimeoutMs: number;
    maxReconnects: number;
    stopTimeoutMs: number;
    overrunMs: number;
  }>;
}
