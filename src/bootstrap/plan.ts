import { Routes, SnowflakeUtil } from "discord.js";
import type { Config, Environment } from "../config.js";
import { contentDigest } from "../content.js";
import { digest, canonical } from "../shared/utils.js";
import { Store } from "../storage/store.js";
import { desired, resourceRoute, type Desired } from "./desired.js";
import { optionalGet, type Api, type Body, type RemoteResource, type Snapshot } from "./api.js";
import { P } from "../permissions/model.js";
import { removePinNotices } from "../shared/pin-notices.js";

const idSetFields = new Set([
  "default_channel_ids",
  "role_ids",
  "channel_ids",
  "exempt_roles",
  "exempt_channels",
]);

export interface Change {
  item: Desired;
  action: "create" | "update" | "keep";
  id?: string;
  before: Body | null;
  drift: boolean;
}
export interface Plan {
  schema: 1;
  created: string;
  expires: string;
  guildId: string;
  ownerId: string;
  clientId: string;
  phase: "core" | "community" | "content";
  configHash: string;
  contentHash: string;
  snapshotHash: string;
  changes: Change[];
  conflicts: string[];
  notes: string[];
  hash: string;
}

export function project(actual: unknown, shape: unknown): unknown {
  if (Array.isArray(shape)) {
    if (!Array.isArray(actual)) return actual ?? (shape.length === 0 ? [] : null);
    if (shape.length === 0) return actual;
    const mapped = actual.map((entry, index) => {
      const specific =
        entry && typeof entry === "object"
          ? ["id", "name", "title", "type"]
              .map((key) =>
                shape.find(
                  (candidate) =>
                    candidate &&
                    typeof candidate === "object" &&
                    key in candidate &&
                    key in entry &&
                    candidate[key] === entry[key],
                ),
              )
              .find(Boolean)
          : undefined;
      return project(entry, specific ?? shape[index] ?? shape[0]);
    });
    if (shape[0] && typeof shape[0] === "object" && "id" in shape[0])
      mapped.sort((a, b) => canonical(a).localeCompare(canonical(b)));
    return mapped;
  }
  if (shape && typeof shape === "object") {
    const source = (actual ?? {}) as Body;
    return Object.fromEntries(
      Object.entries(shape)
        .filter(([key]) => key !== "allowed_mentions")
        .map(([key, value]) => {
          const result = project(source[key], value);
          return [
            key,
            idSetFields.has(key) && Array.isArray(result)
              ? [...result].sort((a, b) => String(a).localeCompare(String(b)))
              : result,
          ];
        }),
    );
  }
  return actual ?? (shape === false ? false : null);
}

export function resolveReferences<T>(value: T, store: Store, strict = true): T {
  if (typeof value === "string")
    return value.replace(/@\{([^{}]+)\}/g, (full, key: string) => {
      const entry = store.resource(key);
      if (!entry && strict) throw new Error(`Unresolved managed resource ${key}`);
      return entry?.id ?? full;
    }) as T;
  if (Array.isArray(value))
    return value.map((entry) => resolveReferences(entry, store, strict)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveReferences(entry, store, strict)]),
    ) as T;
  return value;
}

function current(item: Desired, state: Snapshot, store: Store): RemoteResource | null {
  const id = store.resource(item.key)?.id;
  if (item.key === "role.everyone")
    return state.roles.find((role) => role.id === state.guild.id) ?? null;
  if (item.kind === "guild") return state.guild;
  if (item.kind === "onboarding") return state.onboarding;
  const list =
    item.kind === "role"
      ? state.roles
      : item.kind === "channel"
        ? state.channels
        : item.kind === "automod"
          ? state.automod
          : state.commands;
  return list.find((resource) => resource.id === id) ?? null;
}

export function planHash(plan: Omit<Plan, "hash"> | Plan): string {
  const payload: Partial<Plan> = { ...plan };
  delete payload.hash;
  return digest(payload);
}

function snapshotDigest(state: Snapshot): string {
  return digest({
    ...state,
    guild: { ...state.guild, features: [...(state.guild.features as string[])].sort() },
    onboarding: state.onboarding
      ? {
          ...state.onboarding,
          default_channel_ids: [...(state.onboarding.default_channel_ids as string[])].sort(),
        }
      : null,
  });
}

