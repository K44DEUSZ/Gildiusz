import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function npmEntrypoint() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath))
    return process.env.npm_execpath;
  const locations = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["npm"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/);
  for (const location of locations) {
    const actual = realpathSync(location);
    for (const candidate of [
      actual.endsWith(".js") ? actual : "",
      join(dirname(location), "node_modules", "npm", "bin", "npm-cli.js"),
    ])
      if (candidate && existsSync(candidate)) return candidate;
  }
  throw Error("Run the contracts build through npm or install the npm CLI.");
}
function sourceFiles(root, directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(root, path);
    return entry.name.endsWith(".ts")
      ? [
          [
            relative(root, path).split(sep).join("/"),
            readFileSync(path, "utf8").replace(/\r\n/g, "\n"),
          ],
        ]
      : [];
  });
}
function removeTemporaryDirectory(directory) {
  if (!realpathSync(directory).startsWith(realpathSync(tmpdir()) + sep))
    throw Error("Temporary contracts directory escaped its workspace.");
  rmSync(directory, { recursive: true, force: true });
}
export async function buildContracts(root, output = join(root, "artifacts", "contracts")) {
  root = resolve(root);
  output = resolve(output);
  const stage = mkdtempSync(join(tmpdir(), "gildiusz-contracts-"));
  try {
    writeFileSync(join(stage, "package.json"), '{"type":"module"}\n');
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "bin", "tsc"),
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--skipLibCheck",
        "--declaration",
        "--newLine",
        "lf",
        "--rootDir",
        join(root, "src", "contracts"),
        "--outDir",
        stage,
        join(root, "src", "contracts", "index.ts"),
        join(root, "src", "contracts", "node.ts"),
      ],
      { cwd: root, stdio: "inherit" },
    );
    const { contractsVersion, schemaVersion } = await import(
      pathToFileURL(join(stage, "index.js")).href
    );
    if (!/^\d+\.\d+\.\d+$/.test(contractsVersion) || !Number.isSafeInteger(schemaVersion))
      throw Error("Invalid contracts version.");
    const name = "@gildiusz/contracts";
    const packageJson = {
      name,
      version: contractsVersion,
      description: "Wspólne kontrakty bota i panelu Gildiusza.",
      type: "module",
      engines: { node: ">=24.17.0" },
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./node": { types: "./node.d.ts", default: "./node.js" },
        "./package.json": "./package.json",
      },
      files: ["*.js", "*.d.ts", "LICENSE"],
      license: "MIT",
      author: "Bartosz Golat",
      repository: { type: "git", url: "git+https://github.com/K44DEUSZ/Gildiusz.git" },
    };
    writeFileSync(join(stage, "package.json"), JSON.stringify(packageJson, null, 2) + "\n");
    const license = readFileSync(join(root, "LICENSE"), "utf8").replace(/\r\n/g, "\n");
    writeFileSync(join(stage, "LICENSE"), license);
    mkdirSync(output, { recursive: true });
    const packed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          npmEntrypoint(),
          "pack",
          stage,
          "--offline",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          output,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, npm_config_update_notifier: "false" },
        },
      ),
    );
    const archive = `gildiusz-contracts-${contractsVersion}.tgz`;
    if (packed.length !== 1 || packed[0].filename !== archive)
      throw Error("Unexpected contracts archive.");
    const bytes = readFileSync(join(output, archive));
    const sources = sourceFiles(root, join(root, "src", "contracts"));
    sources.push(["LICENSE", license]);
    sources.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const manifest = {
      format: 1,
      name,
      version: contractsVersion,
      schemaVersion,
      archive,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceHash: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
    };
    writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  } finally {
    removeTemporaryDirectory(stage);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = await buildContracts(
    root,
    process.argv[2] ? resolve(process.argv[2]) : undefined,
  );
  console.log(JSON.stringify(manifest));
}
