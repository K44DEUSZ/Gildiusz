import test from "node:test";
import assert from "node:assert/strict";
import {
  publishDiscord,
  validatePublication,
  publicationPresentation,
} from "../dist/core/delivery/discord.js";

const { AbortController, structuredClone } = globalThis;
const guildId = "700000000000000001",
  otherGuildId = "700000000000000002",
  channelId = "700000000000000003",
  messageId = "700000000000000004";
const objectId = (value = 1) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const button = (action = "read", kind = "meeting", value = 1) => ({
  type: 2,
  style: 2,
  label: "Szczegóły",
  custom_id: `gildiusz:${kind}:${guildId}:${objectId(value)}:${action}`,
});
const row = (components = [button()]) => ({ type: 1, components });
const publication = (components = [row()]) => ({
  guildId,
  channelId,
  content: "Spotkanie w piątek.",
  roleIds: [],
  everyone: false,
  components,
});

test("announcement cards and HTTPS link buttons have a distinct bounded Discord payload", () => {
  const value = {
    ...publication([]),
    content: "",
    card: { title: "x".repeat(256), description: "y".repeat(4096), color: 0xffffff },
    links: Array.from({ length: 5 }, (_, i) => ({
      label: `Strona ${i}`,
      url: `https://example.com/${i}`,
    })),
  };
  const payload = publicationPresentation(value);
  assert.deepEqual(payload.embeds, [value.card]);
  assert.equal(payload.components.length, 1);
  assert.equal(payload.components[0].components.length, 5);
  assert.ok(
    payload.components[0].components.every(
      (button) => button.type === 2 && button.style === 5 && !Object.hasOwn(button, "custom_id"),
    ),
  );
  for (const extra of [
    { card: { ...value.card, url: "https://example.com" } },
    { card: { ...value.card, title: "x".repeat(257) } },
    { card: { ...value.card, description: "y".repeat(4097) } },
    { card: { ...value.card, color: -1 } },
    { card: { ...value.card, color: 0.5 } },
    { card: { ...value.card, image: { url: "https://localhost/image.png" } } },
    { card: { ...value.card, image: null } },
    { card: { title: "", description: "", color: 0 } },
    { links: Array.from({ length: 6 }, () => value.links[0]) },
    { links: [{ label: "x".repeat(81), url: "https://example.com" }] },
    { links: [{ label: "", url: "https://example.com" }] },
    { links: [{ label: "Strona", url: "javascript:alert(1)" }] },
    { links: [{ label: "Strona", url: "http://example.com" }] },
    { links: [{ label: "Strona", url: "https://u:p@example.com" }] },
    { links: [{ label: "Strona", url: "https://example.com", custom_id: button().custom_id }] },
    { components: [row()] },
  ])
    assert.throws(() => validatePublication({ ...value, ...extra }), /invalid_publication/);
});

test("a card image accepts only one bounded matching attachment, never an external source", () => {
  const file = {
      name: "announcement.png",
      contentType: "image/png",
      data: new Uint8Array([137, 80, 78, 71]),
    },
    value = {
      ...publication([]),
      content: "",
      card: { title: "", description: "", color: 0, image: { attachmentName: "announcement.png" } },
      attachments: [file],
    },
    payload = publicationPresentation(value);
  assert.equal(payload.embeds[0].image.url, "attachment://announcement.png");
  assert.deepEqual(payload.attachments, [{ id: 0, filename: "announcement.png" }]);
  for (const extra of [
    { attachments: [] },
    { attachments: [file, file] },
    { attachments: [{ ...file, name: "../image.png" }] },
    { attachments: [{ ...file, contentType: "text/html" }] },
    { attachments: [{ ...file, data: new Uint8Array(2 * 1024 * 1024 + 1) }] },
    { attachments: [{ ...file, data: new Uint8Array() }] },
    { attachments: [{ ...file, data: "data:image/png;base64," }] },
    { card: { ...value.card, image: { attachmentName: "announcement.jpg" } } },
    { card: { ...value.card, image: { attachmentName: "https://example.com/image.png" } } },
    { card: { title: "Karta", description: "", color: 0 } },
  ])
    assert.throws(() => validatePublication({ ...value, ...extra }), /invalid_publication/);
});

