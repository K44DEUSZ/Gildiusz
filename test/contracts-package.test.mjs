import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as legacy from "../dist/control/contracts.js";
import * as contracts from "../dist/contracts/index.js";
import { controlSignature } from "../dist/contracts/node.js";
import { controlSignature as legacySignature } from "../dist/control/server.js";
import { buildContracts, npmEntrypoint } from "../scripts/build-contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guildId = "11111111111111111";
const objectId = "11111111-2222-4333-8444-555555555555";
const configuration = {
  revision: 23,
  modules: { rooms: false, reactions: false, files: false, reports: false },
  rooms: { entryChannelId: "", categoryId: "", maxRooms: 20, userLimit: 0, idleSeconds: 60 },
  reactions: { channelId: "", choices: [] },
  files: { channelIds: [], formats: ["PDF"], includeRooms: false },
  reports: { channelId: "" },
};
function controlError(code) {
  return (error) => error instanceof contracts.ControlError && error.code === code;
}

test("legacy configuration imports preserve parser and class identity", () => {
  assert.equal(legacy.parseConfiguration, contracts.parseConfiguration);
  assert.equal(legacy.ControlError, contracts.ControlError);
  assert.deepEqual(contracts.parseConfiguration(configuration), configuration);
  assert.throws(
    () => contracts.parseConfiguration({ ...configuration, future: true }),
    controlError("unknown_setting"),
  );
});

test("schema version is independent from configuration revision and future response fields are additive", () => {
  const encoded = contracts.versionedResponse(configuration);
  assert.equal(encoded.schemaVersion, 1);
  assert.equal(encoded.data.revision, 23);
  assert.deepEqual(
    contracts.parseVersionedResponse(
      { ...encoded, diagnostic: "future metadata" },
      contracts.parseConfiguration,
    ),
    encoded,
  );
  assert.throws(
    () =>
      contracts.parseVersionedResponse(
        { ...encoded, schemaVersion: 2 },
        contracts.parseConfiguration,
      ),
    controlError("unsupported_schema"),
  );
  assert.throws(
    () => contracts.parseVersionedResponse({ data: configuration }, contracts.parseConfiguration),
    controlError("unsupported_schema"),
  );
});

test("versioned mutations require idempotency identity and reject unsupported transport fields", () => {
  const request = {
    schemaVersion: 1,
    actor: guildId,
    accessToken: "test-oauth-credential",
    payload: { configuration },
  };
  assert.deepEqual(contracts.parseVersionedRequest(request), request);
  assert.throws(
    () => contracts.parseVersionedRequest(request, { mutation: true }),
    controlError("invalid_request_id"),
  );
  const mutation = { ...request, requestId: objectId };
  assert.deepEqual(contracts.parseVersionedRequest(mutation, { mutation: true }), mutation);
  assert.throws(
    () => contracts.parseVersionedRequest({ ...mutation, schemaVersion: 2 }),
    controlError("unsupported_schema"),
  );
  assert.throws(
    () => contracts.parseVersionedRequest({ ...mutation, admin: true }),
    controlError("unknown_field"),
  );
  assert.throws(
    () => contracts.parseVersionedRequest({ ...mutation, requestId: "../unsafe" }),
    controlError("invalid_request_id"),
  );
  assert.throws(
    () => contracts.parseVersionedRequest({ ...mutation, payload: undefined }),
    controlError("invalid_json"),
  );
});

test("all declared operations round trip through the shared allowlist and legacy paths remain valid", () => {
  for (const [operation, descriptor] of Object.entries(contracts.controlOperations)) {
    const path = contracts.controlOperationPath(operation, guildId, objectId);
    const parsed = contracts.parseControlPath(path);
    assert.equal(parsed.operation, operation);
    assert.equal(parsed.legacy, false);
    assert.equal(parsed.guildId, descriptor.path.includes("{guildId}") ? guildId : undefined);
    assert.equal(parsed.objectId, descriptor.path.includes("{objectId}") ? objectId : undefined);
    assert.equal(contracts.isControlPath(path), true);
  }
  assert.equal(contracts.parseControlPath("/guilds").operation, "guilds.list");
  assert.equal(contracts.parseControlPath(`/guilds/${guildId}`).operation, "settings.read");
  assert.deepEqual(contracts.parseControlPath(`/guilds/${guildId}/save`), {
    operation: "settings.save",
    guildId,
    legacy: true,
  });
  for (const path of [
    "/admin",
    "/guilds/1",
    "/v2/guilds",
    `/v1/guilds/${guildId}/unknown`,
    `/v1/guilds/${guildId}/jobs/../settings`,
    `/v1/guilds/${guildId}/jobs?all=true`,
    `/v1/guilds/${guildId}/jobs/${objectId}/retry/`,
    `/v1/guilds/${guildId}/jobs/%2f/read`,
  ])
    assert.equal(contracts.isControlPath(path), false, path);
  assert.throws(
    () => contracts.controlOperationPath("jobs.read", guildId, "../settings"),
    controlError("invalid_route"),
  );
});

