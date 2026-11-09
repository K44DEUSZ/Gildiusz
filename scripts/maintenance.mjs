import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  truncateSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const revisionPattern = /^[a-f0-9]{40}$/;
function plainDirectory(path) {
  return existsSync(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
}
function ownedChild(parent, name) {
  const path = join(parent, name);
  if (dirname(path) !== parent || !plainDirectory(path) || realpathSync(path) !== path)
    throw Error("Expected an ordinary directory directly inside the managed parent.");
  return path;
}
function managedRelease(releases, revision) {
  if (!revisionPattern.test(revision ?? "")) throw Error("Expected a full release SHA.");
  const directory = ownedChild(releases, revision);
  const marker = join(directory, ".built");
  if (!existsSync(marker)) throw Error("Release is not marked as managed.");
  const stat = lstatSync(marker);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 128 ||
    stat.nlink !== 1 ||
    readFileSync(marker, "utf8").trim() !== revision
  )
    throw Error("Invalid managed release marker.");
  return directory;
}

export function pruneReleases(root, previous) {
  if (!previous) return [];
  const releases = realpathSync(join(root, "releases"));
  const active = realpathSync(join(root, "current"));
  const current = basename(active);
  if (managedRelease(releases, current) !== active || previous === current)
    throw Error("The rollback release must differ from the active managed release.");
  managedRelease(releases, previous);
  const removed = [];
  for (const revision of readdirSync(releases)) {
    if (!revisionPattern.test(revision) || revision === current || revision === previous) continue;
    let directory;
    try {
      directory = managedRelease(releases, revision);
    } catch {
      continue;
    }
    // Recheck the active target before every deletion, even when the caller holds deploy.lock.
    if (realpathSync(join(root, "current")) !== active)
      throw Error("Active release changed during cleanup.");
    rmSync(directory, { recursive: true });
    removed.push(revision);
  }
  return removed;
}

export function rotateLogs(root, maximum = 5 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw Error("Invalid log size limit.");
  const logs = realpathSync(join(root, "shared", "logs"));
  const rotated = [];
  for (const name of ["bot.log", "hosting.log", "scheduler.log", "cron.log"]) {
    const path = join(logs, name),
      archive = `${path}.1`;
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= maximum)
      continue;
    const old = lstatSync(archive, { throwIfNoEntry: false });
    if (old) {
      if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1) continue;
    }
    // Keep the inode: running workers retain their open descriptors after rotation.
    copyFileSync(path, archive);
    chmodSync(archive, 0o600);
    truncateSync(path, 0);
    rotated.push(name);
  }
  return rotated;
}

export function cleanLegacyBuild(root) {
  const project = realpathSync(root);
  const source = ownedChild(project, "source");
  ownedChild(source, ".git");
  const removed = [];
  for (const name of ["node_modules", "dist"]) {
    const path = join(source, name);
    if (!existsSync(path)) continue;
    ownedChild(source, name);
    rmSync(path, { recursive: true });
    removed.push(`source/${name}`);
  }
  const shared = ownedChild(project, "shared");
  const installer = join(shared, "installer-v2");
  const archived = [];
  if (existsSync(installer)) {
    ownedChild(shared, "installer-v2");
    const backups = ownedChild(shared, "backups");
    const target = join(backups, "migration-installer-v2");
    if (!existsSync(target)) {
      renameSync(installer, target);
      archived.push("shared/backups/migration-installer-v2");
    }
  }
  return { removed, archived };
}
