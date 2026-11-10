import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { join } from "node:path";
import ts from "typescript";

const source = ts.createSourceFile(
  "main.ts",
  readFileSync(new URL("../src/bot/main.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
let declaration, timerBranch;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "maintainRulesDeletionJournal")
    declaration = node;
  if (
    ts.isIfStatement(node) &&
    node.expression.getText(source).includes("deletionProofBusy") &&
    node.thenStatement.getText(source).includes("maintainRulesDeletionJournal")
  )
    timerBranch = node;
  ts.forEachChild(node, visit);
}
visit(source);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  assert.ok(declaration, "Missing actual main journal-maintenance function");
  assert.ok(timerBranch, "Missing actual main timer journal branch");
  const tracked = [],
    activities = [],
    events = [],
    stores = new Map([
      ["guild-a", { db: { id: "a" } }],
      ["guild-b", { db: { id: "b" } }],
    ]);
  const ports = {
    dataRoot: "/private/data",
    stores,
    openingStores: new Map(),
    changing: new Set(),
    ownsDataRoot: true,
    Date: { now: () => 10000 },
    join,
    existsSync: () => true,
    errorCode: (error) => error.code ?? error.message,
    pruneRulesDeletionJournal: async () => {
      events.push("prune");
    },
    drainRulesDeletionOutbox: async (input) => {
      events.push("drain");
      assert.deepEqual(
        input.stores.map((s) => [s.guildId, s.jobs.db.id]),
        [
          ["guild-a", "a"],
          ["guild-b", "b"],
        ],
      );
      return { pending: false };
    },
    JobStore: class {
      constructor(db) {
        events.push("jobstore:" + db.id);
        this.db = db;
      }
    },
    guildActivity: {
      track(guildId, promise) {
        activities.push({ guildId, promise });
      },
    },
    track(promise) {
      tracked.push(promise);
      return promise;
    },
    ...overrides,
  };
  const functions = ts.transpileModule(
    `${declaration.getText(source)}\nfunction tick(){${timerBranch.getText(source)}}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  // Instantiate the current main source with controlled ports, never import its executable entrypoint.
  const factory = new Function(
    ...Object.keys(ports),
    `let deletionProofBusy=false,deletionProofAt=0,deletionProofState='uninitialized',deletionProofCode='source_uninitialized';${functions};return{tick,state(){return{busy:deletionProofBusy,at:deletionProofAt,state:deletionProofState,code:deletionProofCode}}}`,
  );
  return { runtime: factory(...Object.values(ports)), ports, tracked, activities, events };
}

test("changing or opening inventory cannot suppress independent journal TTL pruning", async () => {
  for (const field of ["changing", "openingStores"]) {
    const blocked =
        field === "changing" ? new Set(["guild-a"]) : new Map([["guild-a", Promise.resolve()]]),
      f = fixture({ [field]: blocked });
    f.runtime.tick();
    assert.equal(f.tracked.length, 1);
    await f.tracked[0];
    assert.deepEqual(f.events, ["prune"]);
    assert.deepEqual(f.runtime.state(), {
      busy: false,
      at: 70000,
      state: "blocked",
      code: "inventory_changing",
    });
    assert.deepEqual(
      f.activities.map((a) => a.guildId),
      ["guild-a", "guild-b"],
    );
  }
});
test("a JobStore constructor exception is contained and resets busy instead of escaping the timer", async () => {
  const error = Object.assign(Error("fixture SQLite failure"), { code: "SQLITE_BUSY" }),
    f = fixture({
      JobStore: class {
        constructor() {
          throw error;
        }
      },
    });
  assert.doesNotThrow(() => f.runtime.tick());
  assert.equal(f.tracked.length, 1);
  await assert.doesNotReject(f.tracked[0]);
  assert.deepEqual(f.events, ["prune"]);
  assert.deepEqual(f.runtime.state(), {
    busy: false,
    at: 70000,
    state: "blocked",
    code: "SQLITE_BUSY",
  });
});
test("a pending durable backlog requests another five-second attempt with the complete store snapshot", async () => {
  let received;
  const f = fixture({
    drainRulesDeletionOutbox: async (input) => {
      received = input;
      return { pending: true };
    },
  });
  f.runtime.tick();
  await f.tracked[0];
  assert.equal(received.stores.length, 2);
  assert.deepEqual(
    received.stores.map((s) => s.guildId),
    ["guild-a", "guild-b"],
  );
  assert.deepEqual(f.runtime.state(), {
    busy: false,
    at: 15000,
    state: "blocked",
    code: "source_incomplete",
  });
});
test("missing journal stays uninitialized without constructing a JobStore and still clears busy", async () => {
  const f = fixture({ existsSync: () => false });
  f.runtime.tick();
  await f.tracked[0];
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.runtime.state(), {
    busy: false,
    at: 70000,
    state: "uninitialized",
    code: "source_uninitialized",
  });
});
test("a prune failure remains blocked, never drains SQLite and releases the maintenance slot", async () => {
  const f = fixture({
    pruneRulesDeletionJournal: async () => {
      throw Object.assign(Error("fixture"), { code: "source_gap" });
    },
  });
  f.runtime.tick();
  await assert.doesNotReject(f.tracked[0]);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.runtime.state(), {
    busy: false,
    at: 70000,
    state: "blocked",
    code: "source_gap",
  });
});
test("each source activity and global shutdown track the full prune-plus-drain promise", async () => {
  const prune = deferred(),
    drain = deferred();
  let drainStarted = false,
    finished = false;
  const f = fixture({
    pruneRulesDeletionJournal: () => prune.promise,
    drainRulesDeletionOutbox: () => {
      drainStarted = true;
      return drain.promise;
    },
  });
  f.runtime.tick();
  assert.equal(f.tracked.length, 1);
  assert.equal(f.activities.length, 2);
  for (const activity of f.activities) assert.equal(activity.promise, f.tracked[0]);
  const completion = f.tracked[0].then(() => {
    finished = true;
  });
  f.runtime.tick();
  assert.equal(f.tracked.length, 1);
  prune.resolve();
  await Promise.resolve();
  assert.equal(drainStarted, true);
  assert.equal(finished, false);
  assert.equal(f.runtime.state().busy, true);
  drain.resolve({ pending: false });
  await completion;
  assert.equal(finished, true);
  assert.deepEqual(f.runtime.state(), { busy: false, at: 70000, state: "ready", code: null });
});
