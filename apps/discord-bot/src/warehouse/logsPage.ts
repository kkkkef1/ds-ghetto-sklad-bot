// ===================== ЧТЕНИЕ ЛОГОВ ФРАКЦИЙ =====================
//
// Страница «Логи фракций» — старый сайт на jQuery: форма без <form>, кнопка «Поиск»
// вызывает Logs.factionSearch(...), результат подгружается в #logs_table в фоне.
// Поэтому бот работает как человек: выставляет фильтры, нажимает «Поиск» и читает таблицу.
// Следующие страницы результата открываются обычной ссылкой
//   /logs?act=faction&page=N&from=page_change
// (сайт помнит последний поиск в сессии).

import type { Page } from "playwright";

export interface SearchParams {
  /** id сервера (Redwood = 17). */
  serverId: string;
  /** Код фракции: F_GANG_BLOODS и т.п. */
  faction: string;
  /** Дата «от»/«до» в формате дд/мм/гггг (у сайта только дни, без времени). */
  dateFrom?: string;
  dateTo?: string;
  /** Фильтр «Действие» (подстрока текста). */
  text?: string;
  /** Ник/ID персонажа. */
  char?: string;
}

export interface LogRow {
  /** Порядковый номер записи в результате поиска: растёт со временем; внутри одного поиска стабилен. */
  id: number;
  /** «Morphy_Outlaw [245351]» как на сайте. */
  character: string;
  characterName: string;
  characterId: string;
  faction: string;
  text: string;
  /** «09.11.2026, 21:04:39» — время по Москве, как на сайте. */
  time: string;
}

export interface SearchResult {
  total: number;
  rows: LogRow[];
  /** «Отображено N, макс. M» со страницы; 0, если не нашлось. */
  shown: number;
  maxShown: number;
}

export class CaptchaRequiredError extends Error {
  constructor() {
    super("Сайт показал «Проверка на робота» при поиске по логам.");
    this.name = "CaptchaRequiredError";
  }
}

/** Страница результата не открылась: сессия сброшена или вёрстка изменилась. */
export class LogsPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogsPageError";
  }
}

// Скрипты, выполняемые в странице, — строками, чтобы не тащить DOM-типы в проект.
const SET_FILTERS_SCRIPT = `(p) => {
  var $ = window.jQuery || window.$;
  var set = function (id, value) {
    var el = document.getElementById(id);
    if (!el) return false;
    el.value = value;
    if ($) {
      try { var q = $('#' + id); q.val(value); if (q.selectpicker) q.selectpicker('refresh'); } catch (e) {}
    }
    return true;
  };
  var sel = function (id) { var el = document.getElementById(id); return el ? el.value : null; };
  return {
    server: set('faction_logs_server_id', p.serverId) && sel('faction_logs_server_id') === p.serverId,
    faction: set('faction_logs_faction', p.faction) && sel('faction_logs_faction') === p.faction,
    char: set('faction_logs_char', p.char || ''),
    from: set('faction_logs_time_from', p.dateFrom || ''),
    to: set('faction_logs_time_to', p.dateTo || ''),
    text: set('faction_logs_text', p.text || '')
  };
}`;

const SNAPSHOT_SCRIPT = `(() => {
  var t = document.querySelector('#logs_table');
  var m = document.querySelector('#recaptcha_modal');
  var captcha = !!m && (m.classList.contains('show') || getComputedStyle(m).display !== 'none');
  return { html: t ? t.innerHTML : '', captcha: captcha };
})()`;

const READ_SCRIPT = `(() => {
  var rows = [];
  document.querySelectorAll('#logs_table tr').forEach(function (tr) {
    var tds = tr.querySelectorAll('td');
    if (tds.length < 5) return;
    rows.push(Array.prototype.map.call(tds, function (td) { return (td.textContent || '').replace(/\\s+/g, ' ').trim(); }));
  });
  var num = function (el) { return el ? Number((el.textContent || '').replace(/\\D/g, '')) || 0 : 0; };
  var cnt = document.querySelector('#logs_cnt');
  return {
    rows: rows,
    total: num(document.querySelector('#logs_total_cnt')),
    shown: num(cnt),
    max: num(cnt ? cnt.nextElementSibling : null),
    hasTable: !!document.querySelector('#logs_table')
  };
})()`;

interface RawPage {
  rows: string[][];
  total: number;
  shown: number;
  max: number;
  hasTable: boolean;
}

