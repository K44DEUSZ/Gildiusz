import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Store } from "../dist/storage/store.js";
import { JobStore, JobError } from "../dist/core/jobs/store.js";
import { CaseService, CaseError } from "../dist/modules/cases/service.js";
import { casesMigration } from "../dist/modules/cases/schema.js";

const guildId = "800000000000000001",
  author = "800000000000000002",
  staff = "800000000000000003",
  other = "800000000000000004",
  secondStaff = "800000000000000005",
  admin = "800000000000000006",
  staffRole = "800000000000000007",
  channelId = "800000000000000008";
const code = (expected) => (error) => error instanceof CaseError && error.code === expected;
const draft = (kind = "report", extra = {}) => ({
  kind,
  title: "Pomoc przy projekcie",
  content: "Potrzebuję odpowiedzi w mojej sprawie.",
  ...extra,
});
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-cases-")),
    path = join(directory, "guild.sqlite"),
    stores = [],
    requests = [],
    facts = new Map();
  let now = Date.parse("2026-11-09T12:00:00Z"),
    hook = async () => {};
  for (const userId of [author, staff, other, secondStaff, admin])
    facts.set(userId, {
      guildId,
      userId,
      owner: userId === admin,
      manageGuild: false,
      pending: false,
      timedOut: false,
      isBot: false,
      roleIds: [staff, secondStaff].includes(userId) ? [staffRole] : [],
    });
  const open = () => {
    const store = new Store(path, guildId);
    const installed = store.db
      .prepare("SELECT name FROM schema_migrations WHERE version=?")
      .get(casesMigration.version);
    assert.equal(installed?.name, casesMigration.name);
    const jobs = new JobStore(store.db, () => now),
      service = new CaseService(jobs, {
        ...options,
        guildId,
        clock: () => now,
        authorize: async (request) => {
          requests.push(request);
          await hook(request);
          return {
            member: { ...facts.get(request.actorId) },
            policy: { guildId, caseModeratorRoleIds: [staffRole] },
          };
        },
      });
    stores.push(store);
    return { store, jobs, service };
  };
  t.after(() => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* Restart fixture. */
      }
    }
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gildiusz-cases-")
    )
      throw Error("Unexpected test directory.");
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...open(),
    open,
    path,
    requests,
    now: () => now,
    advance: (value) => {
      now += value;
    },
    setFacts: (actor, extra) => facts.set(actor, { ...facts.get(actor), ...extra }),
    setHook: (value) => {
      hook = value;
    },
    confirm: (scope) => ({ ...scope, confirmed: true, channelId }),
  };
}
function claimCase(f, id) {
  return f.jobs.claim({ limit: 10, types: ["case.notify"] }).find((job) => job.objectId === id);
}

test("reports and questions are private and lists apply current authorization to each object", async (t) => {
  const f = fixture(t);
  const report = await f.service.create(author, "report", draft());
  const question = await f.service.create(other, "question", draft("question"));
  assert.equal(report.case.visibility, "private");
  assert.equal(question.case.visibility, "private");
  assert.equal((await f.service.list(author)).length, 1);
  assert.equal((await f.service.list(staff)).length, 2);
  assert.deepEqual(
    (await f.service.list(author)).map((value) => value.id),
    [report.case.id],
  );
  await assert.rejects(f.service.get(other, report.case.id), code("permission_revoked"));
  assert.equal((await f.service.get(author, report.case.id)).case.content, report.case.content);
  assert.ok(
    f.requests.some(
      (request) => request.operation === "cases.read" && request.object?.ownerId === author,
    ),
  );
  f.setFacts(staff, { roleIds: [] });
  assert.deepEqual(await f.service.list(staff), []);
});

