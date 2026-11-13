// ===================== /sklad — ПРОВЕРКА СКЛАДА ФРАКЦИЙ =====================
//
// Настройки автоматической проверки (канал, фракции, пороги, исключения).
// Доступ — как у настроек /capt: создатель и модераторы, только на главном сервере.
// Канал для отчётов можно указать на любом сервере, где есть бот (по ID/ссылке).

const FORCE_MAX_HOURS = 24;
const FORCE_MIN_MS = 2 * 60_000;
const DATE_CHECK_MAX_HOURS = 72;

import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { addDaysToKey, formatDateTime, mskToUtcMs, parseDateInput, parseTime } from "../activity/time.js";
import { parseIds } from "../activity/util.js";
import { MAIN_GUILD_ID } from "../captTracker/config.js";
import { isCreatorOrModerator } from "../captTracker/store.js";
import { ClientIO } from "../warehouse/discordIO.js";
import { describePeriod, formatSchedule, lastCompletedPeriod, type Period } from "../warehouse/periods.js";
import { isRunning, runCheck, summarize } from "../warehouse/runner.js";
import { ownerId, postToChannel } from "../warehouse/scheduler.js";
import {
  KNOWN_FACTIONS,
  addExclusion,
  addFaction,
  addRule,
  findRule,
  getExclusions,
  getFactions,
  getRules,
  getSettings,
  markCheckedUntil,
  removeExclusion,
  removeFaction,
  removeRule,
  resetRules,
  setChannel,
  setEnabled,
  setKitCooldown,
  setLastRunSummary,
  setNetReturns,
  setSchedule,
  DEFAULT_SCHEDULE_MINUTES,
  updateRule,
  type Rule,
} from "../warehouse/store.js";

const ID_PATTERN = /^\d{1,12}$/;
const RULE_ID_PATTERN = /^[a-z0-9_-]{2,24}$/;

const factionChoices = KNOWN_FACTIONS.map((f) => ({ name: f.name, value: f.code }));

