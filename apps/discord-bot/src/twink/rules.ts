// ===================== ПРАВИЛА ТВИНКОВ =====================
//
// Перенесено из расширения «Twink Checker» как есть:
//   • нельзя две криминальные фракции;
//   • нельзя две государственные;
//   • нельзя криминальную вместе с государственной;
//   • нельзя криминальную вместе с «особой» (Medical Services, Weazel News, Мэрия ЛС).
// Если у персонажа фракция, которой нет ни в одном списке, группа пропускается, а владельцу
// в личку уходит вопрос, к какой категории её отнести (см. unknown.ts).

export type Category = "crime" | "state" | "special";

export const CATEGORY_LABEL: Record<Category, string> = {
  crime: "криминальная",
  state: "государственная",
  special: "особая",
};

const CRIME = [
  "Армянская Мафия",
  "Итальянская Мафия",
  "Мексиканская Мафия",
  "Русская Мафия",
  "Японская Мафия",
  "The Ballas Gang",
  "Bloods",
  "The Families",
  "Marabunta Grande",
  "Los Santos Vagos",
];
const STATE = ["FIB", "LS Army", "LSPD", "LSSD", "Федеральная Тюрьма"];
const SPECIAL = ["Medical Services", "Weazel News", "Мэрия ЛС"];

/** Полное название фракции → короткий код в выводе (как в расширении; у Vagos — LCV). */
const SHORT: Record<string, string> = {
  "Армянская Мафия": "AM",
  "Итальянская Мафия": "LCN",
  "Мексиканская Мафия": "MM",
  "Русская Мафия": "RM",
  "Японская Мафия": "YAK",
  "The Ballas Gang": "ESB",
  Bloods: "BSG",
  "The Families": "FAM",
  "Marabunta Grande": "MG-13",
  "Los Santos Vagos": "LCV",
  FIB: "FIB",
  "LS Army": "ARMY",
  LSPD: "LSPD",
  LSSD: "LSSD",
  "Федеральная Тюрьма": "SASPA",
  "Medical Services": "EMS",
  "Weazel News": "WN",
  "Мэрия ЛС": "GOV",
};

/** Фракции, добавленные владельцем через ответ в личке или /twink map. */
export interface CustomFaction {
  category: Category;
  code: string;
}

export type CustomFactions = Record<string, CustomFaction>;

export function categoryOf(name: string, custom: CustomFactions): Category | null {
  if (CRIME.includes(name)) return "crime";
  if (STATE.includes(name)) return "state";
  if (SPECIAL.includes(name)) return "special";
  return custom[name]?.category ?? null;
}

export function shortCode(name: string, custom: CustomFactions): string {
  return SHORT[name] ?? custom[name]?.code ?? name.split(" ").map((w) => w[0]).join("").toUpperCase();
}

/** [название фракции, ID персонажа] — одна карточка персонажа в окне «(ч)». */
export type CardFaction = [string, string];

export function isAllowedCombination(cards: CardFaction[], custom: CustomFactions): boolean {
  if (cards.length < 2) return true;
  const cats = cards.map((c) => categoryOf(c[0], custom));
  const crime = cats.filter((c) => c === "crime").length;
  const state = cats.filter((c) => c === "state").length;
  const special = cats.filter((c) => c === "special").length;
  if (crime > 1) return false;
  if (state > 1) return false;
  if (crime > 0 && state > 0) return false;
  if (crime > 0 && special > 0) return false;
  return true;
}

export interface Verdict {
  /** Фракции, которых нет ни в одном списке: группа не проверена. */
  unknown: string[];
  /** true — сочетание запрещено. */
  violation: boolean;
}

export function judge(cards: CardFaction[], custom: CustomFactions): Verdict {
  const valid = cards.filter((c) => c[0] && c[0] !== "-");
  if (valid.length < 2) return { unknown: [], violation: false };
  const unknown = [...new Set(valid.filter((c) => categoryOf(c[0], custom) === null).map((c) => c[0]))];
  if (unknown.length) return { unknown, violation: false };
  return { unknown: [], violation: !isAllowedCombination(valid, custom) };
}

export interface TwinkGroup {
  /** Стабильный ключ группы (отсортированные ID) — чтобы не писать одного игрока дважды за проверку. */
  key: string;
  /** Строки «ID КОД». */
  header: string[];
  /** Строки «offwarn ID Твинк КОД | остальные | by Ник». */
  offwarn: string[];
}

/** Формат строк как в расширении. */
export function buildGroup(cards: CardFaction[], custom: CustomFactions, nickname: string): TwinkGroup {
  const valid = cards.filter((c) => c[0] && c[0] !== "-");
  const header = valid.map(([name, id]) => `${id} ${shortCode(name, custom)}`);
  const offwarn = valid.map(([name, id], idx) => {
    const others = valid.filter((_, i) => i !== idx).map((x) => shortCode(x[0], custom)).join(" | ") || "-";
    return `offwarn ${id} Твинк ${shortCode(name, custom)} | ${others} | by ${nickname}`;
  });
  const key = valid.map((c) => c[1]).sort().join(",");
  return { key, header, offwarn };
}
