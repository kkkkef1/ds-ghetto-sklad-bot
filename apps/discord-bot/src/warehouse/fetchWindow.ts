// ===================== ЗАГРУЗКА ЛОГОВ ЗА ОКНО ВРЕМЕНИ =====================
//
// У сайта фильтр только по дням, а страница вмещает не больше 3000 строк (≈7–8 часов).
// Поэтому: запрашиваем логи начиная со вчерашнего дня, листаем страницы от новых к старым
// и останавливаемся, как только дошли до начала нужного окна. Лишнее отсекаем по времени.

import type { Page } from "playwright";
import { parseSiteTime } from "./actions.js";
import { describeDateInput, openResultPage, raiseRowCount, searchFactionLogs, type LogRow, type SearchResult } from "./logsPage.js";
import { siteDateBefore } from "./periods.js";

export interface WindowFetchParams {
  baseUrl: string;
  serverId: string;
  faction: string;
  startMs: number;
  endMs: number;
  /** Защита от бесконечного листания. 3000 строк × 60 страниц — это уже несколько суток. */
  maxPages?: number;
}

export interface WindowFetchResult {
  /** Строки окна [startMs, endMs), от новых к старым, без повторов. */
  rows: LogRow[];
  pages: number;
  /** false — дошли до лимита страниц, а начало окна так и не увидели: данные неполные. */
  complete: boolean;
  total: number;
  /** Самая новая и самая старая строки, которые вообще попались (не только в окне) — для диагностики «0 строк». */
  newestMs: number | null;
  oldestMs: number | null;
  /** Использованная дата «от» (дд.мм.гггг). */
  dateFrom: string;
  /** Как выглядит поле даты на сайте — только если результат пустой (для диагностики). */
  dateInput?: string;
}

const DEFAULT_MAX_PAGES = 60;

export async function fetchWindowRows(page: Page, p: WindowFetchParams): Promise<WindowFetchResult> {
  const maxPages = p.maxPages ?? DEFAULT_MAX_PAGES;
  // После листания страница результата не содержит формы поиска — возвращаемся к форме.
  if ((await page.locator("#faction_logs_server_id").count()) === 0) {
    await page.goto(`${p.baseUrl}/logs?act=faction`, { waitUntil: "domcontentloaded" });
  }
  // Дата «от» задаётся ВСЕГДА в формате сайта «дд.мм.гггг» (без неё сайт отдаст логи за все годы).
  // Дата «до» не ставится: без неё сайт отдаёт всё до момента запроса.
  const dateFrom = siteDateBefore(p.startMs);
  const search = () => searchFactionLogs(page, { serverId: p.serverId, faction: p.faction, dateFrom });

  let first: SearchResult = await search();
  const dateInput = first.rows.length === 0 ? await describeDateInput(page) : undefined;
  if (await raiseRowCount(page, first)) {
    // Настройка поменялась — повторяем поиск, чтобы страницы стали по максимуму строк.
    first = await search();
  }

  const seen = new Set<number>();
  const rows: LogRow[] = [];
  let pages = 0;
  let complete = false;
  let newestMs = -Infinity;
  let oldestAll = Infinity;
  let current: SearchResult = first;
  const pageSize = first.rows.length;

  for (let n = 1; n <= maxPages; n++) {
    pages = n;
    if (n > 1) current = await openResultPage(page, p.baseUrl, n);
    if (current.rows.length === 0) {
      complete = true; // логи за выбранные дни закончились
      break;
    }
    let oldest = Infinity;
    for (const row of current.rows) {
      const t = parseSiteTime(row.time);
      if (!Number.isFinite(t)) continue;
      if (t < oldest) oldest = t;
      if (t > newestMs) newestMs = t;
      if (t < oldestAll) oldestAll = t;
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

  return {
    rows,
    pages,
    complete,
    total: first.total,
    newestMs: Number.isFinite(newestMs) ? newestMs : null,
    oldestMs: Number.isFinite(oldestAll) ? oldestAll : null,
    dateFrom,
    dateInput,
  };
}
