import { ControlError } from "./configuration.js";

export const contractsVersion = "0.8.0";
export const schemaVersion = 1 as const;
export const controlMethod = "POST" as const;
export const controlHeaderNames = [
  "x-gildiusz-time",
  "x-gildiusz-nonce",
  "x-gildiusz-signature",
] as const;
export const controlLimits = {
  bodyBytes: 49152,
  clockSkewMs: 30000,
  nonceLifetimeMs: 60000,
  activeRequests: 8,
  requestsPerMinute: 240,
} as const;
export const announcementAssetLimits = {
  bytes: 2097152,
  controlBodyBytes: 3145728,
  width: 2048,
  height: 2048,
  unlinkedRetentionMs: 86400000,
} as const;

export const controlOperations = {
  "guilds.list": { method: "GET", path: "/v1/guilds", mutation: false },
  "capabilities.read": {
    method: "GET",
    path: "/v1/guilds/{guildId}/capabilities",
    mutation: false,
  },
  "settings.read": { method: "GET", path: "/v1/guilds/{guildId}/settings", mutation: false },
  "settings.save": { method: "PUT", path: "/v1/guilds/{guildId}/settings/save", mutation: true },
  "rules.read": { method: "GET", path: "/v1/guilds/{guildId}/rules", mutation: false },
  "rules.configure": {
    method: "PUT",
    path: "/v1/guilds/{guildId}/rules/configure",
    mutation: true,
  },
  "rules.publish": {
    method: "POST",
    path: "/v1/guilds/{guildId}/rules/publish",
    mutation: true,
  },
  "rules.acceptances.list": {
    method: "POST",
    path: "/v1/guilds/{guildId}/rules/acceptances",
    mutation: false,
  },
  "rules.publications.reconcile": {
    method: "POST",
    path: "/v1/guilds/{guildId}/rules/{objectId}/reconcile",
    mutation: true,
  },
  "meetings.list": { method: "GET", path: "/v1/guilds/{guildId}/meetings", mutation: false },
  "meetings.preview": {
    method: "POST",
    path: "/v1/guilds/{guildId}/meetings/preview",
    mutation: false,
  },
  "meetings.create": {
    method: "POST",
    path: "/v1/guilds/{guildId}/meetings/create",
    mutation: true,
  },
  "meetings.read": {
    method: "GET",
    path: "/v1/guilds/{guildId}/meetings/{objectId}/read",
    mutation: false,
  },
  "meetings.update": {
    method: "PUT",
    path: "/v1/guilds/{guildId}/meetings/{objectId}/update",
    mutation: true,
  },
  "meetings.join": {
    method: "POST",
    path: "/v1/guilds/{guildId}/meetings/{objectId}/join",
    mutation: true,
  },
  "meetings.leave": {
    method: "POST",
    path: "/v1/guilds/{guildId}/meetings/{objectId}/leave",
    mutation: true,
  },
  "meetings.cancel": {
    method: "POST",
    path: "/v1/guilds/{guildId}/meetings/{objectId}/cancel",
    mutation: true,
  },
  "meetings.start": {
    method: "POST",
    path: "/v1/guilds/{guildId}/meetings/{objectId}/start",
    mutation: true,
  },
  "meetings.complete": {
    method: "POST",
    path: "/v1/guilds/{guildId}/meetings/{objectId}/complete",
    mutation: true,
  },
  "cases.list": { method: "GET", path: "/v1/guilds/{guildId}/cases", mutation: false },
  "cases.create": { method: "POST", path: "/v1/guilds/{guildId}/cases/create", mutation: true },
  "cases.read": {
    method: "GET",
    path: "/v1/guilds/{guildId}/cases/{objectId}/read",
    mutation: false,
  },
  "cases.reply": {
    method: "POST",
    path: "/v1/guilds/{guildId}/cases/{objectId}/reply",
    mutation: true,
  },
  "cases.notes": {
    method: "GET",
    path: "/v1/guilds/{guildId}/cases/{objectId}/notes",
    mutation: false,
  },
  "cases.note": {
    method: "POST",
    path: "/v1/guilds/{guildId}/cases/{objectId}/note",
    mutation: true,
  },
  "cases.approve": {
    method: "POST",
    path: "/v1/guilds/{guildId}/cases/{objectId}/approve",
    mutation: true,
  },
  "cases.assign": {
    method: "POST",
    path: "/v1/guilds/{guildId}/cases/{objectId}/assign",
    mutation: true,
  },
  "cases.transition": {
    method: "POST",
    path: "/v1/guilds/{guildId}/cases/{objectId}/transition",
    mutation: true,
  },
  "cases.vote": {
    method: "POST",
    path: "/v1/guilds/{guildId}/cases/{objectId}/vote",
    mutation: true,
  },
  "announcements.list": {
    method: "GET",
    path: "/v1/guilds/{guildId}/announcements",
    mutation: false,
  },
  "announcements.assets.upload": {
    method: "POST",
    path: "/v1/guilds/{guildId}/announcement-assets/upload",
    mutation: true,
  },
  "announcements.assets.read": {
    method: "GET",
    path: "/v1/guilds/{guildId}/announcement-assets/{objectId}/read",
    mutation: false,
  },
  "announcements.create": {
    method: "POST",
    path: "/v1/guilds/{guildId}/announcements/create",
    mutation: true,
  },
  "announcements.read": {
    method: "GET",
    path: "/v1/guilds/{guildId}/announcements/{objectId}/read",
    mutation: false,
  },
  "announcements.update": {
    method: "PUT",
    path: "/v1/guilds/{guildId}/announcements/{objectId}/update",
    mutation: true,
  },
  "announcements.preview": {
    method: "POST",
    path: "/v1/guilds/{guildId}/announcements/preview",
    mutation: false,
  },
  "announcements.test": {
    method: "POST",
    path: "/v1/guilds/{guildId}/announcements/{objectId}/test",
    mutation: true,
  },
  "announcements.pause": {
    method: "POST",
    path: "/v1/guilds/{guildId}/announcements/{objectId}/pause",
    mutation: true,
  },
  "announcements.resume": {
    method: "POST",
    path: "/v1/guilds/{guildId}/announcements/{objectId}/resume",
    mutation: true,
  },
  "announcements.cancel": {
    method: "POST",
    path: "/v1/guilds/{guildId}/announcements/{objectId}/cancel",
    mutation: true,
  },
  "announcements.remove": {
    method: "POST",
    path: "/v1/guilds/{guildId}/announcements/{objectId}/remove",
    mutation: true,
  },
  "integrations.list": {
    method: "GET",
    path: "/v1/guilds/{guildId}/integrations",
    mutation: false,
  },
  "integrations.lookup": {
    method: "POST",
    path: "/v1/guilds/{guildId}/integrations/lookup",
    mutation: false,
  },
  "integrations.create": {
    method: "POST",
    path: "/v1/guilds/{guildId}/integrations/create",
    mutation: true,
  },
  "integrations.read": {
    method: "GET",
    path: "/v1/guilds/{guildId}/integrations/{objectId}/read",
    mutation: false,
  },
  "integrations.update": {
    method: "PUT",
    path: "/v1/guilds/{guildId}/integrations/{objectId}/update",
    mutation: true,
  },
  "integrations.test": {
    method: "POST",
    path: "/v1/guilds/{guildId}/integrations/{objectId}/test",
    mutation: true,
  },
  "integrations.remove": {
    method: "POST",
    path: "/v1/guilds/{guildId}/integrations/{objectId}/remove",
    mutation: true,
  },
  "jobs.list": { method: "GET", path: "/v1/guilds/{guildId}/jobs", mutation: false },
  "jobs.read": {
    method: "GET",
    path: "/v1/guilds/{guildId}/jobs/{objectId}/read",
    mutation: false,
  },
  "jobs.cancel": {
    method: "POST",
    path: "/v1/guilds/{guildId}/jobs/{objectId}/cancel",
    mutation: true,
  },
  "jobs.retry": {
    method: "POST",
    path: "/v1/guilds/{guildId}/jobs/{objectId}/retry",
    mutation: true,
  },
  "deliveries.list": { method: "GET", path: "/v1/guilds/{guildId}/deliveries", mutation: false },
  "music.read": { method: "GET", path: "/v1/guilds/{guildId}/music", mutation: false },
  "music.actions": { method: "POST", path: "/v1/guilds/{guildId}/music/actions", mutation: true },
} as const;
export type ControlOperation = keyof typeof controlOperations;
export interface ControlPath {
  operation: ControlOperation;
  guildId?: string;
  objectId?: string;
  legacy: boolean;
}
const guildPattern = "[0-9]{17,20}";
const objectPattern = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const guildIdPattern = new RegExp("^" + guildPattern + "$");
const objectIdPattern = new RegExp("^" + objectPattern + "$");
const operationMatchers = Object.entries(controlOperations).map(([operation, descriptor]) => ({
  operation: operation as ControlOperation,
  pattern: new RegExp(
    "^" +
      descriptor.path
        .replace("{guildId}", `(?<guildId>${guildPattern})`)
        .replace("{objectId}", `(?<objectId>${objectPattern})`) +
      "$",
  ),
}));

