// ===================== ПОИСК ПОДОЗРИТЕЛЬНЫХ =====================
//
// Чистая функция без обращений к сайту и Discord: на входе действия за период
// и правила, на выходе — игроки, у которых что-то превышено.
//
// Что проверяется для каждого игрока и каждого правила:
//   • «объём»  — сколько взято за период (с вычетом возвращённого, если включено);
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

export interface Suspect {
  characterId: string;
  characterName: string;
  /** Для сортировки: чем больше, тем сильнее превышение. */
  score: number;
  reasons: string[];
}

interface TakeEvent {
  t: number;
  q: number;
}

interface Bucket {
  rule: Rule;
  taken: number;
  put: number;
  events: TakeEvent[];
  byItem: Map<string, number>;
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

function topItems(byItem: Map<string, number>, n = 3): string {
  const sorted = [...byItem.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, n).map(([name, q]) => `${name} ×${q}`);
  return shown.join(", ") + (sorted.length > n ? ", …" : "");
}

interface Person {
  name: string;
  buckets: Map<string, Bucket>;
  kitTakes: Map<string, { rule: Rule; times: number[]; cooldownMin: number }>;
}

export function analyzeActions(actions: WarehouseAction[], opts: AnalyzeOptions): Suspect[] {
  const people = new Map<string, Person>();
  const sorted = [...actions].sort((a, b) => a.time - b.time || a.rowId - b.rowId);

  for (const a of sorted) {
    if (opts.excluded.has(a.characterId)) continue;
    const rule = pickRule(opts.rules, a);
    if (!rule) continue;

    let person = people.get(a.characterId);
    if (!person) {
      person = { name: a.characterName, buckets: new Map(), kitTakes: new Map() };
      people.set(a.characterId, person);
    }

    if (a.kind === "kit") {
      const entry = person.kitTakes.get(a.item) ?? { rule, times: [], cooldownMin: a.cooldownMin };
      // Одна выдача набора может оставить в логе несколько подряд идущих строк (по предмету на строку).
      const last = entry.times[entry.times.length - 1];
      if (last === undefined || a.time - last > opts.kitMergeSeconds * 1000) entry.times.push(a.time);
      entry.cooldownMin = Math.max(entry.cooldownMin, a.cooldownMin);
      person.kitTakes.set(a.item, entry);
      continue;
    }

    let bucket = person.buckets.get(rule.id);
    if (!bucket) {
      bucket = { rule, taken: 0, put: 0, events: [], byItem: new Map() };
      person.buckets.set(rule.id, bucket);
    }
    if (a.kind === "take") {
      bucket.taken += a.quantity;
      bucket.events.push({ t: a.time, q: a.quantity });
      bucket.byItem.set(a.item, (bucket.byItem.get(a.item) ?? 0) + a.quantity);
    } else {
      bucket.put += a.quantity;
    }
  }

  const suspects: Suspect[] = [];
  for (const [characterId, person] of people) {
    const reasons: string[] = [];
    let score = 0;

    for (const bucket of person.buckets.values()) {
      const { rule } = bucket;
      const net = opts.netReturns ? bucket.taken - bucket.put : bucket.taken;

      if (rule.limit > 0 && net > rule.limit) {
        const returned = opts.netReturns && bucket.put > 0 ? `, вернул ${Math.min(bucket.put, bucket.taken)}` : "";
        reasons.push(`${rule.label}: взял ${bucket.taken}${returned} → итого ${net} при лимите ${rule.limit} (${topItems(bucket.byItem)})`);
        score += net / rule.limit;
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

    if (reasons.length) suspects.push({ characterId, characterName: person.name, score, reasons });
  }

  return suspects.sort((a, b) => b.score - a.score);
}
