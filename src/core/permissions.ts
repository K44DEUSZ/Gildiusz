export interface MemberFacts {
  guildId: string;
  userId: string;
  owner: boolean;
  manageGuild: boolean;
  roleIds: readonly string[];
  pending: boolean;
  timedOut: boolean;
  isBot: boolean;
  voiceChannelId?: string | null;
}

export interface ModulePolicy {
  guildId: string;
  organizerRoleIds?: readonly string[];
  caseModeratorRoleIds?: readonly string[];
  announcementManagerRoleIds?: readonly string[];
  djRoleIds?: readonly string[];
  allowMemberMusic?: boolean;
}

export interface BoundObject {
  guildId: string;
  ownerId?: string;
  visibility?: "public" | "private";
  kind?: "report" | "question" | "suggestion";
  state?: string;
  voiceChannelId?: string;
  participantIds?: readonly string[];
  invitedUserIds?: readonly string[];
  allowedRoleIds?: readonly string[];
  votingEnabled?: boolean;
}

export const moduleActions = [
  "capabilities.read",
  "settings.read",
  "settings.save",
  "rules.read",
  "rules.configure",
  "rules.publish",
  "rules.acceptances.list",
  "rules.publications.reconcile",
  "integrations.list",
  "integrations.lookup",
  "integrations.create",
  "integrations.read",
  "integrations.update",
  "integrations.test",
  "integrations.remove",
  "jobs.list",
  "jobs.read",
  "jobs.cancel",
  "jobs.retry",
  "deliveries.list",
  "meetings.list",
  "meetings.preview",
  "meetings.create",
  "meetings.read",
  "meetings.update",
  "meetings.join",
  "meetings.leave",
  "meetings.cancel",
  "meetings.start",
  "meetings.complete",
  "cases.list",
  "cases.create",
  "cases.read",
  "cases.reply",
  "cases.note",
  "cases.notes",
  "cases.approve",
  "cases.assign",
  "cases.transition",
  "cases.vote",
  "announcements.list",
  "announcements.assets.upload",
  "announcements.assets.read",
  "announcements.create",
  "announcements.read",
  "announcements.update",
  "announcements.preview",
  "announcements.test",
  "announcements.pause",
  "announcements.resume",
  "announcements.cancel",
  "announcements.remove",
  "music.read",
  "music.play",
  "music.join",
  "music.queue",
  "music.vote",
  "music.pause",
  "music.resume",
  "music.skip",
  "music.stop",
  "music.move",
] as const;
export type ModuleAction = (typeof moduleActions)[number];
export type PermissionCode =
  | "unknown_action"
  | "invalid_member"
  | "invalid_policy"
  | "guild_mismatch"
  | "ineligible_member"
  | "object_required"
  | "invalid_object"
  | "forbidden"
  | "closed"
  | "voice_required"
  | "different_voice_channel";
export type PermissionDecision = { allowed: true } | { allowed: false; code: PermissionCode };

export class ModulePermissionError extends Error {
  constructor(readonly code: PermissionCode) {
    super("Nie masz dostępu do tej czynności.");
    this.name = "ModulePermissionError";
  }
}

const actions = new Set<string>(moduleActions);
const allow: PermissionDecision = { allowed: true };
const deny = (code: PermissionCode): PermissionDecision => ({ allowed: false, code });
const id = (value: unknown): value is string =>
  typeof value === "string" && /^\d{17,20}$/.test(value);
const ids = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length <= 1000 && value.every(id);
const ownedActions = new Set<string>([
  "integrations.read",
  "integrations.update",
  "integrations.test",
  "integrations.remove",
  "jobs.read",
  "jobs.cancel",
  "jobs.retry",
  "meetings.read",
  "meetings.update",
  "meetings.join",
  "meetings.leave",
  "meetings.cancel",
  "meetings.start",
  "meetings.complete",
  "cases.read",
  "cases.reply",
  "cases.note",
  "cases.notes",
  "cases.approve",
  "cases.assign",
  "cases.transition",
  "cases.vote",
  "announcements.read",
  "announcements.update",
  "announcements.test",
  "announcements.pause",
  "announcements.resume",
  "announcements.cancel",
  "announcements.remove",
  "music.queue",
  "music.vote",
  "music.pause",
  "music.resume",
  "music.skip",
  "music.stop",
  "music.move",
]);

