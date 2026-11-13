// ===================== ВРЕМЯ (всегда МСК, UTC+3, без перехода на летнее) =====================
export const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
export const MINUTE_MS = 60_000;
/** Названия дней недели по индексу Date.getUTCDay(): 0 = воскресенье. */
export const WEEKDAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
/** Порядок вывода: с понедельника. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
function pad(n) {
    return String(n).padStart(2, "0");
}
/** "2026-11-10" по МСК для момента времени. */
export function mskDateKey(ms) {
    const d = new Date(ms + MSK_OFFSET_MS);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function keyToUtcMidnight(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
}
export function addDaysToKey(dateKey, days) {
    const d = new Date(keyToUtcMidnight(dateKey) + days * 24 * 60 * MINUTE_MS);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** 0 = воскресенье ... 6 = суббота для даты «ГГГГ-ММ-ДД». */
export function weekdayOfKey(dateKey) {
    return new Date(keyToUtcMidnight(dateKey)).getUTCDay();
}
/** Момент (UTC ms) для даты «ГГГГ-ММ-ДД» и времени «ЧЧ:ММ» по МСК. */
export function mskToUtcMs(dateKey, time) {
    const [h, min] = time.split(":").map(Number);
    return keyToUtcMidnight(dateKey) + (h * 60 + min) * MINUTE_MS - MSK_OFFSET_MS;
}
/** "9:5", "09:00", "9.00" -> "09:00"; иначе null. */
export function parseTime(input) {
    const m = input.trim().match(/^(\d{1,2})[:.](\d{1,2})$/);
    if (!m)
        return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59)
        return null;
    return `${pad(h)}:${pad(min)}`;
}
/** "ДД.ММ.ГГГГ" или "ДД.ММ" (текущий год по МСК) -> "ГГГГ-ММ-ДД"; несуществующие даты отвергаются. */
export function parseDateInput(input, nowMs = Date.now()) {
    const m = input.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/);
    if (!m)
        return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = m[3] ? Number(m[3]) : Number(mskDateKey(nowMs).slice(0, 4));
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
        return null;
    return `${year}-${pad(month)}-${pad(day)}`;
}
/** "2026-11-10" -> "10.11.2026" */
export function formatDateKey(dateKey) {
    const [y, m, d] = dateKey.split("-");
    return `${d}.${m}.${y}`;
}
/** "10.11.2026 18:00" по МСК. */
export function formatDateTime(ms) {
    const key = mskDateKey(ms);
    const d = new Date(ms + MSK_OFFSET_MS);
    return `${formatDateKey(key)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** "вт, чт" -> [2, 4]. Понимает «пн вт ср…», «вторник», «все»/«ежедневно». null, если что-то не распознано. */
export function parseDays(input) {
    const tokens = input
        .toLowerCase()
        .split(/[\s,;/]+/)
        .filter(Boolean);
    if (!tokens.length)
        return null;
    const result = new Set();
    for (const token of tokens) {
        if (/^(все|всё|ежедневно|каждый|каждыйдень)$/.test(token)) {
            for (const d of WEEK_ORDER)
                result.add(d);
            continue;
        }
        const idx = WEEKDAY_SHORT.findIndex((s) => token.startsWith(s));
        if (idx === -1)
            return null;
        result.add(idx);
    }
    return WEEK_ORDER.filter((d) => result.has(d));
}
export function formatDays(days) {
    if (days.length === 7)
        return "каждый день";
    return WEEK_ORDER.filter((d) => days.includes(d))
        .map((d) => WEEKDAY_SHORT[d])
        .join(", ");
}
