import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateBuild,
  verifyArchive,
  archiveName,
  createPackage,
} from "../scripts/build-package.mjs";
import { publishBuild } from "../scripts/publish-build.mjs";
import { prepareRelease, validateArchiveEntries } from "../scripts/hosting.mjs";

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
      const release = prepareRelease(directory, metadata, readFileSync(join(output, archiveName)));
      assert.ok(existsSync(join(release, "dist", "bot", "main.js")));
      assert.ok(existsSync(join(release, "node_modules", "discord.js", "package.json")));
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
