// ===================== ЗАГРУЗКА ЛОГОВ ЗА ОКНО ВРЕМЕНИ =====================
//
// У сайта фильтр только по дням, а страница вмещает не больше 3000 строк (≈7–8 часов).
// Поэтому: запрашиваем логи начиная со вчерашнего дня, листаем страницы от новых к старым
// и останавливаемся, как только дошли до начала нужного окна. Лишнее отсекаем по времени.

import type { Page } from "playwright";
import { parseSiteTime } from "./actions.js";
import { openResultPage, raiseRowCount, searchFactionLogs, type LogRow, type SearchParams, type SearchResult } from "./logsPage.js";
import { siteDateAfter, siteDateBefore } from "./periods.js";

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
  /** Какой вариант фильтра дат сработал (0 — основной). */
  attempt: number;
}

const DEFAULT_MAX_PAGES = 60;

export async function fetchWindowRows(page: Page, p: WindowFetchParams): Promise<WindowFetchResult> {
  const maxPages = p.maxPages ?? DEFAULT_MAX_PAGES;
  // После листания страница результата не содержит формы поиска — возвращаемся к форме.
  if ((await page.locator("#faction_logs_server_id").count()) === 0) {
    await page.goto(`${p.baseUrl}/logs?act=faction`, { waitUntil: "domcontentloaded" });
  }
  // Дата «от» задаётся ВСЕГДА (без неё сайт отдаст логи за все годы). Дата «до» не обязательна:
  // без неё сайт отдаёт всё до момента запроса. Если с одной датой «от» пришла пустая таблица,
  // пробуем ещё раз с явной границей «до» — но никогда не пропускаем «от».
  const variants: Array<Pick<SearchParams, "dateFrom" | "dateTo">> = [
    { dateFrom: siteDateBefore(p.startMs) },
    { dateFrom: siteDateBefore(p.startMs), dateTo: siteDateAfter(p.endMs) },
  ];
  const search = (v: Pick<SearchParams, "dateFrom" | "dateTo">) => searchFactionLogs(page, { serverId: p.serverId, faction: p.faction, ...v });

  let attempt = 0;
  let used = variants[0];
  let first: SearchResult = await search(used);
  while (first.rows.length === 0 && attempt < variants.length - 1) {
    attempt++;
    used = variants[attempt];
    console.warn(`[warehouse] ${p.faction}: пустой результат, пробую другой фильтр дат (вариант ${attempt + 1}/${variants.length}).`);
    first = await search(used);
  }

  if (await raiseRowCount(page, first)) {
    // Настройка поменялась — повторяем поиск, чтобы страницы стали по максимуму строк.
    first = await search(used);
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
    attempt,
  };
}
