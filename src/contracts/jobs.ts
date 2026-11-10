export type JobState =
  "pending" | "running" | "succeeded" | "retry" | "failed" | "cancelled" | "expired" | "unknown";

export interface JobInput {
  id?: string;
  guildId: string;
  type: string;
  payload: unknown;
  dueAt: number;
  expiresAt?: number;
  dedupeKey: string;
  objectId?: string;
  generation?: number;
  maxAttempts?: number;
}

export interface Job {
  id: string;
  guildId: string;
  type: string;
  payload: unknown;
  state: JobState;
  dueAt: number;
  nextAttemptAt: number;
  expiresAt: number | null;
  dedupeKey: string;
  objectId: string | null;
  generation: number;
  attempts: number;
  failures: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  revision: number;
  cancelRequested: boolean;
  messageId: string | null;
  lastError: string | null;
  result: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface JobLease extends Job {
  leaseToken: string;
  leaseUntil: number;
}

export type AttemptState =
  | "sending"
  | "succeeded"
  | "retry"
  | "rate_limited"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

export interface DeliveryAttempt {
  id: string;
  jobId: string;
  number: number;
  leaseToken: string;
  state: AttemptState;
  nonce: string | null;
  channelId: string | null;
  messageId: string | null;
  error: string | null;
  result: unknown;
  startedAt: number;
  finishedAt: number | null;
}

export interface JobFilter {
  guildId?: string;
  states?: JobState[];
  type?: string;
  objectId?: string;
  limit?: number;
}

export interface ClaimOptions {
  limit?: number;
  leaseMs?: number;
  guildId?: string;
  types?: string[];
}

export interface JobResult {
  messageId?: string;
  result?: unknown;
}

export type Reconciliation =
  | ({ outcome: "succeeded" } & JobResult)
  | { outcome: "retry"; notDelivered: true; at: number }
  | { outcome: "failed"; error: string };

export type JobErrorCode =
  | "invalid_input"
  | "guild_conflict"
  | "dedupe_conflict"
  | "job_not_found"
  | "stale_lease"
  | "state_conflict"
  | "idempotency_conflict"
  | "revision_conflict";

export type PublicJob = Omit<Job, "payload" | "result" | "leaseToken">;
export type PublicDelivery = Omit<DeliveryAttempt, "result" | "leaseToken" | "nonce">;
