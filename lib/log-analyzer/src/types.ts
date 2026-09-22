// ===================== TYPES =====================

export interface LogEvent {
  log_id: string;
  player_name: string;
  player_id: string;
  faction?: string;
  text?: string;
  datetime: string;
  raw_line: string;
  quantity: string;
  action: string;
  serial?: string;
  /** "%" durability shown next to some weapons, e.g. "Carbine Rifle (LSPD9591) (83%)" */
  condition?: number | null;
  item_type?: string;
  account?: string;
  location_id?: string;
  placement_type?: string;
  property_type?: string;
  item_name?: string;
  owner?: string;
}

export interface AmmoMatch {
  take: LogEvent;
  give: LogEvent;
  time_diff: number;
  item_type: string;
  take_quantity: number;
  give_quantity: number;
}

export type MedkitMatch = AmmoMatch;

export interface SerialItemResult {
  item: string;
  itemType: string;
  location: string;
  serial?: string;
  condition?: number | null;
}

export interface PlayerResultData {
  player_name: string;
  player_id: string;
  is_active: boolean;
  total_items: number;
  weighted_items: number;
  punishment_minutes: number;
  punishment_cmd: string;
  punishment_cmds: string[];
  punishment_level: string;
  evidence_text: string;
  serial_items: SerialItemResult[];
  ammo: { item_type: string; give_quantity: number; take_quantity: number; time_diff: number }[];
  medkit: { item_type: string; give_quantity: number; take_quantity: number; time_diff: number }[];
  matched_takes?: LogEvent[];
  matched_placements?: LogEvent[];
}

export interface AnalysisInput {
  factionLogContent: string;
  placementLogContents: string[];
  factionListContent?: string;
  /** Faction id — must exist in FACTIONS (see factions.ts) */
  selectedFaction: string;
  adminName: string;
  timeWindowMinutes: number;
}

export interface AnalysisResult {
  players: PlayerResultData[];
  faction: string;
  startDate: string;
  endDate: string;
  totalItems: number;
  totalAmmo: number;
  totalMedkits: number;
  /** Plain-text report (Discord-friendly), replaces the old htmlReport */
  txtReport: string;
}

// ===================== PROGRESS REPORTING =====================
//
// runAnalysis is throttled (see throttle.ts) and can take a while on large
// logs. This lets the caller (the Discord bot) show the user that the
// process is alive and roughly how far along it is, instead of a single
// static "анализирую..." message.

export type AnalysisStage =
  | "faction_log"
  | "placement_logs"
  | "matching_ammo"
  | "matching_medkits"
  | "players"
  | "report";

export interface AnalysisProgress {
  stage: AnalysisStage;
  done: number;
  total: number;
}

export type ProgressCallback = (progress: AnalysisProgress) => void;
