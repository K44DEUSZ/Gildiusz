import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export class MusicOperatorError extends Error {
  constructor(
    readonly code:
      | "operator_config_invalid"
      | "operator_path_invalid"
      | "operator_request_invalid"
      | "operator_unavailable",
  ) {
    super(code);
    this.name = "MusicOperatorError";
  }
}
const identity = (value: Stats) =>
  [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
const samePath = (left: string, right: string) =>
  process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
function absolute(value: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length > 1024 ||
    value.includes("\0") ||
    /^(?:\\\\|\/\/)/.test(value) ||
    (process.platform === "win32" && value.slice(parse(value).root.length).includes(":")) ||
    value.split(/[\\/]/).some((part) => part.toLowerCase() === "public_html")
  )
    throw new MusicOperatorError("operator_path_invalid");
  return resolve(value);
}
function physicalParents(value: string, leafPrivate: boolean): void {
  for (let current = value; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(current), current))
      throw new MusicOperatorError("operator_path_invalid");
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      const ownLeaf = current === value && leafPrivate;
      const stickyParent = current !== value && (stat.mode & 0o1000) !== 0;
      if (
        (uid !== undefined && (ownLeaf ? stat.uid !== uid : ![0, uid].includes(stat.uid))) ||
        ((stat.mode & (ownLeaf ? 0o077 : 0o022)) !== 0 && !stickyParent)
      )
        throw new MusicOperatorError("operator_path_invalid");
    }
    if (current === parse(current).root) return;
  }
}
function regular(value: string): Stats {
  const stat = lstatSync(value);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !samePath(realpathSync(value), value)
  )
    throw new MusicOperatorError("operator_path_invalid");
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
  )
    throw new MusicOperatorError("operator_path_invalid");
  return stat;
}
function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Local operator files only. Every read/write rechecks physical private ancestors. */
export class MusicOperatorFiles {
  readonly root: string;
  readonly directory: string;
  readonly requestPath: string;
  readonly statusPath: string;
  constructor(dataRoot: string) {
    try {
      this.root = absolute(dataRoot);
      physicalParents(this.root, true);
      this.directory = join(this.root, "audio-rehearsal");
      try {
        mkdirSync(this.directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      physicalParents(this.directory, true);
      this.requestPath = join(this.directory, "request.json");
      this.statusPath = join(this.directory, "status.json");
    } catch {
      throw new MusicOperatorError("operator_path_invalid");
    }
  }
  configPath(value: string): string {
    const path = absolute(value),
      tail = relative(this.root, path);
    if (
      !tail ||
      tail === ".." ||
      tail.startsWith(`..${sep}`) ||
      isAbsolute(tail) ||
      [this.requestPath, this.statusPath].some((other) => samePath(path, other))
    )
      throw new MusicOperatorError("operator_path_invalid");
    return path;
  }
  privateFile(value: string, maximum: number): string {
    const path = absolute(value);
    physicalParents(dirname(path), false);
    const stat = regular(path);
    if (stat.size < 1 || stat.size > maximum) throw new MusicOperatorError("operator_path_invalid");
    return path;
  }
  read(value: string, maximum: number, optional = false): unknown {
    let fd: number | undefined;
    try {
      physicalParents(this.root, true);
      physicalParents(this.directory, true);
      const path = absolute(value);
      physicalParents(dirname(path), true);
      let before;
      try {
        before = regular(path);
      } catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      if (before.size < 1 || before.size > maximum)
        throw new MusicOperatorError("operator_request_invalid");
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (identity(fstatSync(fd)) !== identity(before))
        throw new MusicOperatorError("operator_path_invalid");
      const bytes = Buffer.alloc(before.size);
      let at = 0;
      while (at < bytes.length) {
        const count = readSync(fd, bytes, at, bytes.length - at, at);
        if (!count) throw new MusicOperatorError("operator_request_invalid");
        at += count;
      }
      if (
        identity(fstatSync(fd)) !== identity(before) ||
        identity(regular(path)) !== identity(before)
      )
        throw new MusicOperatorError("operator_path_invalid");
      // Fatal UTF-8 decoding also rejects hidden replacement characters in malformed input.
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      if (error instanceof MusicOperatorError) throw error;
      throw new MusicOperatorError("operator_request_invalid");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  writeStatus(value: unknown): void {
    let temporary: string | undefined, fd: number | undefined;
    try {
      physicalParents(this.root, true);
      physicalParents(this.directory, true);
      try {
        regular(this.statusPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const body = Buffer.from(`${JSON.stringify(value)}\n`);
      if (body.length > 32768) throw new MusicOperatorError("operator_unavailable");
      temporary = join(this.directory, `.status-${randomUUID()}.tmp`);
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, body);
      fsyncSync(fd);
      const written = identity(fstatSync(fd));
      closeSync(fd);
      fd = undefined;
      physicalParents(this.root, true);
      physicalParents(this.directory, true);
      try {
        regular(this.statusPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (identity(regular(temporary)) !== written)
        throw new MusicOperatorError("operator_unavailable");
      renameSync(temporary, this.statusPath);
      temporary = undefined;
      syncDirectory(this.directory);
    } catch {
      throw new MusicOperatorError("operator_unavailable");
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (temporary) {
        try {
          unlinkSync(temporary);
        } catch {
          /* Only the owned unpromoted temporary may remain after an IO failure. */
        }
      }
    }
  }
}
