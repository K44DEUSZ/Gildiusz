import { createHash } from "node:crypto";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function warsawTime(value: string): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(value));
}

export function requireId(value: string | undefined, label: string): string {
  if (!value || !/^\d{17,20}$/.test(value)) throw new Error(`Invalid Discord ID: ${label}`);
  return value;
}

export function safeName(value: string, limit = 80): string {
  return (
    value
      .normalize("NFKC")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/[@#`<>\\/]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit) || "Projekt"
  );
}

export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  if (error && typeof error === "object" && "status" in error) return String(error.status);
  return error instanceof Error ? error.name : "UnknownError";
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async drain(): Promise<void> {
    await this.tail;
  }
}

export class Pool {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    private maximum: number,
    private queueLimit: number,
  ) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) {
      if (this.waiters.length >= this.queueLimit) throw new Error("AttachmentQueueFull");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export const noMentions = { parse: [] as never[], repliedUser: false };