export async function buildPlan(
  api: Api,
  state: Snapshot,
  store: Store,
  config: Config,
  environment: Environment,
  phase: Plan["phase"],
): Promise<Plan> {
  const conflicts: string[] = [];
  const notes: string[] = [];
  if (store.operations().length)
    conflicts.push(
      "Unfinished API operation in the database. Inspect and resolve it before applying another plan.",
    );
  if (phase !== "core" && !(state.guild.features as string[]).includes("COMMUNITY"))
    conflicts.push("Owner must enable Community before this phase.");
  const changes: Change[] = [];
  if (state.botRoleIds && phase !== "content") {
    const base = state.roles
      .filter((role) => role.id === environment.guildId || state.botRoleIds!.includes(role.id))
      .reduce((mask, role) => mask | BigInt(String(role.permissions)), 0n);
    const required = P.ManageGuild | P.ManageRoles | P.ManageChannels;
    if ((base & required) !== required)
      conflicts.push(
        "The bot lacks temporary configuration permissions. Review the installation instructions.",
      );
  }
  for (const item of desired(config, environment, phase)) {
    const resource = store.resource(item.key);
    let actual = current(item, state, store);
    if (item.kind === "message")
      actual = resource
        ? await optionalGet(
            api,
            resourceRoute(environment, resolveReferences(item, store, false), resource.id),
          )
        : null;
    if (
      item.kind === "message" &&
      actual &&
      actual.author &&
      (actual.author as Body).id !== environment.clientId
    ) {
      conflicts.push(`${item.key}: message is not owned by this application.`);
      continue;
    }
    if (
      !resource &&
      !["guild", "onboarding", "message"].includes(item.kind) &&
      item.key !== "role.everyone"
    ) {
      const list =
        item.kind === "role"
          ? state.roles
          : item.kind === "channel"
            ? state.channels
            : item.kind === "automod"
              ? state.automod
              : state.commands;
      if (list.some((candidate) => candidate.name === item.body.name))
        conflicts.push(
          `${item.key}: unmanaged resource with the same name exists. Explicit adoption is required.`,
        );
      if (
        item.kind === "automod" &&
        list.some((candidate) => candidate.trigger_type === item.body.trigger_type)
      )
        conflicts.push(`${item.key}: another rule already uses this limited trigger type.`);
    }
    if (resource && !actual && !["onboarding", "guild"].includes(item.kind))
      conflicts.push(
        `${item.key}: mapped resource no longer exists or is not visible. Do not recreate automatically.`,
      );
    const body = resolveReferences(item.body, store, false);
    const comparison = project(body, body) as Body;
    const before = actual ? (project(actual, body) as Body) : null;
    const baseline = resource ? (JSON.parse(resource.baseline) as Body) : null;
    const drift = Boolean(
      actual &&
      baseline &&
      canonical(project(actual, baseline)) !== canonical(project(baseline, baseline)),
    );
    if (actual && item.kind === "channel" && actual.type !== item.body.type)
      conflicts.push(`${item.key}: channel type differs; migration is not automatic.`);
    changes.push({
      item,
      action: !actual
        ? "create"
        : canonical(before) === canonical(comparison) &&
            !(item.kind === "message" && item.pin && !actual.pinned)
          ? "keep"
          : "update",
      id: actual?.id ?? resource?.id,
      before,
      drift,
    });
  }
  if (phase === "core")
    notes.push(
      "After this phase the owner must enable Community. Forums are created only in the community phase.",
    );
  notes.push(
    "Owner sets Moderator permissions, Rules Screening, role hierarchy and moderator 2FA manually. Bot permissions are reduced manually after acceptance.",
  );
  const unknown = state.channels.filter(
    (channel) =>
      !store
        .resources()
        .some((resource) => resource.kind === "channel" && resource.id === channel.id) &&
      !store.room(channel.id),
  );
  if (unknown.length)
    notes.push(
      `Existing unmanaged channels are preserved: ${unknown.map((channel) => `${channel.id} (${channel.name})`).join(", ")}`,
    );
  const expectedKeys = new Set(changes.map((change) => change.item.key));
  const obsolete = store
    .resources()
    .filter(
      (resource) =>
        resource.kind === "message" && phase === "content" && !expectedKeys.has(resource.key),
    );
  if (obsolete.length)
    conflicts.push(
      `Obsolete managed message parts require separate review: ${obsolete.map((entry) => `${entry.key}=${entry.id}`).join(", ")}`,
    );
  if (!config.attachments.uploadsEnabled)
    notes.push("Member uploads remain disabled until the file filter is running and verified.");
  const plan: Plan = {
    schema: 1,
    created: new Date().toISOString(),
    expires: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    guildId: environment.guildId,
    ownerId: environment.ownerId,
    clientId: environment.clientId,
    phase,
    configHash: digest(config),
    contentHash: contentDigest(),
    snapshotHash: snapshotDigest(state),
    changes,
    conflicts,
    notes,
    hash: "",
  };
  plan.hash = planHash(plan);
  return plan;
}

