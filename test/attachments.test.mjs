import assert from "node:assert/strict";
import test from "node:test";
import {
  extension,
  matchesHeader,
  fetchHeader,
  attachmentUrl,
} from "../dist/bot/attachment-policy.js";
import { AttachmentFilter } from "../dist/bot/attachments.js";
import { loadConfig } from "../dist/config.js";
import { ReadableStream } from "node:stream/web";

const settings = loadConfig().attachments;
const address =
  "https://cdn.discordapp.com/attachments/100000000000000001/100000000000000002/sample.png?ex=abcd";
const fixtures = {
  pdf: Buffer.from("%PDF-1.7\n"),
  png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  jpg: Buffer.from([255, 216, 255, 224]),
  jpeg: Buffer.from([255, 216, 255, 225]),
  webp: Buffer.from("RIFF1234WEBPVP8 "),
  gif: Buffer.from("GIF89a123456"),
};

test("the exact format allowlist accepts case variants and rejects ambiguous names or forged files", () => {
  for (const [type, bytes] of Object.entries(fixtures))
    assert.ok(matchesHeader(`sample.${type.toUpperCase()}`, bytes, settings.extensions));
  for (const name of [
    "program.EXE",
    "archive.zip",
    "x.svg",
    "x.html",
    "a.exe.png",
    "a.pdf.png",
    "a\u202egnp.exe",
    "no-extension",
    "a.png.",
    "a.png ",
    "../a.png",
  ])
    assert.equal(extension(name, settings.extensions), null, name);
  assert.equal(matchesHeader("picture.png", fixtures.pdf, settings.extensions), false);
  assert.equal(
    matchesHeader("image.jpg", Buffer.from("MZ safe non-executable fixture"), settings.extensions),
    false,
  );
});

test("attachment downloads restrict destination, reject errors, and stop at the byte budget even if Range is ignored", async () => {
  for (const url of [
    "http://cdn.discordapp.com/attachments/1/2/a.png",
    "https://127.0.0.1/a.png",
    "https://cdn.discordapp.com.evil/attachments/100000000000000001/100000000000000002/a.png",
    "https://user:pass@cdn.discordapp.com/attachments/100000000000000001/100000000000000002/a.png",
    "https://cdn.discordapp.com:444/attachments/100000000000000001/100000000000000002/a.png",
  ])
    assert.throws(() => attachmentUrl(url, settings.hosts));
  let cancelled = false,
    observed;
  const fetcher = async (url, options) => {
    observed = { url: String(url), options };
    return {
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10000));
        },
        cancel() {
          cancelled = true;
        },
      }),
    };
  };
  const bytes = await fetchHeader(address, settings, fetcher);
  assert.equal(bytes.length, settings.maxBytes);
  assert.ok(cancelled);
  assert.equal(observed.options.redirect, "error");
  assert.match(observed.options.headers.Range, /^bytes=0-/);
  await assert.rejects(
    fetchHeader(address, settings, async () => ({ status: 403, body: null })),
    /403/,
  );
  await assert.rejects(
    fetchHeader(address, settings, async () => {
      throw Error("timeout");
    }),
  );
});

function contextFor(messages) {
  const calls = { alerts: [], notices: [] };
  const context = {
    environment: { guildId: "guild", clientId: "self" },
    control: { modules: { files: true }, files: { channelIds: ["forum"], includeRooms: true } },
    config: loadConfig(),
    store: {
      resources: () => [{ kind: "channel", id: "forum", key: "channel.showcase" }],
      room: () => undefined,
    },
    alert: async (...args) => calls.alerts.push(args),
    notify: async (...args) => calls.notices.push(args),
  };
  const filter = new AttachmentFilter(context);
  return { filter, calls, messages };
}

test("complete attachment-free creates do not spend a Discord REST request", async () => {
  let fetched = 0;
  const { filter, calls } = contextFor([]);
  await filter.handle(
    {
      guildId: "guild",
      id: "plain-text",
      channelId: "forum",
      channel: { isThread: () => false },
      partial: false,
      attachments: new Map(),
      fetch: async () => {
        fetched++;
        throw Error("No REST refresh needed for this complete create.");
      },
    },
    "create",
  );
  await filter.drain();
  assert.equal(fetched, 0);
  assert.deepEqual(calls.alerts, []);
  assert.deepEqual(calls.notices, []);
});

test("edits, partial creates and uploads still refresh and reject forbidden attachments", async () => {
  for (const [source, partial, incomingAttachments] of [
    ["update", false, new Map()],
    ["create", true, new Map()],
    ["create", false, new Map([["file", { name: "new-file.zip" }]])],
  ]) {
    let fetched = 0,
      deleted = 0;
    const { filter, calls } = contextFor([]),
      incoming = {
        guildId: "guild",
        id: "changed-file",
        channelId: "forum",
        channel: { isThread: () => false },
        partial,
        attachments: incomingAttachments,
        author: { id: "author" },
        inGuild: () => true,
        delete: async () => {
          deleted++;
        },
        fetch: async () => {
          fetched++;
          return { ...incoming, attachments: new Map([["file", { name: "new-file.zip" }]]) };
        },
      };
    await filter.handle(incoming, source);
    assert.equal(fetched, 1);
    assert.equal(deleted, 1);
    assert.equal(calls.notices[0][2], "attachmentDenied");
  }
});

test("uncached partial forum edits are fetched, mixed attachments delete the whole message, and webhooks are checked", async () => {
  let fetched = 0,
    deleted = 0;
  const channel = { isThread: () => true, parentId: "forum" };
  const full = {
    guildId: "guild",
    id: "message",
    channelId: "thread",
    channel,
    applicationId: "other-app",
    author: { id: "author" },
    inGuild: () => true,
    attachments: new Map([
      ["a", { name: "good.pdf" }],
      ["b", { name: "bad.zip" }],
    ]),
    delete: async () => {
      deleted++;
    },
  };
  // Put a disallowed file first to verify message deletion without making an HTTP request.
  full.attachments = new Map([
    ["b", { name: "bad.zip" }],
    ["a", { name: "good.pdf" }],
  ]);
  const partial = {
    ...full,
    fetch: async () => {
      fetched++;
      return full;
    },
  };
  const { filter, calls } = contextFor([]);
  await filter.handle(partial);
  assert.equal(fetched, 1);
  assert.equal(deleted, 1);
  assert.equal(calls.notices[0][2], "attachmentDenied");
  assert.equal(calls.alerts[0][2], "attachmentDenied");
});

test("a fetch failure is reported without claiming an infection or silently accepting the attachment", async () => {
  const message = {
    guildId: "guild",
    id: "message",
    channelId: "forum",
    channel: { isThread: () => false },
    fetch: async () => {
      throw Object.assign(Error("forbidden"), { code: 50013 });
    },
  };
  const { filter, calls } = contextFor([]);
  await filter.handle(message);
  assert.match(calls.alerts[0][2], /message_fetch_failed/);
});
