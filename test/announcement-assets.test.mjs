import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdtemp, readdir, writeFile, unlink, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { AnnouncementAssetStore } from "../dist/modules/announcement-assets/store.js";
import { validateImage } from "../dist/modules/announcement-assets/validate.js";
import { AnnouncementAssetError } from "../dist/modules/announcement-assets/types.js";
import { AnnouncementService } from "../dist/modules/announcements/service.js";
import { JobStore } from "../dist/core/jobs/store.js";
import { transaction } from "../dist/storage/migrations.js";
import { PhotonImage } from "@silvia-odwyer/photon-node";

const guildA = "100000000000000001",
  guildB = "100000000000000002",
  actor = "200000000000000001",
  channelId = "300000000000000001",
  initialNow = Date.parse("2026-11-09T12:00:00Z");
const code = (value) => (error) => error instanceof AnnouncementAssetError && error.code === value;
const imageBytes = (pixel, format = "png") => {
  const image = new PhotonImage(new Uint8Array(pixel.data), pixel.width, pixel.height);
  try {
    return format === "jpeg"
      ? image.get_bytes_jpeg(80)
      : format === "webp"
        ? image.get_bytes_webp()
        : image.get_bytes();
  } finally {
    image.free();
  }
};
const pngEncode = (pixel) => imageBytes(pixel);
const pixel = {
  width: 2,
  height: 1,
  data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
};
const png = Buffer.from(await pngEncode(pixel)),
  jpeg = Buffer.from(imageBytes(pixel, "jpeg")),
  webp = Buffer.from(
    "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoCAAEAAgA0JaACdAEO/gLsAM4+b/zhItX/zYH/t5/4I96RV6u8gAAA",
    "base64",
  );

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gildiusz-assets-")),
    db = new DatabaseSync(":memory:");
  let now = initialNow;
  const jobs = new JobStore(db, () => now),
    store = new AnnouncementAssetStore(db, guildA, root, { clock: () => now, ...options });
  const service = new AnnouncementService(jobs, {
    guildId: guildA,
    clock: () => now,
    authorize: () => {},
    validateAsset: (id) => store.validateAsset(id),
    onSaved: (value) => store.syncAnnouncement(value),
  });
  t.after(async () => {
    db.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const upload = (data = png, mediaType = "image/png", requestId = randomUUID(), authorize) =>
    store.upload(actor, requestId, mediaType, data, authorize);
  const draft = (assetId, extra = {}) => ({
    channelId,
    content: "Obraz ogłoszenia",
    card: {
      title: "Tytuł",
      description: "Opis",
      color: 0x5865f2,
      ...(assetId ? { imageAssetId: assetId } : {}),
    },
    schedule: { kind: "once", at: now + 60000 },
    saveAsDraft: true,
    ...extra,
  });
  return {
    root,
    db,
    jobs,
    store,
    service,
    upload,
    draft,
    now: () => now,
    setNow: (value) => {
      now = value;
    },
    files: () => readdir(join(root, guildA)),
  };
}

test("PNG, JPEG and WebP are fully decoded with dimensions matching the validated headers", async () => {
  for (const [data, type] of [
    [png, "image/png"],
    [jpeg, "image/jpeg"],
    [webp, "image/webp"],
    [imageBytes(pixel, "webp"), "image/webp"],
  ])
    assert.deepEqual(await validateImage(data, type), { width: 2, height: 1 });
  const edge = Buffer.from(
    await pngEncode({ width: 2048, height: 1, data: new Uint8ClampedArray(2048 * 4) }),
  );
  assert.deepEqual(await validateImage(edge, "image/png"), { width: 2048, height: 1 });
});

test("removing an announcement unpins only its image reference and later frees quota", async (t) => {
  const f = await fixture(t, { maxGuildFiles: 1 }),
    asset = await f.upload(),
    one = await f.service.create(actor, "one", f.draft(asset.id)),
    two = await f.service.create(actor, "two", f.draft(asset.id));
  await f.service.remove(actor, "remove-one", one.announcement.id, one.announcement.revision);
  assert.equal(f.store.describeAsset(asset.id).expiresAt, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM announcement_asset_refs").get().n, 1);
  await f.service.remove(actor, "remove-two", two.announcement.id, two.announcement.revision);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM announcement_asset_refs").get().n, 0);
  assert.equal(f.store.describeAsset(asset.id).expiresAt, f.now() + 86400000);
  assert.equal((await f.files()).length, 1);
  await assert.rejects(f.upload(), code("asset_quota"));
  f.setNow(f.now() + 86400000);
  assert.equal(await f.store.prune(), 1);
  assert.equal((await f.files()).length, 0);
  assert.ok((await f.upload()).id);
});

test("an asset detach followed by hook failure rolls back the whole removal", async (t) => {
  const f = await fixture(t),
    asset = await f.upload(),
    saved = await f.service.create(actor, "create", f.draft(asset.id));
  const broken = new AnnouncementService(f.jobs, {
    guildId: guildA,
    clock: f.now,
    authorize: () => {},
    onSaved(value) {
      f.store.syncAnnouncement(value);
      throw Error("after detach");
    },
  });
  await assert.rejects(
    broken.remove(actor, "remove", saved.announcement.id, saved.announcement.revision),
    /after detach/,
  );
  assert.equal(f.store.describeAsset(asset.id).expiresAt, null);
  assert.equal((await f.service.get(actor, saved.announcement.id)).card.imageAssetId, asset.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM announcement_asset_refs").get().n, 1);
});

test("removing an old image announcement needs no configured filesystem port to release its reference", async (t) => {
  const f = await fixture(t),
    asset = await f.upload(),
    saved = await f.service.create(actor, "create", f.draft(asset.id));
  f.setNow(f.now() + 120000);
  const withoutPort = new AnnouncementService(f.jobs, {
    guildId: guildA,
    clock: f.now,
    authorize: () => {},
  });
  await withoutPort.remove(
    actor,
    "remove-without-port",
    saved.announcement.id,
    saved.announcement.revision,
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM announcement_asset_refs").get().n, 0);
  assert.equal(f.store.describeAsset(asset.id).expiresAt, f.now() + 86400000);
  assert.equal((await f.files()).length, 1);
});

test("magic alone, wrong MIME, SVG, truncated and corrupt streams cannot masquerade as images", async () => {
  const corrupt = Buffer.from(png);
  corrupt[Math.floor(corrupt.length / 2)] ^= 255;
  for (const [data, type] of [
    [png, "image/jpeg"],
    [Buffer.from('<svg width="1" height="1"/>'), "image/png"],
    [png.subarray(0, 33), "image/png"],
    [corrupt, "image/png"],
    [jpeg.subarray(0, jpeg.length - 30), "image/jpeg"],
    [webp.subarray(0, webp.length - 3), "image/webp"],
    [Buffer.alloc(2097153), "image/png"],
  ])
    await assert.rejects(() => validateImage(data, type), code("invalid_asset"));
  const huge = Buffer.from(png);
  huge.writeUInt32BE(2049, 16);
  await assert.rejects(() => validateImage(huge, "image/png"), code("invalid_asset"));
});

test("files are private opaque scoped assets with durable exact upload replay and no bytes in SQL", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID(),
    first = await f.upload(png, "image/png", requestId);
  assert.match(first.id, /^[a-f0-9-]{36}$/);
  assert.equal(first.guildId, guildA);
  assert.equal(first.expiresAt, initialNow + 86400000);
  assert.deepEqual(await f.upload(png, "image/png", requestId), first);
  assert.equal((await f.files()).length, 1);
  const data = await f.store.readAsset(first.id);
  assert.equal(data.name, "announcement.png");
  assert.equal(data.contentType, "image/png");
  assert.deepEqual(Buffer.from(data.data), png);
  await assert.rejects(() => f.upload(jpeg, "image/jpeg", requestId), code("idempotency_conflict"));
  const stored = f.db.prepare("SELECT * FROM announcement_assets").get();
  assert.equal(Object.hasOwn(stored, "data"), false);
  assert.equal(Object.hasOwn(stored, "data_base64"), false);
  for (const id of ["../other.png", first.id.toUpperCase(), randomUUID()])
    await assert.rejects(() => f.store.readAsset(id), code("asset_not_found"));
  const other = new AnnouncementAssetStore(f.db, guildB, f.root);
  await assert.rejects(() => other.readAsset(first.id), code("asset_not_found"));
});

test("quota is checked atomically and rejected or revoked uploads leave no unreferenced files", async (t) => {
  const f = await fixture(t, { maxGuildFiles: 1, maxGuildBytes: 2097152 });
  await f.upload();
  await assert.rejects(() => f.upload(), code("asset_quota"));
  await assert.rejects(() => f.upload(Buffer.alloc(png.length)), code("asset_quota"));
  assert.equal((await f.files()).length, 1);
  const g = await fixture(t);
  let calls = 0;
  await assert.rejects(
    () =>
      g.upload(png, "image/png", randomUUID(), async () => {
        if (++calls === 2) throw new AnnouncementAssetError("invalid_asset");
      }),
    code("invalid_asset"),
  );
  assert.equal((await g.files()).length, 0);
  assert.equal(g.db.prepare("SELECT COUNT(*) AS n FROM announcement_assets").get().n, 0);
});

test("actor upload budget rejects further decode work, preserves replay and resets after a minute", async (t) => {
  const f = await fixture(t, { maxUploadsPerMinute: 1 }),
    requestId = randomUUID();
  const first = await f.upload(png, "image/png", requestId);
  assert.deepEqual(await f.upload(png, "image/png", requestId), first);
  await assert.rejects(() => f.upload(Buffer.alloc(png.length)), code("asset_busy"));
  f.setNow(f.now() + 60001);
  await f.upload();
  assert.equal((await f.files()).length, 2);
  const g = await fixture(t, { maxUploadsPerMinute: 1 });
  await assert.rejects(() => g.upload(Buffer.alloc(png.length)), code("invalid_asset"));
  await assert.rejects(() => g.upload(), code("asset_busy"));
  assert.equal((await g.files()).length, 0);
});

test("same request cannot resurrect an expired upload and orphan assets are removed after 24 hours", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID(),
    asset = await f.upload(png, "image/png", requestId);
  f.setNow(initialNow + 86400000);
  await assert.rejects(() => f.store.readAsset(asset.id), code("asset_expired"));
  assert.equal(await f.store.prune(), 1);
  assert.equal((await f.files()).length, 0);
  await assert.rejects(() => f.upload(png, "image/png", requestId), code("asset_expired"));
  assert.equal((await f.files()).length, 0);
});

test("an announcement pins its image transactionally and detaching starts a fresh 24 hour clock", async (t) => {
  const f = await fixture(t),
    asset = await f.upload(),
    created = await f.service.create(actor, "create-announcement", f.draft(asset.id));
  assert.equal(f.store.describeAsset(asset.id).expiresAt, null);
  f.setNow(initialNow + 3 * 86400000);
  assert.equal(await f.store.prune(), 0);
  await f.store.validateAsset(asset.id);
  await f.service.update(
    actor,
    "detach-announcement",
    created.announcement.id,
    created.announcement.revision,
    f.draft(undefined),
  );
  assert.equal(f.store.describeAsset(asset.id).expiresAt, f.now() + 86400000);
  f.setNow(f.now() + 86400000);
  assert.equal(await f.store.prune(), 1);
});

test("shared image references survive one detach and failed saves roll back reference changes", async (t) => {
  const f = await fixture(t),
    asset = await f.upload(),
    one = await f.service.create(actor, "create-one", f.draft(asset.id)),
    two = await f.service.create(actor, "create-two", f.draft(asset.id));
  await f.service.update(
    actor,
    "detach-first",
    one.announcement.id,
    one.announcement.revision,
    f.draft(undefined),
  );
  assert.equal(f.store.describeAsset(asset.id).expiresAt, null);
  const before = f.db.prepare("SELECT COUNT(*) AS n FROM announcement_asset_refs").get().n;
  assert.throws(() =>
    transaction(f.db, () => {
      f.store.syncAnnouncement({ ...two.announcement, card: null });
      throw Error("rollback");
    }),
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM announcement_asset_refs").get().n, before);
  assert.equal(f.store.describeAsset(asset.id).expiresAt, null);
  assert.throws(() => f.store.syncAnnouncement(two.announcement), code("invalid_asset"));
});

test("changing a stored file or replacing it with a link cannot leak arbitrary filesystem bytes", async (t) => {
  const f = await fixture(t),
    asset = await f.upload(),
    path = join(f.root, guildA, (await f.files())[0]);
  const corrupt = Buffer.from(png);
  corrupt[0] ^= 1;
  await writeFile(path, corrupt);
  await assert.rejects(() => f.store.readAsset(asset.id), code("asset_storage_unavailable"));
  await unlink(path);
  const outside = join(f.root, "unrelated-private.txt");
  await writeFile(outside, "private");
  try {
    await symlink(outside, path);
  } catch (error) {
    if (error.code === "EPERM") return;
    throw error;
  }
  await assert.rejects(() => f.store.readAsset(asset.id), code("asset_storage_unavailable"));
});

test("expiry between validation and save cannot pin an expired image or leave a partial announcement", async (t) => {
  const f = await fixture(t),
    asset = await f.upload();
  const service = new AnnouncementService(f.jobs, {
    guildId: guildA,
    clock: f.now,
    authorize: () => {},
    validateAsset: async (id) => {
      await f.store.validateAsset(id);
      f.setNow(initialNow + 86400000);
    },
    onSaved: (value) => f.store.syncAnnouncement(value),
  });
  await assert.rejects(
    () => service.create(actor, "expired-save", f.draft(asset.id)),
    code("asset_expired"),
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM announcements").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM announcement_asset_refs").get().n, 0);
});

test("deleting an announcement cannot leave its formerly pinned image retained forever", async (t) => {
  const f = await fixture(t),
    asset = await f.upload(),
    created = await f.service.create(actor, "delete-parent", f.draft(asset.id));
  f.db.prepare("DELETE FROM schedules WHERE announcement_id=?").run(created.announcement.id);
  f.db.prepare("DELETE FROM announcements WHERE id=?").run(created.announcement.id);
  await f.store.prune();
  assert.equal(f.store.describeAsset(asset.id).expiresAt, f.now() + 86400000);
});

test("storage refuses a public_html location and malformed guild identifiers", async (t) => {
  const f = await fixture(t);
  for (const [id, path] of [
    ["../bad", f.root],
    [guildA, join(f.root, "public_html", "assets")],
  ])
    assert.throws(
      () => new AnnouncementAssetStore(f.db, id, path),
      code("asset_storage_unavailable"),
    );
});

test(
  "POSIX storage rejects writable existing directories and later permission weakening",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t),
      asset = await f.upload();
    await chmod(join(f.root, guildA), 0o777);
    await assert.rejects(() => f.store.readAsset(asset.id), code("asset_storage_unavailable"));
    await chmod(join(f.root, guildA), 0o700);
    await chmod(f.root, 0o777);
    assert.throws(
      () => new AnnouncementAssetStore(f.db, guildA, f.root),
      code("asset_storage_unavailable"),
    );
    await chmod(f.root, 0o700);
  },
);

test("quota remains enforced for non-compressible valid image content", async (t) => {
  const bytes = new Uint8ClampedArray(randomBytes(200 * 200 * 4)),
    large = Buffer.from(await pngEncode({ width: 200, height: 200, data: bytes }));
  assert.ok(large.length > 49152);
  const f = await fixture(t, { maxGuildBytes: large.length });
  await f.upload(large);
  await assert.rejects(() => f.upload(png), code("asset_quota"));
});
