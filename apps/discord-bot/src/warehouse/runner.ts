// ===================== ОДИН ПРОГОН ПРОВЕРКИ =====================
//
// Открывает браузер, по очереди читает логи каждой настроенной фракции за период,
// анализирует и отправляет отчёт в канал. Если подозрительных нет — по этой фракции
// сообщение не отправляется.

import { isNotWarehouseRow, parseAction, type WarehouseAction } from "./actions.js";
import { analyzeActions, DEFAULT_ANALYZE_OPTIONS, findUnknownItems, type Suspect, type UnknownItem } from "./analyze.js";
import { loadSiteConfig } from "./config.js";
import { fetchWindowRows } from "./fetchWindow.js";
import type { OperatorIO } from "./io.js";
import { CaptchaRequiredError, LogsPageError } from "./logsPage.js";
import { formatDateTime } from "../activity/time.js";
import { describePeriod, splitIntoPeriods, type Period } from "./periods.js";
import { askAboutNewItems } from "./newItems.js";
import { formatFactionReport } from "./report.js";
import { LoginError, SiteSession } from "./siteSession.js";
import { getExcludedIds, getSettings } from "./store.js";

export interface FactionOutcome {
  factionName: string;
  suspects: Suspect[];
  rowsRead: number;
  /** Из них распознано как действия со складом/машинами/наборами. */
  actions: number;
  /** Строки «Берет…/Кладет…», которые разобрать не удалось (формат мог измениться) — для проверки при настройке. */
  unparsed: number;
  unparsedSamples: string[];
  pages: number;
  incomplete: boolean;
  error?: string;
}

export interface RunResult {
  period: Period;
  outcomes: FactionOutcome[];
  /** Сообщения для канала, готовые к отправке (по фракциям, где есть подозрительные). */
  messages: string[];
  /** false, если хотя бы одну фракцию не удалось прочитать. */
  ok: boolean;
  /** Служебные предупреждения (неполные данные и т. п.): только владельцу в личку, в канал отчётов не идут. */
  notices: string[];
}

/** Номер сборки: показывается в сводке и в /sklad status, чтобы видеть, какой код реально запущен на сервере. */
export const BUILD_ID = "2026-11-13.r5";

let running = false;
export const isRunning = (): boolean => running;

