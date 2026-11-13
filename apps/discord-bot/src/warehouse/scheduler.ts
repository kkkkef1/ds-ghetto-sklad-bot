// ===================== РАСПИСАНИЕ: 4 ПРОВЕРКИ В СУТКИ =====================
//
// Раз в минуту смотрим на часы. Через PERIOD_DELAY_MIN минут после конца периода
// (00:00, 06:00, 12:00, 18:00 МСК) запускаем проверку за этот период.
// Если бот был выключен в нужный момент, а потом поднялся — наверстает последний
// период, но только если с его окончания прошло не больше CATCH_UP_HOURS (иначе
// отчёт придёт «из прошлого», и в нём уже нет смысла).

import type { Client, TextBasedChannel } from "discord.js";
import { ClientIO } from "./discordIO.js";
import { listenForLimitReplies } from "./newItems.js";
import { lastCompletedPeriod, type Period } from "./periods.js";
import { isRunning, runCheck, summarize } from "./runner.js";
import { getSettings, isPeriodDone, markCheckedUntil, markPeriodDone, setLastRunSummary } from "./store.js";

const TICK_MS = 60_000;
const PERIOD_DELAY_MIN = 2;
const CATCH_UP_HOURS = 3;
const RETRY_AFTER_MIN = 20;
const MAX_ATTEMPTS = 3;

const attempts = new Map<string, { count: number; nextAt: number }>();

export function ownerId(): string | null {
  return process.env.WH_OWNER_ID?.trim() || null;
}

/** Все сообщения канала; возвращает false, если канал не настроен или недоступен. */
export async function postToChannel(client: Client, messages: string[]): Promise<boolean> {
  const { channelId } = getSettings();
  if (!channelId) return false;
  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
  if (!channel || !("send" in channel)) return false;
  for (const content of messages) {
    await channel.send({ content, allowedMentions: { parse: [] } });
  }
  return true;
}

export async function runPeriod(client: Client, period: Period): Promise<void> {
  const owner = ownerId();
  if (!owner) {
    console.error("[warehouse] WH_OWNER_ID не задан — проверка склада невозможна (нужна связь с владельцем для кода входа).");
    return;
  }
  const io = new ClientIO(client, owner);
  try {
    console.log(`[warehouse] Запускаю проверку периода ${period.key} (${new Date(period.startMs).toISOString()} – ${new Date(period.endMs).toISOString()}).`);
    const result = await runCheck(period, io);
    console.log(`[warehouse] Период ${period.key} прочитан: ${summarize(result).replace(/\n/g, " | ")}`);
    // Все фракции дали ошибку (например, сайт ничего не вернул): не закрываем период, чтобы tick повторил попытку.
    if (result.outcomes.length > 0 && result.outcomes.every((o) => o.error)) throw new Error(summarize(result));
    if (result.notices.length) await io.notify(`Проверка склада, период ${period.key}:\n${result.notices.join("\n")}`);
    let delivered = true;
    if (result.messages.length) {
      delivered = await postToChannel(client, result.messages);
      if (!delivered) await io.notify("Результаты есть, но канал для отчётов не настроен или недоступен (/sklad channel).");
    }
    // «Проверено до» двигаем, только если всё прочиталось и отчёт дошёл: иначе /sklad force доберёт это окно.
    if (result.ok && delivered) markCheckedUntil(period.endMs);
    setLastRunSummary({ at: Date.now(), period: period.key, ok: result.ok, text: summarize(result) });
    // Период считается обработанным, даже если часть фракций не прочиталась: повтор целиком
    // продублировал бы уже отправленные отчёты. Недостающее владелец добирает вручную (/sklad run).
    markPeriodDone(period.key);
    if (!result.ok) await io.notify(`Проверка склада прошла с ошибками. Недостающее можно повторить командой /sklad run.\n${summarize(result)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setLastRunSummary({ at: Date.now(), period: period.key, ok: false, text: `Ошибка: ${message}` });
    throw err;
  }
}

async function tick(client: Client): Promise<void> {
  if (!getSettings().enabled) return; // автопроверка выключена командой /sklad disable
  const now = Date.now();
  const period = lastCompletedPeriod(now);
  if (isPeriodDone(period.key) || isRunning()) return;
  if (now < period.endMs + PERIOD_DELAY_MIN * 60_000) return;
  if (now - period.endMs > CATCH_UP_HOURS * 3_600_000) return;
  if (!getSettings().channelId) return; // пока канал не выбран — отчёту некуда идти

  const state = attempts.get(period.key) ?? { count: 0, nextAt: 0 };
  if (state.count >= MAX_ATTEMPTS || now < state.nextAt) return;
  state.count += 1;
  state.nextAt = now + RETRY_AFTER_MIN * 60_000;
  attempts.set(period.key, state);

  try {
    await runPeriod(client, period);
  } catch (err) {
    console.error(`[warehouse] Проверка периода ${period.key} не удалась (попытка ${state.count}/${MAX_ATTEMPTS}):`, err);
    if (state.count >= MAX_ATTEMPTS) {
      const owner = ownerId();
      if (owner) await new ClientIO(client, owner).notify(`Проверка склада за период ${period.key} не удалась ${MAX_ATTEMPTS} раза подряд, больше пробовать не буду.`);
    }
  }
}

/** Подключает расписание к уже запущенному клиенту. Вызывать один раз. */
export function initWarehouse(client: Client): void {
  listenForLimitReplies(client, ownerId);
  setInterval(() => void tick(client).catch((e) => console.error("[warehouse] tick:", e)), TICK_MS).unref();
}
