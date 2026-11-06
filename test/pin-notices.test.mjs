import assert from "node:assert/strict";
import test from "node:test";
import { isManagedPinNotice, removePinNotices } from "../dist/shared/pin-notices.js";

test("pin cleanup deletes only the bot's system notice for a managed message in that channel", async () => {
  const own = {
    id: "notice",
    type: 6,
    channel_id: "channel",
    author: { id: "bot" },
    message_reference: { message_id: "managed", channel_id: "channel" },
  };
  const messages = [
    own,
    { ...own, id: "ordinary", type: 0 },
    { ...own, id: "member-pin", author: { id: "member" } },
    { ...own, id: "unmanaged-pin", message_reference: { message_id: "unmanaged" } },
    { ...own, id: "other-channel", channel_id: "other" },
    {
      ...own,
      id: "bad-reference",
      message_reference: { message_id: "managed", channel_id: "other" },
    },
    { ...own, id: "missing-reference", message_reference: undefined },
  ];
  const deleted = [];
  const api = {
    get: async () => messages,
    delete: async (route) => {
      deleted.push(route);
    },
  };
  assert.ok(isManagedPinNotice(own, "channel", "bot", new Set(["managed"])));
  assert.equal(await removePinNotices(api, "channel", "bot", new Set(["managed"])), 1);
  assert.deepEqual(deleted, ["/channels/channel/messages/notice"]);
});