/** Читает и анализирует, но ничего не отправляет — отправкой занимается вызывающий. */
export async function runCheck(period: Period, io: OperatorIO, opts: { onlyFactions?: string[] } = {}): Promise<RunResult> {
  if (running) throw new Error("Проверка уже выполняется — дождитесь её окончания.");
  running = true;
  const settings = getSettings();
  const outcomes: FactionOutcome[] = [];
  const messages: string[] = [];
  const notices: string[] = [];
  let session: SiteSession | null = null;
  const unknownItems = new Map<string, UnknownItem>();

  try {
    if (!settings.factions.length) throw new Error("Не выбрано ни одной фракции (/sklad faction add).");
    const cfg = loadSiteConfig();
    session = await SiteSession.open(cfg, io);

    const factions = opts.onlyFactions?.length ? settings.factions.filter((f) => opts.onlyFactions!.includes(f.code)) : settings.factions;
    if (!factions.length) throw new Error("Выбранная фракция не входит в список проверяемых (/sklad faction add).");
    for (const faction of factions) {
      const outcome: FactionOutcome = { factionName: faction.name, suspects: [], rowsRead: 0, actions: 0, unparsed: 0, unparsedSamples: [], pages: 0, incomplete: false };
      outcomes.push(outcome);
      try {
        // Перед каждой фракцией заново открываем страницу логов: это же проверяет, что сессия жива.
        const page = await session.ensureLogsPage();
        const fetched = await fetchWindowRows(page, {
          baseUrl: cfg.baseUrl,
          serverId: settings.siteServerId,
          faction: faction.code,
          startMs: period.startMs,
          endMs: period.endMs,
        });
        outcome.rowsRead = fetched.rows.length;
        outcome.pages = fetched.pages;
        outcome.incomplete = !fetched.complete;
        if (fetched.rows.length === 0) {
          // Ни одной строки за несколько часов у фракции — почти наверняка проблема чтения, а не «тишина»: сообщаем и не считаем проверку успешной.
          const seen = fetched.newestMs !== null && fetched.oldestMs !== null ? `, самая новая строка ${formatDateTime(fetched.newestMs)}, самая старая ${formatDateTime(fetched.oldestMs)}` : "";
          outcome.error = `за период не прочитано ни одной строки (сайт показал всего ${fetched.total}${seen}; вариант фильтра дат ${fetched.attempt + 1})`;
          continue;
        }

        const actions: WarehouseAction[] = [];
        for (const row of fetched.rows) {
          const a = parseAction(row);
          if (a) actions.push(a);
          else if (/^(Бер[её]т|Клад[её]т)/i.test(row.text) && !isNotWarehouseRow(row.text)) {
            outcome.unparsed++;
            if (outcome.unparsedSamples.length < 3) outcome.unparsedSamples.push(row.text.slice(0, 120));
          }
        }
        outcome.actions = actions.length;
        for (const item of findUnknownItems(actions, settings.rules)) {
          const key = item.name.toLowerCase();
          const known = unknownItems.get(key);
          if (known) {
            known.quantity += item.quantity;
            item.places.forEach((p) => known.places.add(p));
          } else unknownItems.set(key, item);
        }
        // Пороги заданы на 6 часов, поэтому длинное окно (ручная проверка, /sklad force)
        // анализируется по частям, по границам периодов. Для обычного периода часть одна.
        const chunks = splitIntoPeriods(period.startMs, period.endMs);
        chunks.forEach((chunk, i) => {
          const inChunk = chunks.length === 1 ? actions : actions.filter((a) => a.time >= chunk.startMs && a.time < chunk.endMs);
          const suspects = analyzeActions(inChunk, {
            rules: settings.rules,
            netReturns: settings.netReturns,
            kitCooldownCheck: settings.kitCooldownCheck,
            kitCooldownViolations: settings.kitCooldownViolations,
            excluded: getExcludedIds(),
            ...DEFAULT_ANALYZE_OPTIONS,
          });
          outcome.suspects.push(...suspects);
          // Неполные данные — это нехватка самого раннего куска окна, поэтому предупреждение у первой части.
          if (outcome.incomplete && i === 0) {
            notices.push(`${faction.name}: логи за период прочитаны не полностью (слишком много страниц) — список подозрительных может быть неполным.`);
          }
          // В канал уходят только отчёты о подозрительных; ошибки и предупреждения — владельцу в личку.
          if (suspects.length) messages.push(...formatFactionReport(faction.name, chunk, suspects));
        });
      } catch (err) {
        if (err instanceof LoginError) throw err; // вход не удался — смысла продолжать нет
        outcome.error = describeError(err);
        console.error(`[warehouse] Фракция «${faction.name}»:`, err);
      }
    }
  } finally {
    await session?.close();
    running = false;
  }

  // Новые предметы: спрашиваем лимит у владельца в личке (по сообщению на предмет).
  if (unknownItems.size) {
    try {
      await askAboutNewItems(io, [...unknownItems.values()]);
    } catch (err) {
      console.error("[warehouse] Не удалось спросить лимит для новых предметов:", err);
    }
  }

  return { period, outcomes, messages, notices, ok: outcomes.every((o) => !o.error) };
}

function describeError(err: unknown): string {
  if (err instanceof CaptchaRequiredError || err instanceof LogsPageError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Короткая сводка для личного сообщения владельцу и для /sklad status. */
export function summarize(result: RunResult): string {
  const lines = [`Период ${describePeriod(result.period)} (сборка ${BUILD_ID}):`];
  for (const o of result.outcomes) {
    if (o.error) lines.push(`• ${o.factionName}: ${o.error}`);
    else
      lines.push(
        `• ${o.factionName}: строк ${o.rowsRead} (страниц ${o.pages}), действий со складом ${o.actions}, подозрительных ${o.suspects.length}${o.incomplete ? " данные неполные" : ""}` +
          (o.unparsed ? `\n   не распознано строк «Берет/Кладет»: ${o.unparsed}, например: ${o.unparsedSamples.map((t) => `«${t}»`).join("; ")}` : "")
      );
  }
  return lines.join("\n");
}

