// ===================== ОДИН ПРОГОН ПРОВЕРКИ =====================
//
// Открывает браузер, по очереди читает логи каждой настроенной фракции за период,
// анализирует и отправляет отчёт в канал. Если подозрительных нет — по этой фракции
// сообщение не отправляется.

import { isNotWarehouseRow, parseAction, type WarehouseAction } from "./actions.js";
import { analyzeActions, DEFAULT_ANALYZE_OPTIONS, type Suspect } from "./analyze.js";
import { loadSiteConfig } from "./config.js";
import { fetchWindowRows } from "./fetchWindow.js";
import type { OperatorIO } from "./io.js";
import { CaptchaRequiredError, LogsPageError } from "./logsPage.js";
import { describePeriod, splitIntoPeriods, type Period } from "./periods.js";
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
}

let running = false;
export const isRunning = (): boolean => running;

/** Читает и анализирует, но ничего не отправляет — отправкой занимается вызывающий. */
export async function runCheck(period: Period, io: OperatorIO, opts: { onlyFactions?: string[] } = {}): Promise<RunResult> {
  if (running) throw new Error("Проверка уже выполняется — дождитесь её окончания.");
  running = true;
  const settings = getSettings();
  const outcomes: FactionOutcome[] = [];
  const messages: string[] = [];
  let session: SiteSession | null = null;

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
          const incomplete = outcome.incomplete && i === 0;
          if (suspects.length || incomplete) {
            messages.push(...formatFactionReport(faction.name, chunk, suspects, { incomplete }));
          }
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

  return { period, outcomes, messages, ok: outcomes.every((o) => !o.error) };
}

function describeError(err: unknown): string {
  if (err instanceof CaptchaRequiredError || err instanceof LogsPageError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Короткая сводка для личного сообщения владельцу и для /sklad status. */
export function summarize(result: RunResult): string {
  const lines = [`Период ${describePeriod(result.period)}:`];
  for (const o of result.outcomes) {
    if (o.error) lines.push(`• ${o.factionName}: ❌ ${o.error}`);
    else
      lines.push(
        `• ${o.factionName}: строк ${o.rowsRead} (страниц ${o.pages}), действий со складом ${o.actions}, подозрительных ${o.suspects.length}${o.incomplete ? " ⚠ данные неполные" : ""}` +
          (o.unparsed ? `\n   ⚠ не распознано строк «Берет/Кладет»: ${o.unparsed}, например: ${o.unparsedSamples.map((t) => `«${t}»`).join("; ")}` : "")
      );
  }
  return lines.join("\n");
}

