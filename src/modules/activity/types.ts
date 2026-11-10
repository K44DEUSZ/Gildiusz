export type ActivityVisibility = "administrators" | "members";
export interface ActivityRank {
  id: string;
  name: string;
  thresholdPoints: number;
}
/** Every value is explicit. This interface does not prescribe product defaults. */
export interface ActivityPolicy {
  messageWeight: number;
  voiceWeight: number;
  messageCooldownMs: number;
  maxMessagesPerDay: number;
  maxVoiceMsPerDay: number;
  messageDelayMs: number;
  factMaxAgeMs: number;
  maxVoiceGapMs: number;
  clockSkewMs: number;
  minVoiceHumans: number;
  selfMuteCounts: boolean;
  textChannelIds: string[];
  threadParentIds: string[];
  voiceChannelIds: string[];
  excludedChannelIds: string[];
  excludedMemberIds: string[];
  timeZone: string;
  ranks: ActivityRank[];
}
export interface ActivityMemberFacts {
  guildId: string;
  userId: string;
  joinedAt: number;
  observedAt: number;
  present: boolean | null;
  bot: boolean | null;
  pending: boolean | null;
  timedOut: boolean | null;
  excluded: boolean | null;
}
export interface ActivityAdministratorFacts extends ActivityMemberFacts {
  owner: boolean;
  manageGuild: boolean;
}
export interface ActivityChannelFacts {
  guildId: string;
  channelId: string;
  observedAt: number;
  kind: "text" | "thread" | "voice" | "stage" | "other";
  parentIds: string[];
  ancestryComplete: boolean;
  viewable: boolean | null;
  connectable: boolean | null;
  excluded: boolean | null;
  technical: boolean | null;
  afk: boolean | null;
}
export interface ActivityTotal {
  userId: string;
  joinedAt: number;
  pointsUnits: number;
  messageCount: number;
  voiceMs: number;
  revision: number;
  lastActivityAt: number;
}
export interface ActivityDay {
  messageCount: number;
  voiceMs: number;
}
export interface ActivityVoiceAnchor {
  sequence: number;
  wallTime: number;
  monotonicMs: number;
  members: Record<string, { joinedAt: number; channelId: string }>;
}
/** An input/output value for pure transitions, not a database or a live collector. */
export interface ActivityState {
  guildId: string;
  revision: number;
  settingsRevision: number;
  generation: number;
  enabled: boolean;
  visibility: ActivityVisibility;
  policy: ActivityPolicy | null;
  period: { id: string; startedAt: number; timeZone: string } | null;
  enabledAt: number | null;
  observationEpoch: string | null;
  observationStartedAt: number | null;
  /** Kept even when an uncertain snapshot clears the nullable qualification anchor. */
  voiceHighWatermark: { epoch: string; sequence: number } | null;
  voice: ActivityVoiceAnchor | null;
  totals: Record<string, ActivityTotal>;
  daily: Record<string, ActivityDay>;
  lastMessageAt: Record<string, number>;
  messageReceipts: Record<string, { createdAt: number; pointsUnits: number }>;
}
export interface ActivityMessage {
  guildId: string;
  messageId: string;
  userId: string;
  channelId: string;
  createdAt: number;
  settingsRevision: number;
  generation: number;
  observationEpoch: string;
  source: "create" | "edit" | "delete" | "history";
  webhook: boolean;
  system: boolean;
  filter: "allowed" | "blocked" | "unknown";
}
export interface ActivityVoiceParticipant {
  member: ActivityMemberFacts;
  channel: ActivityChannelFacts;
  selfMute: boolean | null;
  selfDeaf: boolean | null;
  serverDeaf: boolean | null;
}
export interface ActivityVoiceSnapshot {
  guildId: string;
  settingsRevision: number;
  generation: number;
  observationEpoch: string;
  sequence: number;
  wallTime: number;
  monotonicMs: number;
  connected: boolean | null;
  complete: boolean;
  /** True only when the trusted observer processed every relevant transition since its last sample. */
  continuous: boolean;
  participants: ActivityVoiceParticipant[];
}
export interface ActivityTransition {
  state: ActivityState;
  pointsUnits: number;
  reason: string;
}
export class ActivityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ActivityError";
  }
}
