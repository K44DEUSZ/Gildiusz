import test from "node:test";
import assert from "node:assert/strict";
import { GuildActivity } from "../dist/bot/guild-activity.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("draining a guild covers the entire maintenance sequence, including later stages", async () => {
  const activities = new GuildActivity(),
    room = deferred(),
    role = deferred();
  const stages = [];
  const work = (async () => {
    await room.promise;
    stages.push("roles_started");
    await role.promise;
    stages.push("retention_finished");
  })();
  activities.track("guild-a", work);
  assert.equal(await activities.drain("guild-a", 5), false);
  assert.equal(await activities.drain("guild-b", 5), true);
  room.resolve();
  assert.equal(await activities.drain("guild-a", 5), false);
  assert.deepEqual(stages, ["roles_started"]);
  role.resolve();
  assert.equal(await activities.drain("guild-a", 5), true);
  assert.deepEqual(stages, ["roles_started", "retention_finished"]);
});

test("failed guild work finishes its activity record without affecting another guild", async () => {
  const activities = new GuildActivity(),
    held = deferred();
  activities.track("guild-b", held.promise);
  const failed = Promise.reject(Error("operation_failed"));
  activities.track("guild-a", failed);
  assert.equal(await activities.drain("guild-a", 5), true);
  assert.equal(await activities.drain("guild-b", 5), false);
  held.resolve();
  assert.equal(await activities.drain("guild-b", 5), true);
});
