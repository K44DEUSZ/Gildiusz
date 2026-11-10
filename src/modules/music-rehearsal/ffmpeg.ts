import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { Readable, Transform, pipeline } from "node:stream";
import { checkpoint } from "./bounded.js";
import { readSyntheticPcm, syntheticFrames } from "./synthetic.js";
import {
  RehearsalError,
  type RehearsalDecoder,
  type PreparedRehearsalDecoder,
  type RehearsalDecoderSession,
} from "./types.js";

export interface FfmpegRehearsalOptions {
  executablePath: string;
  executableSha256: string;
  sourcePath: string;
  clock?: () => number;
  termGraceMs?: number;
  stopTimeoutMs?: number;
  /** Tests can substitute a controlled local process; the production default is node:child_process.spawn. */
  spawn?: (
    file: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
}
function physical(path: string, maximum: number): string {
  if (!isAbsolute(path)) throw new RehearsalError("decoder_unavailable");
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = absolute;
  while (true) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (current === absolute ? !info.isFile() : !info.isDirectory()))
      throw new RehearsalError("decoder_unavailable");
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      const stickyDirectory = info.isDirectory() && (info.mode & 0o1000) !== 0;
      if (
        (uid !== undefined && ![0, uid].includes(info.uid)) ||
        ((info.mode & 0o022) !== 0 && !stickyDirectory)
      )
        throw new RehearsalError("decoder_unavailable");
    }
    if (current === root) break;
    current = dirname(current);
  }
  const info = statSync(absolute);
  if (info.size < 1 || info.size > maximum) throw new RehearsalError("decoder_unavailable");
  return realpathSync(absolute);
}
const identity = (path: string) => {
  const stat = statSync(path);
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
};
async function digest(path: string, signal: AbortSignal): Promise<string> {
  const stream = createReadStream(path, { highWaterMark: 65536, signal }),
    hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    checkpoint(signal);
    size += chunk.length;
    if (size > 268435456) throw new RehearsalError("decoder_unavailable");
    hash.update(chunk);
  }
  return hash.digest("hex");
}
export function ffmpegRehearsalArguments(durationSeconds: number): string[] {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600)
    throw new RehearsalError("invalid_input");
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "pipe",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-re",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-i",
    "pipe:0",
    "-t",
    String(durationSeconds),
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-c:a",
    "libopus",
    "-threads",
    "1",
    "-b:a",
    "128k",
    "-vbr",
    "off",
    "-frame_duration",
    "20",
    "-application",
    "audio",
    "-f",
    "ogg",
    "pipe:1",
  ];
}
function environment(binary: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: dirname(binary), LANG: "C", LC_ALL: "C" };
  if (process.platform === "win32")
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[key]) result[key] = process.env[key];
  return result;
}
export class FfmpegRehearsalDecoder implements RehearsalDecoder {
  private readonly options: FfmpegRehearsalOptions;
  constructor(options: FfmpegRehearsalOptions) {
    if (
      !/^[a-f0-9]{64}$/i.test(options.executableSha256) ||
      !Number.isSafeInteger(options.termGraceMs ?? 1000) ||
      (options.termGraceMs ?? 1000) < 1 ||
      (options.termGraceMs ?? 1000) > 2000 ||
      !Number.isSafeInteger(options.stopTimeoutMs ?? 4000) ||
      (options.stopTimeoutMs ?? 4000) <= (options.termGraceMs ?? 1000) ||
      (options.stopTimeoutMs ?? 4000) > 5000
    )
      throw new RehearsalError("invalid_input");
    this.options = { ...options };
  }
  async prepare(signal: AbortSignal): Promise<PreparedRehearsalDecoder> {
    checkpoint(signal);
    try {
      const binary = physical(this.options.executablePath, 268435456),
        source = physical(this.options.sourcePath, 192044);
      const before = identity(binary),
        sourceBefore = identity(source),
        pcm = readSyntheticPcm(source);
      if (
        (await digest(binary, signal)) !== this.options.executableSha256.toLowerCase() ||
        identity(binary) !== before ||
        identity(source) !== sourceBefore
      )
        throw new RehearsalError("decoder_unavailable");
      checkpoint(signal);
      let used = false;
      return {
        start: (durationSeconds, inputSignal) => {
          checkpoint(inputSignal);
          if (used || physical(binary, 268435456) !== binary || identity(binary) !== before)
            throw new RehearsalError("decoder_unavailable");
          used = true;
          return this.start(binary, pcm, durationSeconds, inputSignal);
        },
      };
    } catch (error) {
      if (error instanceof RehearsalError) throw error;
      checkpoint(signal);
      throw new RehearsalError("decoder_unavailable");
    }
  }
  private start(
    binary: string,
    pcm: Buffer,
    durationSeconds: number,
    signal: AbortSignal,
  ): RehearsalDecoderSession {
    const args = ffmpegRehearsalArguments(durationSeconds),
      clock = this.options.clock ?? Date.now;
    const spawn =
      this.options.spawn ??
      ((file, arguments_, options) => nodeSpawn(file, arguments_, { ...options, stdio: "pipe" }));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        cwd: dirname(binary),
        env: environment(binary),
      });
    } catch {
      throw new RehearsalError("decoder_unavailable");
    }
    const metrics = { outputBytes: 0, stderrBytes: 0, lastOutputAt: clock() };
    let stopping = false,
      closed = false,
      failure: RehearsalError | undefined,
      stopPromise: Promise<void> | undefined;
    let resolveClose: () => void = () => {},
      resolveFinished: () => void = () => {},
      rejectFinished: (error: RehearsalError) => void = () => {};
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    void finished.catch(() => {});
    const maximum = Math.ceil(durationSeconds * 16000 * 1.5) + 262144;
    const input = Readable.from(syntheticFrames(pcm, durationSeconds), {
      objectMode: false,
      highWaterMark: 30720,
    });
    const output = new Transform({
      highWaterMark: 65536,
      transform(chunk: Buffer, _encoding, callback) {
        metrics.outputBytes += chunk.length;
        metrics.lastOutputAt = clock();
        if (metrics.outputBytes > maximum) {
          fail("decoder_output_limit");
          callback(new RehearsalError("decoder_output_limit"));
        } else callback(null, chunk);
      },
    });
    output.on("error", () => {});
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopping = true;
      input.destroy();
      child.stdin.destroy();
      output.destroy();
      if (closed) return (stopPromise = Promise.resolve());
      try {
        child.kill("SIGTERM");
      } catch {
        /* Closure is still required even when signaling failed. */
      }
      stopPromise = new Promise((resolve, reject) => {
        const kill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* The deadline reports an unconfirmed close. */
          }
        }, this.options.termGraceMs ?? 1000);
        const deadline = setTimeout(() => {
          clearTimeout(kill);
          reject(new RehearsalError("cleanup_unconfirmed"));
        }, this.options.stopTimeoutMs ?? 4000);
        void close.then(() => {
          clearTimeout(kill);
          clearTimeout(deadline);
          resolve();
        });
      });
      void stopPromise.catch(() => {});
      return stopPromise;
    };
    const fail = (code: "decoder_failed" | "decoder_output_limit" | "decoder_stderr_limit") => {
      failure ??= new RehearsalError(code);
      void stop();
    };
    const aborted = () => {
      void stop();
    };
    signal.addEventListener("abort", aborted, { once: true });
    child.once("error", () => fail("decoder_failed"));
    child.once("close", (code) => {
      closed = true;
      signal.removeEventListener("abort", aborted);
      if (failure) rejectFinished(failure);
      else if (!stopping && code !== 0) rejectFinished(new RehearsalError("decoder_failed"));
      else resolveFinished();
      resolveClose();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      metrics.stderrBytes = Math.min(65537, metrics.stderrBytes + chunk.length);
      if (!stopping && metrics.stderrBytes > 65536) fail("decoder_stderr_limit");
    });
    pipeline(input, child.stdin, (error) => {
      if (error && !stopping) fail("decoder_failed");
    });
    pipeline(child.stdout, output, (error) => {
      if (error && !stopping) fail("decoder_failed");
    });
    if (signal.aborted) void stop();
    return { output, finished, stop, metrics: () => ({ ...metrics }) };
  }
}