// Adapters supply current facts refreshed from Discord, never roles or flags from request bodies.
export function permissionDecision(
  action: ModuleAction | string,
  member: MemberFacts,
  policy: ModulePolicy,
  object?: BoundObject,
): PermissionDecision {
  if (!actions.has(action)) return deny("unknown_action");
  if (
    !member ||
    !id(member.guildId) ||
    !id(member.userId) ||
    !ids(member.roleIds) ||
    [member.owner, member.manageGuild, member.pending, member.timedOut, member.isBot].some(
      (value) => typeof value !== "boolean",
    ) ||
    (member.voiceChannelId != null && !id(member.voiceChannelId))
  )
    return deny("invalid_member");
  if (
    !policy ||
    !id(policy.guildId) ||
    [
      policy.organizerRoleIds,
      policy.caseModeratorRoleIds,
      policy.announcementManagerRoleIds,
      policy.djRoleIds,
    ].some((value) => value !== undefined && !ids(value)) ||
    (policy.allowMemberMusic !== undefined && typeof policy.allowMemberMusic !== "boolean")
  )
    return deny("invalid_policy");
  if (member.guildId !== policy.guildId || (object && object.guildId !== policy.guildId))
    return deny("guild_mismatch");
  if (member.pending || member.timedOut || member.isBot) return deny("ineligible_member");
  if (ownedActions.has(action) && !object) return deny("object_required");
  if (
    object &&
    (!id(object.guildId) ||
      (object.ownerId !== undefined && !id(object.ownerId)) ||
      (object.participantIds !== undefined && !ids(object.participantIds)) ||
      (object.invitedUserIds !== undefined && !ids(object.invitedUserIds)) ||
      (object.allowedRoleIds !== undefined && !ids(object.allowedRoleIds)))
  )
    return deny("invalid_object");

  const admin = member.owner || member.manageGuild;
  const hasRole = (roles: readonly string[] | undefined) =>
    roles?.some((role) => member.roleIds.includes(role)) ?? false;
  const organizer = admin || hasRole(policy.organizerRoleIds);
  const staff = admin || hasRole(policy.caseModeratorRoleIds);
  const announcer = admin || hasRole(policy.announcementManagerRoleIds);
  const dj = admin || hasRole(policy.djRoleIds);
  const own = object?.ownerId === member.userId;

  if (action === "capabilities.read") return allow;
  if (
    action.startsWith("settings.") ||
    action.startsWith("rules.") ||
    action.startsWith("integrations.") ||
    action.startsWith("jobs.") ||
    action === "deliveries.list"
  )
    return admin ? allow : deny("forbidden");

  if (action.startsWith("meetings.")) {
    // List access is only module entry; callers apply read permission to every returned object.
    if (action === "meetings.list" || action === "meetings.preview") return allow;
    if (action === "meetings.create") return organizer ? allow : deny("forbidden");
    if (!object || !id(object.ownerId)) return deny("invalid_object");
    const visible =
      object.visibility === "public" ||
      (object.visibility === "private" &&
        (own ||
          organizer ||
          object.invitedUserIds?.includes(member.userId) ||
          hasRole(object.allowedRoleIds) ||
          object.participantIds?.includes(member.userId)));
    if (action === "meetings.read")
      return visible && (object.state !== "draft" || own || organizer) ? allow : deny("forbidden");
    if (action === "meetings.join") {
      if (!visible) return deny("forbidden");
      return object.state === "open" ? allow : deny("closed");
    }
    if (action === "meetings.leave")
      return visible && ["open", "starting", "active"].includes(object.state ?? "")
        ? allow
        : deny("closed");
    return own || organizer ? allow : deny("forbidden");
  }

  if (action.startsWith("cases.")) {
    if (action === "cases.list" || action === "cases.create") return allow;
    if (
      !object ||
      !id(object.ownerId) ||
      !["report", "question", "suggestion"].includes(object.kind ?? "") ||
      !["public", "private"].includes(object.visibility ?? "") ||
      (object.kind !== "suggestion" && object.visibility !== "private")
    )
      return deny("invalid_object");
    const readable =
      staff || own || (object.kind === "suggestion" && object.visibility === "public");
    if (action === "cases.read" || action === "cases.reply")
      return readable ? allow : deny("forbidden");
    if (action === "cases.vote") {
      if (
        object.kind !== "suggestion" ||
        object.visibility !== "public" ||
        object.votingEnabled !== true
      )
        return deny("forbidden");
      return ["new", "open", "in_review"].includes(object.state ?? "") ? allow : deny("closed");
    }
    return staff ? allow : deny("forbidden");
  }

  if (action.startsWith("announcements.")) return announcer ? allow : deny("forbidden");

  if (action === "music.read") return allow;
  if (object && (!id(object.voiceChannelId) || !id(object.ownerId))) return deny("invalid_object");
  const sameChannel = Boolean(object && member.voiceChannelId === object.voiceChannelId);
  if (action === "music.play" || action === "music.join") {
    if (!member.voiceChannelId) return deny("voice_required");
    if (object && !sameChannel) return deny("different_voice_channel");
    return dj || policy.allowMemberMusic === true ? allow : deny("forbidden");
  }
  if (action === "music.vote") {
    if (!["playing", "paused"].includes(object?.state ?? "")) return deny("closed");
    return sameChannel ? allow : deny("different_voice_channel");
  }
  if (action === "music.queue")
    return dj || (sameChannel && policy.allowMemberMusic === true) ? allow : deny("forbidden");
  if (["music.pause", "music.resume", "music.skip", "music.stop", "music.move"].includes(action))
    return own || dj ? allow : deny("forbidden");
  return deny("unknown_action");
}

export function canPerform(
  action: ModuleAction | string,
  member: MemberFacts,
  policy: ModulePolicy,
  object?: BoundObject,
): boolean {
  return permissionDecision(action, member, policy, object).allowed;
}

export function requirePermission(
  action: ModuleAction | string,
  member: MemberFacts,
  policy: ModulePolicy,
  object?: BoundObject,
): void {
  const decision = permissionDecision(action, member, policy, object);
  if (!decision.allowed) throw new ModulePermissionError(decision.code);
}
