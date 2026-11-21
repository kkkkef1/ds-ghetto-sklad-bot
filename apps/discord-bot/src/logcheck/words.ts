// ===================== СПИСОК ОСКОРБЛЕНИЙ И СРАВНЕНИЕ С НИМ =====================
//
// Слово в списке пишется капсом и может иметь пометку:
//   ЛОХ      — слово целиком, допускаются падежные окончания до 2 букв (лох, лохи, лохом; не «лохматый»);
//   =СУКА    — только это слово, без окончаний;
//   ХУЙ*     — любое слово, которое НАЧИНАЕТСЯ так (хуйня, хуйло…): для корней мата;
//   МАТЬ ТВОЮ — несколько слов подряд (фраза).
// Уровень: hard — оскорбление/мат (красное), soft — спорное (в игровом сленге может быть по делу).
//
// Перед сравнением текст нормализуется: регистр, «ё» = «е», латинские и цифровые двойники
// (x → х, o/0 → о…), растянутые буквы (лоооох → лох), буквы через точки и пробелы (л.о.х → лох).

export type WordLevel = "hard" | "soft";

export interface WordEntry {
  word: string;
  level: WordLevel;
}

const HARD = [
  // оскорбления
  "ЛОХ", "ЛОШАРА", "ЛУЗЕР", "ЧМО", "ЧМОШНИК", "НУБ", "ДАУН", "ДЕБИЛ", "ИДИОТ", "КРЕТИН",
  "=ТУПОЙ", "=ТУПАЯ", "=ТУПОЕ", "=ТУПЫЕ", "=ТУПОГО", "ТУПИЦА", "ПРИДУРОК", "ДУРА", "ДУРАК", "ДУРАЧОК", "УРОД",
  "=МРАЗЬ", "=МРАЗИ", "=ТВАРЬ", "УБЛЮДОК", "ГАДИНА", "ПАДЛА", "=ПАДАЛЬ", "СКОТИНА", "ГНИДА",
  "ГОВНО", "ГОВНЮК", "ДЕРЬМО", "ШАВКА", "ШЛЮХ*", "ПИДОР*", "ПИДАР*", "ПИДР*", "МУДАК", "МУДАЧ*", "МУДИЛ*", "ГАНДОН", "ГОНДОН",
  // корни мата
  "ХУЙ*", "ХУЕ*", "ХУЯ*", "ОХУЕ*", "НАХУ*", "ПОХУ*", "ПИЗД*", "ЕБА*", "ЕБЛ*", "ЕБУЧ*", "ЗАЕБ*", "ДОЛБОЕ*",
  "БЛЯ*", "=СУКА", "=СУКИ", "=СУКУ", "=СУКОЙ", "=СУКЕ", "СУЧК*", "СУЧАР*", "ЗАЛУП*",
  // оскорбление родных
  "МАТЬ ТВОЮ", "ТВОЮ МАТЬ", "ТВОЮ МАМКУ", "МАМКУ ТВОЮ", "=МАМКУ",
  // национальные оскорбления
  "ЧУРКА", "ЧУРОК", "ХОХОЛ", "ХОХЛ*", "КАЦАП", "ЖИД", "НЕГР", "НИГГЕР", "ЧЕРНОЖОП*",
];

const SOFT = ["=КРЫСА", "=КРЫСЫ", "=КРЫСУ", "ПЕТУХ", "КОЗЕЛ", "БАРАН", "БОМЖ", "СЛИВ", "ТРУС", "ПОЗОР", "=ОСЕЛ"];

export function defaultWords(): WordEntry[] {
  return [
    ...HARD.map((word) => ({ word, level: "hard" as const })),
    ...SOFT.map((word) => ({ word, level: "soft" as const })),
  ];
}

// ---- нормализация ----

const LATIN_TWINS: Record<string, string> = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у", "0": "о" };

/** Строчные кириллические буквы, «ё» → «е», латинские и цифровые двойники → кириллица. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[a-z0]/g, (ch) => LATIN_TWINS[ch] ?? ch);
}

/** «лоооох» → «лох»: подряд идущие одинаковые буквы схлопываются (и в тексте, и в словах списка — одинаково). */
function collapse(token: string): string {
  return token.replace(/([а-я])\1+/g, "$1");
}

/** Слова текста: сначала как есть, а одиночные буквы подряд («л о х», «л.о.х») склеиваются в одно слово. */
export function tokenize(text: string): string[] {
  const raw = normalizeText(text).match(/[а-я]+/g) ?? [];
  const tokens: string[] = [];
  let run = "";
  const flush = () => {
    if (run.length >= 2) {
      // Склеенная «слово» из одиночных букв; проверяем и её хвосты («а л о х» → «алох», «лох», «ох»).
      for (let i = 0; i <= run.length - 2; i++) tokens.push(run.slice(i));
    }
    run = "";
  };
  for (const w of raw) {
    if (w.length === 1) {
      run += w;
      continue;
    }
    flush();
    tokens.push(w);
  }
  flush();
  return tokens.map(collapse);
}

// ---- сравнение ----

type Mode = "plain" | "exact" | "prefix" | "phrase";

interface Compiled {
  entry: WordEntry;
  mode: Mode;
  stem: string;
  /** Как слово показывается в отчёте: «ЛОХ», «ХУЙ». */
  label: string;
}

const MAX_ENDING = 2;

function compileEntry(entry: WordEntry): Compiled | null {
  let w = entry.word.trim();
  let mode: Mode = "plain";
  if (w.startsWith("=")) {
    mode = "exact";
    w = w.slice(1);
  } else if (w.endsWith("*")) {
    mode = "prefix";
    w = w.slice(0, -1);
  }
  const stem = normalizeText(w)
    .replace(/[^а-я ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map(collapse)
    .join(" ");
  if (!stem) return null;
  if (stem.includes(" ")) mode = "phrase";
  return { entry, mode, stem, label: w.trim().toUpperCase() };
}

export interface WordMatch {
  label: string;
  level: WordLevel;
}

export class WordMatcher {
  private readonly compiled: Compiled[];

  constructor(entries: WordEntry[]) {
    this.compiled = entries.map(compileEntry).filter((c): c is Compiled => c !== null);
  }

  /** Все слова из списка, найденные в тексте (без повторов). */
  find(text: string): WordMatch[] {
    const tokens = tokenize(text);
    if (!tokens.length) return [];
    const haystack = ` ${tokens.join(" ")} `;
    const found = new Map<string, WordMatch>();
    for (const c of this.compiled) {
      let hit = false;
      if (c.mode === "phrase") hit = haystack.includes(` ${c.stem} `);
      else if (c.mode === "exact") hit = tokens.includes(c.stem);
      else if (c.mode === "prefix") hit = tokens.some((t) => t.startsWith(c.stem));
      else hit = tokens.some((t) => t === c.stem || (t.startsWith(c.stem) && t.length - c.stem.length <= MAX_ENDING));
      if (hit && !found.has(c.label)) found.set(c.label, { label: c.label, level: c.entry.level });
    }
    return [...found.values()];
  }
}

/** Проверка и приведение введённого слова: «лох», «=сука», «хуй*», «мать твою». null — не годится. */
export function normalizeWordInput(input: string): string | null {
  const w = input.trim().toUpperCase().replace(/\s+/g, " ");
  if (!/^=?[А-ЯЁA-Z0-9 ]{2,40}\*?$/.test(w)) return null;
  const core = w.replace(/^=/, "").replace(/\*$/, "");
  if (core.trim().length < 2) return null;
  if (w.startsWith("=") && w.endsWith("*")) return null;
  return w;
}
