import type { Announcement, AnnouncementAsset } from "../../contracts/modules.js";

export interface AnnouncementAssetData {
  name: "announcement.png" | "announcement.jpg" | "announcement.webp";
  contentType: AnnouncementAsset["mediaType"];
  data: Uint8Array;
}
export interface AnnouncementAssetPort {
  validateAsset(assetId: string): Promise<void>;
  readAsset(assetId: string): Promise<AnnouncementAssetData>;
  describeAsset(assetId: string): AnnouncementAsset;
  syncAnnouncement(announcement: Announcement): void;
  prune(): Promise<number>;
  upload(
    actorId: string,
    requestId: string,
    mediaType: string,
    data: Uint8Array,
    authorize?: () => Promise<void>,
  ): Promise<AnnouncementAsset>;
}
export class AnnouncementAssetError extends Error {
  constructor(
    readonly code:
      | "invalid_asset"
      | "asset_not_found"
      | "asset_expired"
      | "asset_quota"
      | "asset_storage_unavailable"
      | "asset_busy"
      | "idempotency_conflict",
  ) {
    super(code);
    this.name = "AnnouncementAssetError";
  }
}
