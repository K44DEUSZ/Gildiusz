import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Store } from "../dist/storage/store.js";
import { JobStore, JobError } from "../dist/core/jobs/store.js";
import { MeetingService, MeetingError } from "../dist/modules/meetings/service.js";
import { meetingSchema } from "../dist/modules/meetings/schema.js";

const guildId = "100000000000000001",
  owner = "100000000000000002",
  alice = "100000000000000003",
  bob = "100000000000000004",
  carol = "100000000000000005",
  dave = "100000000000000006",
  channelId = "100000000000000007",
  roomId = "100000000000000008";
const code = (expected) => (error) => error instanceof MeetingError && error.code === expected;
const person = (result, userId) => result.participants.find((item) => item.userId === userId);

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-meetings-")),
    path = join(directory, "guild.sqlite");
  let now = Date.parse("2026-11-09T12:00:00Z");
  const stores = [],
    requests = [],
    removed = new Set();
  let policy = (request) => {
      const { operation, meeting, actorId } = request;
      if (["create", "list", "deliver", "join", "leave"].includes(operation)) return;
      if (operation === "read" && meeting.state !== "draft" && meeting.visibility === "public")
        return;
      if (actorId !== meeting.organizerId) return false;
    },
    eligible = (userId) => !removed.has(userId);
  const open = () => {
    const store = new Store(path, guildId),
      jobs = new JobStore(store.db, () => now);
    const migration = store.db
      .prepare("SELECT name,checksum FROM schema_migrations WHERE version=5")
      .get();
    assert.equal(migration.name, "meetings");
    assert.equal(migration.checksum, createHash("sha256").update(meetingSchema).digest("hex"));
    const service = new MeetingService(jobs, {
      ...options,
      guildId,
      clock: () => now,
      authorize: async (request) => {
        requests.push(request);
        return policy(request);
      },
      eligible: async (userId, meeting) => eligible(userId, meeting),
    });
    stores.push(store);
    return { store, jobs, service };
  };
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* Reopened fixture. */
      }
    }
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-meetings-")
    )
      throw Error("Unexpected test directory.");
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...open(),
    open,
    requests,
    removed,
    now: () => now,
    setNow: (value) => {
      now = value;
    },
    setPolicy: (value) => {
      policy = value;
    },
    setEligible: (value) => {
      eligible = value;
    },
    draft: (extra = {}) => ({
      title: "Wieczór z projektem",
      description: "Zbieramy ekipę do wspólnej pracy.",
      capacity: 2,
      startsAt: now + 3600000,
      endsAt: now + 7200000,
      channelId,
      visibility: "public",
      ...extra,
    }),
  };
}

test("organizer reserves a place unless explicitly opted out, with full computed from rows", async (t) => {
  const f = fixture(t),
    created = await f.service.create(owner, "create", f.draft({ capacity: 1 }));
  assert.equal(created.meeting.confirmedCount, 1);
  assert.equal(created.meeting.full, true);
  assert.equal(person(created, owner).state, "confirmed");
  const without = await f.service.create(
    owner,
    "without",
    f.draft({ organizerParticipates: false }),
  );
  assert.equal(without.participants.length, 0);
  assert.equal(without.meeting.full, false);
  assert.ok(created.jobs.some((job) => job.type === "meeting.publish"));
  assert.ok(created.jobs.some((job) => job.type === "meeting.reminder"));
});

test("delayed membership cleanup preserves reservations made after rejoining", async (t) => {
  const f = fixture(t),
    created = await f.service.create(owner, "create", f.draft());
  await f.service.join(alice, "first-join", created.meeting.id);
  const departedAt = f.now();
  f.setNow(departedAt + 1000);
  await f.service.leave(alice, "leave", created.meeting.id);
  await f.service.join(alice, "new-join", created.meeting.id);
  assert.deepEqual(await f.service.memberRemoved(alice, "old-event", departedAt), []);
  const current = await f.service.get(owner, created.meeting.id);
  assert.equal(person(current, alice).state, "confirmed");
  assert.equal(person(current, alice).joinedAt, departedAt + 1000);
});

