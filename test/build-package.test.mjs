import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  validateBuild,
  verifyArchive,
  archiveName,
  createPackage,
  prepareRuntimePackage,
} from "../scripts/build-package.mjs";
import { publishBuild } from "../scripts/publish-build.mjs";
import {
  assertUpdateRuntime,
  prepareRelease,
  validateArchiveEntries,
} from "../scripts/hosting.mjs";
import {
  assertRuntimePackage,
  assertBackupTransportRuntime,
  validateRuntimeTree,
  smokeRuntime,
  retiredAudioFiles,
} from "../scripts/runtime-package.mjs";

const bytes = Buffer.from("production archive"),
  sha = "a".repeat(40);
const manifest = {
  format: 1,
  revision: sha,
  workflowRun: "123",
  platform: "linux",
  architecture: "x64",
  nodeMajor: 24,
  archive: archiveName,
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

test(
  "a clean production-only stage runs the packaged WASM worker without private source data",
  { timeout: 60000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "gildiusz-runtime-stage-"));
    try {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      prepareRuntimePackage(root, directory, { offline: true });
      assert.ok(existsSync(join(directory, "dist/modules/announcement-assets/decode-worker.js")));
      for (const name of ["scripts/backup-relay.mjs", "scripts/backup-pc.mjs"])
        assert.ok(existsSync(join(directory, name)), name);
      assert.ok(
        existsSync(join(directory, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm")),
      );
      assert.equal(existsSync(join(directory, "node_modules/typescript")), false);
      for (const name of [
        ".env",
        ".env.local",
        ".bot",
        "data",
        "backups",
        "artifacts",
        "apps",
        ".gildiusz-web",
      ])
        assert.equal(existsSync(join(directory, name)), false);
      for (const name of retiredAudioFiles) {
        assert.equal(existsSync(join(directory, name)), false, name);
        assert.equal(existsSync(join(directory, name + ".map")), false, name);
      }
      for (const name of ["scripts/backup-relay.mjs", "scripts/backup-pc.mjs"]) {
        const path = join(directory, name),
          source = readFileSync(path);
        unlinkSync(path);
        assertRuntimePackage(directory, { format: 6 });
        assert.throws(() => smokeRuntime(directory), /Missing runtime file: scripts\/backup-/);
        writeFileSync(path, source, { mode: 0o600 });
      }
      unlinkSync(join(directory, "dist/modules/announcement-assets/decode-worker.js"));
      assert.throws(() => assertRuntimePackage(directory));
    } finally {
      assert.ok(directory.startsWith(resolve(tmpdir()) + sep));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("package privacy validation blocks nested state and uploads inside an allowlisted directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-runtime-privacy-"));
  try {
    for (const name of [
      "dist/state.sqlite-wal",
      "content/.bot/a.txt",
      "node_modules/pkg/.env.local",
      "node_modules/pkg/snapshot.gldbak",
      "node_modules/pkg/latest.gldledger",
      "node_modules/pkg/latest.gldproof",
      "node_modules/pkg/rules-acceptance-deletions/journal.json",
      "config/restore-manifest.json",
      "config/restore-quarantine.json",
      "config/announcement-assets/image.png",
    ]) {
      const path = join(directory, ...name.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "private");
      assert.throws(() => validateRuntimeTree(directory));
      rmSync(join(directory, name.split("/")[0]), { recursive: true });
    }
  } finally {
    assert.ok(directory.startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy managed releases remain reusable while new manifests require the worker runtime", () => {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-legacy-runtime-")),
    release = join(directory, "releases", sha);
  try {
    for (const name of ["dist/bot", "node_modules/discord.js"])
      mkdirSync(join(release, name), { recursive: true });
    for (const name of ["dist/bot/main.js", "dist/cli.js", "node_modules/discord.js/package.json"])
      writeFileSync(join(release, name), "legacy");
    writeFileSync(
      join(release, "build.json"),
      JSON.stringify({ revision: sha, workflowRun: "123", nodeMajor: 24 }),
    );
    writeFileSync(join(release, ".built"), sha);
    assert.equal(prepareRelease(directory, manifest, bytes), release);
    assert.throws(() => prepareRelease(directory, { ...manifest, runtimeFormat: 2 }, bytes));
  } finally {
    assert.ok(directory.startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
test("format2 retains its historical requirements while format3 gates every backup port before downtime", () => {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-format3-runtime-")),
    release = join(directory, "releases", sha);
  try {
    const historicalFormat2 = [
      "dist/bot/main.js",
      "dist/cli.js",
      "dist/contracts/index.js",
      "dist/contracts/node.js",
      "dist/storage/recovery/index.js",
      "scripts/recovery.mjs",
      "dist/modules/announcement-assets/validate.js",
      "dist/modules/announcement-assets/decode-worker.js",
      "dist/modules/twitch/provider.js",
      "node_modules/discord.js/package.json",
      "node_modules/image-size/package.json",
      "node_modules/@silvia-odwyer/photon-node/photon_rs.js",
      "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
    ];
    for (const name of historicalFormat2) {
      const path = join(release, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "historical-format2");
    }
    writeFileSync(
      join(release, "build.json"),
      JSON.stringify({ revision: sha, workflowRun: "123", nodeMajor: 24, runtimeFormat: 2 }),
    );
    writeFileSync(join(release, ".built"), sha);
    assert.equal(prepareRelease(directory, { ...manifest, runtimeFormat: 2 }, bytes), release);
    assert.throws(() => assertUpdateRuntime(release), /require runtime format6/);
    assertRuntimePackage(release, { format: 2 });
    assert.throws(() => assertRuntimePackage(release, { format: 3 }), /uninstall-retention/);
    writeFileSync(join(release, "dist/storage/uninstall-retention.js"), "format3");
    for (const name of ["backup-catalog", "backup-collector", "backup-ledger", "backup-scheduler"])
      writeFileSync(join(release, "scripts", `${name}.mjs`), "format3");
    assertRuntimePackage(release, { format: 3 });
    writeFileSync(
      join(release, "build.json"),
      JSON.stringify({ revision: sha, workflowRun: "123", nodeMajor: 24, runtimeFormat: 3 }),
    );
    assert.throws(() => assertUpdateRuntime(release), /require runtime format6/);
    for (const name of [
      "backup-catalog",
      "backup-collector",
      "backup-ledger",
      "backup-scheduler",
    ]) {
      const path = join(release, "scripts", `${name}.mjs`);
      unlinkSync(path);
      assert.throws(() => assertRuntimePackage(release, { format: 3 }), /Missing runtime file/);
      assertRuntimePackage(release, { format: 2 });
      writeFileSync(path, "format3");
    }
    const format4 = [
      "scripts/backup-proof.mjs",
      "scripts/recovery-deletions.mjs",
      "dist/storage/rules-deletion-journal.js",
      "dist/modules/server-rules/deletion-schema.js",
      "dist/modules/server-rules/deletion-outbox.js",
      "dist/storage/recovery/age.js",
      "dist/storage/recovery/deletions.js",
      "dist/bot/music-rehearsal-voice.js",
      "dist/bot/music-rehearsal-operator.js",
      "dist/bot/music-rehearsal-operator-files.js",
      "dist/modules/music-rehearsal/types.js",
      "dist/modules/music-rehearsal/bounded.js",
      "dist/modules/music-rehearsal/synthetic.js",
      "dist/modules/music-rehearsal/ffmpeg.js",
      "dist/modules/music-rehearsal/service.js",
      "node_modules/@discordjs/voice/package.json",
      "node_modules/@snazzah/davey/package.json",
      "node_modules/@noble/ciphers/package.json",
    ];
    for (const name of format4) {
      const path = join(release, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "format4");
    }
    writeFileSync(join(release, "build.json"), JSON.stringify({ runtimeFormat: 4 }));
    assertRuntimePackage(release, { format: 4 });
    assert.throws(() => assertUpdateRuntime(release), /format6/);
    for (const name of format4) {
      const path = join(release, name);
      unlinkSync(path);
      assert.throws(() => assertRuntimePackage(release, { format: 4 }), /Missing runtime file/);
      assertRuntimePackage(release, { format: 3 });
      writeFileSync(path, "format4");
    }
    const format5 = [
      "scripts/backup-deletion-state.mjs",
      "scripts/rules-deletion-lifecycle.mjs",
      "dist/storage/rules-deletion-lifecycle.js",
    ];
    for (const name of format5) {
      const path = join(release, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "format5");
    }
    writeFileSync(join(release, "build.json"), JSON.stringify({ runtimeFormat: 5 }));
    assertRuntimePackage(release, { format: 5 });
    assert.throws(() => assertUpdateRuntime(release), /format6/);
    for (const name of format5) {
      const path = join(release, name);
      unlinkSync(path);
      assert.throws(() => assertRuntimePackage(release, { format: 5 }), /Missing runtime file/);
      assertRuntimePackage(release, { format: 4 });
      writeFileSync(path, "format5");
    }
    const format6 = ["scripts/prepare-legacy-source.mjs", "scripts/backup-offsite.mjs"];
    for (const name of format6) {
      const path = join(release, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "format6");
    }
    writeFileSync(join(release, "build.json"), JSON.stringify({ runtimeFormat: 6 }));
    assert.throws(() => assertUpdateRuntime(release), /Withdrawn audio file/);
    for (const name of retiredAudioFiles) unlinkSync(join(release, name));
    assertUpdateRuntime(release);
    // Old format6 candidates remain installable without the later optional operator transport.
    assert.equal(existsSync(join(release, "scripts/backup-relay.mjs")), false);
    assert.equal(existsSync(join(release, "scripts/backup-pc.mjs")), false);
    assert.throws(() => assertBackupTransportRuntime(release), /backup-relay\.mjs/);
    writeFileSync(join(release, "scripts/backup-relay.mjs"), "transport");
    assert.throws(() => assertBackupTransportRuntime(release), /backup-pc\.mjs/);
    writeFileSync(join(release, "scripts/backup-pc.mjs"), "transport");
    assertBackupTransportRuntime(release);
    for (const name of ["scripts/backup-relay.mjs", "scripts/backup-pc.mjs"])
      unlinkSync(join(release, name));
    assertUpdateRuntime(release);
    assert.throws(() => assertRuntimePackage(release, { format: 5 }), /Missing runtime file/);
    for (const name of [...format5, ...format6]) {
      const path = join(release, name);
      unlinkSync(path);
      assert.throws(() => assertUpdateRuntime(release), /Missing runtime file/);
      writeFileSync(path, "format6");
    }
  } finally {
    assert.ok(directory.startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
test(
  "Linux CI produces a complete production package that the host can activate without npm or compilation",
  {
    skip: process.platform !== "linux" || process.versions.node.split(".")[0] !== "24",
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "gildiusz-package-test-"));
    try {
      const output = join(directory, "output");
      createPackage(process.cwd(), output, sha, "123");
      const metadata = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
      assert.equal(metadata.runtimeFormat, 6);
      const release = prepareRelease(directory, metadata, readFileSync(join(output, archiveName)));
      assert.ok(existsSync(join(release, "dist", "bot", "main.js")));
      assert.ok(existsSync(join(release, "node_modules", "discord.js", "package.json")));
      smokeRuntime(release);
      assert.equal(existsSync(join(release, "node_modules", "typescript")), false);
      assert.equal(existsSync(join(release, ".env")), false);
      assert.equal(existsSync(join(release, "data")), false);
      assert.equal(readFileSync(join(release, ".built"), "utf8").trim(), sha);
    } finally {
      assert.ok(directory.startsWith(join(tmpdir(), "gildiusz-package-test-")));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("deployment rejects mismatched revisions, workflow runs, platforms, corrupt and oversized packages", () => {
  validateBuild(manifest, sha, "123");
  verifyArchive(manifest, bytes);
  for (const patch of [
    { revision: "b".repeat(40) },
    { workflowRun: "124" },
    { platform: "win32" },
    { architecture: "arm64" },
    { nodeMajor: 26 },
    { runtimeFormat: 7 },
    { size: 100000000 },
    { sha256: "bad" },
    { archive: "../file" },
  ])
    assert.throws(() => validateBuild({ ...manifest, ...patch }, sha, "123"));
  assert.throws(() => verifyArchive(manifest, Buffer.from("corrupt")));
  validateArchiveEntries(["./", "./dist/main.js", "./node_modules/pkg/index.js"], ["d", "-", "-"]);
  for (const name of [
    "../shared/.env",
    "/etc/passwd",
    "./dist/../../shared/.env",
    "./.env",
    "./node_modules\\escape",
    "./dist/state.sqlite",
    "./node_modules/pkg/.env.local",
    "./config/announcement-assets/image.png",
  ])
    assert.throws(() => validateArchiveEntries([name], ["-"]));
  for (const type of ["l", "h", "b", "p"])
    assert.throws(() => validateArchiveEntries(["./dist/file"], [type]));
});

test("a moved main never changes the build branch and a foreign branch is protected", async () => {
  for (const foreign of [false, true]) {
    const writes = [];
    const api = async (path, method = "GET", body) => {
      if (method !== "GET") {
        writes.push({ path, method, body });
        return { sha: "built" };
      }
      if (path.endsWith("heads/main")) return { object: { sha: "b".repeat(40) } };
      if (path.endsWith("heads/hosting-build"))
        return foreign ? { object: { sha: "foreign" } } : null;
      if (path.endsWith("/foreign")) return { message: "user-owned branch" };
    };
    await assert.rejects(publishBuild(manifest, bytes, api));
    assert.equal(writes.filter((write) => write.path.includes("/git/refs")).length, 0);
    if (foreign) assert.equal(writes.length, 0);
  }
});

test("build publication contains only an archive and its manifest, without tags or releases", async () => {
  const writes = [];
  const api = async (path, method = "GET", body) => {
    if (method !== "GET") {
      writes.push({ path, body });
      return { sha: "built" };
    }
    return path.endsWith("heads/main") ? { object: { sha } } : null;
  };
  await publishBuild(manifest, bytes, api);
  assert.deepEqual(
    writes.find((entry) => entry.path.endsWith("/git/trees")).body.tree.map((entry) => entry.path),
    ["manifest.json", archiveName],
  );
  assert.equal(writes.at(-1).body.ref, "refs/heads/hosting-build");
  assert.equal(
    writes.some((entry) => /tags|releases/.test(entry.path)),
    false,
  );
});
