// ===================== ПОИСК ПОДОЗРИТЕЛЬНЫХ =====================
//
// Чистая функция без обращений к сайту и Discord: на входе действия за период
// и правила, на выходе — игроки, у которых что-то превышено.
//
// Что проверяется для каждого игрока и каждого правила:
//   • «объём»  — сколько взято со склада/из машин за период (с вычетом возвращённого, если включено);
//   • «наборы» — содержимое наборов считается по штукам («Аптечка EMS x2» = 2 аптечки) и
//     складывается в ту же категорию, что и склад: 50 наборов по 200 патронов — это 10000 патронов;
//   • «всплеск» — сколько взято за короткое окно (например, 4 оружия за 3 минуты);
//   • у наборов дополнительно — нарушение перезарядки: повторный набор раньше,
//     чем истекла перезарядка, указанная в самой строке лога («| 30min:»).

import { isWeapon, type WarehouseAction } from "./actions.js";
import type { Rule } from "./store.js";

export interface AnalyzeOptions {
  rules: Rule[];
  /** Вычитать из взятого то, что игрок положил обратно за тот же период. */
  netReturns: boolean;
  /** Проверять нарушение перезарядки наборов. */
  kitCooldownCheck: boolean;
  /** Сколько нарушений перезарядки считать подозрительным. */
  kitCooldownViolations: number;
  /** Строки набора, идущие подряд с интервалом не больше этого, считаются одним получением. */
  kitMergeSeconds: number;
  /** Допуск (сек) при сравнении интервала с перезарядкой — на округление и лаги. */
  kitCooldownToleranceSeconds: number;
  /** ID персонажей, которых не проверяем. */
  excluded: ReadonlySet<string>;
}

export const DEFAULT_ANALYZE_OPTIONS = {
  kitMergeSeconds: 10,
  kitCooldownToleranceSeconds: 60,
} as const;

/** Одна категория (правило) в разбивке по игроку: «Оружие — 9: AK-47 ×6, Carbine Rifle ×3». */
export interface CategoryLine {
  label: string;
  total: number;
  /** От большего к меньшему. */
  items: { name: string; quantity: number; /** «склад» или номер машины (BLOODS05); у наборов нет. */ place?: string }[];
  /** Только для наборов: сколько наборов взято ради этой категории. */
  kitCount?: number;
}

export interface KitIssue {
  name: string;
  times: number;
  cooldownMin: number;
}

export interface Suspect {
  characterId: string;
  characterName: string;
  /** Для сортировки: чем больше, тем сильнее превышение. */
  score: number;
  /** Что именно превышено (коротко). */
  reasons: string[];
  /** Всё, что игрок взял со склада и из машин фракции за период. */
  warehouse: CategoryLine[];
  /** Всё, что игрок вернул на склад/в машины. */
  returned: CategoryLine[];
  /** Всё, что игрок получил наборами (по содержимому наборов, а не по числу выдач). */
  kits: CategoryLine[];
  /** Сколько раз взят каждый набор. */
  kitIssues: KitIssue[];
}

interface TakeEvent {
  t: number;
  q: number;
}

interface Bucket {
  rule: Rule;
  /** Со склада/из машин. */
  taken: number;
  put: number;
  /** Получено наборами (по содержимому). */
  kitTaken: number;
  /** Выдачи наборов (имя набора → моменты), из которых пришли предметы этой категории. */
  kitTimes: Map<string, number[]>;
  events: TakeEvent[];
  byItem: Map<string, number>;
  putByItem: Map<string, number>;
  kitByItem: Map<string, number>;
}

export function ruleMatches(rule: Rule, action: WarehouseAction): boolean {
  const name = action.item.toLowerCase();
  return rule.match.some((p) => {
    const pattern = p.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern === "*") return true;
    if (pattern === "@weapon") return action.kind !== "kit" && isWeapon(action.rawItem);
    return name.includes(pattern);
  });
}

export function pickRule(rules: Rule[], action: WarehouseAction): Rule | null {
  const kind = action.kind === "kit" ? "kit" : "item";
  return rules.find((r) => r.kind === kind && ruleMatches(r, action)) ?? null;
}

/** Максимум единиц за любое окно длиной windowMs (события отсортированы по времени). */
function maxInWindow(events: TakeEvent[], windowMs: number): number {
  let best = 0;
  let sum = 0;
  let left = 0;
  for (let right = 0; right < events.length; right++) {
    sum += events[right].q;
    while (events[right].t - events[left].t > windowMs) {
      sum -= events[left].q;
      left++;
    }
    if (sum > best) best = sum;
  }
  return best;
}

const KEY_SEP = "\u0000";
/** Предмет + откуда взят: один и тот же предмет из склада и из машины — разные строки отчёта. */
const itemKey = (item: string, place: string | null): string => `${item}${KEY_SEP}${place ?? ""}`;