test("membership cleanup removes old reservations, promotes waitlist and survives replay", async (t) => {
  const f = fixture(t),
    created = await f.service.create(
      owner,
      "create",
      f.draft({ capacity: 1, organizerParticipates: false }),
    );
  await f.service.join(alice, "alice", created.meeting.id);
  await f.service.join(bob, "bob", created.meeting.id);
  const cutoff = f.now();
  f.setNow(cutoff + 1000);
  const [removed] = await f.service.memberRemoved(alice, "departure", cutoff);
  assert.equal(person(removed, alice).state, "left");
  assert.equal(person(removed, bob).state, "confirmed");
  const version = removed.meeting.participantVersion;
  const [replayed] = await f.service.memberRemoved(alice, "departure", cutoff);
  assert.equal(replayed.meeting.participantVersion, version);
  assert.equal(replayed.jobs.filter((job) => job.type === "meeting.promoted").length, 1);
});

test("idempotency avoids duplicate meetings, joins, rows and jobs", async (t) => {
  const f = fixture(t),
    draft = f.draft();
  const created = await f.service.create(owner, "create", draft);
  const replay = await f.service.create(owner, "create", draft);
  assert.equal(replay.meeting.id, created.meeting.id);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 1);
  await assert.rejects(
    f.service.create(owner, "create", { ...draft, title: "Inny tytuł" }),
    (error) => error instanceof JobError && error.code === "idempotency_conflict",
  );
  const first = await f.service.join(alice, "join", created.meeting.id);
  const again = await f.service.join(alice, "join", created.meeting.id);
  assert.equal(again.jobs.length, first.jobs.length);
  const another = await f.service.join(alice, "another", created.meeting.id);
  assert.equal(another.meeting.confirmedCount, 2);
  assert.equal(another.participants.filter((item) => item.userId === alice).length, 1);
  assert.equal(another.meeting.participantVersion, first.meeting.participantVersion);
});

test("drafts queue nothing and stay private until the organizer opens them", async (t) => {
  const f = fixture(t),
    created = await f.service.create(owner, "draft", f.draft({ state: "draft" }));
  assert.equal(created.jobs.length, 0);
  assert.deepEqual(await f.service.list(alice), []);
  await assert.rejects(f.service.get(alice, created.meeting.id), code("forbidden"));
  const opened = await f.service.update(
    owner,
    "open",
    created.meeting.id,
    created.meeting.revision,
    f.draft({ state: "open" }),
  );
  assert.equal(opened.meeting.state, "open");
  assert.equal((await f.service.list(alice)).length, 1);
  assert.ok(opened.jobs.some((job) => job.type === "meeting.publish"));
});

test("two real SQLite connections cannot grant the last place to two people", async (t) => {
  const f = fixture(t),
    second = f.open(),
    created = await f.service.create(owner, "create", f.draft());
  await Promise.all([
    f.service.join(alice, "alice", created.meeting.id),
    second.service.join(bob, "bob", created.meeting.id),
  ]);
  const result = await second.service.get(owner, created.meeting.id);
  assert.equal(result.meeting.confirmedCount, 2);
  assert.equal(result.meeting.waitlistedCount, 1);
  assert.equal(
    result.participants.filter(
      (item) => [alice, bob].includes(item.userId) && item.state === "confirmed",
    ).length,
    1,
  );
  assert.equal(new Set(result.participants.map((item) => item.userId)).size, 3);
});

