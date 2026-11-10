import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { closeSync, fsyncSync, openSync, readSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { privateDirectory, syncDirectory, withInput, writeAll } from "./files.js";

const magic = Buffer.from("GLDBAK01");
const headerSize = 36,
  tagSize = 16;
export const manifestLimit = 8 * 1024 * 1024;

export function backupKey(
  key: Uint8Array | string,
  forbidden: readonly (Uint8Array | string)[] = [],
): Buffer {
  let value: Buffer;
  if (typeof key === "string") {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key))
      throw new Error("A separate 32-byte base64url backup key is required.");
    value = Buffer.from(key, "base64url");
    if (value.toString("base64url") !== key) throw new Error("Invalid backup key encoding.");
  } else value = Buffer.from(key);
  if (value.length !== 32 || new Set(value).size < 16)
    throw new Error("A random 32-byte backup key is required.");
  for (const item of forbidden) {
    const candidates =
      typeof item === "string"
        ? [
            Buffer.from(item),
            ...(/^[a-fA-F0-9]{64}$/.test(item) ? [Buffer.from(item, "hex")] : []),
            ...(/^[A-Za-z0-9_+/-]{43}=?$/.test(item) ? [Buffer.from(item, "base64")] : []),
          ]
        : [Buffer.from(item)];
    if (
      candidates.some(
        (candidate) => candidate.length === value.length && timingSafeEqual(candidate, value),
      )
    )
      throw new Error("The backup key must be independent of application credentials.");
  }
  return value;
}

export function encryptArchive(
  output: string,
  manifest: unknown,
  files: readonly string[],
  key: Buffer,
): void {
  privateDirectory(dirname(output));
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > manifestLimit) throw new Error("Recovery manifest budget exceeded.");
  const header = Buffer.concat([magic, randomBytes(16), randomBytes(12)]);
  const derived = Buffer.from(
    hkdfSync("sha256", key, header.subarray(8, 24), "gildiusz-backup-v1", 32),
  );
  const cipher = createCipheriv("aes-256-gcm", derived, header.subarray(24));
  derived.fill(0);
  cipher.setAAD(header);
  const fd = openSync(output, "wx", 0o600);
  let completed = false;
  try {
    writeAll(fd, header);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    writeAll(fd, cipher.update(length));
    writeAll(fd, cipher.update(json));
    const chunk = Buffer.alloc(65536);
    for (const path of files)
      withInput(path, (input, size) => {
        let position = 0;
        while (position < size) {
          const count = readSync(
            input,
            chunk,
            0,
            Math.min(chunk.length, size - position),
            position,
          );
          if (!count) throw new Error("Recovery source truncated.");
          writeAll(fd, cipher.update(chunk.subarray(0, count)));
          position += count;
        }
      });
    writeAll(fd, cipher.final());
    writeAll(fd, cipher.getAuthTag());
    fsyncSync(fd);
    completed = true;
  } finally {
    closeSync(fd);
    if (!completed) rmSync(output, { force: true });
  }
  syncDirectory(dirname(output));
}

export function decryptArchive(input: string, output: string, key: Buffer, maximum: number): void {
  withInput(input, (source, size) => {
    if (
      size < headerSize + tagSize + 4 ||
      size > maximum + manifestLimit + headerSize + tagSize + 4
    )
      throw new Error("Invalid recovery archive size.");
    const header = Buffer.alloc(headerSize),
      tag = Buffer.alloc(tagSize);
    if (
      readSync(source, header, 0, header.length, 0) !== header.length ||
      !header.subarray(0, 8).equals(magic)
    )
      throw new Error("Invalid recovery archive header.");
    if (readSync(source, tag, 0, tag.length, size - tag.length) !== tag.length)
      throw new Error("Truncated recovery archive.");
    const derived = Buffer.from(
      hkdfSync("sha256", key, header.subarray(8, 24), "gildiusz-backup-v1", 32),
    );
    const cipher = createDecipheriv("aes-256-gcm", derived, header.subarray(24));
    derived.fill(0);
    cipher.setAAD(header);
    cipher.setAuthTag(tag);
    const target = openSync(output, "wx", 0o600);
    let completed = false;
    try {
      const chunk = Buffer.alloc(65536);
      let position = headerSize;
      while (position < size - tagSize) {
        const count = readSync(
          source,
          chunk,
          0,
          Math.min(chunk.length, size - tagSize - position),
          position,
        );
        if (!count) throw new Error("Truncated recovery archive.");
        writeAll(target, cipher.update(chunk.subarray(0, count)));
        position += count;
      }
      writeAll(target, cipher.final());
      fsyncSync(target);
      completed = true;
    } catch {
      throw new Error("Recovery authentication failed (key or archive).");
    } finally {
      closeSync(target);
      if (!completed) rmSync(output, { force: true });
    }
  });
}
