import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { archiveName, validateBuild, verifyArchive } from "./build-package.mjs";
import { cleanLegacyBuild, pruneReleases, rotateLogs } from "./maintenance.mjs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const repository = "https://github.com/K44DEUSZ/gildiusz.git";
const environment = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };

function paths(root) {
  return {
    shared: join(root, "shared"),
    state: join(root, "shared", "supervisor.json"),
    health: join(root, "shared", "data", "health.json"),
    database: join(root, "shared", "data", "gildiusz.sqlite"),
    pause: join(root, "shared", "paused"),
    restart: join(root, "shared", "restart"),
    current: join(root, "current"),
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function atomicJson(path, value) {
  const text = JSON.stringify(value) + "\n";
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  try {
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    // Windows readers can temporarily deny replacement; Linux hosting keeps atomic renames.
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    writeFileSync(path, text, { mode: 0o600 });
    rmSync(`${path}.tmp`, { force: true });
  }
}

function event(root, message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  appendFileSync(join(root, "shared", "logs", "hosting.log"), line, { mode: 0o600 });
  console.log(line.trim());
}

export function healthy(health, now = Date.now(), after = 0) {
  return Boolean(health?.ready && health.updated >= after && now - health.updated < 60000);
}

export function checkedRun(runs, sha, branch) {
  return runs.some(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === branch &&
      run.event === "push" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.path === ".github/workflows/check.yml",
  );
}

export async function supervise(root, options = {}) {
  const p = paths(root);
  const supervisorRevision = basename(realpathSync(p.current));
  const previous = readJson(p.state);
  if (process.platform === "linux" && previous?.childPid && previous?.childBirth) {
    const matchesPreviousWorker = () => {
      try {
        const birth = readFileSync(`/proc/${previous.childPid}/stat`, "utf8")
          .split(") ")[1]
          .split(" ")[19];
        const command = readFileSync(`/proc/${previous.childPid}/cmdline`, "utf8").split("\0");
        return (
          birth === previous.childBirth &&
          command.includes("--env-file=" + join(p.shared, ".env")) &&
          realpathSync(`/proc/${previous.childPid}/cwd`) ===
            join(root, "releases", previous.release)
        );
      } catch {
        return false;
      }
    };
    if (matchesPreviousWorker()) {
      event(root, `stopping orphan worker pid=${previous.childPid}`);
      process.kill(previous.childPid, "SIGTERM");
      const deadline = Date.now() + 20000;
      while (matchesPreviousWorker() && Date.now() < deadline) await delay(250);
      if (matchesPreviousWorker()) process.kill(previous.childPid, "SIGKILL");
    }
  }
  let child;
  let childBirth;
  let started = 0;
  let release;
  let stopping = false;
  let restartValue = "";
  let restarts = 0;
  let nextStart = 0;
  let terminationAt = 0;
  const interval = options.interval ?? 2000;
  const state = () =>
    atomicJson(p.state, {
      supervisorPid: process.pid,
      supervisorRevision,
      childPid: child?.pid ?? null,
      childBirth: child ? childBirth : null,
      release: release ? basename(release) : null,
      started,
      restarts,
      updated: Date.now(),
      paused: existsSync(p.pause),
    });
  const terminate = () => {
    if (child && !terminationAt) {
      terminationAt = Date.now();
      child.kill("SIGTERM");
    }
  };
  const stop = () => {
    stopping = true;
    terminate();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping || child) {
      const desired = realpathSync(p.current);
      const requested = existsSync(p.restart) ? readFileSync(p.restart, "utf8") : "";
      if (child) {
        const stale = Date.now() - started > 90000 && !healthy(readJson(p.health));
        if (
          stopping ||
          existsSync(p.pause) ||
          desired !== release ||
          requested !== restartValue ||
          stale
        )
          terminate();
        if (terminationAt && Date.now() - terminationAt > 20000) child.kill("SIGKILL");
      } else if (!stopping && !existsSync(p.pause) && Date.now() >= nextStart) {
        release = desired;
        restartValue = requested;
        started = Date.now();
        terminationAt = 0;
        // A new PID must produce a new health signal; a previous process cannot certify it.
        atomicJson(p.health, { ready: false, updated: started });
        const log = openSync(join(p.shared, "logs", "bot.log"), "a", 0o600);
        child = spawn(
          process.execPath,
          options.workerArguments ?? ["--env-file=" + join(p.shared, ".env"), "dist/bot/main.js"],
          { cwd: release, env: environment, stdio: ["ignore", log, log] },
        );
        closeSync(log);
        if (process.platform === "linux" && child.pid) {
          try {
            childBirth = readFileSync(`/proc/${child.pid}/stat`, "utf8")
              .split(") ")[1]
              .split(" ")[19];
          } catch {
            childBirth = null;
          }
        }
        event(root, `worker started pid=${child.pid} revision=${basename(release)}`);
        child.once("exit", (code, signal) => {
          event(root, `worker exited code=${code} signal=${signal}`);
          child = undefined;
          nextStart = Date.now() + (options.restartDelay ?? 5000);
          restarts++;
          state();
        });
        child.once("error", (error) => {
          event(root, `worker spawn error: ${error.code}`);
          child = undefined;
          nextStart = Date.now() + (options.restartDelay ?? 5000);
        });
      }
      state();
      await delay(interval);
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    state();
  }
}

function background(root, command, lock) {
  const log = openSync(join(root, "shared", "logs", "scheduler.log"), "a", 0o600);
  const child = spawn(
    "flock",
    [
      "-o",
      "-n",
      join(root, "shared", lock),
      process.execPath,
      join(root, "current", "scripts", "hosting.mjs"),
      command,
      root,
    ],
    { detached: true, stdio: ["ignore", log, log], env: environment },
  );
  child.on("error", (error) => event(root, `scheduler spawn error: ${error.code}`));
  child.unref();
  closeSync(log);
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function pointTo(root, target) {
  const temporary = join(root, "current.next");
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary, "dir");
  renameSync(temporary, join(root, "current"));
}

async function waitReady(root, revision, after, timeout = 100000) {
  const p = paths(root);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = readJson(p.state);
    const health = readJson(p.health);
    if (
      state?.release === revision &&
      state.started >= after &&
      healthy(health, Date.now(), state.started) &&
      (health.guilds ?? []).every((guild) => guild.ready)
    )
      return true;
    await delay(2000);
  }
  return false;
}

async function stopSupervisor(root) {
  const state = readJson(paths(root).state);
  if (!state?.supervisorPid) return;
  const matches = () => {
    try {
      const args = readFileSync(`/proc/${state.supervisorPid}/cmdline`, "utf8").split("\0");
      return args.includes("supervise") && args.includes(root);
    } catch {
      return false;
    }
  };
  if (!matches()) return;
  process.kill(state.supervisorPid, "SIGTERM");
  const deadline = Date.now() + 20000;
  while (matches() && Date.now() < deadline) await delay(250);
  if (matches()) {
    process.kill(state.supervisorPid, "SIGKILL");
    await delay(500);
  }
}

async function checkedWorkflow(sha) {
  const response = await globalThis.fetch(
    `https://api.github.com/repos/K44DEUSZ/gildiusz/actions/workflows/check.yml/runs?head_sha=${sha}&event=push&per_page=10`,
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: globalThis.AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw Error(`GitHub checks unavailable: HTTP ${response.status}`);
  return (await response.json()).workflow_runs?.find((run) => checkedRun([run], sha, "main"));
}

async function download(url, maximum) {
  const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Build download HTTP ${response.status}`);
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw Error("Build download exceeds the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function validateArchiveEntries(names, types) {
  const allowed = new Set([
    "dist",
    "content",
    "config",
    "scripts",
    "node_modules",
    "package.json",
    "package-lock.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "build.json",
  ]);
  for (const raw of names) {
    const name = raw.replace(/^\.\//, "");
    if (!name) continue;
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      !allowed.has(name.split("/")[0])
    )
      throw Error("Unsafe entry in the hosting package.");
  }
  if (types.some((type) => type !== "-" && type !== "d"))
    throw Error("Hosting packages cannot contain links or special files.");
}

export function prepareRelease(root, manifest, bytes) {
  validateBuild(manifest, manifest.revision, manifest.workflowRun);
  verifyArchive(manifest, bytes);
  const releases = join(root, "releases");
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const release = join(releases, manifest.revision);
  if (existsSync(release)) {
    const previous = readJson(join(release, "build.json"));
    if (previous?.revision !== manifest.revision || previous?.workflowRun !== manifest.workflowRun)
      throw Error("Existing release does not match this build.");
    return release;
  }
  const staging = mkdtempSync(join(releases, ".incoming-"));
  if (dirname(staging) !== releases) throw Error("Unexpected staging directory.");
  try {
    const archive = join(staging, archiveName);
    writeFileSync(archive, bytes, { mode: 0o600 });
    const names = run("tar", ["-tzf", archive], root).split("\n");
    const types = run("tar", ["-tvzf", archive], root)
      .split("\n")
      .map((line) => line[0]);
    validateArchiveEntries(names, types);
    execFileSync("tar", ["-xzf", archive, "-C", staging]);
    rmSync(archive);
    const metadata = readJson(join(staging, "build.json"));
    if (
      metadata?.revision !== manifest.revision ||
      metadata?.workflowRun !== manifest.workflowRun ||
      metadata?.nodeMajor !== 24
    )
      throw Error("Unpacked build identity differs.");
    if (
      !existsSync(join(staging, "dist", "bot", "main.js")) ||
      !existsSync(join(staging, "node_modules", "discord.js", "package.json"))
    )
      throw Error("Incomplete production package.");
    run(process.execPath, ["dist/cli.js", "validate"], staging);
    writeFileSync(join(staging, ".built"), manifest.revision + "\n");
    renameSync(staging, release);
    return release;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function retrieveRelease(root, sha, workflow) {
  const commit = run(
    "git",
    ["ls-remote", "origin", "refs/heads/hosting-build"],
    join(root, "source"),
  ).split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw Error("The hosting build is not published yet.");
  const base = `https://raw.githubusercontent.com/K44DEUSZ/gildiusz/${commit}`;
  const manifest = JSON.parse((await download(`${base}/manifest.json`, 16384)).toString("utf8"));
  validateBuild(manifest, sha, String(workflow.id));
  const bytes = await download(`${base}/${archiveName}`, manifest.size);
  return prepareRelease(root, manifest, bytes);
}

export function deploymentState(root, release) {
  return JSON.parse(
    run(
      process.execPath,
      [
        "--env-file=" + join(root, "shared", ".env"),
        "--input-type=module",
        "-e",
        'import {loadInstallations} from "./dist/installations.js";import {loadConfig} from "./dist/config.js";import {lintContent} from "./dist/content.js";const entries=loadInstallations();if(process.env.PUBLIC_INSTALLS==="1"){const {PublicInstallations}=await import("./dist/control/installations.js");const {healthPath}=await import("./dist/installations.js");const {dirname,join}=await import("node:path");const registry=new PublicInstallations(process.env.CONTROL_DATA_DIR||join(dirname(healthPath()),"public-guilds"));for(const entry of registry.values())if(!entries.some(value=>value.guildId===entry.guildId))entries.push(entry);}for(const entry of entries){if(entry.public)continue;const errors=lintContent(loadConfig(entry.configPath));if(errors.length)throw Error("Invalid guild configuration.");}console.log(JSON.stringify(entries.map(({guildId,databasePath})=>({guildId,databasePath}))));',
      ],
      release,
    ),
  );
}

export async function install(root, sha, checked) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw Error("Expected a full commit SHA.");
  const workflow = checked ?? (await checkedWorkflow(sha));
  if (!workflow) throw Error("This revision has no successful main push checks.");
  const p = paths(root);
  const release = await retrieveRelease(root, sha, workflow);
  const installations = deploymentState(root, release);
  const previous = existsSync(p.current) ? realpathSync(p.current) : null;
  if (previous === release) return event(root, `already active ${sha}`);
  for (const installation of installations) {
    if (!existsSync(installation.databasePath)) continue;
    const { DatabaseSync, backup } = await import("node:sqlite");
    const database = new DatabaseSync(installation.databasePath, { readOnly: true });
    try {
      await backup(
        database,
        join(p.shared, "backups", `${Date.now()}-${installation.guildId}-before-${sha}.sqlite`),
      );
    } finally {
      database.close();
    }
  }
  const activated = Date.now();
  // Restart the supervisor as well, so updates to hosting code take effect with the release.
  await stopSupervisor(root);
  pointTo(root, release);
  event(root, `activating ${sha}`);
  background(root, "supervise", "supervisor.lock");
  if (await waitReady(root, sha, activated)) {
    rmSync(join(p.shared, "failed-revision"), { force: true });
    event(root, `activation healthy ${sha}`);
    try {
      const removed = pruneReleases(root, previous ? basename(previous) : null);
      if (removed.length) event(root, `pruned old releases count=${removed.length}`);
    } catch (error) {
      // A cleanup problem must never roll back a healthy deployment.
      event(root, `release cleanup skipped: ${error.message}`);
    }
    return;
  }
  writeFileSync(join(p.shared, "failed-revision"), sha, { mode: 0o600 });
  if (previous) {
    const reverted = Date.now();
    await stopSupervisor(root);
    pointTo(root, previous);
    event(root, `rollback to ${basename(previous)}`);
    background(root, "supervise", "supervisor.lock");
    const recovered = await waitReady(root, basename(previous), reverted);
    event(root, `rollback healthy=${recovered}`);
  } else {
    writeFileSync(p.pause, "Initial activation failed.\n", { mode: 0o600 });
  }
  throw Error("New release did not become healthy; inspect private hosting logs.");
}

async function update(root) {
  if (!existsSync(join(root, "shared", "autodeploy-enabled"))) return;
  const source = join(root, "source");
  if (run("git", ["remote", "get-url", "origin"], source) !== repository)
    throw Error("Unexpected source repository.");
  run("git", ["fetch", "--quiet", "origin", "main"], source);
  const sha = run("git", ["rev-parse", "FETCH_HEAD"], source);
  if (existsSync(paths(root).current) && basename(realpathSync(paths(root).current)) === sha)
    return;
  const failed = join(root, "shared", "failed-revision");
  if (existsSync(failed) && readFileSync(failed, "utf8") === sha) return;
  const workflow = await checkedWorkflow(sha);
  if (!workflow) return event(root, `waiting for successful main checks and package ${sha}`);
  // Do not activate an older revision if main advanced while checks were being read.
  const remote = run("git", ["ls-remote", "origin", "refs/heads/main"], source).split(/\s/)[0];
  if (remote !== sha) return event(root, "main advanced; waiting for the next scheduler run");
  await install(root, sha, workflow);
}

async function main() {
  const [command, argument, sha] = process.argv.slice(2);
  if (!argument)
    throw Error("Usage: hosting.mjs tick|status|install|restart|pause|resume|cleanup ROOT [SHA]");
  const root = resolve(argument);
  const p = paths(root);
  for (const directory of [
    p.shared,
    join(p.shared, "data"),
    join(p.shared, "logs"),
    join(p.shared, "backups"),
  ])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (command === "supervise") return supervise(root);
  if (command === "install") return install(root, sha);
  if (command === "update") return update(root);
  if (command === "cleanup") {
    if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw Error("Specify the rollback release SHA.");
    console.log(
      run(
        "flock",
        [
          "-n",
          join(p.shared, "deploy.lock"),
          process.execPath,
          join(root, "current", "scripts", "hosting.mjs"),
          "cleanup-locked",
          root,
          sha,
        ],
        root,
      ),
    );
    return;
  }
  if (command === "cleanup-locked") {
    const active = realpathSync(p.current);
    const state = readJson(p.state),
      health = readJson(p.health);
    if (
      !healthy(health) ||
      health.guilds?.some((guild) => !guild.ready) ||
      state?.release !== basename(active)
    )
      throw Error("Cleanup requires a healthy current deployment.");
    if (run("git", ["remote", "get-url", "origin"], join(root, "source")) !== repository)
      throw Error("Unexpected source repository.");
    const removedReleases = pruneReleases(root, sha);
    const legacy = cleanLegacyBuild(root);
    const receipt = {
      time: new Date().toISOString(),
      current: basename(active),
      previous: sha,
      removedReleases,
      ...legacy,
    };
    atomicJson(join(p.shared, "logs", "cleanup.json"), receipt);
    event(
      root,
      `cleanup completed: old releases=${removedReleases.length}; legacy=${legacy.removed.length}`,
    );
    console.log(JSON.stringify(receipt));
    return;
  }
  if (command === "status") {
    console.log(
      JSON.stringify({
        ...readJson(p.state),
        health: readJson(p.health),
        healthy: healthy(readJson(p.health)),
      }),
    );
    return;
  }
  if (command === "pause") writeFileSync(p.pause, "Paused by operator.\n", { mode: 0o600 });
  else if (command === "resume") rmSync(p.pause, { force: true });
  else if (command === "restart") writeFileSync(p.restart, String(Date.now()), { mode: 0o600 });
  else if (command !== "tick") throw Error("Unknown hosting command.");
  if (
    command === "tick" &&
    readJson(p.state)?.supervisorRevision !== basename(realpathSync(p.current))
  )
    await stopSupervisor(root);
  if (command === "tick") {
    try {
      rotateLogs(root);
    } catch (error) {
      event(root, `log rotation skipped: ${error.message}`);
    }
  }
  background(root, "supervise", "supervisor.lock");
  if (command === "tick") background(root, "update", "deploy.lock");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((error) => {
    // Subprocess stderr may contain configuration values; keep errors at the command level.
    console.error(error.message.split("\n")[0]);
    process.exitCode = 1;
  });
