export const maximumRecoveryArchiveAgeMs = 35 * 86400000;

export interface RecoveryArchiveAgeOptions {
  now?: number;
  maxArchiveAgeMs?: number;
}

/** The deadline is exclusive: a retired UUID fence can expire at the same instant. */
export function assertRecoveryArchiveAge(
  createdAt: number,
  options: RecoveryArchiveAgeOptions = {},
): number {
  const now = options.now ?? Date.now(),
    maximum = options.maxArchiveAgeMs ?? maximumRecoveryArchiveAgeMs;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > maximumRecoveryArchiveAgeMs
  )
    throw new Error("Invalid recovery archive age policy.");
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    createdAt > now ||
    now - createdAt >= maximum
  )
    throw new Error("Recovery archive is expired or dated in the future.");
  return now;
}
