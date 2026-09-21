// ===================== FACTIONS =====================
//
// "gov"   — government factions. Serial numbers on the faction warehouse belong
//           to that faction and follow a letter-prefix scheme (LSPD1234, ARMY99...).
//           Only serials matching GOV_SERIAL_PREFIXES are tracked as "теirs".
// "crime" — criminal factions. Their warehouse mixes stolen government weapons
//           (still carrying a masked or full government serial, e.g. "LSPD9591")
//           with fully anonymous / defaced serials (e.g. "119019XX"). There is no
//           per-item ownership split — ANY serial found on a crime warehouse is
//           tracked, government-prefixed or masked alike.

export type FactionKind = "gov" | "crime";

export interface FactionConfig {
  id: string;
  displayName: string;
  kind: FactionKind;
}

export const FACTIONS: FactionConfig[] = [
  { id: "LSPD", displayName: "LSPD", kind: "gov" },
  { id: "LSSD", displayName: "LSSD", kind: "gov" },
  { id: "FIB", displayName: "FIB", kind: "gov" },
  { id: "ARMY", displayName: "ARMY", kind: "gov" },
  { id: "GOV", displayName: "GOV", kind: "gov" },
  { id: "SASPA", displayName: "SASPA", kind: "gov" },
  // Crime factions. All of them share the same serial-ownership rule
  // (kind: "crime" ⇒ isTrackableSerial() counts ANY serial, gov-prefixed or
  // masked alike — see isTrackableSerial below). The list itself does not
  // affect serial-number parsing/matching in any way; it's only used to
  // label sessions and reports with the correct faction name.
  //
  // Банды
  { id: "VAGOS", displayName: "Vagos", kind: "crime" },
  { id: "FAMILIES", displayName: "Families", kind: "crime" },
  { id: "MARABUNTA", displayName: "Marabunta", kind: "crime" },
  { id: "BALLAS", displayName: "Ballas", kind: "crime" },
  { id: "BLOODS", displayName: "Bloods", kind: "crime" },
  // Мафии
  { id: "LCN", displayName: "LCN", kind: "crime" },
  { id: "MM", displayName: "MM", kind: "crime" },
  { id: "AM", displayName: "AM", kind: "crime" },
  { id: "RM", displayName: "RM", kind: "crime" },
  { id: "YAK", displayName: "YAK", kind: "crime" },
];

export function getFaction(id: string): FactionConfig {
  const f = FACTIONS.find(f => f.id === id);
  if (!f) throw new Error(`Unknown faction id: "${id}"`);
  return f;
}

const GOV_SERIAL_PREFIXES = [
  "LSPD", "LSSD", "FIB", "ARMY", "GOV", "BCSO", "SAHP", "NG", "USMS", "PRISON", "PRIS",
];

export function isGovSerial(serial: string): boolean {
  if (!serial) return false;
  const s = serial.toUpperCase();
  return GOV_SERIAL_PREFIXES.some(p => s.startsWith(p));
}

/** A masked/defaced serial: digits only, ending in one or more literal "X" (e.g. "119019XX"). */
export function isMaskedSerial(serial: string): boolean {
  return /^\d{4,}X{1,3}$/i.test(serial);
}

/**
 * Decides whether a serial found on a given faction's warehouse should be tracked
 * as belonging to that faction for leak-detection purposes.
 *
 * - gov factions: only serials carrying that faction's own letter prefix are "theirs".
 *   (kept faction-agnostic on purpose — a GOV admin shouldn't flag LSPD's own gear
 *   found on GOV's warehouse; adjust to `isGovSerial` broadly if that's not desired.)
 * - crime factions: no ownership filter — any serial (gov-prefixed or masked) counts.
 */
export function isTrackableSerial(serial: string, faction: FactionConfig): boolean {
  if (!serial) return false;
  if (faction.kind === "crime") return true;
  return isGovSerial(serial);
}
