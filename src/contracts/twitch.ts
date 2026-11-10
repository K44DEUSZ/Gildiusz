import type { PublicDelivery, PublicJob } from "./jobs.js";

export interface TwitchBindingInput {
  broadcasterId: string;
  channelId: string;
  template: string;
  roleIds: string[];
  mentionEveryone: boolean;
  enabled: boolean;
}
export interface TwitchBinding extends TwitchBindingInput {
  id: string;
  guildId: string;
  actorId: string;
  revision: number;
  generation: number;
  removed: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface TwitchSourceView {
  broadcasterId: string;
  status: "pending" | "enabled" | "revoked";
  reason: string | null;
  lastEventAt: number | null;
}
export interface TwitchIntegrationDetail {
  integration: TwitchBinding;
  source: TwitchSourceView | null;
  jobs: PublicJob[];
  deliveries: PublicDelivery[];
}
export interface TwitchBroadcaster {
  id: string;
  login: string;
  displayName: string;
}
