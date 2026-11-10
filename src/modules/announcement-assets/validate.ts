import { Worker } from "node:worker_threads";
import { crc32 } from "node:zlib";
import { imageSize } from "image-size";
import { AnnouncementAssetError } from "./types.js";

let decoding = false;
export async function validateImage(
  data: Uint8Array,
  mediaType: string,
): Promise<{ width: number; height: number }> {
  if (!(data instanceof Uint8Array) || data.byteLength < 12 || data.byteLength > 2097152)
    throw new AnnouncementAssetError("invalid_asset");
  const bytes = Buffer.from(data);
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : null;
  if (mediaType !== detected || !detected) throw new AnnouncementAssetError("invalid_asset");
  let dimensions;
  try {
    dimensions = imageSize(data);
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width > 2048 ||
      dimensions.height > 2048
    )
      throw Error();
    // Single-frame assets keep decode work and displayed dimensions predictable.
    if (detected === "image/png") {
      let offset = 8,
        ended = false;
      while (offset + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(offset),
          kind = bytes.toString("ascii", offset + 4, offset + 8);
        if (
          size > bytes.length - offset - 12 ||
          kind === "acTL" ||
          crc32(bytes.subarray(offset + 4, offset + 8 + size)) !==
            bytes.readUInt32BE(offset + 8 + size)
        )
          throw Error();
        offset += size + 12;
        if (kind === "IEND") {
          ended = true;
          break;
        }
      }
      if (!ended || offset !== bytes.length) throw Error();
    }
    if (detected === "image/webp") {
      if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw Error();
      let offset = 12;
      while (offset + 8 <= bytes.length) {
        const size = bytes.readUInt32LE(offset + 4),
          kind = bytes.toString("ascii", offset, offset + 4);
        if (size > bytes.length - offset - 8 || ["ANIM", "ANMF"].includes(kind)) throw Error();
        offset += 8 + size + (size % 2);
      }
      if (offset !== bytes.length) throw Error();
    }
  } catch {
    throw new AnnouncementAssetError("invalid_asset");
  }
  if (decoding) throw new AnnouncementAssetError("asset_busy");
  decoding = true;
  try {
    const result = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const worker = new Worker(new URL("./decode-worker.js", import.meta.url), {
        execArgv: [],
        workerData: { mediaType, data },
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
        stdout: true,
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      let finishing = false;
      const finish = async (value?: { width?: number; height?: number }) => {
        if (finishing) return;
        finishing = true;
        clearTimeout(timer);
        await worker.terminate().catch(() => {});
        if (
          value &&
          Number.isInteger(value.width) &&
          Number.isInteger(value.height) &&
          value.width === dimensions.width &&
          value.height === dimensions.height
        )
          resolve({ width: value.width!, height: value.height! });
        else reject(new AnnouncementAssetError("invalid_asset"));
      };
      const timer = setTimeout(() => void finish(), 5000);
      worker.once("error", () => void finish());
      worker.once("exit", () => void finish());
      worker.once("message", (value) => void finish(value));
    });
    return result;
  } finally {
    decoding = false;
  }
}
