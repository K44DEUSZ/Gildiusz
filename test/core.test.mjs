import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { lintContent, publications, chunks } from "../dist/content.js";
import { Store } from "../dist/storage/store.js";
import { acquireLock } from "../dist/storage/lock.js";
import {
  effectivePermissions,
  memberPermissions,
  moderatorPermissions,
  overwrites,
  P,
} from "../dist/permissions/model.js";
import { parseMessageLink } from "../dist/bot/reports.js";
import { safeName, Pool, SerialQueue } from "../dist/shared/utils.js";

test("agreed layout and content resolve only known channels and fit message limits", () => {
  const config = loadConfig();
  assert.equal(
    config.channels.filter((channel) => ["text", "readonly"].includes(channel.kind)).length,
    7,
  );
  assert.equal(config.channels.filter((channel) => channel.kind === "forum").length, 2);
  assert.equal(config.channels.filter((channel) => channel.kind === "voice").length, 4);
  assert.deepEqual(lintContent(config), []);
  for (const message of publications(config)) {
    assert.ok(message.text.length <= 1900);
    assert.doesNotMatch(message.text, /\{\{|[\u2013\u2014]/u);
  }
  assert.throws(() => chunks("a".repeat(2001)));
});

test("interest roles cannot bypass administration, read-only channels, or a closed room", () => {
  const everyone = "100000000000000001",
    moderator = "100000000000000002",
    bot = "100000000000000003";
  for (const roles of [[], ["interest"], ["interest", "another"]]) {
    const ordinary = (kind, extra = []) =>
      effectivePermissions(BigInt(memberPermissions), "member", roles, everyone, [
        ...overwrites(kind, everyone, moderator, bot),
        ...extra,
      ]);
    assert.equal(ordinary("admin") & P.ViewChannel, 0n);
    assert.equal(
      ordinary("readonly") &
        (P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.AttachFiles),
      0n,
    );
    assert.equal(ordinary("private") & P.Connect, 0n);
    const allowed = ordinary("private", [
      { id: "member", type: 1, allow: (P.ViewChannel | P.Connect).toString(), deny: "0" },
    ]);
    assert.ok(allowed & P.Connect);
    assert.equal(
      effectivePermissions(
        BigInt(memberPermissions),
        "member",
        roles,
        everyone,
        [
          ...overwrites("private", everyone, moderator, bot),
          { id: "member", type: 1, allow: (P.ViewChannel | P.Connect).toString(), deny: "0" },
        ],
        true,
      ) & P.Connect,
      0n,
    );
    const mod = effectivePermissions(
      BigInt(memberPermissions) | BigInt(moderatorPermissions),
      "mod",
      [moderator],
      everyone,
      overwrites("private", everyone, moderator, bot),
    );
    assert.ok(mod & P.ViewChannel);
    assert.ok(mod & P.Connect);
    assert.ok(mod & P.PinMessages);
    assert.equal(mod & (P.Administrator | P.ManageGuild | P.ManageRoles | P.ManageWebhooks), 0n);
  }
});

test("technical entrance permits joining but no conversation, including with interest or moderator roles", () => {
  const everyone = "100000000000000001",
    moderator = "100000000000000002",
    bot = "100000000000000003";
  for (const roles of [[], ["interest"], [moderator]]) {
    const mask = effectivePermissions(
      BigInt(memberPermissions) | (roles.includes(moderator) ? BigInt(moderatorPermissions) : 0n),
      "member",
      roles,
      everyone,
      overwrites("entrance", everyone, moderator, bot),
    );
    assert.ok(mask & P.ViewChannel);
    assert.ok(mask & P.Connect);
    assert.equal(
      mask &
        (P.Speak |
          P.Stream |
          P.UseVAD |
          P.SendMessages |
          P.SendMessagesInThreads |
          P.AddReactions |
          P.AttachFiles),
      0n,
    );
    const normalRoom = effectivePermissions(
      BigInt(memberPermissions),
      "member",
      roles,
      everyone,
      overwrites("voice", everyone, moderator, bot),
    );
    assert.ok(normalRoom & P.Speak);
    assert.ok(normalRoom & P.SendMessages);
  }
});

test("Discord report links are confined to this guild and cannot carry arbitrary fetch targets", () => {
  const guild = "100000000000000001";
  assert.deepEqual(
    parseMessageLink(
      `https://discord.com/channels/${guild}/100000000000000002/100000000000000003`,
      guild,
    ),
    { channel: "100000000000000002", message: "100000000000000003" },
  );
  for (const link of [
    "http://localhost/",
    `https://discord.com.evil/channels/${guild}/100000000000000002/100000000000000003`,
    `https://discord.com/channels/100000000000000009/100000000000000002/100000000000000003`,
  ])
    assert.throws(() => parseMessageLink(link, guild));
  assert.equal(safeName("@everyone\u202e\n<script> / projekt"), "everyone script projekt");
});

test("SQLite transactions, backups, persistent cooldowns, and process locks survive reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kampus-storage-")),
    path = join(directory, "state.sqlite");
  let store = new Store(path);
  const release = await acquireLock(path);
  try {
    await assert.rejects(acquireLock(path));
    assert.ok(store.cooldown("a", 1000, 100));
    assert.equal(store.cooldown("a", 1000, 200), false);
    assert.throws(() =>
      store.transaction(() => {
        store.putResource("test", "role", "9007199254740993123", {});
        throw Error("rollback");
      }),
    );
    assert.equal(store.resource("test"), undefined);
    store.putResource("test", "role", "9007199254740993123", {});
    await store.backup(join(directory, "backup.sqlite"));
    store.close();
    store = new Store(path);
    assert.equal(store.id("test"), "9007199254740993123");
    assert.equal(store.cooldown("a", 1000, 300), false);
    const copy = new Store(join(directory, "backup.sqlite"));
    assert.equal(copy.id("test"), "9007199254740993123");
    copy.close();
  } finally {
    store.close();
    await release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrency limits bound network work while serialized tasks recover from failures", async () => {
  const pool = new Pool(2, 10);
  let active = 0,
    maximum = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      pool.run(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
      }),
    ),
  );
  assert.equal(maximum, 2);
  const queue = new SerialQueue(),
    order = [];
  await Promise.allSettled([
    queue.run(async () => {
      order.push(1);
      throw Error("first");
    }),
    queue.run(async () => {
      order.push(2);
    }),
  ]);
  assert.deepEqual(order, [1, 2]);
});
