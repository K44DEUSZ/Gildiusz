import type {
  ActivityAdministratorFacts,
  ActivityChannelFacts,
  ActivityMemberFacts,
  ActivityState,
  ActivityVoiceSnapshot,
} from "./types.js";

/** Future trusted adapters supply minimal facts, never raw SDK events or user-provided point claims. */
export interface ActivityFactsPort {
  administrator(guildId: string, userId: string): Promise<ActivityAdministratorFacts>;
  member(guildId: string, userId: string): Promise<ActivityMemberFacts>;
  channel(guildId: string, channelId: string, userId: string): Promise<ActivityChannelFacts>;
  voice(guildId: string, observationEpoch: string): Promise<ActivityVoiceSnapshot>;
}
/** Not implemented until retention/erasure/restore are decided. No default memory or DB collector. */
export interface ActivityStatePort {
  read(guildId: string): Promise<ActivityState>;
  /** Synchronous transaction: compare revision, re-evaluate current limits, save atomically. */
  transact<T>(
    guildId: string,
    transition: (current: ActivityState) => { state: ActivityState; result: T },
  ): T;
}
