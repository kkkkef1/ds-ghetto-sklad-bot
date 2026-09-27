import type { AmmoMatch, LogEvent } from "./types.js";
import { parseDateTime } from "./parser.js";
import { Yielder } from "./throttle.js";

// ===================== PLAYER CASE (serial take → placement matching) =====================

export class PlayerCase {
  player_name: string;
  player_id: string;
  take_events: LogEvent[] = [];
  placement_events: LogEvent[] = [];
  remove_events: LogEvent[] = [];
  is_active = true;
  matched_serials = new Set<string>();
  matched_takes: LogEvent[] = [];
  matched_placements: LogEvent[] = [];

  constructor(name: string, id: string) {
    this.player_name = name;
    this.player_id = id;
  }

  analyze(isActive: boolean) {
    this.is_active = isActive;
    this.matched_serials.clear();
    this.matched_takes = [];
    this.matched_placements = [];

    type SerialTimeline = {
      factionTakes: LogEvent[];
      placementGives: LogEvent[];
      placementTakebacks: LogEvent[];
    };
    const timelines: Record<string, SerialTimeline> = {};

    for (const t of this.take_events) {
      const s = t.serial;
      if (!s) continue;
      if (!timelines[s]) timelines[s] = { factionTakes: [], placementGives: [], placementTakebacks: [] };
      timelines[s].factionTakes.push(t);
    }

    for (const p of this.placement_events) {
      const s = p.serial;
      if (!s || !timelines[s]) continue;
      timelines[s].placementGives.push(p);
    }

    for (const r of this.remove_events) {
      const s = r.serial;
      if (!s || !timelines[s]) continue;
      timelines[s].placementTakebacks.push(r);
    }

    for (const [serial, tl] of Object.entries(timelines)) {
      if (!tl.factionTakes.length || !tl.placementGives.length) continue;

      const firstTake = [...tl.factionTakes].sort(
        (a, b) => parseDateTime(a.datetime).getTime() - parseDateTime(b.datetime).getTime()
      )[0];
      const firstTakeTime = parseDateTime(firstTake.datetime);

      const givesAfter = tl.placementGives.filter(
        g => parseDateTime(g.datetime).getTime() >= firstTakeTime.getTime()
      );
      if (!givesAfter.length) continue;

      const lastGive = [...givesAfter].sort(
        (a, b) => parseDateTime(a.datetime).getTime() - parseDateTime(b.datetime).getTime()
      ).at(-1)!;
      const lastGiveTime = parseDateTime(lastGive.datetime);

      const hasTakeBack = tl.placementTakebacks.some(
        r => parseDateTime(r.datetime).getTime() > lastGiveTime.getTime()
      );

      if (!hasTakeBack) {
        this.matched_serials.add(serial);
        this.matched_takes.push(firstTake);
        this.matched_placements.push(lastGive);
      }
    }
  }

  getSerialItemsCount(): number { return this.matched_takes.length; }
  hasMatches(): boolean { return this.matched_takes.length > 0; }
}

// ===================== LOCATION LABEL =====================

export function getLocationKey(event: LogEvent): string {
  const pt = event.placement_type ?? "unknown";
  const prop = event.property_type ?? "";
  const loc = event.location_id ?? "";
  if (pt === "house") return prop === "Квартира" ? `квартира ${loc}` : `дом ${loc}`;
  if (pt === "vehicle") return `тачка ${loc}`;
  if (pt === "family") return `семья ${loc}`;
  return loc ? `размещение ${loc}` : "неизвестное место";
}

// ===================== AMMO / MEDKIT (time-window matching, no serials) =====================

