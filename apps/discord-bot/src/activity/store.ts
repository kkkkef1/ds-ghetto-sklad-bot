// ===================== ХРАНИЛИЩЕ МП И СОБРАНИЙ =====================
//
// Отдельный JSON-файл (ACTIVITY_DATA_FILE, по умолчанию ./data/activity-store.json),
// не связанный с capt-store.json. Тот же принцип: загрузили в память, меняем
// на месте, сохраняем отложенно. Бот работает одним процессом.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface GuildSettings {
  guildId: string;
  /** N1 «Активити МП»: анонсы, напоминания и итоговые подбивки. */
  announceChannelId: string | null;
  /** N2: отметки админов и подбивка для старшего. */
  reportChannelId: string | null;
  /** Роли «админов» — те, кто отмечается и может регистрировать собрания. */
  adminRoleIds: string[];
  /** Роль старшего админа — подтверждает «был / не был». */
  seniorRoleId: string | null;
}

export interface ActivityEvent {
  id: string;
  guildId: string;
  name: string;
  /** 0 = вс ... 6 = сб */
  weekdays: number[];
  /** «ЧЧ:ММ» по МСК */
  startTime: string;
  /** За сколько минут до начала нужно быть в игре. */
  prepMinutes: number;
  /** Во сколько в день МП писать анонс, «ЧЧ:ММ» по МСК. */
  postTime: string;
  pingRoleId: string | null;
  enabled: boolean;
  /** Даты «ГГГГ-ММ-ДД», когда регулярного МП не будет. */
  skipDates: string[];
  /** Разовые даты (переносы): МП в эту дату и это время. */
  extraDates: { date: string; startTime: string }[];
}

export interface Mark {
  status: "yes" | "no";
  changedAt: number;
  /** Сообщение с этой отметкой в N2 (редактируется при смене). */
  messageId: string | null;
}

export interface MessageRef {
  channelId: string;
  messageId: string;
}

export interface Occurrence {
  id: string;
  kind: "event" | "meeting";
  guildId: string;
  eventId: string | null;
  /** Название МП или название роли-фракции для собрания. */
  title: string;
  pingRoleId: string | null;
  startAt: number;
  prepMinutes: number;
  createdAt: number;
  announce: (MessageRef & { postedAt: number }) | null;
  reminderDone: boolean;
  closed: boolean;
  canceled: boolean;
  /** userId -> отметка «буду / не буду». */
  marks: Record<string, Mark>;
  /** userId -> серверный ник на момент последней отметки/подбивки. */
  names: Record<string, string>;
  /** Список админов для подбивки (null — ещё не составлен). */
  adminIds: string[] | null;
  /** userId -> решение старшего. */
  confirm: Record<string, "present" | "absent">;
  reportMessages: MessageRef[];
  reportDone: boolean;
  summaryMessages: MessageRef[];
  summaryDone: boolean;
  /** Счётчик неудачных попыток по этапам, чтобы не долбить Discord бесконечно. */
  failures: Record<string, number>;
}

interface StoreData {
  guilds: Record<string, GuildSettings>;
  events: Record<string, ActivityEvent>;
  occurrences: Record<string, Occurrence>;
}

const DATA_FILE = process.env.ACTIVITY_DATA_FILE || `${process.cwd()}/data/activity-store.json`;

function load(): StoreData {
  try {
    if (existsSync(DATA_FILE)) {
      const parsed = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
      return {
        guilds: parsed.guilds ?? {},
        events: parsed.events ?? {},
        occurrences: parsed.occurrences ?? {},
      };
    }
  } catch (err) {
    console.error("[activity] Не удалось прочитать файл данных, начинаю с чистого состояния:", err);
  }
  return { guilds: {}, events: {}, occurrences: {} };
}

const data: StoreData = load();
let saveScheduled = false;

export function persist(): void {
  if (saveScheduled) return;
  saveScheduled = true;
  queueMicrotask(() => {
    saveScheduled = false;
    try {
      mkdirSync(dirname(DATA_FILE), { recursive: true });
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("[activity] Не удалось сохранить файл данных:", err);
    }
  });
}

function newId(): string {
  return randomBytes(4).toString("hex");
}

// ---- настройки серверов ----

export function getGuildSettings(guildId: string): GuildSettings {
  return (
    data.guilds[guildId] ?? {
      guildId,
      announceChannelId: null,
      reportChannelId: null,
      adminRoleIds: [],
      seniorRoleId: null,
    }
  );
}

export function updateGuildSettings(guildId: string, patch: Partial<Omit<GuildSettings, "guildId">>): GuildSettings {
  const next = { ...getGuildSettings(guildId), ...patch, guildId };
  data.guilds[guildId] = next;
  persist();
  return next;
}

// ---- МП ----

export function listEvents(guildId?: string): ActivityEvent[] {
  return Object.values(data.events).filter((e) => !guildId || e.guildId === guildId);
}

export function getEvent(id: string): ActivityEvent | undefined {
  return data.events[id];
}

export function addEvent(event: Omit<ActivityEvent, "id" | "enabled" | "skipDates" | "extraDates">): ActivityEvent {
  const created: ActivityEvent = { ...event, id: newId(), enabled: true, skipDates: [], extraDates: [] };
  data.events[created.id] = created;
  persist();
  return created;
}

export function removeEvent(id: string): boolean {
  if (!data.events[id]) return false;
  delete data.events[id];
  persist();
  return true;
}

// ---- проведения (конкретные МП/собрания с датой) ----

export function listOccurrences(): Occurrence[] {
  return Object.values(data.occurrences);
}

export function getOccurrence(id: string): Occurrence | undefined {
  return data.occurrences[id];
}

export function findEventOccurrence(eventId: string, startAt: number): Occurrence | undefined {
  return Object.values(data.occurrences).find((o) => o.eventId === eventId && o.startAt === startAt);
}

export function createOccurrence(
  base: Pick<Occurrence, "kind" | "guildId" | "eventId" | "title" | "pingRoleId" | "startAt" | "prepMinutes">
): Occurrence {
  const occ: Occurrence = {
    ...base,
    id: newId(),
    createdAt: Date.now(),
    announce: null,
    reminderDone: false,
    closed: false,
    canceled: false,
    marks: {},
    names: {},
    adminIds: null,
    confirm: {},
    reportMessages: [],
    reportDone: false,
    summaryMessages: [],
    summaryDone: false,
    failures: {},
  };
  data.occurrences[occ.id] = occ;
  persist();
  return occ;
}

export function removeOccurrence(id: string): void {
  delete data.occurrences[id];
  persist();
}

/** Удаляет проведения, с начала которых прошло больше keepDays дней. */
export function pruneOccurrences(now: number, keepDays = 14): void {
  const limit = now - keepDays * 24 * 60 * 60_000;
  let changed = false;
  for (const [id, occ] of Object.entries(data.occurrences)) {
    if (occ.startAt < limit) {
      delete data.occurrences[id];
      changed = true;
    }
  }
  if (changed) persist();
}
