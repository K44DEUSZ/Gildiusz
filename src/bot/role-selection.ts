import { PermissionFlagsBits as P } from "discord.js";
import type { BotContext } from "./context.js";
import { RoleSelectionService } from "../role-selection.js";
import { selectionChoices, rolePanel } from "./control.js";
import { errorCode } from "../shared/utils.js";
import { reactionEmojiKey, reactionEmojiValidation } from "../contracts/emoji.js";

export async function discordRoleSelection(
  context: BotContext,
): Promise<RoleSelectionService | null> {
  const { guild, store, environment } = context;
  if (!context.control.modules.reactions) return null;
  const choices = selectionChoices(context);
  const panel = rolePanel(context);
  if (!panel) return null;
  const channel = await guild.channels.fetch(panel.channelId);
  if (!channel?.isTextBased()) throw Error("Missing role channel");
  const message = await channel.messages.fetch(panel.id);
  if (message.author.id !== environment.clientId) throw Error("Role panel author differs");
  const me = await guild.members.fetchMe({ force: true });
  if (!me.permissions.has(P.ManageRoles)) throw Error("Role selection requires ManageRoles");
  for (const choice of choices) await message.react(choice.emoji);
  const service = new RoleSelectionService(
    store,
    { guild: guild.id, channel: channel.id, message: panel.id },
    {
      reactors: async (emoji) => {
        const current = await channel.messages.fetch({ message: panel.id, force: true });
        if (current.author.id !== environment.clientId) throw Error("Role panel author differs");
        const reaction = current.reactions.cache.find(
          (entry) =>
            !entry.emoji.id &&
            entry.emoji.name !== null &&
            reactionEmojiValidation(entry.emoji.name) === "valid" &&
            reactionEmojiKey(entry.emoji.name) === reactionEmojiKey(emoji),
        );
        if (!reaction) return [];
        const users: string[] = [];
        let after: string | undefined;
        for (let page = 0; page < 100; page++) {
          const batch = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
          for (const user of batch.values()) if (!user.bot) users.push(user.id);
          if (batch.size < 100) return users;
          const next = batch.lastKey();
          if (!next || next === after) throw Error("Reaction pagination did not advance");
          after = next;
        }
        throw Error("Role panel exceeds reconciliation limit");
      },
      apply: async (user, key, active) => {
        if (!choices.some((role) => role.key === key))
          throw Error("Role is outside the self-selection allowlist");
        let member;
        try {
          member = active
            ? await context.member(user)
            : await guild.members.fetch({ user, force: true });
        } catch (error) {
          if (
            errorCode(error) === "10007" ||
            (error instanceof Error && ["pending", "timeout"].includes(error.message))
          )
            return false;
          throw error;
        }
        if (member.user.bot) return false;
        const roles = await guild.roles.fetch();
        const role = roles.get(choices.find((choice) => choice.key === key)!.roleId);
        const bot = await guild.members.fetchMe({ force: true });
        if (
          !role ||
          role.managed ||
          role.permissions.bitfield !== 0n ||
          !bot.permissions.has(P.ManageRoles) ||
          bot.roles.highest.comparePositionTo(role) <= 0
        )
          throw Error("Self-selection role is not safe to manage");
        if (member.roles.cache.has(role.id) !== active) {
          if (active) await member.roles.add(role.id, "Wybór zainteresowań przez reakcję");
          else await member.roles.remove(role.id, "Cofnięcie reakcji zainteresowania");
        }
        return true;
      },
    },
    choices,
  );
  await service.reconcile();
  return service;
}
