import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { RuntimeObservations } from "../dist/bot/runtime-observations.js";

const emptyQueue = () => ({
  scope: "registered_guild_runtimes",
  observedGuilds: 0,
  failedGuilds: 0,
  unavailableGuilds: 0,
  pausedGuilds: 0,
  due: 0,
  deferredRetries: 0,
  running: 0,
  unknown: 0,
  oldestOverdueMs: null,
});
function fixture() {
  const f = {
    now: 1000,
    monotonic: 10,
    queueReads: 0,
    resets: 0,
    enables: 0,
    disables: 0,
    count: 0,
    mean: NaN,
    max: 0,
    p95: 0,
  };
  f.sources = {
    clock: () => f.now,
    monotonicClock: () => f.monotonic,
    memoryUsage: () => ({ rss: 120000000, heapUsed: 40000000 }),
    uptime: () => 12.34567,
    monitor: (options) => {
      assert.deepEqual(options, { resolution: 20 });
      return {
        get count() {
          return f.count;
        },
        get mean() {
          return f.mean;
        },
        get max() {
          return f.max;
        },
        percentile: (value) => {
          assert.equal(value, 95);
          return f.p95;
        },
        reset: () => {
          f.resets++;
          f.count = 0;
        },
        enable: () => {
          f.enables++;
          return true;
        },
        disable: () => {
          f.disables++;
          return true;
        },
      };
    },
  };
  f.read = () => {
    f.queueReads++;
    return emptyQueue();
  };
  return f;
}

test("private observations use one reset histogram, explicit millisecond units and a monotonic 30s cache", () => {
  const f = fixture(),
    monitor = new RuntimeObservations(f.read, f.sources);
  const initial = monitor.sample();
  assert.equal(f.enables, 1);
  assert.deepEqual(initial.eventLoop, {
    resolutionMs: 20,
    windowMs: 0,
    samples: 0,
    meanMs: null,
    p95Ms: null,
    maxMs: null,
  });
  assert.deepEqual(initial.process, {
    rssBytes: 120000000,
    heapUsedBytes: 40000000,
    uptimeSeconds: 12.346,
  });
  f.now = 0;
  f.monotonic += 29999;
  assert.strictEqual(monitor.sample(), initial);
  assert.equal(f.queueReads, 1);
  assert.equal(f.resets, 1);
  f.monotonic++;
  Object.assign(f, { count: 10, mean: 20123456, p95: 30987654, max: 47987654 });
  const next = monitor.sample();
  assert.equal(next.sampledAt, 0);
  assert.deepEqual(next.eventLoop, {
    resolutionMs: 20,
    windowMs: 30000,
    samples: 10,
    meanMs: 20.123,
    p95Ms: 30.988,
    maxMs: 47.988,
  });
  assert.equal(f.queueReads, 2);
  assert.equal(f.resets, 2);
  assert.equal(f.count, 0);
  monitor.close();
  monitor.close();
  assert.equal(f.disables, 1);
  assert.equal(f.resets, 3);
  assert.equal(monitor.sample(), null);
  assert.equal(f.queueReads, 2);
});

test("unavailable queue or measurement samples remain explicit and are not retried on each health write", () => {
  const f = fixture(),
    monitor = new RuntimeObservations(() => {
      throw Error("private database error");
    }, f.sources);
  assert.equal(monitor.sample().jobs, null);
  monitor.close();
  let reads = 0;
  const broken = new RuntimeObservations(f.read, {
    ...f.sources,
    memoryUsage: () => {
      reads++;
      throw Error("measurement unavailable");
    },
  });
  assert.equal(broken.sample(), null);
  assert.equal(broken.sample(), null);
  assert.equal(reads, 1);
  f.monotonic += 30000;
  assert.equal(broken.sample(), null);
  assert.equal(reads, 2);
  broken.close();
});

test("the actual Node monitor records finite samples and closes without leaving a running process", () => {
  const source = `
    import { RuntimeObservations } from './dist/bot/runtime-observations.js';
    const monitor = new RuntimeObservations(() => null);
    await new Promise(resolve => setTimeout(resolve, 120));
    const sample = monitor.sample();
    monitor.close();
    console.log(JSON.stringify({ sample, closed: monitor.sample() }));
  `;
  const env = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { sample, closed } = JSON.parse(result.stdout);
  assert.equal(closed, null);
  assert.ok(sample.eventLoop.samples > 0);
  for (const key of ["meanMs", "p95Ms", "maxMs"]) {
    assert.ok(Number.isFinite(sample.eventLoop[key]));
    assert.ok(sample.eventLoop[key] >= 0);
  }
  assert.ok(sample.process.rssBytes > sample.process.heapUsedBytes);
  assert.ok(sample.process.uptimeSeconds >= 0);
});
