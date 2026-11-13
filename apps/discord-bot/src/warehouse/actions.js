// ===================== РАЗБОР СТРОК ЛОГА ФРАКЦИИ =====================
//
// Нас интересуют только действия со складом и машинами фракции:
//   «Берет Carbine Rifle (588608XX) (95%) x1 со склада»
//   «Берет Аптечка EMS x2 из BLOODS05»
//   «Кладет Carbine Rifle (588608XX) (95%) x1 на склад»
//   «Кладет Патроны 5.56mm x30 в BLOODS05»
//   «Берет набор [1 - 7] Броня | 30min: Броня Bloods (М) x1»
// Всё остальное (приём во фракцию, крафт и т.д.) игнорируется.
import { MSK_OFFSET_MS } from "../activity/time.js";
const QTY_X = "[xXхХ×*]";
const MOVE_RE = new RegExp(`^(Бер[её]т|Клад[её]т)\\s+(.+?)(?:\\s+${QTY_X}\\s*(\\d+))?\\s+(со склада|на склад|из\\s+(\\S+)|в\\s+(\\S+))\\s*$`, "iu");
const KIT_RE = /^Бер[её]т набор\s+(.+?)\s*[|│]\s*(\d+)\s*min\s*:\s*(.*)$/iu;
const KIT_NOBAR_RE = /^Бер[её]т набор\s+(.+)$/iu;
/**
 * Строки «Берет/Кладет …», которые не про склад вообще: задания (угон машины и т.п.).
 * Не учитываются и не попадают в «не распознано».
 */
const NOT_WAREHOUSE_RE = /^(Бер[её]т|Клад[её]т)\s+задани/iu;
export const isNotWarehouseRow = (text) => NOT_WAREHOUSE_RE.test(text.replace(/\s+/g, " ").trim());
/**
 * «Броня Bloods (М) x1» → 1 шт.; «Аптечка EMS x2, Бинт x3» → две позиции.
 * Если количество не указано — 1.
 */
export function parseKitContent(content) {
    const result = [];
    for (const part of content.split(/\s*[,;]\s*/)) {
        const raw = part.trim();
        if (!raw)
            continue;
        const m = raw.match(new RegExp(`^(.*?)\\s*${QTY_X}\\s*(\\d+)\\s*$`, "u"));
        const name = (m ? m[1] : raw).trim();
        if (!name)
            continue;
        const qty = m ? Number(m[2]) : 1;
        result.push({ item: cleanItemName(name), rawItem: name, quantity: Number.isFinite(qty) && qty > 0 ? qty : 1 });
    }
    return result;
}
/** «12.11.2026, 16:42:33» (МСК) → UTC ms. NaN, если формат не тот. */
export function parseSiteTime(text) {
    const m = text.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})[,\s]+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m)
        return NaN;
    return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) - MSK_OFFSET_MS;
}
/** Убирает серийник «(588608XX)», «(LSPD1234)» и износ «(95%)» — остаётся название предмета. */
export function cleanItemName(raw) {
    return raw
        .replace(/\s*\(\s*[A-Z]{2,}\d{3,}\s*\)/gi, " ")
        .replace(/\s*\(\s*\d{4,}X{1,3}\s*\)/gi, " ")
        .replace(/\s*\(\s*\d{1,3}%\s*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export function parseAction(row) {
    const time = parseSiteTime(row.time);
    if (!Number.isFinite(time) || !row.characterId)
        return null;
    const text = row.text.replace(/\s+/g, " ").trim();
    if (NOT_WAREHOUSE_RE.test(text))
        return null;
    // Системные записи (например, «Получает припасы из выпавшего армейского груза») — не действия игроков.
    if (row.characterName.trim().toUpperCase() === "SYSTEM")
        return null;
    const base = { time, characterId: row.characterId, characterName: row.characterName, rowId: row.id };
    if (/^Бер[её]т набор/i.test(text)) {
        const m = text.match(KIT_RE);
        if (m) {
            return {
                ...base,
                kind: "kit",
                item: m[1].trim(),
                rawItem: m[1].trim(),
                quantity: 1,
                place: null,
                cooldownMin: Number(m[2]) || 0,
                kitContent: m[3].trim(),
                kitItems: parseKitContent(m[3]),
            };
        }
        const loose = text.match(KIT_NOBAR_RE);
        if (!loose)
            return null;
        return { ...base, kind: "kit", item: loose[1].trim(), rawItem: loose[1].trim(), quantity: 1, place: null, cooldownMin: 0, kitContent: "", kitItems: [] };
    }
    const m = text.match(MOVE_RE);
    if (!m)
        return null;
    const rawItem = m[2].trim();
    const qty = m[3] ? Number(m[3]) : 1;
    const place = m[5] ?? m[6] ?? "склад";
    return {
        ...base,
        kind: m[1].toLowerCase().startsWith("бер") ? "take" : "put",
        item: cleanItemName(rawItem),
        rawItem,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        place,
        cooldownMin: 0,
        kitContent: "",
        kitItems: [],
    };
}
const WEAPON_WORDS = /(rifle|pistol|smg|shotgun|carbine|sniper|revolver|machine\s?gun|assault|pump|\bak-?47\b|\bmp5\b|винтовк|пистолет|автомат|дробовик|карабин|револьвер|снайпер)/i;
/** Оружие узнаём по серийнику/износу в названии («(588608XX)», «(95%)») либо по типовым названиям. */
export function isWeapon(rawItem) {
    return /\(\s*\d{4,}X{1,3}\s*\)/i.test(rawItem) || /\(\s*[A-Z]{2,}\d{3,}\s*\)/.test(rawItem) || /\(\s*\d{1,3}%\s*\)/.test(rawItem) || WEAPON_WORDS.test(rawItem);
}