test("shared signing preserves the exact legacy raw-body HMAC protocol", () => {
  const rawBody = '{"payload":{"b":2,"a":1},"actor":"example"}';
  const args = [
    "example-key",
    "POST",
    `/guilds/${guildId}/save`,
    "1794250000000",
    "a".repeat(32),
    rawBody,
  ];
  assert.equal(controlSignature(...args), legacySignature(...args));
  assert.notEqual(controlSignature(...args), controlSignature(...args.slice(0, -1), rawBody + " "));
  assert.equal(contracts.serializeControlBody({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.throws(
    () => contracts.serializeControlBody({ invalid: Number.NaN }),
    controlError("invalid_json"),
  );
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => contracts.serializeControlBody(cycle), controlError("invalid_json"));
});

test("capabilities never present planned modules as enabled", () => {
  const current = contracts.buildCapabilities({ rooms: "enabled" });
  assert.equal(current.modules.find((entry) => entry.key === "rooms").status, "enabled");
  assert.deepEqual(
    current.modules.filter((entry) => entry.availability === "available").map((entry) => entry.key),
    ["rooms", "reactions", "files", "reports"],
  );
  for (const entry of current.modules.filter(
    (entry) => !contracts.implementedFeatureKeys.includes(entry.key),
  ))
    assert.equal(entry.status, "planned");
  assert.throws(
    () => contracts.buildCapabilities({ music: "enabled" }),
    controlError("module_unavailable"),
  );
});

test("contracts artifacts are reproducible, contain only public runtime files and install without the bot checkout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-contract-test-"));
  try {
    const first = await buildContracts(root, join(directory, "producer-one"));
    const second = await buildContracts(root, join(directory, "producer-two"));
    assert.deepEqual(second, first);
    const archive = join(directory, "producer-one", first.archive);
    const bytes = readFileSync(archive);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), first.sha256);
    assert.equal(bytes.length, first.size);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .sort();
    assert.deepEqual(
      entries,
      [
        "LICENSE",
        "community.d.ts",
        "community.js",
        "configuration.d.ts",
        "configuration.js",
        "emoji.d.ts",
        "emoji.js",
        "file-formats.d.ts",
        "file-formats.js",
        "index.d.ts",
        "index.js",
        "jobs.d.ts",
        "jobs.js",
        "modules.d.ts",
        "modules.js",
        "node.d.ts",
        "node.js",
        "package.json",
        "protocol.d.ts",
        "protocol.js",
        "server-rules.d.ts",
        "server-rules.js",
        "twitch-proxy.d.ts",
        "twitch-proxy.js",
        "twitch.d.ts",
        "twitch.js",
      ]
        .map((entry) => "package/" + entry)
        .sort(),
    );
    const consumer = join(directory, "independent-consumer");
    mkdirSync(join(consumer, "vendor"), { recursive: true });
    copyFileSync(archive, join(consumer, "vendor", first.archive));
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "@gildiusz/contracts": "file:vendor/" + first.archive },
      }),
    );
    for (const args of [["install", "--package-lock-only"], ["ci"]])
      execFileSync(
        process.execPath,
        [npmEntrypoint(), ...args, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: consumer, stdio: "pipe" },
      );
    const imported = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import{schemaVersion,contractsVersion,parseConfiguration,reactionEmojiValidation,fileFormats,rulesDraftMessages,rulesLimits,controlOperations}from'@gildiusz/contracts';import{controlSignature}from'@gildiusz/contracts/node';console.log(JSON.stringify({schemaVersion,contractsVersion,parser:typeof parseConfiguration,signer:typeof controlSignature,emoji:reactionEmojiValidation('❤️'),formatCount:fileFormats.length,rulesFormatter:typeof rulesDraftMessages,rulesLimit:rulesLimits.content,rulesList:controlOperations['rules.acceptances.list']}))",
        ],
        { cwd: consumer, encoding: "utf8" },
      ),
    );
    assert.deepEqual(imported, {
      schemaVersion: 1,
      contractsVersion: first.version,
      parser: "function",
      signer: "function",
      emoji: "valid",
      formatCount: contracts.fileFormats.length,
      rulesFormatter: "function",
      rulesLimit: contracts.rulesLimits.content,
      rulesList: contracts.controlOperations["rules.acceptances.list"],
    });
    const clientSource = [
      "index.js",
      "configuration.js",
      "protocol.js",
      "emoji.js",
      "file-formats.js",
      "server-rules.js",
    ]
      .map((entry) =>
        readFileSync(join(consumer, "node_modules", "@gildiusz", "contracts", entry), "utf8"),
      )
      .join("\n");
    assert.doesNotMatch(clientSource, /from\s+["']node:/);
  } finally {
    assert.ok(
      realpathSync(directory).startsWith(realpathSync(tmpdir()) + sep),
      "Unexpected contracts test directory.",
    );
    rmSync(directory, { recursive: true, force: true });
  }
});
