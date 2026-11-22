// ===================== /lcheck — ПРОВЕРКА ЛОГОВ ЗА СУТКИ =====================
//
// Раз в сутки (по умолчанию в 00:10 МСК) бот читает логи действующих фракций за вчера и присылает сводку:
// участие в ПВП-мероприятиях и действия, где в причине повышения/увольнения/отдела есть оскорбления.
// Доступ — как у /sklad: создатель и модераторы, только на главном сервере.
// Фракции общие со складом и твинками (/sklad faction add|remove).

import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { addDaysToKey, formatDateKey, mskDateKey, parseDateInput, parseTime } from "../activity/time.js";
import { parseIds } from "../activity/util.js";
import { MAIN_GUILD_ID } from "../captTracker/config.js";
import { isCreatorOrModerator } from "../captTracker/store.js";
import { isLogCheckRunning, LC_BUILD_ID, summarize } from "../logcheck/runner.js";
import { buildWeeklyFor, runDay, runWeek } from "../logcheck/scheduler.js";
import { mondayOf } from "../logcheck/weekly.js";
import {
  DEFAULT_START_MINUTE,
  addWord,
  getHistory,
  getSettings,
  getWords,
  isDayDone,
  isWeekDone,
  removeWord,
  resetWords,
  setChannel,
  setEnabled,
  setStartMinute,
  setWeeklyEnabled,
} from "../logcheck/store.js";
import { normalizeWordInput } from "../logcheck/words.js";
import { confirmAction, respond } from "../confirm.js";
import { ClientIO } from "../warehouse/discordIO.js";
import { siteLockInfo } from "../warehouse/siteLock.js";
import { ownerId } from "../warehouse/scheduler.js";
import { KNOWN_FACTIONS, getFactions } from "../warehouse/store.js";

const factionChoices = KNOWN_FACTIONS.map((f) => ({ name: f.name, value: f.code }));
const LEVEL_CHOICES = [
  { name: "оскорбление / мат (hard)", value: "hard" },
  { name: "спорное (soft)", value: "soft" },
] as const;

