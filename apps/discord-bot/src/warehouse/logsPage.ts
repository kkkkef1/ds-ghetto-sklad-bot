// ===================== ЧТЕНИЕ ЛОГОВ ФРАКЦИЙ =====================
//
// Страница «Логи фракций» — старый сайт на jQuery: форма без <form>, кнопка «Поиск»
// вызывает Logs.factionSearch(...), результат подгружается в #logs_table в фоне.
// Поэтому бот работает как человек: выставляет фильтры, нажимает «Поиск» и читает таблицу.

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
  /** Порядковый номер записи: растёт со временем, годится для отсечения уже обработанного. */
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
}

export class CaptchaRequiredError extends Error {
  constructor() {
    super("Сайт показал «Проверка на робота» при поиске по логам.");
    this.name = "CaptchaRequiredError";
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
  return {
    server: set('faction_logs_server_id', p.serverId),
    faction: set('faction_logs_faction', p.faction),
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
  var total = document.querySelector('#logs_total_cnt');
  return { rows: rows, total: total ? (total.textContent || '') : '' };
})()`;

export async function searchFactionLogs(page: Page, params: SearchParams): Promise<SearchResult> {
  // page.evaluate со строкой вычисляет выражение и не передаёт аргумент, поэтому
  // параметры вшиваются в вызов функции как JSON.
  const applied = await page.evaluate<Record<string, boolean>>(`(${SET_FILTERS_SCRIPT})(${JSON.stringify(params)})`);
  if (!applied.server || !applied.faction) {
    throw new Error("На странице логов не нашлись поля фильтров — вёрстка сайта изменилась?");
  }

  const before = await page.evaluate<{ html: string; captcha: boolean }>(SNAPSHOT_SCRIPT);
  await page.locator("button", { hasText: /^\s*Поиск\s*$/ }).first().click();

  // Ждём, пока таблица обновится (или всплывёт капча). Если результат не изменился
  // (тот же поиск повторён) — через таймаут читаем то, что есть.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const now = await page.evaluate<{ html: string; captcha: boolean }>(SNAPSHOT_SCRIPT);
    if (now.captcha) throw new CaptchaRequiredError();
    if (now.html !== before.html) break;
  }

  const raw = await page.evaluate<{ rows: string[][]; total: string }>(READ_SCRIPT);
  return { total: Number(raw.total.replace(/\D/g, "")) || 0, rows: raw.rows.map(toRow) };
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
