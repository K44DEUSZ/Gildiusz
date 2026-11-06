import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/storage/store.js";
import { BotContext } from "../dist/bot/context.js";
import { loadConfig } from "../dist/config.js";

test("retention removes the bot's old log messages and records while preserving active room state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kampus-retention-")),
    store = new Store(join(directory, "db.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.putResource("channel.logs", "channel", "logs", {});
  store.putRoom({
    id: "room",
    owner: "owner",
    locked: false,
    allowed: [],
    arrivals: { owner: 1 },
    emptySince: null,
    ownerAbsentSince: null,
  });
  const id = store.event("report", "member", "submitted", "moderation", "message");
  const now = Date.now();
  store.db.prepare("UPDATE events SET created=? WHERE id=?").run(now - 31 * 86400000, id);
  let deleted = 0;
  const guild = {
    id: "guild",
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        messages: {
          fetch: async () => ({
            author: { id: "self" },
            delete: async () => {
              deleted++;
            },
          }),
        },
      }),
    },
  };
  const context = new BotContext({ user: { id: "self" } }, guild, store, loadConfig(), {});
  await context.retention(now);
  assert.equal(deleted, 1);
  assert.deepEqual(store.oldEvents(now), []);
  assert.equal(store.room("room").owner, "owner");
  assert.equal(store.id("channel.logs"), "logs");
});
