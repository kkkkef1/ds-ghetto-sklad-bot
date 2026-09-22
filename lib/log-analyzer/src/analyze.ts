import type {
  AmmoMatch, AnalysisInput, AnalysisResult, AnalysisStage, LogEvent, MedkitMatch,
  PlayerResultData, ProgressCallback,
} from "./types.js";
import { getFaction } from "./factions.js";
import { cleanItemName, parseFactionLogContent, parsePlacementLogContent } from "./parser.js";
import { PlayerCase, analyzeConsumables, getLocationKey } from "./matching.js";
import { calculatePunishment } from "./punishment.js";
import { generateEvidenceText, generateTxtReport } from "./report.js";
import { Yielder } from "./throttle.js";

/**
 * Runs the full leak analysis. Throttled: on large logs this yields to the
 * event loop periodically instead of running as one uninterrupted synchronous
 * block (see throttle.ts), and reports coarse progress via `onProgress` so a
 * caller can show the user the process is still alive.
 */
export async function runAnalysis(input: AnalysisInput, onProgress?: ProgressCallback): Promise<AnalysisResult> {
  const faction = getFaction(input.selectedFaction);
  const report = (stage: AnalysisStage, done: number, total: number) =>
    onProgress?.({ stage, done, total });

  const players: Record<string, PlayerCase> = {};
  const activePlayers = new Set<string>();
  const ammoTakes: Record<string, LogEvent[]> = {};
  const ammoGives: Record<string, LogEvent[]> = {};
  const ammoTakesRaw: Record<string, LogEvent[]> = {};
  const medkitTakes: Record<string, LogEvent[]> = {};
  const medkitGives: Record<string, LogEvent[]> = {};
  const medkitTakesRaw: Record<string, LogEvent[]> = {};
  const tw = input.timeWindowMinutes;

  if (input.factionListContent) {
    for (const line of input.factionListContent.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      const m = l.match(/\[(\d+)\]/);
      if (m) activePlayers.add(m[1]);
      else { const n = l.match(/\d+/); if (n) activePlayers.add(n[0]); }
    }
  }

  const addTake = (events: LogEvent[]) => {
    for (const e of events) {
      if (!players[e.player_id]) players[e.player_id] = new PlayerCase(e.player_name, e.player_id);
      players[e.player_id].take_events.push(e);
    }
  };

  const addPlacement = (events: LogEvent[]) => {
    for (const e of events) {
      if (!players[e.player_id]) players[e.player_id] = new PlayerCase(e.player_name, e.player_id);
      if (e.action === "TAKE") players[e.player_id].remove_events.push(e);
      else players[e.player_id].placement_events.push(e);
    }
  };

  report("faction_log", 0, 1);
  const [fSe, , fAmmo, fMed] = await parseFactionLogContent(input.factionLogContent, faction);
  addTake(fSe);
  for (const e of fAmmo) { if (!ammoTakes[e.player_id]) ammoTakes[e.player_id] = []; ammoTakes[e.player_id].push(e); }
  for (const e of fMed) { if (!medkitTakes[e.player_id]) medkitTakes[e.player_id] = []; medkitTakes[e.player_id].push(e); }
  report("faction_log", 1, 1);

  const placementTotal = input.placementLogContents.length;
  for (let i = 0; i < placementTotal; i++) {
    const [pSe, , pAmmo, pMed] = await parsePlacementLogContent(input.placementLogContents[i], faction);
    addPlacement(pSe);
    for (const e of pAmmo) {
      if (e.action === "GIVE") { if (!ammoGives[e.player_id]) ammoGives[e.player_id] = []; ammoGives[e.player_id].push(e); }
      else { if (!ammoTakesRaw[e.player_id]) ammoTakesRaw[e.player_id] = []; ammoTakesRaw[e.player_id].push(e); }
    }
    for (const e of pMed) {
      if (e.action === "GIVE") { if (!medkitGives[e.player_id]) medkitGives[e.player_id] = []; medkitGives[e.player_id].push(e); }
      else { if (!medkitTakesRaw[e.player_id]) medkitTakesRaw[e.player_id] = []; medkitTakesRaw[e.player_id].push(e); }
    }
    report("placement_logs", i + 1, placementTotal);
  }

  const playerYielder = new Yielder();
  const playerEntries = Object.entries(players);
  for (let i = 0; i < playerEntries.length; i++) {
    const [pid, p] = playerEntries[i];
    p.is_active = activePlayers.has(pid);
    p.analyze(p.is_active);
    await playerYielder.tick();
    report("players", i + 1, playerEntries.length);
  }

  report("matching_ammo", 0, 1);
  const ammoMatches = await analyzeConsumables(ammoTakes, ammoGives, ammoTakesRaw, tw);
  report("matching_ammo", 1, 1);
  report("matching_medkits", 0, 1);
  const medkitMatches = await analyzeConsumables(medkitTakes, medkitGives, medkitTakesRaw, tw);
  report("matching_medkits", 1, 1);

  const allLeakPids = new Set<string>([
    ...Object.values(players).filter(p => p.hasMatches()).map(p => p.player_id),
    ...Object.keys(ammoMatches),
    ...Object.keys(medkitMatches),
  ]);

  const allDates: string[] = [];
  const playersList: Array<{
    player_name: string; player_id: string; is_active: boolean;
    total_items: number; ammo: AmmoMatch[]; medkit: MedkitMatch[];
    matched_takes: LogEvent[]; matched_placements: LogEvent[];
    weighted_items: number;
  }> = [];

  for (const pid of allLeakPids) {
    const p = players[pid];
    const pAmmo = ammoMatches[pid] ?? [];
    const pMed = medkitMatches[pid] ?? [];
    const totalAmmoQty = pAmmo.reduce((a, m) => a + m.give_quantity, 0);
    const totalMedkitQty = pMed.reduce((a, m) => a + m.give_quantity, 0);
    const ammoItems = totalAmmoQty >= 1000 ? Math.floor(totalAmmoQty / 200) : 0;
    const medkitItems = totalMedkitQty >= 15 ? Math.floor(totalMedkitQty / 5) : 0;

    if (p) {
      for (const e of p.matched_takes) {
        if (e.datetime) {
          const dp = e.datetime.includes(",") ? e.datetime.split(",")[0].trim() : e.datetime.split(" ")[0].trim();
          if (dp) allDates.push(dp);
        }
      }
      const serialItems = p.getSerialItemsCount();
      const weightedItems = serialItems + ammoItems + medkitItems;
      playersList.push({
        player_name: p.player_name, player_id: p.player_id,
        is_active: p.is_active, total_items: serialItems,
        ammo: pAmmo, medkit: pMed,
        matched_takes: p.matched_takes, matched_placements: p.matched_placements,
        weighted_items: weightedItems,
      });
    } else {
      const src = (ammoTakes[pid] ?? medkitTakes[pid] ?? [])[0];
      if (src) {
        const weightedItems = ammoItems + medkitItems;
        playersList.push({
          player_name: src.player_name, player_id: pid,
          is_active: activePlayers.has(pid), total_items: 0,
          ammo: pAmmo, medkit: pMed,
          matched_takes: [], matched_placements: [],
          weighted_items: weightedItems,
        });
      }
    }
  }

  playersList.sort((a, b) => {
    if (b.weighted_items !== a.weighted_items) return b.weighted_items - a.weighted_items;
    const aA = a.ammo.reduce((s, m) => s + m.give_quantity, 0);
    const bA = b.ammo.reduce((s, m) => s + m.give_quantity, 0);
    return bA - aA;
  });

  const startDate = allDates.length ? allDates.reduce((a, b) => a < b ? a : b) : "N/A";
  const endDate = allDates.length ? allDates.reduce((a, b) => a > b ? a : b) : "N/A";
  const totalItemsCount = playersList.reduce((a, p) => a + p.total_items, 0);
  const totalAmmoCount = Object.values(ammoMatches).flat().reduce((a, m) => a + m.give_quantity, 0);
  const totalMedkitsCount = Object.values(medkitMatches).flat().reduce((a, m) => a + m.give_quantity, 0);

  report("report", 0, 1);
  const playerResults: PlayerResultData[] = playersList.flatMap(p => {
    if (p.weighted_items === 0) return [];
    const serialItems = p.matched_takes.map((take, idx) => ({
      item: cleanItemName(p.matched_placements[idx]?.item_name ?? take.item_name ?? take.serial ?? ""),
      itemType: take.faction ?? faction.id,
      location: p.matched_placements[idx] ? getLocationKey(p.matched_placements[idx]) : "неизвестно",
      serial: take.serial,
      condition: take.condition ?? p.matched_placements[idx]?.condition ?? null,
    }));
    const punishment = calculatePunishment({
      totalItems: p.weighted_items,
      playerName: p.player_name,
      playerId: p.player_id,
      faction: faction.id,
      adminName: input.adminName || "Admin",
      items: serialItems,
    });
    const evidenceText = generateEvidenceText({
      player_name: p.player_name,
      player_id: p.player_id,
      matched_takes: p.matched_takes,
      matched_placements: p.matched_placements,
      ammo: p.ammo,
      medkit: p.medkit,
    }, faction.id);
    return [{
      player_name: p.player_name,
      player_id: p.player_id,
      is_active: p.is_active,
      total_items: p.total_items,
      weighted_items: p.weighted_items,
      punishment_minutes: punishment.minutes,
      punishment_cmd: punishment.cmds[0] ?? "",
      punishment_cmds: punishment.cmds,
      punishment_level: punishment.level,
      evidence_text: evidenceText,
      serial_items: serialItems,
      ammo: p.ammo.map(a => ({ item_type: a.item_type, give_quantity: a.give_quantity, take_quantity: a.take_quantity, time_diff: a.time_diff })),
      medkit: p.medkit.map(m => ({ item_type: m.item_type, give_quantity: m.give_quantity, take_quantity: m.take_quantity, time_diff: m.time_diff })),
      matched_takes: p.matched_takes,
      matched_placements: p.matched_placements,
    }];
  });

  report("report", 1, 1);

  return {
    players: playerResults,
    faction: faction.id,
    startDate,
    endDate,
    totalItems: totalItemsCount,
    totalAmmo: totalAmmoCount,
    totalMedkits: totalMedkitsCount,
    txtReport: generateTxtReport(playerResults, faction.id, startDate, endDate, totalItemsCount, totalAmmoCount, totalMedkitsCount),
  };
}
