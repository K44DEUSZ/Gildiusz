import { createHash } from "node:crypto";
import {
  createReadStream,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { regularFile } from "../dist/storage/recovery/files.js";
import { pendingUpgrade, offsiteLocation } from "./hosting.mjs";
import { withHostingBackupLock } from "./backup-scheduler.mjs";
import {
  validateDailyOffsiteOffer,
  validateOffsiteTransfer,
  verifyOffsiteAck,
  writeOffsiteFile,
} from "./backup-offsite.mjs";

export const backupProtocol = "gildiusz-backup-v1";
export const transportLimits = {
  request: 16384,
  proof: 4 * 1024 * 1024,
  archive: 545259576,
  milliseconds: 300000,
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
const identity = (state) => [
  state.dev,
  state.ino,
  state.size,
  state.nlink,
  state.uid,
  state.mtimeMs,
  state.ctimeMs,
];

export function cleanBackupEnvironment(values = process.env) {
  return Object.fromEntries(
    ["PATH", "HOME", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"]
      .filter((name) => values[name])
      .map((name) => [name, values[name]]),
  );
}
function openPrivate(path, maximum) {
  if (
    !isAbsolute(path) ||
    regularFile(path) > maximum ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    fail("backup_transport_path");
  const before = lstatSync(path);
  if (
    before.nlink !== 1 ||
    (process.getuid && before.uid !== process.getuid()) ||
    (process.platform !== "win32" && before.mode & 0o077)
  )
    fail("backup_transport_path");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if (JSON.stringify(identity(fstatSync(fd))) !== JSON.stringify(identity(before))) {
    closeSync(fd);
    fail("backup_transport_changed");
  }
  return {
    fd,
    before,
    check() {
      if (
        JSON.stringify(identity(fstatSync(fd))) !== JSON.stringify(identity(before)) ||
        JSON.stringify(identity(lstatSync(path))) !== JSON.stringify(identity(before))
      )
        fail("backup_transport_changed");
    },
  };
}
function bytes(path, maximum) {
  const input = openPrivate(path, maximum);
  try {
    const value = readFileSync(input.fd);
    input.check();
    return value;
  } finally {
    closeSync(input.fd);
  }
}
const json = (path, maximum = 8192) => JSON.parse(bytes(path, maximum).toString("utf8"));

export function validateBackupOffer(value, now = Date.now()) {
  if (
    !exact(value, ["format", "kind", "purpose", "id", "transfer"]) ||
    value.format !== 1 ||
    value.kind !== "gildiusz-backup-offer" ||
    !["upgrade", "daily"].includes(value.purpose)
  )
    fail("backup_transport_offer");
  const transfer =
    value.purpose === "upgrade"
      ? validateOffsiteTransfer(value.transfer, now)
      : validateDailyOffsiteOffer(value.transfer, now);
  const id = sha(JSON.stringify({ purpose: value.purpose, transfer }));
  if (value.id !== id) fail("backup_transport_offer");
  return { format: 1, kind: value.kind, purpose: value.purpose, id, transfer };
}
export function selectBackupOffer(root, now = Date.now()) {
  const pending = pendingUpgrade(root),
    shared = join(root, "shared");
  let purpose, transfer;
  if (pending) {
    if (pending.state !== "awaiting_offsite" || !pending.backupId || !pending.sha256)
      fail("backup_transport_pending_blocked");
    purpose = "upgrade";
    transfer = validateOffsiteTransfer(json(join(shared, "offsite-transfer.json")), now);
    if (
      transfer.backup.id !== pending.backupId ||
      transfer.backup.sha256 !== pending.sha256 ||
      transfer.upgradeId !== pending.upgradeId ||
      transfer.targetRevision !== pending.revision ||
      transfer.destinationLocationId !== pending.locationId
    )
      fail("backup_transport_pending_changed");
  } else {
    purpose = "daily";
    try {
      transfer = validateDailyOffsiteOffer(json(join(shared, "offsite-daily-offer.json")), now);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  const catalog = json(join(shared, "backups/catalog.json"), 4 * 1024 * 1024);
  const entries = catalog.entries?.filter((entry) => entry.id === transfer.backup.id);
  if (
    entries?.length !== 1 ||
    entries[0].state !== "verified" ||
    catalog.locationId !== transfer.sourceLocationId ||
    offsiteLocation(root) !== transfer.destinationLocationId ||
    ["id", "createdAt", "size", "sha256"].some((key) => entries[0][key] !== transfer.backup[key])
  )
    fail("backup_transport_catalog_changed");
  if (
    purpose === "upgrade" &&
    JSON.stringify(entries[0].checkpoint?.offsite) !== JSON.stringify(transfer)
  )
    fail("backup_transport_pending_changed");
  return validateBackupOffer(
    {
      format: 1,
      kind: "gildiusz-backup-offer",
      purpose,
      id: sha(JSON.stringify({ purpose, transfer })),
      transfer,
    },
    now,
  );
}
export function validateBackupRequest(value) {
  if (
    !value ||
    !["offer", "archive", "proof", "ack"].includes(value.operation) ||
    !exact(
      value,
      value.operation === "offer"
        ? ["operation"]
        : value.operation === "ack"
          ? ["operation", "id", "envelope"]
          : ["operation", "id"],
    ) ||
    (value.operation !== "offer" && !/^[a-f0-9]{64}$/.test(value.id))
  )
    fail("backup_transport_request");
  if (
    value.operation === "ack" &&
    (typeof value.envelope !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(value.envelope) ||
      Buffer.byteLength(value.envelope, "base64url") > 8192 ||
      Buffer.from(value.envelope, "base64url").toString("base64url") !== value.envelope)
  )
    fail("backup_transport_request");
  return value;
}
export async function* streamBackupArtifact(root, request, now = Date.now) {
  validateBackupRequest(request);
  if (!["archive", "proof"].includes(request.operation)) fail("backup_transport_request");
  const offer = selectBackupOffer(root, now());
  if (!offer || offer.id !== request.id) fail("backup_transport_stale_offer");
  const archive = request.operation === "archive",
    expected = archive ? offer.transfer.backup : offer.transfer.proof;
  const path = archive
    ? join(root, "shared/backups/archives", expected.id + ".gldbak")
    : join(root, "shared/backups/deletion-ledger", "deletion-proof-" + expected.id + ".gldproof");
  const input = openPrivate(path, archive ? transportLimits.archive : transportLimits.proof),
    hash = createHash("sha256");
  const started = now();
  let size = 0;
  try {
    if (archive && input.before.size !== expected.size) fail("backup_transport_changed");
    for await (const chunk of createReadStream(path, {
      fd: input.fd,
      autoClose: false,
      highWaterMark: 65536,
    })) {
      if (
        now() - started >= transportLimits.milliseconds ||
        now() >= offer.transfer.proof.expiresAt ||
        now() >= offer.transfer.backup.createdAt + 35 * 86400000
      )
        fail("backup_transport_expired");
      size += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
    input.check();
    if (
      size !== input.before.size ||
      hash.digest("hex") !== expected.sha256 ||
      selectBackupOffer(root, now())?.id !== offer.id
    )
      fail("backup_transport_changed");
  } finally {
    closeSync(input.fd);
  }
}
function privateChild(root, script, args, input, envFiles = []) {
  const child = spawnSync(process.execPath, [...envFiles, script, ...args], {
    cwd: root,
    env: cleanBackupEnvironment(),
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: transportLimits.milliseconds,
    maxBuffer: 65536,
    windowsHide: true,
  });
  if (child.status !== 0) fail("backup_transport_import_failed");
  try {
    return JSON.parse(child.stdout.trim());
  } catch {
    fail("backup_transport_import_failed");
  }
}
export async function acceptUpgradeAck(root, request, { verify, importAck, withLock } = {}) {
  validateBackupRequest(request);
  if (request.operation !== "ack") fail("backup_transport_request");
  const locked = withLock ?? ((task) => withHostingBackupLock(root, task));
  return locked(async (assertFence) => {
    assertFence();
    const offer = selectBackupOffer(root);
    if (!offer || offer.purpose !== "upgrade" || offer.id !== request.id)
      fail("backup_transport_stale_offer");
    const envelope = Buffer.from(request.envelope, "base64url");
    // Only the short recovery child opens the key; the network relay inspects its metadata.
    const keyPath = join(root, "shared/backup-key.env");
    if (!verify) {
      const size = regularFile(keyPath),
        state = lstatSync(keyPath);
      if (
        size > 4096 ||
        (process.getuid && state.uid !== process.getuid()) ||
        (process.platform !== "win32" && state.mode & 0o077)
      )
        fail("backup_transport_path");
    }
    const checked = verify
      ? await verify({ transfer: offer.transfer, envelope })
      : privateChild(
          root,
          fileURLToPath(import.meta.url),
          ["verify-ack", root],
          { transfer: offer.transfer, envelope: request.envelope },
          ["--env-file=" + keyPath],
        );
    if (checked?.verified !== true) fail("backup_transport_ack_rejected");
    assertFence();
    if (selectBackupOffer(root)?.id !== offer.id) fail("backup_transport_stale_offer");
    const catalog = json(join(root, "shared/backups/catalog.json"), 4 * 1024 * 1024);
    const entry = catalog.entries.find((entry) => entry.id === offer.transfer.backup.id);
    if (entry.checkpoint?.offsiteAck?.signedReceipt === request.envelope)
      return { state: "already_verified", id: entry.id, offsiteSuccess: true };
    const path = join(root, "shared/offsite-received-ack.json");
    writeOffsiteFile(path, envelope);
    const result = importAck
      ? await importAck(path)
      : privateChild(
          root,
          join(root, "current/scripts/hosting.mjs"),
          ["import-offsite-ack-locked", root, path],
          null,
        );
    assertFence();
    if (
      result?.state !== "offsite_verified" ||
      result.id !== offer.transfer.backup.id ||
      result.offsiteSuccess !== true
    )
      fail("backup_transport_import_failed");
    return { state: result.state, id: result.id, offsiteSuccess: true };
  });
}
async function inputJson(maximum) {
  let length = 0;
  const chunks = [];
  const timer = setTimeout(() => process.exit(1), 10000);
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > maximum) fail("backup_transport_request");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    globalThis.clearTimeout(timer);
  }
}
async function main() {
  const [mode, argument] = process.argv.slice(2),
    root = resolve(argument ?? "");
  if (process.argv.length !== 4 || !isAbsolute(argument) || realpathSync(root) !== root)
    fail("backup_transport_configuration");
  if (
    process.versions.node.split(".")[0] !== "24" ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH
  )
    fail("backup_transport_configuration");
  const timer = setTimeout(() => process.exit(1), transportLimits.milliseconds);
  try {
    if (mode === "verify-ack") {
      if (
        process.execArgv.length !== 1 ||
        process.execArgv[0] !== "--env-file=" + join(root, "shared/backup-key.env") ||
        Object.entries(process.env).some(
          ([name, value]) => value && /(?:TOKEN|SECRET|PASSWORD)$/i.test(name),
        )
      )
        fail("backup_transport_configuration");
      const value = await inputJson(transportLimits.request);
      verifyOffsiteAck({
        transfer: value.transfer,
        envelope: Buffer.from(value.envelope, "base64url"),
        key: process.env.BACKUP_ENCRYPTION_KEY ?? "",
      });
      process.stdout.write(JSON.stringify({ verified: true }));
      return;
    }
    if (
      mode !== "serve" ||
      process.platform !== "linux" ||
      process.versions.node.split(".")[0] !== "24" ||
      process.env.SSH_ORIGINAL_COMMAND !== backupProtocol ||
      process.execArgv.length ||
      process.env.NODE_OPTIONS ||
      process.env.NODE_PATH ||
      Object.entries(process.env).some(
        ([name, value]) => value && /(?:TOKEN|SECRET|PASSWORD|BACKUP_ENCRYPTION_KEY)$/i.test(name),
      )
    )
      fail("backup_transport_configuration");
    const request = validateBackupRequest(await inputJson(transportLimits.request));
    if (request.operation === "offer")
      process.stdout.write(JSON.stringify(selectBackupOffer(root) ?? { state: "no_offer" }));
    else if (request.operation === "ack")
      process.stdout.write(JSON.stringify(await acceptUpgradeAck(root, request)));
    else {
      const offer = selectBackupOffer(root);
      if (!offer || offer.id !== request.id) fail("backup_transport_stale_offer");
      const expiryTimer = setTimeout(
        () => process.exit(1),
        Math.max(
          1,
          Math.min(
            transportLimits.milliseconds,
            offer.transfer.proof.expiresAt - Date.now(),
            offer.transfer.backup.createdAt + 35 * 86400000 - Date.now(),
          ),
        ),
      );
      try {
        for await (const chunk of streamBackupArtifact(root, request)) {
          if (!process.stdout.write(chunk))
            await new Promise((resolve) => process.stdout.once("drain", resolve));
        }
      } finally {
        globalThis.clearTimeout(expiryTimer);
      }
    }
  } finally {
    globalThis.clearTimeout(timer);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("Backup transport refused.\n");
    process.exitCode = 1;
  });
