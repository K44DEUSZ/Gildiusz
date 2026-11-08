import test from "node:test";
import assert from "node:assert/strict";
import { healthy, checkedRun } from "../scripts/hosting.mjs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

test("hosting requires a fresh ready signal from the current worker", () => {
  assert.equal(healthy({ ready: true, updated: 1000 }, 2000, 500), true);
  assert.equal(healthy({ ready: true, updated: 1000 }, 2000, 1500), false);
  assert.equal(healthy({ ready: true, updated: 1000 }, 62000), false);
  assert.equal(healthy({ ready: false, updated: 2000 }, 2000), false);
  assert.equal(healthy(null), false);
});

test(
  "supervisor recovers a crashed worker and respects pause and resume",
  { timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gildiusz-hosting-"));
    const release = join(root, "releases", "a".repeat(40));
    mkdirSync(release, { recursive: true });
    mkdirSync(join(root, "shared", "data"), { recursive: true });
    mkdirSync(join(root, "shared", "logs"), { recursive: true });
    symlinkSync(release, join(root, "current"), process.platform === "win32" ? "junction" : "dir");
    const worker = `import {writeFileSync} from 'node:fs';const tick=()=>writeFileSync('../../shared/data/health.json',JSON.stringify({ready:true,updated:Date.now()}));tick();setInterval(tick,50);`;
    const supervisor = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {supervise} from ${JSON.stringify(new URL("../scripts/hosting.mjs", import.meta.url).href)};await supervise(${JSON.stringify(root)},{interval:25,restartDelay:50,workerArguments:['--input-type=module','-e',${JSON.stringify(worker)}]});`,
      ],
      { stdio: "ignore" },
    );
    let workerPid;
    const state = () => {
      try {
        return JSON.parse(readFileSync(join(root, "shared", "supervisor.json"), "utf8"));
      } catch {
        return {};
      }
    };
    const waitFor = async (predicate) => {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const value = state();
        if (predicate(value)) return value;
        await delay(25);
      }
      throw Error("Supervisor did not reach the expected state.");
    };
    try {
      workerPid = (await waitFor((s) => s.childPid)).childPid;
      process.kill(workerPid, "SIGKILL");
      const recovered = await waitFor((s) => s.childPid && s.childPid !== workerPid);
      workerPid = recovered.childPid;
      assert.ok(recovered.restarts >= 1);
      writeFileSync(join(root, "shared", "paused"), "pause");
      await waitFor((s) => s.paused && s.childPid === null);
      rmSync(join(root, "shared", "paused"));
      workerPid = (await waitFor((s) => s.childPid)).childPid;
    } finally {
      supervisor.kill("SIGTERM");
      await delay(200);
      if (workerPid) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {
          // The fixture may already have stopped during the supervisor shutdown.
        }
      }
      supervisor.kill("SIGKILL");
      await delay(100);
      assert.ok(root.startsWith(join(tmpdir(), "gildiusz-hosting-")));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("automatic hosting updates require successful push checks for the exact main revision", () => {
  const run = {
    head_sha: "a".repeat(40),
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/check.yml",
  };
  assert.equal(checkedRun([run], run.head_sha, "main"), true);
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { head_branch: "test" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { path: ".github/workflows/release.yml" },
  ])
    assert.equal(checkedRun([{ ...run, ...patch }], run.head_sha, "main"), false);
});
