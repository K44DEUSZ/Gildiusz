export const extendedAttachmentProbeBytes = 65536;
const extended = new Set([
  "bmp",
  "tif",
  "tiff",
  "avif",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "mp4",
  "mov",
  "webm",
  "zip",
  "7z",
  "rar",
]);

export function attachmentProbeBytes(extension: string, configured: number): number {
  return extended.has(extension) ? extendedAttachmentProbeBytes : configured;
}
function ascii(bytes: Buffer, offset: number, size: number): string {
  return bytes.subarray(offset, offset + size).toString("latin1");
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
}
const oggTable = Array.from({ length: 256 }, (_, value) => {
  value <<= 24;
  for (let bit = 0; bit < 8; bit++)
    value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
  return value >>> 0;
});

function bitmap(b: Buffer): boolean {
  if (b.length < 26 || ascii(b, 0, 2) !== "BM") return false;
  const dib = b.readUInt32LE(14),
    pixel = b.readUInt32LE(10),
    size = b.readUInt32LE(2);
  if (
    ![12, 40, 52, 56, 108, 124].includes(dib) ||
    b.length < 14 + dib ||
    pixel < 14 + dib ||
    size < pixel
  )
    return false;
  const width = dib === 12 ? b.readUInt16LE(18) : b.readInt32LE(18),
    height = dib === 12 ? b.readUInt16LE(20) : b.readInt32LE(22),
    planes = b.readUInt16LE(dib === 12 ? 22 : 26),
    bits = b.readUInt16LE(dib === 12 ? 24 : 28);
  return width > 0 && height !== 0 && planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits);
}
function tiff(b: Buffer): boolean {
  const little = ascii(b, 0, 4) === "II\x2a\x00";
  if (b.length < 8 || (!little && ascii(b, 0, 4) !== "MM\x00\x2a")) return false;
  const u16 = (at: number) => (little ? b.readUInt16LE(at) : b.readUInt16BE(at)),
    u32 = (at: number) => (little ? b.readUInt32LE(at) : b.readUInt32BE(at)),
    offset = u32(4);
  if (offset < 8 || offset + 2 > b.length) return false;
  const count = u16(offset);
  if (!count || count > 4096 || offset + 2 + count * 12 + 4 > b.length) return false;
  let width = false,
    height = false;
  for (let index = 0; index < count; index++) {
    const at = offset + 2 + index * 12,
      tag = u16(at),
      type = u16(at + 2);
    if (type < 1 || type > 13) return false;
    if (![256, 257].includes(tag)) continue;
    if (![3, 4].includes(type) || u32(at + 4) !== 1) return false;
    const value = type === 3 ? u16(at + 8) : u32(at + 8);
    if (!value) return false;
    if (tag === 256) width = true;
    else height = true;
  }
  return width && height;
}
function bmff(b: Buffer): string | null {
  let offset = 0;
  for (let box = 0; box < 16 && offset + 8 <= b.length; box++) {
    let length = b.readUInt32BE(offset),
      header = 8;
    const type = ascii(b, offset + 4, 4);
    if (length === 1) {
      if (offset + 16 > b.length) return null;
      const wide = b.readBigUInt64BE(offset + 8);
      if (wide > BigInt(b.length)) return null;
      length = Number(wide);
      header = 16;
    }
    if (length < header || offset + length > b.length) return null;
    if (type === "ftyp") {
      if (length < header + 8 || (length - header) % 4 !== 0) return null;
      const brands = [ascii(b, offset + header, 4)];
      for (let at = offset + header + 8; at < offset + length; at += 4)
        brands.push(ascii(b, at, 4));
      if (brands.some((value) => ["avif", "avis"].includes(value))) return "avif";
      if (brands.includes("qt  ")) return "mov";
      return brands.some((value) => /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |M4A |dash)$/.test(value))
        ? "mp4"
        : null;
    }
    if (!["free", "skip", "wide"].includes(type)) return null;
    offset += length;
  }
  return null;
}
function vint(b: Buffer, offset: number, strip: boolean): { value: number; size: number } | null {
  const first = b[offset];
  if (!first) return null;
  let size = 1,
    marker = 0x80;
  while (!(first & marker) && size <= 8) {
    marker >>>= 1;
    size++;
  }
  if (size > 8 || offset + size > b.length) return null;
  let value = strip ? first & (marker - 1) : first;
  for (let at = 1; at < size; at++) value = value * 256 + b[offset + at]!;
  return Number.isSafeInteger(value) ? { value, size } : null;
}
function webm(b: Buffer): boolean {
  if (b.length < 6 || b.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const size = vint(b, 4, true);
  if (!size || size.value > 4096) return false;
  const end = 4 + size.size + size.value;
  if (end > b.length) return false;
  let found = false;
  for (let at = 4 + size.size, fields = 0; at < end && fields < 64; fields++) {
    const id = vint(b, at, false);
    if (!id || id.size > 4) return false;
    const length = vint(b, at + id.size, true);
    if (!length) return false;
    at += id.size + length.size;
    if (at + length.value > end) return false;
    if (id.value === 0x4282) {
      if (found || length.value !== 4 || ascii(b, at, 4) !== "webm") return false;
      found = true;
    }
    at += length.value;
    if (at === end) return found;
  }
  return false;
}
function wave(b: Buffer): boolean {
  if (b.length < 44 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return false;
  const end = b.readUInt32LE(4) + 8;
  if (end < 44) return false;
  let format = false;
  for (let at = 12, chunks = 0; at + 8 <= Math.min(end, b.length) && chunks < 256; chunks++) {
    const name = ascii(b, at, 4),
      length = b.readUInt32LE(at + 4);
    if (at + 8 + length > end) return false;
    if (name === "data") return format;
    if (name === "fmt ") {
      if (format || length < 16 || at + 8 + length > b.length) return false;
      const codec = b.readUInt16LE(at + 8),
        channels = b.readUInt16LE(at + 10),
        rate = b.readUInt32LE(at + 12),
        block = b.readUInt16LE(at + 20);
      if (!codec || !channels || channels > 64 || !rate || rate > 768000 || !block) return false;
      if (codec === 0xfffe && length < 40) return false;
      format = true;
    }
    at += 8 + length + (length % 2);
  }
  return false;
}
function ogg(b: Buffer): boolean {
  if (
    b.length < 28 ||
    ascii(b, 0, 4) !== "OggS" ||
    b[4] !== 0 ||
    ![2, 6].includes(b[5]!) ||
    b.readUInt32LE(18) !== 0
  )
    return false;
  const segments = b[26]!;
  if (!segments || 27 + segments > b.length) return false;
  const length =
    27 + segments + b.subarray(27, 27 + segments).reduce((sum, value) => sum + value, 0);
  if (length > b.length || length === 27 + segments) return false;
  let value = 0;
  for (let at = 0; at < length; at++) {
    const byte = at >= 22 && at < 26 ? 0 : b[at]!;
    value = (value << 8) ^ oggTable[((value >>> 24) ^ byte) & 255]!;
  }
  return value >>> 0 === b.readUInt32LE(22);
}
function flac(b: Buffer): boolean {
  if (
    b.length < 42 ||
    ascii(b, 0, 4) !== "fLaC" ||
    (b[4]! & 0x7f) !== 0 ||
    b.readUIntBE(5, 3) !== 34
  )
    return false;
  const minimum = b.readUInt16BE(8),
    maximum = b.readUInt16BE(10),
    sampleRate = b.readUIntBE(18, 3) >>> 4,
    bits = (((b[20]! & 1) << 4) | (b[21]! >>> 4)) + 1;
  return (
    minimum >= 16 &&
    maximum >= minimum &&
    sampleRate > 0 &&
    sampleRate <= 655350 &&
    bits >= 4 &&
    bits <= 32
  );
}
function mp3Frame(
  b: Buffer,
  at: number,
): { length: number; version: number; sample: number } | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1]! >>> 3) & 3,
    layer = (b[at + 1]! >>> 1) & 3,
    bitrate = b[at + 2]! >>> 4,
    sample = (b[at + 2]! >>> 2) & 3;
  if (
    version === 1 ||
    layer !== 1 ||
    bitrate === 0 ||
    bitrate === 15 ||
    sample === 3 ||
    (b[at + 3]! & 3) === 2
  )
    return null;
  const rates =
      version === 3
        ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    sampleRate = [44100, 48000, 32000][sample]! / (version === 3 ? 1 : version === 2 ? 2 : 4),
    length =
      Math.floor(((version === 3 ? 144000 : 72000) * rates[bitrate - 1]!) / sampleRate) +
      ((b[at + 2]! >>> 1) & 1);
  return { length, version, sample };
}
function mp3(b: Buffer): boolean {
  let at = 0;
  if (ascii(b, 0, 3) === "ID3") {
    if (
      b.length < 10 ||
      ![2, 3, 4].includes(b[3]!) ||
      b[4] === 255 ||
      b[5]! & (b[3] === 2 ? 0x3f : b[3] === 3 ? 0x1f : 0x0f)
    )
      return false;
    for (const value of b.subarray(6, 10)) {
      if (value & 0x80) return false;
      at = at * 128 + value;
    }
    at += 10 + (b[3] === 4 && b[5]! & 0x10 ? 10 : 0);
  }
  const first = mp3Frame(b, at);
  if (!first) return false;
  const second = mp3Frame(b, at + first.length);
  return Boolean(
    second &&
    first.version === second.version &&
    first.sample === second.sample &&
    at + first.length + second.length <= b.length,
  );
}
function zip(b: Buffer): boolean {
  if (b.length >= 22 && b.readUInt32LE(0) === 0x06054b50)
    return (
      b.readUInt16LE(8) === 0 &&
      b.readUInt16LE(10) === 0 &&
      b.readUInt32LE(12) === 0 &&
      b.readUInt32LE(16) === 0 &&
      22 + b.readUInt16LE(20) <= b.length
    );
  if (b.length < 30 || b.readUInt32LE(0) !== 0x04034b50) return false;
  const version = b.readUInt16LE(4),
    method = b.readUInt16LE(8),
    name = b.readUInt16LE(26),
    extra = b.readUInt16LE(28);
  return (
    version >= 10 &&
    version <= 63 &&
    [0, 8, 9, 12, 14, 20, 93, 98, 99].includes(method) &&
    name > 0 &&
    name <= 4096 &&
    30 + name + extra <= b.length &&
    !b.subarray(30, 30 + name).includes(0)
  );
}
function sevenZip(b: Buffer): boolean {
  if (
    b.length < 32 ||
    !b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) ||
    b[6] !== 0 ||
    b[7]! > 4 ||
    crc32(b.subarray(12, 32)) !== b.readUInt32LE(8)
  )
    return false;
  const offset = b.readBigUInt64LE(12),
    size = b.readBigUInt64LE(20);
  return (
    (size > 0 || (offset === 0n && b.readUInt32LE(28) === 0)) &&
    offset + size + 32n <= BigInt(Number.MAX_SAFE_INTEGER)
  );
}
function rarVint(b: Buffer, at: number): { value: number; size: number } | null {
  let value = 0,
    power = 1;
  for (let size = 1; size <= 8 && at + size <= b.length; size++) {
    const byte = b[at + size - 1]!;
    value += (byte & 0x7f) * power;
    if (!Number.isSafeInteger(value)) return null;
    if (!(byte & 0x80)) return { value, size };
    power *= 128;
  }
  return null;
}
function rar(b: Buffer): boolean {
  if (ascii(b, 0, 7) === "Rar!\x1a\x07\x00") {
    if (b.length < 20 || b[9] !== 0x73) return false;
    const length = b.readUInt16LE(12);
    return (
      length >= 13 &&
      7 + length <= b.length &&
      (crc32(b.subarray(9, 7 + length)) & 0xffff) === b.readUInt16LE(7)
    );
  }
  if (ascii(b, 0, 8) !== "Rar!\x1a\x07\x01\x00" || b.length < 16) return false;
  const length = rarVint(b, 12);
  if (!length || length.value < 3 || 12 + length.size + length.value > b.length) return false;
  const type = rarVint(b, 12 + length.size);
  if (!type || type.value !== 1) return false;
  const end = 12 + length.size + length.value;
  let at = 12 + length.size + type.size;
  const flags = rarVint(b, at);
  if (!flags || flags.value > 0x7f) return false;
  at += flags.size;
  let extra = 0;
  for (const flag of [1, 2]) {
    if (!(flags.value & flag)) continue;
    const field = rarVint(b, at);
    if (!field) return false;
    at += field.size;
    if (flag === 1) extra = field.value;
  }
  const archiveFlags = rarVint(b, at);
  if (!archiveFlags || archiveFlags.value > 0x1f) return false;
  at += archiveFlags.size;
  if (archiveFlags.value & 2) {
    const volume = rarVint(b, at);
    if (!volume) return false;
    at += volume.size;
  }
  return at + extra <= end && crc32(b.subarray(12, end)) === b.readUInt32LE(8);
}

/** Prefix recognition only: this never decodes media, extracts archives or claims malware detection. */
export function sniffExtendedAttachment(bytes: Uint8Array): string | null {
  const b = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, extendedAttachmentProbeBytes),
  );
  if (bitmap(b)) return "bmp";
  if (tiff(b)) return "tiff";
  const iso = bmff(b);
  if (iso) return iso;
  if (webm(b)) return "webm";
  if (wave(b)) return "wav";
  if (ogg(b)) return "ogg";
  if (flac(b)) return "flac";
  if (mp3(b)) return "mp3";
  if (zip(b)) return "zip";
  if (sevenZip(b)) return "7z";
  if (rar(b)) return "rar";
  return null;
}
