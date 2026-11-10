import { createHash } from "node:crypto";
import { RateLimitError } from "discord.js";
import type { ExecutionContext, ExecutionOutcome } from "../jobs/runner.js";

export interface Publication {
  guildId: string;
  channelId: string;
  content: string;
  roleIds: string[];
  everyone: boolean;
  components?: TrustedButtonRow[];
  card?: PublicationCard;
  links?: { label: string; url: string }[];
  attachments?: AnnouncementAttachment[];
}
export interface AnnouncementAttachment {
  name: "announcement.png" | "announcement.jpg" | "announcement.webp";
  contentType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
}
export interface PublicationCard {
  title: string;
  description: string;
  color: number;
  image?: { attachmentName: AnnouncementAttachment["name"] };
}
export interface TrustedButtonRow {
  type: 1;
  components: {
    type: 2;
    style: 1 | 2 | 3 | 4;
    label: string;
    custom_id: string;
    disabled?: boolean;
  }[];
}
export interface DeliveryTransport {
  check(publication: Publication, signal: AbortSignal): Promise<void>;
  send(
    publication: Publication,
    options: { nonce: string; enforceNonce: true; signal: AbortSignal },
  ): Promise<{ id: string }>;
}

export function deliveryNonce(operationId: string): string {
  return BigInt(
    "0x" + createHash("sha256").update(operationId).digest("hex").slice(0, 16),
  ).toString();
}

