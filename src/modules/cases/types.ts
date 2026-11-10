import type {
  BoundObject,
  MemberFacts,
  ModuleAction,
  ModulePolicy,
} from "../../core/permissions.js";

import type { SuggestionStatus, CaseRecord } from "../../contracts/community.js";
export type {
  CaseKind,
  SupportStatus,
  SuggestionStatus,
  CaseStatus,
  CaseDraft,
  CaseRecord,
  CaseSummary,
  CaseMessage,
  CaseVotes,
  CaseView,
  CaseMutation,
  CaseListFilter,
  CaseTransition,
} from "../../contracts/community.js";
export interface CaseAuthorization {
  guildId: string;
  actorId: string;
  operation: ModuleAction;
  object?: BoundObject;
}
export interface CaseAuthority {
  member: MemberFacts;
  policy: ModulePolicy;
}
export interface CaseOptions {
  guildId: string;
  clock?: () => number;
  authorize(request: CaseAuthorization): CaseAuthority | Promise<CaseAuthority>;
  // Runs inside create's transaction; adapters only enqueue local durable work here.
  onCreated?(value: CaseRecord): void;
  suggestionVisibility?: "approval" | "immediate";
  voting?: { enabled: boolean; statuses: SuggestionStatus[] };
  reasonRequiredStatuses?: ("accepted" | "rejected")[];
  retentionMs?: number | null;
  maxActiveCases?: number;
  maxActiveCasesPerAuthor?: number;
  maxMessagesPerCase?: number;
  maxActionsPerMinute?: number;
  maxVotesPerMinute?: number;
}
export type CaseAudience = "author" | "staff" | "public";
export interface CaseAudienceScope {
  guildId: string;
  caseId: string;
  ownerId: string;
  visibility: "private" | "public";
  audience: CaseAudience;
  generation: number;
}
export interface ConfirmedCaseTarget extends CaseAudienceScope {
  confirmed: true;
  channelId: string;
}
export interface PreparedCaseNotification {
  caseId: string;
  eventId: string;
  channelId: string;
  content: string;
  roleIds: [];
  mentionEveryone: false;
  audience: CaseAudience;
}
export type CaseErrorCode =
  | "invalid_input"
  | "not_found"
  | "revision_conflict"
  | "state_conflict"
  | "permission_revoked"
  | "limit_exceeded"
  | "voting_closed"
  | "approval_required"
  | "stale_generation"
  | "expired"
  | "acl_unconfirmed";
export class CaseError extends Error {
  constructor(
    readonly code: CaseErrorCode,
    message = code as string,
  ) {
    super(message);
    this.name = "CaseError";
  }
}