export async function searchFactionLogs(page: Page, params: SearchParams): Promise<SearchResult> {
  // page.evaluate со строкой вычисляет выражение и не передаёт аргумент, поэтому
  // параметры вшиваются в вызов функции как JSON.
  const applied = await page.evaluate<Record<string, boolean>>(`(${SET_FILTERS_SCRIPT})(${JSON.stringify(params)})`);
  if (!applied.server || !applied.faction) {
    throw new LogsPageError(
      `На странице логов не нашлись поля фильтров или нет такого значения (сервер ${params.serverId}, фракция ${params.faction}) — вёрстка сайта изменилась?`
    );
  }

  const before = await page.evaluate<{ html: string; captcha: boolean }>(SNAPSHOT_SCRIPT);
  await page.locator("button", { hasText: /^\s*Поиск\s*$/ }).first().click();

  // Ждём, пока таблица обновится (или всплывёт капча), и затем — пока она перестанет меняться:
  // сразу после клика сайт может показать промежуточное состояние (загрузку), и чтение в этот момент
  // дало бы «0 строк». Если результат вообще не изменился (тот же поиск повторён) — через таймаут читаем то, что есть.
  const deadline = Date.now() + 30_000;
  let changed = false;
  let last = before.html;
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const now = await page.evaluate<{ html: string; captcha: boolean }>(SNAPSHOT_SCRIPT);
    if (now.captcha) throw new CaptchaRequiredError();
    if (now.html !== before.html) changed = true;
    if (now.html !== last) {
      last = now.html;
      lastChangeAt = Date.now();
    }
    if (!changed) continue;
    const stableMs = Date.now() - lastChangeAt;
    const hasRows = now.html.includes("<td");
    if ((hasRows && stableMs >= 2_000) || stableMs >= 6_000) break;
  }

  const raw = await page.evaluate<RawPage>(READ_SCRIPT);
  return toResult(raw);
}

/**
 * Открывает страницу N уже выполненного поиска. Сайт хранит условия поиска в сессии,
 * поэтому достаточно перейти по ссылке пагинации.
 */
export async function openResultPage(page: Page, baseUrl: string, n: number): Promise<SearchResult> {
  await page.goto(`${baseUrl}/logs?act=faction&page=${n}&from=page_change`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#logs_table", { state: "attached", timeout: 30_000 }).catch(() => {
    throw new LogsPageError(`Страница ${n} результата не открылась (нет таблицы логов): возможно, сессия сброшена.`);
  });
  const raw = await page.evaluate<RawPage>(READ_SCRIPT);
  if (!raw.hasTable) throw new LogsPageError(`Страница ${n} результата не открылась.`);
  return toResult(raw);
}

/**
 * Если на сайте стоит меньше максимума строк на страницу («Отображено 50, макс. 3000 (изменить)»),
 * пытается поднять до максимума. Сайт хранит это в настройках аккаунта, поэтому обычно
 * достаточно сделать это один раз. Если не получилось — ничего страшного: бот просто листает
 * больше страниц. Возвращает true, если значение поменялось.
 */
export async function raiseRowCount(page: Page, result: SearchResult): Promise<boolean> {
  if (!result.maxShown || result.shown >= result.maxShown || result.total <= result.shown) return false;
  try {
    await page.locator("a", { hasText: /изменить/i }).first().click({ timeout: 5_000 });
    const input = page.locator('.modal.show input:not([type="hidden"]):not([type="checkbox"]), [role="dialog"] input:not([type="hidden"])').first();
    await input.waitFor({ state: "visible", timeout: 5_000 });
    await input.fill(String(result.maxShown));
    await page
      .locator('.modal.show button, [role="dialog"] button')
      .filter({ hasText: /сохранить|применить|изменить|ок|ok/i })
      .first()
      .click({ timeout: 5_000 });
    await page.waitForTimeout(1_500);
    return true;
  } catch (err) {
    console.warn("[warehouse] Не удалось поднять число строк на странице до максимума (не критично):", err instanceof Error ? err.message : err);
    return false;
  }
}

function toResult(raw: RawPage): SearchResult {
  return { total: raw.total, shown: raw.shown, maxShown: raw.max, rows: raw.rows.map(toRow) };
}

function toRow(cells: string[]): LogRow {
  const [id, character, faction, text, time] = cells;
  const m = character.match(/^(.*?)\s*\[(\d+)\]$/);
  return {
    id: Number(id),
    character,
    characterName: m ? m[1] : character,
    characterId: m ? m[2] : "",
    faction,
    text,
    time,
  };
}
