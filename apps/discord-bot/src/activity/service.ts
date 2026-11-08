// ===================== ПЛАНИРОВЩИК И ОБРАБОТКА КНОПОК =====================
//
// Раз в TICK_MS бот проходит по всем МП и проведениям и делает то, что уже
// наступило по времени (все этапы идемпотентны, состояние лежит в store.ts,
// так что рестарт бота ничего не ломает):
//   1. анонс в N1 («Кто будет?» + кнопки) — в «время поста» дня МП или сразу при
//      регистрации собрания;
//   2. напоминание в N1 за 30 минут до начала (только если анонс был раньше);
//   3. закрытие отметки в момент начала (кнопки на анонсе гаснут);
//   4. сразу после начала — проверка присутствия в N2 для старшего (кнопки «был / не был»);
//   5. итоги в N1: как только старший подтвердил всех, либо через час после
//      начала (тогда неподтверждённые помечены, а сообщение дальше редактируется).

import { Events, type ButtonInteraction, type Client, type GuildMember, type TextChannel } from "discord.js";
import { isCreatorOrModerator } from "../captTracker/store.js";
import {
  adminName,
  renderAnnounce,
  renderMark,
  renderReminder,
  renderReportPages,
  renderSummaryPages,
  type Page,
} from "./render.js";
import {
  createOccurrence,
  findEventOccurrence,
  getGuildSettings,
  getOccurrence,
  listEvents,
  listOccurrences,
  persist,
  pruneOccurrences,
  removeOccurrence,
  type ActivityEvent,
  type GuildSettings,
  type MessageRef,
  type Occurrence,
} from "./store.js";
import { addDaysToKey, mskDateKey, mskToUtcMs, MINUTE_MS, weekdayOfKey } from "./time.js";

const TICK_MS = 20_000;
const REMINDER_BEFORE_MS = 30 * MINUTE_MS;
const REPORT_AFTER_MS = 0; // сообщение старшему уходит сразу после начала
const SUMMARY_AFTER_MS = 60 * MINUTE_MS;
/** Как часто один админ может менять свою отметку. */
export const MARK_CHANGE_COOLDOWN_MS = 15 * MINUTE_MS;
const MAX_STAGE_FAILURES = 5;

const UNKNOWN_MESSAGE = 10008;

let client: Client | null = null;

function discordErrorCode(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "code" in err ? Number((err as { code: unknown }).code) : undefined;
}

// ---- блокировка на одно проведение: тик и нажатия кнопок не должны работать с ним одновременно ----

const chains = new Map<string, Promise<void>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

// ---- вспомогательное ----

async function getChannel(channelId: string | null): Promise<TextChannel | null> {
  if (!client || !channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  return channel as TextChannel;
}

export async function getMember(interaction: { guild: ButtonInteraction["guild"]; user: { id: string } }): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  const cached = guild.members.cache.get(interaction.user.id);
  if (cached) return cached;
  return guild.members.fetch(interaction.user.id).catch(() => null);
}

export function isAdminMember(settings: GuildSettings, member: GuildMember): boolean {
  return (
    settings.adminRoleIds.some((id) => member.roles.cache.has(id)) ||
    (settings.seniorRoleId !== null && member.roles.cache.has(settings.seniorRoleId))
  );
}

export function isSeniorMember(settings: GuildSettings, member: GuildMember): boolean {
  return settings.seniorRoleId !== null && member.roles.cache.has(settings.seniorRoleId);
}

function allConfirmed(occ: Occurrence): boolean {
  return !!occ.adminIds && occ.adminIds.length > 0 && occ.adminIds.every((id) => occ.confirm[id]);
}

/**
 * Отправляет страницы сообщения: существующие сообщения редактирует, недостающие
 * досылает, лишние удаляет. `refs` — массив самого проведения, он дополняется по
 * ходу дела, так что при сбое посередине повторная попытка не создаст дублей.
 */
async function syncPages(channel: TextChannel, refs: MessageRef[], pages: Page[], pingRoleIds: string[]): Promise<void> {
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const existing = refs[i];
    if (existing) {
      try {
        await channel.messages.edit(existing.messageId, { content: page.content, components: page.components });
        continue;
      } catch (err) {
        if (discordErrorCode(err) !== UNKNOWN_MESSAGE) throw err;
        // сообщение удалили вручную — отправим заново
      }
    }
    const sent = await channel.send({
      content: page.content,
      components: page.components,
      allowedMentions: { roles: i === 0 ? pingRoleIds : [] },
    });
    refs[i] = { channelId: channel.id, messageId: sent.id };
    persist();
  }
  while (refs.length > pages.length) {
    const extra = refs.pop();
    if (extra) await channel.messages.delete(extra.messageId).catch(() => undefined);
    persist();
  }
}

