import { reactionEmojiValidation, normalizeReactionEmoji } from "../../contracts/emoji.js";
import { digest } from "../../shared/utils.js";
import { rulesId, rulesKey } from "./policy.js";
import { RulesError, type RulesDraft } from "./types.js";

import { rulesLimits, rulesDraftMessages } from "../../contracts/server-rules.js";
export { rulesLimits } from "../../contracts/server-rules.js";
export function normalizeRulesDraft(value: RulesDraft): RulesDraft {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["channelId", "roleId", "label", "content", "method", "emoji"].includes(key),
    ) ||
    typeof value.label !== "string" ||
    !value.label.trim() ||
    value.label.length > rulesLimits.label ||
    /[\r\n\p{Cc}]/u.test(value.label) ||
    typeof value.content !== "string" ||
    !value.content.trim() ||
    value.content.length > rulesLimits.content ||
    value.content.includes("\0") ||
    !["button", "reaction"].includes(value.method)
  )
    throw new RulesError("invalid_input");
  if (
    value.method === "reaction" &&
    (typeof value.emoji !== "string" || reactionEmojiValidation(value.emoji) !== "valid")
  )
    throw new RulesError("invalid_input");
  if (value.method === "button" && value.emoji !== null) throw new RulesError("invalid_input");
  return {
    channelId: rulesId(value.channelId),
    roleId: rulesId(value.roleId),
    label: value.label.trim(),
    content: value.content.replace(/\r\n?/g, "\n"),
    method: value.method,
    emoji: value.method === "reaction" ? normalizeReactionEmoji(value.emoji!) : null,
  };
}
export function rulesControlId(guildId: string, versionId: string): string {
  rulesId(guildId);
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(rulesKey(versionId)))
    throw new RulesError("invalid_input");
  return `gildiusz:rules:${guildId}:${versionId}:accept`;
}
export function rulesParts(draft: RulesDraft, format: 1 | 2 = 2): string[] {
  try {
    return rulesDraftMessages(draft, format);
  } catch {
    throw new RulesError("invalid_input");
  }
}
export const rulesContentHash = (draft: RulesDraft): string => digest(draft);
