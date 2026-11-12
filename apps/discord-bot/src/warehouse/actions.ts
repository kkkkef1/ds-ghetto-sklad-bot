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
import type { LogRow } from "./logsPage.js";

export type ActionKind = "take" | "put" | "kit";

export interface WarehouseAction {
  kind: ActionKind;
  /** Момент действия, UTC ms. */
  time: number;
  characterId: string;
  characterName: string;
  /** Для take/put — название предмета без серийника и износа; для kit — «[1 - 7] Броня». */
  item: string;
  /** Исходное название предмета (с серийником) — для оружия нужно, чтобы отличить его от остального. */
  rawItem: string;
  quantity: number;
  /** «склад» или номер машины (BLOODS05); для наборов — null. */
  place: string | null;
  /** Только для наборов: перезарядка в минутах (из «| 30min:»). */
  cooldownMin: number;
  /** Содержимое набора (для отчёта), например «Броня Bloods (М) x1». */
  kitContent: string;
  rowId: number;
}

const QTY_X = "[xXхХ×*]";
const MOVE_RE = new RegExp(
  `^(Берет|Кладет)\\s+(.+?)(?:\\s+${QTY_X}\\s*(\\d+))?\\s+(со склада|на склад|из\\s+(\\S+)|в\\s+(\\S+))\\s*$`,
  "iu"
);
const KIT_RE = /^Берет набор\s+(.+?)\s*[|│]\s*(\d+)\s*min\s*:\s*(.*)$/iu;
const KIT_NOBAR_RE = /^Берет набор\s+(.+)$/iu;

/** «12.11.2026, 16:42:33» (МСК) → UTC ms. NaN, если формат не тот. */
export function parseSiteTime(text: string): number {
  const m = text.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})[,\s]+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) - MSK_OFFSET_MS;
}

/** Убирает серийник «(588608XX)», «(LSPD1234)» и износ «(95%)» — остаётся название предмета. */
export function cleanItemName(raw: string): string {
  return raw
    .replace(/\s*\(\s*[A-Z]{2,}\d{3,}\s*\)/gi, " ")
    .replace(/\s*\(\s*\d{4,}X{1,3}\s*\)/gi, " ")
    .replace(/\s*\(\s*\d{1,3}%\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAction(row: LogRow): WarehouseAction | null {
  const time = parseSiteTime(row.time);
  if (!Number.isFinite(time) || !row.characterId) return null;
  const text = row.text.replace(/\s+/g, " ").trim();
  const base = { time, characterId: row.characterId, characterName: row.characterName, rowId: row.id };

  if (/^Берет набор/i.test(text)) {
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
      };
    }
    const loose = text.match(KIT_NOBAR_RE);
    if (!loose) return null;
    return { ...base, kind: "kit", item: loose[1].trim(), rawItem: loose[1].trim(), quantity: 1, place: null, cooldownMin: 0, kitContent: "" };
  }

  const m = text.match(MOVE_RE);
  if (!m) return null;
  const rawItem = m[2].trim();
  const qty = m[3] ? Number(m[3]) : 1;
  const place = m[5] ?? m[6] ?? "склад";
  return {
    ...base,
    kind: m[1].toLowerCase() === "берет" ? "take" : "put",
    item: cleanItemName(rawItem),
    rawItem,
    quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
    place,
    cooldownMin: 0,
    kitContent: "",
  };
}

const WEAPON_WORDS =
  /(rifle|pistol|smg|shotgun|carbine|sniper|revolver|machine\s?gun|assault|pump|\bak-?47\b|\bmp5\b|винтовк|пистолет|автомат|дробовик|карабин|револьвер|снайпер)/i;

/** Оружие узнаём по серийнику/износу в названии («(588608XX)», «(95%)») либо по типовым названиям. */
export function isWeapon(rawItem: string): boolean {
  return /\(\s*\d{4,}X{1,3}\s*\)/i.test(rawItem) || /\(\s*[A-Z]{2,}\d{3,}\s*\)/.test(rawItem) || /\(\s*\d{1,3}%\s*\)/.test(rawItem) || WEAPON_WORDS.test(rawItem);
}
