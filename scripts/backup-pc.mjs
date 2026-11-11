import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BackupCatalog } from "./backup-catalog.mjs";
import {
  collectArchive,
  collectForOffsiteAck,
  pruneCollectedDeletionProofs,
  verifyTransferProof,
} from "./backup-collector.mjs";
import {
  offsiteProofRequirements,
  readOffsiteFile,
  verifyOffsiteAck,
  writeOffsiteFile,
} from "./backup-offsite.mjs";
import {
  backupProtocol,
  cleanBackupEnvironment,
  transportLimits,
  validateBackupOffer,
} from "./backup-relay.mjs";

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validatePcBackupConfig(value) {
  const keys = [
    "host",
    "user",
    "port",
    "identityPath",
    "knownHostsPath",
    "catalogRoot",
    "locationId",
    "sourceId",
  ];
  if (
    !value ||
    Object.keys(value)
      .filter((key) => key !== "receiptPath")
      .sort()
      .join() !== keys.sort().join() ||
    typeof value.host !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(value.host) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(value.user) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    ["identityPath", "knownHostsPath", "catalogRoot"].some(
      (key) =>
        typeof value[key] !== "string" || !isAbsolute(value[key]) || /[\r\n]/.test(value[key]),
    ) ||
    !uuid.test(value.locationId) ||
    !uuid.test(value.sourceId)
  )
    fail("pc_backup_configuration");
  upgradeReceiptPath(value.catalogRoot, value.receiptPath);
  return { ...value };
}
function upgradeReceiptPath(catalogRoot, configured) {
  const root = resolve(catalogRoot),
    path = configured ?? join(dirname(root), "." + basename(root) + "-offsite-ack.json");
  if (typeof path !== "string" || !isAbsolute(path) || /[\r\n]/.test(path))
    fail("pc_backup_configuration");
  const target = resolve(path),
    tail = relative(root, target);
  if (!tail || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep)))
    fail("pc_backup_configuration");
  return target;
}
function savedUpgradeReceipt(path, transfer, key, now) {
  let envelope;
  try {
    envelope = readOffsiteFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(envelope.toString("utf8"));
  // Authenticate an older subject at its signed verification time before replacing its state.
  const previous = verifyOffsiteAck({
    envelope,
    transfer: value?.body?.transfer,
    key,
    now: value?.body?.verifiedAt,
  });
  if (JSON.stringify(previous.transfer) !== JSON.stringify(transfer)) return null;
  verifyOffsiteAck({ envelope, transfer, key, now });
  return envelope;
}
export function backupSshArguments(config) {
  validatePcBackupConfig(config);
  return [
    "-F",
    process.platform === "win32" ? "NUL" : "/dev/null",
    "-T",
    "-p",
    String(config.port),
    "-i",
    config.identityPath,
    ...[
      "BatchMode=yes",
      "IdentitiesOnly=yes",
      "StrictHostKeyChecking=yes",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "ControlMaster=no",
      "ControlPath=none",
      "ControlPersist=no",
      "PermitLocalCommand=no",
      "ConnectTimeout=15",
      "ServerAliveInterval=15",
      "ServerAliveCountMax=1",
      "UserKnownHostsFile=" + config.knownHostsPath,
    ].flatMap((value) => ["-o", value]),
    config.user + "@" + config.host,
    backupProtocol,
  ];
}
/** Each request is a fresh authenticated connection: no reuse of the web forwarding key. */
export function createSshBackupTransport(config, spawnPort = spawn) {
  const args = backupSshArguments(config);
  async function* stream(request, maximum) {
    const executable =
      process.platform === "win32"
        ? join(process.env.SYSTEMROOT || "C:/Windows", "System32/OpenSSH/ssh.exe")
        : "ssh";
    const child = spawnPort(executable, args, {
      env: cleanBackupEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill(), transportLimits.milliseconds);
    let size = 0,
      spawnError = false;
    const exited = new Promise((resolve) => {
      child.once("error", () => {
        spawnError = true;
        resolve(-1);
      });
      child.once("close", (code) => resolve(code));
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.stdin.end(JSON.stringify(request));
    try {
      for await (const chunk of child.stdout) {
        size += chunk.length;
        if (size > maximum) fail("pc_backup_stream_budget");
        yield chunk;
      }
      if ((await exited) !== 0 || spawnError) fail("pc_backup_connection_failed");
    } finally {
      globalThis.clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
  }
  return {
    stream(request) {
      return stream(
        request,
        request.operation === "archive" ? transportLimits.archive : transportLimits.proof,
      );
    },
    async json(request) {
      const chunks = [];
      for await (const chunk of stream(request, 16384)) chunks.push(chunk);
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        fail("pc_backup_response");
      }
    },
  };
}
export async function collectPcBackupOffer({
  catalog,
  key,
  offer: input,
  transport,
  sourceId,
  receiptPath,
}) {
  const offer = validateBackupOffer(input, catalog.clock()),
    transfer = offer.transfer;
  if (
    !uuid.test(sourceId) ||
    transfer.proof.sourceId !== sourceId ||
    (await catalog.read()).locationId !== transfer.destinationLocationId
  )
    fail("pc_backup_location_or_source");
  const chunks = [];
  let size = 0;
  for await (const chunk of transport.stream({ operation: "proof", id: offer.id })) {
    size += chunk.length;
    if (size > transportLimits.proof) fail("pc_backup_stream_budget");
    chunks.push(chunk);
  }
  const proof = Buffer.concat(chunks);
  // Both purposes have the same pinned archive/proof requirements; only upgrades have an ACK.
  if (offer.purpose === "upgrade") {
    const path = upgradeReceiptPath(catalog.root, receiptPath),
      saved = savedUpgradeReceipt(path, transfer, key, catalog.clock());
    if (saved) await catalog.confirmArchive(transfer.backup);
    const collected = await collectForOffsiteAck({
      catalog,
      key,
      transfer,
      envelope: proof,
      fetchStream: () => transport.stream({ operation: "archive", id: offer.id }),
    });
    // Collection rechecks physical bytes, GCM/schema and the exact fresh proof on every retry.
    const ack = saved ?? collected.ack;
    verifyOffsiteAck({ envelope: ack, transfer, key, now: catalog.clock() });
    if (!saved) writeOffsiteFile(path, ack);
    const receipt = await transport.json({
      operation: "ack",
      id: offer.id,
      envelope: ack.toString("base64url"),
    });
    if (
      !["offsite_verified", "already_verified"].includes(receipt?.state) ||
      receipt.id !== transfer.backup.id ||
      receipt.offsiteSuccess !== true
    )
      fail("pc_backup_ack_not_imported");
    return {
      state: "checkpoint_offsite_verified",
      backupId: transfer.backup.id,
      physicalPcCopyVerified: true,
      localVerificationSucceeded: true,
      hostOffsiteSuccess: true,
    };
  }
  verifyTransferProof({ transfer, envelope: proof, key, now: catalog.clock() });
  const collected = await collectArchive({
    catalog,
    key,
    expected: transfer.backup,
    fetchStream: () => transport.stream({ operation: "archive", id: offer.id }),
    latestProof: proof,
    proofRequirements: offsiteProofRequirements(transfer),
  });
  if (collected.ledger.state !== "verified") fail("pc_backup_proof_not_verified");
  return {
    state: "daily_physical_pc_verified",
    backupId: collected.entry.id,
    physicalPcCopyVerified: true,
    localVerificationSucceeded: true,
    hostOffsiteSuccess: false,
  };
}
export async function runPcBackup({ config: input, key, transport }) {
  const config = validatePcBackupConfig(input);
  const path = resolve(config.catalogRoot, "catalog.json"),
    stat = lstatSync(path);
  if (
    stat.size > 4 * 1024 * 1024 ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    realpathSync(config.catalogRoot) !== resolve(config.catalogRoot)
  )
    fail("pc_backup_location_or_source");
  const stored = JSON.parse(readFileSync(path, "utf8"));
  if (stored.locationId !== config.locationId) fail("pc_backup_location_or_source");
  const catalog = new BackupCatalog({ root: config.catalogRoot });
  const rotation = await catalog.applyRotation(await catalog.planRotation());
  const pruned = await pruneCollectedDeletionProofs({ catalog, key });
  if (rotation.state !== "complete" || pruned.blocked) fail("pc_backup_retention_blocked");
  const wire = transport ?? createSshBackupTransport(config),
    offer = await wire.json({ operation: "offer" });
  if (offer?.state === "no_offer")
    return {
      state: "waiting_for_capture",
      physicalPcCopyVerified: false,
      hostOffsiteSuccess: false,
    };
  return collectPcBackupOffer({
    catalog,
    key,
    offer,
    transport: wire,
    sourceId: config.sourceId,
    receiptPath: config.receiptPath,
  });
}
async function main() {
  if (
    process.platform !== "win32" ||
    process.versions.node.split(".")[0] !== "24" ||
    process.argv.length !== 3 ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.execArgv.some((arg) => !arg.startsWith("--env-file=")) ||
    Object.entries(process.env).some(
      ([name, value]) => value && /(?:TOKEN|SECRET|PASSWORD)$/i.test(name),
    )
  )
    fail("pc_backup_configuration");
  const path = resolve(process.argv[2]),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192)
    fail("pc_backup_configuration");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const result = await runPcBackup({ config, key: process.env.BACKUP_ENCRYPTION_KEY ?? "" });
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("PC backup requires operator review.\n");
    process.exitCode = 1;
  });
