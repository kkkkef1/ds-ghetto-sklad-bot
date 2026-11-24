// ===================== НЕДЕЛЬНАЯ СВОДКА ПО ПВП =====================
//
// Собирается из дневных итогов (только счётчики), которые бот копит при каждой дневной проверке: логи заново
// не читаются. Неделя = понедельник–воскресенье по МСК. Формат простой: блок на фракцию, в нём по строке на тип
// мероприятия: сколько стало за неделю и сколько было на прошлой.
//
//   **Недельная сводка за 16.11 – 22.11**
//
//   **Bloods**
//   > ПВП-войны: 29 участий (было 22) 📈
//   > ВЗХ: 10 хаммеров (было 3) 📈
//   > Черный рынок: 81 участие (было 63) 📈
//
//   -# 📈 / 📉 — изменение больше чем на четверть к прошлой неделе. «Участие» — один игрок на одном мероприятии.
//
// Если за какие-то сутки недели данных нет, складываются те сутки, что есть (внизу короткая пометка «Учтено суток: N из 7»).
// Стрелки 📈/📉 ставятся только когда сравнение честное: данных за обе недели поровну суток и мероприятий каждого типа поровну.
// Иначе «5 суток против 7» показало бы ложную просадку.

import { addDaysToKey, formatDateKey } from "../activity/time.js";
import { chunkParts, shortFactionName } from "./report.js";
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

/** Стрелка ставится при изменении больше чем на четверть и не меньше чем на несколько единиц (чтобы 1 → 2 не считалось «ростом»). */
const CHANGE_PCT = 25;

/** Понедельник недели, в которую входит дата. */
export function mondayOf(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = воскресенье
  return addDaysToKey(dateKey, -((weekday + 6) % 7));
}

const weekDays = (start: string): string[] => Array.from({ length: 7 }, (_, i) => addDaysToKey(start, i));

/** Склонение по числу: plural(2, ["участие", "участия", "участий"]) → «участия». */
function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

type Kind = "wars" | "hummers" | "market";

interface KindSpec {
  kind: Kind;
  title: string;
  forms: [string, string, string];
  /** Не меньше стольких единиц разницы для стрелки. */
  minAbs: number;
}

const KINDS: KindSpec[] = [
  { kind: "wars", title: "ПВП-войны", forms: ["участие", "участия", "участий"], minAbs: 3 },
  { kind: "hummers", title: "ВЗХ", forms: ["хаммер", "хаммера", "хаммеров"], minAbs: 2 },
  { kind: "market", title: "Черный рынок", forms: ["участие", "участия", "участий"], minAbs: 3 },
];

interface WeekAgg {
  /** Сколько суток недели есть в истории. */
  daysWithData: number;
  /** Сколько «мероприятий» каждого типа было (дни-события для войн, дни проведения для ВЗХ и рынка). */
  events: Record<Kind, number>;
  /** тип → код фракции → сумма за неделю по имеющимся суткам. */
  totals: Record<Kind, Map<string, number>>;
}

function aggregate(start: string, history: Readonly<Record<string, DayStats>>, factions: WeeklyFaction[]): WeekAgg {
  const agg: WeekAgg = {
    daysWithData: 0,
    events: { wars: 0, hummers: 0, market: 0 },
    totals: { wars: new Map(), hummers: new Map(), market: new Map() },
  };
  for (const f of factions) for (const kind of ["wars", "hummers", "market"] as Kind[]) agg.totals[kind].set(f.code, 0);

  for (const date of weekDays(start)) {
    const day = history[date];
    if (!day) continue;
    agg.daysWithData++;

    // Войны: событие-день на каждое мероприятие (в день бывает не больше нескольких), игроки суммируются по фракциям.
    const events = new Set<string>();
    for (const f of factions) for (const event of Object.keys(day[f.code]?.events ?? {})) events.add(event);
    agg.events.wars += events.size;
    for (const f of factions) {
      const sum = Object.values(day[f.code]?.events ?? {}).reduce((a, b) => a + b, 0);
      agg.totals.wars.set(f.code, (agg.totals.wars.get(f.code) ?? 0) + sum);
    }

    // ВЗХ и черный рынок: день проведения — когда хотя бы одна фракция дала число > 0.
    for (const [kind, field] of [["hummers", "hummers"], ["market", "market"]] as const) {
      if (!factions.some((f) => (day[f.code]?.[field] ?? 0) > 0)) continue;
      agg.events[kind]++;
      for (const f of factions) agg.totals[kind].set(f.code, (agg.totals[kind].get(f.code) ?? 0) + (day[f.code]?.[field] ?? 0));
    }
  }
  return agg;
}