export function validatePublication(publication: Publication): void {
  if (
    !/^\d{17,20}$/.test(publication.guildId) ||
    !/^\d{17,20}$/.test(publication.channelId) ||
    typeof publication.content !== "string" ||
    (!publication.content.trim() && !publication.card) ||
    publication.content.length > 2000 ||
    typeof publication.everyone !== "boolean" ||
    !Array.isArray(publication.roleIds) ||
    publication.roleIds.length > 20 ||
    new Set(publication.roleIds).size !== publication.roleIds.length ||
    publication.roleIds.some((id) => !/^\d{17,20}$/.test(id))
  )
    throw new Error("invalid_publication");
  if (publication.card !== undefined) {
    const card = publication.card;
    if (
      !card ||
      typeof card !== "object" ||
      Array.isArray(card) ||
      Object.keys(card).some((key) => !["title", "description", "color", "image"].includes(key)) ||
      typeof card.title !== "string" ||
      card.title.length > 256 ||
      card.title.includes("\0") ||
      typeof card.description !== "string" ||
      card.description.length > 4096 ||
      card.description.includes("\0") ||
      !Number.isInteger(card.color) ||
      card.color < 0 ||
      card.color > 0xffffff ||
      (!card.title.trim() && !card.description.trim() && !card.image)
    )
      throw new Error("invalid_publication_card");
    if (
      card.image !== undefined &&
      (!card.image ||
        typeof card.image !== "object" ||
        Array.isArray(card.image) ||
        Object.keys(card.image).some((key) => key !== "attachmentName") ||
        !["announcement.png", "announcement.jpg", "announcement.webp"].includes(
          card.image.attachmentName,
        ))
    )
      throw new Error("invalid_publication_card");
  }
  if (publication.links !== undefined) {
    if (
      !Array.isArray(publication.links) ||
      publication.links.length > 5 ||
      (publication.links.length && publication.components?.length)
    )
      throw new Error("invalid_publication_links");
    for (const link of publication.links) {
      if (
        !link ||
        typeof link !== "object" ||
        Array.isArray(link) ||
        Object.keys(link).some((key) => !["label", "url"].includes(key)) ||
        typeof link.label !== "string" ||
        !link.label.trim() ||
        link.label.length > 80 ||
        link.label.includes("\0") ||
        typeof link.url !== "string" ||
        link.url.length > 512 ||
        [...link.url].some(
          (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error("invalid_publication_links");
      let url: URL;
      try {
        url = new URL(link.url);
      } catch {
        throw new Error("invalid_publication_links");
      }
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
        throw new Error("invalid_publication_links");
    }
  }
  const files = publication.attachments ?? [];
  if (
    !Array.isArray(files) ||
    files.length > 1 ||
    Boolean(publication.card?.image) !== Boolean(files.length)
  )
    throw new Error("invalid_publication_attachment");
  for (const file of files) {
    const formats = {
      "announcement.png": "image/png",
      "announcement.jpg": "image/jpeg",
      "announcement.webp": "image/webp",
    };
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      Object.keys(file).some((key) => !["name", "contentType", "data"].includes(key)) ||
      formats[file.name] !== file.contentType ||
      !formats[file.name] ||
      !(file.data instanceof Uint8Array) ||
      !file.data.byteLength ||
      file.data.byteLength > 2 * 1024 * 1024 ||
      publication.card?.image?.attachmentName !== file.name
    )
      throw new Error("invalid_publication_attachment");
  }
  if (publication.components !== undefined) {
    const customId =
      /^gildiusz:(meeting|case):(\d{17,20}):[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}:([a-z]+)$/;
    const actions = {
      meeting: ["read", "join", "leave", "start", "complete", "cancel"],
      case: ["read", "assign", "approve", "up", "down", "unvote"],
    };
    const ids = new Set<string>();
    if (!Array.isArray(publication.components) || publication.components.length > 5)
      throw new Error("invalid_components");
    for (const row of publication.components) {
      if (
        !row ||
        Array.isArray(row) ||
        row.type !== 1 ||
        Object.keys(row).some((key) => !["type", "components"].includes(key)) ||
        !Array.isArray(row.components) ||
        row.components.length < 1 ||
        row.components.length > 5
      )
        throw new Error("invalid_components");
      for (const button of row.components) {
        const match =
          typeof button?.custom_id === "string" ? customId.exec(button.custom_id) : null;
        if (
          !button ||
          Array.isArray(button) ||
          button.type !== 2 ||
          ![1, 2, 3, 4].includes(button.style) ||
          typeof button.label !== "string" ||
          !button.label.trim() ||
          button.label.length > 80 ||
          typeof button.custom_id !== "string" ||
          button.custom_id.length > 100 ||
          !match ||
          match[2] !== publication.guildId ||
          !actions[match[1] as keyof typeof actions].includes(match[3]) ||
          ids.has(button.custom_id) ||
          (button.disabled !== undefined && typeof button.disabled !== "boolean") ||
          Object.keys(button).some(
            (key) => !["type", "style", "label", "custom_id", "disabled"].includes(key),
          )
        )
          throw new Error("invalid_components");
        ids.add(button.custom_id);
      }
    }
  }
}

export function publicationPresentation(publication: Publication) {
  validatePublication(publication);
  const card = publication.card;
  return {
    ...(card
      ? {
          embeds: [
            {
              ...(card.title ? { title: card.title } : {}),
              ...(card.description ? { description: card.description } : {}),
              color: card.color,
              ...(card.image
                ? { image: { url: `attachment://${card.image.attachmentName}` } }
                : {}),
            },
          ],
        }
      : {}),
    ...(publication.links?.length
      ? {
          components: [
            {
              type: 1,
              components: publication.links.map((link) => ({
                type: 2,
                style: 5,
                label: link.label,
                url: link.url,
              })),
            },
          ],
        }
      : publication.components
        ? { components: publication.components }
        : {}),
    ...(publication.attachments?.length
      ? {
          attachments: publication.attachments.map((file, index) => ({
            id: index,
            filename: file.name,
          })),
        }
      : {}),
  };
}

function responseError(error: unknown): { status?: number; retryAfterMs?: number } {
  if (!error || typeof error !== "object") return {};
  if (error instanceof RateLimitError) {
    const delay = Math.max(
      0,
      ...[error.retryAfter, error.timeToReset, error.sublimitTimeout].filter(
        (value) => Number.isFinite(value) && value > 0,
      ),
    );
    return { status: 429, ...(delay ? { retryAfterMs: delay } : {}) };
  }
  const value = error as { status?: unknown; retryAfter?: unknown; rawError?: unknown };
  const raw = value.rawError as { retry_after?: unknown } | undefined;
  // Discord's response body uses seconds; the SDK's retryAfter uses milliseconds.
  const retry =
    raw?.retry_after === undefined ? Number(value.retryAfter) : Number(raw.retry_after) * 1000;
  return {
    status: Number(value.status) || undefined,
    retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry : undefined,
  };
}

export async function publishDiscord(
  operationId: string,
  publication: Publication,
  execution: ExecutionContext,
  transport: DeliveryTransport,
): Promise<ExecutionOutcome> {
  // Keep the checked payload stable while permission checks await Discord.
  publication = structuredClone(publication);
  validatePublication(publication);
  try {
    await transport.check(publication, execution.signal);
  } catch (error) {
    const response = responseError(error);
    if (response.status === 429)
      return {
        state: "retry",
        at: execution.now() + Math.ceil(response.retryAfterMs ?? 5000),
        error: "discord_rate_limit",
        rateLimited: true,
      };
    if (
      response.status &&
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    )
      return { state: "failed", error: "channel_or_permission_unavailable" };
    throw error;
  }
  execution.checkpoint();
  const nonce = deliveryNonce(operationId);
  execution.beginAttempt({ channelId: publication.channelId, nonce });
  try {
    const message = await transport.send(publication, {
      nonce,
      enforceNonce: true,
      signal: execution.signal,
    });
    if (!/^\d{17,20}$/.test(message.id))
      return { state: "unknown", error: "invalid_delivery_confirmation" };
    return { state: "succeeded", messageId: message.id };
  } catch (error) {
    const response = responseError(error);
    if (response.status === 429)
      return {
        state: "retry",
        at: execution.now() + Math.ceil(response.retryAfterMs ?? 5000),
        error: "discord_rate_limit",
        rateLimited: true,
      };
    if (
      response.status &&
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    )
      return { state: "failed", error: "discord_rejected_publication" };
    // An interrupted request or 5xx response can follow acceptance by Discord.
    return { state: "unknown", error: "discord_delivery_unconfirmed" };
  }
}
