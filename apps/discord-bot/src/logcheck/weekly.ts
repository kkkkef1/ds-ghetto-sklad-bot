// ===================== НЕДЕЛЬНАЯ СВОДКА ПО ПВП =====================
//
// Собирается из дневных итогов (только счётчики), которые бот копит при каждой дневной проверке: логи заново
// не читаются. Неделя = понедельник–воскресенье по МСК. Для каждой фракции считаются участия по дням, итог за
// неделю и динамика к прошлой неделе (по среднему на одно ПВП-мероприятие, чтобы неделя с двумя мероприятиями
// честно сравнивалась с неделей с одним).
//
//   **Недельная сводка за 16.11.2026 – 22.11.2026**
//
//   **18.11 (ср), война за ресурсы:**
//   > Bloods ........ 14
//
//   **Итого за неделю (сравнение с 09.11.2026 – 15.11.2026):**
//   > Bloods ........ 34 (ср. 17) ▲ +21% 📈
//
//   **Динамика:**
//   > 📈 Растут: Bloods (+21%)

import { WEEKDAY_SHORT, addDaysToKey, formatDateKey, weekdayOfKey } from "../activity/time.js";
import { chunkParts, dotted, shortFactionName } from "./report.js";
import type { DayStats } from "./store.js";

export interface WeeklyFaction {
  code: string;
  name: string;
}

export interface WeeklyResult {
  messages: string[];
  /** За сколько суток недели есть данные (из 7). */
  daysWithData: number;
  prevDaysWithData: number;
}

/** Порог «заметного» изменения: не меньше 25% и не меньше 3 участников в среднем на мероприятие. */
const CHANGE_PCT = 25;
const CHANGE_ABS = 3;

/** Понедельник недели, в которую входит дата. */
export function mondayOf(dateKey: string): string {
  return addDaysToKey(dateKey, -((weekdayOfKey(dateKey) + 6) % 7));
}

const weekDays = (start: string): string[] => Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));

interface EventDay {
  date: string;
  event: string;
  /** код фракции → число игроков; null — по этой фракции в тот день нет данных. */
  counts: Map<string, number | null>;
}

interface WeekAgg {
  eventDays: EventDay[];
  daysWithData: number;
  /** missing — хотя бы за один день с ПВП по фракции нет данных (например, её не удалось прочитать). */
  perFaction: Map<string, { total: number; avg: number; missing: boolean }>;
}

function aggregate(start: string, history: Readonly<Record<string, DayStats>>, factions: WeeklyFaction[]): WeekAgg {
  const eventDays: EventDay[] = [];
  let daysWithData = 0;
  for (const date of weekDays(start)) {
    const day = history[date];
    if (!day) continue;
    daysWithData++;
    const events = new Set<string>();
    for (const f of factions) for (const event of Object.keys(day[f.code]?.events ?? {})) events.add(event);
    for (const event of [...events].sort((a, b) => a.localeCompare(b, "ru"))) {
      eventDays.push({ date, event, counts: new Map(factions.map((f) => [f.code, day[f.code] ? (day[f.code].events[event] ?? 0) : null])) });
    }
  }
  const perFaction = new Map<string, { total: number; avg: number; missing: boolean }>();
  for (const f of factions) {
    const total = eventDays.reduce((sum, d) => sum + (d.counts.get(f.code) ?? 0), 0);
    perFaction.set(f.code, {
      total,
      avg: eventDays.length ? total / eventDays.length : 0,
      missing: eventDays.some((d) => d.counts.get(f.code) === null),
    });
  }
  return { eventDays, daysWithData, perFaction };
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""));

type Trend = { kind: "up" | "down" | "flat" | "new" | "none"; pct?: number };

function trendOf(now: number, prev: number | null): Trend {
  if (prev === null) return { kind: "none" };
  if (prev === 0) return now >= CHANGE_ABS ? { kind: "new" } : { kind: "flat" };
  const pct = Math.round(((now - prev) / prev) * 100);
  if (Math.abs(now - prev) >= CHANGE_ABS && Math.abs(pct) >= CHANGE_PCT) return { kind: pct > 0 ? "up" : "down", pct };
  return { kind: "flat", pct };
}

