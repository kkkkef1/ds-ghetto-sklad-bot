import type { AmmoMatch, LogEvent } from "./types.js";
import { parseDateTime } from "./parser.js";

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

export function analyzeConsumables(
  takes: Record<string, LogEvent[]>,
  gives: Record<string, LogEvent[]>,
  takesRaw: Record<string, LogEvent[]>,
  timeWindow: number
): Record<string, AmmoMatch[]> {
  const results: Record<string, AmmoMatch[]> = {};

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

      const tbd: Record<string, number[]> = {};
      for (const tr of takesRawList) {
        if ((tr.item_type ?? "x") !== itemType) continue;
        const ms = parseDateTime(tr.datetime).getTime();
        const ds = new Date(ms).toDateString();
        if (!tbd[ds]) tbd[ds] = [];
        tbd[ds].push(ms);
      }

      for (const takeEvent of takeSorted) {
        const takeDt = parseDateTime(takeEvent.datetime).getTime();
        if (isNaN(takeDt)) continue;
        const takeQty = parseInt(takeEvent.quantity ?? "1") || 1;
        const takeDateStr = new Date(takeDt).toDateString();

        let bestGive: [number, LogEvent] | null = null;
        let bestDiff = Infinity;

        for (let idx = 0; idx < giveSorted.length; idx++) {
          if (usedGives.has(idx)) continue;
          const giveDt = giveTimesMs[idx];
          if (isNaN(giveDt)) continue;
          const timeDiff = (giveDt - takeDt) / 60000;
          if (timeDiff >= 0 && timeDiff <= timeWindow) {
            const takenBack = tbd[takeDateStr]?.some(t => t > giveDt) ?? false;
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
