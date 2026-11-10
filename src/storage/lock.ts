import lockfile from "proper-lockfile";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export async function acquireLock(
  databasePath: string,
  options: { createTarget?: boolean } = {},
): Promise<() => Promise<void>> {
  mkdirSync(dirname(databasePath), { recursive: true });
  if (options.createTarget !== false) writeFileSync(databasePath, "", { flag: "a" });
  return lockfile.lock(databasePath, {
    realpath: false,
    stale: 120000,
    update: 10000,
    retries: 0,
    onCompromised: () => {
      console.error("Instance lock lost. Stopping.");
      process.exit(1);
    },
  });
}
