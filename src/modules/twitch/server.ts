import { createServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  normalizeTwitchProxyHeaders,
  twitchEventSubHeaders,
  twitchProxyHeaders,
  twitchProxyLimits,
} from "../../contracts/twitch-proxy.js";
import { twitchProxySignature } from "../../contracts/node.js";
import type { EventSubReceiver } from "./webhook.js";

export interface TwitchIngressOptions {
  receiver?: Pick<EventSubReceiver, "receive">;
  proxySecret: string;
  forbiddenSecrets?: readonly string[];
  port: number;
  allowEphemeralPort?: boolean;
  clock?: () => number;
  limits?: { activeRequests?: number; requestsPerMinute?: number; timeoutMs?: number };
}
export interface TwitchIngress {
  listen(): Promise<AddressInfo>;
  address(): AddressInfo | null;
  close(): Promise<void>;
}
class IngressError extends Error {
  constructor(readonly status: number) {
    super("twitch_ingress_rejected");
  }
}

export function createTwitchIngress(options: TwitchIngressOptions): TwitchIngress {
  const { proxySecret, receiver } = options;
  const limits = { ...twitchProxyLimits, ...options.limits },
    clock = options.clock ?? Date.now;
  if (
    !/^[\x21-\x7e]{32,128}$/.test(proxySecret) ||
    options.forbiddenSecrets?.includes(proxySecret) ||
    !Number.isInteger(options.port) ||
    (options.port === 0
      ? !options.allowEphemeralPort
      : options.port < 1024 || options.port > 65535) ||
    !Number.isInteger(limits.activeRequests) ||
    limits.activeRequests < 1 ||
    limits.activeRequests > 32 ||
    !Number.isInteger(limits.requestsPerMinute) ||
    limits.requestsPerMinute < 1 ||
    limits.requestsPerMinute > 2400 ||
    !Number.isInteger(limits.timeoutMs) ||
    limits.timeoutMs < 100 ||
    limits.timeoutMs > 15000
  )
    throw new Error("Invalid private Twitch ingress configuration.");
  let active = 0,
    windowAt = clock(),
    requests = 0;
  const nonces = new Map<string, number>();
  const reply = (response: ServerResponse, status: number, body = "") => {
    if (response.writableEnded || response.destroyed) return;
    response.statusCode = status;
    response.end(body);
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    let counted = false;
    const deadline = setTimeout(() => {
      reply(response, 408);
      request.destroy();
    }, limits.timeoutMs);
    try {
      const now = clock();
      if (now - windowAt >= 60000) {
        windowAt = now;
        requests = 0;
      }
      if (++requests > limits.requestsPerMinute || active >= limits.activeRequests) {
        response.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil((windowAt + 60000 - now) / 1000))),
        );
        throw new IngressError(429);
      }
      active++;
      counted = true;
      if (request.method !== "POST" || request.url !== "/eventsub") throw new IngressError(404);
      const seen = new Set<string>(),
        protectedNames = new Set<string>([
          ...twitchEventSubHeaders,
          ...Object.values(twitchProxyHeaders),
        ]);
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index].toLowerCase();
        if (protectedNames.has(name) && seen.has(name)) throw new IngressError(400);
        seen.add(name);
      }
      const header = (name: string) =>
        typeof request.headers[name] === "string" ? (request.headers[name] as string) : "";
      const time = header(twitchProxyHeaders.time),
        nonce = header(twitchProxyHeaders.nonce),
        signature = header(twitchProxyHeaders.signature);
      if (
        !/^\d{13}$/.test(time) ||
        Math.abs(now - Number(time)) > limits.clockSkewMs ||
        !/^[a-f0-9]{32}$/.test(nonce) ||
        !/^[a-f0-9]{64}$/.test(signature)
      )
        throw new IngressError(401);
      const contentLength = request.headers["content-length"];
      if (
        contentLength !== undefined &&
        (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))
      )
        throw new IngressError(400);
      if (contentLength !== undefined && Number(contentLength) > limits.bodyBytes)
        throw new IngressError(413);
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const part = Buffer.from(chunk);
        length += part.byteLength;
        if (length > limits.bodyBytes) throw new IngressError(413);
        chunks.push(part);
      }
      const rawBody = Buffer.concat(chunks);
      let twitchHeaders;
      try {
        twitchHeaders = normalizeTwitchProxyHeaders(request.headers);
      } catch {
        throw new IngressError(400);
      }
      const expected = twitchProxySignature(proxySecret, time, nonce, twitchHeaders, rawBody);
      for (const [value, expiresAt] of nonces) if (expiresAt <= clock()) nonces.delete(value);
      if (
        !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex")) ||
        nonces.has(nonce) ||
        Math.abs(clock() - Number(time)) > limits.clockSkewMs
      )
        throw new IngressError(401);
      if (nonces.size > limits.requestsPerMinute * 2) throw new IngressError(429);
      nonces.set(nonce, clock() + limits.nonceLifetimeMs);
      if (!receiver) throw new IngressError(503);
      const received = receiver.receive({ headers: twitchHeaders, rawBody });
      if (
        !received ||
        !Number.isInteger(received.status) ||
        received.status < 200 ||
        received.status > 599 ||
        typeof received.body !== "string"
      )
        throw new IngressError(503);
      if (received.headers?.["content-type"] === "text/plain; charset=utf-8")
        response.setHeader("Content-Type", received.headers["content-type"]);
      reply(response, received.status, received.body);
    } catch (error) {
      reply(response, error instanceof IngressError ? error.status : 503);
    } finally {
      clearTimeout(deadline);
      if (counted) active--;
      if (!request.complete) request.destroy();
    }
  });
  server.requestTimeout = limits.timeoutMs;
  server.headersTimeout = limits.timeoutMs;
  let starting: Promise<AddressInfo> | undefined;
  return {
    listen() {
      if (!starting)
        starting = new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(options.port, "127.0.0.1", () => resolve(server.address() as AddressInfo));
        });
      return starting;
    },
    address: () => server.address() as AddressInfo | null,
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
