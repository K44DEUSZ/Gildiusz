import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseRequest(environment, metadata) {
  if (
    environment.GITHUB_REPOSITORY !== "K44DEUSZ/gildiusz" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.RELEASE_PUBLISH !== "true"
  )
    throw Error("Release requires an explicit manual publication from main.");
  const version = environment.RELEASE_VERSION;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
    version !== metadata.version
  )
    throw Error("The requested version must exactly match package.json.");
  if (!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? ""))
    throw Error("Expected the exact checked commit.");
  return { version, sha: environment.GITHUB_SHA };
}

export async function publishRelease(request, api) {
  const base = "/repos/K44DEUSZ/gildiusz";
  const { version, sha } = request;
  const head = await api(`${base}/git/ref/heads/main`);
  if (head.object.sha !== sha) throw Error("main changed after checks; start a new release run.");
  const tag = `v${version}`;
  const [existingTag, existingRelease] = await Promise.all([
    api(`${base}/git/ref/tags/${tag}`),
    api(`${base}/releases/tags/${tag}`),
  ]);
  if (existingTag || existingRelease) throw Error("The tag or release already exists.");
  await api(`${base}/git/refs`, "POST", { ref: `refs/tags/${tag}`, sha });
  const createdTag = await api(`${base}/git/ref/tags/${tag}`);
  if (createdTag?.object?.sha !== sha)
    throw Error("The release tag does not match the checked commit.");
  return api(`${base}/releases`, "POST", {
    tag_name: tag,
    target_commitish: sha,
    name: `Gildiusz ${version}`,
    generate_release_notes: true,
    draft: false,
    prerelease: version.startsWith("0.") || version.includes("-"),
    make_latest: "false",
  });
}

async function main() {
  const request = releaseRequest(process.env, JSON.parse(readFileSync("package.json", "utf8")));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw Error("Missing GitHub Actions token.");
  const api = async (path, method = "GET", body) => {
    const response = await globalThis.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Gildiusz-Release",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok) throw Error(`GitHub HTTP ${response.status}.`);
    return response.json();
  };
  const release = await publishRelease(request, api);
  console.log(release.html_url);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