test("FIFO waitlist promotion and rejoin at the tail survive separate requests", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ capacity: 1 }));
  await f.service.join(alice, "a", meeting.id);
  await f.service.join(bob, "b", meeting.id);
  await f.service.leave(alice, "a-left", meeting.id);
  const rejoined = await f.service.join(alice, "a-again", meeting.id);
  assert.ok(person(rejoined, alice).sequence > person(rejoined, bob).sequence);
  const promoted = await f.service.leave(owner, "owner-left", meeting.id);
  assert.equal(person(promoted, bob).state, "confirmed");
  assert.equal(person(promoted, alice).state, "waitlisted");
  assert.equal(
    promoted.jobs.filter((job) => job.type === "meeting.promoted").at(-1).payload.recipientId,
    bob,
  );
  const again = await f.service.leave(bob, "b-left", meeting.id);
  assert.equal(person(again, alice).state, "confirmed");
  assert.equal(again.meeting.confirmedCount, 1);
});

test("promotion skips a conclusively ineligible reservist, while lookup failure rolls back", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ capacity: 1 }));
  await f.service.join(alice, "a", meeting.id);
  await f.service.join(bob, "b", meeting.id);
  f.setEligible(() => {
    throw Error("Discord lookup unavailable");
  });
  const count = f.jobs.list({ objectId: meeting.id }).length;
  await assert.rejects(f.service.leave(owner, "leave", meeting.id), /lookup unavailable/);
  assert.equal(person(await f.service.get(owner, meeting.id), owner).state, "confirmed");
  assert.equal(f.jobs.list({ objectId: meeting.id }).length, count);
  f.removed.add(alice);
  f.setEligible((userId) => !f.removed.has(userId));
  const result = await f.service.leave(owner, "leave", meeting.id);
  assert.equal(person(result, alice).state, "left");
  assert.equal(person(result, alice).leftReason, "ineligible");
  assert.equal(person(result, bob).state, "confirmed");
});

test("an async promotion check is fenced by roster version if another connection joins", async (t) => {
  const f = fixture(t),
    second = f.open(),
    { meeting } = await f.service.create(owner, "create", f.draft({ capacity: 1 }));
  await f.service.join(alice, "a", meeting.id);
  let release, entered;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      entered = resolve;
    });
  f.setEligible(async () => {
    entered();
    await gate;
    return true;
  });
  const leaving = f.service.leave(owner, "leave", meeting.id);
  await started;
  await second.service.join(bob, "b", meeting.id);
  release();
  await assert.rejects(leaving, code("revision_conflict"));
  const current = await f.service.get(owner, meeting.id);
  assert.equal(person(current, owner).state, "confirmed");
  assert.equal(current.meeting.waitlistedCount, 2);
});

test("member removal invalidates participation and promotes once, including event replay", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ capacity: 1 }));
  await f.service.join(alice, "a", meeting.id);
  await f.service.join(bob, "b", meeting.id);
  f.removed.add(owner);
  const [removed] = await f.service.memberRemoved(owner, "event");
  assert.equal(person(removed, owner).leftReason, "member_removed");
  assert.equal(person(removed, alice).state, "confirmed");
  const count = removed.jobs.filter((job) => job.type === "meeting.promoted").length;
  await f.service.memberRemoved(owner, "event");
  assert.equal(f.jobs.list({ objectId: meeting.id, type: "meeting.promoted" }).length, count);
});

test("owner authorization, private visibility, CAS and capacity reject without partial changes", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ visibility: "private" }));
  await assert.rejects(f.service.get(alice, meeting.id), code("forbidden"));
  await assert.rejects(
    f.service.update(alice, "bad", meeting.id, meeting.revision, f.draft()),
    code("forbidden"),
  );
  assert.deepEqual(await f.service.list(alice), []);
  await f.service.join(alice, "join", meeting.id);
  await assert.rejects(
    f.service.update(owner, "capacity", meeting.id, meeting.revision, f.draft({ capacity: 1 })),
    code("capacity_conflict"),
  );
  const updated = await f.service.update(
    owner,
    "update",
    meeting.id,
    meeting.revision,
    f.draft({ capacity: 3 }),
  );
  await assert.rejects(
    f.service.update(owner, "old", meeting.id, meeting.revision, f.draft()),
    code("revision_conflict"),
  );
  assert.equal(updated.meeting.capacity, 3);
});

