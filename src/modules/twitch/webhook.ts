import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import type { TwitchHubStore } from "./store.js";
import { broadcasterId, integer, record, text, timestamp } from "./validation.js";
import {
  TwitchError,
  type EventSubMessageType,
  type VerifiedEnvelope,
  type WebhookResponse,
} from "./types.js";

export interface EventSubRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Uint8Array;
}
export interface EventSubReceiverOptions {
  secret: string;
  store: Pick<TwitchHubStore, "accept">;
  clock?: () => number;
  maxBodyBytes?: number;
}
export function webhookSecretRef(secret: string): string {
  return createHash("sha256").update("gildiusz-twitch-key-v1\0").update(secret).digest("hex");
}

export class EventSubReceiver {
  private readonly clock: () => number;
  private readonly maxBodyBytes: number;
  constructor(private readonly options: EventSubReceiverOptions) {
    // Twitch accepts 10–100 ASCII characters; this application requires at least 32.
    if (typeof options.secret !== "string" || !/^[\x20-\x7e]{32,100}$/.test(options.secret))
      throw new TwitchError("invalid_input");
    this.clock = options.clock ?? Date.now;
    this.maxBodyBytes = options.maxBodyBytes ?? 65536;
    if (integer(this.maxBodyBytes) < 1 || this.maxBodyBytes > 1048576)
      throw new TwitchError("invalid_input");
  }

  receive(request: EventSubRequest): WebhookResponse {
    let envelope: VerifiedEnvelope;
    try {
      if (
        !(request.rawBody instanceof Uint8Array) ||
        request.rawBody.byteLength > this.maxBodyBytes
      )
        return { status: 413, body: "" };
      const headers = new Map<string, string>();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        const name = key.toLowerCase();
        if (headers.has(name) || typeof value !== "string") throw new TwitchError("invalid_input");
        headers.set(name, text(value, 512));
      }
      const header = (name: string) => text(headers.get(`twitch-eventsub-${name}`), 512);
      const id = header("message-id"),
        sent = header("message-timestamp"),
        signature = header("message-signature");
      const providerAt = timestamp(sent),
        now = integer(this.clock());
      if (providerAt < now - 600000 || providerAt > now + 60000) return { status: 403, body: "" };
      if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return { status: 403, body: "" };
      const expected = createHmac("sha256", this.options.secret)
        .update(id)
        .update(sent)
        .update(request.rawBody)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
        return { status: 403, body: "" };
      const messageType = header("message-type");
      if (!["notification", "webhook_callback_verification", "revocation"].includes(messageType))
        throw new TwitchError("invalid_input");
      const body = record(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody)),
      );
      const subscription = record(body.subscription),
        condition = record(subscription.condition);
      const subscriptionType = text(subscription.type),
        subscriptionVersion = text(subscription.version, 32);
      if (
        header("subscription-type") !== subscriptionType ||
        header("subscription-version") !== subscriptionVersion
      )
        throw new TwitchError("invalid_input");
      const subscriptionStatus = text(subscription.status, 100);
      envelope = {
        id,
        providerAt,
        messageType: messageType as EventSubMessageType,
        bodyHash: createHash("sha256")
          .update(messageType)
          .update("\0")
          .update(request.rawBody)
          .digest("hex"),
        subscriptionId: text(subscription.id),
        subscriptionType,
        subscriptionVersion,
        broadcasterId: broadcasterId(condition.broadcaster_user_id),
        subscriptionStatus,
        secretRef: webhookSecretRef(this.options.secret),
      };
      if (subscription.transport !== undefined) {
        const transport = record(subscription.transport);
        const callback = new URL(text(transport.callback, 2048));
        if (
          transport.method !== "webhook" ||
          callback.protocol !== "https:" ||
          callback.port ||
          callback.username ||
          callback.password ||
          callback.hash
        )
          throw new TwitchError("invalid_input");
        envelope.callbackUrl = callback.href;
      }
      if (messageType === "webhook_callback_verification") {
        if (
          subscriptionStatus !== "webhook_callback_verification_pending" ||
          body.event !== undefined
        )
          throw new TwitchError("invalid_input");
        envelope.challenge = text(body.challenge, 1024);
      } else if (messageType === "revocation") {
        if (
          ["enabled", "webhook_callback_verification_pending"].includes(subscriptionStatus) ||
          body.event !== undefined ||
          body.challenge !== undefined
        )
          throw new TwitchError("invalid_input");
      } else if (subscriptionType === "stream.online" && subscriptionVersion === "1") {
        const event = record(body.event);
        if (
          subscriptionStatus !== "enabled" ||
          broadcasterId(event.broadcaster_user_id) !== envelope.broadcasterId ||
          !["live", "playlist", "watch_party", "premiere", "rerun"].includes(String(event.type)) ||
          body.challenge !== undefined
        )
          throw new TwitchError("invalid_input");
        envelope.streamId = text(event.id);
        envelope.streamType = event.type as VerifiedEnvelope["streamType"];
        envelope.startedAt = timestamp(event.started_at);
      }
    } catch {
      return { status: 400, body: "" };
    }
    try {
      // No provider/API/Discord work precedes acknowledgement: COMMIT is the boundary.
      return this.options.store.accept(envelope);
    } catch (error) {
      if (error instanceof TwitchError)
        return {
          status:
            error.code === "message_collision" || error.code === "subscription_mismatch"
              ? 409
              : 400,
          body: "",
        };
      return { status: 503, body: "" };
    }
  }
}
