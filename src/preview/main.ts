import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { PermissionFlagsBits as P } from "discord.js";
import { startControlServer } from "../control/server.js";
import {
  buildCapabilities,
  ControlError,
  controlOperations,
  parseControlPath,
  parseVersionedRequest,
  versionedResponse,
  type GuildResources,
  type GuildSummary,
  type ControlOperation,
} from "../contracts/index.js";
import { Store } from "../storage/store.js";
import { JobStore, JobError } from "../core/jobs/store.js";
import { JobRunner } from "../core/jobs/runner.js";
import type { Job, JobLease } from "../core/jobs/types.js";
import { ModuleSettingsStore, newModules, parseModuleSettings } from "../core/modules/settings.js";
import {
  canPerform,
  requirePermission,
  ModulePermissionError,
  type BoundObject,
  type MemberFacts,
} from "../core/permissions.js";
import {
  AnnouncementService,
  AnnouncementError,
  type AnnouncementDraft,
  type AnnouncementMutation,
} from "../modules/announcements/service.js";
import {
  normalizeSchedule,
  nextOccurrences,
  resolveLocalDateTime,
} from "../modules/announcements/schedule.js";
import type { ScheduleInput } from "../modules/announcements/types.js";
import { AnnouncementAssetStore } from "../modules/announcement-assets/store.js";
import { AnnouncementAssetError } from "../modules/announcement-assets/types.js";
import {
  MeetingService,
  MeetingError,
  type Meeting,
  type MeetingDraft,
  type MeetingMutation,
} from "../modules/meetings/service.js";
import {
  CaseService,
  CaseError,
  allowedCaseStatuses,
  type CaseDraft,
  type CaseMutation,
  type CaseListFilter,
  type CaseTransition,
  type CaseAudienceScope,
  type ConfirmedCaseTarget,
} from "../modules/cases/service.js";
import { defaultCaseSettings } from "../core/modules/settings.js";
import { ServerRulesService, RulesError } from "../modules/server-rules/service.js";
import type { RulesDraft, RulesMessage, RulesChannel } from "../modules/server-rules/types.js";

export const previewActorId = "900000000000000001";
export const previewGuildIds = ["900000000000000101", "900000000000000102"] as const;
const guilds: GuildSummary[] = previewGuildIds.map((id, index) => ({
  id,
  name: index ? "Ekipa" : "Pracownia",
  initials: index ? "EK" : "PR",
  description: "Przykładowy serwer do sprawdzenia ustawień.",
  accent: index ? "#57bfa1" : "#5865f2",
  preview: true,
  installed: true,
}));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ControlError(400, "invalid_input", "Sprawdź dane formularza.");
  return value as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new ControlError(400, "revision", "Wczytaj aktualną wersję wpisu.");
  return value as number;
}
function bounded(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum)
    throw Error("Invalid preview worker configuration.");
  return selected;
}
function privateFile(path: string): void {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw Error("Invalid preview data file.");
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
}
function jobView(job: Job) {
  return redacted(job, ["payload", "result", "leaseToken", "nonce"]);
}
function deliveryView(attempt: object) {
  return redacted(attempt, ["result", "leaseToken", "nonce"]);
}
function redacted(value: object, fields: string[]) {
  const view: Record<string, unknown> = { ...value };
  for (const field of fields) delete view[field];
  return view;
}
function mutationView(value: AnnouncementMutation) {
  return { announcement: value.announcement, job: value.job ? jobView(value.job) : null };
}
function meetingMutation(value: MeetingMutation) {
  return { ...value, jobs: value.jobs.map(jobView) };
}
function caseMutation(value: CaseMutation) {
  return { ...value, job: value.job ? jobView(value.job) : null };
}
function only(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new ControlError(400, "invalid_input", "Żądanie zawiera nieobsługiwane pole.");
}
function previewRulesDraft(value: unknown): value is RulesDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    "channelId" in value &&
    typeof value.channelId === "string" &&
    "roleId" in value &&
    typeof value.roleId === "string" &&
    "label" in value &&
    typeof value.label === "string" &&
    "content" in value &&
    typeof value.content === "string" &&
    "method" in value &&
    (value.method === "button" || value.method === "reaction") &&
    "emoji" in value &&
    (value.emoji === null || typeof value.emoji === "string")
  );
}
function resources(guildId: string): GuildResources {
  const block = guildId === previewGuildIds[0] ? 0 : 10000;
  const channel = (offset: number) => (BigInt(guildId) + BigInt(block + 1000 + offset)).toString();
  const role = (offset: number) => (BigInt(guildId) + BigInt(block + 2000 + offset)).toString();
  return {
    channels: [
      {
        id: channel(0),
        name: "ogłoszenia",
        kind: "text",
        accessible: true,
        uses: ["reactions", "files"],
      },
      {
        id: channel(1),
        name: "rozmowy",
        kind: "text",
        accessible: true,
        uses: ["reactions", "files"],
      },
      { id: channel(2), name: "projekty", kind: "text", accessible: true, uses: ["files"] },
      { id: channel(3), name: "Rozmowy", kind: "voice", accessible: true, uses: ["rooms"] },
      { id: channel(4), name: "Pokoje", kind: "category", accessible: true, uses: ["rooms"] },
      { id: channel(5), name: "regulamin", kind: "text", accessible: true, uses: [] },
    ],
    roles: [
      { id: role(0), name: "Administracja", color: "#f0b745", assignable: false },
      { id: role(1), name: "Programowanie", color: "#6e9df1", assignable: true },
      { id: role(2), name: "Design", color: "#bd8ee5", assignable: true },
      { id: role(3), name: "Członek", color: "#a9b1bc", assignable: true },
    ],
  };
}
interface Runtime {
  scope: string;
  guildId: string;
  store: Store;
  jobs: JobStore;
  settings: ModuleSettingsStore;
  announcements: AnnouncementService;
  assets: AnnouncementAssetStore;
  assetsPruneAt?: number;
  meetings: MeetingService;
  rules: ServerRulesService;
}
export interface PreviewWorkerOptions {
  key: string;
  port?: number;
  dataDir?: string;
  clock?: () => number;
  sessionTtlMs?: number;
  maxSessions?: number;
  autoStart?: boolean;
  intervalMs?: number;
}
export interface PreviewWorker {
  server: Server;
  origin: string;
  tick(): Promise<number>;
  close(): Promise<void>;
}

