import type { AnnouncementCard, AnnouncementLink } from "../../contracts/modules.js";
import { AnnouncementError } from "./types.js";

export function normalizeAnnouncementPresentation(value: {
  card?: AnnouncementCard | null;
  links?: AnnouncementLink[];
}): { card: AnnouncementCard | null; links: AnnouncementLink[] } {
  let card: AnnouncementCard | null = null;
  if (value.card !== undefined && value.card !== null) {
    const input = value.card;
    if (
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["title", "description", "color", "imageAssetId"].includes(key),
      ) ||
      typeof input.title !== "string" ||
      input.title.length > 256 ||
      input.title.includes("\0") ||
      typeof input.description !== "string" ||
      input.description.length > 4096 ||
      input.description.includes("\0") ||
      !Number.isInteger(input.color) ||
      input.color < 0 ||
      input.color > 0xffffff ||
      (input.imageAssetId !== undefined &&
        (typeof input.imageAssetId !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            input.imageAssetId,
          )))
    )
      throw new AnnouncementError("invalid_input");
    card = {
      title: input.title,
      description: input.description,
      color: input.color,
      ...(input.imageAssetId === undefined ? {} : { imageAssetId: input.imageAssetId }),
    };
  }
  const links = value.links ?? [];
  if (!Array.isArray(links) || links.length > 5) throw new AnnouncementError("invalid_input");
  return {
    card,
    links: links.map((link) => {
      if (
        !link ||
        typeof link !== "object" ||
        Array.isArray(link) ||
        Object.keys(link).some((key) => !["label", "url"].includes(key)) ||
        typeof link.label !== "string" ||
        !link.label.trim() ||
        link.label.length > 80 ||
        link.label.includes("\0") ||
        typeof link.url !== "string" ||
        !link.url ||
        link.url.length > 512 ||
        [...link.url].some(
          (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new AnnouncementError("invalid_input");
      let url: URL;
      try {
        url = new URL(link.url);
      } catch {
        throw new AnnouncementError("invalid_input");
      }
      // Links are sent to Discord; the server never downloads their destination.
      if (
        url.protocol !== "https:" ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.href.length > 512
      )
        throw new AnnouncementError("invalid_input");
      return { label: link.label, url: url.href };
    }),
  };
}

export function hasAnnouncementBody(content: string, card: AnnouncementCard | null): boolean {
  return Boolean(
    content.trim() || (card && (card.title.trim() || card.description.trim() || card.imageAssetId)),
  );
}
