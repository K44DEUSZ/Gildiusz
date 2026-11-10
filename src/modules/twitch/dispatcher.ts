import { digest } from "../../shared/utils.js";
import type { TwitchHubStore } from "./store.js";
import { discordId, integer, liveStream, text } from "./validation.js";
import {
  TwitchError,
  type LiveStream,
  type TwitchAuthorize,
  type TwitchBinding,
  type TwitchJobInput,
  type TwitchPublication,
} from "./types.js";

export interface TwitchDispatcherOptions {
  store: TwitchHubStore;
  lookupLive(broadcasterId: string): Promise<LiveStream | null>;
  authorize: TwitchAuthorize;
  // The callback must commit through JobStore.enqueue with this exact dedupe key and input.
  enqueue(input: TwitchJobInput): { id: string } | Promise<{ id: string }>;
  maxNotificationAgeMs?: number;
}

export class TwitchDispatcher {
  readonly maxNotificationAgeMs: number;
  constructor(private readonly options: TwitchDispatcherOptions) {
    this.maxNotificationAgeMs = options.maxNotificationAgeMs ?? 600000;
    if (
      integer(this.maxNotificationAgeMs) < 1 ||
      this.maxNotificationAgeMs > 86400000 ||
      (options.store.retention.fanoutMs !== null &&
        options.store.retention.fanoutMs < this.maxNotificationAgeMs)
    )
      throw new TwitchError("invalid_input");
  }

  private fresh(startedAt: number): boolean {
    const now = this.options.store.now();
    return startedAt <= now + 60000 && startedAt >= now - this.maxNotificationAgeMs;
  }
  private publication(binding: TwitchBinding, stream: LiveStream): TwitchPublication {
    const refreshed = liveStream(stream, binding.broadcasterId);
    const values: Record<string, string> = {
      name: refreshed.displayName,
      title: refreshed.title,
      category: refreshed.category,
      url: refreshed.url,
    };
    let content = binding.template
      .replace(/\{(name|title|category|url)\}/g, (_, key: string) => values[key])
      .slice(0, 1900);
    if (!content.includes(refreshed.url)) content += `\n${refreshed.url}`;
    return {
      bindingId: binding.id,
      generation: binding.generation,
      guildId: binding.guildId,
      actorId: binding.actorId,
      channelId: binding.channelId,
      roleIds: [...binding.roleIds],
      mentionEveryone: binding.mentionEveryone,
      stream: refreshed,
      content,
    };
  }
  private authorize(binding: TwitchBinding): Promise<void> {
    return Promise.resolve(
      this.options.authorize({
        guildId: binding.guildId,
        actorId: binding.actorId,
        operation: "publish",
        bindingId: binding.id,
        channelId: binding.channelId,
        roleIds: binding.roleIds,
        mentionEveryone: binding.mentionEveryone,
      }),
    );
  }

  async drain(
    limit = 20,
  ): Promise<{ processed: number; queued: number; skipped: number; failed: number }> {
    const { store } = this.options;
    const result = { processed: 0, queued: 0, skipped: 0, failed: 0 };
    for (const event of store.pending(limit)) {
      if (!event.streamId || event.startedAt === undefined) {
        store.finishEvent(event.id);
        result.skipped++;
        continue;
      }
      if (!this.fresh(event.startedAt) || store.source(event.broadcasterId)?.status !== "enabled") {
        store.skipStream(event.broadcasterId, event.streamId, "stale_or_revoked");
        store.finishEvent(event.id);
        result.skipped++;
        continue;
      }
      let stream: LiveStream & { url: string };
      try {
        const current = await this.options.lookupLive(event.broadcasterId);
        if (!current || current.id !== event.streamId || !this.fresh(current.startedAt)) {
          store.skipStream(event.broadcasterId, event.streamId, "stream_offline_or_stale");
          store.finishEvent(event.id);
          result.skipped++;
          continue;
        }
        stream = liveStream(current, event.broadcasterId);
      } catch {
        store.eventError(event.id, "lookup_failed");
        result.failed++;
        continue;
      }
      let pending = false;
      for (const binding of store.sourceBindings(event.broadcasterId)) {
        let fanout = store.fanouts(binding.id).find((value) => value.streamId === event.streamId);
        if (fanout && fanout.state !== "pending") continue;
        if (!fanout) {
          if (!binding.enabled || binding.removed || binding.updatedAt > event.receivedAt) continue;
          const now = store.now();
          const job: TwitchJobInput = {
            guildId: binding.guildId,
            type: "twitch.send",
            objectId: binding.id,
            generation: binding.generation,
            dueAt: now,
            expiresAt: stream.startedAt + this.maxNotificationAgeMs,
            dedupeKey: `twitch:${digest({ bindingId: binding.id, streamId: stream.id })}`,
            payload: this.publication(binding, stream),
          };
          // Freeze the full cross-database enqueue input before calling the guild queue.
          fanout = store.prepareFanout(binding, stream.id, job);
        }
        if (!binding.enabled || binding.removed || binding.generation !== fanout.job.generation) {
          store.completeFanout(fanout.id, "skipped", "binding_changed");
          result.skipped++;
          continue;
        }
        try {
          await this.authorize(binding);
          const current = store.binding(binding.id);
          if (
            !current ||
            current.removed ||
            !current.enabled ||
            current.generation !== fanout.job.generation ||
            store.source(binding.broadcasterId)?.status !== "enabled" ||
            !this.fresh(stream.startedAt)
          ) {
            store.completeFanout(fanout.id, "skipped", "binding_changed");
            result.skipped++;
            continue;
          }
          const queued = await this.options.enqueue(fanout.job);
          store.completeFanout(fanout.id, "queued", text(queued.id));
          result.queued++;
        } catch (error) {
          if (
            error instanceof TwitchError &&
            ["permission_revoked", "channel_unavailable"].includes(error.code)
          ) {
            store.completeFanout(fanout.id, "skipped", error.code);
            result.skipped++;
          } else {
            pending = true;
            store.eventError(event.id, "enqueue_or_authorization_failed");
            result.failed++;
          }
        }
      }
      if (!pending) {
        store.finishEvent(event.id);
        result.processed++;
      }
    }
    return result;
  }

  async prepareDelivery(
    guild: string,
    id: string,
    generation: number,
    streamId: string,
  ): Promise<TwitchPublication | null> {
    const guildId = discordId(guild),
      binding = this.options.store.binding(text(id));
    integer(generation);
    text(streamId);
    if (
      !binding ||
      binding.guildId !== guildId ||
      binding.removed ||
      !binding.enabled ||
      binding.generation !== generation ||
      this.options.store.source(binding.broadcasterId)?.status !== "enabled"
    )
      return null;
    const stream = await this.options.lookupLive(binding.broadcasterId);
    if (!stream || stream.id !== streamId || !this.fresh(stream.startedAt)) return null;
    await this.authorize(binding);
    const current = this.options.store.binding(binding.id);
    if (
      !current ||
      current.generation !== generation ||
      current.removed ||
      !current.enabled ||
      this.options.store.source(current.broadcasterId)?.status !== "enabled" ||
      !this.fresh(stream.startedAt)
    )
      return null;
    return this.publication(current, stream);
  }
}
