// ===================== ОДНА ПРОВЕРКА ЛОГОВ ЗА СУТКИ =====================
//
// Заходит на сайт тем же способом, что и склад (общий аккаунт, общая очередь), по каждой
// действующей фракции выгружает все логи за сутки, разбирает их в памяти и собирает сводку.
// Логи нигде не сохраняются: массив строк существует только внутри прогона и исчезает,
// как только функция вернула результат.

import { addDaysToKey, formatDateKey, mskToUtcMs } from "../activity/time.js";
import { parseSiteTime } from "../warehouse/actions.js";
import { loadSiteConfig } from "../warehouse/config.js";
import { fetchWindowRows } from "../warehouse/fetchWindow.js";
import type { OperatorIO } from "../warehouse/io.js";
import { CaptchaRequiredError, LogsPageError } from "../warehouse/logsPage.js";
import { LoginError, SiteSession } from "../warehouse/siteSession.js";
import { withSiteLock } from "../warehouse/siteLock.js";
import { getFactions, getSettings as getWarehouseSettings } from "../warehouse/store.js";
import { parseRow } from "./parse.js";
import { buildSummary, shortFactionName, type FactionResult, type Finding } from "./report.js";
import { getWords } from "./store.js";
import { WordMatcher } from "./words.js";

export interface DayWindow {
  /** «2026-11-20» */
  dateKey: string;
  /** Сутки по МСК: [00:00, следующие 00:00). */
  startMs: number;
  endMs: number;
}

export function windowForDate(dateKey: string): DayWindow {
  return { dateKey, startMs: mskToUtcMs(dateKey, "00:00"), endMs: mskToUtcMs(addDaysToKey(dateKey, 1), "00:00") };
}

export interface LogCheckResult {
  day: DayWindow;
  results: FactionResult[];
  /** Сообщения сводки, готовые к отправке в канал. */
  messages: string[];
  /** false, если хотя бы одну фракцию не удалось прочитать. */
  ok: boolean;
  /** Служебные предупреждения: только владельцу в личку. */
  notices: string[];
}

/** Номер сборки модуля: видно в /lcheck status, какой код запущен. */
export const LC_BUILD_ID = "2026-11-21.r1";

let running = false;
export const isLogCheckRunning = (): boolean => running;

export async function runLogCheck(day: DayWindow, io: OperatorIO, opts: { onlyFactions?: string[] } = {}): Promise<LogCheckResult> {
  if (running) throw new Error("Проверка логов уже выполняется — дождитесь её окончания.");
  running = true;
  try {
    return await withSiteLock("логи", () => runLocked(day, io, opts));
  } finally {
    running = false;
  }
}

async function runLocked(day: DayWindow, io: OperatorIO, opts: { onlyFactions?: string[] }): Promise<LogCheckResult> {
  const warehouse = getWarehouseSettings();
  const results: FactionResult[] = [];
  const notices: string[] = [];
  const matcher = new WordMatcher(getWords());
  let session: SiteSession | null = null;

  try {
    if (!warehouse.factions.length) throw new Error("Не выбрано ни одной фракции (/sklad faction add).");
    const factions = opts.onlyFactions?.length ? getFactions().filter((f) => opts.onlyFactions!.includes(f.code)) : getFactions();
    if (!factions.length) throw new Error("Выбранная фракция не входит в список проверяемых (/sklad faction add).");

    const cfg = loadSiteConfig();
    session = await SiteSession.open(cfg, io);

    for (const faction of factions) {
      const result: FactionResult = {
        name: shortFactionName(faction.code, faction.name),
        incomplete: false,
        rowsRead: 0,
        pages: 0,
        findings: [],
        pvp: new Map(),
      };
      results.push(result);
      try {
        // Перед каждой фракцией заново открываем страницу логов: это же проверяет, что сессия жива.
        const page = await session.ensureLogsPage();
        const fetched = await fetchWindowRows(page, {
          baseUrl: cfg.baseUrl,
          serverId: warehouse.siteServerId,
          faction: faction.code,
          startMs: day.startMs,
          endMs: day.endMs,
          maxPages: 80,
        });
        result.rowsRead = fetched.rows.length;
        result.pages = fetched.pages;
        result.incomplete = !fetched.complete;
        if (!fetched.rows.length) {
          // Целые сутки без единой строки у фракции — почти наверняка проблема чтения, а не тишина.
          result.error = `за сутки не прочитано ни одной строки (сайт показал всего ${fetched.total}, дата «от» ${fetched.dateFrom})`;
          continue;
        }
        if (result.incomplete) notices.push(`${result.name}: логи за сутки прочитаны не полностью (слишком много страниц) — данные могут быть неполными.`);

        for (const row of fetched.rows) {
          const { reason, pvp } = parseRow(row);
          if (pvp) {
            const set = result.pvp.get(pvp.event) ?? new Set<string>();
            set.add(pvp.characterId);
            result.pvp.set(pvp.event, set);
          }
          if (reason) {
            const matches = matcher.find(reason.reason);
            if (matches.length) {
              const hard = matches.filter((m) => m.level === "hard").map((m) => m.label.replace(/^=/, "").replace(/\*$/, ""));
              const soft = matches.filter((m) => m.level === "soft").map((m) => `${m.label.replace(/^=/, "").replace(/\*$/, "")} (спорное)`);
              const finding: Finding = {
                line: [row.id, row.character, row.faction, row.text, row.time].join(" "),
                marks: [...hard, ...soft].join(", "),
                time: parseSiteTime(row.time),
              };
              result.findings.push(finding);
            }
          }
        }
      } catch (err) {
        if (err instanceof LoginError) throw err; // вход не удался — смысла продолжать нет
        result.error = err instanceof CaptchaRequiredError || err instanceof LogsPageError ? err.message : err instanceof Error ? err.message : String(err);
        console.error(`[logcheck] Фракция «${faction.name}»:`, err);
      }
    }
  } finally {
    await session?.close();
  }

  return { day, results, messages: buildSummary(day.dateKey, results), notices, ok: results.every((r) => !r.error) };
}

/** Короткая сводка для личного сообщения владельцу и /lcheck status. */
export function summarize(r: LogCheckResult): string {
  const lines = [`Сутки ${formatDateKey(r.day.dateKey)} (сборка ${LC_BUILD_ID}):`];
  for (const f of r.results) {
    if (f.error) lines.push(`• ${f.name}: ${f.error}`);
    else {
      const pvp = [...f.pvp.entries()].map(([event, ids]) => `${event}: ${ids.size}`).join("; ") || "ПВП нет";
      lines.push(`• ${f.name}: строк ${f.rowsRead} (страниц ${f.pages}), нарушений ${f.findings.length}, ${pvp}${f.incomplete ? " — данные неполные" : ""}`);
    }
  }
  return lines.join("\n");
}
