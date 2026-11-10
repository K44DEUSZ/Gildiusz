import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  ControlError,
  isControlPath,
  controlLimits,
  controlRequestBodyLimit,
} from "./contracts.js";
import { controlSignature } from "../contracts/node.js";
export { controlSignature };

export function startControlServer(
  key: string,
  port: number,
  handle: (path: string, body: unknown) => Promise<unknown>,
  options: { allowEphemeralPort?: boolean } = {},
): Promise<Server> {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(key) ||
    !Number.isInteger(port) ||
    (!(port === 0 && options.allowEphemeralPort) && port < 1024) ||
    port > 65535
  )
    throw Error("Invalid private control configuration");
  const nonces = new Map<string, number>();
  let active = 0,
    windowAt = Date.now(),
    requests = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    let counted = false;
    try {
      if (Date.now() - windowAt > 60000) {
        requests = 0;
        windowAt = Date.now();
      }
      if (++requests > controlLimits.requestsPerMinute || active >= controlLimits.activeRequests)
        throw new ControlError(429, "busy", "Panel jest zajęty. Spróbuj za chwilę.");
      active++;
      counted = true;
      if (request.method !== "POST" || !isControlPath(request.url ?? ""))
        throw new ControlError(404, "not_found", "Nie znaleziono operacji.");
      const bodyLimit = controlRequestBodyLimit(request.url!);
      const declared = request.headers["content-length"];
      if (
        declared !== undefined &&
        (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))
      )
        throw new ControlError(400, "invalid_input", "Nieprawidłowa długość żądania.");
      if (declared !== undefined && Number(declared) > bodyLimit)
        throw new ControlError(413, "too_large", "Przesłane dane są zbyt duże.");
      const header = (name: string) =>
        typeof request.headers[name] === "string" ? (request.headers[name] as string) : "";
      const time = header("x-gildiusz-time"),
        nonce = header("x-gildiusz-nonce"),
        signature = header("x-gildiusz-signature");
      if (
        !/^\d{13}$/.test(time) ||
        Math.abs(Date.now() - Number(time)) > controlLimits.clockSkewMs ||
        !/^[a-f0-9]{32}$/.test(nonce) ||
        !/^[a-f0-9]{64}$/.test(signature)
      )
        throw new ControlError(401, "unauthorized", "Brak dostępu do połączenia bota.");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > bodyLimit)
          throw new ControlError(413, "too_large", "Konfiguracja jest za duża.");
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const expected = controlSignature(key, request.method, request.url!, time, nonce, body);
      if (
        !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex")) ||
        nonces.has(nonce)
      )
        throw new ControlError(401, "unauthorized", "Brak dostępu do połączenia bota.");
      for (const [value, expires] of nonces) if (expires < Date.now()) nonces.delete(value);
      nonces.set(nonce, Date.now() + controlLimits.nonceLifetimeMs);
      {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new ControlError(400, "invalid_json", "Niepoprawne żądanie.");
        }
        response.end(JSON.stringify(await handle(request.url!, parsed)));
      }
    } catch (error) {
      const known = error instanceof ControlError;
      response.statusCode = known ? error.status : 503;
      response.end(
        JSON.stringify({
          error: known
            ? error.message
            : "Bot nie może teraz zastosować ustawień. Spróbuj ponownie.",
          code: known ? error.code : "unavailable",
        }),
      );
    } finally {
      if (counted) active--;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