test("a failed post-apply authority fence rolls back content, hook jobs and idempotency together", async (t) => {
  const f = fixture(t);
  let allowed = true,
    revokeInHook = true,
    transactionalChecks = 0;
  const service = new CaseService(f.jobs, {
    guildId,
    clock: f.now,
    authorize: ({ actorId }) => ({
      member: {
        guildId,
        userId: actorId,
        owner: true,
        manageGuild: false,
        pending: false,
        timedOut: false,
        isBot: false,
        roleIds: [],
      },
      policy: { guildId },
      assertCurrent: () => {
        if (f.store.db.isTransaction) transactionalChecks++;
        if (!allowed) throw new CaseError("permission_revoked");
      },
    }),
    onCreated: (value) => {
      f.jobs.enqueue({
        guildId,
        type: "fixture.created",
        objectId: value.id,
        dueAt: f.now(),
        dedupeKey: "hook-" + value.id,
        payload: { caseId: value.id },
      });
      if (revokeInHook) allowed = false;
    },
  });
  await assert.rejects(
    service.create(author, "atomic-authority-guard", draft()),
    code("permission_revoked"),
  );
  assert.equal(transactionalChecks, 2);
  for (const table of ["cases", "case_events", "case_actions", "jobs", "idempotency_keys"])
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  allowed = true;
  revokeInHook = false;
  const result = await service.create(author, "atomic-authority-guard", draft());
  assert.equal(
    (await service.create(author, "atomic-authority-guard", draft())).case.id,
    result.case.id,
  );
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM cases").get().n, 1);
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("an asynchronous authority guard is rejected before any case write", async (t) => {
  const f = fixture(t);
  const service = new CaseService(f.jobs, {
    guildId,
    authorize: ({ actorId }) => ({
      member: {
        guildId,
        userId: actorId,
        owner: true,
        manageGuild: false,
        pending: false,
        timedOut: false,
        isBot: false,
        roleIds: [],
      },
      policy: { guildId },
      assertCurrent: async () => {},
    }),
  });
  await assert.rejects(
    service.create(author, "async-guard", draft()),
    /guards must be synchronous/,
  );
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM cases").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM idempotency_keys").get().n, 0);
});

test("author, staff and public views never contain internal notes; notes require a separate staff action", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(author, "create", draft());
  const noted = await f.service.note(staff, "note", saved.case.id, 1, "INTERNAL_SECRET");
  assert.equal(noted.job, null);
  const replied = await f.service.reply(staff, "reply", saved.case.id, 2, "Odpowiedź dla autora");
  assert.equal(f.jobs.list().length, 2);
  for (const actor of [author, staff]) {
    assert.ok(
      !JSON.stringify(await f.service.get(actor, saved.case.id)).includes("INTERNAL_SECRET"),
    );
    assert.ok(!JSON.stringify(await f.service.list(actor)).includes("INTERNAL_SECRET"));
  }
  await assert.rejects(f.service.notes(author, saved.case.id), code("permission_revoked"));
  assert.equal((await f.service.notes(staff, saved.case.id))[0].content, "INTERNAL_SECRET");
  const lease = claimCase(f, saved.case.id);
  const secondLease = f.jobs
    .list({ objectId: saved.case.id, states: ["running"] })
    .find((job) => job.id === replied.job.id);
  const prepared = await f.service.prepareNotification(secondLease, f.confirm);
  assert.ok(prepared.content.includes("Odpowiedź dla autora"));
  assert.ok(!prepared.content.includes("INTERNAL_SECRET"));
  assert.equal(prepared.audience, "author");
  assert.ok(lease);
});

test("approval publishes only the suggestion and leaves its earlier private replies private", async (t) => {
  const f = fixture(t, { voting: { enabled: true, statuses: ["new", "in_review"] } });
  const saved = await f.service.create(author, "create", draft("suggestion"));
  assert.equal(saved.case.visibility, "private");
  await assert.rejects(f.service.get(other, saved.case.id), code("permission_revoked"));
  await assert.rejects(f.service.vote(author, "vote", saved.case.id, 1), code("approval_required"));
  await assert.rejects(
    f.service.vote(other, "hidden-vote", saved.case.id, 1),
    code("permission_revoked"),
  );
  await f.service.reply(author, "private-reply", saved.case.id, 1, "PRIVATE_CONVERSATION");
  const approved = await f.service.approve(staff, "approve", saved.case.id, 2);
  assert.equal(approved.case.visibility, "public");
  assert.equal(f.jobs.get(saved.job.id).state, "cancelled");
  const publicView = await f.service.get(other, saved.case.id);
  assert.equal(publicView.case.content, saved.case.content);
  assert.deepEqual(publicView.messages, []);
  assert.ok(!JSON.stringify(publicView).includes("PRIVATE_CONVERSATION"));
  assert.equal((await f.service.get(author, saved.case.id)).messages.length, 1);
  await f.service.reply(
    other,
    "public-reply",
    saved.case.id,
    approved.case.revision,
    "PUBLIC_REPLY",
  );
  assert.equal((await f.service.get(other, saved.case.id)).messages[0].content, "PUBLIC_REPLY");
  await assert.rejects(
    f.service.approve(
      staff,
      "approve-report",
      (await f.service.create(author, "report", draft())).case.id,
      1,
    ),
    code("state_conflict"),
  );
});

