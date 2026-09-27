import type { LogEvent } from "./types.js";
import { type FactionConfig, isTrackableSerial } from "./factions.js";
import { Yielder } from "./throttle.js";

// ===================== CONSTANTS =====================

// Faction name aliases: maps log display names → canonical faction ID
const FACTION_ALIASES: Record<string, string> = {
  "мэрия лс": "GOV",
  "мэрия": "GOV",
  "ls army": "ARMY",
  "федеральная тюрьма": "SASPA",
  "фед. тюрьма": "SASPA",
};

const IGNORE_ACTIONS = [
  "повышает", "увольняет", "назначает", "выдал", "выдала",
  "уволил", "уволила", "повысил", "повысила", "назначил",
  "назначила", "перевел", "перевела", "принял", "приняла",
  "отстранил", "отстранила", "снял", "сняла", "понижает",
  "понизил", "понизила", "переводит",
  "Принимает во фракцию", "Приглашает", "принимает", "приглашает",
  "Исключил", "исключил", "Исключает", "исключает",
];

const CRAFT_AMMO_QTY: Record<string, number> = {
  "7.62": 30, "12": 8, "5.56": 30, "9": 20, ".45": 20, ".50": 10,
};

// ===================== HELPERS =====================

const _dtCache = new Map<string, number>();
export function parseDateTime(dtStr: string): Date {
  if (!dtStr) return new Date(2000, 0, 1);
  const cached = _dtCache.get(dtStr);
  if (cached !== undefined) return new Date(cached);
  const s = dtStr.trim();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})[, ]+(\d{2}):(\d{2}):(\d{2})$/);
  const d = m
    ? new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6])
    : new Date(2000, 0, 1);
  _dtCache.set(dtStr, d.getTime());
  return d;
}

// Order matters: letter-prefixed government serials are tried first, then the
// masked/defaced numeric form used by crime factions (e.g. "119019XX").
const SERIAL_PATTERNS = [
  /\(([A-Z]{2,}[0-9]{3,})\)/,
  /\((\d{4,}X{1,3})\)/i,
  /([A-Z]{2,}[0-9]{3,})/,
  /(\d{4,}X{1,3})\b/i,
  /№([A-Z0-9]{4,})/,
  /ID:([A-Z0-9]{4,})/,
  /\[([A-Z0-9]{4,})\]/,
];

export function extractSerial(text: string): string | null {
  if (!text) return null;
  for (const p of SERIAL_PATTERNS) {
    const m = text.match(p);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/** Durability shown as a separate "(83%)" block next to some weapons. */
const CONDITION_RE = /\((\d{1,3})%\)/;
export function extractCondition(text: string): number | null {
  if (!text) return null;
  const m = text.match(CONDITION_RE);
  return m ? parseInt(m[1], 10) : null;
}

function isAmmoItem(text: string): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const mm = t.match(/(\d+(?:\.\d+)?)\s*mm/);
  if (mm && ["7.62", "5.56", "12", "9"].includes(mm[1])) return `Патроны ${mm[1]}mm`;
  if (t.includes(".45")) return "Патроны .45";
  if (t.includes(".50")) return "Патроны .50";
  return null;
}

function getCraftAmmoQty(text: string): number {
  const t = text.toLowerCase();
  const mm = t.match(/(\d+(?:\.\d+)?)\s*mm/);
  if (mm && CRAFT_AMMO_QTY[mm[1]] !== undefined) return CRAFT_AMMO_QTY[mm[1]];
  if (t.includes(".45")) return CRAFT_AMMO_QTY[".45"] ?? 20;
  if (t.includes(".50")) return CRAFT_AMMO_QTY[".50"] ?? 10;
  return 0;
}

function isMedkitItem(text: string): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("аптечка ems")) return "Аптечка EMS";
  if (t.includes("малая аптечка")) return "Малая аптечка";
  if (t.includes("большая аптечка")) return "Большая аптечка";
  if (t.includes("набор аптеки") || t.includes("набор аптек")) return "Аптечка EMS";
  return null;
}

function isFactionVehicleTake(text: string): boolean {
  return /из\s+[A-Z]{2,}\d+/i.test(text);
}

function shouldIgnoreText(text: string): boolean {
  if (!text) return true;
  const t = text.toLowerCase();
  return IGNORE_ACTIONS.some(ig => t.includes(ig.toLowerCase()));
}

