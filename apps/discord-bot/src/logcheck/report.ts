// ===================== ТЕКСТ СВОДКИ =====================
//
//   **Сводка за 20.11.2026 с 00:00 по 23:59**
//
//   **Участие в ПВП-мероприятиях (война за ресурсы):**
//   > Bloods ........ 14
//
//   *Действия требующие внимания:*
//   > Bloods: 2
//   ```
//   <строки логов>
//   ```
//   > Families: чисто ✅

import { formatDateKey } from "../activity/time.js";

export interface Finding {
  /** Строка лога как на сайте («1452 Ник [ID] Bloods Увольняет … 20.11.2026, 21:34:09»). */
  line: string;
  /** Что сработало: «ЛОХ», «КРЫСА (спорное)». */
  marks: string;
  /** Для сортировки по времени. */
  time: number;
}

export interface FactionResult {
  /** Код фракции на сайте (F_GANG_BLOODS…): по нему копится история для недельной сводки. */
  code: string;
  /** Короткое имя для сводки: Bloods, Families, Marabunta. */
  name: string;
  /** Фракцию прочитать не удалось: причина (в канал она не идёт, только пометка «не удалось проверить»). */
  error?: string;
  /** Страницы кончились раньше, чем нашлось начало суток: данные могут быть неполными. */
  incomplete: boolean;
  rowsRead: number;
  pages: number;
  /** ВЗХ: сколько хаммеров фракция вывезла за сутки (число строк «вывозит хаммер…»). */
  hummers: number;
  /** Захват черного рынка: ID уникальных участников за сутки. */
  market: Set<string>;
  findings: Finding[];
  /** Событие («война за ресурсы») → ID вошедших персонажей (уникальные). */
  pvp: Map<string, Set<string>>;
}

const MESSAGE_LIMIT = 1900;
const BLOCK_LIMIT = 1700;
const MAX_LINES_PER_FACTION = 80;
const MAX_LINE_LENGTH = 400;

/** Короткие названия фракций для сводки. */
const SHORT_NAMES: Record<string, string> = {
  F_GANG_BLOODS: "Bloods",
  F_GANG_GROVE: "Families",
  F_GANG_MARABUNTA: "Marabunta",
  F_GANG_BALLAS: "Ballas",
  F_GANG_VAGOS: "Vagos",
};

export function shortFactionName(code: string, fallback: string): string {
  return SHORT_NAMES[code] ?? fallback;
}

export function dotted(name: string, width: number, value: string): string {
  const dots = ".".repeat(Math.max(3, width - name.length));
  return `${name} ${dots} ${value}`;
}

/** Блок ВЗХ: сколько хаммеров вывезла каждая фракция. */
export const HUMMER_TITLE = "ВЗХ — вывезено хаммеров";
/** Блок захвата черного рынка (раз в сутки): сколько игроков участвовало по фракциям. */
export const MARKET_TITLE = "Захват черного рынка — участвовало";

