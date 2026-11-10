import { dirname, join, resolve } from "node:path";
import type { TwitchRuntimeConfiguration } from "./twitch-runtime.js";

export function twitchConfiguration(
  healthFile: string,
  values: NodeJS.ProcessEnv = process.env,
): {
  databasePath: string;
  configuration?: TwitchRuntimeConfiguration;
  proxyKey?: string;
  port: number;
} {
  const keys = [
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "TWITCH_WEBHOOK_SECRET",
    "TWITCH_CALLBACK_URL",
    "TWITCH_PROXY_KEY",
  ] as const;
  const configured = keys.filter((key) => Boolean(values[key]));
  if (configured.length && configured.length !== keys.length)
    throw Error("Complete the private Twitch configuration before starting.");
  const port = Number(values.TWITCH_INGRESS_PORT ?? 35475);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === Number(values.CONTROL_PORT ?? 35471)
  )
    throw Error("Choose a separate private Twitch ingress port.");
  return {
    databasePath: resolve(
      values.INTEGRATIONS_DATABASE_PATH || join(dirname(healthFile), "integrations.sqlite"),
    ),
    port,
    ...(configured.length
      ? {
          configuration: {
            clientId: values.TWITCH_CLIENT_ID!,
            clientSecret: values.TWITCH_CLIENT_SECRET!,
            webhookSecret: values.TWITCH_WEBHOOK_SECRET!,
            callbackUrl: values.TWITCH_CALLBACK_URL!,
          },
          proxyKey: values.TWITCH_PROXY_KEY!,
        }
      : {}),
  };
}
