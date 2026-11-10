import { JobError, type JobLease } from "./types.js";
import type { JobStore } from "./store.js";

export interface JobSource {
  guildId: string;
  store: JobStore;
  available(): boolean;
}
export type ExecutionOutcome =
  | { state: "succeeded"; messageId?: string; result?: unknown }
  | { state: "retry"; at: number; error: string; rateLimited?: boolean }
  | { state: "failed"; error: string }
  | { state: "unknown"; error: string }
  | { state: "expired"; reason: string };

export interface ExecutionContext {
  signal: AbortSignal;
  now(): number;
  checkpoint(): void;
  beginAttempt(input?: { nonce?: string; channelId?: string }): void;
}
export interface RunnerOptions {
  clock?: () => number;
  random?: () => number;
  concurrency?: number;
  batchSize?: number;
  leaseMs?: number;
  intervalMs?: number;
  executionTimeoutMs?: number;
  stopTimeoutMs?: number;
  onError?: (code: string, jobId: string) => void;
}

function failureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(code)) return code;
  }
  return error instanceof Error && /^[a-zA-Z]{1,64}$/.test(error.name)
    ? error.name
    : "execution_failed";
}
function abortReason(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
function bounded(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number)) throw new RangeError("Invalid job runner settings.");
  return Math.min(maximum, Math.max(minimum, number));
}

