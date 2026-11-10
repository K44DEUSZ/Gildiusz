import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCapabilities,
  controlOperationPath,
  controlOperations,
  parseControlPath,
  rulesDraftMessages,
  rulesLimits,
} from "../dist/contracts/index.js";

const guildId = "100000000000000001",
  versionId = "11111111-2222-4333-8444-555555555555";
const draft = {
  channelId: "100000000000000002",
  roleId: "100000000000000003",
  label: "2026.1",
  content: "Szanuj innych.\nNie udostępniaj cudzych danych.",
  method: "button",
  emoji: null,
};

test("rules operations are scoped admin descriptors without a web member-acceptance endpoint", () => {
  const expected = {
    "rules.read": ["GET", false, `/v1/guilds/${guildId}/rules`],
    "rules.configure": ["PUT", true, `/v1/guilds/${guildId}/rules/configure`],
    "rules.publish": ["POST", true, `/v1/guilds/${guildId}/rules/publish`],
    "rules.acceptances.list": ["POST", false, `/v1/guilds/${guildId}/rules/acceptances`],
    "rules.publications.reconcile": [
      "POST",
      true,
      `/v1/guilds/${guildId}/rules/${versionId}/reconcile`,
    ],
  };
  assert.deepEqual(
    Object.keys(controlOperations).filter((key) => key.startsWith("rules.")),
    Object.keys(expected),
  );
  for (const [operation, [method, mutation, path]] of Object.entries(expected)) {
    assert.equal(controlOperations[operation].method, method);
    assert.equal(controlOperations[operation].mutation, mutation);
    assert.equal(controlOperationPath(operation, guildId, versionId), path);
    assert.equal(parseControlPath(path).operation, operation);
  }
  for (const suffix of ["accept", "grant", "members/accept", `${versionId}/accept`])
    assert.equal(parseControlPath(`/v1/guilds/${guildId}/rules/${suffix}`), null);
});

test("rules stay planned until a runtime explicitly implements the module", () => {
  const planned = buildCapabilities().modules.find((module) => module.key === "rules");
  assert.equal(planned.label, "Regulamin serwera");
  assert.equal(planned.availability, "planned");
  assert.equal(planned.status, "planned");
  assert.ok(!planned.requiredPermissions.includes("Administrator"));
  assert.ok(!planned.requiredPermissions.includes("ManageChannels"));
  assert.throws(() => buildCapabilities({ rules: "enabled" }));
  assert.equal(
    buildCapabilities({ rules: "enabled" }, ["rules"]).modules.find(
      (module) => module.key === "rules",
    ).status,
    "enabled",
  );
});

test("the common rules formatter renders the selected method and preserves all Unicode text across bounded parts", () => {
  assert.deepEqual(rulesDraftMessages(draft), [
    "**Regulamin serwera · 2026.1**\n\nSzanuj innych.\nNie udostępniaj cudzych danych.\n\nPrzeczytaj zasady. Jeśli się zgadzasz, wybierz „Akceptuję regulamin”.",
  ]);
  assert.deepEqual(
    rulesDraftMessages({
      ...draft,
      label: " 2026.1 ",
      content: draft.content.replaceAll("\n", "\r\n"),
    }),
    rulesDraftMessages(draft),
  );
  const content = "x".repeat(1799) + "👨‍👩‍👧‍👦" + "ż".repeat(7000),
    parts = rulesDraftMessages({ ...draft, content }),
    prefix = "**Regulamin serwera · 2026.1**\n\n",
    instruction = "\n\nPrzeczytaj zasady. Jeśli się zgadzasz, wybierz „Akceptuję regulamin”.";
  assert.ok(parts.length > 1 && parts.length <= rulesLimits.parts);
  assert.ok(parts.every((part) => part.length <= 2000 && part.isWellFormed()));
  assert.equal(
    parts
      .map((part, index) => {
        const body = part.slice(prefix.length);
        return index === parts.length - 1 ? body.slice(0, -instruction.length) : body;
      })
      .join(""),
    content,
  );
  const reaction = rulesDraftMessages({ ...draft, method: "reaction", emoji: "✅" });
  assert.ok(reaction[0].endsWith("Przeczytaj zasady. Jeśli się zgadzasz, dodaj reakcję ✅."));
  assert.ok(!reaction[0].includes("wybierz „Akceptuję regulamin”"));
  assert.throws(() => rulesDraftMessages({ ...draft, content: "x".repeat(12001) }));
});

function bodies(parts) {
  const prefix = "**Regulamin serwera · 2026.1**\n\n",
    instruction = "\n\nPrzeczytaj zasady. Jeśli się zgadzasz, wybierz „Akceptuję regulamin”.";
  return parts.map((part, index) => {
    const body = part.slice(prefix.length);
    return index === parts.length - 1 ? body.slice(0, -instruction.length) : body;
  });
}

test("new rules messages end at natural boundaries without dropping whitespace or splitting graphemes", () => {
  const content = "\n" + "Polskie zasady dla uczestników. ".repeat(100),
    chunks = bodies(rulesDraftMessages({ ...draft, content }));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.slice(0, -1).every((chunk) => /\s$/u.test(chunk)));
  assert.equal(chunks.join(""), content);
  const paragraph = "x".repeat(1640) + "\n\n" + "Zasady ".repeat(100);
  assert.equal(
    bodies(rulesDraftMessages({ ...draft, content: paragraph }))[0],
    paragraph.slice(0, 1642),
  );

  const emojiText = "x".repeat(1794) + "👨‍👩‍👧‍👦" + "🙂".repeat(3500),
    emojiChunks = bodies(rulesDraftMessages({ ...draft, content: emojiText }));
  assert.equal(emojiChunks[0], "x".repeat(1794));
  assert.ok(emojiChunks[1].startsWith("👨‍👩‍👧‍👦"));
  assert.equal(emojiChunks.join(""), emojiText);
  const maximumContent = "Polskie zasady. ".repeat(1000).slice(0, rulesLimits.content);
  assert.ok(rulesDraftMessages({ ...draft, content: maximumContent }).length <= 8);
});

test("legacy formatting remains byte stable and oversized single graphemes are rejected only for new drafts", () => {
  const content = "\n" + "Polskie zasady dla uczestników. ".repeat(100),
    legacy = bodies(rulesDraftMessages({ ...draft, content }, 1));
  assert.equal(legacy[0], content.slice(0, 1800));
  assert.equal(legacy.join(""), content);
  assert.notDeepEqual(legacy, bodies(rulesDraftMessages({ ...draft, content })));
  const oversized = { ...draft, content: "x" + "\u0301".repeat(2500) };
  assert.throws(() => rulesDraftMessages(oversized));
  assert.equal(bodies(rulesDraftMessages(oversized, 1)).join(""), oversized.content);
  assert.throws(() => rulesDraftMessages(draft, 3));
});
