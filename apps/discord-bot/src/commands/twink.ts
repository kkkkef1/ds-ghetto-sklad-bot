// ===================== /twink — ПРОВЕРКА ТВИНКОВ ФРАКЦИЙ =====================
//
// Настройки и ручное управление автопроверкой твинков. Доступ — как у /sklad:
// создатель и модераторы, только на главном сервере. Канал результатов можно указать
// на любом сервере, где есть бот (по ID/ссылке). Список проверяемых фракций общий со
// складом (/sklad faction add|remove).

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { parseTime } from "../activity/time.js";
import { parseIds } from "../activity/util.js";
import { MAIN_GUILD_ID } from "../captTracker/config.js";
import { isCreatorOrModerator } from "../captTracker/store.js";
import { siteLockInfo } from "../warehouse/siteLock.js";
import { getFactions, KNOWN_FACTIONS } from "../warehouse/store.js";
import { describeRun, ownerId, resumeRun, startRun, stopRun } from "../twink/checker.js";
import { nextPublish } from "../twink/scheduler.js";
import { hm } from "../twink/report.js";
import { CATEGORY_LABEL, type Category } from "../twink/rules.js";
import {
  addCustomFaction,
  DEFAULT_LINKS,
  getRun,
  getSettings,
  linkFor,
  MIN_DELAY_MS,
  patchSettings,
  removeCustomFaction,
  setLink,
} from "../twink/store.js";

const factionChoices = KNOWN_FACTIONS.map((f) => ({ name: f.name, value: f.code }));
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WEEKDAY_ALIASES: Record<string, number> = {
  вс: 0, воскресенье: 0, sun: 0,
  пн: 1, понедельник: 1, mon: 1,
  вт: 2, вторник: 2, tue: 2,
  ср: 3, среда: 3, wed: 3,
  чт: 4, четверг: 4, thu: 4,
  пт: 5, пятница: 5, fri: 5,
  сб: 6, суббота: 6, sat: 6,
};

