import type { Announcement } from "../../contracts/modules.js";
export type {
  InputNow,
  OnceSchedule,
  RecurringSchedule,
  AnnouncementSchedule,
  ScheduleInput,
  AnnouncementDraft,
  AnnouncementCard,
  AnnouncementLink,
  AnnouncementMessage,
  AnnouncementStatus,
  Announcement,
  AnnouncementMutation,
  ScheduledOccurrence,
} from "../../contracts/modules.js";

export type AnnouncementOperation =
  | "create"
  | "read"
  | "list"
  | "update"
  | "pause"
  | "resume"
  | "cancel"
  | "remove"
  | "test"
  | "preview"
  | "deliver";

export interface AnnouncementAuthorization {
  guildId: string;
  actorId: string;
  operation: AnnouncementOperation;
  channelId?: string;
  roleIds?: string[];
  mentionEveryone?: boolean;
  hasCard?: boolean;
  hasImage?: boolean;
}

export interface AnnouncementOptions {
  guildId: string;
  clock?: () => number;
  authorize(request: AnnouncementAuthorization): void | Promise<void>;
  maxAnnouncements?: number;
  maxWritesPerMinute?: number;
  maxTestsPerMinute?: number;
  validateAsset?(assetId: string): void | Promise<void>;
  onSaved?(announcement: Announcement): void;
}

export interface PreparedAnnouncement {
  announcement: Announcement;
  channelId: string;
  content: string;
  card: Announcement["card"];
  links: Announcement["links"];
  roleIds: string[];
  mentionEveryone: boolean;
  test: boolean;
}

export type AnnouncementErrorCode =
  | "invalid_input"
  | "not_found"
  | "revision_conflict"
  | "state_conflict"
  | "limit_exceeded"
  | "schedule_exhausted"
  | "stale_generation"
  | "paused"
  | "cancelled"
  | "permission_revoked"
  | "channel_unavailable"
  | "asset_unavailable"
  | "expired";

export class AnnouncementError extends Error {
  constructor(
    readonly code: AnnouncementErrorCode,
    message = code as string,
  ) {
    super(message);
    this.name = "AnnouncementError";
  }
}
