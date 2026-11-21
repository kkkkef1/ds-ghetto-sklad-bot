// ===================== ТЕКСТЫ И КНОПКИ =====================

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from "discord.js";
import type { Occurrence } from "./store.js";
import { addDaysToKey, formatDateTime, mskDateKey } from "./time.js";

/** customId кнопок «Буду / Не буду» на анонсе: act_m:<id>:y|n */
export const MARK_PREFIX = "act_m:";
/** customId кнопок старшего «Был / Не был»: act_c:<id проведения>:<id админа>:p|a */
export const CONFIRM_PREFIX = "act_c:";

/** Сколько админов помещается в одно сообщение проверки присутствия (по 2 кнопки на админа, 25 кнопок максимум). */
export const ADMINS_PER_PAGE = 10;

export interface Page {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** Разделитель — тот же, что в сообщениях о каптах. */
const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

/** Оборачивает строки в разделители сверху и снизу. */
function frame(...lines: string[]): string {
  return [DIVIDER, ...lines, DIVIDER].join("\n");
}

function timePart(ms: number): string {
  return formatDateTime(ms).slice(11);
}

/**
 * «Сегодня в 20:00» / «Завтра в 20:00» / «18.11.2026 в 20:00» — относительно момента публикации сообщения
 * (refMs), чтобы текст не менялся при последующих правках сообщения.
 */
function whenText(startAt: number, refMs: number): string {
  const day = mskDateKey(startAt);
  const ref = mskDateKey(refMs);
  const time = timePart(startAt);
  if (day === ref) return `Сегодня в ${time}`;
  if (day === addDaysToKey(ref, 1)) return `Завтра в ${time}`;
  return `${formatDateTime(startAt).slice(0, 10)} в ${time}`;
}

/** «1 минуту / 2 минуты / 10 минут». */
function minutesText(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "минуту" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "минуты" : "минут";
  return `${n} ${word}`;
}

/** «Мероприятие "BLACKOUT"» / «Собрание Bloods». */
export function occTitle(occ: Occurrence): string {
  return occ.kind === "event" ? `Мероприятие "${occ.title}"` : `Собрание ${occ.title}`;
}

export function adminName(occ: Occurrence, userId: string): string {
  return occ.names[userId] ?? `ID ${userId}`;
}

function sortedAdminIds(occ: Occurrence): string[] {
  return [...(occ.adminIds ?? [])].sort((a, b) => adminName(occ, a).localeCompare(adminName(occ, b), "ru"));
}

// ---- анонс в N1 ----

/**
 * Версия вида анонса. Когда она растёт, бот при запуске один раз перерисовывает уже опубликованные
 * анонсы (см. refreshAnnouncements в service.ts). v2: под датой показывается список «Буду / Не буду».
 */
export const ANNOUNCE_LAYOUT = 2;

/** Сколько символов отводим под список отметок в анонсе (лимит сообщения Discord — 2000). */
const MARKS_BUDGET = 1200;

/** Ник для вывода в анонсе: без разметки Markdown и без рабочих упоминаний. */
function safeName(occ: Occurrence, userId: string): string {
  return escapeMarkdown(adminName(occ, userId))
    .replace(/\s+/g, " ")
    .replace(/@/g, "@\u200b");
}

/**
 * Список отметок под датой, цитатой (вертикальная черта слева):
 *   > ✅ Ivan Petrov
 *   > ❌ Sam Ford
 * Сначала «Буду», потом «Не буду», внутри группы — по времени нажатия (сменил выбор — оказался в конце другой группы).
 * Пустая группа не показывается. Когда отметка закрыта или никто не нажал — пусто. В конце — пустая строка-отступ.
 */
function marksBlock(occ: Occurrence): string[] {
  if (occ.closed) return [];
  const ids = Object.keys(occ.marks).sort((a, b) => occ.marks[a].changedAt - occ.marks[b].changedAt);
  const rows = [
    ...ids.filter((id) => occ.marks[id].status === "yes").map((id) => `> ✅ ${safeName(occ, id)}`),
    ...ids.filter((id) => occ.marks[id].status === "no").map((id) => `> ❌ ${safeName(occ, id)}`),
  ];
  if (!rows.length) return [];

  const shown: string[] = [];
  let size = 0;
  for (const row of rows) {
    if (size + row.length + 1 > MARKS_BUDGET) break;
    shown.push(row);
    size += row.length + 1;
  }
  if (shown.length < rows.length) shown.push(`> … и ещё ${rows.length - shown.length}`);
  return [...shown, ""];
}

export function renderAnnounce(occ: Occurrence): Page {
  if (occ.canceled) {
    return {
      content: frame(`**Отменено:** ${occTitle(occ)}`, `Дата: ${formatDateTime(occ.startAt)} (МСК)`),
      components: [],
    };
  }
  if (occ.kind === "meeting") return renderMeetingAnnounce(occ);

  const ping = occ.pingRoleId ? `<@&${occ.pingRoleId}>\n` : "";
  const lines = [
    `**${occTitle(occ)}**`,
    `Начало: **${whenText(occ.startAt, occ.announce?.postedAt ?? Date.now())}** (МСК)`,
    `В игре нужно быть за **${minutesText(occ.prepMinutes)}** до начала.`,
    "",
    ...marksBlock(occ),
    occ.closed ? "**Отметка закрыта**" : "**Кто будет?**",
  ];
  return { content: ping + frame(...lines), components: [markRow(occ)] };
}

function renderMeetingAnnounce(occ: Occurrence): Page {
  const role = occ.pingRoleId ? `<@&${occ.pingRoleId}>` : occ.title;
  const lines = [
    `**Собрание** ${role}`,
    `Дата: **${formatDateTime(occ.startAt)}** (МСК)`,
    "",
    ...marksBlock(occ),
    occ.closed ? "**Отметка закрыта**" : "**Кто будет?**",
  ];
  return { content: frame(...lines), components: [markRow(occ)] };
}

function markRow(occ: Occurrence): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MARK_PREFIX}${occ.id}:y`)
      .setLabel("Буду")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(occ.closed),
    new ButtonBuilder()
      .setCustomId(`${MARK_PREFIX}${occ.id}:n`)
      .setLabel("Не буду")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(occ.closed)
  );
}

// ---- напоминание за 30 минут (общий текст, без отметок) ----

export function renderReminder(occ: Occurrence): string {
  if (occ.kind === "event") {
    // Пингуем ту же роль, что и в анонсе (в тексте должно быть упоминание, иначе роль не получит пинг).
    const ping = occ.pingRoleId ? `<@&${occ.pingRoleId}>\n` : "";
    return ping + frame(
      `**Напоминание:** через 30 минут начнётся ${occTitle(occ)}`,
      `Начало: **${whenText(occ.startAt, Date.now())}** (МСК)`,
      `В игре нужно быть за **${minutesText(occ.prepMinutes)}** до начала.`
    );
  }
  const role = occ.pingRoleId ? `<@&${occ.pingRoleId}>` : occ.title;
  return frame(
    `**Напоминание:** через 30 минут начнётся собрание ${role}`,
    `Начало: **${whenText(occ.startAt, Date.now())}** (МСК)`
  );
}

// ---- одно сообщение на МП в N2: кто отметился (после итогов оно же становится итоговым) ----

export function renderBoard(occ: Occurrence): string {
  const names = (status: "yes" | "no") =>
    Object.keys(occ.marks)
      .filter((id) => occ.marks[id].status === status)
      .map((id) => adminName(occ, id))
      .sort((a, b) => a.localeCompare(b, "ru"));
  const yes = names("yes");
  const no = names("no");
  const line = (icon: string, label: string, list: string[]) =>
    list.length ? `${icon} **${label} (${list.length}):** ${list.join(", ")}` : `${icon} **${label}:** никто`;
  return frame(
    `**${occTitle(occ)}**`,
    `Начало: ${formatDateTime(occ.startAt)} (МСК)`,
    "",
    line("✅", "Будут", yes),
    line("❌", "Не будут", no)
  );
}

export function renderBoardCanceled(occ: Occurrence): string {
  return frame(`**Отменено:** ${occTitle(occ)}`, `Дата: ${formatDateTime(occ.startAt)} (МСК)`);
}

// ---- проверка присутствия для старшего в N2 (с кнопками «Был / Не был») ----

function reportHeader(occ: Occurrence): string[] {
  return [`**Присутствие: ${occTitle(occ)}**`, `Начало: ${formatDateTime(occ.startAt)} (МСК)`, "Отметьте, кто был:"];
}

function markText(occ: Occurrence, userId: string): string {
  const m = occ.marks[userId];
  return m ? (m.status === "yes" ? "✅ буду" : "❌ не буду") : "нет отметки";
}

function confirmText(occ: Occurrence, userId: string): string {
  const c = occ.confirm[userId];
  return c === "present" ? "🟢 был" : c === "absent" ? "🔴 не был" : "ожидает";
}

export function renderReportPages(occ: Occurrence, seniorRoleId: string | null, locked = false): Page[] {
  const ping = seniorRoleId ? `<@&${seniorRoleId}>\n` : "";
  const ids = sortedAdminIds(occ);

  if (!ids.length) {
    return [
      {
        content:
          ping +
          frame(
            ...reportHeader(occ),
            "",
            occ.kind === "meeting"
              ? "Список пуст: среди админов нет носителей роли собрания, и никто не отметился «Буду»."
              : "Список админов пуст — проверьте роли админов в настройках сервера."
          ),
        components: [],
      },
    ];
  }

  const pages: Page[] = [];
  for (let start = 0; start < ids.length; start += ADMINS_PER_PAGE) {
    const chunk = ids.slice(start, start + ADMINS_PER_PAGE);
    const lines = chunk.map(
      (id) => `• **${adminName(occ, id)}** — отметка: ${markText(occ, id)} | итог: ${confirmText(occ, id)}`
    );
    const head =
      start === 0
        ? [...reportHeader(occ), ""]
        : [`**Присутствие: ${occTitle(occ)}** (продолжение)`, ""];

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < chunk.length; i += 2) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const id of chunk.slice(i, i + 2)) {
        const short = adminName(occ, id).slice(0, 30);
        const c = occ.confirm[id];
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`${CONFIRM_PREFIX}${occ.id}:${id}:p`)
            .setLabel(`${short}: был`)
            .setStyle(c === "present" ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(locked),
          new ButtonBuilder()
            .setCustomId(`${CONFIRM_PREFIX}${occ.id}:${id}:a`)
            .setLabel(`не был`)
            .setStyle(c === "absent" ? ButtonStyle.Danger : ButtonStyle.Secondary)
            .setDisabled(locked)
        );
      }
      rows.push(row);
    }
    pages.push({ content: (start === 0 ? ping : "") + frame(...head, ...lines), components: rows });
  }
  return pages;
}

// ---- итоги в N1 ----

const PAGE_LIMIT = 1800;

/** Через сколько после начала итоги считаются окончательными, даже если старший отметил не всех. */
export const SUMMARY_FINAL_AFTER_MS = 60 * 60_000;

/** Итоги окончательные: старший отметил всех или прошёл час после начала. */
export function summaryIsFinal(occ: Occurrence, now = Date.now()): boolean {
  const ids = occ.adminIds ?? [];
  const allDone = ids.length > 0 && ids.every((id) => occ.confirm[id]);
  return allDone || now >= occ.startAt + SUMMARY_FINAL_AFTER_MS;
}

/**
 * Итоги в N1. Сразу после начала МП в них только заголовок, а присутствующие добавляются по мере отметки старшим.
 * Неотмеченные называются поимённо только в окончательном виде (всех отметили или прошёл час).
 */
export function renderSummaryPages(occ: Occurrence): string[] {
  const header = [`**Итоги: ${occTitle(occ)}**`, `Начало: ${formatDateTime(occ.startAt)} (МСК)`];
  const ids = sortedAdminIds(occ);

  if (!ids.length) return [frame(...header, "", "Админов для проверки нет.")];

  const present = ids.filter((id) => occ.confirm[id] === "present");
  const absent = ids.filter((id) => occ.confirm[id] === "absent");
  const pending = ids.filter((id) => !occ.confirm[id]);
  const final = summaryIsFinal(occ);

  const lines: string[] = [
    ...present.map((id) => `🟢 ${adminName(occ, id)} — присутствовал`),
    ...absent.map((id) => `🔴 ${adminName(occ, id)} — отсутствовал`),
    ...(final ? pending.map((id) => `${adminName(occ, id)} — не подтверждено старшим`) : []),
  ];
  if (!final && pending.length) {
    if (!present.length && !absent.length) lines.push("Присутствующих пока не отмечено.");
    lines.push(`Ждём отметки старшего: ещё ${pending.length}`);
  }

  // Разделители занимают место в лимите сообщения.
  const budget = PAGE_LIMIT - DIVIDER.length * 2 - 10;
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > budget && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  chunks.push(current);

  return chunks.map((chunk, i) =>
    frame(...(i === 0 ? header : [`**Итоги: ${occTitle(occ)}** (продолжение)`]), "", ...chunk)
  );
}
