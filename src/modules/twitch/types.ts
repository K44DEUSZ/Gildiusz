import type { JobInput } from "../../core/jobs/types.js";
import type { TwitchBinding, TwitchBindingInput } from "../../contracts/twitch.js";
export type { TwitchBinding, TwitchBindingInput };

export type TwitchErrorCode =
  | "invalid_input"
  | "not_found"
  | "revision_conflict"
  | "idempotency_conflict"
  | "binding_exists"
  | "permission_revoked"
  | "channel_unavailable"
  | "subscription_mismatch"
  | "message_collision";

export class TwitchError extends Error {
  constructor(readonly code: TwitchErrorCode) {
    super(code);
    this.name = "TwitchError";
  }
}

export interface TwitchAuthorization {
  guildId: string;
  actorId: string;
  operation: "list" | "read" | "create" | "update" | "remove" | "publish";
  bindingId?: string;
  channelId?: string;
  roleIds?: readonly string[];
  mentionEveryone?: boolean;
}
export type TwitchAuthorize = (request: TwitchAuthorization) => void | Promise<void>;
export interface TwitchSource {
  broadcasterId: string;
  subscriptionId: string | null;
  status: "pending" | "enabled" | "revoked";
  reason: string | null;
  activeBindingCount: number;
  lastEventAt: number | null;
}
export interface TwitchRetention {
  inboxMs: number | null;
  fanoutMs: number | null;
}
export interface SubscriptionIntent {
  id: string;
  broadcasterId: string;
  callbackUrl: string;
  secretRef: string;
  state: "pending" | "registered" | "confirmed" | "superseded" | "expired";
  subscriptionId: string | null;
  attemptedAt: number | null;
  retryAt: number;
  createdAt: number;
  expiresAt: number;
}
export interface HubOptions {
  authorize: TwitchAuthorize;
  clock?: () => number;
  retention?: Partial<TwitchRetention>;
}
export type EventSubMessageType = "notification" | "webhook_callback_verification" | "revocation";
export interface VerifiedEnvelope {
  id: string;
  bodyHash: string;
  messageType: EventSubMessageType;
  providerAt: number;
  subscriptionId: string;
  subscriptionType: string;
  subscriptionVersion: string;
  broadcasterId: string;
  subscriptionStatus: string;
  callbackUrl?: string;
  secretRef?: string;
  challenge?: string;
  streamId?: string;
  streamType?: "live" | "playlist" | "watch_party" | "premiere" | "rerun";
  startedAt?: number;
}
export interface TwitchInboxEvent extends VerifiedEnvelope {
  receivedAt: number;
}
export interface WebhookResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
export interface LiveStream {
  id: string;
  broadcasterId: string;
  login: string;
  displayName: string;
  title: string;
  category: string;
  thumbnailUrl: string;
  startedAt: number;
}
export interface TwitchPublication {
  bindingId: string;
  generation: number;
  guildId: string;
  actorId: string;
  channelId: string;
  roleIds: string[];
  mentionEveryone: boolean;
  stream: LiveStream & { url: string };
  content: string;
}
export interface TwitchJobInput extends JobInput {
  type: "twitch.send";
  payload: {
    bindingId: string;
    generation: number;
    stream: { id: string };
  };
}
export interface TwitchFanout {
  id: string;
  bindingId: string;
  streamId: string;
  state: "pending" | "queued" | "skipped";
  job: TwitchJobInput;
  jobId: string | null;
  reason: string | null;
}
