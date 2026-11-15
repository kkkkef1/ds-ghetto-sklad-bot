// ===================== РАСПИСАНИЕ ПРОВЕРКИ ТВИНКОВ =====================
//
// По умолчанию результат должен быть готов в среду и воскресенье в 09:00 МСК. Проверка долгая
// (несколько часов), поэтому стартует заранее — за leadHours до публикации (по умолчанию за 3 часа).
// Раз в минуту смотрим на часы. Если бот был выключен в момент старта, а потом поднялся — проверка
// всё равно стартует, пока с планового времени публикации прошло не больше CATCH_UP часов.

import type { Client } from "discord.js";
import { MINUTE_MS, MSK_OFFSET_MS, mskDateKey, weekdayOfKey } from "../activity/time.js";
import { isRunActive, ownerId, resumeAfterRestart, startRun } from "./checker.js";
import { listenForFactionReplies } from "./unknown.js";
import { getSettings, isDone } from "./store.js";

const TICK_MS = 60_000;
const CATCH_UP_MS = 6 * 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Причина отказа, о которой уже написали в лог (чтобы не повторять каждую минуту). */
const warned = new Set<string>();

function mskDayStart(ms: number): number {
  return Math.floor((ms + MSK_OFFSET_MS) / DAY_MS) * DAY_MS - MSK_OFFSET_MS;
}

/** Ближайшие моменты публикации вокруг now (вчера, сегодня, завтра), по возрастанию. */
export function publishTimes(now: number): number[] {
  const s = getSettings();
  const today = mskDayStart(now);
  const result: number[] = [];
  for (const shift of [-1, 0, 1]) {
    const day = today + shift * DAY_MS;
    if (s.days.includes(weekdayOfKey(mskDateKey(day)))) result.push(day + s.publishMinutes * MINUTE_MS);
  }
  return result;
}

/** Следующая плановая публикация, ещё не выполненная (для /twink status). */
export function nextPublish(now: number): number | null {
  const s = getSettings();
  const today = mskDayStart(now);
  for (let shift = 0; shift < 8; shift++) {
    const day = today + shift * DAY_MS;
    if (!s.days.includes(weekdayOfKey(mskDateKey(day)))) continue;
    const at = day + s.publishMinutes * MINUTE_MS;
    if (at > now || (!isDone(mskDateKey(at)) && now - at < CATCH_UP_MS)) return at;
  }
  return null;
}

function tick(client: Client): void {
  const s = getSettings();
  if (!s.enabled || !s.channelId || isRunActive()) return;
  if (!ownerId()) return;
  const now = Date.now();
  for (const at of publishTimes(now)) {
    const key = mskDateKey(at);
    if (isDone(key)) continue;
    if (now < at - s.leadHours * 60 * MINUTE_MS || now >= at + CATCH_UP_MS) continue;
    const res = startRun(client, { kind: "auto", runId: key, publishAtMs: at });
    if (res.ok) console.log(`[twink] Запускаю проверку твинков к публикации ${new Date(at).toISOString()}.`);
    else if (!warned.has(`${key}:${res.reason}`)) {
      warned.add(`${key}:${res.reason}`);
      console.error(`[twink] Не удалось запустить проверку: ${res.reason}`);
    }
    return;
  }
}

/** Подключает расписание к уже запущенному клиенту. Вызывать один раз. */
export function initTwink(client: Client): void {
  listenForFactionReplies(client, ownerId);
  resumeAfterRestart(client);
  setInterval(() => {
    try {
      tick(client);
    } catch (err) {
      console.error("[twink] tick:", err);
    }
  }, TICK_MS).unref();
}
