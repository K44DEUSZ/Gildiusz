import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { backupEnvironmentArguments } from "../scripts/hosting.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gildiusz-backup-environment-")),
    shared = join(root, "shared"),
    file = join(shared, "backup-key.env");
  mkdirSync(shared, { mode: 0o700 });
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(root, /gildiusz-backup-environment-[^\\/]+$/);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, shared, file };
}

test("a separate private backup key is passed only as an operator file, without changing process credentials", (t) => {
  const f = fixture(t),
    key = randomBytes(32).toString("base64url"),
    ambient = process.env.BACKUP_ENCRYPTION_KEY;
  assert.deepEqual(backupEnvironmentArguments(f.root), ["--env-file=" + join(f.shared, ".env")]);
  writeFileSync(f.file, "BACKUP_ENCRYPTION_KEY=" + key + "\n", { mode: 0o600 });
  const args = backupEnvironmentArguments(f.root);
  assert.deepEqual(args, ["--env-file=" + join(f.shared, ".env"), "--env-file=" + f.file]);
  assert.equal(args.join(" ").includes(key), false);
  assert.equal(process.env.BACKUP_ENCRYPTION_KEY, ambient);
});

test("the additional file cannot introduce bootstrap flags, app tokens, empty or malformed keys", (t) => {
  const f = fixture(t),
    key = randomBytes(32).toString("base64url");
  for (const text of [
    "",
    "BACKUP_ENCRYPTION_KEY=bad",
    "NODE_OPTIONS=--no-warnings",
    "BACKUP_ENCRYPTION_KEY=" + key + "\nDISCORD_TOKEN=unexpected",
  ]) {
    writeFileSync(f.file, text, { mode: 0o600 });
    assert.throws(() => backupEnvironmentArguments(f.root));
  }
});

test("linked and readable backup secrets are refused before a recovery subprocess starts", (t) => {
  const f = fixture(t);
  writeFileSync(f.file, "BACKUP_ENCRYPTION_KEY=" + randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });
  const second = join(f.shared, "same-key");
  linkSync(f.file, second);
  assert.throws(() => backupEnvironmentArguments(f.root));
  unlinkSync(second);
  if (process.platform !== "win32") {
    chmodSync(f.file, 0o644);
    assert.throws(() => backupEnvironmentArguments(f.root));
    chmodSync(f.file, 0o600);
  }
  unlinkSync(f.file);
  try {
    symlinkSync(join(f.shared, "missing-key"), f.file);
  } catch (e) {
    if (e.code === "EPERM") return;
    throw e;
  }
  assert.throws(() => backupEnvironmentArguments(f.root));
});
