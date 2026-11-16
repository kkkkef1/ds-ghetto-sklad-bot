// ===================== ТЕКСТ ОТЧЁТА В DISCORD =====================
//
// По каждому игроку — отдельный блок: что превышено, затем полная картина за период:
// сколько и чего взято со склада, что возвращено и что получено наборами.
// «Со склада» и «наборами» всегда разделены.

import type { CategoryLine, Suspect } from "./analyze.js";
import { describePeriod, type Period } from "./periods.js";

const MAX_MESSAGE = 1900;
/** Разделитель между фракциями: две жирные линии в конце отчёта по каждой фракции (28 знаков — не переносится на телефоне). */
export const FACTION_SEPARATOR = `${"━".repeat(28)}\n${"━".repeat(28)}`;
const MAX_ITEMS_SHOWN = 5;

/** «со склада» / «из машины BLOODS05»; для возврата — «на склад» / «в машину BLOODS05». */
export function placeLabel(place: string | undefined, direction: "take" | "put"): string {
  if (!place) return "";
  if (place === "набор") return "из наборов";
  if (place === "склад") return direction === "take" ? "со склада" : "на склад";
  return direction === "take" ? `из машины ${place}` : `в машину ${place}`;
}

function formatItems(items: CategoryLine["items"], direction: "take" | "put"): string {
  const shown = items.slice(0, MAX_ITEMS_SHOWN).map((it) => {
    const where = placeLabel(it.place, direction);
    return `${it.name} ×${it.quantity}${where ? ` ${where}` : ""}`;
  });
  return shown.join(", ") + (items.length > MAX_ITEMS_SHOWN ? `, … (+${items.length - MAX_ITEMS_SHOWN})` : "");
}

/**
 * «Оружие — 9 (AK-47 ×6 со склада, Carbine Rifle ×3 из машины BLOODS05)».
 * У патронов с одним названием само название не повторяем — остаётся только откуда взято.
 */
export function formatCategory(line: CategoryLine, direction: "take" | "put" = "take"): string {
  const kits = line.kitCount !== undefined ? `наборов: ${line.kitCount}` : "";
  let details: string;
  if (line.items.length === 1 && line.label.startsWith("Патроны")) {
    details = [placeLabel(line.items[0].place, direction), kits].filter(Boolean).join(", ");
  } else {
    details = [formatItems(line.items, direction), kits].filter(Boolean).join(", ");
  }
  return `${line.label} — ${line.total}${line.note ? ` ${line.note}` : ""}${details ? ` (${details})` : ""}`;
}

/**
 * Блок одного игрока.
 * Коротко (по умолчанию): только превышенное, возвраты уже вычтены, лимиты не пишем.
 *   Оружие — 14 (AK-47 ×9 со склада, Carbine Rifle ×5 из машины BLOODS05)
 * Подробно (/sklad detail): полная картина — взял, вернул, наборы, пороги.
 */
export function formatSuspect(s: Suspect, detailed = false): string {
  const lines: string[] = [`**${s.characterName}** [${s.characterId}]`];
  if (!detailed) {
    for (const e of s.exceeded) lines.push("category" in e ? formatCategory(e.category) : e.text);
    return lines.join("\n");
  }
  for (const reason of s.reasons) lines.push(`**Превышено:** ${reason}`);
  if (s.warehouse.length) {
    lines.push("**Взял со склада / из машин:**");
    for (const line of s.warehouse) lines.push(`  • ${formatCategory(line)}`);
  }
  if (s.returned.length) {
    lines.push("**Вернул на склад / в машины:**");
    for (const line of s.returned) lines.push(`  • ${formatCategory(line, "put")}`);
  }
  if (s.kits.length) {
    lines.push("**Взял наборами:**");
    for (const line of s.kits) lines.push(`  • ${formatCategory(line)}`);
  }
  if (s.kitIssues.length) {
    const shown = s.kitIssues.slice(0, MAX_ITEMS_SHOWN).map((k) => `${k.name} ×${k.times}`);
    lines.push(`**Выдач наборов:** ${shown.join(", ")}${s.kitIssues.length > MAX_ITEMS_SHOWN ? ", …" : ""}`);
  }
  return lines.join("\n");
}

/** Один отчёт по фракции: заголовок + блок на игрока. Режется на сообщения не длиннее лимита Discord. */
export function formatFactionReport(
  factionName: string,
  period: Period,
  suspects: Suspect[],
  detailed = false,
): string[] {
  const header = `## ${factionName}\nПодозрительные действия со складом за ${describePeriod(period)}`;
  const blocks = suspects.map((s) => formatSuspect(s, detailed));
  return chunk(header, blocks);
}

/** Фракция прочитана, подозрительных действий нет — так и пишем. */
export function formatNoSuspects(factionName: string, period: Period): string {
  return `## ${factionName}\nПодозрительных действий со складом за ${describePeriod(period)} нет.`;
}

/**
 * Склеивает отчёты фракций: между фракциями — две жирные линии, после последней текста нет, значит и линий нет.
 * Линии дописываются к последнему сообщению фракции, а если не помещаются в лимит Discord — идут отдельным.
 */
export function joinFactionBlocks(blocks: string[][]): string[] {
  const out: string[] = [];
  blocks.forEach((block, i) => {
    const isLast = i === blocks.length - 1;
    out.push(...block.slice(0, -1));
    const tail = block[block.length - 1];
    if (isLast) out.push(tail);
    else if (tail.length + 1 + FACTION_SEPARATOR.length > MAX_MESSAGE) out.push(tail, FACTION_SEPARATOR);
    else out.push(`${tail}\n${FACTION_SEPARATOR}`);
  });
  return out;
}

function chunk(header: string, blocks: string[]): string[] {
  const messages: string[] = [];
  let current = header;
  for (const raw of blocks) {
    // Один очень длинный блок не должен ломать лимит.
    const block = raw.length > MAX_MESSAGE - 60 ? raw.slice(0, MAX_MESSAGE - 63) + "…" : raw;
    if (current.length + 2 + block.length > MAX_MESSAGE) {
      messages.push(current);
      current = `## ${header.slice(3).replace("\n", " (продолжение)\n")}`;
    }
    current += `\n\n${block}`;
  }
  messages.push(current);
  return messages;
}