function removeDuplicates(events: LogEvent[]): LogEvent[] {
  const seen = new Set<string>();
  return events.filter(e => {
    const key = `${e.log_id}|${e.serial ?? ""}|${e.datetime}|${e.item_name ?? ""}|${e.item_type ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanStr(s: unknown): string {
  return String(s ?? "").trim();
}

function normalizeFaction(name: string): string {
  return FACTION_ALIASES[name.toLowerCase().trim()] ?? name;
}

export function cleanItemName(raw: string): string {
  let s = raw.replace(/^набор\s+/i, "").trim();
  const rangeMatch = s.match(/^.+?\s*\[[\d\s\-–]+\]\s*:\s*(.+)/u);
  if (rangeMatch) {
    s = rangeMatch[1].split(",")[0].trim();
  } else {
    const pipe1 = s.indexOf("│");
    const pipe2 = s.indexOf("|");
    const pipeIdx = pipe1 > 0 && pipe2 > 0 ? Math.min(pipe1, pipe2) : Math.max(pipe1, pipe2);
    if (pipeIdx > 0) {
      const afterPipe = s.substring(pipeIdx + 1).trim();
      const afterTime = afterPipe.match(/^\d+(?:\s*\S+)?:\s*(.+)/u);
      if (afterTime) {
        s = afterTime[1].trim();
      } else {
        s = s.substring(0, pipeIdx).trim();
      }
    } else {
      const colonMatch = s.match(/^[^:|\n]+:\s*(.+)/u);
      if (colonMatch) {
        s = colonMatch[1].split(",")[0].trim();
      }
    }
  }
  s = s.replace(/\s+[xхX×*]\s*\d+\s+из\s+\S+/iu, "").trim();
  s = s.replace(/\s+из\s+\S+$/iu, "").trim();
  s = s.replace(/\s+[xхX×*]\s*\d+\s*$/iu, "").trim();
  s = s.replace(/\s*\([A-Z]{2,}[0-9]{3,}\)\s*/gi, " ").trim();
  s = s.replace(/\s*\(\d{4,}X{1,3}\)\s*/gi, " ").trim();
  s = s.replace(/\s*\(\d+%\)\s*/g, " ").trim();
  return s || raw;
}

function extractQtyFromText(text: string): string {
  const m = text.match(/[xхX×]\s*(\d+)\s*(?:со склада|$)/i) ?? text.match(/[xхX×]\s*(\d+)/i);
  return m ? m[1] : "1";
}

// ===================== TSV SECTION PARSER =====================

interface TsvSection {
  headers: string[];
  rows: string[][];
}

async function splitTsvSections(content: string, yielder: Yielder): Promise<TsvSection[]> {
  const lines = content.split("\n").map(l => l.trimEnd());
  const sections: TsvSection[] = [];
  let currentHeaders: string[] | null = null;
  let currentRows: string[][] = [];

  for (const line of lines) {
    // This pass used to be fully synchronous — on a large placement log
    // (up to the 50MB cap in wizard.ts) that's hundreds of thousands of
    // lines processed in one uninterrupted tick, pinning the event loop
    // long enough that *every* pending Discord interaction (not just this
    // session's) misses its 3s ack window and the bot looks completely
    // unresponsive. Yielding here, same as the row-processing loops below
    // already do, keeps the bot responsive during this pass too.
    await yielder.tick();

    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[А-ЯЁA-Z][А-яёa-zА-ЯЁA-Z\s]*:$/.test(trimmed) && !trimmed.includes("\t")) continue;
    if (trimmed.startsWith("==")) continue;

    const fields = line.split("\t").map(f => f.trim());

    if (fields.includes("Персонаж") || (fields.includes("Ид") && fields.length >= 4 && fields.some(f => f === "Персонаж"))) {
      if (currentHeaders && currentRows.length > 0) {
        sections.push({ headers: currentHeaders, rows: currentRows });
      }
      currentHeaders = fields;
      currentRows = [];
    } else if (currentHeaders && fields.length >= 3) {
      currentRows.push(fields);
    }
  }

  if (currentHeaders && currentRows.length > 0) {
    sections.push({ headers: currentHeaders, rows: currentRows });
  }

  return sections;
}

function detectSectionType(headers: string[]): "vehicle" | "house" | "apartment" | "family" | "faction" | "unknown" {
  if (headers.includes("Тачка")) return "vehicle";
  if (headers.includes("Квартира")) return "apartment";
  if (headers.includes("Дом")) return "house";
  if (headers.includes("Семья")) return "family";
  if (headers.includes("Фракция") || headers.includes("Текст")) return "faction";
  return "unknown";
}

function getField(headers: string[], row: string[], name: string): string {
  const idx = headers.indexOf(name);
  if (idx < 0 || idx >= row.length) return "";
  return cleanStr(row[idx]);
}

function getFieldAt(row: string[], idx: number): string {
  if (idx < 0 || idx >= row.length) return "";
  return cleanStr(row[idx]);
}

// ===================== FACTION (WAREHOUSE) LOG PARSER =====================

function processFactionTextRow(
  logId: string, pname: string, pid: string, factionName: string,
  text: string, datetime: string, rawLine: string,
  faction: FactionConfig,
  serialEvents: LogEvent[], armorEvents: LogEvent[],
  ammoEvents: LogEvent[], medkitEvents: LogEvent[]
) {
  if (!text) return;
  if (text.includes("с номером")) return;
  if (text.includes("Кладет") || text.includes("Кладёт")) return;
  if (shouldIgnoreText(text)) return;

  const isTake = text.includes("Берет") || text.includes("Берёт");
  const isCraft = text.includes("Создает") || text.includes("Создаёт");
  if (!isTake && !isCraft) return;

  if (isCraft) {
    const ammoType = isAmmoItem(text);
    if (!ammoType) return;
    const craftQty = getCraftAmmoQty(text);
    if (craftQty === 0) return;
    ammoEvents.push({
      log_id: logId, player_name: pname, player_id: pid, faction: normalizeFaction(factionName),
      text, datetime, raw_line: rawLine, quantity: String(craftQty), action: "TAKE",
      item_type: ammoType,
    });
    return;
  }

  const serial = extractSerial(text);
  if (serial && !isTrackableSerial(serial, faction)) return;

  const ammoType = isAmmoItem(text);
  const medkitType = isMedkitItem(text);

  let quantity = "1";
  const qm = text.match(/[хxх×*]\s*(\d+)/iu);
  if (qm) quantity = qm[1];

  const event: LogEvent = {
    log_id: logId,
    player_name: pname,
    player_id: pid,
    faction: normalizeFaction(factionName),
    text,
    datetime,
    raw_line: rawLine,
    quantity,
    action: "TAKE",
  };

  const itemNameMatch = text.match(/(?:Берет|Берёт)\s+([^\n]+)/iu);
  const extractedItemName = (itemNameMatch?.[1] ?? "")
    .replace(/\s+[xхх×*]\s*\d+\s*$/, "")
    .trim();

  if (serial) {
    event.serial = serial;
    event.condition = extractCondition(text);
    if (extractedItemName) event.item_name = extractedItemName;
    serialEvents.push(event);
  } else if (ammoType) {
    event.item_type = ammoType;
    ammoEvents.push(event);
  } else if (medkitType && !isFactionVehicleTake(text)) {
    event.item_type = medkitType;
    event.quantity = extractQtyFromText(text);
    medkitEvents.push(event);
  }
}

export async function parseFactionLogContent(
  content: string,
  faction: FactionConfig
): Promise<[LogEvent[], LogEvent[], LogEvent[], LogEvent[]]> {
  const serialEvents: LogEvent[] = [];
  const armorEvents: LogEvent[] = [];
  const ammoEvents: LogEvent[] = [];
  const medkitEvents: LogEvent[] = [];
  const yielder = new Yielder();

  try {
    const sections = await splitTsvSections(content, yielder);
    for (const section of sections) {
      if (detectSectionType(section.headers) !== "faction" && !section.headers.includes("Фракция")) continue;

      for (const row of section.rows) {
        await yielder.tick();
        try {
          const text = getField(section.headers, row, "Текст");
          const personage = getField(section.headers, row, "Персонаж");
          const pm = personage.match(/\[(\d+)\]/);
          if (!pm) continue;
          processFactionTextRow(
            getField(section.headers, row, "Ид"),
            personage.split("[")[0].trim(),
            pm[1],
            getField(section.headers, row, "Фракция"),
            text,
            getField(section.headers, row, "Время"),
            row.join("\t"),
            faction,
            serialEvents, armorEvents, ammoEvents, medkitEvents
          );
        } catch { continue; }
      }
    }
  } catch { /* ignore */ }

  if (serialEvents.length === 0 && armorEvents.length === 0 && ammoEvents.length === 0 && medkitEvents.length === 0) {
    const lines = content.split("\n");
    for (const line of lines) {
      await yielder.tick();
      try {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const fields = trimmed.split("\t").map(f => f.trim());
        if (fields.length < 5) continue;
        if (fields[1] === "Персонаж" || fields[3] === "Текст") continue;
        const pm = fields[1].match(/\[(\d+)\]/);
        if (!pm) continue;
        processFactionTextRow(
          fields[0], fields[1].split("[")[0].trim(), pm[1],
          fields[2], fields[3], fields[4], trimmed,
          faction,
          serialEvents, armorEvents, ammoEvents, medkitEvents
        );
      } catch { continue; }
    }
  }

  return [
    removeDuplicates(serialEvents),
    removeDuplicates(armorEvents),
    removeDuplicates(ammoEvents),
    removeDuplicates(medkitEvents),
  ];
}

// ===================== PLACEMENT LOG PARSER =====================

function processPlacementEvent(
  event: LogEvent, serial: string | null, itemText: string,
  serialEvents: LogEvent[], _armorEvents: LogEvent[],
  ammoEvents: LogEvent[], medkitEvents: LogEvent[]
) {
  const ammoType = isAmmoItem(itemText);
  const medkitType = isMedkitItem(itemText);
  if (serial) {
    event.serial = serial;
    event.condition = extractCondition(itemText);
    serialEvents.push(event);
  } else if (ammoType) {
    event.item_type = ammoType;
    ammoEvents.push(event);
  } else if (medkitType) {
    event.item_type = medkitType;
    medkitEvents.push(event);
  }
}

export async function parsePlacementLogContent(
  content: string,
  faction: FactionConfig
): Promise<[LogEvent[], LogEvent[], LogEvent[], LogEvent[]]> {
  const serialEvents: LogEvent[] = [];
  const armorEvents: LogEvent[] = [];
  const ammoEvents: LogEvent[] = [];
  const medkitEvents: LogEvent[] = [];
  const yielder = new Yielder();

  try {
    const sections = await splitTsvSections(content, yielder);

    if (sections.length === 0) {
      const lines = content.split("\n");
      let detectedType: "vehicle" | "house" | "family" | null = null;
      for (const line of lines) {
        await yielder.tick();
        const fields = line.trim().split("\t").map(f => f.trim());
        if (fields.length < 5 || !fields[1].match(/\[\d+\]/)) continue;
        if (fields.length >= 8 && (fields[3] === "GIVE" || fields[3] === "TAKE") && /^\d+$/.test(fields[4])) {
          detectedType = "vehicle"; break;
        }
        if (fields.length >= 7 && (fields[2] === "GIVE" || fields[2] === "TAKE") && /^\d+$/.test(fields[3])) {
          detectedType = "house"; break;
        }
        if (fields.length === 5 && (fields[3].includes("Берет") || fields[3].includes("Берёт") || fields[3].includes("Кладет"))) {
          detectedType = "family"; break;
        }
      }
      if (detectedType === "vehicle") {
        for (const line of lines) {
          await yielder.tick();
          try {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const fields = trimmed.split("\t").map(f => f.trim());
            if (fields.length < 8 || fields[1] === "Персонаж") continue;
            const pm = fields[1].match(/\[(\d+)\]/);
            if (!pm) continue;
            const rawAction = fields[3].toUpperCase();
            if (rawAction !== "GIVE" && rawAction !== "TAKE") continue;
            const locId = fields[4];
            if (!/^\d+$/.test(locId)) continue;
            const itemText = fields[5];
            if (shouldIgnoreText(itemText)) continue;
            const serial = extractSerial(itemText);
            if (serial && !isTrackableSerial(serial, faction)) continue;
            const event: LogEvent = {
              log_id: fields[0], player_name: fields[1].split("[")[0].trim(), player_id: pm[1],
              account: fields[2], location_id: locId, datetime: fields[7] || "", placement_type: "vehicle",
              action: rawAction, raw_line: trimmed, item_name: itemText, quantity: fields[6] || "1", owner: "", text: itemText,
            };
            processPlacementEvent(event, serial, itemText, serialEvents, armorEvents, ammoEvents, medkitEvents);
          } catch { continue; }
        }
      }
      return [removeDuplicates(serialEvents), removeDuplicates(armorEvents), removeDuplicates(ammoEvents), removeDuplicates(medkitEvents)];
    }

    for (const section of sections) {
      const stype = detectSectionType(section.headers);
      if (stype === "faction" || stype === "unknown") continue;

      for (const row of section.rows) {
        await yielder.tick();
        try {
          if (row.length < 3) continue;
          const personage = getField(section.headers, row, "Персонаж");
          if (!personage) continue;
          const allText = row.join(" ");
          if (shouldIgnoreText(allText)) continue;
          const pm = personage.match(/\[(\d+)\]/);
          if (!pm) continue;
          const pid = pm[1];
          const pname = personage.split("[")[0].trim();

          let action = "GIVE";
          let ptype = "unknown";
          let locId = "";
          let itemText = "";
          let quantity = "1";
          let owner = "";
          let account = "";
          let propertyType = "";

          if (stype === "vehicle") {
            const tachkaIdx = section.headers.indexOf("Тачка");
            const typIdx = tachkaIdx > 0 ? tachkaIdx - 1 : -1;
            const itemIdx = tachkaIdx >= 0 ? tachkaIdx + 1 : -1;
            const userIdx = section.headers.findIndex(h => h === "Пользователь" || h === "Владелец");
            const qtyIdx = section.headers.indexOf("Кол-во");
            const ownerLabel = section.headers[userIdx] ?? "";
            ptype = "vehicle";
            locId = tachkaIdx >= 0 ? getFieldAt(row, tachkaIdx) : "";
            itemText = itemIdx >= 0 ? getFieldAt(row, itemIdx) : "";
            quantity = qtyIdx >= 0 ? getFieldAt(row, qtyIdx) : "1";
            account = userIdx >= 0 ? getFieldAt(row, userIdx) : "";
            if (ownerLabel === "Владелец") { owner = account; account = ""; }
            const rawAction = typIdx >= 0 ? getFieldAt(row, typIdx).toUpperCase() : "";
            if (rawAction === "TAKE") action = "TAKE";
            else if (rawAction === "GIVE") action = "GIVE";
            else action = allText.toLowerCase().includes("take") ? "TAKE" : "GIVE";
          } else if (stype === "house" || stype === "apartment") {
            const locCol = stype === "apartment" ? "Квартира" : "Дом";
            propertyType = stype === "apartment" ? "Квартира" : "Дом";
            ptype = "house";
            locId = getField(section.headers, row, locCol);
            itemText = getField(section.headers, row, "Предмет") || getField(section.headers, row, "Текст");
            quantity = getField(section.headers, row, "Кол-во") || "1";
            account = getField(section.headers, row, "Пользователь") || getField(section.headers, row, "Аккаунт");
            const rawTyp = getField(section.headers, row, "Тип").toUpperCase();
            const rawAction = getField(section.headers, row, "Действие").toUpperCase();
            if (rawAction === "TAKE" || rawTyp === "TAKE") action = "TAKE";
            else if (rawAction === "GIVE" || rawTyp === "GIVE") action = "GIVE";
            else action = allText.toLowerCase().includes("take") ? "TAKE" : "GIVE";
          } else if (stype === "family") {
            ptype = "family";
            locId = getField(section.headers, row, "Семья");
            const textField = getField(section.headers, row, "Текст");
            itemText = textField;
            quantity = getField(section.headers, row, "Кол-во") || "1";
            if (quantity === "1" || quantity === "") {
              const qmTxt = textField.match(/\(x(\d+)\)/i);
              if (qmTxt) quantity = qmTxt[1];
            }
            account = getField(section.headers, row, "Пользователь") || "";
            const rawAction = getField(section.headers, row, "Действие").toUpperCase();
            if (rawAction === "TAKE") action = "TAKE";
            else if (rawAction === "GIVE") action = "GIVE";
            else if (textField.includes("Кладет") || textField.includes("Кладёт")) action = "GIVE";
            else if (textField.includes("Берет") || textField.includes("Берёт")) action = "TAKE";
            else action = allText.toLowerCase().includes("take") ? "TAKE" : "GIVE";
            if (textField) {
              const m = textField.match(/(?:Берет|Берёт|Кладет|Кладёт)\s+(.+?)(?:\s+(?:со|на|из|в)\s+.+)?$/i);
              if (m) itemText = m[1].replace(/\s+\(x\d+\)\s*$/, "").replace(/\s+x\d+\s*$/, "").trim();
            }
          }

          const serial = extractSerial(itemText);
          if (serial && !isTrackableSerial(serial, faction)) continue;
          const logId = getField(section.headers, row, "Ид");
          const timeStr = getField(section.headers, row, "Время");
          const rawLine = [logId, `${pname} [${pid}]`, account, action, locId, itemText, quantity, timeStr].join("\t").replace(/\t+/g, "\t");
          const event: LogEvent = {
            log_id: logId, player_name: pname, player_id: pid, account, location_id: locId,
            datetime: timeStr, placement_type: ptype, action, raw_line: rawLine,
            property_type: propertyType, item_name: itemText, quantity, owner: ptype === "vehicle" ? owner.trim() : "", text: itemText,
          };
          processPlacementEvent(event, serial, itemText, serialEvents, armorEvents, ammoEvents, medkitEvents);
        } catch { continue; }
      }
    }
  } catch { /* ignore */ }

  return [
    removeDuplicates(serialEvents),
    removeDuplicates(armorEvents),
    removeDuplicates(ammoEvents),
    removeDuplicates(medkitEvents),
  ];
}
