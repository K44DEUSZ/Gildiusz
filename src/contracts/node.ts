import { createHash, createHmac } from "node:crypto";
import { signaturePayload } from "./protocol.js";
import { twitchProxyPayload } from "./twitch-proxy.js";

export function controlSignature(
  key: string,
  method: string,
  path: string,
  time: string,
  nonce: string,
  rawBody: string,
): string {
  return createHmac("sha256", key)
    .update(signaturePayload(method, path, time, nonce, rawBody))
    .digest("hex");
}

export function twitchProxySignature(
  key: string,
  time: string,
  nonce: string,
  headers: Record<string, unknown>,
  rawBody: Uint8Array,
): string {
  if (typeof key !== "string" || !/^[\x21-\x7e]{32,128}$/.test(key))
    throw new TypeError("Invalid Twitch proxy key.");
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  return createHmac("sha256", key)
    .update(twitchProxyPayload(time, nonce, headers, bodyHash))
    .digest("hex");
}
