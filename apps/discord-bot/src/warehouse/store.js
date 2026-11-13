// ===================== НАСТРОЙКИ ПРОВЕРКИ СКЛАДА =====================
//
// Всё, что меняется командами /sklad, хранится одним JSON-файлом
// (WH_STORE_FILE, по умолчанию ./data/warehouse-store.json) — так же, как у
// счётчика каптов и МП. Бот работает одним процессом, поэтому достаточно схемы
// «загрузили в память → правим → сохраняем».
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
/** Коды из выпадающего списка «Логи фракций» на сайте. */
export const KNOWN_FACTIONS = [
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
export const RULES_VERSION = 3;
export const DEFAULT_SCHEDULE_MINUTES = [0, 360, 720, 1080];
/** Патроны разных калибров считаются отдельно: у каждого свой лимит. */
function ammoRules() {
    return [
        { id: "ammo762", label: "Патроны 7.62", kind: "item", match: ["7.62"], limit: 420, burstCount: 0, burstMinutes: 0 },
        { id: "ammo556", label: "Патроны 5.56", kind: "item", match: ["5.56"], limit: 420, burstCount: 0, burstMinutes: 0 },
        { id: "ammo1143", label: "Патроны 11.43", kind: "item", match: ["11.43"], limit: 200, burstCount: 0, burstMinutes: 0 },
        { id: "ammo9", label: "Патроны 9mm", kind: "item", match: ["9mm", "9 mm", "9мм"], limit: 400, burstCount: 0, burstMinutes: 0 },
        { id: "ammo12", label: "Патроны 12mm", kind: "item", match: ["12mm", "12 mm", "12мм"], limit: 100, burstCount: 0, burstMinutes: 0 },
        { id: "ammo45", label: "Патроны .45", kind: "item", match: [".45"], limit: 300, burstCount: 0, burstMinutes: 0 },
        { id: "ammo50", label: "Патроны .50", kind: "item", match: [".50"], limit: 60, burstCount: 0, burstMinutes: 0 },
    ];
}
export function defaultRules() {
    return [
        { id: "weapon", label: "Оружие", kind: "item", match: ["@weapon"], limit: 6, burstCount: 4, burstMinutes: 3 },
        ...ammoRules(),
        // Остальные патроны (другой калибр, «Патроны» без калибра).
        { id: "ammo", label: "Патроны (прочие)", kind: "item", match: ["патрон", "ammo", "mm"], limit: 400, burstCount: 0, burstMinutes: 0 },
        { id: "armor", label: "Броня", kind: "item", match: ["брон"], limit: 10, burstCount: 5, burstMinutes: 3 },
        { id: "medkit", label: "Аптечки и бинты", kind: "item", match: ["аптеч", "бинт"], limit: 30, burstCount: 0, burstMinutes: 0 },
        { id: "spank", label: "SPANK", kind: "item", match: ["spank"], limit: 100, burstCount: 0, burstMinutes: 0 },
        { id: "analgesic", label: "Анальгетик", kind: "item", match: ["анальгетик"], limit: 60, burstCount: 0, burstMinutes: 0 },
        { id: "ration", label: "Паек", kind: "item", match: ["паек"], limit: 50, burstCount: 0, burstMinutes: 0 },
        { id: "other", label: "Прочее", kind: "item", match: ["*"], limit: 100, burstCount: 0, burstMinutes: 0 },
        { id: "kit", label: "Наборы", kind: "kit", match: ["*"], limit: 14, burstCount: 0, burstMinutes: 0 },
    ];
}
/**
 * Обновление старых сохранённых правил: добавляет правила по умолчанию, которых там ещё нет
 * (патроны по калибрам, SPANK, анальгетик, паёк). Уже существующие правила и их лимиты не трогаются.
 * Патроны по калибрам встают перед общим «ammo», остальные — перед универсальным «Прочее».
 */
function migrateRules(rules) {
    const result = rules.map((r) => ({ ...r }));
    const ammo = result.find((r) => r.id === "ammo");
    if (ammo && ammo.label === "Патроны") {
        ammo.label = "Патроны (прочие)";
        if (!ammo.match.includes("mm"))
            ammo.match = [...ammo.match, "mm"];
    }
    for (const rule of defaultRules()) {
        if (result.some((r) => r.id === rule.id))
            continue;
        const isCaliber = rule.id.startsWith("ammo") && rule.id !== "ammo";
        let idx = isCaliber ? result.findIndex((r) => r.id === "ammo") : -1;
        if (idx === -1)
            idx = result.findIndex((r) => r.kind === rule.kind && r.match.includes("*"));
        if (idx === -1)
            idx = result.length;
        result.splice(idx, 0, { ...rule });
    }
    return result;
}
function defaultFactions() {
    return ["F_GANG_BLOODS", "F_GANG_GROVE", "F_GANG_MARABUNTA"].map((code) => {
        const f = KNOWN_FACTIONS.find((k) => k.code === code);
        return { code: f.code, name: f.name };
    });
}
function emptyStore() {
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
        scheduleMinutes: [...DEFAULT_SCHEDULE_MINUTES],
        rulesVersion: RULES_VERSION,
        pendingItems: {},
        lastRuns: {},
        lastRunSummary: null,
    };
}
function normalizeSchedule(value) {
    if (!Array.isArray(value))
        return null;
    const list = [...new Set(value.filter((n) => Number.isInteger(n) && n >= 0 && n < 1440))].sort((a, b) => a - b);
    return list.length ? list : null;
}
const DATA_FILE = process.env.WH_STORE_FILE || `${process.cwd()}/data/warehouse-store.json`;
function load() {
    const base = emptyStore();
    try {
        if (existsSync(DATA_FILE)) {
            const raw = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
            return {
                guildId: typeof raw.guildId === "string" ? raw.guildId : base.guildId,
                channelId: typeof raw.channelId === "string" ? raw.channelId : base.channelId,
                enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
                lastCheckedUntilMs: typeof raw.lastCheckedUntilMs === "number" ? raw.lastCheckedUntilMs : base.lastCheckedUntilMs,
                siteServerId: typeof raw.siteServerId === "string" ? raw.siteServerId : base.siteServerId,
                factions: Array.isArray(raw.factions) ? raw.factions : base.factions,
                rules: Array.isArray(raw.rules) && raw.rules.length
                    ? (raw.rulesVersion ?? 1) < RULES_VERSION
                        ? migrateRules(raw.rules)
                        : raw.rules
                    : base.rules,
                rulesVersion: RULES_VERSION,
                pendingItems: raw.pendingItems && typeof raw.pendingItems === "object" ? raw.pendingItems : base.pendingItems,
                scheduleMinutes: normalizeSchedule(raw.scheduleMinutes) ?? base.scheduleMinutes,
                netReturns: typeof raw.netReturns === "boolean" ? raw.netReturns : base.netReturns,
                kitCooldownCheck: typeof raw.kitCooldownCheck === "boolean" ? raw.kitCooldownCheck : base.kitCooldownCheck,
                kitCooldownViolations: typeof raw.kitCooldownViolations === "number" ? raw.kitCooldownViolations : base.kitCooldownViolations,
                exclusions: Array.isArray(raw.exclusions) ? raw.exclusions : base.exclusions,
                lastRuns: raw.lastRuns && typeof raw.lastRuns === "object" ? raw.lastRuns : base.lastRuns,
                lastRunSummary: raw.lastRunSummary ?? base.lastRunSummary,
            };
        }
    }
    catch (err) {
        console.error("[warehouse] Не удалось прочитать файл настроек, начинаю с настроек по умолчанию:", err);
    }
    return base;
}
const data = load();
let saveScheduled = false;
function persist() {
    if (saveScheduled)
        return;
    saveScheduled = true;
    queueMicrotask(() => {
        saveScheduled = false;
        try {
            mkdirSync(dirname(DATA_FILE), { recursive: true });
            writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
        }
        catch (err) {
            console.error("[warehouse] Не удалось сохранить файл настроек:", err);
        }
    });
}
// ---- чтение ----
export const getSettings = () => data;
export const getRules = () => data.rules;
export const getFactions = () => data.factions;
export const getExclusions = () => data.exclusions;
export const getSchedule = () => data.scheduleMinutes;
export const getExcludedIds = () => new Set(data.exclusions.map((e) => e.characterId));
// ---- канал, сервер сайта, флаги ----
export function setChannel(guildId, channelId) {
    data.guildId = guildId;
    data.channelId = channelId;
    persist();
}
export function setEnabled(value) {
    data.enabled = value;
    persist();
}
/** Сдвигает «проверено до» вперёд (назад не двигает). */
export function markCheckedUntil(ms) {
    if (data.lastCheckedUntilMs !== null && ms <= data.lastCheckedUntilMs)
        return;
    data.lastCheckedUntilMs = ms;
    persist();
}
export function setSchedule(minutes) {
    data.scheduleMinutes = normalizeSchedule(minutes) ?? data.scheduleMinutes;
    persist();
    return data.scheduleMinutes;
}
export function setNetReturns(value) {
    data.netReturns = value;
    persist();
}
export function setKitCooldown(check, violations) {
    if (check !== undefined)
        data.kitCooldownCheck = check;
    if (violations !== undefined)
        data.kitCooldownViolations = violations;
    persist();
}
// ---- фракции ----
export function addFaction(code) {
    const known = KNOWN_FACTIONS.find((f) => f.code === code);
    if (!known || data.factions.some((f) => f.code === code))
        return null;
    const entry = { code: known.code, name: known.name };
    data.factions.push(entry);
    persist();
    return entry;
}
export function removeFaction(code) {
    const before = data.factions.length;
    data.factions = data.factions.filter((f) => f.code !== code);
    if (data.factions.length === before)
        return false;
    persist();
    return true;
}
// ---- правила (пороги) ----
export function findRule(id) {
    return data.rules.find((r) => r.id === id);
}
export function updateRule(id, patch) {
    const rule = findRule(id);
    if (!rule)
        return null;
    Object.assign(rule, patch);
    persist();
    return rule;
}
/** Новое правило вставляется перед универсальным («*»), чтобы оно успело сработать. */
export function addRule(rule) {
    if (findRule(rule.id))
        return false;
    const idx = data.rules.findIndex((r) => r.kind === rule.kind && r.match.includes("*"));
    if (idx === -1)
        data.rules.push(rule);
    else
        data.rules.splice(idx, 0, rule);
    persist();
    return true;
}
export function removeRule(id) {
    const rule = findRule(id);
    // Универсальные правила нельзя удалять: иначе часть предметов вообще перестанет проверяться.
    if (!rule || rule.match.includes("*"))
        return false;
    data.rules = data.rules.filter((r) => r.id !== id);
    persist();
    return true;
}
export function resetRules() {
    data.rules = defaultRules();
    persist();
}
// ---- новые предметы: вопрос про лимит ----
export const getPendingItems = () => data.pendingItems;
export function isItemPending(name) {
    const key = name.trim().toLowerCase();
    return Object.values(data.pendingItems).some((p) => p.name.trim().toLowerCase() === key);
}
export function addPendingItem(messageId, name) {
    data.pendingItems[messageId] = { name, askedAt: Date.now() };
    persist();
}
export function removePendingItem(messageId) {
    delete data.pendingItems[messageId];
    persist();
}
/** Правило для нового предмета: отдельная категория с названием предмета и заданным лимитом. */
export function addItemRule(name, limit) {
    const label = name.trim().slice(0, 40);
    const slug = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "item";
    let id = `auto-${slug}`;
    for (let n = 2; findRule(id); n++)
        id = `auto-${slug}-${n}`;
    const rule = { id, label, kind: "item", match: [label.toLowerCase()], limit, burstCount: 0, burstMinutes: 0 };
    addRule(rule);
    return rule;
}
// ---- исключения ----
export function addExclusion(characterId, note) {
    if (data.exclusions.some((e) => e.characterId === characterId))
        return false;
    data.exclusions.push({ characterId, note });
    persist();
    return true;
}
export function removeExclusion(characterId) {
    const before = data.exclusions.length;
    data.exclusions = data.exclusions.filter((e) => e.characterId !== characterId);
    if (data.exclusions.length === before)
        return false;
    persist();
    return true;
}
// ---- журнал запусков ----
export function markPeriodDone(periodKey) {
    data.lastRuns[periodKey] = Date.now();
    // Храним только последние недели — файл не должен расти бесконечно.
    const keys = Object.keys(data.lastRuns).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 60)))
        delete data.lastRuns[k];
    persist();
}
export const isPeriodDone = (periodKey) => periodKey in data.lastRuns;
export function setLastRunSummary(summary) {
    data.lastRunSummary = summary;
    persist();
}
