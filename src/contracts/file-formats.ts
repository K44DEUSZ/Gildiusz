export const fileFormats = [
  "PDF",
  "PNG",
  "JPG",
  "JPEG",
  "WEBP",
  "GIF",
  "BMP",
  "TIF",
  "TIFF",
  "AVIF",
  "MP3",
  "WAV",
  "OGG",
  "FLAC",
  "MP4",
  "MOV",
  "WEBM",
  "ZIP",
  "7Z",
  "RAR",
] as const;
export type FileFormat = (typeof fileFormats)[number];
export const fileExtensions = fileFormats.map((value) =>
  value.toLowerCase(),
) as Lowercase<FileFormat>[];
export const fileFormatGroups: readonly { label: string; formats: readonly FileFormat[] }[] = [
  { label: "Dokumenty", formats: ["PDF"] },
  { label: "Obrazy", formats: ["PNG", "JPG", "JPEG", "WEBP", "GIF", "BMP", "TIF", "TIFF", "AVIF"] },
  { label: "Audio", formats: ["MP3", "WAV", "OGG", "FLAC"] },
  { label: "Wideo", formats: ["MP4", "MOV", "WEBM"] },
  { label: "Archiwa", formats: ["ZIP", "7Z", "RAR"] },
];
