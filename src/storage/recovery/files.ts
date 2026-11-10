import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export function privateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("Recovery paths must be absolute.");
  path = resolve(path);
  if (path.split(/[\\/]/).some((part) => part.toLowerCase() === "public_html"))
    throw new Error("Recovery data must stay outside public_html.");
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const state = lstatSync(current);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error("Unsafe recovery directory.");
    if (process.platform !== "win32" && (state.mode & 0o022) !== 0) {
      const stickyTemporaryParent = current !== path && (state.mode & 0o1000) !== 0;
      if (!stickyTemporaryParent) throw new Error("Recovery directory permits unrelated writers.");
    }
  }
  const state = lstatSync(path);
  if (process.getuid && state.uid !== process.getuid())
    throw new Error("Recovery directory has another owner.");
  if (process.platform !== "win32" && (state.mode & 0o077) !== 0)
    throw new Error("Recovery directory must be private (0700).");
  return path;
}

export function regularFile(path: string): number {
  if (!isAbsolute(path)) throw new Error("Recovery paths must be absolute.");
  // Inspect existing ancestors without creating source directories.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const state = lstatSync(parent);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error("Unsafe recovery source parent.");
    if (parent.toLowerCase().split(/[\\/]/).includes("public_html"))
      throw new Error("Recovery data must stay outside public_html.");
    if (dirname(parent) === parent) break;
  }
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1)
    throw new Error("Recovery accepts only regular, unlinked files.");
  return state.size;
}

export function safeRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^[a-zA-Z0-9._/-]+$/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    isAbsolute(value)
  )
    throw new Error("Invalid recovery manifest path.");
  if (
    !/^(guilds|public-guilds)\/[0-9]{17,20}\/gildiusz\.sqlite$/.test(value) &&
    !/^configuration\/[0-9]{17,20}\.json$/.test(value) &&
    !/^uninstall-retention\/[0-9]{17,20}\.deleted\.json$/.test(value) &&
    !/^announcement-assets\/[0-9]{17,20}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$/.test(
      value,
    ) &&
    ![
      "guilds.json",
      "public-guilds/installations.json",
      "integrations.sqlite",
      "web/web.sqlite",
    ].includes(value)
  )
    throw new Error("Unexpected recovery manifest file.");
  return value;
}

export function inside(root: string, path: string): string {
  safeRelativePath(path);
  const target = resolve(root, ...path.split("/"));
  const tail = relative(root, target);
  if (!tail || tail.startsWith("..") || isAbsolute(tail)) throw new Error("Recovery path escape.");
  return target;
}

export function withInput<T>(path: string, task: (fd: number, size: number) => T): T {
  const size = regularFile(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const state = fstatSync(fd);
    if (!state.isFile() || state.nlink !== 1 || state.size !== size)
      throw new Error("Recovery source changed.");
    return task(fd, size);
  } finally {
    closeSync(fd);
  }
}

export function hashFile(path: string): { size: number; sha256: string } {
  return withInput(path, (fd, size) => {
    const hash = createHash("sha256"),
      chunk = Buffer.alloc(65536);
    let position = 0;
    while (position < size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (!count) throw new Error("Recovery source was truncated.");
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    return { size, sha256: hash.digest("hex") };
  });
}

export function copyPrivate(source: string, destination: string, maximum: number): void {
  privateDirectory(dirname(destination));
  withInput(source, (input, size) => {
    if (size > maximum) throw new Error("Recovery size budget exceeded.");
    const output = openSync(destination, "wx", 0o600);
    try {
      const chunk = Buffer.alloc(65536);
      let offset = 0;
      while (offset < size) {
        const count = readSync(input, chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (!count) throw new Error("Recovery source was truncated.");
        writeAll(output, chunk.subarray(0, count));
        offset += count;
      }
      fsyncSync(output);
    } finally {
      closeSync(output);
    }
  });
}

export function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

export function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
