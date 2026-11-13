// ===================== ТЕКСТ ОТЧЁТА В DISCORD =====================
//
// По каждому игроку — отдельный блок: что превышено, затем полная картина за период:
// сколько и чего взято со склада, что возвращено и что получено наборами.
// «Со склада» и «наборами» всегда разделены.

import type { CategoryLine, Suspect } from "./analyze.js";
import { describePeriod, type Period } from "./periods.js";

const MAX_MESSAGE = 1900;
const MAX_ITEMS_SHOWN = 5;

function formatItems(items: CategoryLine["items"]): string {
  const shown = items.slice(0, MAX_ITEMS_SHOWN).map((it) => `${it.name} ×${it.quantity}`);
  return shown.join(", ") + (items.length > MAX_ITEMS_SHOWN ? `, … (+${items.length - MAX_ITEMS_SHOWN})` : "");
}

/** «Оружие — 9 (AK-47 ×6, Carbine Rifle ×3)»; у патронов с одним названием детали не повторяем. */
export function formatCategory(line: CategoryLine): string {
  const redundant = line.items.length === 1 && line.label.startsWith("Патроны");
  const kits = line.kitCount !== undefined ? `, наборов: ${line.kitCount}` : "";
  const details = redundant ? (kits ? ` (${kits.slice(2)})` : "") : ` (${formatItems(line.items)}${kits})`;
  return `${line.label} — ${line.total}${details}`;
}

/** Блок одного игрока. */
export function formatSuspect(s: Suspect): string {
  const lines: string[] = [`**${s.characterName}** [${s.characterId}]`];
  for (const reason of s.reasons) lines.push(`🚨 ${reason}`);
  if (s.warehouse.length) {
    lines.push("📤 **Взял со склада:**");
    for (const line of s.warehouse) lines.push(`  • ${formatCategory(line)}`);
  }
  if (s.returned.length) {
    lines.push("↩️ **Вернул на склад:**");
    for (const line of s.returned) lines.push(`  • ${formatCategory(line)}`);
  }
  if (s.kits.length) {
    lines.push("🎁 **Взял наборами:**");
    for (const line of s.kits) lines.push(`  • ${formatCategory(line)}`);
  }
  if (s.kitIssues.length) {
    const shown = s.kitIssues.slice(0, MAX_ITEMS_SHOWN).map((k) => `${k.name} ×${k.times}`);
    lines.push(`🔁 Выдач наборов: ${shown.join(", ")}${s.kitIssues.length > MAX_ITEMS_SHOWN ? ", …" : ""}`);
  }
  return lines.join("\n");
}

/** Один отчёт по фракции: заголовок + блок на игрока. Режется на сообщения не длиннее лимита Discord. */
export function formatFactionReport(
  factionName: string,
  period: Period,
  suspects: Suspect[],
  opts: { incomplete?: boolean } = {}
): string[] {
  const header = `**${factionName}** — подозрительные действия со складом за ${describePeriod(period)}`;
  const blocks = suspects.map(formatSuspect);
  if (opts.incomplete) {
    blocks.push("⚠️ Логи за период прочитаны не полностью (слишком много страниц) — список может быть неполным.");
  }
  return chunk(header, blocks);
}

function chunk(header: string, blocks: string[]): string[] {
  const messages: string[] = [];
  let current = header;
  for (const raw of blocks) {
    // Один очень длинный блок не должен ломать лимит.
    const block = raw.length > MAX_MESSAGE - 60 ? raw.slice(0, MAX_MESSAGE - 63) + "…" : raw;
    if (current.length + 2 + block.length > MAX_MESSAGE) {
      messages.push(current);
      current = `${header} (продолжение)`;
    }
    current += `\n\n${block}`;
  }
  messages.push(current);
  return messages;
}