// ---- этапы ----

async function publishAnnounce(occ: Occurrence): Promise<void> {
  const settings = getGuildSettings(occ.guildId);
  const channel = await getChannel(settings.announceChannelId);
  if (!channel) throw new Error("канал N1 («Активити МП») не настроен или недоступен");
  const page = renderAnnounce(occ);
  const sent = await channel.send({
    content: page.content,
    components: page.components,
    allowedMentions: { roles: occ.pingRoleId ? [occ.pingRoleId] : [] },
  });
  occ.announce = { channelId: channel.id, messageId: sent.id, postedAt: Date.now() };
  persist();
}

/** Перерисовывает анонс (закрытие отметки, отмена). */
async function editAnnounce(occ: Occurrence): Promise<void> {
  if (!occ.announce) return;
  const channel = await getChannel(occ.announce.channelId);
  if (!channel) return;
  const page = renderAnnounce(occ);
  try {
    await channel.messages.edit(occ.announce.messageId, {
      content: page.content,
      components: page.components,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    if (discordErrorCode(err) !== UNKNOWN_MESSAGE) throw err;
  }
}

async function sendReminder(occ: Occurrence): Promise<void> {
  if (!occ.announce) return;
  const channel = await getChannel(occ.announce.channelId);
  if (!channel) throw new Error("канал N1 недоступен");
  await channel.send({
    content: renderReminder(occ),
    allowedMentions: { roles: occ.pingRoleId ? [occ.pingRoleId] : [] },
    reply: { messageReference: occ.announce.messageId, failIfNotExists: false },
  });
}

/** Составляет список админов для проверки присутствия: носители админских ролей + все, кто отмечался. */
async function ensureSnapshot(occ: Occurrence): Promise<void> {
  if (occ.adminIds) return;
  if (!client) throw new Error("клиент Discord не готов");

  const settings = getGuildSettings(occ.guildId);
  const guild = await client.guilds.fetch(occ.guildId);
  try {
    await guild.members.fetch();
  } catch (err) {
    // Чаще всего — не включён интент Server Members. Работаем с тем, что есть в кэше.
    console.error(`[activity] Не удалось загрузить участников сервера ${occ.guildId}:`, err);
  }

  const ids = new Set<string>(Object.keys(occ.marks));
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    if (settings.adminRoleIds.some((roleId) => member.roles.cache.has(roleId))) ids.add(member.id);
  }
  for (const id of ids) {
    const member = guild.members.cache.get(id);
    if (member) occ.names[id] = member.displayName;
  }
  occ.adminIds = [...ids];
  persist();
}

async function sendReport(occ: Occurrence): Promise<void> {
  await ensureSnapshot(occ);
  const settings = getGuildSettings(occ.guildId);
  const channel = await getChannel(settings.reportChannelId);
  if (!channel) throw new Error("канал N2 не настроен или недоступен");
  const pages = renderReportPages(occ, settings.seniorRoleId);
  await syncPages(channel, occ.reportMessages, pages, settings.seniorRoleId ? [settings.seniorRoleId] : []);
  occ.reportDone = true;
  persist();
}

/** Отправляет итоги в N1 или обновляет уже отправленный. */
async function syncSummary(occ: Occurrence): Promise<void> {
  await ensureSnapshot(occ);
  const settings = getGuildSettings(occ.guildId);
  const channel = await getChannel(settings.announceChannelId);
  if (!channel) throw new Error("канал N1 недоступен");
  const pages = renderSummaryPages(occ).map((content) => ({ content, components: [] }));
  await syncPages(channel, occ.summaryMessages, pages, []);
  occ.summaryDone = true;
  persist();
}

async function tryStage(occ: Occurrence, stage: string, fn: () => Promise<void>): Promise<void> {
  if ((occ.failures[stage] ?? 0) >= MAX_STAGE_FAILURES) return;
  try {
    await fn();
  } catch (err) {
    occ.failures[stage] = (occ.failures[stage] ?? 0) + 1;
    persist();
    console.error(`[activity] Этап «${stage}» (${occ.id}) не удался (попытка ${occ.failures[stage]}/${MAX_STAGE_FAILURES}):`, err);
  }
}

async function processOccurrence(occ: Occurrence, now: number): Promise<void> {
  if (!getOccurrence(occ.id) || occ.canceled) return;
  const settings = getGuildSettings(occ.guildId);

  // 1. анонс
  if (!occ.announce) {
    if (now >= occ.startAt) {
      // Анонс так и не вышел до начала (бот лежал / канал был недоступен) — тихо закрываем.
      occ.canceled = true;
      persist();
      return;
    }
    await tryStage(occ, "announce", () => publishAnnounce(occ));
    return;
  }

  // 2. напоминание: только если анонс вышел раньше, чем за 30 минут до начала
  if (!occ.reminderDone && now >= occ.startAt - REMINDER_BEFORE_MS) {
    if (now < occ.startAt && occ.announce.postedAt < occ.startAt - REMINDER_BEFORE_MS) {
      await tryStage(occ, "reminder", () => sendReminder(occ));
      if ((occ.failures["reminder"] ?? 0) === 0 || (occ.failures["reminder"] ?? 0) >= MAX_STAGE_FAILURES) {
        occ.reminderDone = true;
        persist();
      }
    } else {
      occ.reminderDone = true;
      persist();
    }
  }

  // 3. закрытие отметки
  if (!occ.closed && now >= occ.startAt) {
    occ.closed = true;
    persist();
    await tryStage(occ, "close", () => editAnnounce(occ));
  }

  // 4. проверка присутствия для старшего в N2
  if (!occ.reportDone && now >= occ.startAt + REPORT_AFTER_MS && settings.reportChannelId) {
    await tryStage(occ, "report", () => sendReport(occ));
  }

  // 5. итоги в N1
  if (!occ.summaryDone && now >= occ.startAt + REPORT_AFTER_MS) {
    const ready = now >= occ.startAt + SUMMARY_AFTER_MS || (occ.reportDone && allConfirmed(occ));
    if (ready) await tryStage(occ, "summary", () => syncSummary(occ));
  }
}

/** Создаёт проведения МП на сегодня/завтра, у которых уже наступило время анонса. */
function scheduleEvents(now: number): void {
  const today = mskDateKey(now);
  for (const event of listEvents()) {
    if (!event.enabled) continue;
    if (!getGuildSettings(event.guildId).announceChannelId) continue;

    for (const dateKey of [today, addDaysToKey(today, 1)]) {
      for (const time of startTimesFor(event, dateKey)) {
        const startAt = mskToUtcMs(dateKey, time);
        if (startAt <= now) continue;
        // Анонс — в «время поста», но не позже чем за час до начала.
        const postAt = Math.min(mskToUtcMs(dateKey, event.postTime), startAt - 60 * MINUTE_MS);
        if (now < postAt) continue;
        if (findEventOccurrence(event.id, startAt)) continue;
        createOccurrence({
          kind: "event",
          guildId: event.guildId,
          eventId: event.id,
          title: event.name,
          pingRoleId: event.pingRoleId,
          startAt,
          prepMinutes: event.prepMinutes,
        });
      }
    }
  }
}

/** Времена начала МП в указанную дату: регулярное (если не пропущено) + разовые переносы. */
export function startTimesFor(event: ActivityEvent, dateKey: string): string[] {
  const times: string[] = [];
  if (!event.skipDates.includes(dateKey) && event.weekdays.includes(weekdayOfKey(dateKey))) times.push(event.startTime);
  for (const extra of event.extraDates) {
    if (extra.date === dateKey && !times.includes(extra.startTime)) times.push(extra.startTime);
  }
  return times;
}

let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    scheduleEvents(now);
    for (const occ of listOccurrences()) {
      if (occ.canceled || (occ.summaryDone && occ.closed && occ.reminderDone)) continue;
      await withLock(occ.id, () => processOccurrence(occ, now));
    }
    pruneOccurrences(now);
  } catch (err) {
    console.error("[activity] Ошибка планировщика:", err);
  } finally {
    ticking = false;
  }
}

