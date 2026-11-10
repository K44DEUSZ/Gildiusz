import { ControlError } from "./configuration.js";
import { normalizeReactionEmoji } from "./emoji.js";

export type RulesMethod = "button" | "reaction";
export interface RulesDraft {
  channelId: string;
  roleId: string;
  label: string;
  content: string;
  method: RulesMethod;
  emoji: string | null;
}
export interface RulesSettings {
  guildId: string;
  revision: number;
  generation: number;
  enabled: boolean;
  draft: RulesDraft | null;
  activeVersionId: string | null;
}
export interface RulesVersion extends RulesDraft {
  id: string;
  guildId: string;
  generation: number;
  contentHash: string;
  state: "publishing" | "active" | "retired";
  createdAt: number;
  createdBy: string;
}
export interface RulesPart {
  versionId: string;
  index: number;
  content: string;
  contentHash: string;
  jobId: string;
  messageId: string | null;
  state: "pending" | "sending" | "unverified" | "confirmed";
  reactionJobId: string | null;
  reactionState: "not_required" | "pending" | "sending" | "confirmed" | "unknown";
}
export type RulesGrantState =
  "pending" | "sending" | "confirmed" | "already_present" | "unknown" | "blocked";
export interface RulesAcceptance {
  id: string;
  guildId: string;
  userId: string;
  joinedAt: number;
  versionId: string;
  roleId: string;
  acceptedAt: number;
  source: "button" | "reaction" | "reaction_reconcile";
  grantState: RulesGrantState;
  jobId: string | null;
  confirmedAt: number | null;
  reason: string | null;
}
export type RulesVersionWithParts = RulesVersion & { parts: RulesPart[] };
export interface RulesOverview {
  settings: RulesSettings;
  /** The transport returns at most the five latest versions. */
  versions: RulesVersionWithParts[];
}
export interface RulesConfigureInput {
  revision: number;
  enabled: boolean;
  draft: RulesDraft | null;
}
export interface RulesConfigureResult {
  settings: RulesSettings;
}
export interface RulesPublishInput {
  revision: number;
}
export interface RulesPublishResult {
  version: RulesVersion;
  settings: RulesSettings;
  parts: RulesPart[];
}
export type RulesReconcileResult = RulesPublishResult;
export interface RulesAcceptanceCursor {
  acceptedAt: number;
  id: string;
}
export interface RulesAcceptancesInput {
  limit?: number;
  before?: RulesAcceptanceCursor;
}
export interface RulesAcceptancePage {
  acceptances: RulesAcceptance[];
  nextCursor: RulesAcceptanceCursor | null;
}

export const rulesLimits = Object.freeze({ content: 12000, label: 80, part: 1800, parts: 8 });

function messageBoundary(text: string, maximum: number, format: 1 | 2): number {
  let end = Math.min(maximum, text.length);
  if (format === 1) {
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    return end;
  }
  if (end === text.length) return end;
  const minimum = Math.ceil(end * 0.9),
    paragraph = text.lastIndexOf("\n\n", end - 2),
    line = text.lastIndexOf("\n", end - 1);
  if (paragraph >= minimum) end = paragraph + 2;
  else if (line >= minimum) end = line + 1;
  else {
    const whitespace = [...text.slice(0, end).matchAll(/\s/gu)].at(-1);
    if (whitespace && whitespace.index >= minimum) end = whitespace.index + 1;
  }
  let boundary = 0;
  for (const part of new Intl.Segmenter("pl", { granularity: "grapheme" }).segment(text)) {
    const next = part.index + part.segment.length;
    if (next > end) break;
    boundary = next;
  }
  if (!boundary)
    throw new ControlError(400, "invalid_input", "Fragment regulaminu jest zbyt długi.");
  return boundary;
}

/** Presentation only; the backend still validates the draft and its current channel/role. */
export function rulesDraftMessages(draft: RulesDraft, format: 1 | 2 = 2): string[] {
  if (
    ![1, 2].includes(format) ||
    !draft ||
    typeof draft.label !== "string" ||
    draft.label.length > rulesLimits.label ||
    typeof draft.content !== "string" ||
    draft.content.length > rulesLimits.content ||
    !["button", "reaction"].includes(draft.method) ||
    (draft.method === "reaction" &&
      (typeof draft.emoji !== "string" || !draft.emoji.length || draft.emoji.length > 64))
  )
    throw new ControlError(400, "invalid_input", "Sprawdź treść i metodę akceptacji regulaminu.");
  const chunks: string[] = [];
  const instruction =
    draft.method === "button"
      ? "Przeczytaj zasady. Jeśli się zgadzasz, wybierz „Akceptuję regulamin”."
      : `Przeczytaj zasady. Jeśli się zgadzasz, dodaj reakcję ${normalizeReactionEmoji(draft.emoji!)}.`;
  const prefix = `**Regulamin serwera · ${draft.label.trim()}**\n\n`;
  const maximum = Math.min(rulesLimits.part, 2000 - prefix.length - instruction.length - 2);
  let remainder = draft.content.replace(/\r\n?/g, "\n");
  while (remainder) {
    const end = messageBoundary(remainder, maximum, format);
    chunks.push(remainder.slice(0, end));
    remainder = remainder.slice(end);
  }
  if (chunks.length > rulesLimits.parts)
    throw new ControlError(400, "invalid_input", "Regulamin wymaga zbyt wielu wiadomości.");
  return chunks.map((chunk, index) => {
    const final = index === chunks.length - 1;
    const content = `${prefix}${chunk}${final ? `\n\n${instruction}` : ""}`;
    if (content.length > 2000)
      throw new ControlError(400, "invalid_input", "Wiadomość regulaminu jest zbyt długa.");
    return content;
  });
}
