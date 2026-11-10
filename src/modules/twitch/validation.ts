import { Temporal } from "@js-temporal/polyfill";
import { TwitchError, type TwitchBindingInput, type LiveStream } from "./types.js";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TwitchError("invalid_input");
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum = 256): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new TwitchError("invalid_input");
  return value;
}
export function discordId(value: unknown): string {
  const result = text(value, 20);
  if (!/^\d{17,20}$/.test(result)) throw new TwitchError("invalid_input");
  return result;
}
export function broadcasterId(value: unknown): string {
  const result = text(value, 25);
  if (!/^\d{1,25}$/.test(result)) throw new TwitchError("invalid_input");
  return result;
}
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum)
    throw new TwitchError("invalid_input");
  return value as number;
}
export function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    throw new TwitchError("invalid_input");
  try {
    return integer(Temporal.Instant.from(value).epochMilliseconds);
  } catch {
    throw new TwitchError("invalid_input");
  }
}
export function bindingInput(value: unknown): TwitchBindingInput {
  const input = record(value);
  const keys = ["broadcasterId", "channelId", "template", "roleIds", "mentionEveryone", "enabled"];
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(input, key))
  )
    throw new TwitchError("invalid_input");
  const template = input.template;
  if (
    typeof template !== "string" ||
    !template.trim() ||
    template.length > 1600 ||
    /\{([^{}]+)\}/g.test(template.replace(/\{(?:name|title|category|url)\}/g, ""))
  )
    throw new TwitchError("invalid_input");
  if (
    !Array.isArray(input.roleIds) ||
    input.roleIds.length > 20 ||
    new Set(input.roleIds).size !== input.roleIds.length ||
    typeof input.enabled !== "boolean" ||
    typeof input.mentionEveryone !== "boolean"
  )
    throw new TwitchError("invalid_input");
  const roleIds = Array.from(input.roleIds, discordId);
  return {
    broadcasterId: broadcasterId(input.broadcasterId),
    channelId: discordId(input.channelId),
    template,
    roleIds,
    enabled: input.enabled,
    mentionEveryone: input.mentionEveryone,
  };
}
export function liveStream(
  input: LiveStream,
  expectedBroadcaster: string,
): LiveStream & { url: string } {
  const value = record(input);
  if (
    broadcasterId(value.broadcasterId) !== expectedBroadcaster ||
    typeof value.login !== "string" ||
    !/^[a-z0-9_]{1,25}$/.test(value.login)
  )
    throw new TwitchError("invalid_input");
  const thumbnailUrl = text(value.thumbnailUrl, 2048);
  const thumbnail = new URL(thumbnailUrl);
  if (
    thumbnail.protocol !== "https:" ||
    thumbnail.hostname !== "static-cdn.jtvnw.net" ||
    thumbnail.port ||
    thumbnail.username ||
    thumbnail.password
  )
    throw new TwitchError("invalid_input");
  const limited = (entry: unknown, maximum: number) => {
    if (typeof entry !== "string" || entry.length > maximum) throw new TwitchError("invalid_input");
    return entry;
  };
  return {
    id: text(value.id),
    broadcasterId: expectedBroadcaster,
    login: value.login,
    displayName: text(value.displayName, 100),
    title: limited(value.title, 500),
    category: limited(value.category, 200),
    thumbnailUrl,
    startedAt: integer(value.startedAt),
    url: `https://www.twitch.tv/${value.login}`,
  };
}
