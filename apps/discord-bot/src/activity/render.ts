// ===================== ТЕКСТЫ И КНОПКИ =====================

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Occurrence } from "./store.js";
import { formatDateTime } from "./time.js";

/** customId кнопок «Буду / Не буду» на анонсе: act_m:<id>:y|n */
export const MARK_PREFIX = "act_m:";
/** customId кнопок старшего «Был / Не был»: act_c:<id проведения>:<id админа>:p|a */
export const CONFIRM_PREFIX = "act_c:";

/** Сколько админов помещается в одно сообщение подбивки (по 2 кнопки на админа, 25 кнопок максимум). */
export const ADMINS_PER_PAGE = 10;

export interface Page {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

function timePart(ms: number): string {
  return formatDateTime(ms).slice(11);
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

export function renderAnnounce(occ: Occurrence): Page {
  if (occ.canceled) {
    return { content: `❌ **Отменено:** ${occTitle(occ)}, ${formatDateTime(occ.startAt)} (МСК)`, components: [] };
  }

  const ping = occ.pingRoleId ? `<@&${occ.pingRoleId}>\n` : "";
  let body: string;
  if (occ.kind === "event") {
    body =
      `**${occTitle(occ)}**\n` +
      `Начало в ${timePart(occ.startAt)} (МСК). За ${occ.prepMinutes} минут нужно быть в игре.`;
  } else {
    // Для собрания название — это и есть пинг роли фракции.
    return renderMeetingAnnounce(occ);
  }

  const content = `${ping}${body}\n\n**Кто будет?**${occ.closed ? "\n🔒 Отметка закрыта." : ""}`;
  return { content, components: [markRow(occ)] };
}

function renderMeetingAnnounce(occ: Occurrence): Page {
  const role = occ.pingRoleId ? `<@&${occ.pingRoleId}>` : occ.title;
  const content =
    `**Собрание** ${role}\n` +
    `📅 ${formatDateTime(occ.startAt)} (МСК)\n\n` +
    `**Кто будет?**${occ.closed ? "\n🔒 Отметка закрыта." : ""}`;
  return { content, components: [markRow(occ)] };
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
    return (
      `⏰ **Напоминание:** через 30 минут начнётся ${occTitle(occ)} — в ${timePart(occ.startAt)} (МСК). ` +
      `За ${occ.prepMinutes} минут нужно быть в игре.`
    );
  }
  const role = occ.pingRoleId ? `<@&${occ.pingRoleId}>` : occ.title;
  return `⏰ **Напоминание:** через 30 минут начнётся собрание ${role} — в ${timePart(occ.startAt)} (МСК).`;
}

// ---- отметка админа в N2 ----

export function renderMark(occ: Occurrence, userId: string): string {
  const mark = occ.marks[userId];
  const status = mark?.status === "yes" ? "✅ будет" : "❌ не будет";
  return `🗓 ${occTitle(occ)}, ${formatDateTime(occ.startAt)}: **${adminName(occ, userId)}** — ${status}`;
}

// ---- подбивка для старшего в N2 (с кнопками «Был / Не был») ----

function reportHeader(occ: Occurrence): string {
  return `📋 **Подбивка: ${occTitle(occ)}**\n📅 ${formatDateTime(occ.startAt)} (МСК)\nОтметьте, кто был:`;
}

function markText(occ: Occurrence, userId: string): string {
  const m = occ.marks[userId];
  return m ? (m.status === "yes" ? "✅ буду" : "❌ не буду") : "— нет отметки";
}

function confirmText(occ: Occurrence, userId: string): string {
  const c = occ.confirm[userId];
  return c === "present" ? "🟢 был" : c === "absent" ? "🔴 не был" : "⏳ ждёт";
}

export function renderReportPages(occ: Occurrence, seniorRoleId: string | null): Page[] {
  const ping = seniorRoleId ? `<@&${seniorRoleId}>\n` : "";
  const ids = sortedAdminIds(occ);

  if (!ids.length) {
    return [
      {
        content: `${ping}${reportHeader(occ)}\n\nСписок админов пуст — проверьте роли админов в настройках сервера.`,
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
    const head = start === 0 ? `${ping}${reportHeader(occ)}\n\n` : `📋 **${occTitle(occ)}** (продолжение)\n\n`;

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
            .setStyle(c === "present" ? ButtonStyle.Success : ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`${CONFIRM_PREFIX}${occ.id}:${id}:a`)
            .setLabel(`не был`)
            .setStyle(c === "absent" ? ButtonStyle.Danger : ButtonStyle.Secondary)
        );
      }
      rows.push(row);
    }
    pages.push({ content: head + lines.join("\n"), components: rows });
  }
  return pages;
}

// ---- итоговая подбивка в N1 ----

const PAGE_LIMIT = 1800;

export function renderSummaryPages(occ: Occurrence): string[] {
  const header = `📋 **Подбивка: ${occTitle(occ)}**\n📅 ${formatDateTime(occ.startAt)} (МСК)`;
  const ids = sortedAdminIds(occ);

  if (!ids.length) return [`${header}\n\nАдминов для подбивки нет.`];

  const present = ids.filter((id) => occ.confirm[id] === "present");
  const absent = ids.filter((id) => occ.confirm[id] === "absent");
  const pending = ids.filter((id) => !occ.confirm[id]);

  const lines: string[] = [
    ...present.map((id) => `${adminName(occ, id)} — присутствовал`),
    ...absent.map((id) => `${adminName(occ, id)} — отсутствовал`),
    ...pending.map((id) => `${adminName(occ, id)} — ⏳ не подтверждено старшим`),
  ];

  const pages: string[] = [];
  let current = header + "\n";
  for (const line of lines) {
    if (current.length + line.length + 1 > PAGE_LIMIT) {
      pages.push(current.trimEnd());
      current = `📋 **${occTitle(occ)}** (продолжение)\n`;
    }
    current += `\n${line}`;
  }
  pages.push(current.trimEnd());
  return pages;
}