export function parseControlPath(path: string): ControlPath | null {
  const legacy = /^\/guilds(?:\/(?<guildId>\d{17,20})(?<save>\/save)?)?$/.exec(path);
  if (legacy)
    return {
      operation: !legacy.groups?.guildId
        ? "guilds.list"
        : legacy.groups.save
          ? "settings.save"
          : "settings.read",
      ...(legacy.groups?.guildId ? { guildId: legacy.groups.guildId } : {}),
      legacy: true,
    };
  for (const matcher of operationMatchers) {
    const match = matcher.pattern.exec(path);
    if (match)
      return {
        operation: matcher.operation,
        ...(match.groups?.guildId ? { guildId: match.groups.guildId } : {}),
        ...(match.groups?.objectId ? { objectId: match.groups.objectId } : {}),
        legacy: false,
      };
  }
  return null;
}
export function isControlPath(path: string): boolean {
  return parseControlPath(path) !== null;
}
export function isAnnouncementAssetPath(path: string): boolean {
  const operation = parseControlPath(path)?.operation;
  return operation === "announcements.assets.upload" || operation === "announcements.assets.read";
}
export function controlRequestBodyLimit(path: string): number {
  return parseControlPath(path)?.operation === "announcements.assets.upload"
    ? announcementAssetLimits.controlBodyBytes
    : controlLimits.bodyBytes;
}
export function controlOperationPath(
  operation: ControlOperation,
  guildId?: string,
  objectId?: string,
): string {
  const descriptor = controlOperations[operation];
  if (
    !descriptor ||
    (descriptor.path.includes("{guildId}") && !guildIdPattern.test(guildId ?? "")) ||
    (descriptor.path.includes("{objectId}") && !objectIdPattern.test(objectId ?? ""))
  )
    throw new ControlError(400, "invalid_route", "Nieprawidłowy adres operacji.");
  return descriptor.path.replace("{guildId}", guildId ?? "").replace("{objectId}", objectId ?? "");
}

