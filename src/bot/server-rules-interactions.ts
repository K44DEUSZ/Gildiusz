import { MessageFlags, type Interaction } from "discord.js";
import type { ServerRulesRuntime } from "./server-rules-runtime.js";
import { rulesAcceptanceText, serverRulesControlError } from "./server-rules-runtime.js";
import { ControlError } from "../contracts/configuration.js";

export async function serverRulesInteraction(
  runtime: ServerRulesRuntime,
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith("gildiusz:rules:")) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (
      interaction.guildId !== runtime.context.guild.id ||
      !interaction.channelId ||
      interaction.user.bot
    )
      throw new ControlError(403, "permission_revoked", "Nie możesz teraz wykonać tej czynności.");
    const acceptance = await runtime.button(
      interaction.user.id,
      interaction.channelId,
      interaction.message.id,
      interaction.customId,
    );
    await interaction.editReply({
      content: rulesAcceptanceText(acceptance),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    const known = serverRulesControlError(error);
    await interaction.editReply({
      content:
        known instanceof ControlError
          ? known.message
          : "Nie udało się teraz potwierdzić akceptacji. Spróbuj ponownie za chwilę.",
      allowedMentions: { parse: [] },
    });
  }
  return true;
}
