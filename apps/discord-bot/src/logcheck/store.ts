// ===================== НАСТРОЙКИ ПРОВЕРКИ ЛОГОВ =====================
//
// Канал, время запуска, список слов и журнал «за какие сутки уже отправлено» — один JSON-файл
// (LC_STORE_FILE, по умолчанию ./data/logcheck-store.json). Сами логи нигде не сохраняются:
// они живут в памяти только на время проверки.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultWords, type WordEntry, type WordLevel } from "./words.js";
import { hasStoreFile, readStoreFile, registerStoreFile, writeStoreFile } from "../storage.js";

interface StoreData {
  guildId: string | null;
  channelId: string | null;
  enabled: boolean;
  /** Во сколько запускать проверку за вчера: минуты от 00:00 МСК (по умолчанию 10 = 00:10). */
  startMinute: number;
  words: WordEntry[];
  /** «2026-11-20» (проверенные сутки) → когда отправлена сводка. Хранятся последние 60. */
  lastRuns: Record<string, number>;
  lastRunSummary: { at: number; day: string; ok: boolean; text: string } | null;
  /** Недельная сводка по понедельникам в 00:30 включена. */
  weeklyEnabled: boolean;
  /** «2026-11-16» (понедельник отчётной недели) → когда отправлена недельная сводка. Хранятся последние 30. */
  weeklyRuns: Record<string, number>;
  /**
   * Итоги ПВП по суткам для недельной сводки: «2026-11-20» → фракция (код) → название и число уникальных игроков
   * по каждому мероприятию. Это только счётчики, самих логов здесь нет. Хранятся последние 120 суток.
   */
  history: Record<string, DayStats>;
}

export type DayStats = Record<string, { name: string; events: Record<string, number>; incomplete?: boolean }>;

export const DEFAULT_START_MINUTE = 10;

function emptyStore(): StoreData {
  return { guildId: null, channelId: null, enabled: true, startMinute: DEFAULT_START_MINUTE, words: defaultWords(), lastRuns: {}, lastRunSummary: null, weeklyEnabled: true, weeklyRuns: {}, history: {} };
}

const DATA_FILE = process.env.LC_STORE_FILE || `${process.cwd()}/data/logcheck-store.json`;
registerStoreFile(DATA_FILE);

function load(): StoreData {
  const base = emptyStore();
  try {
    if (hasStoreFile(DATA_FILE)) {
      const raw = JSON.parse(readStoreFile(DATA_FILE)) as Partial<StoreData>;
      const words = Array.isArray(raw.words)
        ? raw.words.filter((w): w is WordEntry => !!w && typeof w.word === "string" && (w.level === "hard" || w.level === "soft"))
        : [];
      return {
        guildId: typeof raw.guildId === "string" ? raw.guildId : base.guildId,
        channelId: typeof raw.channelId === "string" ? raw.channelId : base.channelId,
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
        startMinute: typeof raw.startMinute === "number" && raw.startMinute >= 0 && raw.startMinute < 1440 ? raw.startMinute : base.startMinute,
        words: words.length || Array.isArray(raw.words) ? words : base.words,
        lastRuns: raw.lastRuns && typeof raw.lastRuns === "object" ? raw.lastRuns : base.lastRuns,
        lastRunSummary: raw.lastRunSummary ?? base.lastRunSummary,
        weeklyEnabled: typeof raw.weeklyEnabled === "boolean" ? raw.weeklyEnabled : base.weeklyEnabled,
        weeklyRuns: raw.weeklyRuns && typeof raw.weeklyRuns === "object" ? raw.weeklyRuns : base.weeklyRuns,
        history: raw.history && typeof raw.history === "object" ? raw.history : base.history,
      };
    }
  } catch (err) {
    console.error("[logcheck] Не удалось прочитать файл настроек, начинаю с настроек по умолчанию:", err);
  }
  return base;
}

const data: StoreData = load();
let saveScheduled = false;

function persist(): void {
  if (saveScheduled) return;
  saveScheduled = true;
  queueMicrotask(() => {
    saveScheduled = false;
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      writeStoreFile(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[logcheck] Не удалось сохранить файл настроек:", err);
    }
  });
}

export const getSettings = (): Readonly<StoreData> => data;
export const getWords = (): WordEntry[] => data.words;

export function setChannel(guildId: string, channelId: string): void {
  data.guildId = guildId;
  data.channelId = channelId;
  persist();
}

export function setEnabled(value: boolean): void {
  data.enabled = value;
  persist();
}

export function setStartMinute(minute: number): void {
  data.startMinute = minute;
  persist();
}

// ---- слова ----

/** true — добавлено или перенесено на другой уровень; false — уже есть с таким же уровнем. */
export function addWord(word: string, level: WordLevel): boolean {
  const existing = data.words.find((w) => w.word === word);
  if (existing) {
    if (existing.level === level) return false;
    existing.level = level;
  } else data.words.push({ word, level });
  persist();
  return true;
}

export function removeWord(word: string): boolean {
  const before = data.words.length;
  data.words = data.words.filter((w) => w.word !== word);
  if (data.words.length === before) return false;
  persist();
  return true;
}

export function resetWords(): void {
  data.words = defaultWords();
  persist();
}

// ---- журнал запусков ----

export const isDayDone = (dateKey: string): boolean => dateKey in data.lastRuns;

export function markDayDone(dateKey: string): void {
  data.lastRuns[dateKey] = Date.now();
  const keys = Object.keys(data.lastRuns).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete data.lastRuns[k];
  persist();
}

export function setLastRunSummary(summary: NonNullable<StoreData["lastRunSummary"]>): void {
  data.lastRunSummary = summary;
  persist();
}

// ---- история ПВП и недельные сводки ----

const HISTORY_KEEP_DAYS = 120;

export const getHistory = (): Readonly<Record<string, DayStats>> => data.history;
export const hasDayStats = (dateKey: string): boolean => dateKey in data.history;

/** Запоминает итоги суток по прочитанным фракциям (фракции с ошибкой не трогаем). Повторная проверка суток обновляет данные. */
export function recordDayStats(dateKey: string, factions: { code: string; name: string; error?: string; incomplete: boolean; pvp: Map<string, Set<string>> }[]): void {
  const day: DayStats = { ...(data.history[dateKey] ?? {}) };
  let any = false;
  for (const f of factions) {
    if (f.error) continue;
    day[f.code] = {
      name: f.name,
      events: Object.fromEntries([...f.pvp.entries()].map(([event, ids]) => [event, ids.size])),
      ...(f.incomplete ? { incomplete: true } : {}),
    };
    any = true;
  }
  if (!any) return;
  data.history[dateKey] = day;
  const keys = Object.keys(data.history).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - HISTORY_KEEP_DAYS))) delete data.history[k];
  persist();
}

export const setWeeklyEnabled = (value: boolean): void => {
  data.weeklyEnabled = value;
  persist();
};

export const isWeekDone = (weekStart: string): boolean => weekStart in data.weeklyRuns;

export function markWeekDone(weekStart: string): void {
  data.weeklyRuns[weekStart] = Date.now();
  const keys = Object.keys(data.weeklyRuns).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete data.weeklyRuns[k];
  persist();
}