export const data = new SlashCommandBuilder()
  .setName("lcheck")
  .setDescription("Проверка логов за сутки: ПВП-участие и оскорбления в причинах")
  .setDMPermission(false)
  .addSubcommand((sc) => sc.setName("status").setDescription("Настройки и результат последней проверки"))
  .addSubcommand((sc) =>
    sc
      .setName("channel")
      .setDescription("Канал, куда бот присылает сводки")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Текстовый канал этого сервера").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addStringOption((o) => o.setName("id").setDescription("ID или ссылка на канал (можно с другого сервера, где есть бот)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("time")
      .setDescription("Во сколько (МСК) запускать проверку за вчера; пусто — показать текущее")
      .addStringOption((o) => o.setName("time").setDescription("чч:мм, например 00:10"))
  )
  .addSubcommand((sc) => sc.setName("enable").setDescription("Включить проверку по расписанию"))
  .addSubcommand((sc) => sc.setName("disable").setDescription("Выключить проверку по расписанию (ручной запуск остаётся)"))
  .addSubcommand((sc) =>
    sc
      .setName("run")
      .setDescription("Проверить сутки вручную (по умолчанию вчера); результат показывается только вам")
      .addStringOption((o) => o.setName("date").setDescription("Дата: дд.мм.гггг (или дд.мм — текущий год). По умолчанию — вчера"))
      .addStringOption((o) => o.setName("faction").setDescription("Только эта фракция (по умолчанию — все действующие)").addChoices(...factionChoices))
      .addBooleanOption((o) => o.setName("post").setDescription("true — отправить сводку в канал и засчитать сутки (по умолчанию — показать только вам)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("weekly")
      .setDescription("Недельная сводка по ПВП (понедельник 00:30 МСК): включить или выключить")
      .addBooleanOption((o) => o.setName("enabled").setDescription("true — включить, false — выключить").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("week")
      .setDescription("Недельная сводка по ПВП за прошедшую неделю (по умолчанию прошлую); видно только вам")
      .addStringOption((o) => o.setName("date").setDescription("Любая дата нужной недели: дд.мм.гггг. По умолчанию — прошлая неделя"))
      .addBooleanOption((o) => o.setName("post").setDescription("true — отправить в канал и засчитать неделю (по умолчанию — показать только вам)"))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("words")
      .setDescription("Список слов, по которому проверяются причины")
      .addSubcommand((sc) => sc.setName("list").setDescription("Показать список слов"))
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Добавить слово (или сменить его уровень)")
          .addStringOption((o) =>
            o.setName("word").setDescription("ЛОХ — с окончаниями; =СУКА — только так; ХУЙ* — любое слово на это начало; МАТЬ ТВОЮ — фраза").setRequired(true)
          )
          .addStringOption((o) => o.setName("level").setDescription("Уровень (по умолчанию — оскорбление)").addChoices(...LEVEL_CHOICES))
      )
      .addSubcommand((sc) =>
        sc
          .setName("remove")
          .setDescription("Убрать слово из списка")
          .addStringOption((o) => o.setName("word").setDescription("Слово (выберите из подсказок)").setRequired(true).setAutocomplete(true))
      )
      .addSubcommand((sc) =>
        sc
          .setName("reset")
          .setDescription("Вернуть список слов по умолчанию (свои слова пропадут); спросит подтверждение")
      )
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const q = interaction.options.getFocused().toLowerCase();
  const choices = getWords()
    .filter((w) => w.word.toLowerCase().includes(q))
    .slice(0, 25)
    .map((w) => ({ name: `${w.word} (${w.level === "hard" ? "оскорбление" : "спорное"})`.slice(0, 100), value: w.word }));
  await interaction.respond(choices);
}

function minuteLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function renderStatus(): string {
  const s = getSettings();
  const words = getWords();
  const lock = siteLockInfo();
  const last = s.lastRunSummary;
  const lines = [
    `**Проверка логов за сутки** (сборка ${LC_BUILD_ID})`,
    `Автопроверка: ${s.enabled ? "включена" : "выключена"}, запуск в ${minuteLabel(s.startMinute)} МСК за вчерашние сутки`,
    `Канал сводок: ${s.channelId ? `<#${s.channelId}>` : "не задан (/lcheck channel) — автопроверка не стартует"}`,
    `Фракции (общие со складом): ${getFactions().map((f) => f.name).join(", ") || "не выбрано"}`,
    `Недельная сводка по ПВП: ${s.weeklyEnabled ? "включена (понедельник 00:30 МСК)" : "выключена"}; накоплено итогов по суткам: ${Object.keys(getHistory()).length}`,
    `Слов в списке: ${words.filter((w) => w.level === "hard").length} оскорблений, ${words.filter((w) => w.level === "soft").length} спорных`,
    `Сейчас: ${isLogCheckRunning() ? "идёт проверка" : "свободно"}${lock.holder ? `; на сайте работает «${lock.holder}»` : ""}${lock.waiting.length ? `; в очереди: ${lock.waiting.join(", ")}` : ""}`,
  ];
  if (last) lines.push(`Последний запуск (${formatDateKey(last.day)}, ${last.ok ? "без ошибок" : "с ошибками"}):\n${last.text}`);
  return lines.join("\n").slice(0, 1990);
}

async function safeFollowUp(interaction: ChatInputCommandInteraction, options: Parameters<ChatInputCommandInteraction["followUp"]>[0]): Promise<void> {
  try {
    await interaction.followUp(options);
  } catch (err) {
    console.warn("[logcheck] Не удалось отправить ответ на /lcheck run (токен команды истёк?):", err instanceof Error ? err.message : err);
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const reply = (content: string) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  if (interaction.guildId !== MAIN_GUILD_ID) {
    await reply("Настройки доступны только на главном сервере.");
    return;
  }
  if (!isCreatorOrModerator(interaction.user.id)) {
    await reply("Эта команда доступна только создателю и модераторам.");
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group === "words") {
    switch (sub) {
      case "list": {
        const words = getWords();
        const fmt = (level: "hard" | "soft") => words.filter((w) => w.level === level).map((w) => w.word).join(", ") || "—";
        const text =
          `**Оскорбления и мат (${words.filter((w) => w.level === "hard").length}):**\n${fmt("hard")}\n\n` +
          `**Спорное (${words.filter((w) => w.level === "soft").length}):**\n${fmt("soft")}\n\n` +
          "Пометки: `=СЛОВО` — только эта форма, `КОРЕНЬ*` — любое слово на это начало, без пометок — слово с окончаниями.";
        return void (await reply(text.slice(0, 1990)));
      }
      case "add": {
        const word = normalizeWordInput(interaction.options.getString("word", true));
        if (!word) return void (await reply("Не подходит. Нужны буквы или цифры (2–40 знаков), можно `=` в начале или `*` в конце, например: `ЛОХ`, `=СУКА`, `ХУЙ*`, `МАТЬ ТВОЮ`."));
        const level = (interaction.options.getString("level") ?? "hard") as "hard" | "soft";
        const changed = addWord(word, level);
        return void (await reply(changed ? `Слово ${word} в списке (${level === "hard" ? "оскорбление" : "спорное"}).` : `Слово ${word} уже есть с таким уровнем.`));
      }
      case "remove": {
        const word = interaction.options.getString("word", true).trim().toUpperCase();
        return void (await reply(removeWord(word) ? `Слово ${word} убрано из списка.` : "Такого слова в списке нет. Выберите его из подсказок."));
      }
      case "reset": {
        if (!(await confirmAction(interaction, "**Вернуть список слов к значениям по умолчанию?**\nВсе добавленные вами слова пропадут, а удалённые из списка вернутся."))) return;
        resetWords();
        return void (await respond(interaction, "Список слов возвращён к значениям по умолчанию."));
      }
    }
    return;
  }

  switch (sub) {
    case "status":
      return void (await reply(renderStatus()));
    case "channel": {
      const picked = interaction.options.getChannel("channel");
      const rawId = interaction.options.getString("id");
      const channelId = picked?.id ?? (rawId ? parseIds(rawId).at(-1) : undefined);
      if (!channelId) return void (await reply("Укажите канал: выберите его в поле «channel» или вставьте ID/ссылку в поле «id»."));
      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.isDMBased() || !channel.isTextBased()) {
        return void (await reply(`Текстовый канал с ID ${channelId} не найден. Бот должен быть на сервере, где этот канал находится.`));
      }
      const me = await channel.guild.members.fetchMe();
      const perms = channel.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return void (await reply(`У бота нет прав «Просмотр канала» и «Отправка сообщений» в <#${channel.id}> (сервер «${channel.guild.name}»).`));
      }
      setChannel(channel.guild.id, channel.id);
      return void (await reply(`Сводки по логам теперь приходят в <#${channel.id}> (сервер «${channel.guild.name}»).`));
    }
    case "time": {
      const raw = interaction.options.getString("time");
      if (raw) {
        const parsed = parseTime(raw);
        if (!parsed) return void (await reply("Не разобрал время. Формат: чч:мм, например 00:10."));
        const [h, m] = parsed.split(":").map(Number);
        setStartMinute(h * 60 + m);
      }
      return void (
        await reply(
          `Проверка за вчерашние сутки запускается в ${minuteLabel(getSettings().startMinute)} МСК (по умолчанию ${minuteLabel(DEFAULT_START_MINUTE)}). ` +
            "Если в это время на сайте работает склад или твинки, проверка дождётся своей очереди."
        )
      );
    }
    case "enable":
      setEnabled(true);
      return void (await reply(`Проверка логов включена: каждый день в ${minuteLabel(getSettings().startMinute)} МСК за вчерашние сутки.${getSettings().channelId ? "" : " Канал для сводок пока не задан (/lcheck channel)."}`));
    case "disable":
      setEnabled(false);
      return void (await reply("Проверка логов по расписанию выключена. Ручной запуск (/lcheck run) продолжает работать. Включить обратно: /lcheck enable."));
    case "weekly":
      setWeeklyEnabled(interaction.options.getBoolean("enabled", true));
      return void (
        await reply(
          getSettings().weeklyEnabled
            ? `Недельная сводка по ПВП включена: каждый понедельник в 00:30 МСК, в тот же канал, что и дневные.${getSettings().channelId ? "" : " Канал пока не задан (/lcheck channel)."}`
            : "Недельная сводка по ПВП выключена. Включить обратно: /lcheck weekly enabled:true."
        )
      );
    case "week":
      return void (await handleWeek(interaction));
    case "run":
      return void (await handleRun(interaction));
  }
}

async function handleRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const fail = (content: string) => interaction.reply({ content, ephemeral: true });
  const owner = ownerId();
  if (!owner) return void (await fail("Не задан WH_OWNER_ID в .env — боту некуда присылать запрос кода входа."));
  if (isLogCheckRunning()) return void (await fail("Проверка логов уже выполняется. Подождите окончания."));

  const now = Date.now();
  const yesterday = addDaysToKey(mskDateKey(now), -1);
  const dateInput = interaction.options.getString("date");
  const dateKey = dateInput ? parseDateInput(dateInput, now) : yesterday;
  if (!dateKey) return void (await fail("Не разобрал дату. Формат: дд.мм.гггг, например 20.11.2026."));
  if (dateKey >= mskDateKey(now)) return void (await fail("Эти сутки ещё не закончились: проверять можно только прошедшие дни (до вчера включительно)."));

  const post = interaction.options.getBoolean("post") ?? false;
  const faction = interaction.options.getString("faction");
  if (post && !getSettings().channelId) return void (await fail("Канал для сводок не задан (/lcheck channel). Уберите post или задайте канал."));
  if (post && isDayDone(dateKey)) {
    if (!(await confirmAction(interaction, `**Сводка за ${formatDateKey(dateKey)} уже отправлялась в канал. Отправить ещё раз?**\nВ канале появится второе такое же сообщение.`))) return;
  } else {
    await interaction.deferReply({ ephemeral: true });
  }
  await interaction.editReply(`Запускаю проверку логов за ${formatDateKey(dateKey)}${faction ? ` (только ${faction})` : ""}. Если сайт попросит код Google Authenticator, бот напишет владельцу в личку.`);

  try {
    const { result, delivered } = await runDay(interaction.client, dateKey, new ClientIO(interaction.client, owner), { post, onlyFactions: faction ? [faction] : undefined });
    const summary = summarize(result);
    if (post) {
      await safeFollowUp(interaction, { content: `${summary}\n${delivered ? "Сводка отправлена в канал." : "Не удалось отправить в канал: проверьте /lcheck channel."}`.slice(0, 1990), ephemeral: true });
    } else {
      await safeFollowUp(interaction, { content: `${summary}\nПоказано только вам, сутки не засчитаны.`.slice(0, 1990), ephemeral: true });
      for (const message of result.messages.slice(0, 5)) {
        await safeFollowUp(interaction, { content: message, ephemeral: true, allowedMentions: { parse: [] } });
      }
    }
  } catch (err) {
    console.error("[logcheck] Ручная проверка не удалась:", err);
    const message = err instanceof Error ? err.message : String(err);
    await safeFollowUp(interaction, { content: `Проверка не удалась: ${message}`.slice(0, 1990), ephemeral: true });
  }
}