test("trusted buttons accept the guild-bound actions handled by Discord interactions", () => {
  for (const [kind, actions] of [
    ["meeting", ["read", "join", "leave", "start", "complete", "cancel"]],
    ["case", ["read", "assign", "approve", "up", "down", "unvote"]],
  ])
    for (const action of actions) {
      const value = button(action, kind);
      value.disabled = true;
      assert.doesNotThrow(() => validatePublication(publication([row([value])])));
    }
  assert.doesNotThrow(() => validatePublication(publication([])));
  assert.doesNotThrow(() => validatePublication({ ...publication(), components: undefined }));
  const maximum = Array.from({ length: 5 }, (_, i) =>
    row(
      Array.from({ length: 5 }, (_, j) => ({
        ...button("read", "meeting", i * 5 + j + 1),
        style: ((i + j) % 4) + 1,
        label: "x".repeat(80),
      })),
    ),
  );
  assert.doesNotThrow(() => validatePublication(publication(maximum)));
});

test("untrusted component shapes fail before preflight or a delivery attempt", async (t) => {
  const invalid = [
    [
      "foreign guild",
      [row([{ ...button(), custom_id: button().custom_id.replace(guildId, otherGuildId) }])],
    ],
    ["meeting case action", [row([button("approve")])]],
    ["case meeting action", [row([button("join", "case")])]],
    ["unknown action", [row([button("delete")])]],
    ["noncanonical action", [row([button("JOIN")])]],
    [
      "invalid object",
      [row([{ ...button(), custom_id: button().custom_id.replace(objectId(), "x".repeat(36)) }])],
    ],
    ["long custom id", [row([{ ...button(), custom_id: "x".repeat(101) }])]],
    ["external URL", [row([{ ...button(), url: "https://example.com" }])]],
    ["extra button field", [row([{ ...button(), emoji: { name: "x" } }])]],
    ["extra row field", [{ ...row(), extra: true }]],
    ["wrong row type", [{ ...row(), type: 2 }]],
    ["wrong button type", [row([{ ...button(), type: 3 }])]],
    ["empty row", [row([])]],
    ["six rows", Array.from({ length: 6 }, (_, i) => row([button("read", "meeting", i + 1)]))],
    ["six buttons", [row(Array.from({ length: 6 }, (_, i) => button("read", "meeting", i + 1)))]],
    ["missing rows", null],
    ["non-array buttons", [{ type: 1, components: {} }]],
    ["array as row", [Object.assign([], row())]],
    ["array as button", [row([Object.assign([], button())])]],
    ["duplicate in row", [row([button(), button()])]],
    ["duplicate across rows", [row(), row()]],
    ["empty label", [row([{ ...button(), label: "  " }])]],
    ["long label", [row([{ ...button(), label: "x".repeat(81) }])]],
    ["nonboolean disabled", [row([{ ...button(), disabled: "false" }])]],
    ...[0, 5, 6, "1", NaN].map((style) => [
      `invalid style ${style}`,
      [row([{ ...button(), style }])],
    ]),
  ];
  for (const [name, components] of invalid)
    await t.test(name, async () => {
      const calls = [];
      await assert.rejects(
        publishDiscord(
          "operation",
          publication(components),
          {
            signal: new AbortController().signal,
            now: () => 1000,
            checkpoint: () => calls.push("checkpoint"),
            beginAttempt: () => calls.push("attempt"),
          },
          {
            check: async () => calls.push("check"),
            send: async () => {
              calls.push("send");
              return { id: messageId };
            },
          },
        ),
        /invalid_components/,
      );
      assert.deepEqual(calls, []);
    });
});

test("a caller cannot replace checked buttons or their guild while preflight awaits", async () => {
  const value = publication(),
    expected = structuredClone(value),
    calls = [];
  let checked;
  const outcome = await publishDiscord(
    "operation",
    value,
    {
      signal: new AbortController().signal,
      now: () => 1000,
      checkpoint: () => calls.push("checkpoint"),
      beginAttempt: () => calls.push("attempt"),
    },
    {
      check: async (approved) => {
        checked = structuredClone(approved);
        await Promise.resolve();
        value.guildId = otherGuildId;
        value.channelId = otherGuildId;
        value.components[0].components[0].url = "https://example.com";
        value.components[0].components[0].custom_id = button().custom_id.replace(
          guildId,
          otherGuildId,
        );
      },
      send: async (sent, options) => {
        assert.deepEqual(sent, expected);
        assert.deepEqual(sent, checked);
        assert.equal(options.enforceNonce, true);
        calls.push("send");
        return { id: messageId };
      },
    },
  );
  assert.deepEqual(outcome, { state: "succeeded", messageId });
  assert.deepEqual(calls, ["checkpoint", "attempt", "send"]);
});