export async function applyPlan(
  plan: Plan,
  approvedHash: string,
  state: Snapshot,
  store: Store,
  config: Config,
  environment: Environment,
  api: Api,
  options: { allowSensitive: boolean; allowDrift: boolean },
): Promise<void> {
  if (plan.schema !== 1 || plan.hash !== planHash(plan) || approvedHash !== plan.hash)
    throw new Error("The approved plan hash is invalid.");
  if (
    plan.guildId !== environment.guildId ||
    plan.ownerId !== environment.ownerId ||
    plan.clientId !== environment.clientId
  )
    throw new Error("Plan identity differs from this environment.");
  if (Date.parse(plan.expires) < Date.now() || !Number.isFinite(Date.parse(plan.expires)))
    throw new Error("Plan expired. Generate a new plan.");
  if (digest(config) !== plan.configHash || contentDigest() !== plan.contentHash)
    throw new Error("Configuration or content changed since planning.");
  if (snapshotDigest(state) !== plan.snapshotHash)
    throw new Error("Discord state changed. Review a new plan.");
  if (plan.conflicts.length || store.operations().length)
    throw new Error("Resolve plan conflicts and unfinished operations first.");
  const fresh = await buildPlan(api, state, store, config, environment, plan.phase);
  if (canonical(fresh.changes) !== canonical(plan.changes))
    throw new Error("Managed messages or mappings changed since planning.");
  if (plan.changes.some((change) => change.drift) && !options.allowDrift)
    throw new Error(
      "Human changes were detected. Review them and pass --allow-drift only when approved.",
    );
  if (
    plan.changes.some((change) => change.action === "update" && change.item.sensitive) &&
    !options.allowSensitive
  )
    throw new Error("Permission/privacy updates require --allow-sensitive with the approved plan.");
  for (const change of plan.changes) {
    const item = resolveReferences(change.item, store);
    if (change.action === "keep") {
      if (!store.resource(item.key) && change.id)
        store.putResource(item.key, item.kind, change.id, change.before);
      continue;
    }
    const route = resourceRoute(environment, item, change.id);
    const body = { ...item.body };
    // Discord defaults a new role to @everyone's flags; later Moderator flags belong to the owner.
    if (item.key === "role.moderator" && change.action === "create") body.permissions = "0";
    if (item.kind === "onboarding") {
      const existing = (state.onboarding?.prompts ?? []) as Body[];
      body.prompts = (body.prompts as Body[]).map((prompt) => {
        const previous = existing.find((entry) => entry.title === prompt.title);
        const options = (previous?.options ?? []) as Body[];
        return {
          ...prompt,
          // Even new prompts require an ID; Discord assigns their final IDs in the response.
          id: previous?.id ?? SnowflakeUtil.generate().toString(),
          options: (prompt.options as Body[]).map((option) => {
            const old = options.find((entry) => entry.title === option.title);
            return { ...option, ...(old?.id ? { id: old.id } : {}) };
          }),
        };
      });
    }
    if (item.kind === "channel" && change.id) {
      delete body.type;
      if (Array.isArray(body.available_tags)) {
        const old = state.channels.find((channel) => channel.id === change.id)?.available_tags as
          Body[] | undefined;
        body.available_tags = (body.available_tags as Body[]).map((tag) => ({
          ...tag,
          ...(old?.find((entry) => entry.name === tag.name)?.id
            ? { id: old.find((entry) => entry.name === tag.name)!.id }
            : {}),
        }));
      }
    }
    store.beginOperation(item.key, { route, kind: item.kind, action: change.action });
    // Never retry ambiguous create failures: the owner reconciles the operation journal.
    const response =
      item.kind === "onboarding"
        ? ((await api.put(route, body)) as RemoteResource)
        : change.action === "create"
          ? await api.post(route, body)
          : await api.patch(route, body);
    const id = response.id ?? change.id ?? environment.guildId;
    store.transaction(() => {
      store.putResource(item.key, item.kind, String(id), project(response, item.body));
      store.endOperation(item.key);
    });
    if (item.kind === "message" && item.pin) {
      await api.put(Routes.channelPin(item.parent!, String(id)), {});
      await removePinNotices(api, item.parent!, environment.clientId, new Set([String(id)]));
    }
  }
}
