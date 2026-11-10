import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, lstatSync, readSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonical } from "../dist/shared/utils.js";
import { backupKey, manifestLimit } from "../dist/storage/recovery/archive.js";
import { assertRecoveryArchiveAge } from "../dist/storage/recovery/age.js";
import { restoreSnapshot } from "../dist/storage/recovery/snapshot.js";
import {
  assertIntegrity,
  currentRecoverySchemaPolicy,
  schemaOf,
  verifySchema,
} from "../dist/storage/recovery/schema.js";
import {
  hashFile,
  inside,
  privateDirectory,
  regularFile,
  withInput,
} from "../dist/storage/recovery/files.js";
import { acquireLock } from "../dist/storage/lock.js";
import {
  assertRestoredRulesQuarantined,
  reconcileRulesDeletionEntries,
} from "../dist/storage/recovery/deletions.js";
import { verifyLatestDeletionProof } from "./backup-proof.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
export class RecoveryDeletionError extends Error {
  constructor(code) {
    super(code);
    this.name = "RecoveryDeletionError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new RecoveryDeletionError(code);
};
function json(path, maximum) {
  return withInput(path, (fd, size) => {
    if (size > maximum) fail("target_quota");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    try {
      while (offset < size) {
        const n = readSync(fd, bytes, offset, size - offset, offset);
        if (!n) fail("target_changed");
        offset += n;
      }
      return JSON.parse(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
    }
  });
}
function missing(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
function marker(root, manifest, expectedId, now) {
  const value = json(join(root, "restore-quarantine.json"), 4096);
  if (
    value?.format !== 1 ||
    value.backupId !== expectedId ||
    value.backupId !== manifest.id ||
    !integer(value.restoredAt) ||
    value.restoredAt < manifest.createdAt ||
    value.restoredAt > now ||
    value.sourceRelease !== manifest.release ||
    value.requiresOperatorReview !== true ||
    value.automaticResume !== false ||
    value.externalEffectsMayAlreadyExist !== true ||
    value.deletionReconciliationRequired !== true
  )
    fail("target_not_quarantined");
  return value;
}
function inventory(root, manifest, lockTargets) {
  const files = new Set([
      ...manifest.files.map((f) => f.path),
      "restore-manifest.json",
      "restore-quarantine.json",
    ]),
    dirs = new Set([""]);
  for (const path of files) {
    let parent = dirname(path).replaceAll("\\", "/");
    while (parent !== ".") {
      dirs.add(parent);
      parent = dirname(parent).replaceAll("\\", "/");
    }
  }
  const locks = new Set(
    lockTargets.map((path) => relative(root, path + ".lock").replaceAll("\\", "/")),
  );
  files.add(".runtime-data");
  let count = 0;
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      if (++count > 20000) fail("target_quota");
      const path = join(directory, name),
        tail = relative(root, path).replaceAll("\\", "/"),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail("unsafe_target");
      if (locks.has(tail)) {
        if (!stat.isDirectory() || readdirSync(path).length) fail("unsafe_target");
        continue;
      }
      if (stat.isDirectory()) {
        if (!dirs.has(tail)) fail("unexpected_target_file");
        walk(path);
      } else {
        if (!files.has(tail)) fail("unexpected_target_file");
        regularFile(path);
      }
    }
  };
  walk(root);
  for (const entry of manifest.files) {
    const path = inside(root, entry.path);
    regularFile(path);
    if (!["guild", "hub", "web"].includes(entry.kind)) {
      const digest = hashFile(path);
      if (digest.size !== entry.size || digest.sha256 !== entry.sha256) fail("target_file_changed");
    }
  }
}
function inspect(db, entry, policy) {
  assertIntegrity(db);
  const actual = schemaOf(db, entry.kind);
  if (canonical(actual) !== canonical(entry.schema)) fail("target_schema_changed");
  if (entry.kind !== "web") verifySchema(actual, policy[entry.kind]);
  if (entry.kind === "guild") {
    assertRestoredRulesQuarantined(db, entry.guildId);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='guild_module_settings'").get())
      for (const row of db.prepare("SELECT body FROM guild_module_settings").all()) {
        const settings = JSON.parse(String(row.body));
        if (settings.enabled && Object.values(settings.enabled).some((value) => value !== false))
          fail("target_not_quarantined");
      }
  }
  if (entry.kind === "web")
    for (const table of ["sessions", "oauth_states"])
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
        db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
      )
        fail("target_not_quarantined");
  if (
    entry.kind === "hub" &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='twitch_bindings'").get()
  )
    for (const row of db.prepare("SELECT definition FROM twitch_bindings").all())
      if (JSON.parse(String(row.definition)).enabled !== false) fail("target_not_quarantined");
}
function validateRequirements(requirements) {
  if (
    !requirements ||
    !isAbsolute(requirements.archivePath) ||
    !uuid.test(requirements.expectedSourceId) ||
    !integer(requirements.minSequence) ||
    requirements.minSequence < 1 ||
    !integer(requirements.notBefore) ||
    !uuid.test(requirements.challenge) ||
    !integer(requirements.maxAgeMs) ||
    requirements.maxAgeMs < 1 ||
    requirements.maxAgeMs > 86400000 ||
    Object.keys(requirements).some(
      (key) =>
        ![
          "archivePath",
          "expectedSourceId",
          "minSequence",
          "notBefore",
          "challenge",
          "maxAgeMs",
        ].includes(key),
    )
  )
    fail("invalid_proof_requirements");
}
const empty = () => ({
  acceptancesRemoved: 0,
  membershipsRemoved: 0,
  jobsScrubbed: 0,
  attemptsScrubbed: 0,
  cacheEntriesScrubbed: 0,
  fencesAdded: 0,
});
/** Operator-only: never starts the target, clears its marker, resumes jobs or calls Discord. */
export async function reconcileRestoredDeletionData(options) {
  const {
    targetRoot,
    latestProofEnvelope,
    key,
    proofRequirements,
    expectedBackupId,
    dryRun = true,
  } = options;
  if (
    !isAbsolute(targetRoot) ||
    !uuid.test(expectedBackupId) ||
    typeof dryRun !== "boolean" ||
    !(latestProofEnvelope instanceof Uint8Array) ||
    latestProofEnvelope.length > 4 * 1024 * 1024
  )
    fail("invalid_input");
  validateRequirements(proofRequirements);
  const root = resolve(targetRoot),
    clock = () => options.now ?? Date.now(),
    proofOptions = { ...proofRequirements };
  if (missing(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    fail("unsafe_target");
  privateDirectory(root);
  regularFile(proofOptions.archivePath);
  const master = backupKey(key, options.forbiddenKeys),
    envelope = Buffer.from(latestProofEnvelope),
    releases = [];
  let scratch, report, authenticatedCreatedAt;
  const verified = () =>
    verifyLatestDeletionProof({
      ...proofOptions,
      envelope,
      key: master,
      now: clock(),
      maxFutureMs: 0,
    });
  try {
    verified();
    scratch = mkdtempSync(join(privateDirectory(dirname(root)), ".rules-restore-proof-"));
    const manifest = await restoreSnapshot({
      archivePath: proofOptions.archivePath,
      targetRoot: join(scratch, "verified"),
      key: master,
      forbiddenKeys: options.forbiddenKeys,
      dryRun: true,
      now: clock(),
    });
    if (manifest.id !== expectedBackupId) fail("backup_mismatch");
    authenticatedCreatedAt = manifest.createdAt;
    const check = () => {
      const now = clock();
      assertRecoveryArchiveAge(manifest.createdAt, { now });
      const proof = verified();
      if (
        manifest.createdAt < proof.proof.coveredFrom ||
        manifest.createdAt > proof.proof.createdAt ||
        proofOptions.notBefore < manifest.createdAt
      )
        fail("proof_coverage_missing");
      for (const guild of manifest.guilds)
        if (
          !proof.proof.guildIds.includes(guild.guildId) &&
          !proof.proof.guilds.some(
            (e) => e.guildId === guild.guildId && manifest.createdAt <= e.purgedAt,
          )
        )
          fail("proof_scope_missing");
      if (
        canonical(json(join(root, "restore-manifest.json"), manifestLimit)) !== canonical(manifest)
      )
        fail("target_manifest_mismatch");
      marker(root, manifest, expectedBackupId, now);
      return { now, ...proof };
    };
    check();
    const entries = manifest.files.filter((e) => ["guild", "hub", "web"].includes(e.kind)),
      lockTargets = [
        join(root, ".runtime-data"),
        ...entries.filter((e) => e.kind !== "web").map((e) => inside(root, e.path)),
      ].sort();
    for (const target of lockTargets) {
      if (!missing(target)) regularFile(target);
      try {
        releases.push(await acquireLock(target, { createTarget: false }));
      } catch {
        fail("writer_active");
      }
    }
    let current = check();
    inventory(root, manifest, lockTargets);
    const policy = currentRecoverySchemaPolicy(),
      plans = [];
    for (const entry of entries) {
      const db = new DatabaseSync(inside(root, entry.path), { readOnly: true });
      try {
        inspect(db, entry, policy);
        if (entry.kind === "guild") {
          const decisions = current.proof.acceptances.filter((e) => e.guildId === entry.guildId);
          const counts = reconcileRulesDeletionEntries(db, {
            guildId: entry.guildId,
            entries: decisions,
            now: current.now,
            dryRun: true,
          });
          plans.push({ entry, decisions, counts });
        }
      } finally {
        db.close();
      }
    }
    const blockers = current.proof.guilds
      .filter(
        (e) =>
          manifest.guilds.some((g) => g.guildId === e.guildId) && manifest.createdAt <= e.purgedAt,
      )
      .map((e) => ({ code: "guild_deletion_requires_reconciliation", guildId: e.guildId }));
    const totals = empty(),
      guilds = [];
    if (!blockers.length)
      for (const plan of plans) {
        current = check();
        let counts = plan.counts;
        if (!dryRun) {
          const db = new DatabaseSync(inside(root, plan.entry.path));
          try {
            inspect(db, plan.entry, policy);
            current = check();
            counts = reconcileRulesDeletionEntries(db, {
              guildId: plan.entry.guildId,
              entries: plan.decisions,
              now: current.now,
              dryRun: false,
              beforeCommit: () => {
                check();
              },
            });
            assertIntegrity(db);
          } finally {
            db.close();
          }
        }
        for (const key of Object.keys(totals)) totals[key] += counts[key];
        guilds.push({ guildId: plan.entry.guildId, ...counts });
      }
    current = check();
    report = {
      format: 1,
      state: blockers.length ? "blocked" : dryRun ? "planned" : "reconciled",
      dryRun,
      backupId: manifest.id,
      proof: {
        id: current.meta.id,
        sha256: current.meta.sha256,
        sourceId: current.meta.sourceId,
        sequence: current.meta.sequence,
        createdAt: current.meta.createdAt,
        expiresAt: current.meta.expiresAt,
      },
      quarantinePreserved: true,
      activationAllowed: false,
      operatorReviewRequired: true,
      sourceLossRecoveryConfirmed: false,
      scope: manifest.guilds.map((g) => g.guildId),
      guilds,
      totals,
      blockers,
    };
    return report;
  } finally {
    try {
      for (const release of releases.reverse()) await release();
    } finally {
      try {
        if (scratch) {
          const tail = relative(dirname(root), scratch);
          if (
            !tail.startsWith(".rules-restore-proof-") ||
            tail.includes("/") ||
            tail.includes("\\") ||
            lstatSync(scratch).isSymbolicLink()
          )
            fail("unsafe_scratch");
          rmSync(scratch, { recursive: true, force: true });
        }
        if (report) {
          verified();
          assertRecoveryArchiveAge(authenticatedCreatedAt, { now: clock() });
        }
      } finally {
        master.fill(0);
        envelope.fill(0);
      }
    }
  }
}
