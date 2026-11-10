import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import {
  sniffExtendedAttachment,
  attachmentProbeBytes,
  extendedAttachmentProbeBytes,
} from "../dist/bot/attachment-formats.js";
import { matchesHeader, extension, fetchHeader } from "../dist/bot/attachment-policy.js";
import {
  fileFormats,
  fileExtensions,
  fileFormatGroups,
  parseConfiguration,
} from "../dist/contracts/index.js";
import { loadConfig } from "../dist/config.js";
import { publicConfig } from "../dist/control/configuration.js";
import { supportedExtensions, validateSettings } from "../dist/settings.js";
import { AttachmentFilter } from "../dist/bot/attachments.js";

// Fixture checksums use a direct bit calculation; detector tables do not construct these inputs.
function checksum(bytes, ogg = false) {
  let value = ogg ? 0 : 0xffffffff;
  for (const byte of bytes) {
    value ^= ogg ? byte << 24 : byte;
    for (let bit = 0; bit < 8; bit++)
      value = ogg
        ? value & 0x80000000
          ? (value << 1) ^ 0x04c11db7
          : value << 1
        : value & 1
          ? (value >>> 1) ^ 0xedb88320
          : value >>> 1;
  }
  return (ogg ? value : value ^ 0xffffffff) >>> 0;
}
function iso(brand) {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(24);
  bytes.write("ftyp", 4);
  bytes.write(brand, 8);
  bytes.write(brand, 16);
  bytes.write(brand === "avif" ? "mif1" : brand, 20);
  return bytes;
}
function bitmap() {
  const b = Buffer.alloc(58);
  b.write("BM");
  b.writeUInt32LE(58, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(1, 18);
  b.writeInt32LE(1, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(4, 34);
  return b;
}
function tiff(little = true) {
  const b = Buffer.alloc(123),
    put16 = (value, at) => (little ? b.writeUInt16LE(value, at) : b.writeUInt16BE(value, at)),
    put32 = (value, at) => (little ? b.writeUInt32LE(value, at) : b.writeUInt32BE(value, at));
  b.write(little ? "II" : "MM");
  put16(42, 2);
  put32(8, 4);
  put16(9, 8);
  for (const [index, [tag, type, value]] of [
    [256, 4, 1],
    [257, 4, 1],
    [258, 3, 8],
    [259, 3, 1],
    [262, 3, 1],
    [273, 4, 122],
    [277, 3, 1],
    [278, 4, 1],
    [279, 4, 1],
  ].entries()) {
    const at = 10 + index * 12;
    put16(tag, at);
    put16(type, at + 2);
    put32(1, at + 4);
    if (type === 3) put16(value, at + 8);
    else put32(value, at + 8);
  }
  b[122] = 255;
  return b;
}
function wave() {
  const b = Buffer.alloc(46);
  b.write("RIFF");
  b.writeUInt32LE(38, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(2, 40);
  return b;
}
function ogg() {
  const b = Buffer.alloc(47);
  b.write("OggS");
  b[5] = 2;
  b.writeUInt32LE(1, 14);
  b[26] = 1;
  b[27] = 19;
  b.write("OpusHead", 28);
  b[36] = 1;
  b[37] = 2;
  b.writeUInt32LE(48000, 40);
  b.writeUInt32LE(checksum(b, true), 22);
  return b;
}
function flac() {
  const b = Buffer.alloc(42);
  b.write("fLaC");
  b[4] = 128;
  b.writeUIntBE(34, 5, 3);
  b.writeUInt16BE(4096, 8);
  b.writeUInt16BE(4096, 10);
  b.writeBigUInt64BE((44100n << 44n) | (1n << 41n) | (15n << 36n), 18);
  return b;
}
function mp3() {
  const frame = Buffer.alloc(417);
  frame.set([255, 251, 144, 100]);
  return Buffer.concat([frame, frame]);
}
function rar4() {
  const b = Buffer.alloc(20);
  b.set([82, 97, 114, 33, 26, 7, 0]);
  b[9] = 0x73;
  b.writeUInt16LE(13, 12);
  b.writeUInt16LE(checksum(b.subarray(9)) & 65535, 7);
  return b;
}
function rar5() {
  const b = Buffer.from("526172211a0701000000000003010000", "hex");
  b.writeUInt32LE(checksum(b.subarray(12)), 8);
  return b;
}
const fixtures = [
  { ext: "bmp", bytes: bitmap(), header: 54 },
  { ext: "tif", type: "tiff", bytes: tiff(), header: 122 },
  { ext: "tiff", bytes: tiff(false), header: 122 },
  { ext: "avif", bytes: iso("avif"), header: 24 },
  { ext: "mp3", bytes: mp3(), header: 834 },
  { ext: "wav", bytes: wave(), header: 44 },
  { ext: "ogg", bytes: ogg(), header: 47 },
  { ext: "flac", bytes: flac(), header: 42 },
  { ext: "mp4", bytes: iso("isom"), header: 24 },
  { ext: "mov", bytes: iso("qt  "), header: 24 },
  { ext: "webm", bytes: Buffer.from("1a45dfa3874282847765626d", "hex"), header: 12 },
  { ext: "zip", bytes: Buffer.alloc(22), header: 22 },
  // Official 7-Zip recovery example start header, without loading any compressed data.
  {
    ext: "7z",
    bytes: Buffer.from("377abcaf271c00045b38bef9590e00000000000023000000000000007a6368fd", "hex"),
    header: 32,
  },
  { ext: "rar", bytes: rar4(), header: 20 },
  { ext: "rar", bytes: rar5(), header: 16 },
];
fixtures.find((value) => value.ext === "zip").bytes.writeUInt32LE(0x06054b50);

test("extended formats need matching structured headers and remain opt-in", () => {
  for (const { ext, type = ext, bytes, header } of fixtures) {
    assert.equal(sniffExtendedAttachment(bytes), type, ext);
    assert.equal(
      matchesHeader(`project.${ext.toUpperCase()}`, bytes, [...fileExtensions]),
      true,
      ext,
    );
    assert.equal(
      matchesHeader(`project.${ext}`, bytes, loadConfig().attachments.extensions),
      false,
      ext,
    );
    assert.equal(sniffExtendedAttachment(bytes.subarray(0, header - 1)), null, ext);
  }
  assert.deepEqual(loadConfig().attachments.extensions, [
    "pdf",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
  ]);
  assert.deepEqual(publicConfig().attachments.extensions, loadConfig().attachments.extensions);
  assert.deepEqual(supportedExtensions, fileExtensions);
  assert.deepEqual(
    [...new Set(fileFormatGroups.flatMap((group) => group.formats))].sort(),
    [...fileFormats].sort(),
  );
});

test("cross-format renaming, executable disguises, unsupported text and ambiguous containers are rejected", () => {
  for (const first of fixtures)
    for (const second of fixtures) {
      if ((first.type ?? first.ext) === (second.type ?? second.ext)) continue;
      assert.equal(
        matchesHeader(`project.${second.ext}`, first.bytes, [...fileExtensions]),
        false,
        `${first.ext} as ${second.ext}`,
      );
    }
  for (const name of [
    "run.exe.mp4",
    "run.zip.mp3",
    "file.html.avif",
    "a.svg",
    "a.txt",
    "a.csv",
    "a.md",
    "a.docx",
    "a.xlsx",
    "a.pptx",
    "a.opus",
    "../a.zip",
    "a.rar.",
  ])
    assert.equal(extension(name, [...fileExtensions]), null, name);
  for (const bytes of [
    Buffer.from("MZnot a document"),
    Buffer.from("<svg></svg>"),
    Buffer.from("Hello world"),
    iso("heic"),
    Buffer.from("ID3"),
    Buffer.from("OggS"),
    Buffer.from("fLaC"),
    Buffer.from("RIFF0000WAVE"),
    Buffer.from("PK\x03\x04"),
    Buffer.from("Rar!\x1a\x07\x00"),
  ])
    assert.equal(sniffExtendedAttachment(bytes), null);
});

test("container sizes, checksums and missing identification data fail closed without decompression", () => {
  for (const ext of ["ogg", "7z", "rar"]) {
    const original = fixtures.find((value) => value.ext === ext),
      bytes = Buffer.from(original.bytes);
    bytes[bytes.length - 1] ^= 1;
    assert.equal(sniffExtendedAttachment(bytes), null, ext);
  }
  const badIso = iso("isom");
  badIso.writeUInt32BE(0xffffffff);
  assert.equal(sniffExtendedAttachment(badIso), null);
  const badTiff = tiff();
  badTiff.writeUInt32LE(0xffffffff, 4);
  assert.equal(sniffExtendedAttachment(badTiff), null);
  const badBitmap = bitmap();
  badBitmap.writeUInt32LE(10, 10);
  assert.equal(sniffExtendedAttachment(badBitmap), null);
  const empty7z = Buffer.alloc(32);
  empty7z.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
  empty7z.writeUInt32LE(checksum(empty7z.subarray(12)), 8);
  assert.equal(sniffExtendedAttachment(empty7z), "7z");
  const missingRarField = rar5();
  missingRarField[14] = 2;
  missingRarField.writeUInt32LE(checksum(missingRarField.subarray(12)), 8);
  assert.equal(sniffExtendedAttachment(missingRarField), null);
  const tag = Buffer.alloc(1010);
  tag.write("ID3");
  tag[3] = 4;
  tag[8] = 7;
  tag[9] = 104;
  assert.equal(sniffExtendedAttachment(Buffer.concat([tag, mp3()])), "mp3");
  assert.equal(sniffExtendedAttachment(tag), null);
  const huge = Buffer.alloc(extendedAttachmentProbeBytes + 1000);
  huge.write("ID3");
  huge[3] = 4;
  huge[7] = 4;
  huge.set(mp3(), extendedAttachmentProbeBytes + 10);
  assert.equal(sniffExtendedAttachment(huge), null);
  for (let length = 0; length < 200; length++) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + length * 17) & 255);
    assert.doesNotThrow(() => sniffExtendedAttachment(bytes));
  }
  for (const { bytes } of fixtures)
    for (let index = 0; index < bytes.length; index++) {
      const malformed = Buffer.from(bytes);
      malformed[index] ^= 255;
      assert.doesNotThrow(() => sniffExtendedAttachment(malformed));
    }
});

