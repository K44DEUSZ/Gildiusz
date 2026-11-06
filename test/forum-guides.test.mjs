import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/storage/store.js";
import { initializeForumGuides } from "../dist/bootstrap/forum-guides.js";

test("forum instructions preview exact content, create once, and preserve manual edits", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kampus-guides-"));
  const store = new Store(join(directory, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const environment = { guildId: "guild", clientId: "bot", ownerId: "owner" };
  const state = { channels: [] };
  for (const key of ["showcase", "collaboration"]) {
    store.putResource(`channel.${key}`, "channel", key, {});
    state.channels.push({
      id: key,
      type: 15,
      available_tags: [{ id: `${key}-tag`, name: "Start" }],
    });
  }
  const remote = new Map();
  let writes = 0;
  const api = {
    get: async (route) => JSON.parse(JSON.stringify(remote.get(route))),
    post: async (route, body) => {
      writes++;
      const id = `thread-${writes}`,
        parent = route.split("/")[2];
      const thread = { id, type: 11, parent_id: parent, name: body.name };
      remote.set(`/channels/${id}`, thread);
      remote.set(`/channels/${id}/messages/${id}`, {
        id,
        content: body.message.content,
        author: { id: "bot" },
      });
      return thread;
    },
  };
  const preview = await initializeForumGuides(api, state, store, environment);
  assert.equal(writes, 0);
  assert.ok(preview.guides.every((guide) => guide.body.message.content.includes("To instrukcja")));
  await assert.rejects(
    initializeForumGuides(api, state, store, environment, "wrong"),
    /plan changed/,
  );
  assert.equal(writes, 0);
  await initializeForumGuides(api, state, store, environment, preview.approve);
  assert.equal(writes, 2);
  assert.deepEqual(store.operations(), []);
  const repeated = await initializeForumGuides(api, state, store, environment);
  assert.ok(repeated.guides.every((guide) => guide.action === "keep"));
  await initializeForumGuides(api, state, store, environment, repeated.approve);
  assert.equal(writes, 2);
  remote.get("/channels/thread-1/messages/thread-1").content = "Owner edit";
  await assert.rejects(initializeForumGuides(api, state, store, environment), /review manually/);
  assert.equal(writes, 2);
});
