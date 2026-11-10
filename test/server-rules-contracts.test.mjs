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
