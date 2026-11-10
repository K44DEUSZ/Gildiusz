import { createHash } from "node:crypto";
import { constants, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { RehearsalError } from "./types.js";

export const syntheticWavSha256 =
  "0430fb8db0261d58152958868de82a64bcdee3fda7f08c8b0ec834f181289689";
/** Own mathematical tones only, with a 20 ms fade and a peak of 0.03 full scale. */
export function syntheticWav(): Buffer {
  const wav = Buffer.alloc(192044);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(192000, 40);
  for (let frame = 0; frame < 48000; frame++) {
    const fade = Math.min(1, frame / 960, (48000 - frame - 1) / 960);
    for (let channel = 0; channel < 2; channel++)
      wav.writeInt16LE(
        Math.round(
          Math.sin((2 * Math.PI * (channel ? 660 : 440) * frame) / 48000) * 0.03 * fade * 32767,
        ),
        44 + frame * 4 + channel * 2,
      );
  }
  return wav;
}
export function readSyntheticPcm(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (fstatSync(descriptor).size !== 192044) throw new RehearsalError("source_invalid");
    const wav = Buffer.alloc(192045);
    let length = 0,
      count = 0;
    do {
      count = readSync(descriptor, wav, length, wav.length - length, null);
      length += count;
    } while (count > 0 && length < wav.length);
    if (
      length !== 192044 ||
      fstatSync(descriptor).size !== 192044 ||
      createHash("sha256").update(wav.subarray(0, length)).digest("hex") !== syntheticWavSha256
    )
      throw new RehearsalError("source_invalid");
    return Buffer.from(wav.subarray(44, length));
  } catch {
    throw new RehearsalError("source_invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export function* syntheticFrames(pcm: Buffer, durationSeconds: number): Generator<Buffer> {
  if (
    pcm.length !== 192000 ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > 3600
  )
    throw new RehearsalError("invalid_input");
  for (let index = 0; index < durationSeconds * 50; index++) {
    const offset = (index % 50) * 3840;
    yield pcm.subarray(offset, offset + 3840);
  }
}
