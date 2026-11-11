// Frozen startup guards from 2a99079; retained so shallow CI checkouts test old readers too.
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function assertSourcePreparationComplete(dataRoot) {
  if (!isAbsolute(dataRoot)) throw new Error("Recovery requires an absolute private data root.");
  try {
    lstatSync(join(dataRoot, "source-preparation.json"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Recovery source preparation is incomplete. Keep the worker paused.");
}

export function assertRestoreStartupAllowed(dataRoot) {
  if (!isAbsolute(dataRoot)) throw new Error("Recovery requires an absolute private data root.");
  try {
    lstatSync(join(dataRoot, "restore-quarantine.json"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Restored data is quarantined. Operator review is required before startup.");
}
