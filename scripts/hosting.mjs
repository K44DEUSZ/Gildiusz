import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
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
    if (
      state?.release === revision &&
      state.started >= after &&
      healthy(readJson(p.health), Date.now(), state.started)
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

export async function install(root, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw Error("Expected a full commit SHA.");
  const p = paths(root);
  const release = join(root, "releases", sha);
  const source = join(root, "source");
  if (!existsSync(release)) {
    mkdirSync(release, { mode: 0o700 });
    // Export only tracked source; deployment state never enters a release archive.
    const archive = execFileSync("git", ["archive", "--format=tar", sha], {
      cwd: source,
      maxBuffer: 16 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", release], { input: archive });
  }
  if (!existsSync(join(release, ".built"))) {
    run("npm", ["ci", "--ignore-scripts"], release);
    run("npm", ["run", "build"], release);
    run("npm", ["run", "cli", "--", "validate"], release);
    writeFileSync(join(release, ".built"), sha + "\n");
  }
  const previous = existsSync(p.current) ? realpathSync(p.current) : null;
  if (previous === release) return event(root, `already active ${sha}`);
  if (existsSync(p.database)) {
    const { DatabaseSync, backup } = await import("node:sqlite");
    const database = new DatabaseSync(p.database, { readOnly: true });
    try {
      await backup(database, join(p.shared, "backups", `${Date.now()}-before-${sha}.sqlite`));
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
  const response = await globalThis.fetch(
    `https://api.github.com/repos/K44DEUSZ/gildiusz/actions/workflows/check.yml/runs?head_sha=${sha}&event=push&per_page=10`,
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: globalThis.AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw Error(`GitHub checks unavailable: HTTP ${response.status}`);
  if (!checkedRun((await response.json()).workflow_runs ?? [], sha, "main"))
    return event(root, `waiting for successful main checks ${sha}`);
  // Do not activate an older revision if main advanced while checks were being read.
  const remote = run("git", ["ls-remote", "origin", "refs/heads/main"], source).split(/\s/)[0];
  if (remote !== sha) return event(root, "main advanced; waiting for the next scheduler run");
  await install(root, sha);
}

async function main() {
  const [command, argument, sha] = process.argv.slice(2);
  if (!argument)
    throw Error("Usage: hosting.mjs tick|status|install|restart|pause|resume ROOT [SHA]");
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
  background(root, "supervise", "supervisor.lock");
  if (command === "tick") background(root, "update", "deploy.lock");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((error) => {
    // Subprocess stderr may contain configuration values; keep errors at the command level.
    console.error(error.message.split("\n")[0]);
    process.exitCode = 1;
  });
