import test from "node:test";
import assert from "node:assert/strict";
import { RetentionSchedule } from "../dist/bot/retention-schedule.js";

test("retention reaches every one of 1000 guilds across repeated hourly cycles", () => {
  const scheduler = new RetentionSchedule(),
    ids = Array.from({ length: 1000 }, (_, i) => String(i)),
    visits = new Map();
  for (let now = 0; now < 3 * 3600000; now += 5000) {
    const batch = scheduler.take(ids, now);
    assert.ok(batch.length <= 5);
    for (const id of batch) visits.set(id, (visits.get(id) ?? 0) + 1);
  }
  assert.equal(visits.size, 1000);
  assert.ok([...visits.values()].every((count) => count === 3));
});

test("retention respects in-flight capacity, retry delay and a fresh installation", () => {
  const scheduler = new RetentionSchedule();
  assert.deepEqual(scheduler.take(["a", "b"], 0, 0), []);
  assert.deepEqual(scheduler.take(["a", "b"], 0, 1), ["a"]);
  scheduler.retry("a", 0);
  assert.deepEqual(scheduler.take(["a", "b"], 59999), ["b"]);
  assert.deepEqual(scheduler.take(["a", "b"], 60000), ["a"]);
  scheduler.forget("a");
  assert.deepEqual(scheduler.take(["a", "b"], 60001), ["a"]);
});
