import type { TwitchHubStore } from "./store.js";
import { webhookSecretRef } from "./webhook.js";
import { broadcasterId, integer, liveStream, record, text, timestamp } from "./validation.js";
import type { LiveStream, SubscriptionIntent, TwitchBinding } from "./types.js";
import type { TwitchBroadcaster } from "../../contracts/twitch.js";
import { TwitchError } from "./types.js";

export type TwitchProviderErrorCode =
  | "invalid_configuration"
  | "invalid_response"
  | "network"
  | "timeout"
  | "rate_limited"
  | "unauthorized"
  | "provider_unavailable"
  | "subscription_conflict"
  | "subscription_rejected"
  | "ambiguous_create"
  | "pagination_limit"
  | "closed";
export class TwitchProviderError extends Error {
  constructor(
    readonly code: TwitchProviderErrorCode,
    readonly status?: number,
    readonly retryAt?: number,
  ) {
    super(code);
    this.name = "TwitchProviderError";
  }
}
export interface TwitchProviderOptions {
  store: TwitchHubStore;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  callbackUrl: string;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
  maxWaitMs?: number;
  activeBinding?: (binding: TwitchBinding) => boolean | undefined;
}
interface ResponseData {
  status: number;
  headers: Headers;
  body?: unknown;
}
interface AppToken {
  value: string;
  expiresAt: number;
  refreshAt: number;
  validatedAt: number;
}
interface Subscription {
  id: string;
  broadcasterId: string;
  callbackUrl: string;
  status: string;
}
export interface ReconciliationResult {
  created: number;
  adopted: number;
  deleted: number;
  pending: number;
  errors: { broadcasterId: string; code: string }[];
}
const oauth = "https://id.twitch.tv",
  helix = "https://api.twitch.tv";
const active = (value: Subscription) =>
  ["enabled", "webhook_callback_verification_pending"].includes(value.status);
const mode = (value: Subscription) =>
  value.status === "enabled" ? ("enabled" as const) : ("pending" as const);

export class TwitchProvider {
  readonly #store: TwitchHubStore;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #webhookSecret: string;
  readonly #secretRef: string;
  readonly #callback: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #timeout: number;
  readonly #retries: number;
  readonly #maxWait: number;
  #token?: AppToken;
  #tokenFlight?: Promise<AppToken>;
  #reconcileFlight?: Promise<ReconciliationResult>;
  #validationTimer?: ReturnType<typeof setTimeout>;
  #closed = false;
  #blockedUntil = 0;
  readonly #controllers = new Set<AbortController>();
  readonly #activeBinding?: TwitchProviderOptions["activeBinding"];

