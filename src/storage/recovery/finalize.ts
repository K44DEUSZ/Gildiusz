import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireLock } from "../lock.js";
import { acquireDataRootLease } from "./lease.js";
import { hashFile, privateDirectory, regularFile, syncDirectory } from "./files.js";
import { physicalIdentity, type PhysicalIdentity } from "./source-lease.js";
import type { SnapshotManifest } from "./snapshot.js";
import {
  parseRulesDeletionLifecycleJournal,
  type RulesDeletionLifecycleJournal,
} from "../rules-deletion-lifecycle.js";
import type { RulesDeletionEntry } from "../../modules/server-rules/deletion-outbox.js";

export const coldRestoreReceiptFile = "restore-cold-receipt.json";
export const finalizationDirectory = "recovery-finalization";
export const digest = (body: string) => createHash("sha256").update(body).digest("hex");
export interface RecoveryTargetFile {
  path: string;
  size: number;
  sha256: string;
  identity: PhysicalIdentity;
}
export function readPrivateRecoveryJson(path: string, maximum = 8 * 1024 * 1024): unknown {
  if (regularFile(path) > maximum) throw new Error("recovery_input_too_large");
  const stat = lstatSync(path);
  if (
    (process.getuid && stat.uid !== process.getuid()) ||
    (process.platform !== "win32" && stat.mode & 0o077)
  )
    throw new Error("recovery_input_not_private");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function signedRecoveryDocument(body: unknown, key: Uint8Array): string {
  const data = JSON.stringify(body),
    mac = createHmac("sha256", key)
      .update("gildiusz-recovery-finalization-v1\0")
      .update(data)
      .digest("hex");
  return JSON.stringify({ format: 1, body, mac }) + "\n";
}
export function readSignedRecoveryDocument(path: string, key: Uint8Array): unknown {
  const value = readPrivateRecoveryJson(path) as { format: number; body: unknown; mac: string };
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "body,format,mac" ||
    value.format !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.mac)
  )
    throw new Error("invalid_recovery_receipt");
  const expected = JSON.parse(signedRecoveryDocument(value.body, key)).mac;
  if (!timingSafeEqual(Buffer.from(value.mac, "hex"), Buffer.from(expected, "hex")))
    throw new Error("recovery_receipt_authentication_failed");
  return value.body;
}
export function durableRecoveryWrite(path: string, body: string): void {
  privateDirectory(dirname(path));
  const temporary = path + ".recovery-tmp";
  try {
    try {
      regularFile(temporary);
      rmSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    try {
      rmSync(temporary);
    } catch {
      /* The guarded operation may safely retain its own incomplete temporary. */
    }
    throw error;
  }
}
export function recoveryTargetInventory(
  root: string,
  manifest: SnapshotManifest,
  permitOperation = false,
): RecoveryTargetFile[] {
  const locks = new Set([
      ".runtime-data.lock",
      ...manifest.files
        .filter((file) => ["guild", "hub", "web"].includes(file.kind))
        .map((file) => file.path + ".lock"),
    ]),
    files: RecoveryTargetFile[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        tail = relative(root, path).replaceAll("\\", "/"),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("recovery_target_link");
      if (locks.has(tail)) {
        if (!stat.isDirectory() || readdirSync(path).length)
          throw new Error("invalid_recovery_lock_directory");
        continue;
      }
      if (tail === finalizationDirectory && permitOperation) {
        if (!stat.isDirectory()) throw new Error("invalid_recovery_operation_directory");
        continue;
      }
      if (stat.isDirectory()) visit(path);
      else {
        if (tail === coldRestoreReceiptFile) continue;
        if (files.length >= 11000) throw new Error("recovery_target_inventory_quota");
        regularFile(path);
        if (process.platform !== "win32" && stat.mode & 0o077)
          throw new Error("recovery_target_not_private");
        files.push({ path: tail, ...hashFile(path), identity: physicalIdentity(path) });
      }
    }
  };
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Actual root and all canonical SQLite leases remain held through the entire callback. */
export async function withRecoveryTargetLease<T>(
  root: string,
  manifest: SnapshotManifest,
  work: () => Promise<T>,
): Promise<T> {
  privateDirectory(root);
  const releases: (() => Promise<void>)[] = [];
  try {
    try {
      writeFileSync(join(root, ".runtime-data"), "", { flag: "wx", mode: 0o600, flush: true });
      syncDirectory(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    regularFile(join(root, ".runtime-data"));
    releases.push(await acquireDataRootLease(root));
    for (const file of manifest.files
      .filter((file) => ["guild", "hub", "web"].includes(file.kind))
      .sort((a, b) => a.path.localeCompare(b.path)))
      releases.push(
        await acquireLock(join(root, ...file.path.split("/")), { createTarget: false }),
      );
    return await work();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

export function recoveredLifecycleJournal(
  captured: RulesDeletionLifecycleJournal,
  active: {
    guildId: string;
    path: string;
    epoch: string;
    through: number;
    fileIdentity: PhysicalIdentity;
  }[],
  addedEntries: readonly RulesDeletionEntry[],
  now: number,
): RulesDeletionLifecycleJournal {
  const value = structuredClone(captured);
  value.active = active.map((row) => ({ ...row, admittedAt: now }));
  value.entries.push(...addedEntries);
  value.sequence++;
  value.updatedAt = now;
  return parseRulesDeletionLifecycleJournal(value);
}

export function closeRecoveryDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  db.close();
}