test("rescheduling cancels old reminders and claimed generations stay stale after restart", async (t) => {
  const f = fixture(t),
    { meeting, jobs } = await f.service.create(owner, "create", f.draft());
  const reminder = jobs.find((job) => job.type === "meeting.reminder");
  f.setNow(reminder.dueAt);
  const [claimed] = f.jobs.claim({ types: ["meeting.reminder"], limit: 1, leaseMs: 30000 });
  const changed = await f.service.update(
    owner,
    "move",
    meeting.id,
    meeting.revision,
    f.draft({ startsAt: f.now() + 7200000, endsAt: f.now() + 10800000 }),
  );
  assert.equal(changed.meeting.generation, meeting.generation + 1);
  assert.equal(f.jobs.get(claimed.id).state, "cancelled");
  f.store.close();
  const reopened = f.open();
  await assert.rejects(reopened.service.prepare(claimed), code("stale_job"));
  assert.ok(
    reopened.jobs
      .list({ objectId: meeting.id, type: "meeting.reminder" })
      .some((job) => job.generation === changed.meeting.generation && job.state === "pending"),
  );
});

test("leaving cancels recipient reminders and rejoin uses a different participant sequence", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ capacity: 3 }));
  const joined = await f.service.join(alice, "join", meeting.id),
    sequence = person(joined, alice).sequence;
  const old = joined.jobs.find(
    (job) => job.type === "meeting.reminder" && job.payload.recipientId === alice,
  );
  await f.service.leave(alice, "leave", meeting.id);
  assert.equal(f.jobs.get(old.id).state, "cancelled");
  const again = await f.service.join(alice, "again", meeting.id);
  assert.ok(person(again, alice).sequence > sequence);
  assert.equal(
    again.jobs.filter(
      (job) =>
        job.type === "meeting.reminder" &&
        job.payload.recipientId === alice &&
        job.state === "pending",
    ).length,
    1,
  );
});

test("job preparation refreshes permission and recipient eligibility before delivery", async (t) => {
  const f = fixture(t),
    created = await f.service.create(owner, "create", f.draft());
  const reminder = created.jobs.find((job) => job.type === "meeting.reminder");
  f.setNow(reminder.dueAt);
  const [claimed] = f.jobs.claim({ types: ["meeting.reminder"], limit: 1 });
  f.setPolicy((request) => (request.operation === "deliver" ? false : undefined));
  await assert.rejects(f.service.prepare(claimed), code("forbidden"));
  f.setPolicy(() => {});
  f.removed.add(owner);
  await assert.rejects(f.service.prepare(claimed), code("forbidden"));
  f.removed.clear();
  const prepared = await f.service.prepare(claimed);
  assert.equal(prepared.recipientId, owner);
  assert.equal(prepared.meeting.id, created.meeting.id);
  assert.equal(f.requests.at(-1).jobType, "meeting.reminder");
});

test("time passing does not start or complete meetings and expired reminders are never sent", async (t) => {
  const f = fixture(t),
    created = await f.service.create(owner, "create", f.draft());
  f.setNow(created.meeting.endsAt + 1);
  assert.equal((await f.service.get(owner, created.meeting.id)).meeting.state, "open");
  assert.deepEqual(f.jobs.claim({ types: ["meeting.reminder"], limit: 1 }), []);
  await assert.rejects(
    f.service.transition(owner, "start", created.meeting.id, created.meeting.revision, "start"),
    code("expired"),
  );
});