test("read and write checks use fresh identities and reject timed out or mismatched actors", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(author, "create", draft());
  f.setFacts(staff, { timedOut: true });
  await assert.rejects(f.service.get(staff, saved.case.id), code("permission_revoked"));
  await assert.rejects(
    f.service.reply(staff, "reply", saved.case.id, 1, "Nie wolno"),
    code("permission_revoked"),
  );
  f.setFacts(author, { userId: other });
  await assert.rejects(f.service.get(author, saved.case.id), code("permission_revoked"));
  assert.equal(f.jobs.list().length, 1);
});

test("revisions reject concurrent replies and losing writes do not persist a message or notification", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(author, "create", draft());
  const replies = await Promise.allSettled([
    f.service.reply(author, "reply-owner", saved.case.id, 1, "Pierwsza odpowiedź"),
    f.service.reply(staff, "reply-staff", saved.case.id, 1, "Druga odpowiedź"),
  ]);
  assert.equal(replies.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    replies.find((result) => result.status === "rejected").reason.code,
    "revision_conflict",
  );
  assert.equal((await f.service.get(author, saved.case.id)).messages.length, 1);
  assert.equal(f.jobs.list().length, 2);
});

test("assignments require a currently eligible moderator and can be cleared", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(author, "create", draft());
  await assert.rejects(
    f.service.assign(staff, "bad-target", saved.case.id, 1, other),
    code("permission_revoked"),
  );
  f.setFacts(secondStaff, { pending: true });
  await assert.rejects(
    f.service.assign(staff, "pending-target", saved.case.id, 1, secondStaff),
    code("permission_revoked"),
  );
  f.setFacts(secondStaff, { pending: false });
  const assigned = await f.service.assign(staff, "assign", saved.case.id, 1, secondStaff);
  assert.equal(assigned.case.assigneeId, secondStaff);
  f.setFacts(secondStaff, { roleIds: [] });
  await assert.rejects(
    f.service.assign(staff, "revoked-target", saved.case.id, 2, secondStaff),
    code("permission_revoked"),
  );
  assert.equal(
    (await f.service.assign(staff, "clear", saved.case.id, 2, null)).case.assigneeId,
    null,
  );
});

test("type-specific transitions and reasons are enforced while authors cannot moderate status", async (t) => {
  const f = fixture(t, {
    suggestionVisibility: "immediate",
    reasonRequiredStatuses: ["accepted", "rejected"],
  });
  const report = await f.service.create(author, "report", draft());
  await assert.rejects(
    f.service.transition(author, "owner-transition", report.case.id, 1, { status: "resolved" }),
    code("permission_revoked"),
  );
  await assert.rejects(
    f.service.transition(staff, "wrong-kind", report.case.id, 1, { status: "accepted" }),
    code("state_conflict"),
  );
  const resolved = await f.service.transition(staff, "resolve", report.case.id, 1, {
    status: "resolved",
    reason: "Problem naprawiony",
  });
  assert.equal(resolved.case.status, "resolved");
  const closed = await f.service.transition(staff, "close", report.case.id, 2, {
    status: "closed",
  });
  assert.equal(closed.case.retentionAt, null);
  await assert.rejects(
    f.service.reply(author, "reply-closed", report.case.id, 3, "Jeszcze jedno"),
    code("state_conflict"),
  );
  const idea = await f.service.create(author, "idea", draft("suggestion"));
  await assert.rejects(
    f.service.transition(staff, "without-reason", idea.case.id, 1, { status: "accepted" }),
    code("invalid_input"),
  );
  const accepted = await f.service.transition(staff, "accept", idea.case.id, 1, {
    status: "accepted",
    reason: "Przyda się całej ekipie",
  });
  const implemented = await f.service.transition(
    staff,
    "implement",
    idea.case.id,
    accepted.case.revision,
    { status: "implemented" },
  );
  assert.equal(implemented.case.status, "implemented");
  await assert.rejects(
    f.service.transition(staff, "reopen", idea.case.id, implemented.case.revision, {
      status: "in_review",
    }),
    code("state_conflict"),
  );
});

