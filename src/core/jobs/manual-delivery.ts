import { digest } from "../../shared/utils.js";
import type { DeliveryAttempt, ManualDeliveryResolution } from "./types.js";

const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const snowflake = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{17,20}$/.test(value);
const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Only this versioned metadata can mark an unknown job as manually handled. */
export function readManualDeliveryResolution(value: unknown): ManualDeliveryResolution | undefined {
  if (!object(value) || !object(value.manualDeliveryResolution)) return;
  const resolution = value.manualDeliveryResolution;
  if (
    Object.keys(resolution).some(
      (key) => !["format", "actorId", "decidedAt", "attemptIds", "decisions"].includes(key),
    ) ||
    resolution.format !== 1 ||
    !snowflake(resolution.actorId) ||
    !time(resolution.decidedAt) ||
    !Array.isArray(resolution.attemptIds) ||
    !resolution.attemptIds.length ||
    resolution.attemptIds.length > 100 ||
    !resolution.attemptIds.every(uuid) ||
    new Set(resolution.attemptIds).size !== resolution.attemptIds.length ||
    !Array.isArray(resolution.decisions) ||
    !resolution.decisions.length ||
    resolution.decisions.length > resolution.attemptIds.length
  )
    return;
  const seen = new Set<string>();
  for (const item of resolution.decisions) {
    if (
      !object(item) ||
      !uuid(item.attemptId) ||
      !resolution.attemptIds.includes(item.attemptId) ||
      seen.has(item.attemptId) ||
      Object.keys(item).some((key) => !["attemptId", "decision", "linkedMessage"].includes(key)) ||
      !["human_confirmed_message", "closed_unconfirmed"].includes(String(item.decision))
    )
      return;
    seen.add(item.attemptId);
    if (item.decision === "closed_unconfirmed") {
      if (item.linkedMessage !== undefined) return;
      continue;
    }
    const linked = item.linkedMessage;
    if (
      !object(linked) ||
      Object.keys(linked).sort().join(",") !==
        ["channelId", "messageId", "checkedAt", "fingerprint"].sort().join(",") ||
      !snowflake(linked.channelId) ||
      !snowflake(linked.messageId) ||
      !time(linked.checkedAt) ||
      Number(linked.checkedAt) > Number(resolution.decidedAt) ||
      typeof linked.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(linked.fingerprint)
    )
      return;
  }
  return resolution as unknown as ManualDeliveryResolution;
}

export function deliveryAttemptsFingerprint(attempts: readonly DeliveryAttempt[]): string {
  return digest(
    attempts.map(({ id, number, state, channelId, messageId, startedAt, finishedAt }) => ({
      id,
      number,
      state,
      channelId,
      messageId,
      startedAt,
      finishedAt,
    })),
  );
}

/** Human associations never replace a later genuine transport receipt. */
export function mergeManualDeliveryResult(previous: unknown, receipt: unknown): unknown {
  const manual = readManualDeliveryResolution(previous);
  return manual
    ? {
        ...(previous as Record<string, unknown>),
        manualDeliveryResolution: manual,
        receiptResult: receipt ?? null,
      }
    : receipt;
}

export function publicManualDeliveryResolution(
  value: unknown,
  attempts: readonly DeliveryAttempt[],
) {
  const manual = readManualDeliveryResolution(value);
  if (!manual) return;
  const recordedMessageIds = [
    ...new Set(
      attempts
        .filter((entry) => entry.state === "succeeded" && entry.messageId)
        .map((entry) => entry.messageId!),
    ),
  ];
  return {
    ...manual,
    recordedMessageIds,
    conflictingMessageIds: [
      ...new Set([
        ...attempts
          .filter(
            (entry) =>
              entry.messageId &&
              manual.decisions.some(
                (item) =>
                  item.attemptId === entry.id &&
                  item.linkedMessage &&
                  item.linkedMessage.messageId !== entry.messageId,
              ),
          )
          .map((entry) => entry.messageId!),
        ...([
          ...new Set([
            ...recordedMessageIds,
            ...manual.decisions.flatMap((item) =>
              item.linkedMessage ? [item.linkedMessage.messageId] : [],
            ),
          ]),
        ].length > 1
          ? [
              ...recordedMessageIds,
              ...manual.decisions.flatMap((item) =>
                item.linkedMessage ? [item.linkedMessage.messageId] : [],
              ),
            ]
          : []),
      ]),
    ],
  };
}