test("manual early start queues work; its fenced receipt activates once and finish requests safe cleanup", async (t) => {
  const f = fixture(t),
    created = await f.service.create(
      owner,
      "create",
      f.draft({ room: { kind: "create", categoryId: channelId } }),
    );
  const starting = await f.service.transition(
    owner,
    "start",
    created.meeting.id,
    created.meeting.revision,
    "start",
  );
  assert.equal(starting.meeting.state, "starting");
  const [job] = f.jobs.claim({ types: ["meeting.start"], limit: 1 });
  const prepared = await f.service.prepare(job);
  assert.equal(prepared.room.kind, "create");
  const result = { roomChannelId: roomId, roomCreatedByBot: true };
  const active = f.service.recordResult(job, result);
  assert.equal(active.meeting.state, "active");
  assert.equal(active.meeting.roomChannelId, roomId);
  assert.deepEqual(f.service.recordResult(job, result), active);
  assert.throws(
    () => f.service.recordResult(job, { ...result, roomChannelId: channelId }),
    code("state_conflict"),
  );
  const completed = await f.service.transition(
    owner,
    "complete",
    created.meeting.id,
    active.meeting.revision,
    "complete",
  );
  const [finish] = f.jobs.claim({ types: ["meeting.finish"], limit: 1 });
  const cleanup = await f.service.prepare(finish);
  assert.equal(completed.meeting.state, "completed");
  assert.deepEqual(cleanup.cleanupRoom, {
    channelId: roomId,
    createdByBot: true,
    requireNoHumans: true,
  });
});

test("existing rooms never receive deletion instruction and message receipts cannot replace room bindings", async (t) => {
  const f = fixture(t),
    created = await f.service.create(
      owner,
      "create",
      f.draft({ room: { kind: "existing", channelId: roomId } }),
    );
  const starting = await f.service.transition(
    owner,
    "start",
    created.meeting.id,
    created.meeting.revision,
    "start",
  );
  const [start] = f.jobs.claim({ types: ["meeting.start"], limit: 1 });
  assert.throws(
    () => f.service.recordResult(start, { roomChannelId: channelId, roomCreatedByBot: true }),
    code("invalid_input"),
  );
  const active = f.service.recordResult(start, {});
  assert.equal(active.meeting.roomChannelId, roomId);
  assert.equal(active.meeting.roomCreatedByBot, false);
  await f.service.transition(
    owner,
    "complete",
    starting.meeting.id,
    active.meeting.revision,
    "complete",
  );
  const [finish] = f.jobs.claim({ types: ["meeting.finish"], limit: 1 });
  assert.equal((await f.service.prepare(finish)).cleanupRoom, null);
  assert.throws(
    () => f.service.recordResult(finish, { messageId: channelId }),
    code("invalid_input"),
  );
});

test("private data cannot escape through an async read whose roster changed", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ visibility: "private" }));
  let release, entered;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      entered = resolve;
    });
  f.setPolicy(async (request) => {
    if (request.operation === "read" && request.actorId === alice) {
      entered();
      await gate;
    }
  });
  const reading = f.service.get(alice, meeting.id);
  await started;
  await f.service.join(bob, "new", meeting.id);
  release();
  await assert.rejects(reading, code("revision_conflict"));
});

test("a failure to enqueue rolls back the meeting, roster, jobs and idempotency together", async (t) => {
  const f = fixture(t),
    enqueue = f.jobs.enqueue.bind(f.jobs);
  let calls = 0;
  f.jobs.enqueue = (input) => {
    if (++calls === 2) throw Error("Queue unavailable");
    return enqueue(input);
  };
  await assert.rejects(f.service.create(owner, "create", f.draft()), /Queue unavailable/);
  for (const table of [
    "meetings",
    "meeting_participants",
    "jobs",
    "meeting_audit",
    "idempotency_keys",
  ])
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
});

test("guild isolation applies before writes even to drafts that queue no jobs", async (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      new MeetingService(f.jobs, {
        guildId: "200000000000000001",
        authorize() {},
        eligible() {
          return true;
        },
      }),
    code("guild_conflict"),
  );
  const created = await f.service.create(owner, "create", f.draft());
  f.store.db.exec("DELETE FROM guild_identity");
  const other = new MeetingService(f.jobs, {
    guildId: "200000000000000001",
    authorize() {},
    eligible() {
      return true;
    },
  });
  assert.deepEqual(await other.list(owner), []);
  await assert.rejects(other.get(owner, created.meeting.id), code("not_found"));
});

