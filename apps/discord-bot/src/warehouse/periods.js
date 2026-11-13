// ===================== РАСЧЁТНЫЕ ПЕРИОДЫ =====================
//
// Периоды задаются расписанием (/sklad schedule): список границ в течение суток по МСК.
// По умолчанию 00:00, 06:00, 12:00, 18:00 — то есть 4 периода по 6 часов.
// Период — это отрезок между двумя соседними границами; проверка запускается
// сразу после его окончания.
import { MINUTE_MS, MSK_OFFSET_MS, formatDateKey, mskDateKey } from "../activity/time.js";
import { getSchedule } from "./store.js";
const DAY_MS = 24 * 60 * MINUTE_MS;
function pad(n) {
    return String(n).padStart(2, "0");
}
/** Начало суток по МСК (UTC ms) для момента ms. */
function mskDayStart(ms) {
    return Math.floor((ms + MSK_OFFSET_MS) / DAY_MS) * DAY_MS - MSK_OFFSET_MS;
}
/** Все границы расписания в окрестности момента: вчера, сегодня, завтра — по возрастанию. */
function boundariesNear(ms) {
    const day = mskDayStart(ms);
    const schedule = getSchedule();
    const result = [];
    for (const shift of [-1, 0, 1])
        for (const m of schedule)
            result.push(day + shift * DAY_MS + m * MINUTE_MS);
    return result;
}
/** Ближайшая граница не позже ms. */
export function boundaryAtOrBefore(ms) {
    let best = -Infinity;
    for (const b of boundariesNear(ms))
        if (b <= ms && b > best)
            best = b;
    return best;
}
/** Ближайшая граница строго позже ms. */
export function boundaryAfter(ms) {
    let best = Infinity;
    for (const b of boundariesNear(ms))
        if (b > ms && b < best)
            best = b;
    return best;
}
function boundaryBefore(ms) {
    return boundaryAtOrBefore(ms - 1);
}
function keyFor(endMs) {
    const d = new Date(endMs + MSK_OFFSET_MS);
    const hh = pad(d.getUTCHours());
    const mm = d.getUTCMinutes();
    return `${mskDateKey(endMs)}-${hh}${mm ? pad(mm) : ""}`;
}
export function periodEndingAt(endMs) {
    return { key: keyFor(endMs), startMs: boundaryBefore(endMs), endMs };
}
/** Последний уже закончившийся период на момент nowMs. */
export function lastCompletedPeriod(nowMs) {
    return periodEndingAt(boundaryAtOrBefore(nowMs));
}
/**
 * Режет окно [startMs, endMs) по границам расписания.
 * Пороги настроены на один период, поэтому длинное окно проверяется по частям.
 * Для обычного периода возвращается он же.
 */
export function splitIntoPeriods(startMs, endMs) {
    const result = [];
    let from = startMs;
    while (from < endMs) {
        const boundary = boundaryAfter(from);
        const to = Math.min(boundary, endMs);
        result.push({ key: keyFor(boundary), startMs: from, endMs: to });
        from = to;
    }
    return result;
}
/** «00:00, 06:00, 12:00, 18:00» */
export function formatSchedule(minutes) {
    return minutes.map((m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`).join(", ");
}
/** «12.11.2026 12:00–18:00 МСК» */
export function describePeriod(p) {
    const s = new Date(p.startMs + MSK_OFFSET_MS);
    const e = new Date(p.endMs + MSK_OFFSET_MS);
    const hm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    const sameDay = mskDateKey(p.startMs) === mskDateKey(p.endMs - 1);
    const startPart = `${formatDateKey(mskDateKey(p.startMs))} ${hm(s)}`;
    const endPart = sameDay ? hm(e) : `${formatDateKey(mskDateKey(p.endMs))} ${hm(e)}`;
    return `${startPart}–${endPart} МСК`;
}
/** Дата «дд/мм/гггг» для фильтра сайта: день, предшествующий началу окна (сам «сегодня» сайт отдаёт пустым). */
export function siteDateBefore(startMs) {
    const prev = mskDateKey(startMs - 24 * 60 * MINUTE_MS);
    const [y, m, d] = prev.split("-");
    return `${d}/${m}/${y}`;
}
