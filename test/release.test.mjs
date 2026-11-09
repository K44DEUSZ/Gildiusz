import assert from "node:assert/strict";
import test from "node:test";
import { publishRelease, releaseRequest } from "../scripts/release.mjs";

const sha = "a".repeat(40);
const environment = {
  GITHUB_REPOSITORY: "K44DEUSZ/Gildiusz",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: sha,
  RELEASE_PUBLISH: "true",
  RELEASE_VERSION: "0.1.0",
};
test("publication requires a deliberate main-branch request for the exact manifest version", () => {
  assert.deepEqual(releaseRequest(environment, { version: "0.1.0" }), { version: "0.1.0", sha });
  for (const patch of [
    { GITHUB_REPOSITORY: "someone/gildiusz" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_EVENT_NAME: "push" },
    { RELEASE_PUBLISH: "false" },
    { RELEASE_VERSION: "0.2.0" },
    { RELEASE_VERSION: "0.1.0;echo invalid" },
    { GITHUB_SHA: "main" },
  ])
    assert.throws(() => releaseRequest({ ...environment, ...patch }, { version: "0.1.0" }));
});
test("changed main and existing tags or releases prevent all publication writes", async () => {
  for (const conflict of ["head", "tag", "release"]) {
    let writes = 0;
    const api = async (path, method = "GET") => {
      if (method !== "GET") writes++;
      if (path.endsWith("heads/main"))
        return { object: { sha: conflict === "head" ? "b".repeat(40) : sha } };
      if (conflict === "tag" && path.includes("/git/ref/tags/")) return {};
      if (conflict === "release" && path.includes("/releases/tags/")) return {};
      return null;
    };
    await assert.rejects(publishRelease({ version: "0.1.0", sha }, api));
    assert.equal(writes, 0);
  }
});
test("a release targets the checked SHA without changing the manifest or deploying", async () => {
  const writes = [];
  let created = false;
  const api = async (path, method = "GET", body) => {
    if (method === "POST") {
      writes.push({ path, body });
      created = true;
      return { html_url: "release-url" };
    }
    if (created && path.includes("/git/ref/tags/")) return { object: { sha } };
    return path.endsWith("heads/main") ? { object: { sha } } : null;
  };
  await publishRelease({ version: "0.1.0", sha }, api);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, { ref: "refs/tags/v0.1.0", sha });
  assert.equal(writes[1].path, "/repos/K44DEUSZ/Gildiusz/releases");
  assert.equal(writes[1].body.target_commitish, sha);
  assert.equal(writes[1].body.tag_name, "v0.1.0");
  assert.equal(writes[1].body.prerelease, true);
});
