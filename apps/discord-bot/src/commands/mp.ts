import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import { CREATOR_ID, MAIN_GUILD_ID } from "../captTracker/config.js";
import { getHelpers } from "../captTracker/store.js";
import { cancelOccurrence, startTimesFor } from "../activity/service.js";
import {
  addEvent,
  getEvent,
  getGuildSettings,
  listEvents,
  listOccurrences,
  persist,
  removeEvent,
  updateGuildSettings,
  type ActivityEvent,
} from "../activity/store.js";
import {
  formatDateKey,
  formatDays,
  mskDateKey,
  mskToUtcMs,
  parseDateInput,
  parseDays,
  parseTime,
} from "../activity/time.js";
import { parseIds, resolveGuildId, respondWithGuilds } from "../activity/util.js";

const SERVER_DESC = "Сервер, где есть бот (выберите из подсказок)";
const EVENT_DESC = "МП (выберите из подсказок)";

export const data = new SlashCommandBuilder()
  .setName("mp")
  .setDescription("Настройка МП (еженедельных мероприятий) и подбивок")
  .setDMPermission(false)
  .addSubcommand((sc) =>
    sc
      .setName("settings")
      .setDescription("Показать настройки сервера и список МП")
      .addStringOption((o) => o.setName("server").setDescription(SERVER_DESC).setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("set-channel")
      .setDescription("Задать канал N1 («Активити МП») или N2 (отметки админов и подбивка старшему)")
      .addStringOption((o) => o.setName("server").setDescription(SERVER_DESC).setRequired(true).setAutocomplete(true))
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Какой канал задаём")
          .setRequired(true)
          .addChoices(
            { name: "N1 — Активити МП (анонсы, напоминания, итоги)", value: "announce" },
            { name: "N2 — отметки админов и подбивка старшему", value: "report" }
          )
      )
      .addStringOption((o) =>
        o.setName("channel").setDescription("ID канала или #упоминание").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("set-admin-roles")
      .setDescription("Роли админов (можно несколько): они отмечаются и могут регистрировать собрания")
      .addStringOption((o) => o.setName("server").setDescription(SERVER_DESC).setRequired(true).setAutocomplete(true))
      .addStringOption((o) =>
        o
          .setName("roles")
          .setDescription("ID ролей или @упоминания через пробел; none — очистить список")
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("set-senior-role")
      .setDescription("Роль старшего админа: подтверждает «был / не был»")
      .addStringOption((o) => o.setName("server").setDescription(SERVER_DESC).setRequired(true).setAutocomplete(true))
      .addStringOption((o) =>
        o.setName("role").setDescription("ID роли или @упоминание; none — убрать").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Добавить МП (повторяется каждую неделю)")
      .addStringOption((o) => o.setName("server").setDescription(SERVER_DESC).setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("name").setDescription("Название, например BLACKOUT").setRequired(true))
      .addStringOption((o) =>
        o.setName("days").setDescription("Дни недели: вт или пн ср пт; «все» — каждый день").setRequired(true)
      )
      .addStringOption((o) => o.setName("time").setDescription("Время начала по МСК, например 18:00").setRequired(true))
      .addIntegerOption((o) =>
        o.setName("prep").setDescription("За сколько минут нужно быть в игре (по умолчанию 10)").setMinValue(0).setMaxValue(180)
      )
      .addStringOption((o) =>
        o.setName("post").setDescription("Во сколько писать анонс по МСК (по умолчанию 09:00)")
      )
      .addStringOption((o) => o.setName("role").setDescription("Роль для пинга: ID или @упоминание"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("edit")
      .setDescription("Изменить МП (укажите только то, что меняется)")
      .addStringOption((o) => o.setName("event").setDescription(EVENT_DESC).setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("name").setDescription("Новое название"))
      .addStringOption((o) => o.setName("days").setDescription("Новые дни недели"))
      .addStringOption((o) => o.setName("time").setDescription("Новое время начала по МСК"))
      .addIntegerOption((o) =>
        o.setName("prep").setDescription("За сколько минут быть в игре").setMinValue(0).setMaxValue(180)
      )
      .addStringOption((o) => o.setName("post").setDescription("Во сколько писать анонс по МСК"))
      .addStringOption((o) => o.setName("role").setDescription("Роль для пинга: ID, @упоминание или none"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("toggle")
      .setDescription("Включить или отключить МП, не удаляя его")
      .addStringOption((o) => o.setName("event").setDescription(EVENT_DESC).setRequired(true).setAutocomplete(true))
      .addBooleanOption((o) => o.setName("enabled").setDescription("true — включить, false — отключить").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("skip")
      .setDescription("Пропустить МП в одну дату (повторная команда на ту же дату возвращает МП)")
      .addStringOption((o) => o.setName("event").setDescription(EVENT_DESC).setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("date").setDescription("Дата ДД.ММ или ДД.ММ.ГГГГ").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("move")
      .setDescription("Перенести МП на другую дату (разово)")
      .addStringOption((o) => o.setName("event").setDescription(EVENT_DESC).setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("from").setDescription("Какую дату переносим, ДД.ММ").setRequired(true))
      .addStringOption((o) => o.setName("to").setDescription("На какую дату, ДД.ММ").setRequired(true))
      .addStringOption((o) => o.setName("time").setDescription("Новое время по МСК (по умолчанию — обычное)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Удалить МП насовсем")
      .addStringOption((o) => o.setName("event").setDescription(EVENT_DESC).setRequired(true).setAutocomplete(true))
  );

function allowed(userId: string): boolean {
  return userId === CREATOR_ID || getHelpers().includes(userId);
}

function parseRoleId(input: string): string | null {
  return parseIds(input)[0] ?? null;
}

/** Отменяет предстоящие проведения МП, которых больше нет в расписании (или всё, если МП выключен/удалён). */
async function cancelStale(eventId: string): Promise<number> {
  const event = getEvent(eventId);
  const now = Date.now();
  let count = 0;
  for (const occ of listOccurrences()) {
    if (occ.eventId !== eventId || occ.canceled || occ.startAt <= now) continue;
    let keep = false;
    if (event?.enabled) {
      const dateKey = mskDateKey(occ.startAt);
      keep = startTimesFor(event, dateKey).some((t) => mskToUtcMs(dateKey, t) === occ.startAt);
    }
    if (!keep) {
      await cancelOccurrence(occ);
      count++;
    }
  }
  return count;
}

function describeEvent(e: ActivityEvent): string {
  const state = e.enabled ? "" : " — **отключено**";
  const role = e.pingRoleId ? `<@&${e.pingRoleId}>` : "без пинга";
  let line =
    `• \`${e.id}\` **${e.name}**${state}: ${formatDays(e.weekdays)} в ${e.startTime} МСК, ` +
    `в игре за ${e.prepMinutes} мин, анонс в ${e.postTime}, пинг: ${role}`;
  const today = mskDateKey(Date.now());
  const skips = e.skipDates.filter((d) => d >= today).sort();
  const extras = e.extraDates.filter((x) => x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (skips.length) line += `\n   пропуски: ${skips.map(formatDateKey).join(", ")}`;
  if (extras.length) line += `\n   переносы: ${extras.map((x) => `${formatDateKey(x.date)} в ${x.startTime}`).join(", ")}`;
  return line;
}

async function fetchGuild(interaction: ChatInputCommandInteraction, serverInput: string): Promise<Guild | null> {
  const guildId = resolveGuildId(interaction.client, serverInput);
  if (!guildId) {
    await interaction.reply({
      content: "Не нашёл такой сервер среди серверов бота. Выберите сервер из подсказок поля server.",
      ephemeral: true,
    });
    return null;
  }
  return interaction.client.guilds.fetch(guildId);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name === "server") {
    await respondWithGuilds(interaction, focused.value);
    return;
  }
  if (focused.name === "event") {
    const q = focused.value.toLowerCase();
    const choices = listEvents()
      .map((e) => {
        const guildName = interaction.client.guilds.cache.get(e.guildId)?.name ?? e.guildId;
        return { name: `${e.name} — ${guildName}`.slice(0, 100), value: e.id };
      })
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 25);
    await interaction.respond(choices);
    return;
  }
  await interaction.respond([]);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.guildId !== MAIN_GUILD_ID) {
    await interaction.reply({ content: "Настройки МП доступны только на главном сервере.", ephemeral: true });
    return;
  }
  if (!allowed(interaction.user.id)) {
    await interaction.reply({ content: "Эта команда доступна только создателю и помощникам.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const reply = (content: string) =>
    interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  // ---------- настройки сервера ----------

  if (sub === "settings") {
    const guild = await fetchGuild(interaction, interaction.options.getString("server", true));
    if (!guild) return;
    const s = getGuildSettings(guild.id);
    const ch = (id: string | null) => (id ? `<#${id}>` : "**не задан**");
    const roles = s.adminRoleIds.length ? s.adminRoleIds.map((id) => `<@&${id}>`).join(", ") : "**не заданы**";
    const events = listEvents(guild.id);
    const lines = [
      `**Сервер «${guild.name}»**`,
      `N1 «Активити МП»: ${ch(s.announceChannelId)}`,
      `N2 (отметки и подбивка): ${ch(s.reportChannelId)}`,
      `Роли админов: ${roles}`,
      `Старший админ: ${s.seniorRoleId ? `<@&${s.seniorRoleId}>` : "**не задан**"}`,
      "",
      "**МП:**",
      ...(events.length ? events.map(describeEvent) : ["• пока нет — добавьте через /mp add"]),
    ];
    await reply(lines.join("\n"));
    return;
  }

  if (sub === "set-channel") {
    const guild = await fetchGuild(interaction, interaction.options.getString("server", true));
    if (!guild) return;
    const channelId = parseIds(interaction.options.getString("channel", true))[0];
    if (!channelId) {
      await reply("Это не похоже на ID канала.");
      return;
    }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await reply(`Текстовый канал с ID ${channelId} не найден на сервере «${guild.name}».`);
      return;
    }
    const me = await guild.members.fetchMe();
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      await reply(`У бота нет прав «Просмотр канала» и «Отправка сообщений» в <#${channel.id}>.`);
      return;
    }
    const type = interaction.options.getString("type", true);
    if (type === "announce") {
      updateGuildSettings(guild.id, { announceChannelId: channel.id });
      await reply(`Для «${guild.name}» канал N1 «Активити МП» теперь <#${channel.id}>.`);
    } else {
      updateGuildSettings(guild.id, { reportChannelId: channel.id });
      await reply(`Для «${guild.name}» канал N2 (отметки админов и подбивка) теперь <#${channel.id}>.`);
    }
    return;
  }

  if (sub === "set-admin-roles") {
    const guild = await fetchGuild(interaction, interaction.options.getString("server", true));
    if (!guild) return;
    const input = interaction.options.getString("roles", true).trim();
    if (/^(none|нет|-)$/i.test(input)) {
      updateGuildSettings(guild.id, { adminRoleIds: [] });
      await reply(`Список ролей админов для «${guild.name}» очищен.`);
      return;
    }
    const ids = parseIds(input);
    if (!ids.length) {
      await reply("Не нашёл ни одного ID роли. Укажите ID или @упоминания через пробел.");
      return;
    }
    const found: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const role = await guild.roles.fetch(id).catch(() => null);
      if (role) found.push(role.id);
      else missing.push(id);
    }
    if (missing.length) {
      await reply(`Не нашёл на сервере «${guild.name}» роли: ${missing.join(", ")}. Ничего не изменено.`);
      return;
    }
    updateGuildSettings(guild.id, { adminRoleIds: found });
    await reply(`Роли админов для «${guild.name}»: ${found.map((id) => `<@&${id}>`).join(", ")}.`);
    return;
  }

  if (sub === "set-senior-role") {
    const guild = await fetchGuild(interaction, interaction.options.getString("server", true));
    if (!guild) return;
    const input = interaction.options.getString("role", true).trim();
    if (/^(none|нет|-)$/i.test(input)) {
      updateGuildSettings(guild.id, { seniorRoleId: null });
      await reply(`Роль старшего админа для «${guild.name}» убрана.`);
      return;
    }
    const roleId = parseRoleId(input);
    const role = roleId ? await guild.roles.fetch(roleId).catch(() => null) : null;
    if (!role) {
      await reply(`Роль не найдена на сервере «${guild.name}».`);
      return;
    }
    updateGuildSettings(guild.id, { seniorRoleId: role.id });
    await reply(`Старший админ на «${guild.name}»: <@&${role.id}>.`);
    return;
  }

  // ---------- МП ----------

  if (sub === "add") {
    const guild = await fetchGuild(interaction, interaction.options.getString("server", true));
    if (!guild) return;
    const days = parseDays(interaction.options.getString("days", true));
    if (!days) {
      await reply("Не понял дни недели. Примеры: «вт», «пн ср пт», «все».");
      return;
    }
    const startTime = parseTime(interaction.options.getString("time", true));
    if (!startTime) {
      await reply("Не понял время начала. Формат: 18:00.");
      return;
    }
    const postInput = interaction.options.getString("post");
    const postTime = postInput ? parseTime(postInput) : "09:00";
    if (!postTime) {
      await reply("Не понял время анонса. Формат: 09:00.");
      return;
    }
    const roleInput = interaction.options.getString("role");
    let pingRoleId: string | null = null;
    if (roleInput) {
      const id = parseRoleId(roleInput);
      const role = id ? await guild.roles.fetch(id).catch(() => null) : null;
      if (!role) {
        await reply(`Роль для пинга не найдена на сервере «${guild.name}».`);
        return;
      }
      pingRoleId = role.id;
    }
    const event = addEvent({
      guildId: guild.id,
      name: interaction.options.getString("name", true).trim(),
      weekdays: days,
      startTime,
      prepMinutes: interaction.options.getInteger("prep") ?? 10,
      postTime,
      pingRoleId,
    });
    const warn = getGuildSettings(guild.id).announceChannelId
      ? ""
      : "\n⚠️ Канал N1 для этого сервера ещё не задан — анонсы не пойдут (/mp set-channel).";
    await reply(`МП добавлено на «${guild.name}»:\n${describeEvent(event)}${warn}`);
    return;
  }

  // Остальные команды работают с конкретным МП.
  const event = getEvent(interaction.options.getString("event", true));
  if (!event) {
    await reply("Такого МП нет. Выберите его из подсказок поля event.");
    return;
  }
  const guildName = interaction.client.guilds.cache.get(event.guildId)?.name ?? event.guildId;

  if (sub === "edit") {
    const guild = await interaction.client.guilds.fetch(event.guildId).catch(() => null);
    const name = interaction.options.getString("name");
    const daysInput = interaction.options.getString("days");
    const timeInput = interaction.options.getString("time");
    const prep = interaction.options.getInteger("prep");
    const postInput = interaction.options.getString("post");
    const roleInput = interaction.options.getString("role");
    if (name === null && daysInput === null && timeInput === null && prep === null && postInput === null && roleInput === null) {
      await reply("Укажите хотя бы одно поле, которое нужно изменить.");
      return;
    }

    const patch: Partial<ActivityEvent> = {};
    if (name !== null) patch.name = name.trim();
    if (daysInput !== null) {
      const days = parseDays(daysInput);
      if (!days) {
        await reply("Не понял дни недели. Примеры: «вт», «пн ср пт», «все».");
        return;
      }
      patch.weekdays = days;
    }
    if (timeInput !== null) {
      const t = parseTime(timeInput);
      if (!t) {
        await reply("Не понял время начала. Формат: 18:00.");
        return;
      }
      patch.startTime = t;
    }
    if (prep !== null) patch.prepMinutes = prep;
    if (postInput !== null) {
      const t = parseTime(postInput);
      if (!t) {
        await reply("Не понял время анонса. Формат: 09:00.");
        return;
      }
      patch.postTime = t;
    }
    if (roleInput !== null) {
      if (/^(none|нет|-)$/i.test(roleInput.trim())) patch.pingRoleId = null;
      else {
        const id = parseRoleId(roleInput);
        const role = id && guild ? await guild.roles.fetch(id).catch(() => null) : null;
        if (!role) {
          await reply(`Роль для пинга не найдена на сервере «${guildName}».`);
          return;
        }
        patch.pingRoleId = role.id;
      }
    }

    Object.assign(event, patch);
    persist();
    const canceled = await cancelStale(event.id);
    await reply(
      `МП обновлено:\n${describeEvent(event)}\n` +
        (canceled ? `Отменено предстоящих анонсов, которые не подходят под новое расписание: ${canceled}. ` : "") +
        "Уже опубликованный анонс не переписывается, новые настройки применятся к следующим."
    );
    return;
  }

  if (sub === "toggle") {
    event.enabled = interaction.options.getBoolean("enabled", true);
    persist();
    const canceled = await cancelStale(event.id);
    await reply(
      event.enabled
        ? `МП «${event.name}» (${guildName}) включено.`
        : `МП «${event.name}» (${guildName}) отключено.` + (canceled ? ` Отменено предстоящих анонсов: ${canceled}.` : "")
    );
    return;
  }

  if (sub === "skip") {
    const dateKey = parseDateInput(interaction.options.getString("date", true));
    if (!dateKey) {
      await reply("Не понял дату. Формат: ДД.ММ или ДД.ММ.ГГГГ.");
      return;
    }
    if (dateKey < mskDateKey(Date.now())) {
      await reply("Эта дата уже прошла.");
      return;
    }
    if (event.skipDates.includes(dateKey)) {
      event.skipDates = event.skipDates.filter((d) => d !== dateKey);
      persist();
      await reply(`Пропуск ${formatDateKey(dateKey)} снят: МП «${event.name}» (${guildName}) снова по расписанию.`);
      return;
    }
    event.skipDates.push(dateKey);
    persist();
    const canceled = await cancelStale(event.id);
    await reply(
      `МП «${event.name}» (${guildName}) пропущено ${formatDateKey(dateKey)}.` +
        (canceled ? " Уже вышедший анонс помечен как отменённый." : "")
    );
    return;
  }

  if (sub === "move") {
    const from = parseDateInput(interaction.options.getString("from", true));
    const to = parseDateInput(interaction.options.getString("to", true));
    if (!from || !to) {
      await reply("Не понял дату. Формат: ДД.ММ или ДД.ММ.ГГГГ.");
      return;
    }
    const timeInput = interaction.options.getString("time");
    const time = timeInput ? parseTime(timeInput) : event.startTime;
    if (!time) {
      await reply("Не понял время. Формат: 18:00.");
      return;
    }
    if (mskToUtcMs(to, time) <= Date.now()) {
      await reply("Новая дата и время уже прошли.");
      return;
    }
    if (!event.skipDates.includes(from)) event.skipDates.push(from);
    event.extraDates = event.extraDates.filter((x) => x.date !== from);
    if (!event.extraDates.some((x) => x.date === to && x.startTime === time)) {
      event.extraDates.push({ date: to, startTime: time });
    }
    persist();
    await cancelStale(event.id);
    await reply(
      `МП «${event.name}» (${guildName}) перенесено: ${formatDateKey(from)} → ${formatDateKey(to)} в ${time} МСК. ` +
        "Анонс выйдет в обычное время поста."
    );
    return;
  }

  if (sub === "remove") {
    event.enabled = false;
    const canceled = await cancelStale(event.id);
    removeEvent(event.id);
    await reply(`МП «${event.name}» (${guildName}) удалено.` + (canceled ? ` Отменено предстоящих анонсов: ${canceled}.` : ""));
    return;
  }
}