/** Подключает планировщик к клиенту. Вызывать один раз до login. */
export function initActivity(c: Client): void {
  client = c;
  c.once(Events.ClientReady, () => {
    void tick();
    setInterval(() => void tick(), TICK_MS).unref();
  });
}

// ---- для команд ----

/** Регистрирует собрание и сразу публикует анонс в N1. При ошибке публикации регистрация откатывается. */
export async function createMeeting(guildId: string, roleId: string, roleName: string, startAt: number): Promise<Occurrence> {
  const occ = createOccurrence({
    kind: "meeting",
    guildId,
    eventId: null,
    title: roleName,
    pingRoleId: roleId,
    startAt,
    prepMinutes: 0,
  });
  try {
    await withLock(occ.id, async () => {
      if (!occ.announce) await publishAnnounce(occ);
    });
  } catch (err) {
    removeOccurrence(occ.id);
    throw err;
  }
  return occ;
}

/** Отменяет проведение: анонс перерисовывается как «Отменено», кнопки пропадают. */
export async function cancelOccurrence(occ: Occurrence): Promise<void> {
  await withLock(occ.id, async () => {
    occ.canceled = true;
    persist();
    try {
      await editAnnounce(occ);
    } catch (err) {
      console.error(`[activity] Не удалось пометить анонс ${occ.id} отменённым:`, err);
    }
  });
}