const signed = (pct: number): string => `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;

/** Сообщения недельной сводки за неделю, начинающуюся в понедельник weekStart («2026-11-16»). */
export function buildWeekly(weekStart: string, history: Readonly<Record<string, DayStats>>, factions: WeeklyFaction[]): WeeklyResult {
  const prevStart = addDaysToKey(weekStart, -7);
  const now = aggregate(weekStart, history, factions);
  const prev = aggregate(prevStart, history, factions);
  const names = new Map(factions.map((f) => [f.code, shortFactionName(f.code, f.name)]));
  const width = Math.max(...[...names.values()].map((n) => n.length)) + 8;
  const range = (start: string) => `${formatDateKey(start)} – ${formatDateKey(addDaysToKey(start, 6))}`;

  const parts: { text: string; sep: string }[] = [{ text: `**Недельная сводка за ${range(weekStart)}**`, sep: "" }];
  let noPrevNote = "";

  if (!now.eventDays.length) {
    parts.push({ text: `**Участие в ПВП-мероприятиях по дням:**\n> ПВП за неделю не было${now.daysWithData ? "" : " (данных за эту неделю нет)"}`, sep: "\n\n" });
  } else {
    for (const d of now.eventDays) {
      const lines = factions.map((f) => {
        const count = d.counts.get(f.code);
        const name = names.get(f.code)!;
        if (count === null || count === undefined) return `> ${dotted(name, width, "⚠️ нет данных")}`;
        return `> ${dotted(name, width, String(count))}${count === 0 ? " ⚠️" : ""}`;
      });
      const wd = WEEKDAY_SHORT[weekdayOfKey(d.date)];
      parts.push({ text: [`**${formatDateKey(d.date).slice(0, 5)} (${wd}), ${d.event}:**`, ...lines].join("\n"), sep: "\n\n" });
    }

    // Итого и динамика
    const prevComparable = prev.eventDays.length > 0;
    const trends = new Map<string, Trend>();
    const totalLines = factions.map((f) => {
      const cur = now.perFaction.get(f.code)!;
      const old = prevComparable ? prev.perFaction.get(f.code)!.avg : null;
      const trend = trendOf(cur.avg, old);
      trends.set(f.code, trend);
      const name = names.get(f.code)!;
      const base = `${fmt(cur.total)} (ср. ${fmt(cur.avg)})${cur.missing ? " ⚠️ есть дни без данных" : ""}`;
      const tail =
        trend.kind === "up" ? ` ▲ ${signed(trend.pct!)} 📈`
        : trend.kind === "down" ? ` ▼ ${signed(trend.pct!)} 📉`
        : trend.kind === "new" ? " ▲ в прошлую неделю ПВП у фракции не было 📈"
        : trend.kind === "flat" && trend.pct !== undefined ? ` ≈ ${signed(trend.pct)}`
        : "";
      return `> ${dotted(name, width, base + tail)}`;
    });
    const heading = prevComparable ? `**Итого за неделю (сравнение с ${range(prevStart)}):**` : "**Итого за неделю:**";
    parts.push({ text: [heading, ...totalLines].join("\n"), sep: "\n\n" });
    if (!prevComparable) {
      noPrevNote = prev.daysWithData
        ? `ℹ️ Динамики нет: на прошлой неделе (${range(prevStart)}) ПВП не было.`
        : `ℹ️ Динамики нет: данных за прошлую неделю (${range(prevStart)}) нет.`;
    }

    const up = factions.filter((f) => ["up", "new"].includes(trends.get(f.code)!.kind));
    const down = factions.filter((f) => trends.get(f.code)!.kind === "down");
    const never = factions.filter((f) => now.perFaction.get(f.code)!.total === 0 && !now.perFaction.get(f.code)!.missing);
    const label = (f: WeeklyFaction) => {
      const t = trends.get(f.code)!;
      return `${names.get(f.code)}${t.pct !== undefined && t.kind !== "new" ? ` (${signed(t.pct)})` : ""}`;
    };
    const dynamics: string[] = [];
    if (prevComparable) {
      if (up.length) dynamics.push(`> 📈 Растут: ${up.map(label).join(", ")}`);
      if (down.length) dynamics.push(`> 📉 Просели: ${down.map(label).join(", ")}`);
      if (!up.length && !down.length) dynamics.push("> Без заметных изменений");
    }
    if (never.length) dynamics.push(`> ⚠️ Не участвовали ни в одном ПВП: ${never.map((f) => names.get(f.code)).join(", ")}`);
    if (dynamics.length) parts.push({ text: ["**Динамика:**", ...dynamics].join("\n"), sep: "\n\n" });
  }

  const notes: string[] = noPrevNote ? [noPrevNote] : [];
  if (now.daysWithData < 7) notes.push(`⚠️ Данные есть за ${now.daysWithData} из 7 суток этой недели: недостающие сутки бот не читал.`);
  if (now.eventDays.length && prev.eventDays.length && prev.daysWithData < 7) notes.push(`⚠️ Прошлая неделя неполная: данные за ${prev.daysWithData} из 7 суток, динамика примерная.`);
  if (notes.length) parts.push({ text: notes.join("\n"), sep: "\n\n" });

  return { messages: chunkParts(parts), daysWithData: now.daysWithData, prevDaysWithData: prev.daysWithData };
}