export class JobRunner {
  private readonly active = new Set<Promise<void>>();
  private readonly guilds = new Set<string>();
  private readonly quarantined = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly suspended = new Set<string>();
  private readonly guildWork = new Map<string, Promise<void>>();
  private readonly guildExecutions = new Map<string, Set<Promise<ExecutionOutcome>>>();
  private readonly guildControllers = new Map<string, Set<AbortController>>();
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly executionTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private cursor = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly sources: () => JobSource[],
    private readonly execute: (
      job: JobLease,
      context: ExecutionContext,
    ) => Promise<ExecutionOutcome>,
    private readonly options: RunnerOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
    this.concurrency = bounded(options.concurrency, 2, 1, 8);
    this.batchSize = bounded(options.batchSize, 10, 1, 10);
    this.leaseMs = bounded(options.leaseMs, 30000, 1000, 86400000);
    this.executionTimeoutMs = bounded(options.executionTimeoutMs, 45000, 1, 300000);
    this.stopTimeoutMs = bounded(options.stopTimeoutMs, 5000, 1, 60000);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(
      () => {
        void this.tick().catch((error) => this.options.onError?.(failureCode(error), "runner"));
      },
      bounded(this.options.intervalMs, 5000, 1, 3600000),
    );
    this.timer.unref();
  }

  async tick(): Promise<number> {
    if (this.stopped) return 0;
    const sources = this.sources();
    const selected: Promise<void>[] = [];
    let claimed = 0;
    // One active task per guild; the next scan starts with the next guild.
    const start = this.cursor;
    for (let index = 0; index < sources.length; index++) {
      if (this.stopped || this.active.size >= this.concurrency || claimed >= this.batchSize) break;
      const source = sources[(start + index) % sources.length];
      this.cursor = (start + index + 1) % sources.length;
      if (
        !source.available() ||
        this.suspended.has(source.guildId) ||
        this.guilds.has(source.guildId) ||
        this.quarantined.has(source.guildId)
      )
        continue;
      source.store.recover();
      const [job] = source.store.claim({
        guildId: source.guildId,
        limit: 1,
        leaseMs: this.leaseMs,
      });
      if (!job) continue;
      claimed++;
      this.guilds.add(source.guildId);
      const work = this.run(source, job).finally(() => {
        this.active.delete(work);
        this.guilds.delete(source.guildId);
        this.guildWork.delete(source.guildId);
      });
      this.active.add(work);
      this.guildWork.set(source.guildId, work);
      selected.push(work);
    }
    await Promise.all(selected);
    return claimed;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort(abortReason("runner_stopped"));
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, this.stopTimeoutMs);
      void Promise.allSettled(this.active).then(() => {
        clearTimeout(deadline);
        resolve();
      });
    });
  }

  /** Keep this guild fenced until every handler has actually stopped using its database. */
  async suspendGuild(guildId: string): Promise<boolean> {
    this.suspended.add(guildId);
    for (const controller of this.guildControllers.get(guildId) ?? [])
      controller.abort(abortReason("guild_suspended"));
    const work = this.guildWork.get(guildId);
    const pending = [...(this.guildExecutions.get(guildId) ?? []), ...(work ? [work] : [])];
    if (!pending.length) return true;
    return new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), this.stopTimeoutMs);
      void Promise.allSettled(pending).then(() => {
        clearTimeout(deadline);
        resolve(true);
      });
    });
  }

  resumeGuild(guildId: string): void {
    this.suspended.delete(guildId);
  }

  private async run(source: JobSource, job: JobLease): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let controllers = this.guildControllers.get(source.guildId);
    if (!controllers) this.guildControllers.set(source.guildId, (controllers = new Set()));
    controllers.add(controller);
    let deliveryStarted = false,
      closed = false,
      settled = true;
    let received: ExecutionOutcome | undefined;
    const saveLateReceipt = (outcome: ExecutionOutcome | undefined) => {
      if (!deliveryStarted || outcome?.state !== "succeeded" || !outcome.messageId) return;
      try {
        source.store.recordReceipt(job.id, job.leaseToken, { messageId: outcome.messageId });
      } catch (error) {
        this.options.onError?.(failureCode(error), job.id);
      }
    };
    const checkpoint = () => {
      if (closed) throw abortReason("execution_closed");
      if (this.stopped) throw abortReason("runner_stopped");
      if (this.suspended.has(source.guildId)) throw abortReason("guild_suspended");
      controller.signal.throwIfAborted();
      const current = source.store.get(job.id);
      if (
        !source.available() ||
        current?.state !== "running" ||
        current.leaseToken !== job.leaseToken ||
        current.leaseUntil === null ||
        current.leaseUntil <= this.clock() ||
        current.cancelRequested
      )
        throw new JobError("stale_lease");
    };
    const renewal = setInterval(
      () => {
        if (closed || controller.signal.aborted) return;
        try {
          source.store.renew(job.id, job.leaseToken, this.leaseMs);
        } catch {
          controller.abort(abortReason("stale_lease"));
        }
      },
      Math.max(250, Math.floor(this.leaseMs / 3)),
    );
    renewal.unref();
    const deadline = setTimeout(
      () => controller.abort(abortReason("execution_timeout")),
      this.executionTimeoutMs,
    );
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      checkpoint();
      const execution = this.execute(job, {
        signal: controller.signal,
        now: this.clock,
        checkpoint,
        beginAttempt: (input) => {
          checkpoint();
          source.store.beginAttempt(job.id, job.leaseToken, input);
          deliveryStarted = true;
        },
      });
      settled = false;
      const observed = Promise.resolve(execution).then(
        (outcome) => {
          settled = true;
          received = outcome;
          this.quarantined.delete(source.guildId);
          if (closed) saveLateReceipt(outcome);
          return outcome;
        },
        (error: unknown) => {
          settled = true;
          this.quarantined.delete(source.guildId);
          throw error;
        },
      );
      let executions = this.guildExecutions.get(source.guildId);
      if (!executions) this.guildExecutions.set(source.guildId, (executions = new Set()));
      const pendingExecutions = executions;
      pendingExecutions.add(observed);
      const releaseExecution = () => {
        pendingExecutions.delete(observed);
        if (!pendingExecutions.size) this.guildExecutions.delete(source.guildId);
      };
      void observed.then(releaseExecution, releaseExecution);
      const outcome = await Promise.race([observed, aborted]);
      closed = true;
      if (outcome.state === "succeeded") source.store.complete(job.id, job.leaseToken, outcome);
      else if (outcome.state === "retry") source.store.retry(job.id, job.leaseToken, outcome);
      else if (outcome.state === "failed") source.store.fail(job.id, job.leaseToken, outcome.error);
      else if (outcome.state === "unknown")
        source.store.unknown(job.id, job.leaseToken, outcome.error);
      else source.store.expire(job.id, job.leaseToken, outcome.reason);
    } catch (error) {
      closed = true;
      saveLateReceipt(received);
      const code = failureCode(error);
      try {
        if (deliveryStarted) source.store.unknown(job.id, job.leaseToken, code);
        else
          source.store.retry(job.id, job.leaseToken, {
            at:
              this.clock() +
              Math.min(900000, 5000 * 2 ** Math.min(8, job.failures)) +
              Math.floor(this.random() * 1000),
            error: code,
          });
      } catch (commitError) {
        // A fenced worker must not overwrite a newer owner's result.
        if (!(commitError instanceof JobError && commitError.code === "stale_lease"))
          this.options.onError?.(failureCode(commitError), job.id);
      }
      this.options.onError?.(code, job.id);
    } finally {
      closed = true;
      if (!settled) this.quarantined.add(source.guildId);
      clearTimeout(deadline);
      clearInterval(renewal);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort(abortReason("execution_closed"));
      this.controllers.delete(controller);
      controllers.delete(controller);
      if (!controllers.size) this.guildControllers.delete(source.guildId);
    }
  }
}
