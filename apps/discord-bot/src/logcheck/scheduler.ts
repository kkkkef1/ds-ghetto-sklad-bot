// ===================== РАСПИСАНИЕ: ОДНА ПРОВЕРКА В СУТКИ =====================
//
// Раз в минуту смотрим на часы. Начиная с настроенного времени (по умолчанию 00:10 МСК)
// бот проверяет ВЧЕРАШНИЕ сутки (00:00–23:59). Если бот был выключен в нужный момент, он
// наверстает вчерашние сутки, как только поднимется (в течение того же дня). Сутки считаются
// обработанными только после того, как сводка дошла до канала; логи не хранятся нигде.
// При сбое — повтор через 20 минут, до 3 попыток, потом сообщение владельцу.

import type { Client, TextBasedChannel } from "discord.js";
import { addDaysToKey, mskDateKey, mskToUtcMs } from "../activity/time.js";
import { ClientIO } from "../warehouse/discordIO.js";
import { ownerId } from "../warehouse/scheduler.js";
import { isLogCheckRunning, runLogCheck, summarize, windowForDate, type LogCheckResult } from "./runner.js";
import { getSettings, isDayDone, markDayDone, setLastRunSummary } from "./store.js";

const TICK_MS = 60_000;
const RETRY_AFTER_MIN = 20;
const MAX_ATTEMPTS = 3;

const attempts = new Map<string, { count: number; nextAt: number }>();
/** Сколько сообщений сводки уже ушло в канал по суткам: при повторе после сбоя не дублируем отправленное. */
const sentParts = new Map<string, number>();

function startTimeToday(now: number): number {
  const minute = getSettings().startMinute;
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return mskToUtcMs(mskDateKey(now), `${hh}:${mm}`);
}

/** Отправляет сообщения в канал сводок. false — канал не настроен или недоступен. */
async function postSummary(client: Client, dateKey: string, messages: string[]): Promise<boolean> {
  const { channelId } = getSettings();
  if (!channelId) return false;
  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
  if (!channel || !("send" in channel)) return false;
  for (let i = sentParts.get(dateKey) ?? 0; i < messages.length; i++) {
    await channel.send({ content: messages[i], allowedMentions: { parse: [] } });
    sentParts.set(dateKey, i + 1);
  }
  sentParts.delete(dateKey);
  return true;
}

export interface DayRunOutcome {
  result: LogCheckResult;
  /** null — отправка в канал не требовалась. */
  delivered: boolean | null;
}

/**
 * Проверка суток целиком: чтение, при post — отправка сводки и отметка «сутки обработаны».
 * Вызывается и расписанием, и командой /lcheck run.
 */
export async function runDay(client: Client, dateKey: string, io: ClientIO, opts: { post: boolean; onlyFactions?: string[] }): Promise<DayRunOutcome> {
  console.log(`[logcheck] Запускаю проверку суток ${dateKey}.`);
  const result = await runLogCheck(windowForDate(dateKey), io, { onlyFactions: opts.onlyFactions });
  console.log(`[logcheck] Сутки ${dateKey} прочитаны: ${summarize(result).replace(/\n/g, " | ")}`);

  // Все фракции дали ошибку (например, сайт ничего не вернул): не закрываем сутки, расписание повторит попытку.
  if (opts.post && result.results.length > 0 && result.results.every((r) => r.error)) throw new Error(summarize(result));

  if (result.notices.length) await io.notify(`Проверка логов, сутки ${dateKey}:\n${result.notices.join("\n")}`);

  let delivered: boolean | null = null;
  if (opts.post) {
    delivered = await postSummary(client, dateKey, result.messages);
    if (!delivered) {
      await io.notify("Сводка готова, но канал для неё не настроен или недоступен (/lcheck channel). Повторю позже.");
      throw new Error("канал сводки недоступен");
    }
    // Сутки считаются обработанными, даже если часть фракций не прочиталась: повтор целиком продублировал бы
    // сводку. Недостающее владелец добирает вручную (/lcheck run).
    if (!opts.onlyFactions?.length) markDayDone(dateKey);
    setLastRunSummary({ at: Date.now(), day: dateKey, ok: result.ok, text: summarize(result) });
    if (!result.ok) await io.notify(`Проверка логов прошла с ошибками, в сводке эти фракции помечены ⚠️.\n${summarize(result)}`);
  }
  return { result, delivered };
}

async function tick(client: Client): Promise<void> {
  const s = getSettings();
  if (!s.enabled || !s.channelId) return;
  const now = Date.now();
  if (now < startTimeToday(now)) return;
  const dateKey = addDaysToKey(mskDateKey(now), -1);
  if (isDayDone(dateKey) || isLogCheckRunning()) return;

  const owner = ownerId();
  if (!owner) {
    console.error("[logcheck] WH_OWNER_ID не задан — проверка логов невозможна (нужна связь с владельцем для кода входа).");
    return;
  }

  const state = attempts.get(dateKey) ?? { count: 0, nextAt: 0 };
  if (state.count >= MAX_ATTEMPTS || now < state.nextAt) return;
  state.count += 1;
  state.nextAt = now + RETRY_AFTER_MIN * 60_000;
  attempts.set(dateKey, state);

  const io = new ClientIO(client, owner);
  try {
    await runDay(client, dateKey, io, { post: true });
  } catch (err) {
    console.error(`[logcheck] Проверка суток ${dateKey} не удалась (попытка ${state.count}/${MAX_ATTEMPTS}):`, err);
    const message = err instanceof Error ? err.message : String(err);
    setLastRunSummary({ at: Date.now(), day: dateKey, ok: false, text: `Ошибка: ${message}` });
    if (state.count >= MAX_ATTEMPTS) await io.notify(`Проверка логов за ${dateKey} не удалась ${MAX_ATTEMPTS} раза подряд, больше пробовать не буду. Ручной запуск: /lcheck run.`);
  }
  // Старые записи о попытках не копим.
  for (const key of attempts.keys()) if (key < addDaysToKey(dateKey, -3)) attempts.delete(key);
}

/** Подключает расписание к уже запущенному клиенту. Вызывать один раз. */
export function initLogCheck(client: Client): void {
  setInterval(() => void tick(client).catch((e) => console.error("[logcheck] tick:", e)), TICK_MS).unref();
}
