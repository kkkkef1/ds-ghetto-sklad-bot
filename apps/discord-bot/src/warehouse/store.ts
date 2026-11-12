// ===================== НАСТРОЙКИ ПРОВЕРКИ СКЛАДА =====================
//
// Всё, что меняется командами /sklad, хранится одним JSON-файлом
// (WH_STORE_FILE, по умолчанию ./data/warehouse-store.json) — так же, как у
// счётчика каптов и МП. Бот работает одним процессом, поэтому достаточно схемы
// «загрузили в память → правим → сохраняем».

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Rule {
  /** Короткий идентификатор (латиница), по нему правило выбирается в командах. */
  id: string;
  /** Название в отчёте: «Оружие», «Броня» … */
  label: string;
  /** item — предметы со склада/машин, kit — наборы («Берет набор …»). */
  kind: "item" | "kit";
  /**
   * Что считать этим правилом. Подстроки названия предмета (без учёта регистра);
   * «@weapon» — любое оружие (по серийнику/износу), «*» — всё остальное.
   * Правила проверяются сверху вниз, срабатывает первое подходящее.
   */
  match: string[];
  /** Сколько можно взять за период (6 часов). 0 — не проверять. */
  limit: number;
  /** Всплеск: от скольких штук за burstMinutes минут считать подозрительным. 0 — не проверять. */
  burstCount: number;
  burstMinutes: number;
}

export interface FactionSetting {
  /** Код на сайте, например F_GANG_BLOODS. */
  code: string;
  /** Название в отчёте. */
  name: string;
}

export interface KnownFaction extends FactionSetting {}

/** Коды из выпадающего списка «Логи фракций» на сайте. */
export const KNOWN_FACTIONS: KnownFaction[] = [
  { code: "F_GANG_BLOODS", name: "Bloods" },
  { code: "F_GANG_GROVE", name: "The Families" },
  { code: "F_GANG_MARABUNTA", name: "Marabunta Grande" },
  { code: "F_GANG_BALLAS", name: "The Ballas Gang" },
  { code: "F_GANG_VAGOS", name: "Los Santos Vagos" },
  { code: "F_MEXICOMAFIA", name: "Мексиканская Мафия" },
  { code: "F_ITALYMAFIA", name: "Итальянская Мафия" },
  { code: "F_ARMENIAMAFIA", name: "Армянская Мафия" },
  { code: "F_RUSSIANMAFIA", name: "Русская Мафия" },
  { code: "F_YAKUZA", name: "Японская Мафия" },
];

export interface Exclusion {
  characterId: string;
  note: string;
}

interface StoreData {
  guildId: string | null;
  channelId: string | null;
  /** false — автопроверка по расписанию выключена (ручные /sklad run и /sklad force работают). */
  enabled: boolean;
  /** До какого момента (UTC ms) логи уже проверены и отчёт ушёл в канал; от него считает /sklad force. */
  lastCheckedUntilMs: number | null;
  /** Сервер на сайте (Redwood = 17). */
  siteServerId: string;
  factions: FactionSetting[];
  rules: Rule[];
  netReturns: boolean;
  kitCooldownCheck: boolean;
  kitCooldownViolations: number;
  exclusions: Exclusion[];
  /** Ключ периода («2026-11-12-12» = период, закончившийся 12.11 в 12:00 МСК) → когда обработан. */
  lastRuns: Record<string, number>;
  /** Когда бот последний раз успешно закончил проверку (для /sklad status). */
  lastRunSummary: { at: number; period: string; ok: boolean; text: string } | null;
}

export function defaultRules(): Rule[] {
  return [
    { id: "weapon", label: "Оружие", kind: "item", match: ["@weapon"], limit: 6, burstCount: 4, burstMinutes: 3 },
    { id: "ammo", label: "Патроны", kind: "item", match: ["патрон", "ammo"], limit: 400, burstCount: 0, burstMinutes: 0 },
    { id: "armor", label: "Броня", kind: "item", match: ["брон"], limit: 10, burstCount: 5, burstMinutes: 3 },
    { id: "medkit", label: "Аптечки и бинты", kind: "item", match: ["аптеч", "бинт"], limit: 30, burstCount: 0, burstMinutes: 0 },
    { id: "other", label: "Прочее", kind: "item", match: ["*"], limit: 100, burstCount: 0, burstMinutes: 0 },
    { id: "kit", label: "Наборы", kind: "kit", match: ["*"], limit: 14, burstCount: 0, burstMinutes: 0 },
  ];
}

function defaultFactions(): FactionSetting[] {
  return ["F_GANG_BLOODS", "F_GANG_GROVE", "F_GANG_MARABUNTA"].map((code) => {
    const f = KNOWN_FACTIONS.find((k) => k.code === code)!;
    return { code: f.code, name: f.name };
  });
}

function emptyStore(): StoreData {
  return {
    guildId: null,
    channelId: null,
    enabled: true,
    lastCheckedUntilMs: null,
    siteServerId: process.env.WH_SERVER_ID?.trim() || "17",
    factions: defaultFactions(),
    rules: defaultRules(),
    netReturns: true,
    kitCooldownCheck: true,
    kitCooldownViolations: 2,
    exclusions: [],
    lastRuns: {},
    lastRunSummary: null,
  };
}

const DATA_FILE = process.env.WH_STORE_FILE || `${process.cwd()}/data/warehouse-store.json`;

