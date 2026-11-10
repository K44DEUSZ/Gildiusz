import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { npmEntrypoint } from "./build-contracts.mjs";
import {
  runtimeSources,
  validateRuntimeTree,
  assertRuntimePackage,
  smokeRuntime,
} from "./runtime-package.mjs";

export const archiveName = "gildiusz-linux-x64.tar.gz";
export function validateBuild(manifest, sha, runId) {
  if (
    manifest?.format !== 1 ||
    manifest.revision !== sha ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    manifest.workflowRun !== String(runId) ||
    !/^\d+$/.test(String(runId)) ||
    manifest.platform !== "linux" ||
    manifest.architecture !== "x64" ||
    manifest.nodeMajor !== 24 ||
    (manifest.runtimeFormat !== undefined && ![1, 2, 3, 4].includes(manifest.runtimeFormat)) ||
    manifest.archive !== archiveName ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "") ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 1 ||
    manifest.size > 64 * 1024 * 1024
  )
    throw Error("Build metadata does not match the checked Linux/Node.js 24 revision.");
}
export function verifyArchive(manifest, bytes) {
  if (
    bytes.length !== manifest.size ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
  )
    throw Error("Build archive checksum or size differs.");
}
function removeLinks(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) rmSync(path);
    else if (stat.isDirectory()) removeLinks(path);
  }
}
export function prepareRuntimePackage(root, staging, { offline = false } = {}) {
  if (readdirSync(staging).length) throw Error("Runtime staging must be empty.");
  for (const name of runtimeSources) {
    validateRuntimeTree(join(root, name), { prefix: name });
    cpSync(join(root, name), join(staging, name), { recursive: true });
  }
  execFileSync(
    process.execPath,
    [
      npmEntrypoint(),
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...(offline ? ["--offline"] : []),
    ],
    { cwd: staging, stdio: "pipe", env: { ...process.env, npm_config_update_notifier: "false" } },
  );
  removeLinks(join(staging, "node_modules"));
  validateRuntimeTree(staging);
  assertRuntimePackage(staging);
  smokeRuntime(staging);
}
export function createPackage(root, output, revision, workflowRun) {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    process.versions.node.split(".")[0] !== "24"
  )
    throw Error("Production packages must be built on Linux x64 with Node.js 24.");
  if (!/^[a-f0-9]{40}$/.test(revision ?? "") || !/^\d+$/.test(workflowRun ?? ""))
    throw Error("Expected a commit SHA and workflow run ID.");
  const staging = mkdtempSync(join(tmpdir(), "gildiusz-package-"));
  try {
    // An explicit allowlist prevents local settings, member data and tokens entering the package.
    prepareRuntimePackage(root, staging);
    const metadata = {
      format: 1,
      revision,
      workflowRun,
      platform: "linux",
      architecture: "x64",
      nodeMajor: 24,
      runtimeFormat: 4,
    };
    writeFileSync(join(staging, "build.json"), JSON.stringify(metadata) + "\n");
    validateRuntimeTree(staging);
    if (!existsSync(join(staging, "dist", "bot", "main.js"))) throw Error("Missing compiled bot.");
    execFileSync(process.execPath, ["dist/cli.js", "validate"], { cwd: staging, stdio: "inherit" });
    mkdirSync(output, { recursive: true });
    const archive = join(output, archiveName);
    execFileSync("tar", ["-czf", archive, "-C", staging, "."]);
    const bytes = readFileSync(archive);
    const manifest = {
      ...metadata,
      archive: archiveName,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    validateBuild(manifest, revision, workflowRun);
    writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  createPackage(
    process.cwd(),
    resolve(process.argv[2] || "work/hosting-package"),
    process.env.GITHUB_SHA,
    process.env.GITHUB_RUN_ID,
  );