test("invalid definitions and active-meeting limits fail before side effects", async (t) => {
  const f = fixture(t, { maxMeetings: 1 });
  for (const extra of [
    { startsAt: f.now() - 60001 },
    { endsAt: f.now() },
    { capacity: 0 },
    { recurrence: "daily" },
    { room: { kind: "create", categoryId: "bad" } },
  ])
    await assert.rejects(f.service.create(owner, "bad", f.draft(extra)), code("invalid_input"));
  await f.service.create(owner, "create", f.draft({ startsAt: f.now() - 500 }));
  await assert.rejects(f.service.create(owner, "second", f.draft()), code("limit_exceeded"));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 1);
});

test("an uncertain create replay still resolves after the start grace, while a fresh stale create fails", async (t) => {
  const f = fixture(t),
    draft = f.draft({ startsAt: f.now() });
  const created = await f.service.create(owner, "create", draft);
  f.setNow(f.now() + 120000);
  assert.equal((await f.service.create(owner, "create", draft)).meeting.id, created.meeting.id);
  await assert.rejects(f.service.create(owner, "new", draft), code("invalid_input"));
});

test("commit rechecks time after authorization and no transaction spans an async callback", async (t) => {
  const f = fixture(t),
    draft = f.draft({ startsAt: f.now() });
  f.setPolicy(async () => {
    assert.equal(f.store.db.isTransaction, false);
    await Promise.resolve();
    f.setNow(f.now() + 120000);
  });
  await assert.rejects(f.service.create(owner, "create", draft), code("invalid_input"));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 0);
});

test("promotion only looks up enough FIFO candidates to fill available places", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ capacity: 1 }));
  for (const userId of [alice, bob, carol, dave]) await f.service.join(userId, userId, meeting.id);
  const checks = [];
  f.setEligible((userId) => {
    assert.equal(f.store.db.isTransaction, false);
    checks.push(userId);
    return true;
  });
  await f.service.leave(owner, "leave", meeting.id);
  assert.deepEqual(checks, [alice]);
});

test("growing roster and reminder history do not overflow a persisted idempotency result", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(
      owner,
      "create",
      f.draft({
        capacity: 100,
        startsAt: f.now() + 86400000,
        endsAt: f.now() + 90000000,
        reminderMinutes: [1, 5, 10, 15, 20],
      }),
    );
  for (let index = 0; index < 25; index++) {
    const userId = (300000000000000000n + BigInt(index)).toString();
    await f.service.join(userId, "join", meeting.id);
  }
  assert.equal((await f.service.get(owner, meeting.id)).meeting.confirmedCount, 26);
  const maximum = f.store.db
    .prepare("SELECT MAX(LENGTH(result)) AS n FROM idempotency_keys")
    .get().n;
  assert.ok(maximum < 100);
});

test("terminal card updates and safe cleanup can prepare after the original end time", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft());
  const started = await f.service.transition(owner, "start", meeting.id, meeting.revision, "start");
  const [start] = f.jobs.claim({ types: ["meeting.start"], limit: 1 });
  const active = f.service.recordResult(start, {});
  await f.service.transition(owner, "finish", meeting.id, active.meeting.revision, "complete");
  f.setNow(started.meeting.endsAt + 1);
  for (const type of ["meeting.publish", "meeting.finish"]) {
    const [job] = f.jobs.claim({ types: [type], limit: 1 });
    assert.equal((await f.service.prepare(job)).meeting.state, "completed");
  }
});

test("private invitations persist independently of roster and membership removal revokes them", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(
      owner,
      "private",
      f.draft({ visibility: "private", invitedUserIds: [alice] }),
    );
  assert.deepEqual(meeting.invitedUserIds, [alice]);
  assert.deepEqual((await f.open().service.get(owner, meeting.id)).meeting.invitedUserIds, [alice]);
  f.removed.add(alice);
  await f.service.memberRemoved(alice, "departed");
  assert.deepEqual((await f.service.get(owner, meeting.id)).meeting.invitedUserIds, []);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE version=7 AND name='meeting-invites'",
      )
      .get().n,
    1,
  );
});

