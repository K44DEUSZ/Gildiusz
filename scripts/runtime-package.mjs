import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const runtimeSources = [
  "dist",
  "content",
  "config",
  "scripts",
  "package.json",
  "package-lock.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];
const allowedRoots = new Set([...runtimeSources, "node_modules", "build.json"]);
const privateDirectories = new Set([
  ".git",
  ".bot",
  ".local",
  ".gildiusz-web",
  ".deployment-recovery",
  "uninstall-retention",
  "rules-acceptance-deletions",
]);
export function validatePackagePath(name) {
  if (
    typeof name !== "string" ||
    name.includes("\\") ||
    name.includes(":") ||
    /\p{Cc}/u.test(name) ||
    name.startsWith("/")
  )
    throw Error("Unsafe path in the runtime package.");
  const parts = name.replace(/^\.\//, "").replace(/\/$/, "").split("/");
  if (
    !parts[0] ||
    parts.some(
      (part) =>
        !part ||
        part === ".." ||
        part === "." ||
        privateDirectories.has(part.toLowerCase()) ||
        part.toLowerCase().startsWith(".env") ||
        ["restore-quarantine.json", "restore-manifest.json", "source-preparation.json"].includes(
          part.toLowerCase(),
        ) ||
        /\.(?:gldbak|gldledger|gldproof)(?:$|[-.])/i.test(part) ||
        /\.(?:sqlite3?|db)(?:$|[-.])/i.test(part),
    ) ||
    !allowedRoots.has(parts[0])
  )
    throw Error("Private data or an unsupported path entered the runtime package.");
  return parts;
}
export function validatePackageFile(name) {
  const parts = validatePackagePath(name),
    root = parts[0];
  const extensions = {
    dist: /\.(?:js|map)$/,
    content: /\.(?:json|md|txt)$/,
    config: /\.json$/,
    scripts: /\.(?:mjs|js)$/,
  };
  if (extensions[root] && !extensions[root].test(parts.at(-1)))
    throw Error("Unsupported file in a runtime source directory.");
}
export function validateRuntimeTree(directory, { prefix = "", allowBuilt = false } = {}) {
  const visit = (path, name) => {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1)
    )
      throw Error("Runtime packages cannot contain links or special files.");
    if (name && !(allowBuilt && name === ".built")) validatePackagePath(name);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path))
        visit(join(path, entry), name ? `${name}/${entry}` : entry);
    } else if (!(allowBuilt && name === ".built")) validatePackageFile(name);
  };
  visit(directory, prefix);
}

export const requiredRuntimeFilesV2 = [
  "dist/bot/main.js",
  "dist/cli.js",
  "dist/contracts/index.js",
  "dist/contracts/node.js",
  "dist/storage/recovery/index.js",
  "scripts/recovery.mjs",
  "dist/modules/announcement-assets/validate.js",
  "dist/modules/announcement-assets/decode-worker.js",
  "dist/modules/twitch/provider.js",
  "node_modules/discord.js/package.json",
  "node_modules/image-size/package.json",
  "node_modules/@silvia-odwyer/photon-node/photon_rs.js",
  "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
];
export const requiredRuntimeFilesV3 = [
  ...requiredRuntimeFilesV2,
  "dist/storage/uninstall-retention.js",
  "scripts/backup-catalog.mjs",
  "scripts/backup-collector.mjs",
  "scripts/backup-ledger.mjs",
  "scripts/backup-scheduler.mjs",
];
// Preserve validation of old releases without shipping their withdrawn audio feature.
export const retiredAudioFiles = [
  "dist/bot/music-rehearsal-voice.js",
  "dist/bot/music-rehearsal-operator.js",
  "dist/bot/music-rehearsal-operator-files.js",
  "dist/modules/music-rehearsal/types.js",
  "dist/modules/music-rehearsal/bounded.js",
  "dist/modules/music-rehearsal/synthetic.js",
  "dist/modules/music-rehearsal/ffmpeg.js",
  "dist/modules/music-rehearsal/service.js",
  "node_modules/@discordjs/voice/package.json",
  "node_modules/@snazzah/davey/package.json",
  "node_modules/@noble/ciphers/package.json",
];
export const requiredRuntimeFilesV4 = [
  ...requiredRuntimeFilesV3,
  "scripts/backup-proof.mjs",
  "scripts/recovery-deletions.mjs",
  "dist/storage/rules-deletion-journal.js",
  "dist/modules/server-rules/deletion-schema.js",
  "dist/modules/server-rules/deletion-outbox.js",
  "dist/storage/recovery/age.js",
  "dist/storage/recovery/deletions.js",
  ...retiredAudioFiles,
];
export const requiredRuntimeFilesV5 = [
  ...requiredRuntimeFilesV4,
  "scripts/backup-deletion-state.mjs",
  "scripts/rules-deletion-lifecycle.mjs",
  "dist/storage/rules-deletion-lifecycle.js",
];
export const requiredRuntimeFiles = [
  ...requiredRuntimeFilesV5.filter((name) => !retiredAudioFiles.includes(name)),
  "scripts/prepare-legacy-source.mjs",
  "scripts/backup-offsite.mjs",
];
export function assertRuntimePackage(directory, { format = 6 } = {}) {
  if (![1, 2, 3, 4, 5, 6].includes(format)) throw Error("Unsupported runtime package format.");
  const files =
    format === 1
      ? ["dist/bot/main.js", "dist/cli.js", "node_modules/discord.js/package.json"]
      : format === 2
        ? requiredRuntimeFilesV2
        : format === 3
          ? requiredRuntimeFilesV3
          : format === 4
            ? requiredRuntimeFilesV4
            : format === 5
              ? requiredRuntimeFilesV5
              : requiredRuntimeFiles;
  if (format === 6)
    for (const name of retiredAudioFiles)
      if (existsSync(join(directory, name)))
        throw Error(`Withdrawn audio file in the runtime package: ${name}`);
  for (const name of files) {
    const path = join(directory, name);
    if (!existsSync(path)) throw Error(`Missing runtime file: ${name}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1)
      throw Error(`Invalid runtime file: ${name}`);
  }
}
export function smokeRuntime(directory) {
  assertRuntimePackage(directory);
  // This exercises packaged JS -> worker -> local WASM without tokens, databases or Discord.
  const source =
    'await import("./scripts/recovery-deletions.mjs");await import("./scripts/backup-deletion-state.mjs");await import("./scripts/rules-deletion-lifecycle.mjs");await import("./scripts/prepare-legacy-source.mjs");await import("./scripts/backup-offsite.mjs");await import("./dist/storage/rules-deletion-lifecycle.js");' +
    'const{planBackupRotation}=await import("./scripts/backup-catalog.mjs");const{planDailyBackup}=await import("./scripts/backup-scheduler.mjs");await import("./scripts/backup-collector.mjs");await import("./scripts/backup-ledger.mjs");if(planBackupRotation([],{now:0}).remove.length||!planDailyBackup([],0).due)throw Error("Unexpected packaged backup ports");' +
    'import{validateImage}from"./dist/modules/announcement-assets/validate.js";const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==","base64");const value=await validateImage(bytes,"image/png");if(value.width!==1||value.height!==1)throw Error("Unexpected packaged decoder result");';
  const environment = { NODE_ENV: "production", TZ: "Europe/Warsaw" };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"])
    if (process.env[key]) environment[key] = process.env[key];
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: directory,
    stdio: "pipe",
    timeout: 15000,
    env: environment,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--smoke") throw Error("Use --smoke to verify the packaged runtime.");
  smokeRuntime(process.cwd());
  console.log("Packaged worker, recovery ports and image decoder verified.");
}
