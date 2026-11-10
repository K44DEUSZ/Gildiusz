import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import {
  normalizeReactionEmoji,
  reactionEmojiKey,
  reactionEmojiValidation,
} from "../dist/contracts/emoji.js";
import { parseConfiguration, validateBindings } from "../dist/contracts/configuration.js";

const roleId = "100000000000000001",
  secondRole = "100000000000000002",
  channelId = "100000000000000003";
const configuration = (choices) => ({
  revision: 0,
  modules: { rooms: false, reactions: true, files: false, reports: false },
  rooms: { entryChannelId: "", categoryId: "", maxRooms: 10, userLimit: 0, idleSeconds: 60 },
  reactions: { channelId, choices },
  files: { channelIds: [], formats: ["PDF"], includeRooms: false },
  reports: { channelId: "" },
});
const resources = {
  channels: [{ id: channelId, name: "Role", kind: "text", accessible: true }],
  roles: [roleId, secondRole].map((id) => ({ id, name: "Rola", color: "#fff", assignable: true })),
};

test("Unicode emoji accepts complete flags, families, skin tones, keycaps and presentation variants", () => {
  for (const emoji of [
    "💻",
    "❤",
    "❤️",
    "©",
    "©️",
    "☕️",
    "🇵🇱",
    "1️⃣",
    "1⃣",
    "#️⃣",
    "👍🏽",
    "☝️🏽",
    "👩🏽‍⚕️",
    "👩‍❤️‍💋‍👩",
    "👩🏻‍❤️‍💋‍👩🏿",
    "👨🏿‍🤝‍👨🏻",
    "👨‍👩‍👧‍👦",
    "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
  ]) {
    assert.equal(reactionEmojiValidation(emoji), "valid", emoji);
    const parsed = parseConfiguration(configuration([{ emoji, roleId }]));
    assert.equal(parsed.reactions.choices[0].emoji, normalizeReactionEmoji(emoji));
    assert.deepEqual(validateBindings(parsed, resources), [], emoji);
  }
  assert.equal(reactionEmojiKey("❤"), reactionEmojiKey("❤️"));
});

test("single grapheme text, standalone components and broken sequences cannot become reaction bindings", () => {
  for (const emoji of [
    "",
    "hello",
    "a",
    "a\u20e3",
    "\u20e3",
    "😀\u200d",
    "é",
    "😀́",
    "😀😀",
    "🇵",
    "1",
    "#",
    "🏽",
    "🦰",
    "\u200d",
    "\ufe0f",
    "\ufe0f😀",
    "😀\ufe0f\ufe0f",
    "🇵🇱\ufe0f",
    "😀‍😀",
    "👍🏽🏽",
    "❤︎",
    "❤\n",
    " ❤",
    "❤ ",
    "<:custom:100000000000000001>",
    "<a:custom:100000000000000001>",
    "😀".repeat(40),
  ]) {
    assert.equal(reactionEmojiValidation(emoji), "invalid", emoji);
    assert.throws(
      () => parseConfiguration(configuration([{ emoji, roleId }])),
      (error) => error.code === "invalid_emoji",
    );
    assert.ok(
      validateBindings(configuration([{ emoji, roleId }]), resources).includes(
        "Każdy wybór potrzebuje jednego emoji.",
      ),
    );
  }
  for (const value of [null, undefined, 1, {}, []])
    assert.equal(reactionEmojiValidation(value), "invalid");
});

test("equivalent Unicode presentations cannot create duplicate choices for different roles", () => {
  for (const [one, two] of [
    ["❤", "❤️"],
    ["1⃣", "1️⃣"],
    ["☝🏽", "☝️🏽"],
  ]) {
    const value = configuration([
      { emoji: one, roleId },
      { emoji: two, roleId: secondRole },
    ]);
    assert.ok(validateBindings(value, resources).includes("Emoji i role nie mogą się powtarzać."));
    assert.ok(
      validateBindings(parseConfiguration(value), resources).includes(
        "Emoji i role nie mogą się powtarzać.",
      ),
    );
  }
});

test("a browser without regexp-v can import the contract and explicitly defers Unicode checks to the backend", () => {
  const source = readFileSync(
    new URL("../dist/contracts/emoji.js", import.meta.url),
    "utf8",
  ).replace(/^export /gm, "");
  function OlderRegExp(pattern, flags) {
    if (flags === "v") throw new SyntaxError("unsupported flag");
    return new RegExp(pattern, flags);
  }
  const validator = new Function("RegExp", source + ";return reactionEmojiValidation")(OlderRegExp);
  assert.equal(validator("💻"), "server_required");
  assert.equal(validator("😀‍😀"), "server_required");
  assert.equal(validator(""), "invalid");
  assert.equal(validator("<:custom:100000000000000001>"), "invalid");
  assert.equal(reactionEmojiValidation("😀‍😀"), "invalid");
});