test("withdrawn invitation removes its reservation, cancels reminders and promotes FIFO once", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(
      owner,
      "private",
      f.draft({ visibility: "private", capacity: 2, invitedUserIds: [alice, bob, carol] }),
    );
  f.setEligible((userId, value) => userId === owner || value.invitedUserIds.includes(userId));
  await f.service.join(alice, "alice", meeting.id);
  await f.service.join(bob, "bob", meeting.id);
  await f.service.join(carol, "carol", meeting.id);
  const audience = { invitedUserIds: [bob, carol], allowedRoleIds: [] };
  const changed = await f.service.updateAudience(
    owner,
    "withdraw",
    meeting.id,
    meeting.revision,
    audience,
  );
  assert.equal(person(changed, alice).state, "left");
  assert.equal(person(changed, alice).leftReason, "ineligible");
  assert.equal(person(changed, bob).state, "confirmed");
  assert.equal(person(changed, carol).state, "waitlisted");
  assert.ok(
    changed.jobs
      .filter((job) => job.payload.recipientId === alice)
      .every((job) => job.state === "cancelled"),
  );
  await f.service.updateAudience(owner, "withdraw", meeting.id, meeting.revision, audience);
  assert.equal(f.jobs.list({ type: "meeting.promoted", objectId: meeting.id }).length, 1);
  await assert.rejects(
    f.service.updateAudience(owner, "stale", meeting.id, meeting.revision, audience),
    code("revision_conflict"),
  );
});

test("invitation changes are fenced by concurrent roster changes and lookup failures roll back", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(
      owner,
      "private",
      f.draft({ visibility: "private", invitedUserIds: [alice] }),
    );
  await f.service.join(alice, "join", meeting.id);
  const original = (await f.service.get(owner, meeting.id)).meeting;
  f.setEligible(async () => {
    assert.equal(f.store.db.isTransaction, false);
    throw Error("lookup unavailable");
  });
  await assert.rejects(
    f.service.updateAudience(owner, "failure", meeting.id, original.revision, {
      invitedUserIds: [],
      allowedRoleIds: [],
    }),
    /lookup unavailable/,
  );
  assert.deepEqual((await f.service.get(owner, meeting.id)).meeting.invitedUserIds, [alice]);
  let mutate = true;
  f.setEligible(async () => {
    if (mutate) {
      mutate = false;
      await f.open().service.join(bob, "concurrent", meeting.id);
    }
    return true;
  });
  await assert.rejects(
    f.service.updateAudience(owner, "race", meeting.id, original.revision, {
      invitedUserIds: [],
      allowedRoleIds: [],
    }),
    code("revision_conflict"),
  );
  assert.deepEqual((await f.service.get(owner, meeting.id)).meeting.invitedUserIds, [alice]);
});

test("active audience changes preserve the owned room and existing generation receipts", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(
      owner,
      "private",
      f.draft({ visibility: "private", room: { kind: "create", categoryId: roomId } }),
    );
  await f.service.transition(owner, "start", meeting.id, meeting.revision, "start");
  const [job] = f.jobs.claim({ types: ["meeting.start"], limit: 1 });
  const active = f.service.recordResult(job, { roomChannelId: roomId, roomCreatedByBot: true });
  const changed = await f.service.updateAudience(
    owner,
    "invite",
    meeting.id,
    active.meeting.revision,
    { invitedUserIds: [alice], allowedRoleIds: [] },
  );
  assert.equal(changed.meeting.state, "active");
  assert.equal(changed.meeting.generation, active.meeting.generation);
  assert.equal(changed.meeting.roomChannelId, roomId);
  assert.equal(changed.meeting.roomCreatedByBot, true);
  assert.deepEqual(changed.meeting.invitedUserIds, [alice]);
});

