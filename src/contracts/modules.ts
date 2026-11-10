import type { Job, PublicJob, PublicDelivery } from "./jobs.js";
import type { Capabilities } from "./protocol.js";
import type { GuildResources } from "./configuration.js";

export const newModules = ["meetings", "cases", "announcements", "integrations", "music"] as const;
export type NewModule = (typeof newModules)[number];
export interface CaseSettings {
  categoryId: string;
  suggestionChannelId: string;
  suggestionVisibility: "approval" | "immediate";
  voting: { enabled: boolean; statuses: ("new" | "in_review")[] };
  reasonRequiredStatuses: ("accepted" | "rejected")[];
  retentionMs: number | null;
}
export interface ModuleSettings {
  revision: number;
  timeZone: string;
  organizerRoleIds: string[];
  caseModeratorRoleIds: string[];
  announcementManagerRoleIds: string[];
  djRoleIds: string[];
  allowMemberMusic: boolean;
  enabled: Record<NewModule, boolean>;
  cases?: CaseSettings;
}

export interface OnceSchedule {
  kind: "once";
  at: number;
}
export interface InputNow {
  kind: "now";
}

export interface RecurringSchedule {
  kind: "daily" | "weekly";
  time: string;
  timeZone: string;
  startDate: string;
  endDate?: string;
  maxOccurrences?: number;
  weekdays?: number[];
}

export type AnnouncementSchedule = OnceSchedule | RecurringSchedule;
export type ScheduleInput =
  | InputNow
  | OnceSchedule
  | (Omit<RecurringSchedule, "timeZone" | "startDate"> & {
      timeZone?: string;
      startDate?: string;
    });

export interface AnnouncementCard {
  title: string;
  description: string;
  color: number;
  imageAssetId?: string;
}
export interface AnnouncementLink {
  label: string;
  url: string;
}
export interface AnnouncementAsset {
  id: string;
  guildId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  width: number;
  height: number;
  createdAt: number;
  expiresAt: number | null;
}
export interface AnnouncementDraft {
  channelId: string;
  content: string;
  card?: AnnouncementCard;
  links?: AnnouncementLink[];
  saveAsDraft?: boolean;
  roleIds?: string[];
  mentionEveryone?: boolean;
  schedule: ScheduleInput;
}

export type AnnouncementStatus =
  "draft" | "scheduled" | "paused" | "cancelled" | "completed" | "expired" | "blocked";

export interface Announcement {
  id: string;
  guildId: string;
  actorId: string;
  channelId: string;
  content: string;
  card: AnnouncementCard | null;
  links: AnnouncementLink[];
  roleIds: string[];
  mentionEveryone: boolean;
  schedule: AnnouncementSchedule;
  status: AnnouncementStatus;
  revision: number;
  generation: number;
  nextDueAt: number | null;
  activeJobId: string | null;
  publishedCount: number;
  lastMessageId: string | null;
  lastPublishedAt: number | null;
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AnnouncementMutation {
  announcement: Announcement;
  job: Job | null;
}
export type AnnouncementMessage = Pick<
  Announcement,
  "channelId" | "content" | "card" | "links" | "roleIds" | "mentionEveryone"
>;

export interface ScheduledOccurrence {
  at: number;
  localDate: string;
  localTime: string;
  timeZone: string;
  offset: string;
  adjusted: boolean;
}

export interface RuntimeCapabilities extends Capabilities {
  announcementEditor?: { cards: boolean; links: boolean; drafts: boolean };
  announcementAssets?: {
    available: boolean;
    maxBytes: number;
    maxWidth: number;
    maxHeight: number;
    mediaTypes: AnnouncementAsset["mediaType"][];
  };
  resources: GuildResources;
  permissions: string[];
  mentionPermissions: { roleIds: string[]; everyone: boolean };
  moduleSettings?: ModuleSettings;
}
export interface AnnouncementDetail {
  announcement: Announcement;
  jobs: PublicJob[];
  deliveries: PublicDelivery[];
}
