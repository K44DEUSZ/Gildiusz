import type { Config } from "../config.js";
import { sniffExtendedAttachment } from "./attachment-formats.js";

export function extension(filename: string, allowed: string[]): string | null {
  const name = filename.normalize("NFKC");
  if (
    /[\p{Cc}\p{Cf}\\/]/u.test(name) ||
    name.length > 255 ||
    name.endsWith(" ") ||
    name.endsWith(".")
  )
    return null;
  const parts = name.toLowerCase().split(".");
  const result = parts.pop();
  if (
    !result ||
    !parts.length ||
    parts.some((part) =>
      /^(exe|com|bat|cmd|ps1|js|mjs|vbs|scr|msi|zip|rar|7z|html?|svg|docm|xlsm|pdf)$/i.test(part),
    )
  )
    return null;
  return allowed.includes(result) ? result : null;
}

export function sniff(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "jpeg";
  const prefix = buffer.subarray(0, 6).toString("ascii");
  if (["GIF87a", "GIF89a"].includes(prefix)) return "gif";
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP" &&
    buffer.length >= 16
  )
    return "webp";
  if (/^%PDF-[12]\.\d/.test(buffer.subarray(0, 8).toString("ascii"))) return "pdf";
  return sniffExtendedAttachment(bytes);
}

export function attachmentUrl(address: string, hosts: string[]): URL {
  const url = new URL(address);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.includes(url.hostname) ||
    !/^\/(ephemeral-)?attachments\/\d{17,20}\/\d{17,20}\//.test(url.pathname) ||
    address.length > 4096
  )
    throw new Error("UntrustedAttachmentURL");
  return url;
}

export async function fetchHeader(
  address: string,
  settings: Config["attachments"],
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const url = attachmentUrl(address, settings.hosts);
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(settings.timeoutMs),
    headers: { Range: `bytes=0-${settings.maxBytes - 1}`, "Accept-Encoding": "identity" },
  });
  if (![200, 206].includes(response.status) || !response.body) {
    await response.body?.cancel();
    throw new Error(`AttachmentHTTP${response.status}`);
  }
  const reader = response.body.getReader();
  const result = new Uint8Array(settings.maxBytes);
  let length = 0;
  try {
    while (length < settings.maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const size = Math.min(chunk.value.length, settings.maxBytes - length);
      result.set(chunk.value.subarray(0, size), length);
      length += size;
    }
  } finally {
    await reader.cancel();
  }
  return result.subarray(0, length);
}

export function matchesHeader(filename: string, bytes: Uint8Array, allowed: string[]): boolean {
  const ext = extension(filename, allowed);
  return Boolean(ext && sniff(bytes) === (ext === "jpg" ? "jpeg" : ext === "tif" ? "tiff" : ext));
}
