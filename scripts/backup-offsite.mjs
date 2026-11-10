import { createHmac, hkdfSync, timingSafeEqual, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { backupKey } from "../dist/storage/recovery/archive.js";
import {
  privateDirectory,
  regularFile,
  syncDirectory,
  withInput,
} from "../dist/storage/recovery/files.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === [...keys].sort().join();
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
export function validateOffsiteTransfer(value, now = Date.now()) {
  if (
    !integer(now) ||
    !exact(value, [
      "format",
      "kind",
      "backup",
      "upgradeId",
      "targetRevision",
      "sourceLocationId",
      "destinationLocationId",
      "proof",
    ]) ||
    value.format !== 1 ||
    value.kind !== "gildiusz-offsite-transfer" ||
    !uuid.test(value.upgradeId) ||
    !/^[a-f0-9]{40}$/.test(value.targetRevision) ||
    !uuid.test(value.sourceLocationId) ||
    !uuid.test(value.destinationLocationId) ||
    value.sourceLocationId === value.destinationLocationId
  )
    fail("invalid_offsite_transfer");
  const b = value.backup,
    p = value.proof;
  if (
    !exact(b, ["id", "createdAt", "size", "sha256"]) ||
    !uuid.test(b.id) ||
    !sha.test(b.sha256) ||
    !integer(b.createdAt) ||
    b.createdAt > now ||
    !integer(b.size) ||
    b.size < 1 ||
    b.size > 545259576 ||
    !integer(b.createdAt + 35 * 86400000) ||
    now >= b.createdAt + 35 * 86400000 ||
    !exact(p, [
      "id",
      "sha256",
      "sourceId",
      "sequence",
      "createdAt",
      "expiresAt",
      "coveredFrom",
      "challenge",
      "notBefore",
    ]) ||
    !uuid.test(p.id) ||
    !sha.test(p.sha256) ||
    !uuid.test(p.sourceId) ||
    !uuid.test(p.challenge) ||
    !integer(p.sequence) ||
    p.sequence < 1 ||
    !integer(p.createdAt) ||
    p.createdAt > now ||
    !integer(p.expiresAt) ||
    p.expiresAt <= p.createdAt ||
    p.expiresAt > p.createdAt + 86400000 ||
    !integer(p.coveredFrom) ||
    p.coveredFrom > b.createdAt ||
    b.createdAt > p.createdAt ||
    !integer(p.notBefore) ||
    p.notBefore > p.createdAt
  )
    fail("invalid_offsite_transfer");
  if (now >= p.expiresAt) fail("offsite_proof_expired");
  return {
    format: 1,
    kind: value.kind,
    backup: { id: b.id, createdAt: b.createdAt, size: b.size, sha256: b.sha256 },
    upgradeId: value.upgradeId,
    targetRevision: value.targetRevision,
    sourceLocationId: value.sourceLocationId,
    destinationLocationId: value.destinationLocationId,
    proof: Object.fromEntries(
      [
        "id",
        "sha256",
        "sourceId",
        "sequence",
        "createdAt",
        "expiresAt",
        "coveredFrom",
        "challenge",
        "notBefore",
      ].map((k) => [k, p[k]]),
    ),
  };
}
export function offsiteProofRequirements(transfer) {
  const p = transfer.proof;
  return {
    expectedSourceId: p.sourceId,
    minSequence: p.sequence,
    notBefore: p.notBefore,
    challenge: p.challenge,
    maxAgeMs: 86400000,
    maxFutureMs: 0,
  };
}
function mac(body, key, forbiddenKeys) {
  const master = backupKey(key, forbiddenKeys);
  let derived;
  try {
    derived = Buffer.from(
      hkdfSync("sha256", master, Buffer.alloc(0), "gildiusz-offsite-ack-v1", 32),
    );
    return createHmac("sha256", derived).update(JSON.stringify(body)).digest("hex");
  } finally {
    master.fill(0);
    derived?.fill(0);
  }
}
export function sealOffsiteAck({
  transfer,
  verifiedAt,
  key,
  forbiddenKeys = [],
  now = Date.now(),
}) {
  transfer = validateOffsiteTransfer(transfer, now);
  if (!integer(verifiedAt) || verifiedAt < transfer.proof.createdAt || verifiedAt > now)
    fail("invalid_offsite_ack");
  const body = { format: 1, kind: "gildiusz-offsite-ack", transfer, verifiedAt };
  return Buffer.from(JSON.stringify({ format: 1, body, hmac: mac(body, key, forbiddenKeys) }));
}
export function verifyOffsiteAck({
  envelope,
  transfer,
  key,
  forbiddenKeys = [],
  now = Date.now(),
}) {
  if (!(envelope instanceof Uint8Array) || envelope.length > 8192) fail("invalid_offsite_ack");
  let value;
  try {
    value = JSON.parse(Buffer.from(envelope).toString("utf8"));
  } catch {
    fail("invalid_offsite_ack");
  }
  if (
    !exact(value, ["format", "body", "hmac"]) ||
    value.format !== 1 ||
    !sha.test(value.hmac) ||
    !exact(value.body, ["format", "kind", "transfer", "verifiedAt"]) ||
    value.body.format !== 1 ||
    value.body.kind !== "gildiusz-offsite-ack"
  )
    fail("invalid_offsite_ack");
  const expected = mac(value.body, key, forbiddenKeys);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(value.hmac, "hex")))
    fail("offsite_ack_authentication_failed");
  const actualTransfer = validateOffsiteTransfer(value.body.transfer, now);
  if (
    JSON.stringify(actualTransfer) !== JSON.stringify(validateOffsiteTransfer(transfer, now)) ||
    !integer(value.body.verifiedAt) ||
    value.body.verifiedAt < transfer.proof.createdAt ||
    value.body.verifiedAt > now
  )
    fail("offsite_ack_mismatch");
  return { transfer: actualTransfer, verifiedAt: value.body.verifiedAt };
}
export function readOffsiteFile(path, maximum = 8192) {
  if (!isAbsolute(path)) fail("absolute_offsite_path_required");
  privateDirectory(dirname(path));
  const state = lstatSync(path);
  if (
    (process.getuid && state.uid !== process.getuid()) ||
    (process.platform !== "win32" && (state.mode & 0o077) !== 0)
  )
    fail("offsite_file_not_private");
  return withInput(path, (fd, size) => {
    if (size > maximum) fail("offsite_file_budget");
    const bytes = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const n = readSync(fd, bytes, at, size - at, at);
      if (!n) fail("offsite_file_changed");
      at += n;
    }
    return bytes;
  });
}
export function writeOffsiteFile(path, bytes) {
  if (!isAbsolute(path) || !(bytes instanceof Uint8Array) || bytes.length > 8192)
    fail("invalid_offsite_file");
  const directory = privateDirectory(dirname(path)),
    temporary = `${path}.${randomUUID()}.tmp`;
  try {
    regularFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    syncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}
