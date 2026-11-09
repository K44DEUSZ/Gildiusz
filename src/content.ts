import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { digest } from "./shared/utils.js";
import { roleChoices } from "./role-selection.js";

export function readContent(file: string): string {
  return readFileSync(join("content", file), "utf8").trim();
}
export function readJson<T>(file: string): T {
  return JSON.parse(readContent(file)) as T;
}

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

export function contentDigest(): string {
  return digest(
    filesIn("content")
      .sort()
      .map((file) => [file.replaceAll("\\", "/"), readFileSync(file, "utf8")]),
  );
}

export function render(text: string, config: Config): string {
  const rendered = text.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => {
    if (key === "brand.name") return config.brand.name;
    if (key === "brand.description") return config.brand.description;
    if (
      key.startsWith("channel.") &&
      config.channels.some((channel) => `channel.${channel.key}` === key)
    )
      return `<#@{${key}}>`;
    throw new Error(`Unknown content variable: ${key}`);
  });
  if (/\{\{|\}\}/.test(rendered)) throw new Error("Unresolved content variable.");
  return rendered;
}

export function lintContent(config: Config): string[] {
  const errors: string[] = [];
  for (const file of filesIn("content")) {
    const text = readFileSync(file, "utf8");
    if (/\{\{|\}\}/.test(text.replace(/\{\{[^{}]+\}\}/g, "")))
      errors.push(`${file}: malformed variable`);
    if (/[\u2013\u2014]/u.test(text)) errors.push(`${file}: forbidden punctuation`);
    for (const [, key] of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (key === "room.link" && file.endsWith("bot-messages.json")) continue;
      try {
        render(`{{${key}}}`, config);
      } catch {
        errors.push(`${file}: unknown variable ${key}`);
      }
    }
    for (const [, channel] of text.matchAll(/#([a-z][a-z-]{2,})/g)) {
      if (!config.channels.some((entry) => entry.name === channel))
        errors.push(`${file}: unknown channel ${channel}`);
    }
  }
  const rules = readJson<string[]>("rules.json");
  if (rules.length !== 10 || rules.some((rule) => rule.length > 300))
    errors.push("Rules Screening: verify 10 rules, each <= 300 characters.");
  return errors;
}

export function chunks(text: string, maximum = 1900): string[] {
  const result: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\n+/)) {
    if (paragraph.length > maximum)
      throw new Error("A content paragraph exceeds the message limit.");
    if ((current + "\n\n" + paragraph).length > maximum) {
      result.push(current);
      current = "";
    }
    current += (current ? "\n\n" : "") + paragraph;
  }
  if (current) result.push(current);
  return result;
}

export function publications(
  config: Config,
): { key: string; channel: string; text: string; pin: boolean }[] {
  const rules = readJson<string[]>("rules.json");
  const titles = [
    "Szacunek",
    "Pytania i opinie",
    "Własna praca",
    "Jasne warunki współpracy",
    "Bez nachalnych ofert",
    "Bez spamu",
    "Prywatność",
    "Bezpieczne treści",
    "Rozmowy głosowe",
    "Moderacja",
  ];
  const rulesText =
    "**📜 Zasady Kampusu**\nZanim zaczniesz pisać, przeczytaj te 10 zasad.\n\n" +
    rules.map((rule, index) => `**${index + 1} · ${titles[index]}:** ${rule}`).join("\n\n") +
    "\n\n**Potrzebujesz pomocy?** Użyj /zglos lub napisz do moderatora. Prywatnych danych nie publikuj na otwartym czacie.";
  const sources: [string, string, string][] = [
    ["start", "start", readContent("start.md")],
    ["room-help", "start", readContent("room-help.md")],
    [
      "roles",
      "start",
      "**🎭 Wybierz swoje role**\nKliknij reakcje pod tą wiadomością. Każda nadaje przypisaną rolę, a cofnięcie reakcji ją odbiera. Możesz wybrać kilka.\n\n" +
        roleChoices
          .map((choice) => {
            const role = config.roles.find((entry) => entry.key === choice.key);
            if (!role) throw Error(`Missing self-selection role: ${choice.key}`);
            return `${choice.emoji} · <@&@{role.${role.key}}>`;
          })
          .join("\n") +
        "\n\nTo role zainteresowań i współpracy. Akceptację zasad wykonujesz osobno w formularzu Discorda przy dołączaniu.",
    ],
    ["rules", "rules", rulesText],
    ["privacy", "rules", readContent("privacy-note.md")],
    ["introductions", "introductions", readContent("introductions.md")],
    ["general", "general", readContent("general.md")],
    ["help", "help", readContent("help.md")],
    ["offtopic", "offtopic", readContent("offtopic.md")],
    ["resources", "resources", readContent("resources.md")],
    ...Object.entries(readJson<Record<string, string>>("voice-notes.json")).map<
      [string, string, string]
    >(([key, text]) => [`voice-${key}`, key, text]),
  ];
  const seen = new Set<string>();
  return sources.flatMap(([key, channel, text]) =>
    chunks(render(text, config)).map((part, index) => {
      const prefix = seen.has(channel) ? "\u200b\n\n" : "";
      seen.add(channel);
      return {
        key: `message.${key}.${index}`,
        channel,
        text: prefix + part,
        pin: config.channels.find((entry) => entry.key === channel)?.kind !== "voice",
      };
    }),
  );
}
