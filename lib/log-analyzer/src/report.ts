import type { AmmoMatch, LogEvent, MedkitMatch, PlayerResultData } from "./types.js";
import { getLocationKey } from "./matching.js";

// ===================== EVIDENCE TEXT (per-player, unchanged format) =====================

export function generateEvidenceText(player: {
  player_name: string;
  player_id: string;
  matched_takes?: LogEvent[];
  matched_placements?: LogEvent[];
  ammo?: AmmoMatch[];
  medkit?: MedkitMatch[];
}, faction: string): string {
  const lines: string[] = [];
  if (!player.matched_takes?.length && !player.ammo?.length && !player.medkit?.length) return "Сливов не обнаружено";

  lines.push(`${player.player_name} [${player.player_id}]`, faction);

  if (player.matched_takes?.length) {
    lines.push("```", "Фракция (взял):");
    const seen = new Set<string>();
    for (const t of player.matched_takes) {
      if (!seen.has(t.serial ?? "")) { seen.add(t.serial ?? ""); lines.push(t.raw_line); }
    }
    const byLoc: Record<string, string[]> = {};
    for (const pl of player.matched_placements ?? []) {
      if (!seen.has(pl.serial ?? "")) continue;
      const k = getLocationKey(pl);
      if (!byLoc[k]) byLoc[k] = [];
      byLoc[k].push(pl.raw_line);
    }
    for (const [k, rls] of Object.entries(byLoc)) {
      lines.push(`${k} (положил):`);
      for (const rl of rls) lines.push(rl);
    }
    lines.push("```");
  }

  if (player.ammo?.length) {
    lines.push("```", "Фракция (взял патроны):");
    const seen = new Set<string>();
    for (const it of player.ammo) {
      if (!seen.has(it.take.raw_line)) { seen.add(it.take.raw_line); lines.push(`${it.take.raw_line} [x${it.take_quantity}]`); }
    }
    const byLoc: Record<string, Array<[string, number, number]>> = {};
    for (const it of player.ammo) {
      const k = getLocationKey(it.give);
      if (!byLoc[k]) byLoc[k] = [];
      byLoc[k].push([it.give.raw_line, it.give_quantity, it.time_diff]);
    }
    for (const [k, items] of Object.entries(byLoc)) {
      lines.push(`${k} (положил патроны):`);
      for (const [rl, qty, diff] of items) lines.push(`${rl} [x${qty}] (${diff} мин)`);
    }
    lines.push("```");
  }

  if (player.medkit?.length) {
    lines.push("```", "Фракция (взял аптечки):");
    const seen = new Set<string>();
    for (const it of player.medkit) {
      if (!seen.has(it.take.raw_line)) { seen.add(it.take.raw_line); lines.push(`${it.take.raw_line} [x${it.take_quantity}]`); }
    }
    const byLoc: Record<string, Array<[string, number, number]>> = {};
    for (const it of player.medkit) {
      const k = getLocationKey(it.give);
      if (!byLoc[k]) byLoc[k] = [];
      byLoc[k].push([it.give.raw_line, it.give_quantity, it.time_diff]);
    }
    for (const [k, items] of Object.entries(byLoc)) {
      lines.push(`${k} (положил аптечки):`);
      for (const [rl, qty, diff] of items) lines.push(`${rl} [x${qty}] (${diff} мин)`);
    }
    lines.push("```");
  }

  return lines.join("\n");
}

// ===================== FULL PLAIN-TEXT REPORT (replaces the old HTML report) =====================

export function generateTxtReport(
  players: PlayerResultData[],
  faction: string,
  startDate: string,
  endDate: string,
  totalItems: number,
  totalAmmo: number,
  totalMedkits: number
): string {
  const genTime = new Date().toLocaleString("ru-RU");
  const lines: string[] = [];

  lines.push("=".repeat(60));
  lines.push(`GTA5RP LOG ANALYZER — ${faction}`);
  lines.push(`Сформировано: ${genTime}`);
  lines.push(`Период логов: ${startDate} — ${endDate}`);
  lines.push(`Нарушителей: ${players.length} · Предметов: ${totalItems}${totalAmmo ? ` · Патронов: ${totalAmmo}` : ""}${totalMedkits ? ` · Аптечек: ${totalMedkits}` : ""}`);
  lines.push("=".repeat(60));

  if (!players.length) {
    lines.push("", "Сливов не обнаружено.");
    return lines.join("\n");
  }

  players.forEach((p, i) => {
    const ammoTotal = p.ammo.reduce((a, m) => a + m.give_quantity, 0);
    const medkitTotal = p.medkit.reduce((a, m) => a + m.give_quantity, 0);

    lines.push("");
    lines.push("-".repeat(60));
    lines.push(`#${i + 1} ${p.player_name} [${p.player_id}] — ${p.is_active ? "в списке фракции" : "не в списке фракции"}`);
    if (p.serial_items.length) {
      lines.push("Предметы:");
      for (const si of p.serial_items) {
        const serialPart = si.serial ? ` (${si.serial}${si.condition != null ? `, ${si.condition}%` : ""})` : "";
        lines.push(`  - ${si.item}${serialPart} → ${si.location}`);
      }
    }
    if (ammoTotal > 0) lines.push(`  - Патроны: x${ammoTotal}`);
    if (medkitTotal > 0) lines.push(`  - Аптечки: x${medkitTotal}`);
    lines.push(`Итого: ${p.weighted_items} ед. → наказание: ${p.punishment_level}`);
    lines.push("Команда:");
    for (const cmd of p.punishment_cmds) lines.push(`  ${cmd}`);
    if (p.evidence_text && p.evidence_text !== "Сливов не обнаружено") {
      lines.push("Доказательства:");
      lines.push(p.evidence_text);
    }
  });

  lines.push("");
  lines.push("=".repeat(60));
  lines.push("ВСЕ КОМАНДЫ:");
  for (const p of players) {
    for (const cmd of p.punishment_cmds) lines.push(cmd);
  }

  return lines.join("\n");
}
