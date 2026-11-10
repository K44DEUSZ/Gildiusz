import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { twitchConfiguration } from "../dist/bot/twitch-config.js";

test("Twitch remains unconfigured until all separate operator values exist", () => {
  const value = twitchConfiguration(resolve("private", "health.json"), {});
  assert.equal(value.databasePath, resolve("private", "integrations.sqlite"));
  assert.equal(value.configuration, undefined);
  assert.equal(value.proxyKey, undefined);
  assert.equal(value.port, 35475);
  for (const key of [
    "TWITCH_CLIENT_ID",
    "TWITCH_CLIENT_SECRET",
    "TWITCH_WEBHOOK_SECRET",
    "TWITCH_CALLBACK_URL",
    "TWITCH_PROXY_KEY",
  ])
    assert.throws(() => twitchConfiguration("health.json", { [key]: "configured" }), /Complete/);
});

test("private ingress rejects invalid ports and collisions with the control port", () => {
  for (const port of ["", "0", "80", "NaN", "35471", "65536", "35475.5"])
    assert.throws(
      () => twitchConfiguration("health.json", { TWITCH_INGRESS_PORT: port }),
      /separate/,
    );
  assert.throws(
    () =>
      twitchConfiguration("health.json", { TWITCH_INGRESS_PORT: "40000", CONTROL_PORT: "40000" }),
    /separate/,
  );
});

test("operator settings are explicitly separated from the session database and secrets are not echoed by errors", () => {
  const values = {
    TWITCH_CLIENT_ID: "client",
    TWITCH_CLIENT_SECRET: "private-client-secret",
    TWITCH_WEBHOOK_SECRET: "private-webhook-secret",
    TWITCH_CALLBACK_URL: "https://example.com/api/integrations/twitch/eventsub",
    TWITCH_PROXY_KEY: "private-proxy-key",
    INTEGRATIONS_DATABASE_PATH: resolve("private", "hub.sqlite"),
    TWITCH_INGRESS_PORT: "35476",
  };
  const parsed = twitchConfiguration("health.json", values);
  assert.equal(parsed.configuration.clientSecret, values.TWITCH_CLIENT_SECRET);
  assert.equal(parsed.databasePath, values.INTEGRATIONS_DATABASE_PATH);
  assert.equal(parsed.proxyKey, values.TWITCH_PROXY_KEY);
  assert.equal(parsed.port, 35476);
  assert.throws(
    () => twitchConfiguration("health.json", { ...values, TWITCH_CLIENT_ID: "" }),
    (error) => !error.message.includes(values.TWITCH_CLIENT_SECRET),
  );
});