export async function createPreviewWorker(options: PreviewWorkerOptions): Promise<PreviewWorker> {
  if (
    process.env.GILDIUSZ_PREVIEW_WORKER !== "1" ||
    (process.env.PUBLIC_INSTALLS && !["0", "false"].includes(process.env.PUBLIC_INSTALLS))
  )
    throw Error("Preview worker requires an isolated local environment.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.key)) throw Error("Invalid preview control key.");
  const clock = options.clock ?? Date.now;
  const ttl = bounded(options.sessionTtlMs, 14400000, 1000, 86400000);
  const maximum = bounded(options.maxSessions, 12, 1, 32);
  const interval = bounded(options.intervalMs, 1000, 10, 60000);
  const directory = resolve(options.dataDir ?? ".bot/preview-data");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
    throw Error("Invalid preview data directory.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const root = realpathSync(directory);
  const registryPath = join(root, "sessions.sqlite");
  privateFile(registryPath);
  const registry = new DatabaseSync(registryPath);
  registry.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (scope TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)",
  );
  const runtimes = new Map<string, Runtime>();
  let closed = false,
    queue = Promise.resolve(),
    timer: ReturnType<typeof setInterval> | undefined;
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw Error("Invalid preview clock.");
    return value;
  };
  function exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const result = queue.then(() => {
      if (closed) throw new ControlError(503, "stopping", "Podgląd jest ponownie uruchamiany.");
      return work();
    });
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function scopeDirectory(scope: string): string {
    const path = resolve(root, scope);
    if (!/^[a-f0-9]{64}$/.test(scope) || !path.startsWith(root + sep))
      throw Error("Invalid preview scope.");
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw Error("Invalid preview scope directory.");
    return path;
  }
  function cleanup(): void {
    for (const row of registry
      .prepare("SELECT scope FROM sessions WHERE expires_at<=?")
      .all(now())) {
      const scope = String(row.scope),
        path = scopeDirectory(scope);
      for (const [key, runtime] of runtimes)
        if (runtime.scope === scope) {
          runtime.store.close();
          runtimes.delete(key);
        }
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      registry.prepare("DELETE FROM sessions WHERE scope=?").run(scope);
    }
  }
  function touch(token: string): string {
    cleanup();
    const scope = createHash("sha256").update(token).digest("hex");
    const current = registry.prepare("SELECT scope FROM sessions WHERE scope=?").get(scope);
    if (
      !current &&
      Number(registry.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count) >= maximum
    )
      throw new ControlError(429, "preview_sessions", "Podgląd jest zajęty. Spróbuj później.");
    registry
      .prepare(
        "INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET expires_at=excluded.expires_at,last_seen=excluded.last_seen",
      )
      .run(scope, now() + ttl, now());
    return scope;
  }
  function facts(runtime: Runtime, actor = previewActorId): MemberFacts {
    if (
      actor !== previewActorId ||
      !/^[a-f0-9]{64}$/.test(runtime.scope) ||
      !previewGuildIds.includes(runtime.guildId as (typeof previewGuildIds)[number])
    )
      throw new ControlError(403, "preview_member", "To konto nie należy do tego podglądu.");
    return {
      guildId: runtime.guildId,
      userId: actor,
      owner: true,
      manageGuild: true,
      roleIds: resources(runtime.guildId).roles.map((role) => role.id),
      pending: false,
      timedOut: false,
      isBot: false,
    };
  }
  function requireEnabled(runtime: Runtime, module: "meetings" | "cases"): void {
    if (!runtime.settings.read().enabled[module])
      throw new ControlError(
        409,
        "module_unavailable",
        "Ta funkcja jest wyłączona w tym podglądzie.",
      );
  }
  function scopedId(runtime: Runtime, kind: string, objectId: string): string {
    const hash = createHash("sha256")
      .update([runtime.scope, runtime.guildId, kind, objectId].join(":"))
      .digest("hex");
    return (
      800000000000000000n +
      (BigInt("0x" + hash.slice(0, 16)) % 100000000000000000n)
    ).toString();
  }
  function ruleMessage(
    runtime: Runtime,
    channelId: string,
    messageId: string,
  ): RulesMessage | null {
    const resource = runtime.store.resource(`preview.rules-message.${messageId}`);
    if (!resource) return null;
    const saved = object(JSON.parse(resource.baseline));
    if (
      resource.kind !== "preview-rules-message" ||
      resource.id !== messageId ||
      saved.scope !== runtime.scope ||
      saved.guildId !== runtime.guildId ||
      saved.channelId !== channelId ||
      saved.messageId !== messageId ||
      saved.authorId !== previewActorId ||
      saved.webhookId !== null ||
      typeof saved.content !== "string" ||
      (saved.controlId !== null && typeof saved.controlId !== "string") ||
      (saved.reactionEmoji !== null && typeof saved.reactionEmoji !== "string")
    )
      throw new RulesError("publication_unavailable");
    return {
      guildId: runtime.guildId,
      channelId,
      messageId,
      authorId: previewActorId,
      webhookId: null,
      content: saved.content,
      controlId: saved.controlId,
      reactionEmoji: saved.reactionEmoji,
    };
  }
  function putRuleMessage(runtime: Runtime, message: RulesMessage): void {
    runtime.store.putResource(
      `preview.rules-message.${message.messageId}`,
      "preview-rules-message",
      message.messageId,
      { ...message, scope: runtime.scope, simulated: true },
    );
  }
  function previewRules(runtime: Runtime): ServerRulesService {
    const available = resources(runtime.guildId),
      botRoleId = available.roles[0].id,
      channelId = available.channels.find((channel) => channel.name === "regulamin")!.id;
    return new ServerRulesService(runtime.jobs, {
      guildId: runtime.guildId,
      botId: previewActorId,
      clock: now,
      ports: {
        administrator: async (userId) => ({
          guildId: runtime.guildId,
          userId,
          observedAt: now(),
          owner: userId === previewActorId,
          manageGuild: userId === previewActorId,
          pending: false,
          timedOut: false,
        }),
        preflight: async () => ({
          guildId: runtime.guildId,
          observedAt: now(),
          nativeScreening: false,
          complete: true,
          roles: [
            {
              guildId: runtime.guildId,
              id: runtime.guildId,
              permissions: P.ViewChannel | P.ReadMessageHistory,
              position: 0,
              managed: false,
              restricted: false,
            },
            ...available.roles.map((role, index) => ({
              guildId: runtime.guildId,
              id: role.id,
              permissions: index === 0 ? P.ManageRoles | P.SendMessages | P.AddReactions : 0n,
              position: index === 0 ? 10 : index,
              managed: index === 0,
              restricted: false,
            })),
          ],
          channels: available.channels.map<RulesChannel>((channel) => ({
            guildId: runtime.guildId,
            id: channel.id,
            type: channel.kind === "text" ? "text" : "other",
            overwrites:
              channel.id === channelId
                ? []
                : [{ id: runtime.guildId, type: "role", allow: P.SendMessages, deny: 0n }],
          })),
          botRoleIds: [botRoleId],
          interestRoleIds: available.roles.slice(1, 3).map((role) => role.id),
          staffRoleIds: [],
          staffUserIds: [],
        }),
        member: async () => null,
        sendPart: async (input) => {
          if (input.signal.aborted) throw new RulesError("stale_lease");
          if (
            input.guildId !== runtime.guildId ||
            input.allowedMentions.parse.length ||
            input.allowedMentions.roles.length ||
            input.allowedMentions.users.length
          )
            throw new RulesError("permission_revoked");
          const messageId = scopedId(runtime, "rules-message", input.nonce),
            previous = ruleMessage(runtime, input.channelId, messageId);
          if (
            previous &&
            (previous.content !== input.content || previous.controlId !== input.controlId)
          )
            throw new RulesError("unknown_effect");
          if (!previous)
            putRuleMessage(runtime, {
              guildId: runtime.guildId,
              channelId: input.channelId,
              messageId,
              authorId: previewActorId,
              webhookId: null,
              content: input.content,
              controlId: input.controlId,
              reactionEmoji: null,
            });
          return { guildId: runtime.guildId, channelId: input.channelId, messageId };
        },
        message: async (channel, message) => ruleMessage(runtime, channel, message),
        seedReaction: async (input) => {
          if (input.signal.aborted) throw new RulesError("stale_lease");
          const message = ruleMessage(runtime, input.channelId, input.messageId);
          if (input.guildId !== runtime.guildId || !message)
            throw new RulesError("publication_unavailable");
          putRuleMessage(runtime, { ...message, reactionEmoji: input.emoji });
        },
        addRole: async () => {
          throw new RulesError("member_unavailable");
        },
        retireControls: async (input) => {
          if (input.signal.aborted) throw new RulesError("stale_lease");
          const message = ruleMessage(runtime, input.channelId, input.messageId);
          if (input.guildId !== runtime.guildId || !message)
            throw new RulesError("publication_unavailable");
          putRuleMessage(runtime, { ...message, controlId: null, reactionEmoji: null });
        },
      },
    });
  }
  function meetingBound(value: Meeting, participantIds: readonly string[] = []): BoundObject {
    return {
      guildId: value.guildId,
      ownerId: value.organizerId,
      visibility: value.visibility,
      state: value.state,
      participantIds,
      invitedUserIds: value.invitedUserIds,
      allowedRoleIds: value.allowedRoleIds,
    };
  }
  function eligible(runtime: Runtime, userId: string, meeting: Meeting): boolean {
    if (userId !== previewActorId || meeting.guildId !== runtime.guildId) return false;
    const current = facts(runtime, userId);
    return (
      !meeting.allowedRoleIds.length ||
      meeting.allowedRoleIds.some((role) => current.roleIds.includes(role))
    );
  }
  function caseResource(runtime: Runtime, scope: Omit<CaseAudienceScope, "audience">) {
    const configuration = runtime.settings.read().cases ?? defaultCaseSettings();
    const channels = resources(runtime.guildId).channels;
    const privateCase = scope.visibility === "private";
    const parent = channels.find(
      (channel) => channel.id === configuration.categoryId && channel.kind === "category",
    );
    const publicChannel = channels.find(
      (channel) => channel.id === configuration.suggestionChannelId && channel.kind === "text",
    );
    if (
      scope.guildId !== runtime.guildId ||
      scope.ownerId !== previewActorId ||
      (privateCase && !parent) ||
      (!privateCase && !publicChannel)
    )
      throw new CaseError("acl_unconfirmed");
    const key = `preview.case.${privateCase ? "private" : "public"}.${scope.caseId}`;
    const prior = runtime.store.resource(key);
    if (prior) {
      let saved: Record<string, unknown>;
      try {
        saved = object(JSON.parse(prior.baseline));
      } catch {
        throw new CaseError("acl_unconfirmed");
      }
      if (
        prior.kind !== "preview-case-channel" ||
        saved.scope !== runtime.scope ||
        saved.guildId !== runtime.guildId ||
        saved.caseId !== scope.caseId ||
        saved.ownerId !== scope.ownerId ||
        saved.visibility !== scope.visibility ||
        saved.simulated !== true ||
        saved.owned !== true
      )
        throw new CaseError("acl_unconfirmed");
    }
    const channelId = privateCase ? scopedId(runtime, "case", scope.caseId) : publicChannel!.id;
    runtime.store.putResource(key, "preview-case-channel", channelId, {
      ...scope,
      scope: runtime.scope,
      simulated: true,
      owned: true,
      parentId: privateCase ? parent!.id : null,
      // These are facts of the local model, not a confirmation of a Discord ACL.
      acl: privateCase
        ? {
            visibility: "private",
            ownerId: scope.ownerId,
            staffRoleIds: configuration ? [...runtime.settings.read().caseModeratorRoleIds] : [],
          }
        : { visibility: "public" },
    });
    return runtime.store.resource(key)!;
  }
  function caseTarget(runtime: Runtime, scope: CaseAudienceScope): ConfirmedCaseTarget {
    if (scope.guildId !== runtime.guildId || scope.ownerId !== previewActorId)
      throw new CaseError("acl_unconfirmed");
    const row = runtime.store.db
      .prepare("SELECT owner_id,visibility,generation FROM cases WHERE guild_id=? AND id=?")
      .get(runtime.guildId, scope.caseId);
    if (
      !row ||
      row.owner_id !== scope.ownerId ||
      row.visibility !== scope.visibility ||
      Number(row.generation) !== scope.generation ||
      (scope.audience === "public" && scope.visibility !== "public")
    )
      throw new CaseError("acl_unconfirmed");
    const resource = runtime.store.resource(`preview.case.${scope.visibility}.${scope.caseId}`);
    if (!resource) throw new CaseError("acl_unconfirmed");
    let saved: Record<string, unknown>;
    try {
      saved = object(JSON.parse(resource.baseline));
    } catch {
      throw new CaseError("acl_unconfirmed");
    }
    let acl: Record<string, unknown>;
    try {
      acl = object(saved.acl);
    } catch {
      throw new CaseError("acl_unconfirmed");
    }
    const expectedChannel =
      scope.visibility === "private"
        ? scopedId(runtime, "case", scope.caseId)
        : runtime.settings.read().cases?.suggestionChannelId;
    const expectedParent =
      scope.visibility === "private" ? runtime.settings.read().cases?.categoryId : null;
    if (
      resource.kind !== "preview-case-channel" ||
      resource.id !== expectedChannel ||
      saved.scope !== runtime.scope ||
      saved.guildId !== scope.guildId ||
      saved.caseId !== scope.caseId ||
      saved.ownerId !== scope.ownerId ||
      saved.visibility !== scope.visibility ||
      saved.generation !== scope.generation ||
      saved.parentId !== expectedParent ||
      saved.simulated !== true ||
      saved.owned !== true ||
      acl.visibility !== scope.visibility ||
      (scope.visibility === "private" &&
        (acl.ownerId !== scope.ownerId ||
          JSON.stringify(acl.staffRoleIds) !==
            JSON.stringify(runtime.settings.read().caseModeratorRoleIds)))
    )
      throw new CaseError("acl_unconfirmed");
    return { ...scope, confirmed: true, channelId: resource.id };
  }
  function cases(runtime: Runtime): CaseService {
    const configuration = runtime.settings.read().cases ?? defaultCaseSettings();
    return new CaseService(runtime.jobs, {
      guildId: runtime.guildId,
      clock: now,
      ...configuration,
      retentionMs: null,
      authorize: (request) => {
        requireEnabled(runtime, "cases");
        return { member: facts(runtime, request.actorId), policy: runtime.settings.policy() };
      },
      onCreated: (value) =>
        caseResource(runtime, {
          guildId: value.guildId,
          caseId: value.id,
          ownerId: value.ownerId,
          visibility: value.visibility,
          generation: value.generation,
        }),
    });
  }
  function open(scope: string, guildId: string): Runtime {
    const key = `${scope}:${guildId}`;
    const prior = runtimes.get(key);
    if (prior) return prior;
    const folder = scopeDirectory(scope);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    const path = join(folder, `${guildId}.sqlite`);
    privateFile(path);
    const store = new Store(path, guildId),
      jobs = new JobStore(store.db, now),
      settings = new ModuleSettingsStore(store.db, guildId, now);
    if (!store.resource("preview.community-defaults")) {
      const initial = settings.read(),
        available = resources(guildId);
      settings.save(
        {
          ...initial,
          enabled: {
            ...initial.enabled,
            announcements: initial.revision === 0 ? true : initial.enabled.announcements,
            meetings: true,
            cases: true,
          },
          cases: {
            ...defaultCaseSettings(),
            categoryId: available.channels.find((channel) => channel.kind === "category")!.id,
            suggestionChannelId: available.channels[2].id,
            voting: { enabled: true, statuses: ["new", "in_review"] },
            retentionMs: null,
          },
        },
        previewActorId,
      );
      store.putResource("preview.community-defaults", "preview-initialization", guildId, {
        scope,
        guildId,
        version: 1,
      });
    }
    const runtime = { scope, guildId, store, jobs, settings } as Runtime;
    runtime.rules = previewRules(runtime);
    runtime.assets = new AnnouncementAssetStore(
      store.db,
      guildId,
      join(folder, "announcement-assets"),
      { clock: now },
    );
    runtime.announcements = new AnnouncementService(jobs, {
      guildId,
      clock: now,
      validateAsset: (id) => runtime.assets.validateAsset(id),
      onSaved: (announcement) => runtime.assets.syncAnnouncement(announcement),
      authorize: (request) => {
        if (!settings.read().enabled.announcements)
          throw new AnnouncementError("permission_revoked");
        const actor: MemberFacts = {
          guildId,
          userId: request.actorId,
          owner: true,
          manageGuild: true,
          roleIds: [],
          pending: false,
          timedOut: false,
          isBot: false,
        };
        if (request.actorId !== previewActorId) throw new AnnouncementError("permission_revoked");
        requirePermission(
          request.operation === "deliver"
            ? "announcements.create"
            : `announcements.${request.operation}`,
          actor,
          settings.policy(),
          { guildId },
        );
        const available = resources(guildId);
        if (
          request.channelId &&
          !available.channels.some(
            (channel) => channel.id === request.channelId && channel.kind === "text",
          )
        )
          throw new AnnouncementError("channel_unavailable");
        if (
          (request.roleIds ?? []).some(
            (role) => !available.roles.some((value) => value.id === role),
          )
        )
          throw new AnnouncementError("permission_revoked");
      },
    });
    runtime.meetings = new MeetingService(jobs, {
      guildId,
      clock: now,
      authorize: (request) => {
        requireEnabled(runtime, "meetings");
        const current = facts(runtime, request.actorId),
          value = request.meeting;
        requirePermission(
          request.operation === "deliver" ? "meetings.update" : `meetings.${request.operation}`,
          current,
          settings.policy(),
          value ? meetingBound(value, request.participantIds) : undefined,
        );
        const definition = request.draft ?? value;
        if (
          !definition ||
          ["read", "leave", "cancel", "complete"].includes(request.operation) ||
          (request.operation === "deliver" && request.jobType === "meeting.finish")
        )
          return;
        const available = resources(guildId);
        if (
          !available.channels.some(
            (channel) => channel.id === definition.channelId && channel.kind === "text",
          )
        )
          throw new MeetingError("forbidden");
        if (
          (definition.allowedRoleIds ?? []).some(
            (role) => !available.roles.some((value) => value.id === role),
          )
        )
          throw new MeetingError("forbidden");
        if ((definition.invitedUserIds ?? []).some((userId) => userId !== previewActorId))
          throw new MeetingError("forbidden");
        const selectedRoom = definition.room;
        if (
          selectedRoom?.kind === "existing" &&
          !available.channels.some(
            (channel) => channel.id === selectedRoom.channelId && channel.kind === "voice",
          )
        )
          throw new MeetingError("forbidden");
        if (
          selectedRoom?.kind === "create" &&
          !available.channels.some(
            (channel) => channel.id === selectedRoom.categoryId && channel.kind === "category",
          )
        )
          throw new MeetingError("forbidden");
        if (request.operation === "join" && !eligible(runtime, request.actorId, value!))
          throw new MeetingError("forbidden");
      },
      eligible: (userId, value) => eligible(runtime, userId, value),
    });
    runtimes.set(key, runtime);
    return runtime;
  }
  function capabilities(runtime: Runtime) {
    const settings = runtime.settings.read();
    const result = buildCapabilities(
      {
        announcements: settings.enabled.announcements ? "enabled" : "available",
        meetings: settings.enabled.meetings ? "enabled" : "available",
        cases: !settings.enabled.cases
          ? "available"
          : settings.cases?.categoryId
            ? "enabled"
            : "needs_configuration",
        rules: runtime.rules.settings().enabled ? "enabled" : "available",
      },
      ["rooms", "reactions", "files", "reports", "announcements", "meetings", "cases", "rules"],
    );
    result.modules = result.modules.filter((module) => module.key !== "music");
    return result;
  }
  function permissions(runtime: Runtime): string[] {
    const settings = runtime.settings.read();
    return [
      "settings.read",
      "settings.save",
      "capabilities.read",
      "jobs.list",
      "jobs.read",
      "jobs.cancel",
      "deliveries.list",
      "rules.read",
      "rules.configure",
      "rules.publish",
      "rules.acceptances.list",
      "rules.publications.reconcile",
      ...(settings.enabled.announcements
        ? [
            "announcements.list",
            "announcements.read",
            "announcements.create",
            "announcements.update",
            "announcements.preview",
            "announcements.test",
            "announcements.pause",
            "announcements.resume",
            "announcements.cancel",
            "announcements.remove",
            "announcements.assets.upload",
            "announcements.assets.read",
          ]
        : []),
      ...(settings.enabled.meetings
        ? [
            "meetings.list",
            "meetings.read",
            "meetings.create",
            "meetings.update",
            "meetings.join",
            "meetings.leave",
            "meetings.start",
            "meetings.complete",
            "meetings.cancel",
            "meetings.preview",
          ]
        : []),
      ...(settings.enabled.cases
        ? [
            "cases.list",
            "cases.read",
            "cases.create",
            "cases.reply",
            "cases.notes",
            "cases.note",
            "cases.assign",
            "cases.transition",
            "cases.approve",
            "cases.vote",
          ]
        : []),
    ];
  }
  function history(runtime: Runtime, objectId: string) {
    const jobs = runtime.jobs.list({ guildId: runtime.guildId, objectId, limit: 100 });
    return {
      jobs: jobs.map(jobView),
      deliveries: jobs.flatMap((job) => runtime.jobs.attempts(job.id).map(deliveryView)),
    };
  }
  async function meetingView(runtime: Runtime, objectId: string) {
    const detail = await runtime.meetings.get(previewActorId, objectId),
      value = detail.meeting;
    const bound = meetingBound(
      value,
      detail.participants
        .filter((person) => person.state !== "left")
        .map((person) => person.userId),
    );
    const valid = ["meetings.read"];
    if (["draft", "open", "starting", "active"].includes(value.state))
      valid.push("meetings.update");
    if (value.state === "open" && value.endsAt > now() && eligible(runtime, previewActorId, value))
      valid.push("meetings.join", "meetings.start");
    if (["open", "starting", "active"].includes(value.state)) valid.push("meetings.leave");
    if (["starting", "active"].includes(value.state)) valid.push("meetings.complete");
    if (["draft", "open", "starting", "active"].includes(value.state))
      valid.push("meetings.cancel");
    return {
      ...detail,
      participantNames: { [previewActorId]: "Ty" },
      memberNames: { [previewActorId]: "Ty" },
      allowedOperations: valid.filter((operation) =>
        canPerform(operation, facts(runtime), runtime.settings.policy(), bound),
      ),
      ...history(runtime, objectId),
    };
  }
  async function caseView(runtime: Runtime, objectId: string) {
    const detail = await cases(runtime).get(previewActorId, objectId),
      value = detail.case;
    const configuration = runtime.settings.read().cases ?? defaultCaseSettings();
    const bound: BoundObject = {
      guildId: runtime.guildId,
      ownerId: value.ownerId,
      kind: value.kind,
      visibility: value.visibility,
      state: value.status,
      votingEnabled:
        configuration.voting.enabled &&
        configuration.voting.statuses.includes(value.status as "new" | "in_review"),
    };
    const valid = ["cases.read", "cases.notes", "cases.note"];
    if (!["closed", "rejected", "implemented"].includes(value.status))
      valid.push("cases.reply", "cases.assign", "cases.transition");
    if (
      value.kind === "suggestion" &&
      value.visibility === "private" &&
      !["rejected", "implemented"].includes(value.status)
    )
      valid.push("cases.approve");
    if (bound.votingEnabled) valid.push("cases.vote");
    return {
      ...detail,
      allowedOperations: valid.filter((operation) =>
        canPerform(operation, facts(runtime), runtime.settings.policy(), bound),
      ),
      allowedStatuses: canPerform(
        "cases.transition",
        facts(runtime),
        runtime.settings.policy(),
        bound,
      )
        ? allowedCaseStatuses(value.kind, value.status)
        : [],
      ...history(runtime, objectId),
    };
  }
  function targetJobs(runtime: Runtime, payload: Record<string, unknown>): Job[] {
    const selector = jobSelector(payload);
    return runtime.jobs
      .list({
        guildId: runtime.guildId,
        ...(selector ? { objectId: selector.id } : {}),
        ...(selector?.kind === "announcementId" ? { type: "announcement.send" } : {}),
        limit: 100,
      })
      .filter((job) => !selector || matchesSelector(job, selector));
  }
  function matchesSelector(job: Job, selector: { id: string; kind: string }): boolean {
    return (
      job.objectId === selector.id &&
      (selector.kind === "announcementId"
        ? job.type === "announcement.send"
        : selector.kind === "meetingId"
          ? job.type.startsWith("meeting.")
          : job.type === "case.notify")
    );
  }
  function jobSelector(payload: Record<string, unknown>): { id: string; kind: string } | undefined {
    const fields = ["announcementId", "meetingId", "caseId"].filter(
      (key) => payload[key] !== undefined,
    );
    if (fields.length > 1)
      throw new ControlError(400, "invalid_input", "Wybierz jeden element historii.");
    if (!fields.length) return;
    const kind = fields[0],
      value = payload[kind];
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
      throw new ControlError(400, "invalid_input", "Wybierz element historii.");
    return { id: value, kind };
  }
  async function request(
    runtime: Runtime,
    operation: ControlOperation,
    input: unknown,
    objectId?: string,
    requestId?: string,
  ): Promise<object> {
    const payload = object(input);
    const service = runtime.announcements;
    switch (operation) {
      case "rules.read": {
        only(payload, []);
        const overview = await runtime.rules.inspect(previewActorId);
        return { ...overview, versions: overview.versions.slice(0, 5) };
      }
      case "rules.configure": {
        only(payload, ["revision", "enabled", "draft"]);
        if (
          typeof payload.enabled !== "boolean" ||
          (payload.draft !== null && !previewRulesDraft(payload.draft))
        )
          throw new RulesError("invalid_input");
        return {
          settings: await runtime.rules.configure(
            previewActorId,
            requestId!,
            revision(payload.revision),
            {
              enabled: payload.enabled,
              draft: payload.draft,
            },
          ),
        };
      }
      case "rules.publish": {
        only(payload, ["revision"]);
        const version = await runtime.rules.publish(
          previewActorId,
          requestId!,
          revision(payload.revision),
        );
        return {
          version,
          settings: runtime.rules.settings(),
          parts: runtime.rules.parts(version.id),
        };
      }
      case "rules.publications.reconcile": {
        only(payload, []);
        const version = await runtime.rules.reconcilePublication(previewActorId, objectId!);
        return {
          version,
          settings: runtime.rules.settings(),
          parts: runtime.rules.parts(version.id),
        };
      }
      case "rules.acceptances.list": {
        only(payload, ["limit", "before"]);
        if (
          payload.limit !== undefined &&
          (typeof payload.limit !== "number" ||
            !Number.isSafeInteger(payload.limit) ||
            payload.limit < 1 ||
            payload.limit > 100)
        )
          throw new RulesError("invalid_input");
        let before: { acceptedAt: number; id: string } | undefined;
        if (payload.before !== undefined) {
          const value = object(payload.before);
          only(value, ["acceptedAt", "id"]);
          if (
            typeof value.acceptedAt !== "number" ||
            !Number.isSafeInteger(value.acceptedAt) ||
            value.acceptedAt < 0 ||
            typeof value.id !== "string"
          )
            throw new RulesError("invalid_input");
          before = { acceptedAt: value.acceptedAt, id: value.id };
        }
        const limit = payload.limit ?? 50;
        const acceptances = await runtime.rules.listAcceptances(previewActorId, { limit, before }),
          last = acceptances.at(-1);
        return {
          acceptances,
          nextCursor:
            acceptances.length === limit && last
              ? { acceptedAt: last.acceptedAt, id: last.id }
              : null,
        };
      }
      case "capabilities.read":
        return {
          ...capabilities(runtime),
          announcementEditor: { cards: true, links: true, drafts: true },
          resources: resources(runtime.guildId),
          announcementAssets: {
            available: runtime.settings.read().enabled.announcements,
            maxBytes: 2097152,
            maxWidth: 2048,
            maxHeight: 2048,
            mediaTypes: ["image/png", "image/jpeg", "image/webp"],
          },
          permissions: permissions(runtime),
          mentionPermissions: {
            roleIds: resources(runtime.guildId).roles.map((role) => role.id),
            everyone: true,
          },
          moduleSettings: runtime.settings.read(),
        };
      case "settings.read":
        return {
          moduleSettings: runtime.settings.read(),
          capabilities: capabilities(runtime),
          resources: resources(runtime.guildId),
          installation: { ready: true, managedLayout: false, activeRooms: 0 },
        };
      case "settings.save": {
        if (payload.scope !== "modules")
          throw new ControlError(400, "settings_scope", "Wybierz zakres ustawień.");
        const draft = parseModuleSettings(payload.settings);
        if (
          newModules.some(
            (key) => !["announcements", "meetings", "cases"].includes(key) && draft.enabled[key],
          )
        )
          throw new ControlError(
            409,
            "module_unavailable",
            "Ta funkcja jest jeszcze w przygotowaniu.",
          );
        const available = resources(runtime.guildId);
        if (
          (draft.cases?.categoryId &&
            !available.channels.some(
              (channel) => channel.id === draft.cases!.categoryId && channel.kind === "category",
            )) ||
          (draft.cases?.suggestionChannelId &&
            !available.channels.some(
              (channel) =>
                channel.id === draft.cases!.suggestionChannelId && channel.kind === "text",
            ))
        )
          throw new ControlError(400, "cases_channel", "Wybierz zasoby tego podglądu.");
        if (
          [
            ...draft.organizerRoleIds,
            ...draft.caseModeratorRoleIds,
            ...draft.announcementManagerRoleIds,
            ...draft.djRoleIds,
          ].some((id) => !available.roles.some((role) => role.id === id))
        )
          throw new ControlError(400, "roles", "Wybierz role tego serwera.");
        return runtime.jobs.idempotent("preview:module-settings", requestId!, draft, () => {
          const saved = runtime.settings.save(draft, previewActorId);
          for (const job of runtime.jobs.list({
            guildId: runtime.guildId,
            states: ["pending", "retry", "running", "unknown"],
            limit: 500,
          }))
            if (
              (!saved.enabled.announcements && job.type === "announcement.send") ||
              (!saved.enabled.meetings && job.type.startsWith("meeting.")) ||
              (!saved.enabled.cases && job.type === "case.notify")
            )
              runtime.jobs.cancel(job.id);
          for (const value of runtime.store.db
            .prepare("SELECT id,owner_id,visibility,generation FROM cases WHERE guild_id=?")
            .all(runtime.guildId))
            caseResource(runtime, {
              guildId: runtime.guildId,
              caseId: String(value.id),
              ownerId: String(value.owner_id),
              visibility: value.visibility as "private" | "public",
              generation: Number(value.generation),
            });
          return { moduleSettings: saved, capabilities: capabilities(runtime) };
        });
      }
      case "meetings.list":
        only(payload, []);
        return { meetings: await runtime.meetings.list(previewActorId) };
      case "meetings.read":
        only(payload, []);
        return meetingView(runtime, objectId!);
      case "meetings.preview":
        requireEnabled(runtime, "meetings");
        only(payload, ["date", "time", "timeZone"]);
        requirePermission("meetings.preview", facts(runtime), runtime.settings.policy());
        return resolveLocalDateTime(
          payload.date as string,
          payload.time as string,
          payload.timeZone as string,
        );
      case "meetings.create":
        return meetingMutation(
          await runtime.meetings.create(
            previewActorId,
            requestId!,
            payload as unknown as MeetingDraft,
          ),
        );
      case "meetings.update":
        only(payload, ["revision", "draft", "audience"]);
        if (Object.hasOwn(payload, "audience") === Object.hasOwn(payload, "draft"))
          throw new ControlError(400, "invalid_input", "Wybierz jeden zakres zmiany spotkania.");
        if (payload.audience !== undefined)
          return meetingMutation(
            await runtime.meetings.updateAudience(
              previewActorId,
              requestId!,
              objectId!,
              revision(payload.revision),
              object(
                payload.audience,
              ) as unknown as import("../contracts/community.js").MeetingAudience,
            ),
          );
        return meetingMutation(
          await runtime.meetings.update(
            previewActorId,
            requestId!,
            objectId!,
            revision(payload.revision),
            object(payload.draft) as unknown as MeetingDraft,
          ),
        );
      case "meetings.join":
      case "meetings.leave":
        only(payload, []);
        return meetingMutation(
          await runtime.meetings[operation === "meetings.join" ? "join" : "leave"](
            previewActorId,
            requestId!,
            objectId!,
          ),
        );
      case "meetings.start":
      case "meetings.complete":
      case "meetings.cancel":
        only(payload, ["revision"]);
        return meetingMutation(
          await runtime.meetings.transition(
            previewActorId,
            requestId!,
            objectId!,
            revision(payload.revision),
            operation.slice(9) as "start" | "complete" | "cancel",
          ),
        );
      case "cases.list":
        return { cases: await cases(runtime).list(previewActorId, payload as CaseListFilter) };
      case "cases.read":
        only(payload, []);
        return caseView(runtime, objectId!);
      case "cases.create":
        return caseMutation(
          await cases(runtime).create(previewActorId, requestId!, payload as unknown as CaseDraft),
        );
      case "cases.reply":
      case "cases.note":
        only(payload, ["revision", "content"]);
        return caseMutation(
          await cases(runtime)[operation === "cases.reply" ? "reply" : "note"](
            previewActorId,
            requestId!,
            objectId!,
            revision(payload.revision),
            payload.content as string,
          ),
        );
      case "cases.notes":
        only(payload, []);
        return { notes: await cases(runtime).notes(previewActorId, objectId!) };
      case "cases.assign":
        only(payload, ["revision", "assigneeId"]);
        return caseMutation(
          await cases(runtime).assign(
            previewActorId,
            requestId!,
            objectId!,
            revision(payload.revision),
            payload.assigneeId as string | null,
          ),
        );
      case "cases.transition":
        only(payload, ["revision", "status", "reason"]);
        return caseMutation(
          await cases(runtime).transition(
            previewActorId,
            requestId!,
            objectId!,
            revision(payload.revision),
            {
              status: payload.status,
              ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
            } as CaseTransition,
          ),
        );
      case "cases.approve": {
        only(payload, ["revision"]);
        const value = await cases(runtime).approve(
          previewActorId,
          requestId!,
          objectId!,
          revision(payload.revision),
        );
        caseResource(runtime, {
          guildId: runtime.guildId,
          caseId: value.case.id,
          ownerId: value.case.ownerId,
          visibility: value.case.visibility,
          generation: value.case.generation,
        });
        return caseMutation(value);
      }
      case "cases.vote":
        only(payload, ["value"]);
        return cases(runtime).vote(
          previewActorId,
          requestId!,
          objectId!,
          payload.value as 1 | -1 | null,
        );
      case "announcements.list":
        return { announcements: await service.list(previewActorId) };
      case "announcements.assets.upload": {
        if (!runtime.settings.read().enabled.announcements)
          throw new AnnouncementError("permission_revoked");
        if (
          Object.keys(payload).some((key) => !["mediaType", "dataBase64"].includes(key)) ||
          typeof payload.mediaType !== "string" ||
          typeof payload.dataBase64 !== "string" ||
          payload.dataBase64.length > 2796204 ||
          payload.dataBase64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.dataBase64)
        )
          throw new AnnouncementAssetError("invalid_asset");
        const data = Buffer.from(payload.dataBase64, "base64");
        if (data.toString("base64") !== payload.dataBase64)
          throw new AnnouncementAssetError("invalid_asset");
        return {
          asset: await runtime.assets.upload(
            previewActorId,
            requestId!,
            payload.mediaType,
            data,
            async () => {
              if (!runtime.settings.read().enabled.announcements)
                throw new AnnouncementError("permission_revoked");
            },
          ),
        };
      }
      case "announcements.assets.read": {
        if (!runtime.settings.read().enabled.announcements)
          throw new AnnouncementError("permission_revoked");
        if (Object.keys(payload).length) throw new AnnouncementAssetError("invalid_asset");
        const asset = runtime.assets.describeAsset(objectId!),
          data = await runtime.assets.readAsset(objectId!);
        return { asset, dataBase64: Buffer.from(data.data).toString("base64") };
      }
      case "announcements.read": {
        const announcement = await service.get(previewActorId, objectId!);
        const jobs = runtime.jobs.list({
          guildId: runtime.guildId,
          objectId,
          type: "announcement.send",
          limit: 100,
        });
        return {
          announcement,
          jobs: jobs.map(jobView),
          deliveries: jobs.flatMap((job) =>
            runtime.jobs
              .attempts(job.id)
              .map((attempt) => redacted(attempt, ["result", "leaseToken", "nonce"])),
          ),
        };
      }
      case "announcements.create":
        return mutationView(
          await service.create(previewActorId, requestId!, payload as unknown as AnnouncementDraft),
        );
      case "announcements.update":
        return mutationView(
          await service.update(
            previewActorId,
            requestId!,
            objectId!,
            revision(payload.revision),
            object(payload.draft) as unknown as AnnouncementDraft,
          ),
        );
      case "announcements.pause":
        return mutationView(
          await service.pause(previewActorId, requestId!, objectId!, revision(payload.revision)),
        );
      case "announcements.resume":
        return mutationView(
          await service.resume(previewActorId, requestId!, objectId!, revision(payload.revision)),
        );
      case "announcements.cancel":
        return mutationView(
          await service.cancel(previewActorId, requestId!, objectId!, revision(payload.revision)),
        );
      case "announcements.test":
        return mutationView(
          await service.test(previewActorId, requestId!, objectId!, revision(payload.revision)),
        );
      case "announcements.remove":
        only(payload, ["revision"]);
        return service.remove(previewActorId, requestId!, objectId!, revision(payload.revision));
      case "announcements.preview": {
        if (payload.draft !== undefined) {
          if (Object.keys(payload).some((key) => key !== "draft"))
            throw new AnnouncementError("invalid_input");
          return {
            message: await service.previewMessage(
              previewActorId,
              object(payload.draft) as unknown as AnnouncementDraft,
            ),
          };
        }
        const input = object(payload.schedule);
        const localOnce = input.kind === "once" && "date" in input;
        if (
          localOnce &&
          Object.keys(input).some((key) => !["kind", "date", "time", "timeZone"].includes(key))
        )
          throw new AnnouncementError("invalid_input");
        const occurrence = localOnce
          ? resolveLocalDateTime(
              input.date as string,
              input.time as string,
              input.timeZone as string,
            )
          : null;
        const schedule = normalizeSchedule(
          occurrence ? { kind: "once", at: occurrence.at } : (input as unknown as ScheduleInput),
          now(),
        );
        return {
          schedule,
          occurrences:
            occurrence && occurrence.at >= now()
              ? [occurrence]
              : nextOccurrences(schedule, now() - 1, 5),
        };
      }
      case "jobs.list":
        return { jobs: targetJobs(runtime, payload).map(jobView) };
      case "deliveries.list":
        return {
          deliveries: targetJobs(runtime, payload).flatMap((job) =>
            runtime.jobs
              .attempts(job.id)
              .map((attempt) => redacted(attempt, ["result", "leaseToken", "nonce"])),
          ),
        };
      case "jobs.read": {
        const job = runtime.jobs.get(objectId!);
        const selector = jobSelector(payload);
        if (
          !job ||
          job.guildId !== runtime.guildId ||
          runtime.jobs.isHistoryRetired(job.id) ||
          (selector && !matchesSelector(job, selector))
        )
          throw new ControlError(404, "not_found", "Nie znaleziono zadania.");
        return {
          job: jobView(job),
          attempts: runtime.jobs
            .attempts(job.id)
            .map((attempt) => redacted(attempt, ["result", "leaseToken", "nonce"])),
        };
      }
      case "jobs.cancel": {
        const job = runtime.jobs.get(objectId!);
        if (!job || job.guildId !== runtime.guildId || runtime.jobs.isHistoryRetired(job.id))
          throw new ControlError(404, "not_found", "Nie znaleziono zadania.");
        return runtime.jobs.idempotent(
          "preview:job-cancel",
          requestId!,
          { id: objectId, revision: payload.revision },
          () => {
            if (job.revision !== revision(payload.revision))
              throw new ControlError(409, "conflict", "Stan zadania zmienił się.");
            return { job: jobView(runtime.jobs.cancel(job.id)!) };
          },
        );
      }
      default:
        throw new ControlError(
          409,
          "module_unavailable",
          "Ta funkcja jest jeszcze w przygotowaniu.",
        );
    }
  }
  const runner = new JobRunner(
    () =>
      [...runtimes.values()].map((runtime) => ({
        guildId: runtime.guildId,
        store: runtime.jobs,
        available: () =>
          !closed &&
          (["announcements", "meetings", "cases"].some(
            (key) => runtime.settings.read().enabled[key as "announcements" | "meetings" | "cases"],
          ) ||
            runtime.rules.settings().enabled ||
            runtime.jobs.list({
              guildId: runtime.guildId,
              type: "server-rules.retire-controls",
              states: ["pending", "retry"],
              limit: 1,
            }).length > 0),
      })),
    async (job: JobLease, execution) => {
      const runtime = [...runtimes.values()].find((value) => value.jobs.get(job.id));
      if (!runtime) return { state: "failed", error: "preview_scope_missing" };
      try {
        if (job.type.startsWith("server-rules.")) return runtime.rules.execute(job, execution);
        if (job.type.startsWith("meeting.")) {
          const prepared = await runtime.meetings.prepare(job),
            meeting = prepared.meeting;
          execution.checkpoint();
          execution.beginAttempt({ nonce: randomUUID(), channelId: meeting.channelId });
          if (prepared.type === "meeting.publish") {
            const messageId = meeting.messageId ?? scopedId(runtime, "meeting-message", meeting.id);
            runtime.meetings.recordResult(job, { messageId });
            return { state: "succeeded", messageId, result: { preview: true, simulated: true } };
          }
          if (prepared.type === "meeting.start") {
            runtime.jobs.transaction(() => {
              execution.checkpoint();
              if (prepared.room.kind === "none") runtime.meetings.recordResult(job, {});
              else if (prepared.room.kind === "existing")
                runtime.meetings.recordResult(job, {
                  roomChannelId: prepared.room.channelId,
                  roomCreatedByBot: false,
                });
              else {
                const channelId = scopedId(runtime, "meeting-room", meeting.id),
                  key = `preview.meeting.${meeting.id}`;
                const prior = runtime.store.resource(key);
                if (prior) {
                  const saved = object(JSON.parse(prior.baseline));
                  if (
                    prior.id !== channelId ||
                    prior.kind !== "preview-meeting-room" ||
                    saved.scope !== runtime.scope ||
                    saved.guildId !== runtime.guildId ||
                    saved.meetingId !== meeting.id ||
                    saved.simulated !== true ||
                    saved.owned !== true
                  )
                    throw new MeetingError("forbidden");
                }
                runtime.store.putResource(key, "preview-meeting-room", channelId, {
                  scope: runtime.scope,
                  guildId: runtime.guildId,
                  meetingId: meeting.id,
                  parentId: prepared.room.categoryId,
                  generation: meeting.generation,
                  simulated: true,
                  owned: true,
                  cleaned: false,
                });
                runtime.meetings.recordResult(job, {
                  roomChannelId: channelId,
                  roomCreatedByBot: true,
                });
              }
            });
          } else if (prepared.type === "meeting.finish") {
            runtime.jobs.transaction(() => {
              execution.checkpoint();
              if (prepared.cleanupRoom) {
                const key = `preview.meeting.${meeting.id}`,
                  resource = runtime.store.resource(key);
                if (
                  !resource ||
                  resource.kind !== "preview-meeting-room" ||
                  resource.id !== prepared.cleanupRoom.channelId
                )
                  throw new MeetingError("forbidden");
                const saved = object(JSON.parse(resource.baseline));
                if (
                  saved.scope !== runtime.scope ||
                  saved.guildId !== runtime.guildId ||
                  saved.meetingId !== meeting.id ||
                  saved.simulated !== true ||
                  saved.owned !== true
                )
                  throw new MeetingError("forbidden");
                runtime.store.putResource(key, resource.kind, resource.id, {
                  ...saved,
                  cleaned: true,
                });
              }
              runtime.meetings.recordResult(job, {});
            });
          } else runtime.meetings.recordResult(job, {});
          return { state: "succeeded", result: { preview: true, simulated: true } };
        }
        if (job.type === "case.notify") {
          const publication = await cases(runtime).prepareNotification(job, (scope) =>
            caseTarget(runtime, scope),
          );
          execution.checkpoint();
          execution.beginAttempt({ nonce: randomUUID(), channelId: publication.channelId });
          return {
            state: "succeeded",
            messageId: `preview-${randomUUID()}`,
            result: { preview: true, simulated: true, audience: publication.audience },
          };
        }
        if (job.type !== "announcement.send") return { state: "failed", error: "unsupported_job" };
        const publication = await runtime.announcements.prepare(job);
        execution.checkpoint();
        execution.beginAttempt({ nonce: randomUUID(), channelId: publication.channelId });
        return {
          state: "succeeded",
          messageId: `preview-${randomUUID()}`,
          result: { preview: true, simulated: true },
        };
      } catch (error) {
        if (
          error instanceof AnnouncementError ||
          error instanceof MeetingError ||
          error instanceof CaseError
        )
          return [
            "stale_generation",
            "paused",
            "cancelled",
            "expired",
            "stale_job",
            "revision_conflict",
            "state_conflict",
          ].includes(error.code)
            ? { state: "expired", reason: error.code }
            : { state: "failed", error: error.code };
        if (error instanceof ControlError || error instanceof ModulePermissionError)
          return { state: "failed", error: error.code };
        throw error;
      }
    },
    { clock: now, concurrency: 2, stopTimeoutMs: 1000 },
  );
  async function tick(): Promise<number> {
    return exclusive(async () => {
      cleanup();
      for (const runtime of runtimes.values())
        if (now() >= (runtime.assetsPruneAt ?? 0)) {
          await runtime.assets.prune();
          runtime.assetsPruneAt = now() + 3600000;
        }
      for (const runtime of runtimes.values())
        if (runtime.settings.read().enabled.announcements) runtime.announcements.sync();
      const count = await runner.tick();
      for (const runtime of runtimes.values())
        if (runtime.settings.read().enabled.announcements) runtime.announcements.sync();
      return count;
    });
  }
  function mapped(error: unknown): unknown {
    if (error instanceof RulesError)
      return new ControlError(
        error.code === "not_found"
          ? 404
          : error.code === "invalid_input"
            ? 400
            : [
                  "native_pending",
                  "permission_revoked",
                  "member_unavailable",
                  "membership_changed",
                  "role_revoked",
                ].includes(error.code)
              ? 403
              : 409,
        error.code,
        "Sprawdź ustawienia i aktualny stan regulaminu.",
      );
    if (error instanceof AnnouncementAssetError)
      return new ControlError(
        error.code === "asset_not_found"
          ? 404
          : error.code === "asset_expired"
            ? 410
            : error.code === "asset_busy" || error.code === "asset_quota"
              ? 429
              : error.code === "asset_storage_unavailable"
                ? 503
                : error.code === "idempotency_conflict"
                  ? 409
                  : 400,
        error.code,
        "Nie udało się odczytać lub zapisać obrazu ogłoszenia.",
      );
    if (error instanceof ModulePermissionError)
      return new ControlError(403, error.code, "Nie masz dostępu do tej czynności w podglądzie.");
    if (
      error instanceof AnnouncementError ||
      error instanceof JobError ||
      error instanceof MeetingError ||
      error instanceof CaseError
    ) {
      const status =
        error.code === "not_found" || error.code === "job_not_found"
          ? 404
          : error.code === "limit_exceeded"
            ? 429
            : ["permission_revoked", "forbidden"].includes(error.code)
              ? 403
              : [
                    "revision_conflict",
                    "state_conflict",
                    "idempotency_conflict",
                    "cancelled",
                    "paused",
                    "stale_generation",
                    "capacity_conflict",
                    "approval_required",
                    "voting_closed",
                    "acl_unconfirmed",
                    "stale_job",
                  ].includes(error.code)
                ? 409
                : 400;
      return new ControlError(
        status,
        error.code,
        status === 409
          ? "Wpis zmienił się. Wczytaj aktualną wersję."
          : status === 403
            ? "Nie masz dostępu do tej czynności w podglądzie."
            : status === 404
              ? "Nie znaleziono wpisu."
              : status === 429
                ? "Zwolnij na chwilę i spróbuj ponownie."
                : "Sprawdź treść, kanał i termin.",
      );
    }
    return error;
  }
  let server: Server;
  try {
    cleanup();
    for (const row of registry.prepare("SELECT scope FROM sessions").all()) {
      const scope = String(row.scope),
        folder = scopeDirectory(scope);
      if (!existsSync(folder)) continue;
      const files = new Set(readdirSync(folder));
      for (const guildId of previewGuildIds)
        if (files.has(`${guildId}.sqlite`)) open(scope, guildId);
    }
    server = await startControlServer(
      options.key,
      options.port ?? 35473,
      (path, body) =>
        exclusive(async () => {
          try {
            const route = parseControlPath(path);
            if (!route || route.legacy)
              throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
            const envelope = parseVersionedRequest(body, {
              mutation: controlOperations[route.operation].mutation,
            });
            if (
              envelope.actor !== previewActorId ||
              !/^[A-Za-z0-9_-]{43}$/.test(envelope.accessToken)
            )
              throw new ControlError(401, "preview_session", "Otwórz podgląd ponownie.");
            if (
              route.guildId &&
              !previewGuildIds.includes(route.guildId as (typeof previewGuildIds)[number])
            )
              throw new ControlError(404, "not_found", "Nie znaleziono serwera podglądu.");
            const scope = touch(envelope.accessToken);
            if (route.operation === "guilds.list")
              return versionedResponse({ preview: true, guilds });
            if (!route.guildId)
              throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
            const runtime = open(scope, route.guildId);
            if (runtime.settings.read().enabled.announcements) runtime.announcements.sync();
            const data = await request(
              runtime,
              route.operation,
              envelope.payload,
              route.objectId,
              envelope.requestId,
            );
            return versionedResponse({ ...data, preview: true });
          } catch (error) {
            throw mapped(error);
          }
        }),
      { allowEphemeralPort: true },
    );
  } catch (error) {
    for (const runtime of runtimes.values()) runtime.store.close();
    registry.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Preview worker did not bind to loopback.");
  if (options.autoStart !== false) {
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, interval);
    timer.unref();
  }
  let closing: Promise<void> | undefined;
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    tick,
    close: () =>
      (closing ??= (async () => {
        clearInterval(timer);
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
        await queue;
        await runner.stop();
        closed = true;
        for (const runtime of runtimes.values()) runtime.store.close();
        registry.close();
      })()),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const worker = await createPreviewWorker({
    key: process.env.PREVIEW_CONTROL_KEY ?? "",
    port: Number(process.env.PREVIEW_CONTROL_PORT ?? 35473),
  });
  process.stdout.write(`Lokalny podgląd Gildiusza: ${worker.origin}\n`);
  const stop = () => {
    void worker.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
