import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { URL, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { backupV2Fixture } from "./backup-v2-fixture.mjs";
import { deploymentPause, stopSupervisor } from "../scripts/hosting.mjs";

const hostingUrl = new URL("../scripts/hosting.mjs", import.meta.url).href;
const cleanEnvironment = () =>
  Object.fromEntries(
    ["PATH", "HOME", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );

function application(root) {
  const shared = join(root, "shared"),
    release = join(root, "releases", "a".repeat(40));
  for (const path of [
    shared,
    join(shared, "data"),
    join(shared, "logs"),
    join(release, "dist/bot"),
    join(release, "scripts"),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  symlinkSync(release, join(root, "current"), process.platform === "win32" ? "junction" : "dir");
  const file = join(shared, ".env"),
    report = join(shared, "worker-observations.jsonl");
  writeFileSync(file, "APPLICATION_FIXTURE=preserved\n", { mode: 0o600 });
  writeFileSync(
    join(release, "scripts/hosting.mjs"),
    `const[command,root]=process.argv.slice(2);if(command!=='supervise'||!root)throw Error('unexpected_fixture_command');const{supervise}=await import(${JSON.stringify(hostingUrl)});await supervise(root,{interval:25,restartDelay:50});`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(release, "dist/bot/main.js"),
    `const fs=require('node:fs');
const observation={pid:process.pid,keyPresent:Object.keys(process.env).some(name=>name.toUpperCase()==='BACKUP_ENCRYPTION_KEY'),application:process.env.APPLICATION_FIXTURE,recoveryFileInArgv:process.execArgv.some(value=>value.includes('operator.env'))};
fs.appendFileSync(${JSON.stringify(report)},JSON.stringify(observation)+'\\n',{mode:0o600});
const tick=()=>fs.writeFileSync(${JSON.stringify(join(shared, "data/health.json"))},JSON.stringify({ready:true,updated:Date.now()}),{mode:0o600});
tick();const timer=setInterval(tick,25);process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0);});`,
    { mode: 0o600 },
  );
  return { root, shared, release, file, report };
}
function observations(file) {
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
async function waitFor(predicate) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    if (predicate()) return;
    await delay(25);
  }
  throw Error("The isolated hosting fixture did not reach its expected state.");
}
function temporaryApplication(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-hosting-isolation-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /gildiusz-hosting-isolation-[^\\/]+$/);
    rmSync(root, { recursive: true, force: true });
  });
  return application(root);
}

