import { lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { acquireLock } from "../lock.js";

export const restoreQuarantineFile = "restore-quarantine.json";

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

export async function acquireDataRootLease(dataRoot: string): Promise<() => Promise<void>> {
  if (!isAbsolute(dataRoot)) throw new Error("Recovery requires an absolute private data root.");
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(dataRoot).isDirectory() || lstatSync(dataRoot).isSymbolicLink())
    throw new Error("Invalid data root.");
  return acquireLock(join(resolve(dataRoot), ".runtime-data"));
}
