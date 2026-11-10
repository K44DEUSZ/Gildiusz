export const reactionEmojiMaxLength = 64;
export type ReactionEmojiValidation = "valid" | "invalid" | "server_required";

const rgiEmoji = (() => {
  try {
    return new RegExp("^\\p{RGI_Emoji}$", "v");
  } catch {
    // Older browsers can still submit to the Node 24 validator instead of crashing on import.
    return null;
  }
})();

export function normalizeReactionEmoji(value: string): string {
  return value
    .replace(/\uFE0F/g, "")
    .replace(/(\p{Emoji})(?!\p{Emoji_Modifier})/gu, (point) =>
      /\p{Emoji_Presentation}/u.test(point) ? point : point + "\uFE0F",
    );
}

export function reactionEmojiValidation(value: unknown): ReactionEmojiValidation {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > reactionEmojiMaxLength ||
    value.trim() !== value ||
    /[\p{Cc}<>]/u.test(value)
  )
    return "invalid";
  const points = [...value];
  for (const [index, point] of points.entries()) {
    if (point !== "\uFE0F") continue;
    const previous = points[index - 1] ?? "";
    if (
      !/\p{Emoji}/u.test(previous) ||
      /[\p{Emoji_Modifier}\p{Regional_Indicator}]/u.test(previous)
    )
      return "invalid";
  }
  const bare = value.replace(/\uFE0F/g, "");
  if (/^\p{Emoji_Component}$/u.test(bare)) return "invalid";
  if (!rgiEmoji) return "server_required";
  return rgiEmoji.test(normalizeReactionEmoji(value)) ? "valid" : "invalid";
}

export function reactionEmojiKey(value: string): string {
  return value.replace(/\uFE0F/g, "");
}
