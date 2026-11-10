import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const { AbortController } = globalThis;
const base = pathToFileURL(
  resolve(process.env.GILDIUSZ_MUSIC_TEST_DIST ?? "dist/modules/music-rehearsal") + "/",
);
const { FfmpegRehearsalDecoder, ffmpegRehearsalArguments } = await import(
  new URL("ffmpeg.js", base)
);
const { syntheticWav, syntheticWavSha256, readSyntheticPcm, syntheticFrames } = await import(
  new URL("synthetic.js", base)
);
const { RehearsalError } = await import(new URL("types.js", base));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const code = (value) => (error) => error instanceof RehearsalError && error.code === value;
const childPath = fileURLToPath(new URL("./fixtures/music-rehearsal-child.mjs", import.meta.url));
function fixture(t, mode = "encode", ignoreTerm = false) {
  const directory = mkdtempSync(join(tmpdir(), "gildiusz-music-decoder-"));
  const sourcePath = join(directory, "own.wav"),
    executablePath = join(directory, "fake-ffmpeg");
  writeFileSync(sourcePath, syntheticWav(), { mode: 0o600 });
  writeFileSync(executablePath, "controlled fixture", { mode: 0o700 });
  const children = [],
    calls = [],
    signals = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((done) => child.once("close", done));
      }
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw Error("Unexpected fixture path");
    rmSync(directory, { recursive: true, force: true });
  });
  const options = {
    sourcePath,
    executablePath,
    executableSha256: hash("controlled fixture"),
    termGraceMs: 30,
    stopTimeoutMs: 1500,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      const child = spawn(process.execPath, [childPath, mode], {
        stdio: "pipe",
        windowsHide: true,
        env: options.env,
      });
      const kill = child.kill.bind(child);
      child.kill = (signal) => {
        signals.push(signal);
        return ignoreTerm && signal === "SIGTERM" ? true : kill(signal);
      };
      children.push(child);
      return child;
    },
  };
  return {
    sourcePath,
    options,
    children,
    calls,
    signals,
    decoder: new FfmpegRehearsalDecoder(options),
  };
}
test("the sole source is the pinned own WAV and finite frames stay small even for an hour", (t) => {
  const f = fixture(t);
  assert.equal(hash(syntheticWav()), syntheticWavSha256);
  const pcm = readSyntheticPcm(f.sourcePath),
    frames = syntheticFrames(pcm, 3600);
  assert.equal(pcm.length, 192000);
  assert.equal(frames.next().value.length, 3840);
  const changed = syntheticWav();
  changed[100] ^= 1;
  writeFileSync(f.sourcePath, changed);
  assert.throws(() => readSyntheticPcm(f.sourcePath), code("source_invalid"));
});
test("prepare verifies exact files before spawning; changed binaries, aborts and symlinks fail closed", async (t) => {
  const f = fixture(t),
    abort = new AbortController();
  const prepared = await f.decoder.prepare(abort.signal);
  assert.equal(f.children.length, 0);
  writeFileSync(f.options.executablePath, "changed fixture");
  assert.throws(() => prepared.start(1, abort.signal), code("decoder_unavailable"));
  abort.abort();
  await assert.rejects(f.decoder.prepare(abort.signal), code("cancelled"));
  assert.equal(f.children.length, 0);
  if (process.platform !== "win32") {
    const linked = f.sourcePath + ".link";
    symlinkSync(f.sourcePath, linked);
    const decoder = new FfmpegRehearsalDecoder({ ...f.options, sourcePath: linked });
    await assert.rejects(
      decoder.prepare(new AbortController().signal),
      code("decoder_unavailable"),
    );
  }
});
test("actual controlled subprocess receives only pipe protocols and OS env; output and EOF are bounded", async (t) => {
  const f = fixture(t),
    signal = new AbortController().signal;
  const prepared = await f.decoder.prepare(signal),
    session = prepared.start(1, signal);
  let bytes = 0;
  for await (const chunk of session.output) bytes += chunk.length;
  await session.finished;
  await session.stop();
  assert.ok(bytes > 0 && bytes < 10000);
  assert.equal(f.calls[0].options.shell, false);
  assert.deepEqual(
    Object.keys(f.calls[0].options.env).filter(
      (name) => !["PATH", "LANG", "LC_ALL", "SystemRoot", "WINDIR", "TEMP", "TMP"].includes(name),
    ),
    [],
  );
  assert.deepEqual(f.calls[0].args, ffmpegRehearsalArguments(1));
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf("-protocol_whitelist") + 1], "pipe");
  assert.ok(!f.calls[0].args.includes(f.sourcePath));
  assert.throws(() => prepared.start(1, signal), code("decoder_unavailable"));
});
test("ignored TERM escalates to KILL of the owned subprocess and resolves only after close", async (t) => {
  const f = fixture(t, "hold", true),
    signal = new AbortController();
  const session = (await f.decoder.prepare(signal.signal)).start(120, signal.signal);
  signal.abort();
  await session.stop();
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null);
});
for (const [mode, expected] of [
  ["stderr", "decoder_stderr_limit"],
  ["flood", "decoder_output_limit"],
])
  test(`${mode} limit stops the owned process without exposing diagnostics`, async (t) => {
    const f = fixture(t, mode),
      signal = new AbortController().signal;
    const session = (await f.decoder.prepare(signal)).start(1, signal);
    session.output.on("data", () => {});
    await assert.rejects(session.finished, code(expected));
    await session.stop();
    assert.ok(!JSON.stringify(session.metrics()).includes("AAAA"));
  });