function toLine(rule: Rule, byItem: Map<string, number>, kitCount?: number): CategoryLine {
  const items = [...byItem.entries()]
    .map(([key, quantity]) => {
      const [name, place] = key.split(KEY_SEP);
      return place ? { name, quantity, place } : { name, quantity };
    })
    .sort((a, b) => b.quantity - a.quantity);
  return { label: rule.label, total: items.reduce((sum, it) => sum + it.quantity, 0), items, ...(kitCount !== undefined ? { kitCount } : {}) };
}

function countKits(times: Map<string, number[]>): number {
  let n = 0;
  for (const t of times.values()) n += t.length;
  return n;
}

function inc(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

interface Person {
  name: string;
  buckets: Map<string, Bucket>;
  kitTakes: Map<string, { rule: Rule; times: number[]; cooldownMin: number }>;
}

function bucketOf(person: Person, rule: Rule): Bucket {
  let bucket = person.buckets.get(rule.id);
  if (!bucket) {
    bucket = { rule, taken: 0, put: 0, kitTaken: 0, kitTimes: new Map(), events: [], byItem: new Map(), putByItem: new Map(), kitByItem: new Map() };
    person.buckets.set(rule.id, bucket);
  }
  return bucket;
}

export function analyzeActions(actions: WarehouseAction[], opts: AnalyzeOptions): Suspect[] {
  const people = new Map<string, Person>();
  const sorted = [...actions].sort((a, b) => a.time - b.time || a.rowId - b.rowId);

  for (const a of sorted) {
    if (opts.excluded.has(a.characterId)) continue;

    let person = people.get(a.characterId);
    const ensurePerson = (): Person => {
      if (!person) {
        person = { name: a.characterName, buckets: new Map(), kitTakes: new Map() };
        people.set(a.characterId, person);
      }
      return person;
    };

    if (a.kind === "kit") {
      // 1) Сама выдача набора: сколько раз и не нарушена ли перезарядка.
      const kitRule = pickRule(opts.rules, a);
      if (kitRule) {
        const p = ensurePerson();
        const entry = p.kitTakes.get(a.item) ?? { rule: kitRule, times: [], cooldownMin: a.cooldownMin };
        // Одна выдача набора может оставить в логе несколько подряд идущих строк (по предмету на строку).
        const last = entry.times[entry.times.length - 1];
        if (last === undefined || a.time - last > opts.kitMergeSeconds * 1000) entry.times.push(a.time);
        entry.cooldownMin = Math.max(entry.cooldownMin, a.cooldownMin);
        p.kitTakes.set(a.item, entry);
      }
      // 2) Содержимое набора: «Аптечка EMS x2» — это 2 аптечки, их считаем по категориям предметов.
      for (const ki of a.kitItems) {
        const itemAction: WarehouseAction = { ...a, kind: "take", item: ki.item, rawItem: ki.rawItem, quantity: ki.quantity, kitItems: [] };
        const rule = pickRule(opts.rules, itemAction);
        if (!rule) continue;
        const bucket = bucketOf(ensurePerson(), rule);
        bucket.kitTaken += ki.quantity;
        inc(bucket.kitByItem, itemKey(ki.item, null), ki.quantity);
        // Строки одного набора подряд (до kitMergeSeconds) — одна выдача.
        const times = bucket.kitTimes.get(a.item) ?? [];
        const last = times[times.length - 1];
        if (last === undefined || a.time - last > opts.kitMergeSeconds * 1000) times.push(a.time);
        bucket.kitTimes.set(a.item, times);
      }
      continue;
    }

    const rule = pickRule(opts.rules, a);
    if (!rule) continue;
    const bucket = bucketOf(ensurePerson(), rule);
    if (a.kind === "take") {
      bucket.taken += a.quantity;
      bucket.events.push({ t: a.time, q: a.quantity });
      inc(bucket.byItem, itemKey(a.item, a.place), a.quantity);
    } else {
      bucket.put += a.quantity;
      inc(bucket.putByItem, itemKey(a.item, a.place), a.quantity);
    }
  }

  const suspects: Suspect[] = [];
  for (const [characterId, person] of people) {
    const reasons: string[] = [];
    let score = 0;

    for (const bucket of person.buckets.values()) {
      const { rule } = bucket;
      const net = opts.netReturns ? bucket.taken - bucket.put : bucket.taken;
      // Содержимое наборов складывается в ту же категорию и сравнивается с тем же лимитом.
      const total = net + bucket.kitTaken;

      if (rule.limit > 0 && total > rule.limit) {
        const kitsCount = countKits(bucket.kitTimes);
        const parts: string[] = [];
        if (bucket.taken > 0) {
          const returned = opts.netReturns && bucket.put > 0 ? `, вернул ${Math.min(bucket.put, bucket.taken)}` : "";
          parts.push(`взял ${bucket.taken}${returned}`);
        }
        if (bucket.kitTaken > 0) parts.push(`набрал из наборов ${bucket.kitTaken}, взял наборов: ${kitsCount}`);
        const showTotal = parts.length > 1 || (opts.netReturns && bucket.put > 0);
        reasons.push(`${rule.label}: ${parts.join("; ")}${showTotal ? ` → итого ${total}` : ""} (лимит ${rule.limit})`);
        score += total / rule.limit;
      }
      if (rule.burstCount > 0 && rule.burstMinutes > 0) {
        const burst = maxInWindow(bucket.events, rule.burstMinutes * 60_000);
        if (burst >= rule.burstCount) {
          reasons.push(`${rule.label}: ${burst} шт. за ${rule.burstMinutes} мин (порог ${rule.burstCount})`);
          score += burst / rule.burstCount;
        }
      }
    }

    for (const [kitName, entry] of person.kitTakes) {
      const { rule, times } = entry;
      if (rule.limit > 0 && times.length > rule.limit) {
        reasons.push(`Набор «${kitName}»: ${times.length} раз за период (лимит ${rule.limit})`);
        score += times.length / rule.limit;
      }
      if (rule.burstCount > 0 && rule.burstMinutes > 0) {
        const burst = maxInWindow(times.map((t) => ({ t, q: 1 })), rule.burstMinutes * 60_000);
        if (burst >= rule.burstCount) {
          reasons.push(`Набор «${kitName}»: ${burst} раз за ${rule.burstMinutes} мин (порог ${rule.burstCount})`);
          score += burst / rule.burstCount;
        }
      }
      if (opts.kitCooldownCheck && entry.cooldownMin > 0 && opts.kitCooldownViolations > 0) {
        const cooldownMs = entry.cooldownMin * 60_000 - opts.kitCooldownToleranceSeconds * 1000;
        let violations = 0;
        for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < cooldownMs) violations++;
        if (violations >= opts.kitCooldownViolations) {
          reasons.push(`Набор «${kitName}»: взят раньше перезарядки (${entry.cooldownMin} мин) ${violations} раз`);
          score += violations;
        }
      }
    }

    if (!reasons.length) continue;

    // Подробности — в порядке правил, как они заданы в настройках.
    const order = new Map(opts.rules.map((r, i) => [r.id, i]));
    const buckets = [...person.buckets.values()].sort((x, y) => (order.get(x.rule.id) ?? 0) - (order.get(y.rule.id) ?? 0));
    suspects.push({
      characterId,
      characterName: person.name,
      score,
      reasons,
      warehouse: buckets.filter((b) => b.taken > 0).map((b) => toLine(b.rule, b.byItem)),
      returned: buckets.filter((b) => b.put > 0).map((b) => toLine(b.rule, b.putByItem)),
      kits: buckets.filter((b) => b.kitTaken > 0).map((b) => toLine(b.rule, b.kitByItem, countKits(b.kitTimes))),
      kitIssues: [...person.kitTakes.entries()]
        .map(([name, e]) => ({ name, times: e.times.length, cooldownMin: e.cooldownMin }))
        .sort((x, y) => y.times - x.times),
    });
  }

  return suspects.sort((a, b) => b.score - a.score);
}

