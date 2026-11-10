import assert from "node:assert/strict";
import test from "node:test";
import { MeetingMembership } from "../dist/bot/meeting-membership.js";
import { MeetingError } from "../dist/modules/meetings/service.js";

const guildId = "100000000000000001",
  userId = "100000000000000002";
function fixture() {
  let now = 2000,
    fetchMember = async (route) => ({
      user: { id: route.split("/").at(-1) },
      joined_at: new Date(1000).toISOString(),
    });
  const removed = [],
    fetches = [],
    queries = [];
  const runtime = {
    effectsReady: true,
    context: {
      guild: {
        id: guildId,
      },
    },
    jobs: {
      db: {
        prepare: (sql) => ({
          all: (guild, cursor) => {
            queries.push({ sql, guild, cursor });
            return rows.filter((row) => row.user_id > cursor).slice(0, 10);
          },
        }),
      },
    },
    memberRemoved: async (...args) => {
      removed.push(args);
      return [];
    },
    memberUpdated() {},
  };
  let rows = [];
  return {
    runtime,
    removed,
    fetches,
    queries,
    membership: new MeetingMembership(
      runtime,
      {
        get: async (route, options) => {
          fetches.push({ route, signal: options.signal });
          return fetchMember(route, options);
        },
      },
      () => now,
    ),
    setNow: (value) => {
      now = value;
    },
    setFetch: (value) => {
      fetchMember = value;
    },
    setRows: (value) => {
      rows = value;
    },
  };
}

test("fresh REST membership detects an offline leave and rejoin without invalidating newer joins", async () => {
  const f = fixture();
  await f.membership.check(userId);
  assert.equal(f.fetches[0].route, `/guilds/${guildId}/members/${userId}`);
  assert.ok(f.fetches[0].signal instanceof globalThis.AbortSignal);
  assert.equal(f.removed[0][0], userId);
  assert.equal(f.removed[0][2], 999);
  const key = f.removed[0][1];
  f.setNow(9000);
  await f.membership.check(userId);
  assert.equal(f.removed[1][1], key);
});

test("definite absence uses time before the lookup and a network outage never removes a member", async () => {
  const f = fixture();
  f.setFetch(async () => {
    f.setNow(8000);
    throw Object.assign(Error("absent"), { code: 10007 });
  });
  await f.membership.check(userId);
  assert.equal(f.removed[0][2], 2000);
  f.setFetch(async () => {
    throw Object.assign(Error("unavailable"), { status: 503 });
  });
  await assert.rejects(f.membership.check(userId), /unavailable/);
  assert.equal(f.removed.length, 1);
});

test("duplicate concurrent events share one check, and a roster CAS conflict reuses its cutoff", async () => {
  const f = fixture();
  let release;
  f.setFetch(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let calls = 0;
  f.runtime.memberRemoved = async (...args) => {
    f.removed.push(args);
    if (!calls++) throw new MeetingError("revision_conflict");
    return [];
  };
  const first = f.membership.check(userId),
    second = f.membership.check(userId);
  assert.equal(first, second);
  release({ user: { id: userId }, joined_at: new Date(1000).toISOString() });
  await Promise.all([first, second]);
  assert.equal(f.fetches.length, 1);
  assert.deepEqual(f.removed[0], f.removed[1]);
});

test("startup sweep is bounded and cycles fairly without overlapping or querying inactive history", async () => {
  const f = fixture();
  f.setRows(
    Array.from({ length: 12 }, (_, i) => ({ user_id: String(100000000000000010n + BigInt(i)) })),
  );
  await f.membership.sweep();
  assert.equal(f.fetches.length, 10);
  assert.match(f.queries[0].sql, /m.state IN \('draft','open','starting','active'\)/);
  assert.equal(f.queries[0].guild, guildId);
  await f.membership.sweep();
  assert.equal(f.fetches.length, 10);
  f.setNow(62000);
  await f.membership.sweep();
  assert.equal(f.fetches.length, 12);
  assert.equal(f.queries[1].cursor, "100000000000000019");
  f.setNow(122000);
  await f.membership.sweep();
  assert.equal(f.queries[2].cursor, "");
});

test("shutdown aborts the private REST lookup and prevents late mutations or fresh checks", async () => {
  const f = fixture();
  let release;
  f.setFetch(
    (_route, options) =>
      new Promise((resolve, reject) => {
        release = resolve;
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
  );
  const active = f.membership.check(userId);
  await f.membership.stop();
  release({ user: { id: userId }, joined_at: new Date(1000).toISOString() });
  await active;
  await f.membership.check(userId);
  await f.membership.sweep();
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].signal.aborted, true);
  assert.equal(f.removed.length, 0);
});

test("an unrelated or incomplete API member response never invalidates a reservation", async () => {
  const f = fixture();
  f.setFetch(async () => ({ user: { id: guildId }, joined_at: new Date(1000).toISOString() }));
  await assert.rejects(f.membership.check(userId), /membership_unconfirmed/);
  f.setFetch(async () => ({ user: { id: userId }, joined_at: null }));
  await f.membership.check(userId);
  assert.equal(f.removed.length, 0);
});