export const data = new SlashCommandBuilder()
  .setName("twink")
  .setDescription("Автопроверка твинков во фракциях")
  .setDMPermission(false)
  .addSubcommand((sc) => sc.setName("status").setDescription("Настройки, ход проверки и ближайший запуск"))
  .addSubcommand((sc) =>
    sc
      .setName("channel")
      .setDescription("Канал, куда бот присылает ход проверки и результаты")
      .addChannelOption((o) => o.setName("channel").setDescription("Текстовый канал этого сервера").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption((o) => o.setName("id").setDescription("ID или ссылка на канал (можно с другого сервера, где есть бот)"))
  )
  .addSubcommand((sc) => sc.setName("enable").setDescription("Включить автопроверку по расписанию"))
  .addSubcommand((sc) => sc.setName("disable").setDescription("Выключить автопроверку (ручной запуск остаётся)"))
  .addSubcommand((sc) =>
    sc
      .setName("schedule")
      .setDescription("Расписание: дни, время публикации (МСК) и за сколько часов стартовать")
      .addStringOption((o) => o.setName("days").setDescription("Дни недели: например «ср вс» или «пн ср пт»"))
      .addStringOption((o) => o.setName("time").setDescription("Во сколько результат должен быть готов (МСК), чч:мм"))
      .addIntegerOption((o) => o.setName("lead_hours").setDescription("За сколько часов до этого начинать проверку").setMinValue(1).setMaxValue(12))
      .addBooleanOption((o) => o.setName("reset").setDescription("true — вернуть ср и вс, 09:00, за 3 часа"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("force")
      .setDescription("Запустить проверку сейчас (с подтверждением)")
      .addStringOption((o) => o.setName("faction").setDescription("Проверить только эту фракцию (по умолчанию — все активные)").addChoices(...factionChoices))
  )
  .addSubcommand((sc) => sc.setName("stop").setDescription("Остановить проверку и отправить в канал то, что уже найдено"))
  .addSubcommand((sc) => sc.setName("resume").setDescription("Продолжить проверку, остановленную капчей или сбросом сессии"))
  .addSubcommand((sc) =>
    sc
      .setName("delay")
      .setDescription("Паузы: перед каждым нажатием «(ч)» и ожидание окна")
      .addIntegerOption((o) => o.setName("delay_ms").setDescription(`Пауза перед каждым нажатием, мс (не меньше ${MIN_DELAY_MS})`).setMinValue(MIN_DELAY_MS).setMaxValue(60_000))
      .addIntegerOption((o) => o.setName("jitter_ms").setDescription("Случайная добавка к паузе 0…N мс (0 — без разброса)").setMinValue(0).setMaxValue(10_000))
      .addIntegerOption((o) => o.setName("wait_ms").setDescription("Сколько ждать окно со списком персонажей, мс").setMinValue(500).setMaxValue(15_000))
  )
  .addSubcommand((sc) =>
    sc
      .setName("nick")
      .setDescription("Что писать после «by» в строках offwarn")
      .addStringOption((o) => o.setName("name").setDescription("Например: фамилия").setRequired(true).setMaxLength(40))
  )
  .addSubcommand((sc) =>
    sc
      .setName("options")
      .setDescription("Переключатели")
      .addBooleanOption((o) => o.setName("skip_seen").setDescription("Не нажимать «(ч)» у тех, чьи ID уже встретились (быстрее)"))
      .addBooleanOption((o) => o.setName("code_block").setDescription("Результат в блоке кода (удобно копировать)"))
      .addIntegerOption((o) => o.setName("progress_sec").setDescription("Как часто обновлять сообщение о ходе проверки, секунд (по умолчанию 60)").setMinValue(10).setMaxValue(3600))
  )
  .addSubcommand((sc) =>
    sc
      .setName("link")
      .setDescription("Ссылка на список участников фракции")
      .addStringOption((o) => o.setName("faction").setDescription("Фракция").setRequired(true).addChoices(...factionChoices))
      .addStringOption((o) => o.setName("url").setDescription("Новая ссылка (mi?act=faction_members…). Пусто — показать текущую"))
      .addBooleanOption((o) => o.setName("reset").setDescription("true — вернуть ссылку по умолчанию"))
  )
  .addSubcommandGroup((g) =>
    g
      .setName("map")
      .setDescription("Неизвестные фракции: к какой категории отнести")
      .addSubcommand((sc) => sc.setName("list").setDescription("Добавленные вручную фракции"))
      .addSubcommand((sc) =>
        sc
          .setName("add")
          .setDescription("Добавить фракцию (название точно как на сайте)")
          .addStringOption((o) => o.setName("name").setDescription("Название фракции на сайте").setRequired(true).setMaxLength(60))
          .addStringOption((o) =>
            o
              .setName("category")
              .setDescription("Категория")
              .setRequired(true)
              .addChoices({ name: "криминальная", value: "crime" }, { name: "государственная", value: "state" }, { name: "особая", value: "special" })
          )
          .addStringOption((o) => o.setName("code").setDescription("Короткий код в выводе, например TRD").setRequired(true).setMaxLength(12))
      )
      .addSubcommand((sc) =>
        sc.setName("remove").setDescription("Убрать добавленную фракцию").addStringOption((o) => o.setName("name").setDescription("Название").setRequired(true).setMaxLength(60))
      )
  );

function parseDays(input: string): number[] | null {
  const tokens = input.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return null;
  const result = new Set<number>();
  for (const token of tokens) {
    const n = token in WEEKDAY_ALIASES ? WEEKDAY_ALIASES[token] : /^[0-6]$/.test(token) ? Number(token) : null;
    if (n === null) return null;
    result.add(n);
  }
  return [...result].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // с понедельника
}

const fmtDays = (days: number[]): string => days.map((d) => WEEKDAYS[d]).join(", ");
const fmtTime = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function renderStatus(): string {
  const s = getSettings();
  const next = nextPublish(Date.now());
  const lock = siteLockInfo();
  const lines = [
    `**Автопроверка:** ${s.enabled ? "включена" : "выключена (/twink enable — включить)"}`,
    `**Расписание:** ${fmtDays(s.days)}, результат к ${fmtTime(s.publishMinutes)} МСК, старт за ${s.leadHours} ч`,
    `**Ближайшая публикация:** ${next ? `${new Date(next + 3 * 3_600_000).toISOString().slice(0, 10).split("-").reverse().join(".")} ${hm(next)} МСК` : "нет (не выбраны дни)"}`,
    `**Канал:** ${s.channelId ? `<#${s.channelId}>` : "не задан (/twink channel) — без него автопроверка не запускается"}`,
    `**Фракции (общие со складом):** ${getFactions().map((f) => f.name).join(", ") || "нет"}`,
    `**Паузы:** перед нажатием ${s.delayMs} мс + случайно до ${s.jitterMs} мс, ожидание окна ${s.waitModalMs} мс`,
    `**После «by»:** ${s.nickname}; **ход проверки обновляется** раз в ${s.progressSeconds} с`,
    `**Пропуск уже встреченных ID:** ${s.skipSeen ? "да" : "нет"}; **блок кода:** ${s.codeBlock ? "да" : "нет"}`,
    `**Свои фракции:** ${Object.keys(s.customFactions).length}`,
    "",
    describeRun(),
    lock.holder || lock.waiting.length ? `**Сайт:** сейчас — ${lock.holder ?? "свободен"}${lock.waiting.length ? `, в очереди — ${lock.waiting.join(", ")}` : ""}` : "",
    s.lastRun ? `**Последняя проверка:** ${s.lastRun.text}` : "",
  ];
  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n").slice(0, 1990);
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
  const s = getSettings();

  if (group === "map") {
    if (sub === "list") {
      const entries = Object.entries(s.customFactions);
      return void (await reply(entries.length ? ["**Добавленные фракции:**", ...entries.map(([n, f]) => `• ${n} — ${CATEGORY_LABEL[f.category]}, код ${f.code}`)].join("\n").slice(0, 1990) : "Своих фракций нет — только встроенные списки."));
    }
    const name = interaction.options.getString("name", true).trim();
    if (sub === "add") {
      const category = interaction.options.getString("category", true) as Category;
      const code = interaction.options.getString("code", true).trim().toUpperCase();
      addCustomFaction(name, category, code);
      return void (await reply(`Добавлено: «${name}» — ${CATEGORY_LABEL[category]}, код ${code}.`));
    }
    return void (await reply(removeCustomFaction(name) ? `«${name}» убрана из добавленных.` : "Такой добавленной фракции нет (встроенные убрать нельзя)."));
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
      patchSettings({ guildId: channel.guild.id, channelId: channel.id });
      return void (await reply(`Результаты проверки твинков теперь приходят в <#${channel.id}> (сервер «${channel.guild.name}»).`));
    }

    case "enable":
      patchSettings({ enabled: true });
      return void (await reply(`Автопроверка твинков включена: ${fmtDays(s.days)}, результат к ${fmtTime(s.publishMinutes)} МСК, старт за ${s.leadHours} ч до этого.`));

    case "disable":
      patchSettings({ enabled: false });
      return void (await reply("Автопроверка твинков выключена." + (getRun() ? " Проверка, которая идёт прямо сейчас, доработает до конца (остановить: /twink stop)." : "") + " Ручной запуск: /twink force."));

    case "schedule": {
      if (interaction.options.getBoolean("reset")) patchSettings({ days: [3, 0], publishMinutes: 540, leadHours: 3 });
      const rawDays = interaction.options.getString("days");
      const rawTime = interaction.options.getString("time");
      const lead = interaction.options.getInteger("lead_hours");
      if (rawDays) {
        const days = parseDays(rawDays);
        if (!days) return void (await reply("Не разобрал дни. Пример: `ср вс` или `пн ср пт` (пн вт ср чт пт сб вс)."));
        patchSettings({ days });
      }
      if (rawTime) {
        const t = parseTime(rawTime);
        if (!t) return void (await reply("Не разобрал время. Формат: чч:мм, например 09:00 (МСК)."));
        const [h, m] = t.split(":").map(Number);
        patchSettings({ publishMinutes: h * 60 + m });
      }
      if (lead !== null) patchSettings({ leadHours: lead });
      const n = getSettings();
      return void (await reply(`**Расписание:** ${fmtDays(n.days)}, результат к ${fmtTime(n.publishMinutes)} МСК. Проверка стартует за ${n.leadHours} ч до этого (около ${fmtTime(((n.publishMinutes - n.leadHours * 60) % 1440 + 1440) % 1440)} МСК).`));
    }

    case "force":
      return void (await handleForce(interaction));

    case "stop": {
      const res = await stopRun(interaction.client);
      return void (await reply(res.ok ? res.text : res.reason));
    }

    case "resume": {
      const res = resumeRun(interaction.client);
      return void (await reply(res.ok ? "Продолжаю проверку с того же места. Если сайт попросит код Google Authenticator, бот напишет владельцу в личку." : res.reason));
    }

    case "delay": {
      const delay = interaction.options.getInteger("delay_ms");
      const jitter = interaction.options.getInteger("jitter_ms");
      const wait = interaction.options.getInteger("wait_ms");
      if (delay === null && jitter === null && wait === null) {
        return void (await reply(`Сейчас: пауза ${s.delayMs} мс + случайно до ${s.jitterMs} мс, ожидание окна ${s.waitModalMs} мс. Меньше ${MIN_DELAY_MS} мс паузу поставить нельзя.`));
      }
      patchSettings({ ...(delay !== null ? { delayMs: delay } : {}), ...(jitter !== null ? { jitterMs: jitter } : {}), ...(wait !== null ? { waitModalMs: wait } : {}) });
      const n = getSettings();
      return void (await reply(`Готово: пауза ${n.delayMs} мс + случайно до ${n.jitterMs} мс, ожидание окна ${n.waitModalMs} мс. Действует и на идущую проверку.`));
    }

    case "nick": {
      const name = interaction.options.getString("name", true).trim();
      patchSettings({ nickname: name });
      return void (await reply(`После «by» теперь будет: ${name}`));
    }

    case "options": {
      const skip = interaction.options.getBoolean("skip_seen");
      const block = interaction.options.getBoolean("code_block");
      const progress = interaction.options.getInteger("progress_sec");
      if (skip === null && block === null && progress === null) return void (await reply("Укажите skip_seen, code_block и/или progress_sec."));
      patchSettings({
        ...(skip !== null ? { skipSeen: skip } : {}),
        ...(block !== null ? { codeBlock: block } : {}),
        ...(progress !== null ? { progressSeconds: progress } : {}),
      });
      const n = getSettings();
      return void (await reply(`Пропуск уже встреченных ID: ${n.skipSeen ? "включён" : "выключен"}. Блок кода в результате: ${n.codeBlock ? "включён" : "выключен"}. Сообщение о ходе проверки обновляется раз в ${n.progressSeconds} с.`));
    }

    case "link": {
      const code = interaction.options.getString("faction", true);
      const name = KNOWN_FACTIONS.find((f) => f.code === code)?.name ?? code;
      if (interaction.options.getBoolean("reset")) {
        setLink(code, null);
        const def = DEFAULT_LINKS[code];
        return void (await reply(def ? `Ссылка «${name}» возвращена по умолчанию:\n${def}` : `Для «${name}» нет ссылки по умолчанию — задайте свою.`));
      }
      const url = interaction.options.getString("url")?.trim();
      if (!url) return void (await reply(`Ссылка «${name}»: ${linkFor(code) ?? "не задана"}`));
      if (!/^https:\/\/gta5rp\.com\/mi\?[^\s]*act=faction_members[^\s]*$/.test(url)) {
        return void (await reply("Ссылка должна быть вида https://gta5rp.com/mi?act=faction_members&sid=17&faction=…"));
      }
      setLink(code, url);
      return void (await reply(`Ссылка «${name}» обновлена:\n${url}`));
    }
  }
}

/** Принудительный запуск: сначала подтверждение кнопкой (видно только вам), результат уходит в канал. */
async function handleForce(interaction: ChatInputCommandInteraction): Promise<void> {
  const s = getSettings();
  const fail = (content: string) => interaction.reply({ content, ephemeral: true });
  if (getRun()) return void (await fail("Проверка твинков уже идёт или стоит на паузе (/twink status). Продолжить: /twink resume, остановить: /twink stop."));
  if (!ownerId()) return void (await fail("Не задан WH_OWNER_ID в .env — боту некуда присылать запрос кода входа."));
  if (!s.channelId) return void (await fail("Не задан канал для результатов (/twink channel)."));

  const only = interaction.options.getString("faction");
  const factions = only ? KNOWN_FACTIONS.filter((f) => f.code === only) : getFactions();
  if (!factions.length) return void (await fail("Не выбрано ни одной фракции (/sklad faction add)."));
  const noLink = factions.filter((f) => !linkFor(f.code));
  if (noLink.length) return void (await fail(`Нет ссылки на список участников для: ${noLink.map((f) => f.name).join(", ")} (/twink link).`));
  const lock = siteLockInfo();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("twink-force-yes").setLabel("Подтвердить").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("twink-force-no").setLabel("Отмена").setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({
    content:
      `**Запустить проверку твинков сейчас?**\n${only ? "Только фракция" : "Фракции"}: ${factions.map((f) => f.name).join(", ")}.\n` +
      `Проверка долгая (пауза ${s.delayMs} мс перед каждым нажатием — это несколько часов). Ход и результат придут в <#${s.channelId}>.` +
      (lock.holder ? `\nСейчас на сайте работает «${lock.holder}» — проверка твинков встанет в очередь и стартует сразу после неё.` : ""),
    components: [row],
    ephemeral: true,
  });
  const message = await interaction.fetchReply();

  try {
    const click = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: 60_000,
    });
    if (click.customId !== "twink-force-yes") {
      await click.update({ content: "Отменено.", components: [] });
      return;
    }
    const res = startRun(interaction.client, { kind: "manual", runId: `manual-${Date.now()}`, startedBy: interaction.user.id, onlyFactions: only ? [only] : undefined });
    await click.update({ content: res.ok ? `Запустил. Ход проверки — в <#${s.channelId}>.` : res.reason, components: [] });
  } catch {
    await interaction.editReply({ content: "Время на подтверждение вышло — проверка не запущена.", components: [] }).catch(() => {});
  }
}
