import test from "node:test";
import assert from "node:assert/strict";
import { freshBotGuildPresence } from "../dist/bot/guild-presence.js";

const id = (number) => String(100000000000000000n + BigInt(number));
const rows = (start, count) => Array.from({ length: count }, (_, n) => ({ id: id(start + n) }));

test("fresh bot membership checks every page before confirming absence", async () => {
  const requests = [];
  const rest = {
    async get(path, options) {
      assert.equal(path, "/users/@me/guilds");
      assert.equal(options.query.get("limit"), "200");
      requests.push(options.query.get("after"));
      return requests.length === 1 ? rows(1, 200) : rows(201, 50);
    },
  };
  assert.deepEqual(await freshBotGuildPresence(rest, id(999), { clock: () => 123 }), {
    state: "absent",
    observedAt: 123,
    source: "discord-rest",
  });
  assert.deepEqual(requests, ["0", id(200)]);
});

test("a member on a later page is present, even if local caches would omit it", async () => {
  let calls = 0;
  const rest = { get: async () => (++calls === 1 ? rows(1, 200) : rows(201, 50)) };
  assert.equal((await freshBotGuildPresence(rest, id(250))).state, "present");
  assert.equal(calls, 2);
});

test("denied, limited, failed and interrupted membership checks never authorize deletion", async (t) => {
  for (const failure of [
    { status: 403 },
    { status: 404 },
    { status: 429 },
    { status: 503 },
    Error(),
  ])
    await t.test(String(failure.status ?? "network"), async () => {
      assert.equal(
        (
          await freshBotGuildPresence(
            {
              get: async () => {
                throw failure;
              },
            },
            id(1),
          )
        ).state,
        "unknown",
      );
    });
  const controller = new globalThis.AbortController();
  controller.abort();
  let called = false;
  assert.equal(
    (
      await freshBotGuildPresence(
        {
          get: async () => {
            called = true;
            return [];
          },
        },
        id(1),
        { signal: controller.signal },
      )
    ).state,
    "unknown",
  );
  assert.equal(called, false);
});

test("malformed, duplicate and stalled pages cannot establish absence", async () => {
  for (const response of [
    null,
    {},
    [{ id: "bad" }],
    [null],
    [{ id: id(1) }, { id: id(1) }],
    rows(1, 201),
  ])
    assert.equal(
      (await freshBotGuildPresence({ get: async () => response }, id(999))).state,
      "unknown",
    );
  let calls = 0;
  assert.equal(
    (
      await freshBotGuildPresence(
        {
          get: async () => {
            calls++;
            return rows(1, 200);
          },
        },
        id(999),
      )
    ).state,
    "unknown",
  );
  assert.equal(calls, 2);
});