export async function analyzeConsumables(
  takes: Record<string, LogEvent[]>,
  gives: Record<string, LogEvent[]>,
  takesRaw: Record<string, LogEvent[]>,
  timeWindow: number
): Promise<Record<string, AmmoMatch[]>> {
  const results: Record<string, AmmoMatch[]> = {};
  // Ticked per take-event below (and periodically inside the inner give
  // scan too): for each take we scan the unused gives of its item type
  // looking for the closest one within the time window, so a player with
  // thousands of take/give events costs roughly takes × gives — exactly
  // the kind of loop a single huge paste can blow up.
  const yielder = new Yielder();
  const INNER_TICK_EVERY = 500; // tick the inner give-scan periodically, not every iteration, to avoid overhead swamping small scans

  for (const [pid, takesList] of Object.entries(takes)) {
    const givesList = gives[pid] ?? [];
    const takesRawList = takesRaw[pid] ?? [];
    if (!takesList.length || !givesList.length) continue;

    const takeByType: Record<string, LogEvent[]> = {};
    for (const t of takesList) {
      const tp = t.item_type ?? "x";
      if (!takeByType[tp]) takeByType[tp] = [];
      takeByType[tp].push(t);
    }

    const giveByType: Record<string, LogEvent[]> = {};
    for (const g of givesList) {
      const tp = g.item_type ?? "x";
      if (!giveByType[tp]) giveByType[tp] = [];
      giveByType[tp].push(g);
    }

    for (const [itemType, takeEvents] of Object.entries(takeByType)) {
      const giveEvents = giveByType[itemType] ?? [];
      if (!giveEvents.length) continue;

      const takeSorted = [...takeEvents].sort((a, b) => a.datetime.localeCompare(b.datetime));
      const giveSorted = [...giveEvents].sort((a, b) => a.datetime.localeCompare(b.datetime));
      const usedGives = new Set<number>();
      const giveTimesMs = giveSorted.map(g => parseDateTime(g.datetime).getTime());
      const takeTimesMs = takeSorted.map(t => parseDateTime(t.datetime).getTime());

      // Raw "took back from placement" events for this item type, sorted
      // once so each take can binary/linear-scan just its own slice instead
      // of bucketing by calendar day. Bucketing by day mirrored the same
      // class of bug as PlayerCase's global-min/max collapse: a retrieval
      // that actually belongs to a *later* take/give cycle (same day) could
      // get attributed to an earlier, still-open cycle, hiding a real leak
      // — or, conversely, a late-night cycle spanning midnight could miss
      // its own retrieval entirely because it fell on the "next" day's
      // bucket. Scoping the check to strictly between this cycle's give and
      // the start of the player's *next* take of the same item (rather than
      // "same calendar day") fixes both directions.
      const takebacksMs = takesRawList
        .filter(tr => (tr.item_type ?? "x") === itemType)
        .map(tr => parseDateTime(tr.datetime).getTime())
        .filter(ms => !isNaN(ms))
        .sort((a, b) => a - b);

      for (let ti = 0; ti < takeSorted.length; ti++) {
        const takeEvent = takeSorted[ti];
        await yielder.tick();
        const takeDt = takeTimesMs[ti];
        if (isNaN(takeDt)) continue;
        const takeQty = parseInt(takeEvent.quantity ?? "1") || 1;
        // Cycle boundary: retrievals are only relevant if they happen after
        // this take's give and before the player takes this item type
        // again (or, for the last take, at any point afterwards).
        const nextTakeDt = ti + 1 < takeTimesMs.length ? takeTimesMs[ti + 1] : Infinity;

        let bestGive: [number, LogEvent] | null = null;
        let bestDiff = Infinity;

        for (let idx = 0; idx < giveSorted.length; idx++) {
          if (idx % INNER_TICK_EVERY === 0) await yielder.tick();
          if (usedGives.has(idx)) continue;
          const giveDt = giveTimesMs[idx];
          if (isNaN(giveDt)) continue;
          const timeDiff = (giveDt - takeDt) / 60000;
          if (timeDiff >= 0 && timeDiff <= timeWindow) {
            const takenBack = takebacksMs.some(t => t > giveDt && t < nextTakeDt);
            if (!takenBack && timeDiff < bestDiff) {
              bestDiff = timeDiff;
              bestGive = [idx, giveSorted[idx]];
            }
          }
        }

        if (bestGive) {
          const [idx, giveEvent] = bestGive;
          usedGives.add(idx);
          const giveQty = parseInt(giveEvent.quantity ?? "1") || 1;
          if (!results[pid]) results[pid] = [];
          results[pid].push({
            take: takeEvent, give: giveEvent,
            time_diff: Math.round(bestDiff * 10) / 10,
            item_type: itemType,
            take_quantity: takeQty,
            give_quantity: Math.min(giveQty, takeQty),
          });
        }
      }
    }
  }

  return results;
}