export const data = new SlashCommandBuilder()
  .setName("sklad")
  .setDescription("Автопроверка склада фракций: подозрительные выдачи")
  .setDMPermission(false)
  .addSubcommand((sc) => sc.setName("status").setDescription("Текущие настройки и результат последней проверки"))
  .addSubcommand((sc) =>
    sc
      .setName("channel")
      .setDescription("Канал, куда бот присылает отчёты")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Текстовый канал этого сервера")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addStringOption((o) =>
        o.setName("id").setDescription("ID или ссылка на канал (можно с другого сервера, где есть бот)")
      )
  )
  .addSubcommand((sc) => sc.setName("enable").setDescription("Включить автопроверку склада по расписанию"))
  .addSubcommand((sc) => sc.setName("disable").setDescription("Выключить автопроверку склада (ручные проверки остаются)"))
  .addSubcommand((sc) =>
    sc
      .setName("force")
      .setDescription("Принудительная проверка: с момента последней проверки до сейчас")
      .addBooleanOption((o) =>
        o.setName("post").setDescription("true (по умолчанию) — отправить отчёт в канал и зачесть проверку; false — показать только вам")
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("run")
      .setDescription("Запустить проверку сейчас")
      .addIntegerOption((o) =>
        o.setName("hours").setDescription("За сколько последних часов (по умолчанию — последний закончившийся период)").setMinValue(1).setMaxValue(24)
      )
      .addBooleanOption((o) => o.setName("post").setDescription("Отправить результат в канал отчётов (по умолчанию — показать только вам)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("date")
      .setDescription("Проверить склад за указанную дату и время (результат показывается только вам)")
      .addStringOption((o) => o.setName("date").setDescription("Дата начала: дд.мм.гггг (или дд.мм — текущий год)").setRequired(true))
      .addStringOption((o) => o.setName("from").setDescription("Время начала по МСК, чч:мм (по умолчанию 00:00)"))
      .addStringOption((o) => o.setName("to").setDescription("Время конца по МСК, чч:мм (по умолчанию 00:00 = до конца суток)"))
      .addStringOption((o) => o.setName("end_date").setDescription("Дата конца, если окно больше одних суток: дд.мм.гггг"))
      .addStringOption((o) => o.setName("faction").setDescription("Только эта фракция (по умолчанию — все проверяемые)").addChoices(...factionChoices))
      .addBooleanOption((o) => o.setName("post").setDescription("Отправить результат в канал отчётов (по умолчанию — показать только вам)"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("schedule")
      .setDescription("Расписание автопроверки: во сколько заканчиваются периоды (МСК)")
      .addStringOption((o) => o.setName("times").setDescription("Время через пробел или запятую, например: 0 6 12 18 или 02:00 14:00. Пусто — показать текущее"))
      .addBooleanOption((o) => o.setName("reset").setDescription("true — вернуть 00:00, 06:00, 12:00, 18:00"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("returns")
      .setDescription("Вычитать ли возвращённое на склад из взятого")
      .addBooleanOption((o) => o.setName("enabled").setDescription("true — вычитать (по умолчанию), false — считать только «взял»").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("cooldown")
      .setDescription("Проверка перезарядки наборов: повторный набор раньше срока")
      .addBooleanOption((o) => o.setName("check").setDescription("Включить/выключить проверку"))
      .addIntegerOption((o) => o.setName("violations").setDescription("Сколько нарушений считать подозрительным").setMinValue(1).setMaxValue(50))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("faction")
      .setDescription("Какие фракции проверять")
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Добавить фракцию")
          .addStringOption((o) => o.setName("faction").setDescription("Фракция").setRequired(true).addChoices(...factionChoices))
      )
      .addSubcommand((sc) =>
        sc
          .setName("remove")
          .setDescription("Убрать фракцию")
          .addStringOption((o) => o.setName("faction").setDescription("Фракция").setRequired(true).addChoices(...factionChoices))
      )
  )
  .addSubcommandGroup((g) =>
    g
      .setName("rule")
      .setDescription("Пороги: что и сколько можно брать за период")
      .addSubcommand((sc) => sc.setName("list").setDescription("Все правила и пороги"))
      .addSubcommand((sc) =>
        sc
          .setName("set")
          .setDescription("Изменить пороги правила")
          .addStringOption((o) => o.setName("rule").setDescription("Правило").setRequired(true).setAutocomplete(true))
          .addIntegerOption((o) => o.setName("limit").setDescription("Лимит за период: склад + наборы (0 — не проверять)").setMinValue(0).setMaxValue(100000))
          .addIntegerOption((o) => o.setName("burst_count").setDescription("Всплеск: сколько штук (0 — выключить)").setMinValue(0).setMaxValue(10000))
          .addIntegerOption((o) => o.setName("burst_minutes").setDescription("Всплеск: за сколько минут").setMinValue(1).setMaxValue(120))
      )
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Новое правило для конкретного предмета или набора")
          .addStringOption((o) => o.setName("id").setDescription("Короткое имя латиницей, например rifle").setRequired(true))
          .addStringOption((o) => o.setName("title").setDescription("Название в отчёте").setRequired(true))
          .addStringOption((o) => o.setName("match").setDescription("Часть названия (через запятую), например: карабин, rifle").setRequired(true))
          .addIntegerOption((o) => o.setName("limit").setDescription("Лимит за период").setMinValue(0).setMaxValue(100000).setRequired(true))
          .addIntegerOption((o) => o.setName("burst_count").setDescription("Всплеск: сколько штук").setMinValue(0).setMaxValue(10000))
          .addIntegerOption((o) => o.setName("burst_minutes").setDescription("Всплеск: за сколько минут").setMinValue(1).setMaxValue(120))
          .addBooleanOption((o) => o.setName("kit").setDescription("true — это набор («Берет набор …»), а не предмет"))
      )
      .addSubcommand((sc) =>
        sc
          .setName("remove")
          .setDescription("Удалить своё правило")
          .addStringOption((o) => o.setName("rule").setDescription("Правило").setRequired(true).setAutocomplete(true))
      )
      .addSubcommand((sc) => sc.setName("reset").setDescription("Вернуть все пороги к значениям по умолчанию"))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("exclude")
      .setDescription("Исключения: кого не проверять")
      .addSubcommand((sc) => sc.setName("list").setDescription("Список исключений"))
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Не проверять игрока")
          .addStringOption((o) => o.setName("id").setDescription("ID персонажа (число в скобках в логах)").setRequired(true))
          .addStringOption((o) => o.setName("note").setDescription("Заметка: кто это"))
      )
      .addSubcommand((sc) =>
        sc
          .setName("remove")
          .setDescription("Вернуть игрока в проверку")
          .addStringOption((o) => o.setName("id").setDescription("ID персонажа").setRequired(true))
      )
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "rule") {
    await interaction.respond([]);
    return;
  }
  const query = focused.value.toLowerCase();
  await interaction.respond(
    getRules()
      .filter((r) => r.id.includes(query) || r.label.toLowerCase().includes(query))
      .slice(0, 25)
      .map((r) => ({ name: `${r.label} (${r.id})`.slice(0, 100), value: r.id }))
  );
}

function describeRule(r: Rule): string {
  const burst = r.burstCount > 0 ? `, всплеск ${r.burstCount} за ${r.burstMinutes} мин` : ", всплеск выкл.";
  const limit = r.limit > 0 ? `лимит ${r.limit}` : "лимит выкл.";
  if (r.kind === "kit") return `• \`${r.id}\` — ${r.label} (набор): ${limit} выдач${burst}; ищет: ${r.match.join(", ")}`;
  return `• \`${r.id}\` — ${r.label}: ${limit}${burst}; ищет: ${r.match.join(", ")}`;
}

/** «0 6 12 18», «02:00, 14:30» → минуты от начала суток; null, если что-то не распознано. */
function parseScheduleInput(input: string): number[] | null {
  const tokens = input.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return null;
  const result = new Set<number>();
  for (const token of tokens) {
    const t = /^\d{1,2}$/.test(token) ? parseTime(`${token}:00`) : parseTime(token);
    if (!t) return null;
    const [h, m] = t.split(":").map(Number);
    result.add(h * 60 + m);
  }
  return [...result].sort((a, b) => a - b);
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

  if (!group) {
    switch (sub) {
      case "status":
        return void (await reply(renderStatus()));
      case "channel": {
        const picked = interaction.options.getChannel("channel");
        const rawId = interaction.options.getString("id");
        // В ссылке discord.com/channels/СЕРВЕР/КАНАЛ нужен последний ID.
        const channelId = picked?.id ?? (rawId ? parseIds(rawId).at(-1) : undefined);
        if (!channelId) {
          return void (await reply("Укажите канал: выберите его в поле «channel» или вставьте ID/ссылку в поле «id»."));
        }
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
        return void (await reply(`Отчёты о складе теперь приходят в <#${channel.id}> (сервер «${channel.guild.name}»).`));
      }
      case "enable": {
        setEnabled(true);
        return void (
          await reply(
            `Автопроверка склада включена. Проверки идут по расписанию (${formatSchedule(getSettings().scheduleMinutes)} МСК). ` +
              "Если после последнего периода прошло меньше 3 часов и он не проверен, бот проверит его сам — может прийти запрос кода в личку. " +
              "Пропущенное за время выключения можно добрать командой /sklad force."
          )
        );
      }
      case "disable": {
        setEnabled(false);
        return void (
          await reply(
            "Автопроверка склада выключена: по расписанию бот больше не заходит на сайт и ничего не присылает." +
              (isRunning() ? " Проверка, которая идёт прямо сейчас, доработает до конца." : "") +
              " Ручные команды (/sklad run, /sklad force) продолжают работать. Включить обратно: /sklad enable."
          )
        );
      }
      case "force":
        return void (await handleForce(interaction));
      case "run":
        return void (await handleRun(interaction));
      case "date":
        return void (await handleDate(interaction));
      case "schedule": {
        if (interaction.options.getBoolean("reset")) {
          setSchedule(DEFAULT_SCHEDULE_MINUTES);
        } else {
          const raw = interaction.options.getString("times");
          if (raw) {
            const parsed = parseScheduleInput(raw);
            if (!parsed) return void (await reply("Не разобрал время. Пример: `0 6 12 18` или `02:00, 14:30` (часы 0–23, минуты 0–59, МСК)."));
            setSchedule(parsed);
          }
        }
        const minutes = getSettings().scheduleMinutes;
        return void (
          await reply(
            `**Расписание проверок (МСК):** ${formatSchedule(minutes)}\n` +
              `Периодов в сутки: ${minutes.length}. Бот проверяет период между соседними временами через ~2 минуты после его конца. ` +
              `Пороги в \`/sklad rule list\` действуют на один период — при смене расписания поменяйте их под длину периода.`
          )
        );
      }
      case "returns": {
        const enabled = interaction.options.getBoolean("enabled", true);
        setNetReturns(enabled);
        return void (await reply(enabled ? "Возвращённое на склад вычитается из взятого." : "Считается только взятое, возвраты не учитываются."));
      }
      case "cooldown": {
        const check = interaction.options.getBoolean("check") ?? undefined;
        const violations = interaction.options.getInteger("violations") ?? undefined;
        if (check === undefined && violations === undefined) return void (await reply("Укажите check или violations."));
        setKitCooldown(check, violations);
        const s = getSettings();
        return void (await reply(`Перезарядка наборов: проверка ${s.kitCooldownCheck ? "включена" : "выключена"}, порог — ${s.kitCooldownViolations} нарушений.`));
      }
    }
    return;
  }

  if (group === "faction") {
    const code = interaction.options.getString("faction", true);
    const known = KNOWN_FACTIONS.find((f) => f.code === code);
    if (!known) return void (await reply("Неизвестная фракция."));
    if (sub === "add") {
      return void (await reply(addFaction(code) ? `Фракция «${known.name}» добавлена в проверку.` : `«${known.name}» уже проверяется.`));
    }
    return void (await reply(removeFaction(code) ? `Фракция «${known.name}» больше не проверяется.` : `«${known.name}» не была в списке.`));
  }

  if (group === "rule") {
    if (sub === "list") {
      return void (await reply(["**Пороги за период:**", ...getRules().map(describeRule)].join("\n").slice(0, 1990)));
    }
    if (sub === "reset") {
      resetRules();
      return void (await reply("Все пороги возвращены к значениям по умолчанию."));
    }
    if (sub === "set") {
      const id = interaction.options.getString("rule", true);
      const limit = interaction.options.getInteger("limit");
      const burstCount = interaction.options.getInteger("burst_count");
      const burstMinutes = interaction.options.getInteger("burst_minutes");
      if (!findRule(id)) return void (await reply("Такого правила нет. Выберите из подсказок."));
      if (limit === null && burstCount === null && burstMinutes === null) return void (await reply("Укажите, что менять: limit, burst_count или burst_minutes."));
      const rule = findRule(id)!;
      const patch: Partial<Pick<Rule, "limit" | "burstCount" | "burstMinutes">> = {};
      if (limit !== null) patch.limit = limit;
      if (burstCount !== null) patch.burstCount = burstCount;
      if (burstMinutes !== null) patch.burstMinutes = burstMinutes;
      if ((patch.burstCount ?? rule.burstCount) > 0 && (patch.burstMinutes ?? rule.burstMinutes) <= 0) patch.burstMinutes = 3;
      const updated = updateRule(id, patch)!;
      return void (await reply(`Обновлено:\n${describeRule(updated)}`));
    }
    if (sub === "add") {
      const id = interaction.options.getString("id", true).trim().toLowerCase();
      if (!RULE_ID_PATTERN.test(id)) return void (await reply("Короткое имя: 2–24 символа, латиница, цифры, - и _."));
      const match = interaction.options
        .getString("match", true)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!match.length) return void (await reply("Укажите хотя бы одну часть названия в поле match."));
      const burstCount = interaction.options.getInteger("burst_count") ?? 0;
      const rule: Rule = {
        id,
        label: interaction.options.getString("title", true).trim().slice(0, 40),
        kind: interaction.options.getBoolean("kit") ? "kit" : "item",
        match,
        limit: interaction.options.getInteger("limit", true),
        burstCount,
        burstMinutes: burstCount > 0 ? (interaction.options.getInteger("burst_minutes") ?? 3) : 0,
      };
      if (!addRule(rule)) return void (await reply("Правило с таким именем уже есть."));
      return void (await reply(`Добавлено (проверяется раньше универсального «прочее»):\n${describeRule(rule)}`));
    }
    if (sub === "remove") {
      const id = interaction.options.getString("rule", true);
      return void (await reply(removeRule(id) ? "Правило удалено." : "Не удалось: такого правила нет или оно универсальное (его нельзя удалять, только менять пороги)."));
    }
    return;
  }

  if (group === "exclude") {
    if (sub === "list") {
      const items = getExclusions();
      return void (await reply(items.length ? ["**Исключения:**", ...items.map((e) => `• ${e.characterId}${e.note ? ` — ${e.note}` : ""}`)].join("\n").slice(0, 1990) : "Список исключений пуст."));
    }
    const id = interaction.options.getString("id", true).trim();
    if (!ID_PATTERN.test(id)) return void (await reply("ID персонажа — число (то, что в скобках после ника в логах)."));
    if (sub === "add") {
      const note = interaction.options.getString("note")?.trim().slice(0, 80) ?? "";
      return void (await reply(addExclusion(id, note) ? `Игрок ${id} больше не проверяется.` : "Он уже в исключениях."));
    }
    return void (await reply(removeExclusion(id) ? `Игрок ${id} снова проверяется.` : "Его нет в исключениях."));
  }
}

function renderStatus(): string {
  const s = getSettings();
  const lines = [
    `**Автопроверка:** ${s.enabled ? "включена" : "выключена (/sklad enable — включить)"}`,
    `**Проверено до:** ${s.lastCheckedUntilMs ? `${formatDateTime(s.lastCheckedUntilMs)} МСК` : "нет данных (/sklad force проверит с начала последнего периода)"}`,
    `**Канал отчётов:** ${s.channelId ? `<#${s.channelId}>` : "не задан (/sklad channel) — без него автопроверка не запускается"}`,
    `**Фракции:** ${getFactions().map((f) => f.name).join(", ") || "нет"}`,
    `**Возвраты вычитаются:** ${s.netReturns ? "да" : "нет"}`,
    `**Перезарядка наборов:** ${s.kitCooldownCheck ? `проверка включена, порог ${s.kitCooldownViolations}` : "проверка выключена"}`,
    `**Исключений:** ${s.exclusions.length}`,
    `**Расписание:** ${formatSchedule(s.scheduleMinutes)} МСК (запуск через ~2 минуты после конца периода; менять: /sklad schedule)`,
    "",
    "**Пороги за период:**",
    ...getRules().map(describeRule),
  ];
  if (s.lastRunSummary) {
    lines.push("", `**Последняя проверка** (${s.lastRunSummary.ok ? "успешно" : "с ошибками"}):`, s.lastRunSummary.text);
  }
  return lines.join("\n").slice(0, 1990);
}

/** Токен ответа на команду живёт 15 минут, а вход на сайт может ждать код дольше — тогда ответ просто не дойдёт, это не ошибка. */
async function safeFollowUp(interaction: ChatInputCommandInteraction, options: Parameters<ChatInputCommandInteraction["followUp"]>[0]): Promise<void> {
  try {
    await interaction.followUp(options);
  } catch (err) {
    console.warn("[warehouse] Не удалось отправить ответ на /sklad run (токен команды истёк?):", err instanceof Error ? err.message : err);
  }
}

/** Принудительная проверка: от конца последней проверки до момента команды. */
async function handleForce(interaction: ChatInputCommandInteraction): Promise<void> {
  const owner = ownerId();
  if (!owner) {
    await interaction.reply({ content: "Не задан WH_OWNER_ID в .env — боту некуда присылать запрос кода входа.", ephemeral: true });
    return;
  }
  if (isRunning()) {
    await interaction.reply({ content: "Проверка уже выполняется. Подождите окончания.", ephemeral: true });
    return;
  }
  const post = interaction.options.getBoolean("post") ?? true;
  const settings = getSettings();
  if (post && !settings.channelId) {
    await interaction.reply({ content: "Канал отчётов не задан (/sklad channel). Либо задайте его, либо запустите с post:false, чтобы увидеть результат только вам.", ephemeral: true });
    return;
  }

  const now = Date.now();
  const notes: string[] = [];
  let startMs = settings.lastCheckedUntilMs ?? lastCompletedPeriod(now).startMs;
  if (settings.lastCheckedUntilMs === null) notes.push("Сохранённой предыдущей проверки нет — беру с начала последнего закончившегося периода.");
  const capMs = FORCE_MAX_HOURS * 3_600_000;
  if (now - startMs > capMs) {
    startMs = now - capMs;
    notes.push(`С последней проверки прошло больше ${FORCE_MAX_HOURS} ч — беру только последние ${FORCE_MAX_HOURS} ч (более раннее — через /sklad run hours:…).`);
  }
  if (now - startMs < FORCE_MIN_MS) {
    await interaction.reply({ content: "С последней проверки прошло меньше 2 минут — проверять пока нечего.", ephemeral: true });
    return;
  }
  const period: Period = { key: `force-${now}`, startMs, endMs: now };

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(
    [`Запускаю принудительную проверку за ${describePeriod(period)}. Если сайт попросит код Google Authenticator, бот напишет владельцу в личку.`, ...notes].join("\n").slice(0, 1990)
  );

  try {
    const result = await runCheck(period, new ClientIO(interaction.client, owner));
    const summary = summarize(result);
    if (post) {
      const delivered = result.messages.length ? await postToChannel(interaction.client, result.messages) : true;
      const counted = result.ok && delivered;
      if (counted) markCheckedUntil(now);
      setLastRunSummary({ at: Date.now(), period: period.key, ok: result.ok, text: summary });
      const tail = !delivered
        ? "Не удалось отправить в канал: проверьте /sklad channel. Проверка не зачтена."
        : !result.ok
          ? "Часть фракций прочитать не удалось — проверка не зачтена, повторите /sklad force."
          : result.messages.length
            ? "Отчёты отправлены в канал. Проверка зачтена."
            : "Подозрительных нет — в канал ничего не отправлено. Проверка зачтена.";
      await safeFollowUp(interaction, { content: `${summary}\n${tail}`.slice(0, 1990), ephemeral: true });
    } else {
      await safeFollowUp(interaction, { content: `${summary}\nПоказано только вам, проверка не зачтена.`.slice(0, 1990), ephemeral: true });
      for (const message of result.messages.slice(0, 5)) {
        await safeFollowUp(interaction, { content: message, ephemeral: true, allowedMentions: { parse: [] } });
      }
      if (!result.messages.length) await safeFollowUp(interaction, { content: "Подозрительных нет.", ephemeral: true });
    }
  } catch (err) {
    await safeFollowUp(interaction, { content: `❌ Проверка не удалась: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1990), ephemeral: true });
  }
}

async function handleRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const hours = interaction.options.getInteger("hours");
  const post = interaction.options.getBoolean("post") ?? false;
  const now = Date.now();
  const period: Period =
    hours !== null
      ? { key: `manual-${now}`, startMs: now - hours * 3_600_000, endMs: now }
      : lastCompletedPeriod(now);
  await runManual(interaction, period, post);
}

/** Проверка за указанную дату/время: /sklad date. Точку «проверено до» не двигает. */
async function handleDate(interaction: ChatInputCommandInteraction): Promise<void> {
  const fail = (content: string) => interaction.reply({ content, ephemeral: true });
  const now = Date.now();
  const startKey = parseDateInput(interaction.options.getString("date", true), now);
  if (!startKey) return void (await fail("Не разобрал дату. Формат: дд.мм.гггг, например 12.11.2026."));
  const from = parseTime(interaction.options.getString("from") ?? "00:00");
  const to = parseTime(interaction.options.getString("to") ?? "00:00");
  if (!from || !to) return void (await fail("Не разобрал время. Формат: чч:мм, например 18:00."));
  const endDateRaw = interaction.options.getString("end_date");
  const endKeyInput = endDateRaw ? parseDateInput(endDateRaw, now) : null;
  if (endDateRaw && !endKeyInput) return void (await fail("Не разобрал end_date. Формат: дд.мм.гггг."));

  const startMs = mskToUtcMs(startKey, from);
  let endMs = mskToUtcMs(endKeyInput ?? startKey, to);
  // «18:00 → 00:00» и «00:00 → 00:00» без end_date означают конец в следующие сутки.
  if (endMs <= startMs) {
    if (endKeyInput) return void (await fail("Конец окна раньше или равен началу."));
    endMs = mskToUtcMs(addDaysToKey(startKey, 1), to);
  }
  if (startMs >= now) return void (await fail("Это время ещё не наступило — логов за него нет."));
  const notes: string[] = [];
  if (endMs > now) {
    endMs = now;
    notes.push("Конец окна в будущем — проверяю до текущего момента.");
  }
  if (endMs - startMs > DATE_CHECK_MAX_HOURS * 3_600_000) {
    return void (await fail(`Окно слишком большое (максимум ${DATE_CHECK_MAX_HOURS} ч). Разбейте на несколько проверок.`));
  }

  const faction = interaction.options.getString("faction");
  const post = interaction.options.getBoolean("post") ?? false;
  const period: Period = { key: `date-${now}`, startMs, endMs };
  await runManual(interaction, period, post, { onlyFactions: faction ? [faction] : undefined, notes });
}

async function runManual(
  interaction: ChatInputCommandInteraction,
  period: Period,
  post: boolean,
  extra: { onlyFactions?: string[]; notes?: string[] } = {}
): Promise<void> {
  const owner = ownerId();
  if (!owner) {
    await interaction.reply({ content: "Не задан WH_OWNER_ID в .env — боту некуда присылать запрос кода входа.", ephemeral: true });
    return;
  }
  if (isRunning()) {
    await interaction.reply({ content: "Проверка уже выполняется. Подождите окончания.", ephemeral: true });
    return;
  }
  if (post && !getSettings().channelId) {
    await interaction.reply({ content: "Канал отчётов не задан (/sklad channel). Уберите post или задайте канал.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply(
    [`Запускаю проверку за ${describePeriod(period)}. Если сайт попросит код Google Authenticator, бот напишет владельцу в личку.`, ...(extra.notes ?? [])].join("\n").slice(0, 1990)
  );

  try {
    const result = await runCheck(period, new ClientIO(interaction.client, owner), { onlyFactions: extra.onlyFactions });
    const summary = summarize(result);
    if (post) {
      const delivered = result.messages.length ? await postToChannel(interaction.client, result.messages) : true;
      await safeFollowUp(interaction, {
        content: `${summary}\n${result.messages.length ? (delivered ? "Отчёты отправлены в канал." : "Не удалось отправить в канал: проверьте /sklad channel.") : "Подозрительных нет — в канал ничего не отправлено."}`.slice(0, 1990),
        ephemeral: true,
      });
    } else {
      await safeFollowUp(interaction, { content: summary.slice(0, 1990), ephemeral: true });
      for (const message of result.messages.slice(0, 5)) {
        await safeFollowUp(interaction, { content: message, ephemeral: true, allowedMentions: { parse: [] } });
      }
      if (result.messages.length > 5) {
        await safeFollowUp(interaction, { content: `Показано 5 сообщений из ${result.messages.length}. Остальное — с post:true (отправить в канал).`, ephemeral: true });
      }
      if (!result.messages.length) await safeFollowUp(interaction, { content: "Подозрительных нет.", ephemeral: true });
    }
  } catch (err) {
    await safeFollowUp(interaction, { content: `❌ Проверка не удалась: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1990), ephemeral: true });
  }
}