function load(): StoreData {
  const base = emptyStore();
  try {
    if (existsSync(DATA_FILE)) {
      const raw = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Partial<StoreData>;
      return {
        guildId: typeof raw.guildId === "string" ? raw.guildId : base.guildId,
        channelId: typeof raw.channelId === "string" ? raw.channelId : base.channelId,
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
        lastCheckedUntilMs: typeof raw.lastCheckedUntilMs === "number" ? raw.lastCheckedUntilMs : base.lastCheckedUntilMs,
        siteServerId: typeof raw.siteServerId === "string" ? raw.siteServerId : base.siteServerId,
        factions: Array.isArray(raw.factions) ? raw.factions : base.factions,
        rules: Array.isArray(raw.rules) && raw.rules.length ? raw.rules : base.rules,
        netReturns: typeof raw.netReturns === "boolean" ? raw.netReturns : base.netReturns,
        kitCooldownCheck: typeof raw.kitCooldownCheck === "boolean" ? raw.kitCooldownCheck : base.kitCooldownCheck,
        kitCooldownViolations: typeof raw.kitCooldownViolations === "number" ? raw.kitCooldownViolations : base.kitCooldownViolations,
        exclusions: Array.isArray(raw.exclusions) ? raw.exclusions : base.exclusions,
        lastRuns: raw.lastRuns && typeof raw.lastRuns === "object" ? raw.lastRuns : base.lastRuns,
        lastRunSummary: raw.lastRunSummary ?? base.lastRunSummary,
      };
    }
  } catch (err) {
    console.error("[warehouse] Не удалось прочитать файл настроек, начинаю с настроек по умолчанию:", err);
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
      console.error("[warehouse] Не удалось сохранить файл настроек:", err);
    }
  });
}

// ---- чтение ----

export const getSettings = (): Readonly<StoreData> => data;
export const getRules = (): Rule[] => data.rules;
export const getFactions = (): FactionSetting[] => data.factions;
export const getExclusions = (): Exclusion[] => data.exclusions;
export const getExcludedIds = (): Set<string> => new Set(data.exclusions.map((e) => e.characterId));

// ---- канал, сервер сайта, флаги ----

export function setChannel(guildId: string, channelId: string): void {
  data.guildId = guildId;
  data.channelId = channelId;
  persist();
}

export function setEnabled(value: boolean): void {
  data.enabled = value;
  persist();
}

/** Сдвигает «проверено до» вперёд (назад не двигает). */
export function markCheckedUntil(ms: number): void {
  if (data.lastCheckedUntilMs !== null && ms <= data.lastCheckedUntilMs) return;
  data.lastCheckedUntilMs = ms;
  persist();
}

export function setNetReturns(value: boolean): void {
  data.netReturns = value;
  persist();
}

export function setKitCooldown(check: boolean | undefined, violations: number | undefined): void {
  if (check !== undefined) data.kitCooldownCheck = check;
  if (violations !== undefined) data.kitCooldownViolations = violations;
  persist();
}

// ---- фракции ----

export function addFaction(code: string): FactionSetting | null {
  const known = KNOWN_FACTIONS.find((f) => f.code === code);
  if (!known || data.factions.some((f) => f.code === code)) return null;
  const entry = { code: known.code, name: known.name };
  data.factions.push(entry);
  persist();
  return entry;
}

export function removeFaction(code: string): boolean {
  const before = data.factions.length;
  data.factions = data.factions.filter((f) => f.code !== code);
  if (data.factions.length === before) return false;
  persist();
  return true;
}

// ---- правила (пороги) ----

export function findRule(id: string): Rule | undefined {
  return data.rules.find((r) => r.id === id);
}

export function updateRule(
  id: string,
  patch: Partial<Pick<Rule, "limit" | "burstCount" | "burstMinutes" | "label" | "match">>
): Rule | null {
  const rule = findRule(id);
  if (!rule) return null;
  Object.assign(rule, patch);
  persist();
  return rule;
}

/** Новое правило вставляется перед универсальным («*»), чтобы оно успело сработать. */
export function addRule(rule: Rule): boolean {
  if (findRule(rule.id)) return false;
  const idx = data.rules.findIndex((r) => r.kind === rule.kind && r.match.includes("*"));
  if (idx === -1) data.rules.push(rule);
  else data.rules.splice(idx, 0, rule);
  persist();
  return true;
}

export function removeRule(id: string): boolean {
  const rule = findRule(id);
  // Универсальные правила нельзя удалять: иначе часть предметов вообще перестанет проверяться.
  if (!rule || rule.match.includes("*")) return false;
  data.rules = data.rules.filter((r) => r.id !== id);
  persist();
  return true;
}

export function resetRules(): void {
  data.rules = defaultRules();
  persist();
}

// ---- исключения ----

export function addExclusion(characterId: string, note: string): boolean {
  if (data.exclusions.some((e) => e.characterId === characterId)) return false;
  data.exclusions.push({ characterId, note });
  persist();
  return true;
}

export function removeExclusion(characterId: string): boolean {
  const before = data.exclusions.length;
  data.exclusions = data.exclusions.filter((e) => e.characterId !== characterId);
  if (data.exclusions.length === before) return false;
  persist();
  return true;
}

// ---- журнал запусков ----

export function markPeriodDone(periodKey: string): void {
  data.lastRuns[periodKey] = Date.now();
  // Храним только последние недели — файл не должен расти бесконечно.
  const keys = Object.keys(data.lastRuns).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete data.lastRuns[k];
  persist();
}

export const isPeriodDone = (periodKey: string): boolean => periodKey in data.lastRuns;

export function setLastRunSummary(summary: NonNullable<StoreData["lastRunSummary"]>): void {
  data.lastRunSummary = summary;
  persist();
}
