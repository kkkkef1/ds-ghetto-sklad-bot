// ===================== ТЕКСТ СООБЩЕНИЙ В КАНАЛ =====================

import { MSK_OFFSET_MS } from "../activity/time.js";
import { FACTION_SEPARATOR } from "../warehouse/report.js";
import type { Finding, RunState } from "./store.js";

const LIMIT = 1800;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** «08:47» по МСК. */
export function hm(ms: number): string {
  const d = new Date(ms + MSK_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fmtDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h ? `${h} ч ${pad(min % 60)} мин` : `${min} мин`;
}

export interface Progress {
  done: number;
  total: number;
  percent: number;
  etaMs: number | null;
}

/** Сколько обработано (нажато + пропущено как повтор) и сколько осталось. */
export function progressOf(run: RunState): Progress {
  const known = run.factions.filter((f) => f.total !== null);
  const total = known.reduce((s, f) => s + (f.total ?? 0), 0);
  const done = known.reduce((s, f) => s + Math.min(f.done.length, f.total ?? 0), 0);
  const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  // Оценка по средней скорости на уже обработанных строках (с учётом пропущенных повторов).
  const etaMs = done > 20 && total > done ? ((total - done) * run.workMs) / done : null;
  return { done, total, percent, etaMs };
}

export function renderProgress(run: RunState, now: number): string {
  const p = progressOf(run);
  const countingLeft = run.factions.some((f) => f.total === null);
  const current = run.factions.findIndex((f) => !f.finished);
  const lines: string[] = [];
  if (run.status === "paused") lines.push("⏸ **Проверка твинков приостановлена**");
  else if (run.status === "queued") lines.push("⏳ **Проверка твинков ждёт очереди** (на сайте работает другая проверка)");
  else if (run.status === "stopping") lines.push("⏹ **Останавливаю проверку твинков…**");
  else lines.push("🔎 **Идёт проверка твинков**");

  if (run.status === "paused" && run.pauseReason) lines.push(`Причина: ${run.pauseReason}. Продолжить: \`/twink resume\`.`);
  if (current >= 0) lines.push(`Фракция: **${run.factions[current].name}** (${current + 1} из ${run.factions.length})`);
  lines.push(countingLeft ? "Считаю участников…" : `Прогресс: **${p.percent}%** (${p.done} из ${p.total})`);
  lines.push(`Найдено групп с нарушением: **${run.findings.length}**`);
  if (run.status === "running" && p.etaMs !== null) {
    lines.push(`Примерное окончание: **≈ ${hm(now + p.etaMs)} МСК** (осталось около ${fmtDuration(p.etaMs)})`);
  }
  if (run.publishAtMs) lines.push(`Результат должен быть к ${hm(run.publishAtMs)} МСК; будет опубликован здесь сразу по готовности.`);
  else lines.push("Результат будет опубликован здесь сразу по готовности.");
  return lines.join("\n");
}

/** Результат: по одному сообщению (или нескольким, если длинно) на фракцию. */
export function renderResults(findings: Finding[], factionNames: string[], codeBlock: boolean): string[] {
  const messages: string[] = [];
  for (const name of factionNames) {
    const items = findings.filter((f) => f.factionName === name);
    if (!items.length) continue;
    const title = `**${name}**`;
    const blocks = items.map((f) => f.offwarn.join("\n"));
    let chunk: string[] = [];
    let first = true;
    const flush = () => {
      if (!chunk.length) return;
      const body = chunk.join("\n");
      messages.push(`${first ? `${title}\n` : ""}${codeBlock ? `\`\`\`\n${body}\n\`\`\`` : body}`);
      first = false;
      chunk = [];
    };
    for (const block of blocks) {
      const next = [...chunk, block].join("\n");
      if (chunk.length && next.length + (first ? title.length : 0) + 12 > LIMIT) flush();
      chunk.push(block.slice(0, LIMIT - 40));
    }
    flush();
    // Две жирные линии после фракции — как в отчёте склада.
    messages[messages.length - 1] += `\n${FACTION_SEPARATOR}`;
  }
  return messages;
}
