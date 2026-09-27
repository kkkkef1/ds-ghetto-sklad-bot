// ===================== CAPT REPORT PARSER =====================
//
// The relayed reports always look like a stack of "Label:" / value pairs.
// The current relay format doubles the colon and puts the value on the
// same line as the label, e.g.:
//
//   Мое зеркало:
//   @sthormmm
//   Дата и время:: 25.09.2026, 17:42:04
//   Номер забива:: 2026-25-9-5
//   Квадрат:: 54
//   Стороны:: 13x13
//   Время начала:: 18:11
//   Оружие:: на 11.43mm
//   Дополнительно:: алкоголь/анальгетики, косяки/SPANK
//   Атака:: `Bloods`
//   Защита:: `Marabunta Grande`
//
// (Атака/Защита also arrive wrapped in backticks — Discord inline-code
// formatting — which we strip off.) We match "one or more colons" after
// the label so both the old single-colon, own-line style and the current
// double-colon, same-line style work without needing two code paths.
//
// The source message is also edited in place once the capture resolves
// (the relay bot adds "Результат:"/"Статистика:" to the same message).
// We only care about the *first* post for a given capture — that edit is
// deliberately ignored (see listener.ts, which only handles
// Events.MessageCreate, never MessageUpdate). This parser just extracts
// whatever labelled fields are present; the caller decides what's
// mandatory.

import type { Embed, Message } from "discord.js";

const KNOWN_LABELS = [
  "Мое зеркало",
  "Дата и время",
  "Номер забива",
  "Квадрат",
  "Стороны",
  "Время начала",
  "Оружие",
  "Дополнительно",
  "Атака",
  "Защита",
  "Результат",
  "Статистика",
] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches "Label" followed by one or more colons, then optionally the
// value on the same line (group 1). Longer labels are tried first so a
// short label can't accidentally match a prefix of a longer one. A run of
// non-letter characters (emoji, symbols, extra spaces) is allowed before
// the label itself — the real relay decorates some lines with an emoji,
// e.g. "🗡Атака:: `Bloods`", and without this the label wouldn't be
// recognized at all (the whole report would silently fail to parse).
const LABEL_PATTERNS = [...KNOWN_LABELS]
  .sort((a, b) => b.length - a.length)
  .map((label) => ({
    label,
    regex: new RegExp(`^[^\\p{L}]*${escapeRegExp(label)}:+\\s*(.*)$`, "u"),
  }));

/**
 * Strips Discord decoration (inline-code backticks, bold/italic asterisks
 * or underscores, strikethrough tildes) and surrounding whitespace some
 * field values arrive wrapped in — the relay has been seen sending values
 * as plain `` `Bloods` ``, but also bolded as `` **`Bloods`** ``. Applied
 * to every captured field value (not just attacker/defender), so a stray
 * "**" never ends up baked into a stored value — e.g. as part of a faction
 * name, which would silently create a bogus extra faction bucket in the
 * day's tally instead of matching the real one.
 */
function stripMarkdown(value: string): string {
  let v = value.trim();
  // Peel decoration off both ends repeatedly — stacked markers like
  // "**`value`**" need more than one pass to fully unwrap.
  for (let i = 0; i < 3; i++) {
    const before = v;
    v = v.replace(/^[*_~`]+/, "").replace(/[*_~`]+$/, "").trim();
    if (v === before) break;
  }
  return v;
}

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
    if (currentLabel) fields[currentLabel] = stripMarkdown(buffer.join(" "));
    buffer = [];
  };

  for (const line of lines) {
    const match = LABEL_PATTERNS.find((p) => p.regex.test(line));
    if (match) {
      flush();
      currentLabel = match.label;
      const value = line.match(match.regex)![1];
      if (value) buffer.push(value);
      continue;
    }
    if (currentLabel) buffer.push(line);
  }
  flush();

  const attacker = fields["Атака"] ?? "";
  const defender = fields["Защита"] ?? "";
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

/** Parses a "ДД.ММ.ГГГГ" string (as typed into a slash command option) into a dayKey, or null if malformed. */
export function dayKeyFromDateString(input: string): string | null {
  const m = input.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

export function dayKeyFromDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
