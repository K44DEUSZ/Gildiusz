import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { archiveName, validateBuild, verifyArchive } from "./build-package.mjs";

export async function publishBuild(manifest, bytes, api) {
  validateBuild(manifest, manifest.revision, manifest.workflowRun);
  verifyArchive(manifest, bytes);
  const base = "/repos/K44DEUSZ/gildiusz";
  const ref = await api(`${base}/git/ref/heads/hosting-build`);
  if (ref) {
    const previous = await api(`${base}/git/commits/${ref.object.sha}`);
    if (!previous?.message?.startsWith("Paczka hostingu "))
      throw Error("hosting-build is not a managed build branch.");
  }
  const tree = [];
  for (const [path, content] of [
    ["manifest.json", Buffer.from(JSON.stringify(manifest) + "\n")],
    [archiveName, bytes],
  ]) {
    const blob = await api(`${base}/git/blobs`, "POST", {
      content: content.toString("base64"),
      encoding: "base64",
    });
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const createdTree = await api(`${base}/git/trees`, "POST", { tree });
  const commit = await api(`${base}/git/commits`, "POST", {
    message: `Paczka hostingu ${manifest.revision}`,
    tree: createdTree.sha,
    parents: [],
  });
  // Prevent a slow build from publishing over a newer main revision.
  const main = await api(`${base}/git/ref/heads/main`);
  if (main?.object?.sha !== manifest.revision)
    throw Error("main advanced; do not publish an older build.");
  if (ref)
    await api(`${base}/git/refs/heads/hosting-build`, "PATCH", { sha: commit.sha, force: true });
  else await api(`${base}/git/refs`, "POST", { ref: "refs/heads/hosting-build", sha: commit.sha });
  return commit.sha;
}
async function main() {
  const env = process.env;
  if (
    env.GITHUB_REPOSITORY !== "K44DEUSZ/gildiusz" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "push"
  )
    throw Error("Hosting packages are published only for pushes to main.");
  const directory = resolve(process.argv[2]);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  validateBuild(manifest, env.GITHUB_SHA, env.GITHUB_RUN_ID);
  if (!env.GITHUB_TOKEN) throw Error("Missing workflow token.");
  const api = async (path, method = "GET", body) => {
    const response = await globalThis.fetch(`https://api.github.com${path}`, {
      method,
      signal: globalThis.AbortSignal.timeout(60000),
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok) throw Error(`GitHub build publication HTTP ${response.status}.`);
    return response.json();
  };
  console.log(
    `Published hosting build ${await publishBuild(manifest, readFileSync(join(directory, archiveName)), api)}`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
