import { monitorEventLoopDelay, performance, type ELDHistogram } from "node:perf_hooks";
import type { RunnerQueueObservation } from "../core/jobs/runner.js";

const intervalMs = 30000,
  resolutionMs = 20;
type LoopHistogram = Pick<
  ELDHistogram,
  "enable" | "disable" | "reset" | "count" | "mean" | "max" | "percentile"
>;
interface ObservationSources {
  clock(): number;
  monotonicClock(): number;
  memoryUsage(): Pick<NodeJS.MemoryUsage, "rss" | "heapUsed">;
  uptime(): number;
  monitor(options: { resolution: number }): LoopHistogram;
}
export interface RuntimeObservation {
  sampledAt: number;
  process: { rssBytes: number; heapUsedBytes: number; uptimeSeconds: number };
  eventLoop: {
    resolutionMs: number;
    windowMs: number;
    samples: number;
    meanMs: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  jobs: RunnerQueueObservation | null;
}

function milliseconds(nanoseconds: number): number | null {
  return Number.isFinite(nanoseconds) && nanoseconds >= 0
    ? Math.round(nanoseconds / 1000) / 1000
    : null;
}

/** One bounded histogram and a cached private snapshot, with no additional scheduler. */
export class RuntimeObservations {
  private readonly sources: ObservationSources;
  private readonly histogram: LoopHistogram;
  private windowStarted: number;
  private nextSampleAt = -Infinity;
  private closed = false;
  private cached: RuntimeObservation | null = null;

  constructor(
    private readonly readQueues: () => RunnerQueueObservation,
    sources: Partial<ObservationSources> = {},
  ) {
    this.sources = {
      clock: Date.now,
      monotonicClock: () => performance.now(),
      memoryUsage: () => process.memoryUsage(),
      uptime: () => process.uptime(),
      monitor: monitorEventLoopDelay,
      ...sources,
    };
    this.windowStarted = this.sources.monotonicClock();
    this.histogram = this.sources.monitor({ resolution: resolutionMs });
    this.histogram.enable();
  }

  sample(): RuntimeObservation | null {
    if (this.closed) return null;
    try {
      return this.readSample();
    } catch {
      this.cached = null;
      return null;
    }
  }

  private readSample(): RuntimeObservation | null {
    const now = this.sources.monotonicClock();
    if (now < this.nextSampleAt) return this.cached;
    this.nextSampleAt = now + intervalMs;
    const memory = this.sources.memoryUsage(),
      samples = this.histogram.count,
      eventLoop = {
        resolutionMs,
        windowMs: Math.max(0, Math.round(now - this.windowStarted)),
        samples,
        meanMs: samples ? milliseconds(this.histogram.mean) : null,
        p95Ms: samples ? milliseconds(this.histogram.percentile(95)) : null,
        maxMs: samples ? milliseconds(this.histogram.max) : null,
      };
    let jobs: RunnerQueueObservation | null = null;
    try {
      jobs = this.readQueues();
    } catch {
      // A measurement failure cannot replace the ordinary readiness result.
    }
    this.cached = {
      sampledAt: this.sources.clock(),
      process: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        uptimeSeconds: Math.round(this.sources.uptime() * 1000) / 1000,
      },
      eventLoop,
      jobs,
    };
    this.histogram.reset();
    this.windowStarted = now;
    return this.cached;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cached = null;
    try {
      this.histogram.disable();
    } catch {
      // Optional measurements never prevent the worker from shutting down.
    }
    try {
      this.histogram.reset();
    } catch {
      // No caller relies on observation state after close.
    }
  }
}
