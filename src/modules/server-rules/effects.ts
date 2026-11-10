import { RateLimitError } from "discord.js";
import type { ExecutionOutcome } from "../../core/jobs/runner.js";

/** Only Discord's explicit 429/pre-request SDK rejection proves this attempt was not applied. */
export function rulesRateLimit(error: unknown, now: number): ExecutionOutcome | null {
  let delay: number;
  if (error instanceof RateLimitError) {
    delay =
      Math.max(
        0,
        ...[error.retryAfter, error.timeToReset, error.sublimitTimeout].filter(
          (value) => Number.isFinite(value) && value > 0,
        ),
      ) || 5000;
  } else {
    const value = error as { status?: number; rawError?: { retry_after?: number } };
    if (value?.status !== 429) return null;
    delay =
      Number.isFinite(value.rawError?.retry_after) && Number(value.rawError?.retry_after) > 0
        ? Number(value.rawError?.retry_after) * 1000
        : 5000;
  }
  return {
    state: "retry",
    at: now + Math.ceil(Math.min(86400000, delay)),
    error: "discord_rate_limit",
    rateLimited: true,
  };
}
