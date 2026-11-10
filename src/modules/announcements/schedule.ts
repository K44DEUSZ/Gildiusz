import { Temporal } from "@js-temporal/polyfill";
import {
  AnnouncementError,
  type AnnouncementSchedule,
  type ScheduleInput,
  type ScheduledOccurrence,
} from "./types.js";

function timestamp(input: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(input) || Number(input) < minimum)
    throw new AnnouncementError("invalid_input");
  Temporal.Instant.fromEpochMilliseconds(input as number);
  return input as number;
}

function date(input: unknown): Temporal.PlainDate {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input) || input < "1970-01-01")
    throw new AnnouncementError("invalid_input");
  return Temporal.PlainDate.from(input, { overflow: "reject" });
}

export function normalizeSchedule(input: ScheduleInput, now: number): AnnouncementSchedule {
  try {
    if (!input || typeof input !== "object") throw new AnnouncementError("invalid_input");
    const fields =
      input.kind === "now"
        ? ["kind"]
        : input.kind === "once"
          ? ["kind", "at"]
          : ["kind", "time", "timeZone", "startDate", "endDate", "maxOccurrences", "weekdays"];
    if (Object.keys(input).some((field) => !fields.includes(field)))
      throw new AnnouncementError("invalid_input");
    if (input.kind === "now") return { kind: "once", at: timestamp(now) };
    if (input.kind === "once") return { kind: "once", at: timestamp(input.at) };
    if (input.kind !== "daily" && input.kind !== "weekly")
      throw new AnnouncementError("invalid_input");
    if (typeof input.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))
      throw new AnnouncementError("invalid_input");
    const timeZone = input.timeZone ?? "Europe/Warsaw";
    if (typeof timeZone !== "string" || !timeZone.length || /^[+-]/.test(timeZone))
      throw new AnnouncementError("invalid_input");
    const zone = Temporal.Instant.fromEpochMilliseconds(timestamp(now)).toZonedDateTimeISO(
      timeZone,
    );
    const startDate = date(input.startDate ?? zone.toPlainDate().toString()).toString();
    const endDate = input.endDate === undefined ? undefined : date(input.endDate).toString();
    if (endDate && endDate < startDate) throw new AnnouncementError("invalid_input");
    if (
      input.maxOccurrences !== undefined &&
      (!Number.isSafeInteger(input.maxOccurrences) ||
        input.maxOccurrences < 1 ||
        input.maxOccurrences > 10000)
    )
      throw new AnnouncementError("invalid_input");
    let weekdays: number[] | undefined;
    if (input.kind === "weekly") {
      if (
        !Array.isArray(input.weekdays) ||
        !input.weekdays.length ||
        input.weekdays.length > 7 ||
        input.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
        new Set(input.weekdays).size !== input.weekdays.length
      )
        throw new AnnouncementError("invalid_input");
      weekdays = [...input.weekdays].sort((a, b) => a - b);
    } else if (input.weekdays !== undefined) throw new AnnouncementError("invalid_input");
    return {
      kind: input.kind,
      time: input.time,
      timeZone: zone.timeZoneId,
      startDate,
      ...(endDate ? { endDate } : {}),
      ...(input.maxOccurrences !== undefined ? { maxOccurrences: input.maxOccurrences } : {}),
      ...(weekdays ? { weekdays } : {}),
    };
  } catch (error) {
    if (error instanceof AnnouncementError) throw error;
    throw new AnnouncementError("invalid_input");
  }
}

function localOccurrence(
  day: Temporal.PlainDate,
  time: string,
  timeZone: string,
): ScheduledOccurrence {
  const requested = day.toPlainDateTime(Temporal.PlainTime.from(time));
  const earlier = requested.toZonedDateTime(timeZone, { disambiguation: "earlier" });
  let selected = earlier;
  let adjusted = false;
  if (!earlier.toPlainDateTime().equals(requested)) {
    const later = requested.toZonedDateTime(timeZone, { disambiguation: "later" });
    // The chosen policy is the end of a gap, not the same minute in the shifted hour.
    const boundary = earlier.getTimeZoneTransition("next");
    if (
      !boundary ||
      boundary.epochMilliseconds <= earlier.epochMilliseconds ||
      boundary.epochMilliseconds > later.epochMilliseconds ||
      Temporal.PlainDateTime.compare(boundary.toPlainDateTime(), requested) <= 0
    )
      throw new AnnouncementError("invalid_input");
    selected = boundary;
    adjusted = true;
  }
  return {
    at: selected.epochMilliseconds,
    localDate: day.toString(),
    localTime: selected.toPlainDateTime().toString({ smallestUnit: "minute" }),
    timeZone,
    offset: selected.offset,
    adjusted,
  };
}

export function resolveLocalDateTime(
  localDate: string,
  time: string,
  timeZone: string,
): ScheduledOccurrence {
  const normalized = normalizeSchedule({ kind: "daily", time, timeZone, startDate: localDate }, 0);
  if (normalized.kind === "once") throw new AnnouncementError("invalid_input");
  return localOccurrence(date(localDate), normalized.time, normalized.timeZone);
}

export function nextOccurrences(
  schedule: AnnouncementSchedule,
  after: number,
  count = 5,
): ScheduledOccurrence[] {
  try {
    timestamp(after, -1);
    if (!Number.isInteger(count) || count < 1 || count > 20)
      throw new AnnouncementError("invalid_input");
    if (schedule.kind === "once") {
      if (schedule.at <= after) return [];
      const utc = Temporal.Instant.fromEpochMilliseconds(schedule.at).toZonedDateTimeISO("UTC");
      return [
        {
          at: schedule.at,
          localDate: utc.toPlainDate().toString(),
          localTime: utc.toPlainDateTime().toString({ smallestUnit: "minute" }),
          timeZone: "UTC",
          offset: utc.offset,
          adjusted: false,
        },
      ];
    }
    const limit = Math.min(count, schedule.maxOccurrences ?? count);
    const local = Temporal.Instant.fromEpochMilliseconds(Math.max(0, after)).toZonedDateTimeISO(
      schedule.timeZone,
    );
    const start = date(schedule.startDate);
    let cursor = local.toPlainDate().subtract({ days: 1 });
    if (Temporal.PlainDate.compare(cursor, start) < 0) cursor = start;
    const end = schedule.endDate === undefined ? null : date(schedule.endDate);
    const result: ScheduledOccurrence[] = [];
    let previousAt: number | undefined;
    // At most twenty weekly dates plus a boundary day; no walk from an old series origin.
    for (
      let scanned = 0;
      scanned < 160 && result.length < limit;
      scanned++, cursor = cursor.add({ days: 1 })
    ) {
      if (end && Temporal.PlainDate.compare(cursor, end) > 0) break;
      if (schedule.kind === "weekly" && !schedule.weekdays!.includes(cursor.dayOfWeek)) continue;
      const occurrence = localOccurrence(cursor, schedule.time, schedule.timeZone);
      if (occurrence.at <= after || occurrence.at === previousAt) continue;
      result.push(occurrence);
      previousAt = occurrence.at;
    }
    return result;
  } catch (error) {
    if (error instanceof AnnouncementError) throw error;
    throw new AnnouncementError("invalid_input");
  }
}