export interface VersionedRequest<T = unknown> {
  schemaVersion: typeof schemaVersion;
  actor: string;
  accessToken: string;
  requestId?: string;
  payload: T;
}
export interface VersionedResponse<T> {
  schemaVersion: typeof schemaVersion;
  data: T;
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ControlError(400, "invalid_request", "Nieprawidłowe żądanie panelu.");
  return input as Record<string, unknown>;
}
export function assertSchemaVersion(version: unknown): asserts version is typeof schemaVersion {
  if (version !== schemaVersion)
    throw new ControlError(
      426,
      "unsupported_schema",
      "Panel i bot wymagają zgodnej wersji danych.",
    );
}
export function parseVersionedRequest(
  input: unknown,
  options: { mutation?: boolean } = {},
): VersionedRequest {
  const value = object(input);
  if (
    Object.keys(value).some(
      (key) => !["schemaVersion", "actor", "accessToken", "requestId", "payload"].includes(key),
    )
  )
    throw new ControlError(400, "unknown_field", "Żądanie zawiera nieobsługiwane pole.");
  assertSchemaVersion(value.schemaVersion);
  if (typeof value.actor !== "string" || !guildIdPattern.test(value.actor))
    throw new ControlError(400, "invalid_actor", "Nieprawidłowy identyfikator użytkownika.");
  if (
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    value.accessToken.length > 4096 ||
    /\s/.test(value.accessToken)
  )
    throw new ControlError(401, "invalid_credentials", "Zaloguj się ponownie przez Discorda.");
  if (
    (options.mutation && value.requestId === undefined) ||
    (value.requestId !== undefined &&
      (typeof value.requestId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(value.requestId)))
  )
    throw new ControlError(
      400,
      "invalid_request_id",
      "Operacja wymaga poprawnego identyfikatora żądania.",
    );
  serializeControlBody(value.payload);
  return {
    schemaVersion,
    actor: value.actor,
    accessToken: value.accessToken,
    ...(value.requestId !== undefined ? { requestId: value.requestId as string } : {}),
    payload: value.payload,
  };
}
export function versionedResponse<T>(data: T): VersionedResponse<T> {
  return { schemaVersion, data };
}
export function parseVersionedResponse<T>(
  input: unknown,
  parseData: (data: unknown) => T,
): VersionedResponse<T> {
  const value = object(input);
  assertSchemaVersion(value.schemaVersion);
  return versionedResponse(parseData(value.data));
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
function jsonValue(value: unknown, parents: Set<object>, depth: number): JsonValue {
  if (depth > 32) throw new ControlError(400, "invalid_json", "Dane żądania są zbyt złożone.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || parents.has(value))
    throw new ControlError(400, "invalid_json", "Dane żądania nie są poprawnym JSON.");
  parents.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, parents, depth + 1));
    if (![null, Object.prototype].includes(Object.getPrototypeOf(value)))
      throw new ControlError(400, "invalid_json", "Dane żądania nie są poprawnym JSON.");
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          jsonValue((value as Record<string, unknown>)[key], parents, depth + 1),
        ]),
    );
  } finally {
    parents.delete(value);
  }
}
export function serializeControlBody(input: unknown): string {
  return JSON.stringify(jsonValue(input, new Set(), 0));
}
export function signaturePayload(
  method: string,
  path: string,
  time: string,
  nonce: string,
  rawBody: string,
): string {
  return [method, path, time, nonce, rawBody].join("\n");
}

