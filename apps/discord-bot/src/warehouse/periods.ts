// ===================== РАСЧЁТНЫЕ ПЕРИОДЫ =====================
//
// Сутки по МСК делятся на 4 периода по 6 часов: 00–06, 06–12, 12–18, 18–24.
// Проверка периода запускается сразу после его окончания.

import { MINUTE_MS, MSK_OFFSET_MS, formatDateKey, mskDateKey } from "../activity/time.js";

export const PERIOD_HOURS = 6;
export const PERIOD_MS = PERIOD_HOURS * 60 * MINUTE_MS;

export interface Period {
  /** «2026-11-12-18»: дата и час окончания периода по МСК (00 — конец суток). */
  key: string;
  /** Начало (включительно) и конец (исключительно), UTC ms. */
  startMs: number;
  endMs: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function periodEndingAt(endMs: number): Period {
  const d = new Date(endMs + MSK_OFFSET_MS);
  return { key: `${mskDateKey(endMs)}-${pad(d.getUTCHours())}`, startMs: endMs - PERIOD_MS, endMs };
}

/** Последний уже закончившийся период на момент nowMs. */
export function lastCompletedPeriod(nowMs: number): Period {
  const boundary = Math.floor((nowMs + MSK_OFFSET_MS) / PERIOD_MS) * PERIOD_MS - MSK_OFFSET_MS;
  return periodEndingAt(boundary);
}

/**
 * Режет окно [startMs, endMs) по границам 6-часовых периодов (00/06/12/18 МСК).
 * Пороги настроены на период 6 часов, поэтому длинное окно проверяется по частям.
 * Для обычного периода возвращается он же.
 */
export function splitIntoPeriods(startMs: number, endMs: number): Period[] {
  const result: Period[] = [];
  let from = startMs;
  while (from < endMs) {
    const boundary = Math.floor((from + MSK_OFFSET_MS) / PERIOD_MS) * PERIOD_MS - MSK_OFFSET_MS + PERIOD_MS;
    const to = Math.min(boundary, endMs);
    result.push({ key: periodEndingAt(boundary).key, startMs: from, endMs: to });
    from = to;
  }
  return result;
}

/** «12.11.2026 12:00–18:00 МСК» */
export function describePeriod(p: { startMs: number; endMs: number }): string {
  const s = new Date(p.startMs + MSK_OFFSET_MS);
  const e = new Date(p.endMs + MSK_OFFSET_MS);
  const hm = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const sameDay = mskDateKey(p.startMs) === mskDateKey(p.endMs - 1);
  const startPart = `${formatDateKey(mskDateKey(p.startMs))} ${hm(s)}`;
  const endPart = sameDay ? hm(e) : `${formatDateKey(mskDateKey(p.endMs))} ${hm(e)}`;
  return `${startPart}–${endPart} МСК`;
}

/** Дата «дд/мм/гггг» для фильтра сайта: день, предшествующий началу окна (сам «сегодня» сайт отдаёт пустым). */
export function siteDateBefore(startMs: number): string {
  const prev = mskDateKey(startMs - 24 * 60 * MINUTE_MS);
  const [y, m, d] = prev.split("-");
  return `${d}/${m}/${y}`;
}