async function handleWeek(interaction: ChatInputCommandInteraction): Promise<void> {
  const fail = (content: string) => interaction.reply({ content, ephemeral: true });
  const now = Date.now();
  const today = mskDateKey(now);
  const dateInput = interaction.options.getString("date");
  const picked = dateInput ? parseDateInput(dateInput, now) : null;
  if (dateInput && !picked) return void (await fail("Не разобрал дату. Формат: дд.мм.гггг, например 17.11.2026."));
  const weekStart = picked ? mondayOf(picked) : addDaysToKey(mondayOf(today), -7);
  if (addDaysToKey(weekStart, 6) >= today) return void (await fail("Эта неделя ещё не закончилась: сводку можно собрать только за прошедшие недели (до последнего воскресенья)."));

  const weekly = buildWeeklyFor(weekStart);
  if (!weekly) return void (await fail("Не выбрано ни одной фракции (/sklad faction add)."));
  const post = interaction.options.getBoolean("post") ?? false;

  if (!post) {
    await interaction.reply({ content: weekly.messages[0].slice(0, 1990), ephemeral: true, allowedMentions: { parse: [] } });
    for (const message of weekly.messages.slice(1, 5)) {
      await interaction.followUp({ content: message, ephemeral: true, allowedMentions: { parse: [] } });
    }
    await interaction.followUp({ content: "Показано только вам, неделя не засчитана. Отправить в канал: добавьте post:true.", ephemeral: true });
    return;
  }

  if (!getSettings().channelId) return void (await fail("Канал для сводок не задан (/lcheck channel). Уберите post или задайте канал."));
  if (isWeekDone(weekStart)) {
    if (!(await confirmAction(interaction, `**Недельная сводка за ${formatDateKey(weekStart)} – ${formatDateKey(addDaysToKey(weekStart, 6))} уже отправлялась в канал. Отправить ещё раз?**\nВ канале появится второе такое же сообщение.`))) return;
  } else {
    await interaction.deferReply({ ephemeral: true });
  }
  try {
    const sent = await runWeek(interaction.client, weekStart);
    await interaction.editReply({ content: `Недельная сводка отправлена в канал (данные за ${sent.daysWithData} из 7 суток).`, components: [] });
  } catch (err) {
    await interaction.editReply({ content: `Не удалось отправить: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1990), components: [] });
  }
}
