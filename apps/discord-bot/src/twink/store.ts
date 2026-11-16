// ===================== НАСТРОЙКИ И СОСТОЯНИЕ ПРОВЕРКИ ТВИНКОВ =====================
//
// Один JSON-файл (TWINK_STORE_FILE, по умолчанию ./data/twink-store.json), как у склада.
// Список проверяемых фракций общий со складом (/sklad faction), здесь он не хранится.
// Состояние идущей проверки (что уже проверено, что найдено) тоже лежит здесь, поэтому
// после перезапуска бота проверка продолжается с того места, где остановилась.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CustomFactions } from "./rules.js";

/** Меньше 4000 мс пауза быть не может (требование владельца). */
export const MIN_DELAY_MS = 4000;
export const DEFAULT_DELAY_MS = 5000;

/** Ссылки на списки участников по умолчанию; меняются командой /twink link. */
export const DEFAULT_LINKS: Record<string, string> = {
  F_GANG_BLOODS: "https://gta5rp.com/mi?act=faction_members&sid=17&faction=F_GANG_BLOODS",
  F_GANG_BALLAS: "https://gta5rp.com/mi?act=faction_members&faction=F_GANG_BALLAS&sid=17",
  F_GANG_VAGOS: "https://gta5rp.com/mi?act=faction_members&faction=F_GANG_VAGOS&sid=17",
  F_GANG_MARABUNTA: "https://gta5rp.com/mi?act=faction_members&sid=17&faction=F_GANG_MARABUNTA",
  F_GANG_GROVE: "https://gta5rp.com/mi?act=faction_members&faction=F_GANG_GROVE&sid=17",
};

export interface TwinkSettings {
  guildId: string | null;
  channelId: string | null;
  /** Автозапуск по расписанию. Ручные /twink force работают всегда. */
  enabled: boolean;
  /** Дни недели публикации (0 = воскресенье … 6 = суббота, МСК). По умолчанию среда и воскресенье. */
  days: number[];
  /** Во сколько результат должен быть опубликован, минуты от полуночи МСК (540 = 09:00). */
  publishMinutes: number;
  /** За сколько часов до публикации стартует проверка. */
  leadHours: number;
  /** Пауза перед каждым нажатием «(ч)», мс (не меньше 4000). */
  delayMs: number;
  /** Случайная добавка к паузе 0…jitterMs, мс (пауза никогда не короче delayMs). */
  jitterMs: number;
  /** Сколько ждать окно со списком персонажей после нажатия, мс. */
  waitModalMs: number;
  /** Как часто обновлять сообщение о ходе проверки, секунд (10…3600). */
  progressSeconds: number;
  /** Что писать после «by». */
  nickname: string;
  /** Не нажимать «(ч)» у тех, чьи ID уже встретились. */
  skipSeen: boolean;
  /** Оборачивать результат в блок кода (удобно копировать). */
  codeBlock: boolean;
  /** Свои ссылки на списки участников (код фракции → адрес). */
  links: Record<string, string>;
  /** Фракции, добавленные владельцем: название на сайте → категория и короткий код. */
  customFactions: CustomFactions;
  /** Вопросы владельцу про неизвестные фракции: id сообщения в личке → название. */
  pendingFactions: Record<string, string>;
  /** Ключи завершённых запусков по расписанию (дата публикации), чтобы не запускать дважды. */
  doneRuns: Record<string, number>;
  lastRun: { at: number; kind: string; text: string } | null;
}

export interface FactionProgress {
  code: string;
  name: string;
  /** Сколько кнопок «(ч)» на странице (известно после подсчёта). */
  total: number | null;
  /** Ключи уже обработанных строк. */
  done: string[];
  finished: boolean;
}

export interface Finding {
  factionName: string;
  groupKey: string;
  header: string[];
  offwarn: string[];
}