test("settings and the shared configuration parser accept the exact new catalog without changing old choices", () => {
  const config = {
    revision: 0,
    modules: { rooms: false, reactions: false, files: true, reports: false },
    rooms: { entryChannelId: "", categoryId: "", maxRooms: 10, userLimit: 0, idleSeconds: 60 },
    reactions: { channelId: "", choices: [] },
    files: { channelIds: [], formats: [...fileFormats], includeRooms: true },
    reports: { channelId: "" },
  };
  assert.deepEqual(parseConfiguration(config).files.formats, [...fileFormats]);
  assert.throws(() =>
    parseConfiguration({ ...config, files: { ...config.files, formats: [...fileFormats, "SVG"] } }),
  );
  const values = {
    maximum: 10,
    creationCooldownSeconds: 30,
    emptySeconds: 60,
    transferSeconds: 30,
    extensions: [...fileExtensions],
  };
  assert.deepEqual(validateSettings(values).extensions, [...fileExtensions]);
  assert.throws(() => validateSettings({ ...values, extensions: ["docx"] }));
  const old = { ...config, files: { ...config.files, formats: ["PDF", "PNG"] } };
  assert.deepEqual(parseConfiguration(old).files.formats, ["PDF", "PNG"]);
});

test("new header probes preserve CDN, Range, timeout and the exact 64KiB stream budget", async () => {
  const settings = loadConfig().attachments;
  for (const ext of settings.extensions)
    assert.equal(attachmentProbeBytes(ext, settings.maxBytes), settings.maxBytes);
  assert.equal(attachmentProbeBytes("mp3", settings.maxBytes), 65536);
  let cancelled = false,
    observed,
    reads = 0;
  const fetcher = async (url, options) => {
    observed = { url: String(url), options };
    return {
      status: 200,
      body: new ReadableStream({
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(8192));
        },
        cancel() {
          cancelled = true;
        },
      }),
    };
  };
  const bytes = await fetchHeader(
    "https://cdn.discordapp.com/attachments/100000000000000001/100000000000000002/audio.mp3",
    { ...settings, maxBytes: attachmentProbeBytes("mp3", settings.maxBytes) },
    fetcher,
  );
  assert.equal(bytes.length, 65536);
  assert.equal(cancelled, true);
  assert.ok(reads <= 9);
  assert.equal(observed.options.headers.Range, "bytes=0-65535");
  assert.equal(observed.options.redirect, "error");
  assert.ok(observed.options.signal instanceof globalThis.AbortSignal);
});

