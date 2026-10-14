// ===================== CAPT TRACKER STORE =====================
//
// Small JSON-file-backed store (no DB in this app, and the volume here is
// tiny — a handful of writes per capture). Kept as a single flat file so a
// bot restart doesn't lose today's tally, who the helpers are, or the
// ability to still cancel an older capt.
//
// Not meant for concurrent multi-process access — this bot runs as one
// process, so a simple "load once, mutate in memory, debounce-save" model
// is enough.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FactionDayCounts {
  attacks: number;
  defenses: number;
}

export interface CaptMirrorRef {
  guildId: string;
  channelId: string;
  messageId: string;
}

export interface CaptRecord {
  /** The id of the source report message — stable and unique, used as the record key. */
  id: string;
  dayKey: string;
  /** The report's own "Номер забива" field, when present — used to detect a duplicate repost of the same capture (see recordCapt). */
  captNumber: string | null;
  attacker: string;
  defender: string;
  canceled: boolean;
  createdAt: number;
  mirrors: CaptMirrorRef[];
}

interface StoreData {
  days: Record<string, Record<string, FactionDayCounts>>; // dayKey -> faction -> counts
  records: Record<string, CaptRecord>; // recordId -> record
  helpers: string[]; // user ids allowed to use admin/status commands
  /** guildId -> role id pinged on limit violations; overrides the default in config.ts (set via /capt set-role). */
  pingRoles: Record<string, string>;
}

const DATA_FILE = process.env.CAPT_DATA_FILE || `${process.cwd()}/data/capt-store.json`;

function emptyStore(): StoreData {
  return { days: {}, records: {}, helpers: [], pingRoles: {} };
}

function load(): StoreData {
  try {
    if (existsSync(DATA_FILE)) {
      const raw = readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        days: parsed.days ?? {},
        records: parsed.records ?? {},
        helpers: Array.isArray(parsed.helpers) ? parsed.helpers : [],
        pingRoles: parsed.pingRoles && typeof parsed.pingRoles === "object" ? parsed.pingRoles : {},
      };
    }
  } catch (err) {
    console.error("[captTracker] Не удалось прочитать файл данных, начинаю с чистого состояния:", err);
  }
  return emptyStore();
}

const data: StoreData = load();
let saveScheduled = false;

function persist() {
  if (saveScheduled) return;
  saveScheduled = true;
  queueMicrotask(() => {
    saveScheduled = false;
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[captTracker] Не удалось сохранить файл данных:", err);
    }
  });
}

function ensureFaction(dayKey: string, faction: string): FactionDayCounts {
  const day = (data.days[dayKey] ??= {});
  return (day[faction] ??= { attacks: 0, defenses: 0 });
}

// ---- daily counts / captures ----

export function getDayCounts(dayKey: string): Record<string, FactionDayCounts> {
  return data.days[dayKey] ?? {};
}

/**
 * Looks up an existing, non-canceled record for the same day + capt number —
 * used to detect a duplicate repost of the same capture (the relay has been
 * seen sending the same report as two separate messages) before recording
 * it a second time. Captures with no "Номер забива" field (captNumber null)
 * are never deduplicated this way, since null would otherwise match every
 * other captureless record for the day.
 */
export function findRecordByCaptNumber(dayKey: string, captNumber: string): CaptRecord | undefined {
  return Object.values(data.records).find(
    (r) => r.dayKey === dayKey && r.captNumber === captNumber && !r.canceled
  );
}

/** Records a new capture: +1 attack for the attacker, +1 defense for the defender. */
export function recordCapt(
  id: string,
  dayKey: string,
  attacker: string,
  defender: string,
  captNumber: string | null
): CaptRecord {
  ensureFaction(dayKey, attacker).attacks += 1;
  ensureFaction(dayKey, defender).defenses += 1;
  const record: CaptRecord = {
    id,
    dayKey,
    captNumber,
    attacker,
    defender,
    canceled: false,
    createdAt: Date.now(),
    mirrors: [],
  };
  data.records[id] = record;
  persist();
  return record;
}

/**
 * Manually overwrites one faction's attack/defense counters for a day —
 * for manual corrections via `/capt edit-count`. A value left `undefined`
 * is untouched (only the value that was actually passed gets set).
 */
export function setFactionCounts(
  dayKey: string,
  faction: string,
  attacks: number | undefined,
  defenses: number | undefined
): FactionDayCounts {
  const counts = ensureFaction(dayKey, faction);
  if (attacks !== undefined) counts.attacks = attacks;
  if (defenses !== undefined) counts.defenses = defenses;
  persist();
  return counts;
}

export function attachMirror(id: string, mirror: CaptMirrorRef) {
  const record = data.records[id];
  if (!record) return;
  record.mirrors.push(mirror);
  persist();
}

export function getRecord(id: string): CaptRecord | undefined {
  return data.records[id];
}

/** Rolls back one attack + one defense for the two factions involved. Idempotent (no-op if already canceled). */
export function cancelCapt(id: string): CaptRecord | null {
  const record = data.records[id];
  if (!record || record.canceled) return null;

  const day = data.days[record.dayKey];
  if (day) {
    if (day[record.attacker]) day[record.attacker].attacks = Math.max(0, day[record.attacker].attacks - 1);
    if (day[record.defender]) day[record.defender].defenses = Math.max(0, day[record.defender].defenses - 1);
  }
  record.canceled = true;
  persist();
  return record;
}

/** Wipes one day's counters and every capt record for that day — used by /capt reset-day. */
export function resetDay(dayKey: string) {
  delete data.days[dayKey];
  for (const [id, rec] of Object.entries(data.records)) {
    if (rec.dayKey === dayKey) delete data.records[id];
  }
  persist();
}

/** Drops day buckets/records older than `keepDays` so the file doesn't grow forever. */
export function pruneOldDays(keepDays: number, referenceDate: Date = new Date()) {
  const keepKeys = new Set<string>();
  for (let i = 0; i < keepDays; i++) {
    const d = new Date(referenceDate);
    d.setUTCDate(d.getUTCDate() - i);
    keepKeys.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
  }

  let changed = false;
  for (const key of Object.keys(data.days)) {
    if (!keepKeys.has(key)) {
      delete data.days[key];
      changed = true;
    }
  }
  for (const [id, rec] of Object.entries(data.records)) {
    if (!keepKeys.has(rec.dayKey)) {
      delete data.records[id];
      changed = true;
    }
  }
  if (changed) persist();
}

// ---- helpers (added/removed by the creator) ----

export function getHelpers(): string[] {
  return [...data.helpers];
}

export function addHelper(userId: string): boolean {
  if (data.helpers.includes(userId)) return false;
  data.helpers.push(userId);
  persist();
  return true;
}

export function removeHelper(userId: string): boolean {
  const idx = data.helpers.indexOf(userId);
  if (idx === -1) return false;
  data.helpers.splice(idx, 1);
  persist();
  return true;
}

// ---- ping roles (changed by the creator via /capt set-role) ----

/** Role id saved for a server via /capt set-role, or undefined if none was ever set (config default applies). */
export function getPingRoleOverride(guildId: string): string | undefined {
  return data.pingRoles[guildId];
}

export function setPingRoleOverride(guildId: string, roleId: string) {
  data.pingRoles[guildId] = roleId;
  persist();
}
