import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../dist/storage/store.js";
import { quarantineDatabase } from "../dist/storage/recovery/schema.js";
import {
  inspectRestoredInstallation,
  reconcileRestoredGuild,
  rebaseRestoredGuild,
} from "../dist/storage/recovery/finalize-lineage.js";
import { parseRulesDeletionLifecycleJournal } from "../dist/storage/rules-deletion-lifecycle.js";

const guildId = "100000000000000001",
  day = 86400000;
function fixture(t) {
  const store = new Store(":memory:", guildId),
    now = Date.now(),
    sourceId = randomUUID(),
    epoch = randomUUID(),
    admittedAt = now - 40 * day;
  t.after(() => store.close());
  quarantineDatabase(store.db, "guild", now);
  store.putResource("retention.rules-deletion-installation", "retention", epoch, {
    format: 1,
    sourceId,
    baseSequence: 5,
    admittedAt,
  });
  store.db.prepare("INSERT INTO server_rules_deletion_state VALUES(?,5,5,NULL)").run(guildId);
  const journal = parseRulesDeletionLifecycleJournal({
    format: 2,
    sourceId,
    sequence: 37,
    createdAt: now - 60 * day,
    coveredFrom: now - 60 * day,
    updatedAt: now,
    globalGap: null,
    admitting: [],
    retiring: [],
    retired: [],
    entries: [],
    active: [
      {
        guildId,
        path: `guilds/${guildId}/gildiusz.sqlite`,
        epoch,
        admittedAt,
        through: 5,
        fileIdentity: { dev: "1", ino: "2" },
      },
    ],
  });
  return { store, now, sourceId, epoch, admittedAt, journal };
}

test("a populated restore preserves expired sequence gaps and its logical source during physical rebase", (t) => {
  const f = fixture(t),
    original = inspectRestoredInstallation(f.store.db, guildId, f.journal, f.now),
    epoch = randomUUID();
  assert.equal(original.sequence, 5);
  assert.equal(original.through, 5);
  rebaseRestoredGuild(f.store.db, original, f.journal, epoch, f.now);
  const state = f.store.db
      .prepare("SELECT sequence,journaled_through FROM server_rules_deletion_state")
      .get(),
    marker = f.store.resource("retention.rules-deletion-installation");
  assert.equal(state.sequence, 5);
  assert.equal(state.journaled_through, 5);
  assert.equal(marker.id, epoch);
  assert.equal(JSON.parse(marker.baseline).sourceId, f.sourceId);
  assert.equal(JSON.parse(marker.baseline).baseSequence, 5);
  assert.equal(f.journal.sequence, 37);
  assert.equal(f.journal.coveredFrom, f.journal.createdAt);
});

test("retired old epochs cannot become a same-ID rejoin, and a current epoch is never purged by an old retirement", (t) => {
  const f = fixture(t),
    newer = randomUUID(),
    retired = {
      format: 1,
      guildId,
      removedAt: f.now - 20 * day,
      purgedAt: f.now - 15 * day,
      outcome: "purged",
      lastEpoch: f.epoch,
      through: 5,
      expiresAt: f.now + 20 * day,
    };
  const onlyRetired = parseRulesDeletionLifecycleJournal({
    ...f.journal,
    active: [],
    retired: [retired],
  });
  assert.equal(
    inspectRestoredInstallation(f.store.db, guildId, onlyRetired, f.now).disposition,
    "purge",
  );
  const rejoined = parseRulesDeletionLifecycleJournal({
    ...f.journal,
    retired: [retired],
    active: [{ ...f.journal.active[0], epoch: newer, admittedAt: f.now - 10 * day }],
  });
  assert.equal(
    inspectRestoredInstallation(f.store.db, guildId, rejoined, f.now).disposition,
    "purge",
  );
  f.store.putResource("retention.rules-deletion-installation", "retention", newer, {
    format: 1,
    sourceId: f.sourceId,
    baseSequence: 5,
    admittedAt: f.now - 10 * day,
  });
  assert.equal(
    inspectRestoredInstallation(f.store.db, guildId, rejoined, f.now).disposition,
    "keep",
  );
});

test("captured unexpired tombstones retain their original local sequence above an old snapshot floor", (t) => {
  const f = fixture(t),
    decision = {
      guildId,
      acceptanceId: randomUUID(),
      retiredAt: f.now - day,
      expiresAt: f.now + 34 * day,
      sequence: 6,
    },
    journal = parseRulesDeletionLifecycleJournal({
      ...f.journal,
      active: [{ ...f.journal.active[0], through: 6 }],
      entries: [decision],
    }),
    original = inspectRestoredInstallation(f.store.db, guildId, journal, f.now);
  assert.equal(original.sequence, 5);
  assert.equal(original.through, 6);
  reconcileRestoredGuild(f.store.db, guildId, journal, f.now);
  rebaseRestoredGuild(f.store.db, original, journal, randomUUID(), f.now);
  const outbox = f.store.db.prepare("SELECT * FROM server_rules_deletion_outbox").get();
  assert.equal(outbox.acceptance_id, decision.acceptanceId);
  assert.equal(outbox.sequence, 6);
  assert.equal(outbox.retired_at, decision.retiredAt);
  assert.equal(outbox.expires_at, decision.expiresAt);
  assert.equal(
    f.store.db.prepare("SELECT sequence FROM server_rules_deletion_state").get().sequence,
    6,
  );
});

test("unknown epochs, another logical source, impossible counters and conflicting retained history refuse", (t) => {
  for (const variant of ["epoch", "source", "counter", "outbox"]) {
    const f = fixture(t);
    if (variant === "epoch")
      f.store.db
        .prepare("UPDATE resources SET id=? WHERE key='retention.rules-deletion-installation'")
        .run(randomUUID());
    if (variant === "source")
      f.store.putResource("retention.rules-deletion-installation", "retention", f.epoch, {
        format: 1,
        sourceId: randomUUID(),
        baseSequence: 5,
        admittedAt: f.admittedAt,
      });
    if (variant === "counter")
      f.store.db.exec("UPDATE server_rules_deletion_state SET sequence=6,journaled_through=6");
    if (variant === "outbox")
      f.store.db
        .prepare("INSERT INTO server_rules_deletion_outbox VALUES(?,?,?,?,5,?)")
        .run(guildId, randomUUID(), f.now - day, f.now + 34 * day, f.now);
    assert.throws(() => inspectRestoredInstallation(f.store.db, guildId, f.journal, f.now));
  }
});
