import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export async function relay(input, send = globalThis.fetch) {
  if (
    !input ||
    typeof input !== "object" ||
    input.method !== "POST" ||
    !/^\/guilds(?:\/\d{17,20}(?:\/save)?)?$/.test(input.path ?? "") ||
    typeof input.body !== "string" ||
    Buffer.byteLength(input.body) > 49152
  )
    throw Error("Invalid control request");
  const headers = input.headers;
  if (
    !headers ||
    typeof headers !== "object" ||
    Object.keys(headers).some(
      (key) => !["x-gildiusz-time", "x-gildiusz-nonce", "x-gildiusz-signature"].includes(key),
    ) ||
    Object.values(headers).some((value) => typeof value !== "string" || value.length > 80)
  )
    throw Error("Invalid control headers");
  const response = await send("http://127.0.0.1:35471" + input.path, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: input.body,
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(90000),
  });
  return { status: response.status, body: await response.json() };
}
async function main() {
  const chunks = [];
  let length = 0;
  const timer = setTimeout(() => process.exit(1), 10000);
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 65536) throw Error("Control request too large");
    chunks.push(chunk);
  }
  globalThis.clearTimeout(timer);
  const result = await relay(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write("Private control connection failed.\n");
    process.exitCode = 1;
  });