// ---- кнопки ----

/** «Буду / Не буду» на анонсе. */
export async function handleMarkButton(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const [, occId, choice] = interaction.customId.split(":");
  const reply = (content: string) => interaction.editReply({ content });

  await withLock(occId, async () => {
    const occ = getOccurrence(occId);
    if (!occ || occ.canceled || interaction.guildId !== occ.guildId) {
      await reply("Это мероприятие уже неактуально.");
      return;
    }
    const now = Date.now();
    if (now >= occ.startAt) {
      await reply("Отметка закрыта: мероприятие уже началось.");
      return;
    }

    const settings = getGuildSettings(occ.guildId);
    const member = await getMember(interaction);
    if (!member || !isAdminMember(settings, member)) {
      await reply("Отмечаться могут только админы.");
      return;
    }

    const status = choice === "y" ? "yes" : "no";
    const label = status === "yes" ? "✅ будете" : "❌ не будете";
    const existing = occ.marks[member.id];
    if (existing && existing.status === status) {
      await reply(`Вы уже отметили: ${label}.`);
      return;
    }
    if (existing) {
      const wait = existing.changedAt + MARK_CHANGE_COOLDOWN_MS - now;
      if (wait > 0) {
        await reply(`Менять отметку можно раз в 15 минут. Попробуйте через ${Math.ceil(wait / MINUTE_MS)} мин.`);
        return;
      }
    }

    occ.names[member.id] = member.displayName;
    occ.marks[member.id] = { status, changedAt: now, messageId: existing?.messageId ?? null };
    persist();

    try {
      await publishMark(occ, member.id);
    } catch (err) {
      console.error(`[activity] Не удалось отправить отметку в N2 (${occ.id}):`, err);
    }
    await reply(`Записал: вы ${label}.`);
  });
}

/** Сообщение с отметкой админа в N2: новое при первой отметке, редактируется при смене. */
async function publishMark(occ: Occurrence, userId: string): Promise<void> {
  const settings = getGuildSettings(occ.guildId);
  const channel = await getChannel(settings.reportChannelId);
  if (!channel) return; // N2 не настроен — отметка просто сохранена
  const mark = occ.marks[userId];
  const content = renderMark(occ, userId);

  if (mark.messageId) {
    try {
      await channel.messages.edit(mark.messageId, { content, allowedMentions: { parse: [] } });
      return;
    } catch (err) {
      if (discordErrorCode(err) !== UNKNOWN_MESSAGE) throw err;
    }
  }
  const sent = await channel.send({ content, allowedMentions: { parse: [] } });
  mark.messageId = sent.id;
  persist();
}

/** «Был / Не был» под админом в сообщении для старшего. Повторное нажатие на ту же кнопку снимает решение. */
export async function handleConfirmButton(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  const [, occId, userId, action] = interaction.customId.split(":");
  const notify = (content: string) => interaction.followUp({ content, ephemeral: true }).catch(() => undefined);

  await withLock(occId, async () => {
    const occ = getOccurrence(occId);
    if (!occ || occ.canceled || interaction.guildId !== occ.guildId) {
      await notify("Это мероприятие уже неактуально.");
      return;
    }
    const settings = getGuildSettings(occ.guildId);
    const member = await getMember(interaction);
    const allowed = isCreatorOrModerator(interaction.user.id) || (member !== null && isSeniorMember(settings, member));
    if (!allowed) {
      await notify("Подтверждать «был / не был» может только старший админ или модератор.");
      return;
    }
    if (!occ.adminIds?.includes(userId)) {
      await notify("Этого админа нет в списке.");
      return;
    }

    const value = action === "p" ? "present" : "absent";
    if (occ.confirm[userId] === value) delete occ.confirm[userId];
    else occ.confirm[userId] = value;
    persist();

    // Перерисовать то сообщение, на котором нажали.
    const pages = renderReportPages(occ, settings.seniorRoleId);
    const idx = occ.reportMessages.findIndex((r) => r.messageId === interaction.message.id);
    if (idx >= 0 && pages[idx]) {
      await interaction
        .editReply({ content: pages[idx].content, components: pages[idx].components })
        .catch((err) => console.error("[activity] Не удалось обновить проверку присутствия:", err));
    }

    // Итоги в N1: отправить, когда подтверждены все; уже отправленный — отредактировать.
    if (occ.summaryDone || allConfirmed(occ)) {
      try {
        await syncSummary(occ);
      } catch (err) {
        console.error(`[activity] Не удалось обновить итоги (${occ.id}):`, err);
        await notify("Решение сохранено, но итоги в канале «Активити МП» обновить не удалось. Попробую позже.");
      }
    }
  });
}

export { adminName };
