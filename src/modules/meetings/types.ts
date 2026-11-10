import type {
  Meeting,
  MeetingDraft,
  MeetingDetail,
  MeetingRoom,
} from "../../contracts/community.js";
export type {
  MeetingState,
  ParticipantState,
  MeetingRoom,
  MeetingDraft,
  Meeting,
  MeetingParticipant,
  MeetingDetail,
  MeetingMutation,
  MeetingAudience,
} from "../../contracts/community.js";
export type MeetingOperation =
  | "create"
  | "list"
  | "read"
  | "update"
  | "join"
  | "leave"
  | "start"
  | "complete"
  | "cancel"
  | "deliver";
export interface MeetingAuthorization {
  guildId: string;
  actorId: string;
  operation: MeetingOperation;
  meeting?: Meeting;
  participantIds?: readonly string[];
  draft?: MeetingDraft;
  jobType?: MeetingJobType;
}
export interface MeetingOptions {
  guildId: string;
  clock?: () => number;
  maxMeetings?: number;
  authorize(request: MeetingAuthorization): void | false | Promise<void | false>;
  // False means a conclusive membership/access denial; lookup failures must throw.
  eligible(userId: string, meeting: Meeting): boolean | Promise<boolean>;
}
export type MeetingJobType =
  "meeting.publish" | "meeting.reminder" | "meeting.promoted" | "meeting.start" | "meeting.finish";
export interface PreparedMeetingJob extends MeetingDetail {
  type: MeetingJobType;
  recipientId: string | null;
  room: MeetingRoom;
  cleanupRoom: { channelId: string; createdByBot: true; requireNoHumans: true } | null;
}
export interface MeetingEffectResult {
  messageId?: string;
  roomChannelId?: string;
  roomCreatedByBot?: boolean;
  guildScheduledEventId?: string;
}
export type MeetingErrorCode =
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "revision_conflict"
  | "state_conflict"
  | "capacity_conflict"
  | "visibility_conflict"
  | "limit_exceeded"
  | "stale_generation"
  | "expired"
  | "stale_job"
  | "guild_conflict";
export class MeetingError extends Error {
  constructor(
    readonly code: MeetingErrorCode,
    message = code as string,
  ) {
    super(message);
    this.name = "MeetingError";
  }
}
