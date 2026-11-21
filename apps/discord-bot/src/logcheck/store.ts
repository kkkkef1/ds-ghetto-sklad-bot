// ===================== НАСТРОЙКИ ПРОВЕРКИ ЛОГОВ =====================
//
// Канал, время запуска, список слов и журнал «за какие сутки уже отправлено» — один JSON-файл
// (LC_STORE_FILE, по умолчанию ./data/logcheck-store.json). Сами логи нигде не сохраняются:
// они живут в памяти только на время проверки.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultWords, type WordEntry, type WordLevel } from "./words.js";

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
}

export const DEFAULT_START_MINUTE = 10;

function emptyStore(): StoreData {
  return { guildId: null, channelId: null, enabled: true, startMinute: DEFAULT_START_MINUTE, words: defaultWords(), lastRuns: {}, lastRunSummary: null };
}

const DATA_FILE = process.env.LC_STORE_FILE || `${process.cwd()}/data/logcheck-store.json`;

function load(): StoreData {
  const base = emptyStore();
  try {
    if (existsSync(DATA_FILE)) {
      const raw = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Partial<StoreData>;
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
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
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
