export const twitchEventSubHeaders = [
  "twitch-eventsub-message-id",
  "twitch-eventsub-message-timestamp",
  "twitch-eventsub-message-signature",
  "twitch-eventsub-message-type",
  "twitch-eventsub-subscription-type",
  "twitch-eventsub-subscription-version",
  "twitch-eventsub-message-retry",
] as const;
export type TwitchEventSubHeader = (typeof twitchEventSubHeaders)[number];
export type TwitchProxyHeaders = Partial<Record<TwitchEventSubHeader, string>>;
export const twitchProxyHeaders = {
  time: "x-gildiusz-proxy-time",
  nonce: "x-gildiusz-proxy-nonce",
  signature: "x-gildiusz-proxy-signature",
} as const;
export const twitchProxyLimits = {
  bodyBytes: 65536,
  activeRequests: 8,
  requestsPerMinute: 240,
  timeoutMs: 5000,
  clockSkewMs: 30000,
  nonceLifetimeMs: 60000,
} as const;

export function normalizeTwitchProxyHeaders(input: Record<string, unknown>): TwitchProxyHeaders {
  const result: TwitchProxyHeaders = {};
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase() as TwitchEventSubHeader;
    if (!(twitchEventSubHeaders as readonly string[]).includes(name) || value === undefined)
      continue;
    if (
      Object.hasOwn(result, name) ||
      typeof value !== "string" ||
      !value.length ||
      value.length > 512 ||
      /[\r\n]/.test(value)
    )
      throw new TypeError("Invalid Twitch proxy headers.");
    result[name] = value;
  }
  return result;
}

export function twitchProxyPayload(
  time: string,
  nonce: string,
  headers: Record<string, unknown>,
  bodyHash: string,
): string {
  if (!/^\d{13}$/.test(time) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(bodyHash))
    throw new TypeError("Invalid Twitch proxy envelope.");
  const normalized = normalizeTwitchProxyHeaders(headers);
  return JSON.stringify([
    "gildiusz-twitch-proxy-v1",
    "POST",
    "/eventsub",
    time,
    nonce,
    twitchEventSubHeaders.map((name) => [name, normalized[name] ?? null]),
    bodyHash,
  ]);
}
