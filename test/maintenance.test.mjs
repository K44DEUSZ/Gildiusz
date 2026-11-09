import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanLegacyBuild, pruneReleases, rotateLogs } from "../scripts/maintenance.mjs";

const active = "a".repeat(40),
  previous = "b".repeat(40),
  obsolete = "c".repeat(40);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-maintenance-"));
  const root = join(directory, "project");
  for (const path of ["releases", "shared/logs", "shared/backups", "source/.git"])
    mkdirSync(join(root, path), { recursive: true });
  for (const revision of [active, previous, obsolete]) {
    const release = join(root, "releases", revision);
    mkdirSync(release);
    writeFileSync(join(release, ".built"), revision + "\n");
  }
  const link = (target, path) =>
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  link(join(root, "releases", active), join(root, "current"));
  t.after(() => {
    assert.ok(directory.startsWith(join(tmpdir(), "gildiusz-maintenance-")));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root, link };
}

test("release cleanup preserves the active and rollback versions, private data and unmanaged paths", (t) => {
  const f = fixture(t);
  const outside = join(f.directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "outside");
  const linked = "d".repeat(40),
    unknown = "e".repeat(40);
  f.link(outside, join(f.root, "releases", linked));
  mkdirSync(join(f.root, "releases", unknown));
  writeFileSync(join(f.root, "shared", ".env"), "private");
  assert.deepEqual(pruneReleases(f.root, previous), [obsolete]);
  for (const revision of [active, previous, linked, unknown])
    assert.equal(existsSync(join(f.root, "releases", revision)), true);
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "outside");
  assert.equal(readFileSync(join(f.root, "shared", ".env"), "utf8"), "private");
  assert.deepEqual(pruneReleases(f.root, previous), []);
});

test("cleanup without a verified rollback version cannot remove releases", (t) => {
  const f = fixture(t);
  assert.deepEqual(pruneReleases(f.root, null), []);
  for (const target of [active, "../shared", "f".repeat(40)])
    assert.throws(() => pruneReleases(f.root, target));
  assert.equal(existsSync(join(f.root, "releases", obsolete)), true);
});

test("log rotation keeps an open worker descriptor usable and ignores unrelated files", (t) => {
  const f = fixture(t),
    path = join(f.root, "shared", "logs", "bot.log");
  writeFileSync(path, "old entries");
  const descriptor = openSync(path, "a");
  const inode = statSync(path).ino;
  try {
    writeFileSync(join(f.root, "shared", "logs", "operator.log"), "private log");
    assert.deepEqual(rotateLogs(f.root, 5), ["bot.log"]);
    assert.equal(readFileSync(`${path}.1`, "utf8"), "old entries");
    assert.equal(statSync(path).ino, inode);
    writeFileSync(descriptor, "new");
    assert.equal(readFileSync(path, "utf8"), "new");
    assert.equal(
      readFileSync(join(f.root, "shared", "logs", "operator.log"), "utf8"),
      "private log",
    );
    assert.deepEqual(rotateLogs(f.root, 5), []);
  } finally {
    closeSync(descriptor);
  }
});

test(
  "rotation never overwrites a symlink used as an archive destination",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t),
      path = join(f.root, "shared", "logs", "bot.log");
    writeFileSync(path, "keep all entries");
    const missing = join(f.directory, "missing-target");
    symlinkSync(missing, `${path}.1`);
    assert.deepEqual(rotateLogs(f.root, 5), []);
    assert.equal(existsSync(missing), false);
    assert.equal(readFileSync(path, "utf8"), "keep all entries");
  },
);

test("legacy cleanup removes only unused build output and archives the one-off installer", (t) => {
  const f = fixture(t);
  for (const path of ["source/node_modules", "source/dist", "source/src", "shared/installer-v2"])
    mkdirSync(join(f.root, path), { recursive: true });
  writeFileSync(join(f.root, "source", "src", "keep.ts"), "source");
  writeFileSync(join(f.root, "shared", "installer-v2", "hosting.mjs"), "installer");
  const result = cleanLegacyBuild(f.root);
  assert.deepEqual(result.removed, ["source/node_modules", "source/dist"]);
  assert.deepEqual(result.archived, ["shared/backups/migration-installer-v2"]);
  assert.equal(readFileSync(join(f.root, "source", "src", "keep.ts"), "utf8"), "source");
  assert.equal(
    readFileSync(
      join(f.root, "shared", "backups", "migration-installer-v2", "hosting.mjs"),
      "utf8",
    ),
    "installer",
  );
  assert.deepEqual(cleanLegacyBuild(f.root), { removed: [], archived: [] });
});

test("legacy cleanup rejects a build directory linked outside the source tree", (t) => {
  const f = fixture(t),
    outside = join(f.directory, "external-build");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "external");
  f.link(outside, join(f.root, "source", "node_modules"));
  assert.throws(() => cleanLegacyBuild(f.root));
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "external");
});
