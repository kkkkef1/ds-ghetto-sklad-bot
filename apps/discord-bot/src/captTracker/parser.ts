// ===================== CAPT REPORT PARSER =====================
//
// The relayed reports always look like a stack of "Label:" / value pairs,
// e.g.:
//
//   Дата и время:
//   23.09.2026, 19:30:16
//   Номер забива:
//   2026-23-9-5
//   ...
//   Атака:
//   Bloods
//   Защита:
//   Marabunta Grande
//
// We only care about the *first* post for a given capture (the seizure
// itself) — the later edit that adds "Результат:"/"Статистика:" once the
// capture finishes is deliberately ignored (see listener.ts). This parser
// just extracts whatever labelled fields are present; the caller decides
// what's mandatory.

import type { Embed, Message } from "discord.js";

const KNOWN_LABELS = [
  "Дата и время:",
  "Номер забива:",
  "Квадрат:",
  "Стороны:",
  "Время начала:",
  "Оружие:",
  "Дополнительно:",
  "Атака:",
  "Защита:",
  "Результат:",
  "Статистика:",
] as const;

export interface ParsedCaptMessage {
  fields: Record<string, string>;
  dateTime: string | null;
  captNumber: string | null;
  attacker: string;
  defender: string;
}

/**
 * Flattens a message's plain content and any embeds into one block of text
 * so the same line-scanning parser below works whether the relay sends
 * these reports as plain text or as embeds.
 */
export function extractFullText(message: Pick<Message, "content" | "embeds">): string {
  const parts: string[] = [];
  if (message.content?.trim()) parts.push(message.content);
  for (const embed of message.embeds as Embed[]) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields ?? []) {
      parts.push(field.name);
      parts.push(field.value);
    }
  }
  return parts.join("\n");
}

/**
 * Parses the labelled-field text into a map, then returns a typed result
 * only if the minimum fields we need (Атака/Защита) are present. Returns
 * null for anything that isn't a recognizable capt report — e.g. some
 * unrelated message posted in the same channel.
 */
export function parseCaptMessage(text: string): ParsedCaptMessage | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const fields: Record<string, string> = {};
  let currentLabel: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentLabel) fields[currentLabel] = buffer.join(" ").trim();
    buffer = [];
  };

  for (const line of lines) {
    const exactLabel = KNOWN_LABELS.find((l) => l === line);
    if (exactLabel) {
      flush();
      currentLabel = exactLabel.slice(0, -1); // drop trailing ":"
      continue;
    }
    // Also accept "Label: value" on a single line, in case the relay
    // collapses label and value onto one line instead of two.
    const inlineLabel = KNOWN_LABELS.find((l) => line.startsWith(l) && line.length > l.length);
    if (inlineLabel) {
      flush();
      currentLabel = inlineLabel.slice(0, -1);
      buffer.push(line.slice(inlineLabel.length).trim());
      continue;
    }
    if (currentLabel) buffer.push(line);
  }
  flush();

  const attacker = fields["Атака"]?.trim();
  const defender = fields["Защита"]?.trim();
  if (!attacker || !defender) return null;

  return {
    fields,
    dateTime: fields["Дата и время"] ?? null,
    captNumber: fields["Номер забива"] ?? null,
    attacker,
    defender,
  };
}

/**
 * Derives the "day" a capture belongs to from the report's own
 * "Дата и время" field (DD.MM.YYYY, ...) rather than the bot's wall clock,
 * since that's the timestamp that actually matters for the 00:00–23:59
 * rule. Falls back to the Discord message's own timestamp if the field is
 * missing or unparseable.
 */
export function dayKeyFromDateTime(dateTime: string | null, fallback: Date): string {
  if (dateTime) {
    const m = dateTime.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) {
      const [, dd, mm, yyyy] = m;
      return `${yyyy}-${mm}-${dd}`;
    }
  }
  return dayKeyFromDate(fallback);
}

export function dayKeyFromDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
