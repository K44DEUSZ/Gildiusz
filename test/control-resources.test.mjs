import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField } from "discord.js";
import { controlResources } from "../dist/bot/control.js";
import {
  fileFormats,
  parseVersionedResponse,
  reactionEmojiMaxLength,
  versionedResponse,
} from "../dist/contracts/index.js";

test("the actual backend resource response explicitly advertises its supported configuration inputs", async () => {
  const roleId = "100000000000000001",
    channelId = "100000000000000002",
    guildId = "100000000000000003";
  const everyone = { id: guildId },
    role = {
      id: roleId,
      name: "Rola",
      hexColor: "#123456",
      managed: false,
      permissions: new PermissionsBitField(),
    };
  const guild = {
    id: guildId,
    channels: {
      fetch: async () =>
        new Map([
          [
            channelId,
            {
              id: channelId,
              name: "Kanał",
              type: ChannelType.GuildText,
              permissionsFor: () =>
                new PermissionsBitField(P.ViewChannel | P.SendMessages | P.ReadMessageHistory),
            },
          ],
        ]),
    },
    roles: {
      everyone,
      fetch: async () =>
        new Map([
          [guildId, everyone],
          [roleId, role],
        ]),
    },
    members: {
      fetchMe: async () => ({
        permissions: new PermissionsBitField(P.ManageRoles),
        roles: { highest: { comparePositionTo: () => 1 } },
      }),
    },
  };
  const resources = await controlResources(guild);
  assert.deepEqual(resources.configurationCapabilities, {
    fileFormats: [...fileFormats],
    reactionEmojiMaxLength,
  });
  assert.equal(resources.configurationCapabilities.fileFormats.length, 20);
  assert.equal(resources.configurationCapabilities.reactionEmojiMaxLength, 64);
  assert.deepEqual(
    resources.channels.map((value) => value.id),
    [channelId],
  );
  assert.deepEqual(
    resources.roles.map((value) => value.id),
    [roleId],
  );
  assert.notEqual(resources.configurationCapabilities.fileFormats, fileFormats);
});

test("resource capabilities are additive and the legacy resource shape remains a valid versioned response", () => {
  const legacy = { channels: [], roles: [] };
  assert.deepEqual(parseVersionedResponse(versionedResponse(legacy), (data) => data).data, legacy);
  assert.equal(Object.hasOwn(legacy, "configurationCapabilities"), false);
  const current = {
    ...legacy,
    configurationCapabilities: { fileFormats: [...fileFormats], reactionEmojiMaxLength },
    futureMetadata: { ignored: true },
  };
  assert.deepEqual(
    parseVersionedResponse(versionedResponse(current), (data) => data).data,
    current,
  );
});