export interface RunState {
  id: string;
  kind: "auto" | "manual";
  startedAt: number;
  /** Когда результат должен быть готов (для автозапуска). */
  publishAtMs: number | null;
  status: "queued" | "running" | "paused" | "stopping";
  pauseReason: string | null;
  factions: FactionProgress[];
  /** ID персонажей, уже встретившихся в окнах «(ч)». */
  seenIds: string[];
  findings: Finding[];
  /** Сколько раз реально нажали «(ч)» / сколько пропустили как повтор. */
  clicked: number;
  skipped: number;
  /** Секунды, потраченные на уже обработанные строки (для оценки времени окончания). */
  workMs: number;
  progressMessageId: string | null;
  /** Кто запустил (для ручной проверки), для сообщений. */
  startedBy: string | null;
}

interface StoreData extends TwinkSettings {
  run: RunState | null;
}

function emptyStore(): StoreData {
  return {
    guildId: null,
    channelId: null,
    enabled: true,
    days: [3, 0],
    publishMinutes: 9 * 60,
    leadHours: 3,
    delayMs: DEFAULT_DELAY_MS,
    jitterMs: 1000,
    waitModalMs: 1200,
    progressSeconds: 60,
    nickname: "Фамилия",
    skipSeen: true,
    codeBlock: true,
    links: {},
    customFactions: {},
    pendingFactions: {},
    doneRuns: {},
    lastRun: null,
    run: null,
  };
}

const DATA_FILE = process.env.TWINK_STORE_FILE || `${process.cwd()}/data/twink-store.json`;

function load(): StoreData {
  const base = emptyStore();
  try {
    if (existsSync(DATA_FILE)) {
      const raw = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Partial<StoreData>;
      return { ...base, ...raw, delayMs: Math.max(MIN_DELAY_MS, Number(raw.delayMs) || base.delayMs) };
    }
  } catch (err) {
    console.error("[twink] Не удалось прочитать файл настроек, начинаю с настроек по умолчанию:", err);
  }
  return base;
}

const data: StoreData = load();
let saveScheduled = false;

export function persist(): void {
  if (saveScheduled) return;
  saveScheduled = true;
  queueMicrotask(() => {
    saveScheduled = false;
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[twink] Не удалось сохранить файл настроек:", err);
    }
  });
}

export const getSettings = (): Readonly<TwinkSettings> => data;
export const getRun = (): RunState | null => data.run;

/** Правка настроек одним патчем. delayMs не опускается ниже MIN_DELAY_MS. */
export function patchSettings(patch: Partial<TwinkSettings>): void {
  Object.assign(data, patch);
  if (patch.delayMs !== undefined) data.delayMs = Math.max(MIN_DELAY_MS, patch.delayMs);
  persist();
}

export function linkFor(code: string): string | null {
  return data.links[code] ?? DEFAULT_LINKS[code] ?? null;
}

export function setLink(code: string, url: string | null): void {
  if (url) data.links[code] = url;
  else delete data.links[code];
  persist();
}

// ---- фракции, добавленные владельцем ----

export function addCustomFaction(name: string, category: CustomFactions[string]["category"], code: string): void {
  data.customFactions[name] = { category, code };
  persist();
}

export function removeCustomFaction(name: string): boolean {
  if (!(name in data.customFactions)) return false;
  delete data.customFactions[name];
  persist();
  return true;
}

export function addPendingFaction(messageId: string, name: string): void {
  data.pendingFactions[messageId] = name;
  persist();
}

export function removePendingFaction(messageId: string): void {
  delete data.pendingFactions[messageId];
  persist();
}

export const isFactionPending = (name: string): boolean => Object.values(data.pendingFactions).includes(name);

// ---- запуск ----

export function setRun(run: RunState | null): void {
  data.run = run;
  persist();
}

export function markDone(key: string): void {
  data.doneRuns[key] = Date.now();
  const keys = Object.keys(data.doneRuns).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete data.doneRuns[k];
  persist();
}

export const isDone = (key: string): boolean => key in data.doneRuns;

export function setLastRun(text: string, kind: string): void {
  data.lastRun = { at: Date.now(), kind, text };
  persist();
}
