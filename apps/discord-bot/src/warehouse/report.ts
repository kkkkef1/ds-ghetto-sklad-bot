// ===================== ТЕКСТ ОТЧЁТА В DISCORD =====================

import type { Suspect } from "./analyze.js";
import { describePeriod, type Period } from "./periods.js";

const MAX_MESSAGE = 1900;

/** Один отчёт по фракции: заголовок + по строке на игрока. Режется на сообщения не длиннее лимита Discord. */
export function formatFactionReport(
  factionName: string,
  period: Period,
  suspects: Suspect[],
  opts: { incomplete?: boolean } = {}
): string[] {
  const header = `**${factionName}** — подозрительная выдача со склада за ${describePeriod(period)}`;
  const lines: string[] = [];
  for (const s of suspects) {
    lines.push(`• \`${s.characterName} [${s.characterId}]\` — ${s.reasons.join("; ")}`);
  }
  if (opts.incomplete) {
    lines.push("", "⚠️ Логи за период прочитаны не полностью (слишком много страниц) — список может быть неполным.");
  }
  return chunk(header, lines);
}

function chunk(header: string, lines: string[]): string[] {
  const messages: string[] = [];
  let current = header;
  for (const raw of lines) {
    // Одна очень длинная строка не должна ломать лимит.
    const line = raw.length > MAX_MESSAGE - 50 ? raw.slice(0, MAX_MESSAGE - 53) + "…" : raw;
    if (current.length + 1 + line.length > MAX_MESSAGE) {
      messages.push(current);
      current = `${header} (продолжение)`;
    }
    current += `\n${line}`;
  }
  messages.push(current);
  return messages;
}