export const featureCatalog = [
  {
    key: "rooms",
    label: "Pokoje głosowe",
    requiredPermissions: ["ViewChannel", "Connect", "MoveMembers", "ManageChannels"],
  },
  {
    key: "reactions",
    label: "Role za reakcje",
    requiredPermissions: ["ViewChannel", "ReadMessageHistory", "ManageRoles", "AddReactions"],
  },
  {
    key: "rules",
    label: "Regulamin serwera",
    requiredPermissions: ["ViewChannel", "ReadMessageHistory", "SendMessages", "ManageRoles"],
  },
  {
    key: "files",
    label: "Filtr plików",
    requiredPermissions: ["ViewChannel", "ReadMessageHistory", "ManageMessages"],
  },
  { key: "reports", label: "Zgłoszenia", requiredPermissions: ["ViewChannel", "SendMessages"] },
  {
    key: "meetings",
    label: "Spotkania i ekipa",
    requiredPermissions: ["ViewChannel", "SendMessages", "ManageChannels"],
  },
  {
    key: "cases",
    label: "Zgłoszenia i pomysły",
    requiredPermissions: ["ViewChannel", "SendMessages", "ManageThreads"],
  },
  {
    key: "announcements",
    label: "Ogłoszenia i powiadomienia",
    requiredPermissions: ["ViewChannel", "SendMessages", "EmbedLinks"],
  },
  {
    key: "integrations",
    label: "Integracje",
    requiredPermissions: ["ViewChannel", "SendMessages", "EmbedLinks"],
  },
  {
    key: "twitch",
    label: "Powiadomienia z Twitcha",
    requiredPermissions: ["ViewChannel", "SendMessages", "EmbedLinks"],
  },
  { key: "music", label: "Muzyka", requiredPermissions: ["ViewChannel", "Connect", "Speak"] },
] as const;
export type FeatureKey = (typeof featureCatalog)[number]["key"];
export type ModuleStatus = "available" | "enabled" | "needs_configuration" | "degraded";
export interface ModuleCapability {
  key: FeatureKey;
  label: string;
  availability: "available" | "planned";
  status: ModuleStatus | "planned";
  schemaVersion: typeof schemaVersion;
  requiredPermissions: readonly string[];
}
export interface Capabilities {
  apiVersion: 1;
  schemaVersion: typeof schemaVersion;
  contractsVersion: typeof contractsVersion;
  modules: ModuleCapability[];
}
export const implementedFeatureKeys: readonly FeatureKey[] = [
  "rooms",
  "reactions",
  "files",
  "reports",
];
export function buildCapabilities(
  states: Partial<Record<FeatureKey, ModuleStatus>> = {},
  implemented: readonly FeatureKey[] = implementedFeatureKeys,
): Capabilities {
  return {
    apiVersion: 1,
    schemaVersion,
    contractsVersion,
    modules: featureCatalog.map((entry) => {
      const available = implemented.includes(entry.key);
      if (!available && states[entry.key])
        throw new ControlError(409, "module_unavailable", "Ta funkcja nie jest jeszcze dostępna.");
      return {
        ...entry,
        availability: available ? "available" : "planned",
        status: available ? (states[entry.key] ?? "available") : "planned",
        schemaVersion,
      };
    }),
  };
}