test(
  "the real supervisor strips an operator recovery key but preserves application env and argv",
  { timeout: 15000 },
  async (t) => {
    const f = temporaryApplication(t),
      key = randomBytes(32).toString("base64url"),
      operatorFile = join(f.root, "operator.env");
    writeFileSync(operatorFile, "BACKUP_ENCRYPTION_KEY=" + key + "\n", { mode: 0o600 });
    const supervisor = spawn(
      process.execPath,
      [
        "--env-file=" + operatorFile,
        "--input-type=module",
        "-e",
        `const key=process.env.BACKUP_ENCRYPTION_KEY;if(!key)throw Error('missing_fixture_key');const{supervise}=await import(${JSON.stringify(hostingUrl)});process.stdout.write(JSON.stringify({operatorRetainedKey:process.env.BACKUP_ENCRYPTION_KEY===key,argvContainsKey:process.execArgv.some(value=>value.includes(key))})+'\\n');await supervise(${JSON.stringify(f.root)},{interval:25,restartDelay:50});`,
      ],
      { env: cleanEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let output = "",
      diagnostics = "";
    supervisor.stdout.on("data", (chunk) => (output += chunk));
    supervisor.stderr.on("data", (chunk) => (diagnostics += chunk));
    try {
      await waitFor(() => observations(f.report).length > 0);
      const observed = observations(f.report)[0];
      assert.equal(observed.keyPresent, false);
      assert.equal(observed.application, "preserved");
      assert.equal(observed.recoveryFileInArgv, false);
      const operator = output
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.operatorRetainedKey);
      assert.deepEqual(operator, { operatorRetainedKey: true, argvContainsKey: false });
      assert.equal(output.includes(key) || diagnostics.includes(key), false);
    } finally {
      supervisor.kill("SIGTERM");
      await delay(150);
      for (const observed of observations(f.report)) {
        try {
          process.kill(observed.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      supervisor.kill("SIGKILL");
      await delay(100);
    }
  },
);

test("a key in the application env-file is refused before the default worker can load it", (t) => {
  const f = temporaryApplication(t),
    key = randomBytes(32).toString("base64url");
  writeFileSync(f.file, "APPLICATION_FIXTURE=preserved\nBACKUP_ENCRYPTION_KEY=" + key + "\n", {
    mode: 0o600,
  });
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const{supervise}=await import(${JSON.stringify(hostingUrl)});await supervise(${JSON.stringify(f.root)});`,
    ],
    { env: cleanEnvironment(), encoding: "utf8", timeout: 5000, windowsHide: true },
  );
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /separate private operator environment/);
  assert.equal(existsSync(f.report), false);
  assert.equal(child.stdout.includes(key) || child.stderr.includes(key), false);
});

test(
  "a changed application env-file is revalidated before a real default worker restart",
  { timeout: 15000 },
  async (t) => {
    const f = temporaryApplication(t),
      key = randomBytes(32).toString("base64url"),
      supervisor = spawn(
        process.execPath,
        [join(f.release, "scripts/hosting.mjs"), "supervise", f.root],
        {
          env: cleanEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    let output = "",
      diagnostics = "";
    supervisor.stdout.on("data", (chunk) => (output += chunk));
    supervisor.stderr.on("data", (chunk) => (diagnostics += chunk));
    try {
      await waitFor(() => observations(f.report).length === 1);
      assert.equal(observations(f.report)[0].keyPresent, false);
      writeFileSync(f.file, "APPLICATION_FIXTURE=preserved\nBACKUP_ENCRYPTION_KEY=" + key + "\n", {
        mode: 0o600,
      });
      writeFileSync(join(f.shared, "restart"), "fixture-requested-restart", { mode: 0o600 });
      await waitFor(() => supervisor.exitCode !== null || supervisor.signalCode !== null);
      assert.notEqual(supervisor.exitCode, 0);
      assert.match(diagnostics, /separate private operator environment/);
      assert.equal(observations(f.report).length, 1);
      assert.equal(
        observations(f.report).some((worker) => worker.keyPresent),
        false,
      );
      assert.equal(output.includes(key) || diagnostics.includes(key), false);
    } finally {
      supervisor.kill("SIGTERM");
      await delay(150);
      for (const observed of observations(f.report)) {
        try {
          process.kill(observed.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      supervisor.kill("SIGKILL");
      await delay(100);
    }
  },
);

test(
  "real Linux daily pause, snapshot and background resumption never inherit the operator key",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const f = await backupV2Fixture(t),
      app = application(f.root),
      keyFile = join(f.root, "operator.env"),
      script = join(f.root, "daily-operator.mjs");
    assert.equal(existsSync(join(app.release, "scripts/hosting.mjs")), true);
    writeFileSync(keyFile, "BACKUP_ENCRYPTION_KEY=" + f.key.toString("base64url") + "\n", {
      mode: 0o600,
    });
    const moduleUrl = (path) => pathToFileURL(resolve(path)).href;
    writeFileSync(
      script,
      `import assert from 'node:assert/strict';import{readFileSync,existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';
import{startSupervisor,stopSupervisor,deploymentPause}from ${JSON.stringify(hostingUrl)};
import{runDailyBackup,hostingLifecycle,withHostingBackupLock}from ${JSON.stringify(moduleUrl("scripts/backup-scheduler.mjs"))};
import{BackupCatalog}from ${JSON.stringify(moduleUrl("scripts/backup-catalog.mjs"))};
import{createSnapshot}from ${JSON.stringify(moduleUrl("dist/storage/recovery/index.js"))};
import{sealLatestDeletionProof}from ${JSON.stringify(moduleUrl("scripts/backup-proof.mjs"))};
import{randomUUID}from'node:crypto';
const root=${JSON.stringify(f.root)},report=${JSON.stringify(app.report)},key=process.env.BACKUP_ENCRYPTION_KEY;
const options=${JSON.stringify({ dataRoot: f.dataRoot, guilds: f.options.guilds, release: f.options.release })};
const read=()=>{try{return readFileSync(report,'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return[];}};
const wait=async(n)=>{const end=Date.now()+6000;while(Date.now()<end){if(read().length>=n)return;await delay(25);}throw Error('fixture_resume_timeout');};
try{assert.ok(key);startSupervisor(root);await wait(1);let snapshotCreated=false,proofWhilePaused=false;
const result=await withHostingBackupLock(root,()=>runDailyBackup({catalog:new BackupCatalog({root:${JSON.stringify(f.catalog.root)}}),key,revision:options.release,lifecyclePort:hostingLifecycle(root),snapshotPort:{preflight(){},create({outputPath}){assert.equal(existsSync(${JSON.stringify(join(app.shared, "paused"))}),true);snapshotCreated=true;return createSnapshot({...options,key,outputPath});},async sealLatestProof(){assert.equal(existsSync(${JSON.stringify(join(app.shared, "paused"))}),true);proofWhilePaused=true;const notBefore=Date.now(),challenge=randomUUID(),sealed=await sealLatestDeletionProof({dataRoot:options.dataRoot,installations:options.guilds,key,notBefore,challenge});return{...sealed,proofRequirements:{expectedSourceId:sealed.meta.sourceId,minSequence:sealed.meta.sequence,notBefore,challenge}};}}}));
await wait(2);assert.equal(snapshotCreated,true);assert.equal(proofWhilePaused,true);assert.equal(result.state,'verified');assert.equal(result.localVerificationSucceeded,true);assert.equal(result.offsiteSuccess,false);assert.equal(existsSync(${JSON.stringify(join(app.shared, "paused"))}),false);assert.equal(process.env.BACKUP_ENCRYPTION_KEY,key);const workers=read();assert.notEqual(workers[0].pid,workers[1].pid);for(const worker of workers){assert.equal(worker.keyPresent,false);assert.equal(worker.recoveryFileInArgv,false);assert.equal(worker.application,'preserved');}console.log(JSON.stringify({dailyVerified:true,operatorRetainedKey:true,workersWithoutKey:workers.length,offsiteSuccess:false,argvContainsKey:process.execArgv.some(value=>value.includes(key))}));
}finally{if(!existsSync(${JSON.stringify(join(app.shared, "paused"))}))deploymentPause(root);await stopSupervisor(root);}`,
      { mode: 0o600 },
    );
    try {
      const result = spawnSync(process.execPath, ["--env-file=" + keyFile, script], {
        env: cleanEnvironment(),
        encoding: "utf8",
        timeout: 16000,
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      const summary = result.stdout
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.dailyVerified);
      assert.deepEqual(summary, {
        dailyVerified: true,
        operatorRetainedKey: true,
        workersWithoutKey: 2,
        offsiteSuccess: false,
        argvContainsKey: false,
      });
      assert.equal(
        result.stdout.includes(f.key.toString("base64url")) ||
          result.stderr.includes(f.key.toString("base64url")),
        false,
      );
    } finally {
      // Also clean up a detached fixture supervisor if the operator child times out.
      if (!existsSync(join(app.shared, "paused"))) deploymentPause(f.root);
      await stopSupervisor(f.root);
    }
  },
);