test("votes upsert and withdraw by user without changing the content revision, and close by configured status", async (t) => {
  const f = fixture(t, {
    suggestionVisibility: "immediate",
    voting: { enabled: true, statuses: ["new"] },
  });
  const saved = await f.service.create(author, "idea", draft("suggestion"));
  const first = await f.service.vote(other, "vote-one", saved.case.id, 1);
  assert.deepEqual(await f.service.vote(other, "vote-one", saved.case.id, 1), first);
  assert.equal(first.votes.positive, 1);
  assert.equal((await f.service.vote(other, "vote-change", saved.case.id, -1)).votes.score, -1);
  assert.equal((await f.service.vote(other, "vote-withdraw", saved.case.id, null)).votes.total, 0);
  assert.equal((await f.service.get(author, saved.case.id)).case.revision, 1);
  await assert.rejects(
    f.service.vote(other, "vote-one", saved.case.id, -1),
    (error) => error instanceof JobError && error.code === "idempotency_conflict",
  );
  await f.service.transition(staff, "review", saved.case.id, 1, { status: "in_review" });
  await assert.rejects(
    f.service.vote(other, "closed-vote", saved.case.id, 1),
    code("voting_closed"),
  );
  await assert.rejects(
    f.service.vote(other, "closed-withdraw", saved.case.id, null),
    code("voting_closed"),
  );
});

test("case, event, action and durable notification roll back together if queue insertion fails", async (t) => {
  const f = fixture(t);
  f.store.db.exec(
    "CREATE TRIGGER fail_case_job BEFORE INSERT ON jobs WHEN NEW.type='case.notify' BEGIN SELECT RAISE(ABORT,'test queue failure'); END",
  );
  await assert.rejects(f.service.create(author, "create", draft()), /test queue failure/);
  for (const table of ["cases", "case_events", "case_actions", "idempotency_keys", "jobs"])
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  f.store.db.exec("DROP TRIGGER fail_case_job");
  assert.equal((await f.service.create(author, "create", draft())).case.revision, 1);
});

test("durable notes and replies survive restart while the author response remains redacted", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(author, "create", draft());
  await f.service.note(staff, "note", saved.case.id, 1, "STAFF_ONLY_PERSISTENT");
  const replied = await f.service.reply(staff, "reply", saved.case.id, 2, "Zapisana odpowiedź");
  f.store.close();
  const reopened = f.open();
  const own = await reopened.service.get(author, saved.case.id);
  assert.equal(own.messages.length, 1);
  assert.equal(own.messages[0].content, "Zapisana odpowiedź");
  assert.ok(!JSON.stringify(own).includes("STAFF_ONLY_PERSISTENT"));
  assert.equal(
    (await reopened.service.notes(staff, saved.case.id))[0].content,
    "STAFF_ONLY_PERSISTENT",
  );
  assert.deepEqual(
    await reopened.service.reply(staff, "reply", saved.case.id, 2, "Zapisana odpowiedź"),
    replied,
  );
});

