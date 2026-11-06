import { ChannelType, Routes } from "discord.js";
import type { Api, Body, RemoteResource, Snapshot } from "./api.js";
import type { Environment } from "../config.js";
import type { Store } from "../storage/store.js";
import { readContent } from "../content.js";
import { digest } from "../shared/utils.js";

export async function initializeForumGuides(
  api: Api,
  state: Snapshot,
  store: Store,
  environment: Environment,
  approval?: string,
) {
  if (store.operations().length) throw new Error("Resolve unfinished operations first.");
  const guides = [];
  for (const [key, title] of [
    ["showcase", "Zacznij tutaj: jak dodać projekt"],
    ["collaboration", "Zacznij tutaj: jak znaleźć ekipę"],
  ]) {
    const parentId = store.id(`channel.${key}`);
    const forum = state.channels.find((channel) => channel.id === parentId);
    const tag = (forum?.available_tags as Body[] | undefined)?.find(
      (entry) => entry.name === "Start",
    );
    if (forum?.type !== ChannelType.GuildForum || !tag?.id)
      throw new Error(`Configure the forum and Start tag first: ${key}`);
    const resourceKey = `guide.${key}`;
    const resource = store.resource(resourceKey);
    const content = readContent(`${key}-welcome.md`);
    if (content.length > 1900) throw new Error("Forum guide exceeds the message limit.");
    const body = {
      name: title,
      auto_archive_duration: 10080,
      applied_tags: [String(tag.id)],
      message: { content, allowed_mentions: { parse: [], replied_user: false }, flags: 4 },
    };
    if (resource) {
      const thread = (await api.get(Routes.channel(resource.id))) as RemoteResource;
      const message = (await api.get(
        Routes.channelMessage(resource.id, resource.id),
      )) as RemoteResource;
      if (
        resource.kind !== "guide" ||
        thread.type !== ChannelType.PublicThread ||
        thread.parent_id !== parentId ||
        thread.name !== title ||
        message.content !== content ||
        (message.author as { id?: string } | undefined)?.id !== environment.clientId
      )
        throw new Error(
          `Forum guide changed or has a different identity; review manually: ${resourceKey}`,
        );
    }
    guides.push({
      key: resourceKey,
      parentId,
      id: resource?.id ?? null,
      action: resource ? "keep" : "create",
      body,
    });
  }
  const hash = digest({
    guild: environment.guildId,
    owner: environment.ownerId,
    bot: environment.clientId,
    guides,
  });
  if (approval === undefined) return { approve: hash, guides };
  if (approval !== hash) throw new Error("Forum guide plan changed. Review a new preview.");
  for (const guide of guides) {
    if (guide.action === "keep") continue;
    const route = Routes.threads(guide.parentId);
    store.beginOperation(guide.key, { route, kind: "guide", action: "create", body: guide.body });
    const response = await api.post(route, guide.body);
    store.transaction(() => {
      store.putResource(guide.key, "guide", response.id, guide.body);
      store.endOperation(guide.key);
    });
  }
  return { applied: true, guides: guides.map(({ key, action }) => ({ key, action })) };
}