function pvpSections(results: FactionResult[]): string[] {
  const header = (event?: string) => `**Участие в ПВП-мероприятиях${event ? ` (${event})` : ""}:**`;
  const events = [...new Set(results.flatMap((r) => [...r.pvp.keys()]))].sort((a, b) => a.localeCompare(b, "ru"));
  const hasHummers = results.some((r) => !r.error && r.hummers > 0);
  const hasMarket = results.some((r) => !r.error && r.market.size > 0);
  const width = Math.max(...results.map((r) => r.name.length)) + 8;
  const sections: string[] = [];
  // «ПВП за сутки не было» относится к войнам и ВЗХ; захват черного рынка идёт отдельным блоком ниже.
  if (!events.length && !hasHummers) {
    const failed = results.filter((r) => r.error).map((r) => r.name);
    const lines = ["> ПВП за сутки не было"];
    if (failed.length) lines.push(`> ⚠️ нет данных: ${failed.join(", ")}`);
    sections.push([header(), ...lines].join("\n"));
  }
  sections.push(...events.map((event) => {
    const lines = results.map((r) => {
      if (r.error) return `> ${dotted(r.name, width, "⚠️ нет данных")}`;
      const count = r.pvp.get(event)?.size ?? 0;
      const tail = r.incomplete ? " ⚠️ данные неполные" : count === 0 ? " ⚠️" : "";
      return `> ${dotted(r.name, width, String(count))}${tail}`;
    });
    return [header(event), ...lines].join("\n");
  }));
  // ВЗХ: входов в логах нет, поэтому показываем число вывезенных хаммеров (вместо «ПВП за сутки не было»).
  if (hasHummers) {
    const lines = results.map((r) => {
      if (r.error) return `> ${dotted(r.name, width, "⚠️ нет данных")}`;
      const tail = r.incomplete ? " ⚠️ данные неполные" : r.hummers === 0 ? " ⚠️" : "";
      return `> ${dotted(r.name, width, String(r.hummers))}${tail}`;
    });
    sections.push([`**${HUMMER_TITLE}:**`, ...lines].join("\n"));
  }
  // Захват черного рынка: уникальные участники по фракциям.
  if (hasMarket) {
    const lines = results.map((r) => {
      if (r.error) return `> ${dotted(r.name, width, "⚠️ нет данных")}`;
      const tail = r.incomplete ? " ⚠️ данные неполные" : r.market.size === 0 ? " ⚠️" : "";
      return `> ${dotted(r.name, width, String(r.market.size))}${tail}`;
    });
    sections.push([`**${MARKET_TITLE}:**`, ...lines].join("\n"));
  }
  return sections;
}

function safeLine(text: string): string {
  const clean = text.replace(/```/g, "'''").replace(/\s+/g, " ").trim();
  return clean.length > MAX_LINE_LENGTH ? `${clean.slice(0, MAX_LINE_LENGTH - 1)}…` : clean;
}

/** Блок фракции в разделе «требующие внимания»; длинный разбивается на части, каждая — целый блок кода. */
function attentionBlocks(r: FactionResult): string[] {
  if (r.error) return [`> ${r.name}: ⚠️ не удалось проверить`];
  if (!r.findings.length) return [`> ${r.name}: ${r.incomplete ? "⚠️ данные неполные, нарушений в прочитанном нет" : "чисто ✅"}`];

  const sorted = [...r.findings].sort((a, b) => a.time - b.time);
  const lines = sorted.slice(0, MAX_LINES_PER_FACTION).map((f) => `${safeLine(f.line)}  ⟵ ${f.marks}`);
  if (sorted.length > lines.length) lines.push(`… и ещё ${sorted.length - lines.length}`);

  const blocks: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (!current.length) return;
    const head = blocks.length === 0 ? `> ${r.name}: ${r.findings.length}${r.incomplete ? " ⚠️ данные неполные" : ""}` : `> ${r.name} (продолжение)`;
    blocks.push(`${head}\n\`\`\`\n${current.join("\n")}\n\`\`\``);
    current = [];
    size = 0;
  };
  for (const line of lines) {
    if (size + line.length + 1 > BLOCK_LIMIT && current.length) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return blocks;
}

/** Сообщения сводки за сутки dateKey («2026-11-20»), каждое не длиннее лимита Discord. */
export function buildSummary(dateKey: string, results: FactionResult[]): string[] {
  const parts: { text: string; sep: string }[] = [];
  parts.push({ text: `**Сводка за ${formatDateKey(dateKey)} с 00:00 по 23:59**`, sep: "" });
  for (const section of pvpSections(results)) parts.push({ text: section, sep: "\n\n" });

  const attention = results.flatMap(attentionBlocks);
  parts.push({ text: `**Действия требующие внимания:**`, sep: "\n\n" });
  for (const block of attention) parts.push({ text: block, sep: "\n" });

  return chunkParts(parts);
}

/** Склеивает части в сообщения не длиннее лимита Discord; часть никогда не рвётся посередине. */
export function chunkParts(parts: { text: string; sep: string }[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.sep.length + part.text.length > MESSAGE_LIMIT) {
      messages.push(current);
      current = part.text;
    } else current += (current ? part.sep : "") + part.text;
  }
  if (current) messages.push(current);
  return messages;
}