function arrow(now: number, prev: number, minAbs: number): string {
  const diff = now - prev;
  if (Math.abs(diff) < minAbs) return "";
  if (prev === 0) return diff > 0 ? " 📈" : "";
  if ((Math.abs(diff) / prev) * 100 <= CHANGE_PCT) return "";
  return diff > 0 ? " 📈" : " 📉";
}

/** Сообщения недельной сводки за неделю, начинающуюся в понедельник weekStart («2026-11-16»). */
export function buildWeekly(weekStart: string, history: Readonly<Record<string, DayStats>>, factions: WeeklyFaction[]): WeeklyResult {
  const prevStart = addDaysToKey(weekStart, -7);
  const now = aggregate(weekStart, history, factions);
  const prev = aggregate(prevStart, history, factions);
  const short = (key: string) => formatDateKey(key).slice(0, 5);
  const title = `**Недельная сводка за ${short(weekStart)} – ${short(addDaysToKey(weekStart, 6))}**`;
  const done = (messages: string[]): WeeklyResult => ({ messages, daysWithData: now.daysWithData, prevDaysWithData: prev.daysWithData });

  if (now.daysWithData === 0) {
    return done([`${title}\n\nДанных за эту неделю нет: в эти дни бот не читал логи.`]);
  }

  // Типы, которые были хотя бы на одной из двух недель.
  const kinds = KINDS.filter((k) => now.events[k.kind] > 0 || prev.events[k.kind] > 0);
  if (!kinds.length) {
    const note = now.daysWithData < 7 ? `\n\nℹ️ Учтено суток: ${now.daysWithData} из 7.` : "";
    return done([`${title}\n\nПВП-мероприятий за неделю не было.${note}`]);
  }

  const hasPrev = prev.daysWithData > 0;
  const sameCoverage = now.daysWithData === prev.daysWithData;
  let arrowsSuppressed = false;

  const parts: { text: string; sep: string }[] = [{ text: title, sep: "" }];
  for (const f of factions) {
    const lines = kinds.map((k) => {
      const cur = now.totals[k.kind].get(f.code) ?? 0;
      const before = prev.totals[k.kind].get(f.code) ?? 0;
      const base = `${k.title}: ${cur} ${plural(cur, k.forms)}`;
      if (!hasPrev) return `> ${base}`;
      // Честное сравнение: суток данных и мероприятий этого типа поровну на обеих неделях.
      const comparable = sameCoverage && now.events[k.kind] === prev.events[k.kind];
      if (!comparable) arrowsSuppressed = true;
      return `> ${base} (было ${before})${comparable ? arrow(cur, before, k.minAbs) : ""}`;
    });
    parts.push({ text: [`**${shortFactionName(f.code, f.name)}**`, ...lines].join("\n"), sep: "\n\n" });
  }

  parts.push({ text: "-# 📈 / 📉 — изменение больше чем на четверть к прошлой неделе. «Участие» — один игрок на одном мероприятии.", sep: "\n\n" });
  const notes: string[] = [];
  if (now.daysWithData < 7) notes.push(`ℹ️ Учтено суток: ${now.daysWithData} из 7.`);
  if (!hasPrev) notes.push("ℹ️ Данных за прошлую неделю нет, сравнения нет.");
  else if (arrowsSuppressed) notes.push("ℹ️ Стрелки не ставились там, где неделя неполная или мероприятий было разное число.");
  if (notes.length) parts.push({ text: notes.join("\n"), sep: "\n" });

  return done(chunkParts(parts));
}
