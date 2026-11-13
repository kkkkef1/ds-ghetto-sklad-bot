// ===================== ЗАГРУЗКА ЛОГОВ ЗА ОКНО ВРЕМЕНИ =====================
//
// У сайта фильтр только по дням, а страница вмещает не больше 3000 строк (≈7–8 часов).
// Поэтому: запрашиваем логи начиная со вчерашнего дня, листаем страницы от новых к старым
// и останавливаемся, как только дошли до начала нужного окна. Лишнее отсекаем по времени.
import { parseSiteTime } from "./actions.js";
import { openResultPage, raiseRowCount, searchFactionLogs } from "./logsPage.js";
import { siteDateBefore } from "./periods.js";
const DEFAULT_MAX_PAGES = 60;
export async function fetchWindowRows(page, p) {
    const maxPages = p.maxPages ?? DEFAULT_MAX_PAGES;
    // После листания страница результата не содержит формы поиска — возвращаемся к форме.
    if ((await page.locator("#faction_logs_server_id").count()) === 0) {
        await page.goto(`${p.baseUrl}/logs?act=faction`, { waitUntil: "domcontentloaded" });
    }
    let first = await searchFactionLogs(page, {
        serverId: p.serverId,
        faction: p.faction,
        dateFrom: siteDateBefore(p.startMs),
    });
    if (await raiseRowCount(page, first)) {
        // Настройка поменялась — повторяем поиск, чтобы страницы стали по максимуму строк.
        first = await searchFactionLogs(page, { serverId: p.serverId, faction: p.faction, dateFrom: siteDateBefore(p.startMs) });
    }
    const seen = new Set();
    const rows = [];
    let pages = 0;
    let complete = false;
    let current = first;
    const pageSize = first.rows.length;
    for (let n = 1; n <= maxPages; n++) {
        pages = n;
        if (n > 1)
            current = await openResultPage(page, p.baseUrl, n);
        if (current.rows.length === 0) {
            complete = true; // логи за выбранные дни закончились
            break;
        }
        let oldest = Infinity;
        for (const row of current.rows) {
            const t = parseSiteTime(row.time);
            if (!Number.isFinite(t))
                continue;
            if (t < oldest)
                oldest = t;
            if (t >= p.startMs && t < p.endMs && !seen.has(row.id)) {
                seen.add(row.id);
                rows.push(row);
            }
        }
        if (oldest < p.startMs) {
            complete = true; // видели строки старше начала окна — всё нужное уже прочитано
            break;
        }
        if (current.rows.length < pageSize) {
            complete = true; // последняя страница короче первой — дальше ничего нет
            break;
        }
    }
    return { rows, pages, complete, total: first.total };
}