test("the real attachment filter uses the extended budget and denies unconfirmed prefixes without forwarding files", async (t) => {
  const config = loadConfig();
  config.attachments.extensions = ["mp3"];
  const calls = [],
    notices = [],
    ranges = [];
  let bytes = mp3();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    ranges.push(options.headers.Range);
    return {
      status: 206,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  });
  const channel = { isThread: () => false },
    context = {
      environment: { guildId: "guild", clientId: "self" },
      control: {
        modules: { files: true },
        files: { channelIds: ["channel"], includeRooms: false },
      },
      config,
      store: { room: () => undefined },
      alert: async (...args) => calls.push(args),
      notify: async (...args) => notices.push(args),
    };
  const message = {
    guildId: "guild",
    channelId: "channel",
    channel,
    id: "message",
    applicationId: null,
    author: { id: "user" },
    inGuild: () => true,
    attachments: new Map([
      [
        "a",
        {
          name: "audio.mp3",
          url: "https://cdn.discordapp.com/attachments/100000000000000001/100000000000000002/audio.mp3",
        },
      ],
    ]),
    delete: async () => calls.push("deleted"),
  };
  const incoming = { ...message, fetch: async () => message },
    filter = new AttachmentFilter(context);
  await filter.handle(incoming);
  assert.deepEqual(calls, []);
  assert.deepEqual(notices, []);
  bytes = Buffer.from("ID3");
  await filter.handle(incoming);
  assert.ok(calls.includes("deleted"));
  assert.equal(notices[0][2], "attachmentDenied");
  assert.deepEqual(ranges, ["bytes=0-65535", "bytes=0-65535"]);
});