// ===================== НОВЫЕ ПРЕДМЕТЫ =====================

export interface UnknownItem {
  /** Название как в логе («SPANK»). */
  name: string;
  quantity: number;
  /** Откуда брали: «склад», номера машин, «набор». */
  places: Set<string>;
}

/**
 * Предметы, для которых нет отдельного правила и которые попали в универсальное «Прочее».
 * Бот спрашивает про них лимит у владельца.
 */
export function findUnknownItems(actions: WarehouseAction[], rules: Rule[]): UnknownItem[] {
  const found = new Map<string, UnknownItem>();
  const note = (item: string, rawItem: string, quantity: number, place: string, probe: WarehouseAction) => {
    const rule = pickRule(rules, { ...probe, kind: "take", item, rawItem, quantity, kitItems: [] });
    if (!rule || rule.kind !== "item" || !rule.match.includes("*")) return;
    const key = item.trim().toLowerCase();
    if (!key) return;
    const entry = found.get(key) ?? { name: item.trim(), quantity: 0, places: new Set<string>() };
    entry.quantity += quantity;
    entry.places.add(place);
    found.set(key, entry);
  };
  for (const a of actions) {
    if (a.kind === "kit") for (const ki of a.kitItems) note(ki.item, ki.rawItem, ki.quantity, "набор", a);
    else note(a.item, a.rawItem, a.quantity, a.place ?? "склад", a);
  }
  return [...found.values()].sort((x, y) => y.quantity - x.quantity);
}
