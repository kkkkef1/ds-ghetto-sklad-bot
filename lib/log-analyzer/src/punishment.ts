// ===================== PUNISHMENT CALCULATION =====================
//
// Only `offprison` commands — no `/warn add` branch. Whether the player is
// still an active faction member is informational only (shown as a badge in
// the report) and no longer changes which command gets generated.

export interface PunishmentItem {
  item: string;
  serial?: string;
  condition?: number | null;
}

export function calculatePunishment(params: {
  totalItems: number;
  playerName: string;
  playerId: string;
  faction: string;
  adminName: string;
  items: PunishmentItem[];
}): { cmds: string[]; level: string; minutes: number } {
  const { totalItems, playerId, faction, adminName } = params;
  if (totalItems === 0) return { cmds: [], level: "СЛИВОВ НЕ ОБНАРУЖЕНО", minutes: 0 };

  const s = adminName;
  const reason = `Слив склада ${faction}`;

  const tier = (minutes: number, extraWarn = false) => {
    const cmds = [`offprison ${playerId} ${minutes} ${reason} | ${s}`];
    if (extraWarn) cmds.push(`offwarn ${playerId} ${reason} (next BAN) | ${s}`);
    return { cmds, level: extraWarn ? `${minutes} мин. + WARN` : `${minutes} мин`, minutes };
  };

  if (totalItems === 1) return tier(10);
  if (totalItems === 2) return tier(20);
  if (totalItems <= 4) return tier(30);
  if (totalItems <= 7) return tier(60);
  if (totalItems <= 9) return tier(80);
  if (totalItems <= 13) return tier(120);
  return tier(180, true);
}