  constructor(options: TwitchProviderOptions) {
    try {
      this.#clientId = text(options.clientId, 128);
      this.#clientSecret = text(options.clientSecret, 256);
      this.#webhookSecret = text(options.webhookSecret, 100);
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(this.#clientId) ||
        !/^[\x20-\x7e]{32,100}$/.test(this.#webhookSecret)
      )
        throw Error();
      const callback = new URL(options.callbackUrl);
      if (
        callback.protocol !== "https:" ||
        callback.port ||
        callback.username ||
        callback.password ||
        callback.search ||
        callback.hash
      )
        throw Error();
      this.#callback = callback.href;
      this.#timeout = integer(options.timeoutMs ?? 10000);
      this.#retries = integer(options.retries ?? 2);
      this.#maxWait = integer(options.maxWaitMs ?? 2000);
      if (this.#timeout < 10 || this.#timeout > 30000 || this.#retries > 3 || this.#maxWait > 10000)
        throw Error();
    } catch {
      throw new TwitchProviderError("invalid_configuration");
    }
    this.#secretRef = webhookSecretRef(this.#webhookSecret);
    this.#store = options.store;
    this.#activeBinding = options.activeBinding;
    this.#clock = options.clock ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }
  close(): void {
    this.#closed = true;
    this.#token = undefined;
    clearTimeout(this.#validationTimer);
    for (const controller of this.#controllers) controller.abort();
  }
  #now(): number {
    return integer(this.#clock());
  }
  #scheduleValidation(): void {
    clearTimeout(this.#validationTimer);
    if (this.#closed || !this.#token) return;
    this.#validationTimer = setTimeout(() => {
      void this.#appToken().catch(() => {
        this.#token = undefined;
      });
    }, 3600000);
    this.#validationTimer.unref();
  }
  async #exchange(url: URL, init: RequestInit): Promise<ResponseData> {
    if (this.#closed) throw new TwitchProviderError("closed");
    if (!(
      (url.origin === oauth && ["/oauth2/token", "/oauth2/validate"].includes(url.pathname)) ||
      (url.origin === helix &&
        ["/helix/eventsub/subscriptions", "/helix/streams", "/helix/users"].includes(url.pathname))
    ))
      throw new TwitchProviderError("invalid_configuration");
    const controller = new AbortController();
    this.#controllers.add(controller);
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new TwitchProviderError(this.#closed ? "closed" : "timeout"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(url, {
            ...init,
            signal: controller.signal,
            redirect: "error",
          });
          if (!response.ok || response.status === 204) {
            void response.body?.cancel().catch(() => {});
            return { status: response.status, headers: response.headers };
          }
          const reader = response.body?.getReader();
          if (!reader) throw new TwitchProviderError("invalid_response");
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > 1048576) throw new TwitchProviderError("invalid_response");
              chunks.push(next.value);
            }
          } finally {
            void reader.cancel().catch(() => {});
          }
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            throw new TwitchProviderError("invalid_response");
          }
          return { status: response.status, headers: response.headers, body };
        })(),
        aborted,
      ]);
    } catch (error) {
      if (error instanceof TwitchProviderError) throw error;
      throw new TwitchProviderError(
        this.#closed ? "closed" : controller.signal.aborted ? "timeout" : "network",
      );
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      this.#controllers.delete(controller);
    }
  }
  #retryAt(headers: Headers): number {
    const now = this.#now(),
      retry = headers.get("retry-after"),
      reset = Number(headers.get("ratelimit-reset"));
    const seconds = retry === null ? NaN : Number(retry);
    const retryAt =
      Number.isFinite(seconds) && seconds >= 0
        ? now + seconds * 1000
        : retry
          ? Date.parse(retry)
          : NaN;
    const candidates = [now + 1000, retryAt, reset * 1000].filter(
      (value) => Number.isSafeInteger(value) && value >= now,
    );
    return Math.min(now + 86400000, Math.max(...candidates));
  }
  async #request(url: URL, init: RequestInit, safe: boolean): Promise<ResponseData> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.#blockedUntil - this.#now();
      if (wait > this.#maxWait)
        throw new TwitchProviderError("rate_limited", 429, this.#blockedUntil);
      if (wait > 0) await this.#sleep(wait);
      let response: ResponseData;
      try {
        response = await this.#exchange(url, init);
      } catch (error) {
        if (
          safe &&
          error instanceof TwitchProviderError &&
          ["network", "timeout"].includes(error.code) &&
          attempt < this.#retries
        ) {
          await this.#sleep(Math.min(this.#maxWait, 250 * 2 ** attempt));
          continue;
        }
        throw error;
      }
      if (response.status === 429) {
        this.#blockedUntil = this.#retryAt(response.headers);
        if (attempt < this.#retries && this.#blockedUntil - this.#now() <= this.#maxWait) continue;
        throw new TwitchProviderError("rate_limited", 429, this.#blockedUntil);
      }
      if (response.status >= 500 && safe && attempt < this.#retries) {
        await this.#sleep(Math.min(this.#maxWait, 250 * 2 ** attempt));
        continue;
      }
      if (response.headers.get("ratelimit-remaining") === "0")
        this.#blockedUntil = this.#retryAt(response.headers);
      return response;
    }
  }
  #httpError(status: number, create = false): TwitchProviderError {
    return new TwitchProviderError(
      status === 401
        ? "unauthorized"
        : status === 409
          ? "subscription_conflict"
          : status >= 500
            ? create
              ? "ambiguous_create"
              : "provider_unavailable"
            : "subscription_rejected",
      status,
    );
  }
  async #validateToken(token: AppToken): Promise<AppToken> {
    const result = await this.#request(
      new URL("/oauth2/validate", oauth),
      { headers: { Authorization: `OAuth ${token.value}` } },
      true,
    );
    if (result.status !== 200) throw this.#httpError(result.status);
    try {
      const value = record(result.body),
        ttl = integer(value.expires_in);
      if (
        value.client_id !== this.#clientId ||
        value.user_id != null ||
        value.login != null ||
        ttl < 1 ||
        ttl > 366 * 86400
      )
        throw Error();
      const expiresAt = Math.min(token.expiresAt, this.#now() + ttl * 1000);
      return {
        ...token,
        expiresAt,
        refreshAt: expiresAt - Math.min(60000, ttl * 200),
        validatedAt: this.#now(),
      };
    } catch {
      throw new TwitchProviderError("invalid_response");
    }
  }
  async #issueToken(): Promise<AppToken> {
    const body = new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: "client_credentials",
    });
    const result = await this.#request(
      new URL("/oauth2/token", oauth),
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
      true,
    );
    if (result.status !== 200) throw this.#httpError(result.status);
    let token: AppToken;
    try {
      const value = record(result.body),
        ttl = integer(value.expires_in),
        access = text(value.access_token, 512);
      if (
        !/^[A-Za-z0-9._-]+$/.test(access) ||
        value.token_type !== "bearer" ||
        ttl < 1 ||
        ttl > 366 * 86400
      )
        throw Error();
      const now = this.#now();
      token = {
        value: access,
        expiresAt: now + ttl * 1000,
        refreshAt: now + ttl * 1000 - Math.min(60000, ttl * 200),
        validatedAt: now,
      };
    } catch {
      throw new TwitchProviderError("invalid_response");
    }
    return this.#validateToken(token);
  }
  async #appToken(): Promise<AppToken> {
    if (this.#closed) throw new TwitchProviderError("closed");
    const current = this.#token;
    if (current && current.refreshAt > this.#now() && current.validatedAt > this.#now() - 3600000)
      return current;
    if (!this.#tokenFlight) {
      this.#tokenFlight = (async () => {
        let token: AppToken;
        if (current && current.refreshAt > this.#now()) {
          try {
            token = await this.#validateToken(current);
          } catch (error) {
            if (error instanceof TwitchProviderError && error.code === "unauthorized")
              token = await this.#issueToken();
            else throw error;
          }
        } else token = await this.#issueToken();
        if (this.#closed) throw new TwitchProviderError("closed");
        this.#token = token;
        this.#scheduleValidation();
        return token;
      })().finally(() => {
        this.#tokenFlight = undefined;
      });
    }
    return this.#tokenFlight;
  }
  async #api(
    method: "GET" | "POST" | "DELETE",
    path: "/helix/streams" | "/helix/eventsub/subscriptions" | "/helix/users",
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<ResponseData> {
    const url = new URL(path, helix);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    for (let authorizationAttempt = 0; ; authorizationAttempt++) {
      const token = await this.#appToken();
      let result: ResponseData;
      try {
        result = await this.#request(
          url,
          {
            method,
            headers: {
              Authorization: `Bearer ${token.value}`,
              "Client-Id": this.#clientId,
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          method !== "POST",
        );
      } catch (error) {
        if (
          method === "POST" &&
          error instanceof TwitchProviderError &&
          ["network", "timeout", "invalid_response"].includes(error.code)
        )
          throw new TwitchProviderError("ambiguous_create");
        throw error;
      }
      if (result.status === 401 && authorizationAttempt === 0) {
        if (this.#token?.value === token.value) this.#token = undefined;
        continue;
      }
      if (result.status >= 400 && !(method === "DELETE" && result.status === 404))
        throw this.#httpError(result.status, method === "POST");
      if (method === "DELETE" && result.status === 404) return result;
      if (result.status >= 300) throw new TwitchProviderError("invalid_response");
      if (result.status !== (method === "GET" ? 200 : method === "POST" ? 202 : 204))
        throw new TwitchProviderError(method === "POST" ? "ambiguous_create" : "invalid_response");
      return result;
    }
  }
  async getLive(broadcaster: string): Promise<LiveStream | null> {
    const expected = broadcasterId(broadcaster),
      result = await this.#api("GET", "/helix/streams", { user_id: expected });
    try {
      const value = record(result.body);
      if (!Array.isArray(value.data) || value.data.length > 1) throw Error();
      if (!value.data.length) return null;
      const stream = record(value.data[0]);
      if (stream.type !== "live") throw Error();
      return liveStream(
        {
          id: text(stream.id),
          broadcasterId: text(stream.user_id),
          login: text(stream.user_login),
          displayName: text(stream.user_name),
          title: stream.title as string,
          category: stream.game_name as string,
          thumbnailUrl: text(stream.thumbnail_url, 2048),
          startedAt: timestamp(stream.started_at),
        },
        expected,
      );
    } catch {
      throw new TwitchProviderError("invalid_response");
    }
  }
  async lookupBroadcaster(login: string): Promise<TwitchBroadcaster | null> {
    if (typeof login !== "string" || !/^[a-zA-Z0-9_]{1,25}$/.test(login))
      throw new TwitchError("invalid_input");
    const expected = login.toLowerCase(),
      response = await this.#api("GET", "/helix/users", { login: expected });
    try {
      const value = record(response.body);
      if (!Array.isArray(value.data) || value.data.length > 1) throw Error();
      if (!value.data.length) return null;
      const user = record(value.data[0]);
      if (user.login !== expected) throw Error();
      return {
        id: broadcasterId(user.id),
        login: expected,
        displayName: text(user.display_name, 100),
      };
    } catch {
      throw new TwitchProviderError("invalid_response");
    }
  }
  async #subscriptions(): Promise<Subscription[]> {
    const result: Subscription[] = [],
      seen = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      const response = await this.#api("GET", "/helix/eventsub/subscriptions", {
        type: "stream.online",
        ...(cursor ? { after: cursor } : {}),
      });
      try {
        const value = record(response.body);
        if (!Array.isArray(value.data) || value.data.length > 100) throw Error();
        for (const item of value.data) {
          const subscription = record(item),
            transport = record(subscription.transport);
          if (
            subscription.type !== "stream.online" ||
            subscription.version !== "1" ||
            transport.method !== "webhook"
          )
            continue;
          result.push({
            id: text(subscription.id),
            status: text(subscription.status),
            broadcasterId: broadcasterId(record(subscription.condition).broadcaster_user_id),
            callbackUrl: text(transport.callback, 2048),
          });
        }
        const next = record(value.pagination ?? {}).cursor;
        if (next === undefined) return result;
        cursor = text(next, 2048);
        if (seen.has(cursor)) throw Error();
        seen.add(cursor);
      } catch {
        throw new TwitchProviderError("invalid_response");
      }
    }
    throw new TwitchProviderError("pagination_limit");
  }
  #intentFor(subscription: Subscription): SubscriptionIntent | undefined {
    return this.#store
      .subscriptionIntents(subscription.broadcasterId)
      .find(
        (intent) =>
          intent.callbackUrl === subscription.callbackUrl &&
          (intent.subscriptionId === null || intent.subscriptionId === subscription.id),
      );
  }
  async #delete(subscription: Subscription): Promise<void> {
    const intent = this.#intentFor(subscription);
    await this.#api("DELETE", "/helix/eventsub/subscriptions", { id: subscription.id });
    this.#store.revokeSubscriptionIfCurrent(
      subscription.broadcasterId,
      subscription.id,
      "provider_subscription_removed",
    );
    if (intent) this.#store.retireSubscriptionIntent(intent.id, subscription.id);
  }
  reconcile(): Promise<ReconciliationResult> {
    if (!this.#reconcileFlight)
      this.#reconcileFlight = this.#reconcile().finally(() => {
        this.#reconcileFlight = undefined;
      });
    return this.#reconcileFlight;
  }
  async #reconcile(): Promise<ReconciliationResult> {
    const snapshots = this.#store.sources();
    const subscriptions = await this.#subscriptions(),
      result: ReconciliationResult = { created: 0, adopted: 0, deleted: 0, pending: 0, errors: [] };
    for (const snapshot of snapshots) {
      const stored = this.#store.source(snapshot.broadcasterId);
      if (!stored) continue;
      const states = this.#store
        .sourceBindings(snapshot.broadcasterId)
        .filter((binding) => binding.enabled && !binding.removed)
        .map((binding) => (this.#activeBinding ? this.#activeBinding(binding) : true));
      if (!states.includes(true) && states.includes(undefined)) {
        result.pending++;
        continue;
      }
      const source = {
        ...stored,
        activeBindingCount: states.filter((value) => value === true).length,
      };
      if (source.subscriptionId !== snapshot.subscriptionId || source.status !== snapshot.status) {
        result.pending++;
        continue;
      }
      try {
        const candidates = subscriptions.filter(
          (value) => value.broadcasterId === source.broadcasterId,
        );
        const owned = candidates.filter(
          (value) =>
            Boolean(this.#intentFor(value)) ||
            (value.id === source.subscriptionId && value.callbackUrl === this.#callback),
        );
        let retained = false;
        for (const value of owned) {
          const intent = this.#intentFor(value);
          if (
            source.activeBindingCount &&
            (source.status !== "revoked" || source.subscriptionId !== value.id) &&
            active(value) &&
            intent?.secretRef === this.#secretRef &&
            (intent.state !== "pending" || intent.attemptedAt !== null) &&
            !["superseded", "expired"].includes(intent.state) &&
            (intent.state !== "confirmed" || source.subscriptionId === value.id) &&
            (intent.state === "confirmed" || intent.expiresAt > this.#now())
          ) {
            this.#store.completeSubscriptionIntent(intent.id, value.id, mode(value));
            retained = true;
            result.adopted++;
            break;
          }
        }
        for (const value of owned) {
          const current = this.#store.source(source.broadcasterId)!;
          if (retained && value.id === current.subscriptionId) continue;
          await this.#delete(value);
          result.deleted++;
        }
        const latest = this.#store.source(source.broadcasterId);
        if (!latest?.activeBindingCount || !source.activeBindingCount || retained) continue;
        if (latest.subscriptionId !== source.subscriptionId && latest.status !== "revoked") {
          result.pending++;
          continue;
        }
        const intent = this.#store.beginSubscriptionIntent(
          source.broadcasterId,
          this.#callback,
          this.#secretRef,
        );
        if (!this.#store.markSubscriptionAttempt(intent.id)) {
          result.pending++;
          continue;
        }
        try {
          const response = await this.#api(
            "POST",
            "/helix/eventsub/subscriptions",
            {},
            {
              type: "stream.online",
              version: "1",
              condition: { broadcaster_user_id: source.broadcasterId },
              transport: {
                method: "webhook",
                callback: intent.callbackUrl,
                secret: this.#webhookSecret,
              },
            },
          );
          const body = record(response.body);
          if (!Array.isArray(body.data) || body.data.length !== 1)
            throw new TwitchProviderError("invalid_response");
          const value = record(body.data[0]),
            transport = record(value.transport);
          if (
            value.type !== "stream.online" ||
            value.version !== "1" ||
            record(value.condition).broadcaster_user_id !== source.broadcasterId ||
            transport.method !== "webhook" ||
            transport.callback !== intent.callbackUrl ||
            !["enabled", "webhook_callback_verification_pending"].includes(String(value.status))
          )
            throw new TwitchProviderError("invalid_response");
          this.#store.completeSubscriptionIntent(
            intent.id,
            text(value.id),
            value.status === "enabled" ? "enabled" : "pending",
          );
          result.created++;
        } catch (error) {
          if (
            error instanceof TwitchProviderError &&
            (error.status === 429 ||
              (error.status !== undefined &&
                error.status >= 400 &&
                error.status < 500 &&
                error.status !== 409))
          )
            this.#store.deferSubscriptionIntent(intent.id, error.retryAt ?? this.#now() + 60000);
          throw error;
        }
      } catch (error) {
        result.errors.push({
          broadcasterId: source.broadcasterId,
          code:
            error instanceof TwitchProviderError ? error.code : "provider_reconciliation_failed",
        });
      }
    }
    return result;
  }
}

export function twitchProviderFromEnvironment(
  store: TwitchHubStore,
  options: Omit<
    TwitchProviderOptions,
    "store" | "clientId" | "clientSecret" | "webhookSecret" | "callbackUrl"
  > = {},
): TwitchProvider {
  return new TwitchProvider({
    ...options,
    store,
    clientId: process.env.TWITCH_CLIENT_ID ?? "",
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? "",
    webhookSecret: process.env.TWITCH_WEBHOOK_SECRET ?? "",
    callbackUrl: process.env.TWITCH_CALLBACK_URL ?? "",
  });
}