test("notification content is withheld until a matching scoped ACL is confirmed", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(author, "create", draft());
  const lease = claimCase(f, saved.case.id);
  let seen;
  await assert.rejects(
    f.service.prepareNotification(lease, (scope) => {
      seen = scope;
      return { ...scope, confirmed: false, channelId };
    }),
    code("acl_unconfirmed"),
  );
  assert.deepEqual(Object.keys(seen).sort(), [
    "audience",
    "caseId",
    "generation",
    "guildId",
    "ownerId",
    "visibility",
  ]);
  assert.ok(!JSON.stringify(seen).includes(saved.case.content));
  await assert.rejects(
    f.service.prepareNotification(lease, (scope) => ({ ...f.confirm(scope), caseId: "other" })),
    code("acl_unconfirmed"),
  );
  const prepared = await f.service.prepareNotification(lease, f.confirm);
  assert.equal(prepared.content, `${saved.case.title}\n\n${saved.case.content}`);
  assert.deepEqual(prepared.roleIds, []);
  assert.equal(prepared.mentionEveryone, false);
  assert.deepEqual(f.jobs.attempts(lease.id), []);
});

test("notification scope cannot be widened and long messages are bounded without ping permissions", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(
    author,
    "create",
    draft("report", { content: "@everyone " + "x".repeat(3990) }),
  );
  const lease = claimCase(f, saved.case.id);
  assert.ok(!JSON.stringify(lease.payload).includes(saved.case.content));
  await assert.rejects(
    f.service.prepareNotification(lease, (scope) => ({
      ...f.confirm(scope),
      visibility: "public",
    })),
    code("acl_unconfirmed"),
  );
  await assert.rejects(
    f.service.prepareNotification(lease, (scope) => {
      scope.visibility = "public";
      return f.confirm(scope);
    }),
    TypeError,
  );
  const prepared = await f.service.prepareNotification(lease, f.confirm);
  assert.equal(prepared.content.length, 2000);
  assert.ok(prepared.content.endsWith("…"));
  assert.equal(prepared.mentionEveryone, false);
  assert.deepEqual(prepared.roleIds, []);
});

test("ACL checks cannot publish a stale generation or continue after authority is revoked", async (t) => {
  const f = fixture(t);
  const idea = await f.service.create(author, "idea", draft("suggestion"));
  const lease = claimCase(f, idea.case.id);
  await assert.rejects(
    f.service.prepareNotification(lease, async (scope) => {
      await f.service.approve(staff, "approve", idea.case.id, 1);
      return f.confirm(scope);
    }),
    code("stale_generation"),
  );
  const report = await f.service.create(author, "report", draft());
  const reportLease = claimCase(f, report.case.id);
  await assert.rejects(
    f.service.prepareNotification(reportLease, (scope) => {
      f.setFacts(author, { timedOut: true });
      return f.confirm(scope);
    }),
    code("permission_revoked"),
  );
});

test("foreign guild services cannot read a known UUID or prepare another server's job", async (t) => {
  const f = fixture(t);
  const saved = await f.service.create(author, "create", draft());
  const foreign = new CaseService(f.jobs, {
    guildId: "800000000000000099",
    authorize: () => {
      throw Error("Must not authorize a foreign object");
    },
  });
  await assert.rejects(foreign.get(author, saved.case.id), code("not_found"));
  await assert.rejects(foreign.reply(author, "reply", saved.case.id, 1, "Obce"), code("not_found"));
  await assert.rejects(
    foreign.prepareNotification(claimCase(f, saved.case.id), f.confirm),
    code("not_found"),
  );
});

test("limits are durable and a request replay does not consume another slot", async (t) => {
  const f = fixture(t, { maxActionsPerMinute: 1, maxActiveCasesPerAuthor: 1 });
  const saved = await f.service.create(author, "create", draft());
  assert.deepEqual(await f.service.create(author, "create", draft()), saved);
  await assert.rejects(
    f.service.reply(author, "reply", saved.case.id, 1, "Za szybko"),
    code("limit_exceeded"),
  );
  const reopened = f.open();
  await assert.rejects(
    reopened.service.reply(author, "reply", saved.case.id, 1, "Za szybko"),
    code("limit_exceeded"),
  );
  f.advance(60000);
  assert.equal(
    (await reopened.service.reply(author, "reply", saved.case.id, 1, "Za szybko")).case.revision,
    2,
  );
  f.advance(60000);
  await assert.rejects(reopened.service.create(author, "second", draft()), code("limit_exceeded"));
});

