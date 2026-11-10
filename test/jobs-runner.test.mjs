import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { JobStore } from "../dist/core/jobs/store.js";
import { JobRunner } from "../dist/core/jobs/runner.js";
import { publishDiscord, deliveryNonce } from "../dist/core/delivery/discord.js";
import { RateLimitError } from "discord.js";

const guilds = ["100000000000000001", "100000000000000002", "100000000000000003"];
const channelId = "200000000000000001",
  messageId = "300000000000000001";
function fixture(t, count = 1) {
  let now = 10000;
  const sources = guilds.slice(0, count).map((guildId) => {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    return { guildId, store: new JobStore(db, () => now), available: () => true };
  });
  const add = (index = 0, suffix = "one") =>
    sources[index].store.enqueue({
      guildId: sources[index].guildId,
      type: "announcement.send",
      payload: {},
      dueAt: now,
      dedupeKey: suffix,
    });
  return {
    sources,
    add,
    clock: () => now,
    advance: (value) => {
      now += value;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const publication = (guildId = guilds[0]) => ({
  guildId,
  channelId,
  content: "Próba",
  roleIds: [],
  everyone: false,
});

test("guild suspension waits for the actual late handler before allowing its database to close", async (t) => {
  const f = fixture(t, 2),
    gate = deferred(),
    first = f.add(0),
    second = f.add(1);
  let firstSends = 0;
  const runner = new JobRunner(
    () => f.sources,
    async (job, execution) => {
      if (job.guildId !== guilds[0]) return { state: "succeeded" };
      firstSends++;
      execution.beginAttempt({ channelId, nonce: "one-send" });
      await gate.promise;
      return { state: "succeeded", messageId };
    },
    { clock: f.clock, stopTimeoutMs: 10 },
  );
  t.after(() => runner.stop());
  const work = runner.tick();
  assert.equal(await runner.suspendGuild(guilds[0]), false);
  await work;
  assert.equal(f.sources[0].store.get(first.id).state, "unknown");
  assert.equal(f.sources[1].store.get(second.id).state, "succeeded");
  assert.equal(await runner.tick(), 0);
  gate.resolve();
  assert.equal(await runner.suspendGuild(guilds[0]), true);
  assert.equal(f.sources[0].store.attempts(first.id)[0].messageId, messageId);
  assert.equal(firstSends, 1);
});

test("an idle suspended guild stays fenced until explicitly resumed without blocking another guild", async (t) => {
  const f = fixture(t, 2),
    first = f.add(0),
    second = f.add(1);
  const runner = new JobRunner(
    () => f.sources,
    async () => ({ state: "succeeded" }),
    {
      clock: f.clock,
    },
  );
  t.after(() => runner.stop());
  assert.equal(await runner.suspendGuild(guilds[0]), true);
  assert.equal(await runner.tick(), 1);
  assert.equal(f.sources[0].store.get(first.id).state, "pending");
  assert.equal(f.sources[1].store.get(second.id).state, "succeeded");
  runner.resumeGuild(guilds[0]);
  assert.equal(await runner.tick(), 1);
  assert.equal(f.sources[0].store.get(first.id).state, "succeeded");
});

test("real SDK rate limits retain millisecond delays and do not consume ordinary failures", async (t) => {
  for (const phase of ["check", "send"])
    await t.test(phase, async (t) => {
      const f = fixture(t);
      const job = f.add();
      const error = new RateLimitError({
        timeToReset: 900,
        retryAfter: 1200,
        sublimitTimeout: 2500,
        limit: 1,
        method: "POST",
        hash: "example",
        url: "https://discord.com/api/channels/example/messages",
        route: "/channels/:id/messages",
        majorParameter: channelId,
        global: false,
        scope: "user",
      });
      assert.match(error.name, /^RateLimitError\[/);
      const runner = new JobRunner(
        () => f.sources,
        (current, execution) =>
          publishDiscord(current.id, publication(), execution, {
            check: async () => {
              if (phase === "check") throw error;
            },
            send: async () => {
              throw error;
            },
          }),
        { clock: f.clock },
      );
      await runner.tick();
      assert.equal(f.sources[0].store.get(job.id).state, "retry");
      assert.equal(f.sources[0].store.get(job.id).failures, 0);
      assert.equal(f.sources[0].store.get(job.id).nextAttemptAt, f.clock() + 2500);
      assert.equal(f.sources[0].store.attempts(job.id).length, phase === "check" ? 0 : 1);
      if (phase === "send")
        assert.equal(f.sources[0].store.attempts(job.id)[0].state, "rate_limited");
      await runner.stop();
    });
});

test("408 and server errors after sending remain uncertain and are never retried blindly", async (t) => {
  for (const status of [408, 500, 503])
    await t.test(String(status), async (t) => {
      const f = fixture(t);
      const job = f.add();
      let sends = 0;
      const runner = new JobRunner(
        () => f.sources,
        (current, execution) =>
          publishDiscord(current.id, publication(), execution, {
            check: async () => {},
            send: async () => {
              sends++;
              throw { status };
            },
          }),
        { clock: f.clock },
      );
      await runner.tick();
      assert.equal(f.sources[0].store.get(job.id).state, "unknown");
      f.advance(100000);
      assert.equal(await runner.tick(), 0);
      assert.equal(sends, 1);
      await runner.stop();
    });
});

test(
  "execution timeout fences an ignored abort and frees global slots for other guilds",
  { timeout: 2000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const f = fixture(t, 3);
    f.add(0);
    f.add(1);
    const third = f.add(2);
    const gates = [deferred(), deferred()];
    const contexts = [],
      seen = [];
    let sends = 0;
    const runner = new JobRunner(
      () => f.sources,
      async (job, context) => {
        seen.push(job.guildId);
        const index = guilds.indexOf(job.guildId);
        if (index < 2) {
          contexts[index] = context;
          await gates[index].promise;
          context.checkpoint();
          context.beginAttempt();
          sends++;
        }
        return { state: "succeeded" };
      },
      { clock: f.clock, concurrency: 2, executionTimeoutMs: 50 },
    );
    const first = runner.tick();
    t.mock.timers.tick(50);
    assert.equal(await first, 2);
    for (const context of contexts) {
      assert.equal(context.signal.aborted, true);
      assert.throws(() => context.checkpoint());
      assert.throws(() => context.beginAttempt());
    }
    assert.equal(await runner.tick(), 1);
    assert.equal(f.sources[2].store.get(third.id).state, "succeeded");
    assert.deepEqual(seen, guilds);
    gates.forEach((gate) => gate.resolve());
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sends, 0);
    assert.equal(f.sources[0].store.list()[0].state, "retry");
    assert.equal(f.sources[0].store.attempts(f.sources[0].store.list()[0].id).length, 0);
    await runner.stop();
  },
);

test(
  "stopping does not await a handler which ignores cancellation",
  { timeout: 2000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const f = fixture(t);
    const job = f.add();
    const gate = deferred();
    let context;
    const runner = new JobRunner(
      () => f.sources,
      async (_job, execution) => {
        context = execution;
        await gate.promise;
        execution.beginAttempt();
        return { state: "succeeded" };
      },
      { clock: f.clock, stopTimeoutMs: 20 },
    );
    const work = runner.tick();
    await runner.stop();
    assert.equal(await work, 1);
    assert.equal(context.signal.aborted, true);
    assert.equal(f.sources[0].store.get(job.id).state, "retry");
    assert.throws(() => context.beginAttempt());
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.sources[0].store.attempts(job.id).length, 0);
    assert.equal(await runner.tick(), 0);
  },
);

test(
  "a timed-out send can record its late receipt without repeating or silently completing the job",
  { timeout: 2000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const f = fixture(t);
    const job = f.add();
    const gate = deferred();
    let sent = 0;
    const runner = new JobRunner(
      () => f.sources,
      async (_job, context) => {
        context.beginAttempt({ channelId, nonce: "stable" });
        sent++;
        await gate.promise;
        return { state: "succeeded", messageId };
      },
      { clock: f.clock, executionTimeoutMs: 50 },
    );
    const work = runner.tick();
    t.mock.timers.tick(50);
    await work;
    const unknown = f.sources[0].store.get(job.id);
    assert.equal(unknown.state, "unknown");
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(f.sources[0].store.get(job.id), unknown);
    assert.equal(f.sources[0].store.attempts(job.id)[0].messageId, messageId);
    assert.equal(f.sources[0].store.attempts(job.id)[0].state, "succeeded");
    f.advance(100000);
    assert.equal(await runner.tick(), 0);
    assert.equal(sent, 1);
    await runner.stop();
  },
);

test("a successful response after lease expiry is preserved before recovery without another send", async (t) => {
  const f = fixture(t);
  const job = f.add();
  let sent = 0;
  const runner = new JobRunner(
    () => f.sources,
    async (_job, context) => {
      context.beginAttempt({ channelId, nonce: "stable" });
      sent++;
      f.advance(31000);
      return { state: "succeeded", messageId };
    },
    { clock: f.clock },
  );
  await runner.tick();
  assert.equal(f.sources[0].store.attempts(job.id)[0].messageId, messageId);
  assert.equal(await runner.tick(), 0);
  assert.equal(f.sources[0].store.get(job.id).state, "unknown");
  assert.equal(sent, 1);
  await runner.stop();
});

test("cancellation after delivery begins keeps the successful confirmation", async (t) => {
  const f = fixture(t);
  const job = f.add();
  const gate = deferred();
  const runner = new JobRunner(
    () => f.sources,
    async (_job, context) => {
      context.beginAttempt({ channelId });
      await gate.promise;
      return { state: "succeeded", messageId };
    },
    { clock: f.clock },
  );
  const work = runner.tick();
  f.sources[0].store.cancel(job.id);
  gate.resolve();
  await work;
  assert.equal(f.sources[0].store.get(job.id).state, "succeeded");
  assert.equal(f.sources[0].store.get(job.id).cancelRequested, true);
  assert.equal(f.sources[0].store.attempts(job.id)[0].messageId, messageId);
  await runner.stop();
});

test("runner rotates guilds, bounds concurrency and never runs two tasks of one guild together", async (t) => {
  const f = fixture(t, 3);
  for (let index = 0; index < 3; index++) {
    f.add(index);
    f.add(index, "two");
  }
  const seen = [],
    held = [];
  const runner = new JobRunner(
    () => f.sources,
    async (job) => {
      seen.push(job.guildId);
      await new Promise((resolve) => held.push(resolve));
      return { state: "succeeded" };
    },
    { clock: f.clock, concurrency: 2 },
  );
  const first = runner.tick();
  assert.deepEqual(seen, guilds.slice(0, 2));
  assert.equal(await runner.tick(), 0);
  held.splice(0).forEach((resolve) => resolve());
  assert.equal(await first, 2);
  const second = runner.tick();
  assert.deepEqual(seen.slice(2), [guilds[2], guilds[0]]);
  held.splice(0).forEach((resolve) => resolve());
  await second;
  await runner.stop();
});

test("failure before external delivery retries safely but failure after starting delivery stays unknown", async (t) => {
  const f = fixture(t);
  const first = f.add();
  let afterSend = false;
  const runner = new JobRunner(
    () => f.sources,
    async (_job, execution) => {
      if (afterSend) execution.beginAttempt({ channelId, nonce: "1" });
      throw Error("do not persist a private payload in the error");
    },
    { clock: f.clock, random: () => 0 },
  );
  await runner.tick();
  assert.equal(f.sources[0].store.get(first.id).state, "retry");
  assert.equal(f.sources[0].store.get(first.id).lastError, "Error");
  f.advance(5000);
  afterSend = true;
  await runner.tick();
  assert.equal(f.sources[0].store.get(first.id).state, "unknown");
  f.advance(100000);
  assert.equal(await runner.tick(), 0);
  assert.equal(f.sources[0].store.attempts(first.id).length, 1);
  await runner.stop();
});

test("an unavailable guild does not block another guild and cannot send a claimed publication", async (t) => {
  const f = fixture(t, 2);
  f.add(0);
  const second = f.add(1);
  f.sources[0].available = () => false;
  const seen = [];
  const runner = new JobRunner(
    () => f.sources,
    async (job) => {
      seen.push(job.guildId);
      return { state: "succeeded" };
    },
    { clock: f.clock },
  );
  await runner.tick();
  assert.deepEqual(seen, [guilds[1]]);
  assert.equal(f.sources[1].store.get(second.id).state, "succeeded");
  await runner.stop();
});

test("publication stores a durable nonce and explicit mentions without repeating an uncertain request", async (t) => {
  const f = fixture(t);
  const job = f.add();
  const publication = {
    guildId: guilds[0],
    channelId,
    content: "Wiadomość",
    roleIds: [],
    everyone: false,
  };
  let sent = 0,
    recorded;
  const runner = new JobRunner(
    () => f.sources,
    (current, execution) =>
      publishDiscord(current.id, publication, execution, {
        check: async () => {},
        send: async (_input, options) => {
          sent++;
          recorded = options;
          throw Object.assign(Error("timeout"), { status: 504 });
        },
      }),
    { clock: f.clock },
  );
  await runner.tick();
  assert.equal(f.sources[0].store.get(job.id).state, "unknown");
  assert.equal(recorded.enforceNonce, true);
  assert.equal(recorded.nonce, deliveryNonce(job.id));
  assert.equal(f.sources[0].store.attempts(job.id)[0].nonce, recorded.nonce);
  f.advance(600000);
  await runner.tick();
  assert.equal(sent, 1);
  await runner.stop();
});

test("429 postpones delivery by the server's interval without spending ordinary failures", async (t) => {
  const f = fixture(t);
  const job = f.add();
  const publication = {
    guildId: guilds[0],
    channelId,
    content: "Wiadomość",
    roleIds: [],
    everyone: false,
  };
  let limited = true;
  const runner = new JobRunner(
    () => f.sources,
    (current, execution) =>
      publishDiscord(current.id, publication, execution, {
        check: async () => {},
        send: async () => {
          if (limited) throw { status: 429, rawError: { retry_after: 1.5 } };
          return { id: messageId };
        },
      }),
    { clock: f.clock },
  );
  await runner.tick();
  const deferred = f.sources[0].store.get(job.id);
  assert.equal(deferred.nextAttemptAt, f.clock() + 1500);
  assert.equal(deferred.failures, 0);
  assert.equal(f.sources[0].store.attempts(job.id)[0].state, "rate_limited");
  assert.equal(await runner.tick(), 0);
  limited = false;
  f.advance(1500);
  await runner.tick();
  assert.equal(f.sources[0].store.get(job.id).messageId, messageId);
  await runner.stop();
});

test("a transient preflight failure is retryable and a removed channel never sends", async (t) => {
  const f = fixture(t);
  const job = f.add();
  let status = 503,
    sent = 0;
  const publication = {
    guildId: guilds[0],
    channelId,
    content: "Wiadomość",
    roleIds: [],
    everyone: false,
  };
  const runner = new JobRunner(
    () => f.sources,
    (current, execution) =>
      publishDiscord(current.id, publication, execution, {
        check: async () => {
          throw { status };
        },
        send: async () => {
          sent++;
          return { id: messageId };
        },
      }),
    { clock: f.clock, random: () => 0 },
  );
  await runner.tick();
  assert.equal(f.sources[0].store.get(job.id).state, "retry");
  status = 404;
  f.advance(5000);
  await runner.tick();
  assert.equal(f.sources[0].store.get(job.id).state, "failed");
  assert.equal(sent, 0);
  assert.equal(f.sources[0].store.attempts(job.id).length, 0);
  await runner.stop();
});
