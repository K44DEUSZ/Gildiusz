import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { acquireLock } from "../lock.js";

export const restoreQuarantineFile = "restore-quarantine.json";
export const sourcePreparationFile = "source-preparation.json";
export const coldSourceFenceFile = "source-cold-pair.json";

function markerState(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function assertColdSourceFenceAbsent(dataRoot: string): void {
  if (!isAbsolute(dataRoot)) throw new Error("Recovery requires an absolute private data root.");
  if (markerState(join(dataRoot, coldSourceFenceFile)))
    throw new Error(
      "The source is sealed for a controlled cold recovery. Keep all writers stopped.",
    );
  const compatibility = join(dataRoot, sourcePreparationFile),
    stat = markerState(compatibility);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error("Unknown source preparation marker.");
  const value = JSON.parse(readFileSync(compatibility, "utf8"));
  if (value?.kind === "gildiusz-controlled-cold-source")
    throw new Error(
      "The source is sealed for a controlled cold recovery. Keep all writers stopped.",
    );
  if (
    value?.format !== 1 ||
    Object.keys(value).sort().join(",") !==
      "backupId,format,operationId,sourceRevision,startedAt" ||
    !/^[a-f0-9-]{36}$/.test(value.operationId) ||
    !/^[a-f0-9-]{36}$/.test(value.backupId) ||
    !/^[a-f0-9]{40}$/.test(value.sourceRevision) ||
    !Number.isSafeInteger(value.startedAt)
  )
    throw new Error("Unknown source preparation marker.");
}

export function assertSourcePreparationComplete(dataRoot: string): void {
  if (!isAbsolute(dataRoot)) throw new Error("Recovery requires an absolute private data root.");
  assertColdSourceFenceAbsent(dataRoot);
  try {
    lstatSync(join(dataRoot, sourcePreparationFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Recovery source preparation is incomplete. Keep the worker paused.");
}

export function assertRestoreStartupAllowed(dataRoot: string): void {
  if (!isAbsolute(dataRoot)) throw new Error("Recovery requires an absolute private data root.");
  try {
    // Even an unreadable or malformed marker must stop restored work before migrations.
    lstatSync(join(dataRoot, restoreQuarantineFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Restored data is quarantined. Operator review is required before startup.");
}

/** CLI configuration may point at nested guild data independently of HEALTH_PATH. */
export function assertDatabaseSourceOpenAllowed(databasePath: string): void {
  if (!isAbsolute(databasePath)) throw new Error("Recovery requires an absolute database path.");
  for (let directory = dirname(resolve(databasePath)); ; directory = dirname(directory)) {
    assertRestoreStartupAllowed(directory);
    assertSourcePreparationComplete(directory);
    if (dirname(directory) === directory) break;
  }
}

export async function acquireDataRootLease(dataRoot: string): Promise<() => Promise<void>> {
  if (!isAbsolute(dataRoot)) throw new Error("Recovery requires an absolute private data root.");
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(dataRoot).isDirectory() || lstatSync(dataRoot).isSymbolicLink())
    throw new Error("Invalid data root.");
  return acquireLock(join(resolve(dataRoot), ".runtime-data"));
}
