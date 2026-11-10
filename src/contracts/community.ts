import type { Job } from "./jobs.js";
export type MeetingState = "draft" | "open" | "starting" | "active" | "completed" | "cancelled";
export type ParticipantState = "confirmed" | "waitlisted" | "left";
export type MeetingRoom =
  | { kind: "none" }
  | { kind: "existing"; channelId: string }
  | { kind: "create"; categoryId: string };

export interface MeetingDraft {
  title: string;
  description: string;
  capacity: number;
  startsAt: number;
  endsAt: number;
  channelId: string;
  visibility: "public" | "private";
  allowedRoleIds?: string[];
  invitedUserIds?: string[];
  organizerParticipates?: boolean;
  room?: MeetingRoom;
  reminderMinutes?: number[];
  state?: "draft" | "open";
}
export interface Meeting {
  id: string;
  guildId: string;
  creatorId: string;
  organizerId: string;
  title: string;
  description: string;
  capacity: number;
  startsAt: number;
  endsAt: number;
  channelId: string;
  visibility: "public" | "private";
  allowedRoleIds: string[];
  invitedUserIds: string[];
  organizerParticipates: boolean;
  room: MeetingRoom;
  reminderMinutes: number[];
  state: MeetingState;
  revision: number;
  generation: number;
  participantVersion: number;
  confirmedCount: number;
  waitlistedCount: number;
  full: boolean;
  messageId: string | null;
  roomChannelId: string | null;
  roomCreatedByBot: boolean;
  guildScheduledEventId: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface MeetingParticipant {
  meetingId: string;
  userId: string;
  state: ParticipantState;
  sequence: number;
  joinedAt: number;
  updatedAt: number;
  leftReason: "left" | "member_removed" | "ineligible" | "organizer_opt_out" | null;
}
export interface MeetingDetail {
  meeting: Meeting;
  participants: MeetingParticipant[];
}
export interface MeetingAudience {
  invitedUserIds: string[];
  allowedRoleIds: string[];
}
export interface MeetingMutation extends MeetingDetail {
  jobs: Job[];
}
export type CaseKind = "report" | "question" | "suggestion";
export type SupportStatus = "new" | "in_progress" | "waiting_author" | "resolved" | "closed";
export type SuggestionStatus = "new" | "in_review" | "accepted" | "rejected" | "implemented";
export type CaseStatus = SupportStatus | SuggestionStatus;
export interface CaseDraft {
  kind: CaseKind;
  title: string;
  content: string;
}
export interface CaseRecord {
  id: string;
  guildId: string;
  ownerId: string;
  kind: CaseKind;
  visibility: "private" | "public";
  title: string;
  content: string;
  status: CaseStatus;
  assigneeId: string | null;
  revision: number;
  generation: number;
  votesRevision: number;
  approvedBy: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  retentionAt: number | null;
}
export type CaseSummary = Omit<CaseRecord, "content">;
export interface CaseMessage {
  id: string;
  authorId: string;
  content: string;
  visibility: "private" | "public";
  createdAt: number;
}
export interface CaseVotes {
  positive: number;
  negative: number;
  score: number;
  total: number;
  revision: number;
}
export interface CaseView {
  case: CaseRecord;
  messages: CaseMessage[];
  votes: CaseVotes;
  ownVote: 1 | -1 | null;
}
export interface CaseMutation {
  case: CaseRecord;
  job: Job | null;
}
export interface CaseListFilter {
  kind?: CaseKind;
  status?: CaseStatus;
  mine?: boolean;
}
export interface CaseTransition {
  status: CaseStatus;
  reason?: string;
}
