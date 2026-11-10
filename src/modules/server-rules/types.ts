import type { ExecutionContext } from "../../core/jobs/runner.js";

import type { RulesAcceptance } from "../../contracts/server-rules.js";
export type {
  RulesMethod,
  RulesDraft,
  RulesSettings,
  RulesVersion,
  RulesPart,
  RulesGrantState,
  RulesAcceptance,
} from "../../contracts/server-rules.js";
export interface RulesRole {
  guildId: string;
  id: string;
  permissions: bigint;
  position: number;
  managed: boolean;
  restricted: boolean;
}
export interface RulesChannel {
  guildId: string;
  id: string;
  type: "text" | "other";
  overwrites: { id: string; type: "role" | "member"; allow: bigint; deny: bigint }[];
}
/** Adapters obtain complete snapshots from Discord, never from a panel request body or cache. */
export interface RulesPreflightFacts {
  guildId: string;
  observedAt: number;
  nativeScreening: boolean;
  complete: boolean;
  roles: RulesRole[];
  channels: RulesChannel[];
  botRoleIds: string[];
  interestRoleIds: string[];
  staffRoleIds: string[];
  staffUserIds: string[];
}
export interface RulesMemberFacts {
  guildId: string;
  userId: string;
  observedAt: number;
  joinedAt: number;
  bot: boolean;
  pending: boolean | null;
  timedOut: boolean;
  roleIds: string[];
}
export interface RulesAdministratorFacts {
  guildId: string;
  userId: string;
  observedAt: number;
  owner: boolean;
  manageGuild: boolean;
  pending: boolean | null;
  timedOut: boolean;
}
export interface RulesMessage {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  webhookId: string | null;
  content: string;
  controlId: string | null;
  reactionEmoji: string | null;
}
export interface RulesSendPart {
  guildId: string;
  channelId: string;
  content: string;
  controlId: string | null;
  allowedMentions: { parse: []; users: []; roles: [] };
  nonce: string;
  enforceNonce: true;
  signal: AbortSignal;
}
export interface RulesPorts {
  administrator(userId: string): Promise<RulesAdministratorFacts>;
  preflight(): Promise<RulesPreflightFacts>;
  member(userId: string): Promise<RulesMemberFacts | null>;
  message(channelId: string, messageId: string): Promise<RulesMessage | null>;
  /** One POST, retries disabled. The receipt is retained before any subsequent network read. */
  sendPart(
    input: RulesSendPart,
  ): Promise<{ guildId: string; channelId: string; messageId: string }>;
  /** A separate PUT of the bot's own reaction after durable verification of the POST receipt. */
  seedReaction(input: {
    guildId: string;
    channelId: string;
    messageId: string;
    emoji: string;
    signal: AbortSignal;
  }): Promise<void>;
  /** Only AddGuildMemberRole: no replacement of the member's complete role array. */
  addRole(input: {
    guildId: string;
    userId: string;
    roleId: string;
    signal: AbortSignal;
  }): Promise<void>;
  retireControls(input: {
    guildId: string;
    channelId: string;
    messageId: string;
    signal: AbortSignal;
  }): Promise<void>;
}
export interface RulesOptions {
  guildId: string;
  botId: string;
  ports: RulesPorts;
  clock?: () => number;
  maxFactAgeMs?: number;
}
export interface RulesAcceptEvent {
  versionId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  source: RulesAcceptance["source"];
  controlId?: string;
  emoji?: string;
  /** Reconciliation supplies only the observation time, never a fabricated historical click time. */
  observedAt?: number;
  reconciliationComplete?: boolean;
}
export type RulesExecutionContext = ExecutionContext;
export type RulesErrorCode =
  | "invalid_input"
  | "permission_revoked"
  | "role_unavailable"
  | "channel_unavailable"
  | "incomplete_acl"
  | "native_pending"
  | "member_unavailable"
  | "membership_changed"
  | "role_revoked"
  | "disabled"
  | "not_found"
  | "revision_conflict"
  | "stale_generation"
  | "publication_unavailable"
  | "publication_not_ready"
  | "unknown_effect"
  | "stale_lease";
export class RulesError extends Error {
  constructor(readonly code: RulesErrorCode) {
    super(code);
    this.name = "RulesError";
  }
}