test("module-off removal defers promotion and notification until an idempotent fresh reconciliation", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ capacity: 1 }));
  await f.service.join(alice, "alice", meeting.id);
  const before = f.jobs.list({ objectId: meeting.id }).length;
  f.setEligible(() => {
    throw Error("disabled must not look up the reserve");
  });
  const [removed] = await f.service.memberRemoved(
    owner,
    "off-removal",
    Number.MAX_SAFE_INTEGER,
    false,
  );
  assert.equal(person(removed, alice).state, "waitlisted");
  assert.equal(f.jobs.list({ objectId: meeting.id }).length, before);
  f.setEligible(() => true);
  const resumed = await f.service.reconcileParticipants(meeting.id, "enabled-revision-3");
  assert.equal(person(resumed, alice).state, "confirmed");
  await f.service.reconcileParticipants(meeting.id, "enabled-revision-3");
  assert.equal(f.jobs.list({ objectId: meeting.id, type: "meeting.promoted" }).length, 1);
});

test("moving a published card clears its binding and queues only confirmed old controls", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft());
  const [job] = f.jobs.claim({ types: ["meeting.publish"], limit: 1 });
  f.jobs.beginAttempt(job.id, job.leaseToken, { channelId, nonce: "meeting-proof" });
  const published = f.service.recordResult(job, { messageId: roomId });
  f.jobs.complete(job.id, job.leaseToken, { messageId: roomId });
  const moved = await f.service.update(
    owner,
    "move",
    meeting.id,
    published.meeting.revision,
    f.draft({ channelId: bob }),
  );
  assert.equal(moved.meeting.messageId, null);
  const cleanup = moved.jobs.find((item) => item.type === "community.meeting-controls-clear");
  assert.equal(cleanup.payload.channelId, channelId);
  assert.equal(cleanup.payload.messageId, roomId);
  assert.equal(cleanup.payload.sourceJobId, job.id);
  assert.ok(moved.jobs.some((item) => item.type === "meeting.publish" && item.state === "pending"));
});

test("a public card cannot be relabelled private after an actual or uncertain publication", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft());
  const [job] = f.jobs.claim({ types: ["meeting.publish"], limit: 1 });
  f.jobs.beginAttempt(job.id, job.leaseToken, { channelId, nonce: "uncertain-proof" });
  f.jobs.unknown(job.id, job.leaseToken, "network_disconnected");
  await assert.rejects(
    f.service.update(
      owner,
      "make-private",
      meeting.id,
      meeting.revision,
      f.draft({ visibility: "private", invitedUserIds: [alice] }),
    ),
    code("visibility_conflict"),
  );
  assert.equal((await f.service.get(owner, meeting.id)).meeting.visibility, "public");
});

test("an expired reconciliation execution cannot commit a late eligibility result", async (t) => {
  const f = fixture(t),
    { meeting } = await f.service.create(owner, "create", f.draft({ capacity: 1 }));
  await f.service.join(alice, "reserve", meeting.id);
  await f.service.memberRemoved(owner, "off-remove", Number.MAX_SAFE_INTEGER, false);
  const before = f.service.systemDetail(meeting.id),
    jobs = f.jobs.list({ objectId: meeting.id });
  let checked = false;
  f.setEligible(async () => {
    checked = true;
    assert.equal(f.store.db.isTransaction, false);
    return true;
  });
  await assert.rejects(
    f.service.reconcileParticipants(meeting.id, "expired-run", () => {
      throw new MeetingError("stale_job");
    }),
    code("stale_job"),
  );
  assert.equal(checked, true);
  assert.deepEqual(f.service.systemDetail(meeting.id), before);
  assert.deepEqual(f.jobs.list({ objectId: meeting.id }), jobs);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE request_id='expired-run'")
      .get().n,
    0,
  );
});