test("retention requires explicit configuration and does not delete content or public ideas", async (t) => {
  const f = fixture(t, { retentionMs: 60000, suggestionVisibility: "immediate" });
  const report = await f.service.create(author, "report", draft());
  const closed = await f.service.transition(staff, "close", report.case.id, 1, {
    status: "closed",
  });
  assert.equal(closed.case.retentionAt, f.now() + 60000);
  const idea = await f.service.create(author, "idea", draft("suggestion"));
  assert.equal(
    (await f.service.transition(staff, "reject", idea.case.id, 1, { status: "rejected" })).case
      .retentionAt,
    null,
  );
  f.advance(60000);
  assert.deepEqual(
    (await f.service.retentionCandidates(staff)).map((value) => value.id),
    [report.case.id],
  );
  await assert.rejects(f.service.retentionCandidates(author), code("permission_revoked"));
  assert.equal((await f.service.get(author, report.case.id)).case.content, report.case.content);
  const unconfigured = new CaseService(f.jobs, {
    guildId,
    authorize: (request) => ({
      member: {
        guildId,
        userId: request.actorId,
        owner: true,
        manageGuild: false,
        roleIds: [],
        pending: false,
        timedOut: false,
        isBot: false,
      },
      policy: { guildId },
    }),
  });
  assert.deepEqual(await unconfigured.retentionCandidates(staff), []);
});

test("invalid or oversized input creates neither conversation copies nor notifications", async (t) => {
  const f = fixture(t);
  for (const input of [
    draft("report", { visibility: "public" }),
    draft("unknown"),
    draft("report", { title: "x".repeat(141) }),
    draft("report", { content: "x".repeat(4001) }),
    draft("report", { content: " " }),
  ])
    await assert.rejects(f.service.create(author, "invalid", input), code("invalid_input"));
  assert.deepEqual(f.jobs.list(), []);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM cases").get().count, 0);
});

test("independent processes upsert votes without duplicates or lost aggregate counts", async (t) => {
  const f = fixture(t, {
    suggestionVisibility: "immediate",
    voting: { enabled: true, statuses: ["new"] },
  });
  const idea = await f.service.create(author, "idea", draft("suggestion"));
  const program = `
    import { Store } from './dist/storage/store.js';
    import { JobStore } from './dist/core/jobs/store.js';
    import { CaseService } from './dist/modules/cases/service.js';
    const [path,guildId,caseId,worker]=process.argv.slice(1);
    const store=new Store(path,guildId), jobs=new JobStore(store.db);
    const service=new CaseService(jobs,{guildId,voting:{enabled:true,statuses:['new']},authorize:request=>({member:{guildId,userId:request.actorId,owner:false,manageGuild:false,roleIds:[],pending:false,timedOut:false,isBot:false},policy:{guildId}})});
    for(let i=0;i<10;i++){ const actor=(810000000000000000n+BigInt(Number(worker)*10+i)).toString(); await service.vote(actor,'vote-'+i,caseId,1); }
    await service.vote('810000000000000099','shared-'+worker,caseId,Number(worker)===0?1:-1);
    store.close();
  `;
  const run = (worker) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", program, f.path, guildId, idea.case.id, String(worker)],
        { cwd: process.cwd(), timeout: 10000, windowsHide: true },
      );
      let errors = "";
      child.stderr.on("data", (chunk) => (errors += chunk));
      child.on("error", reject);
      child.on("exit", (status) => (status === 0 ? resolve() : reject(Error(errors))));
    });
  const outcomes = await Promise.allSettled([run(0), run(1)]);
  for (const outcome of outcomes)
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message);
  const result = await f.service.get(author, idea.case.id);
  assert.equal(result.votes.total, 21);
  assert.equal(result.votes.positive + result.votes.negative, 21);
  assert.equal(result.case.revision, 1);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS count FROM case_votes WHERE user_id='810000000000000099'")
      .get().count,
    1,
  );
});
