import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { CREATOR_ID, DAILY_ATTACK_DEFENSE_LIMIT, MAIN_GUILD_ID } from "../captTracker/config.js";
import { dayKeyFromDate, dayKeyFromDateString } from "../captTracker/parser.js";
import { buildSummaryContent } from "../captTracker/render.js";
import {
  addHelper,
  getDayCounts,
  getDestinations,
  getHelpers,
  getSourceChannelId,
  removeDestination,
  removeHelper,
  resetDay,
  setDestinationChannel,
  setDestinationRole,
  setFactionCounts,
  setSourceChannelId,
} from "../captTracker/store.js";

const SERVER_OPTION_DESC = "Сервер, где есть бот (выберите из подсказок)";

export const data = new SlashCommandBuilder()
  .setName("capt")
  .setDescription("Управление учётом каптов")
  .setDMPermission(false)
  .addSubcommand((sc) =>
    sc
      .setName("helper-add")
      .setDescription("Добавить помощника по Discord ID (только создатель)")
      .addStringOption((o) => o.setName("id").setDescription("Discord ID пользователя").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("helper-remove")
      .setDescription("Убрать помощника по Discord ID (только создатель)")
      .addStringOption((o) => o.setName("id").setDescription("Discord ID пользователя").setRequired(true))
  )
  .addSubcommand((sc) => sc.setName("helpers").setDescription("Показать список помощников"))
  .addSubcommand((sc) =>
    sc.setName("summary").setDescription("Отправить в чат сообщение с актуальным количеством каптов за сегодня")
  )
  .addSubcommand((sc) =>
    sc.setName("settings").setDescription("Показать текущие настройки: канал-источник, каналы и роли по серверам")
  )
  .addSubcommand((sc) =>
    sc
      .setName("set-channel")
      .setDescription("Задать канал, куда бот шлёт сообщения о каптах на выбранном сервере (только создатель)")
      .addStringOption((o) =>
        o.setName("server").setDescription(SERVER_OPTION_DESC).setRequired(true).setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("channel")
          .setDescription("ID канала (ПКМ по каналу → Копировать ID) или #упоминание")
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("set-role")
      .setDescription("Роль, которую бот пингует при превышении лимитов на сервере (только создатель)")
      .addStringOption((o) =>
        o.setName("server").setDescription(SERVER_OPTION_DESC).setRequired(true).setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("role")
          .setDescription("ID роли, @упоминание роли или none — чтобы не пинговать никого")
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove-channel")
      .setDescription("Перестать слать сообщения о каптах на выбранный сервер (только создатель)")
      .addStringOption((o) =>
        o.setName("server").setDescription(SERVER_OPTION_DESC).setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("set-source")
      .setDescription("Канал на главном сервере, откуда бот читает забивы (только создатель)")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Канал с забивами")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  )
  .addSubcommand((sc) => sc.setName("reset-day").setDescription("Сбросить счётчик каптов за сегодня (только создатель)"))
  .addSubcommand((sc) =>
    sc
      .setName("edit-count")
      .setDescription("Вручную выставить счётчик атак/защит фракции за день (только создатель)")
      .addStringOption((o) => o.setName("faction").setDescription("Название фракции (как в отчёте)").setRequired(true))
      .addIntegerOption((o) => o.setName("attacks").setDescription("Новое значение атак").setMinValue(0))
      .addIntegerOption((o) => o.setName("defenses").setDescription("Новое значение защит").setMinValue(0))
      .addStringOption((o) =>
        o.setName("day").setDescription("Дата в формате ДД.ММ.ГГГГ (по умолчанию — сегодня)")
      )
  );

/** Команды, меняющие настройки/данные: только создатель и только на главном сервере. */
const CREATOR_SUBCOMMANDS = new Set([
  "helper-add",
  "helper-remove",
  "set-channel",
  "set-role",
  "remove-channel",
  "set-source",
  "reset-day",
  "edit-count",
]);

function isCreator(userId: string): boolean {
  return userId === CREATOR_ID;
}

function isCreatorOrHelper(userId: string): boolean {
  return userId === CREATOR_ID || getHelpers().includes(userId);
}

const ID_PATTERN = /^\d{17,20}$/;

/** Подсказки для поля `server`: все серверы, на которых сейчас есть бот. */
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "server") {
    await interaction.respond([]);
    return;
  }
  const query = focused.value.toLowerCase();
  const choices = [...interaction.client.guilds.cache.values()]
    .map((g) => ({ name: g.name.slice(0, 100), value: g.id }))
    .filter((c) => c.name.toLowerCase().includes(query) || c.value.includes(query))
    .slice(0, 25);
  await interaction.respond(choices);
}

/** `server` приходит как id из подсказок; если ввели название руками — ищем по имени среди серверов бота. */
function resolveGuildId(client: Client, input: string): string | undefined {
  const value = input.trim();
  const byId = client.guilds.cache.get(value);
  if (byId) return byId.id;
  const lower = value.toLowerCase();
  return [...client.guilds.cache.values()].find((g) => g.name.toLowerCase() === lower)?.id;
}

function parseId(input: string, kind: "role" | "channel"): string | null {
  const mention = kind === "role" ? /^<@&(\d{17,20})>$/ : /^<#(\d{17,20})>$/;
  const id = (input.trim().match(mention)?.[1] ?? input.trim()).trim();
  return ID_PATTERN.test(id) ? id : null;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  // summary открыта всем (как и кнопка «Отменить капт»).
  if (sub === "summary") {
    const dayKey = dayKeyFromDate(new Date());
    await interaction.reply({
      content: buildSummaryContent(dayKey, getDayCounts(dayKey)),
      allowedMentions: { parse: [] },
    });
    return;
  }

  // Всё остальное — только с главного сервера по настройке.
  if (interaction.guildId !== MAIN_GUILD_ID) {
    await interaction.reply({ content: "Настройки доступны только на главном сервере.", ephemeral: true });
    return;
  }

  if (CREATOR_SUBCOMMANDS.has(sub)) {
    if (!isCreator(interaction.user.id)) {
      await interaction.reply({ content: "Эта команда доступна только создателю бота.", ephemeral: true });
      return;
    }
  } else if (!isCreatorOrHelper(interaction.user.id)) {
    await interaction.reply({ content: "Эта команда доступна только создателю и помощникам.", ephemeral: true });
    return;
  }

  if (sub === "settings") {
    const client = interaction.client;
    const lines: string[] = [`**Канал-источник забивов:** <#${getSourceChannelId()}>`, "", "**Куда шлются сообщения о каптах:**"];
    const destinations = getDestinations();
    if (!destinations.length) {
      lines.push("• пока никуда — задайте через /capt set-channel");
    }
    for (const d of destinations) {
      const name = client.guilds.cache.get(d.guildId)?.name ?? `сервер ${d.guildId} (бота там нет?)`;
      lines.push(`• **${name}** — канал <#${d.channelId}>, роль ${d.pingRoleId ? `<@&${d.pingRoleId}>` : "не задана (без пинга)"}`);
    }
    await interaction.reply({ content: lines.join("\n"), ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }

  if (sub === "set-channel") {
    const guildId = resolveGuildId(interaction.client, interaction.options.getString("server", true));
    if (!guildId) {
      await interaction.reply({
        content: "Не нашёл такой сервер среди серверов бота. Выберите сервер из подсказок поля server.",
        ephemeral: true,
      });
      return;
    }
    const channelId = parseId(interaction.options.getString("channel", true), "channel");
    if (!channelId) {
      await interaction.reply({ content: "Это не похоже на ID канала.", ephemeral: true });
      return;
    }

    try {
      const guild = await interaction.client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({
          content: `Текстовый канал с ID ${channelId} не найден на сервере «${guild.name}».`,
          ephemeral: true,
        });
        return;
      }
      const me = await guild.members.fetchMe();
      const perms = channel.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        await interaction.reply({
          content: `У бота нет прав «Просмотр канала» и «Отправка сообщений» в <#${channel.id}> на сервере «${guild.name}».`,
          ephemeral: true,
        });
        return;
      }
      setDestinationChannel(guildId, channel.id);
      await interaction.reply({
        content: `Для сервера «${guild.name}» сообщения о каптах теперь идут в <#${channel.id}>.`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error("[captTracker] set-channel: не удалось проверить канал:", err);
      await interaction.reply({ content: "Не удалось проверить канал на этом сервере. Бот точно состоит на нём?", ephemeral: true });
    }
    return;
  }

  if (sub === "set-role") {
    const guildId = resolveGuildId(interaction.client, interaction.options.getString("server", true));
    if (!guildId) {
      await interaction.reply({
        content: "Не нашёл такой сервер среди серверов бота. Выберите сервер из подсказок поля server.",
        ephemeral: true,
      });
      return;
    }
    const roleInput = interaction.options.getString("role", true).trim();

    // «none» — убрать роль: сообщения продолжат приходить, но без пинга.
    if (/^(none|нет|-)$/i.test(roleInput)) {
      const ok = setDestinationRole(guildId, null);
      await interaction.reply({
        content: ok
          ? "Роль убрана — при превышении лимитов бот никого не пингует."
          : "Для этого сервера ещё не задан канал. Сначала /capt set-channel.",
        ephemeral: true,
      });
      return;
    }

    const roleId = parseId(roleInput, "role");
    if (!roleId) {
      await interaction.reply({ content: "Это не похоже на ID роли или упоминание роли.", ephemeral: true });
      return;
    }

    // Проверяем, что роль реально есть на сервере — неверный id как раз и давал «@неизвестная роль».
    try {
      const guild = await interaction.client.guilds.fetch(guildId);
      const role = await guild.roles.fetch(roleId);
      if (!role) {
        await interaction.reply({ content: `Роль с ID ${roleId} не найдена на сервере «${guild.name}».`, ephemeral: true });
        return;
      }
      if (!setDestinationRole(guildId, role.id)) {
        await interaction.reply({
          content: `Для сервера «${guild.name}» ещё не задан канал. Сначала /capt set-channel.`,
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        content: `Для сервера «${guild.name}» роль для пинга при превышении лимитов теперь: <@&${role.id}> (${role.name}).`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error("[captTracker] set-role: не удалось проверить роль:", err);
      await interaction.reply({ content: "Не удалось проверить роль на этом сервере. Бот точно состоит на нём?", ephemeral: true });
    }
    return;
  }

  if (sub === "remove-channel") {
    const guildId = resolveGuildId(interaction.client, interaction.options.getString("server", true));
    const removed = guildId ? removeDestination(guildId) : false;
    await interaction.reply({
      content: removed
        ? "Готово: на этот сервер бот больше не шлёт сообщения о каптах."
        : "Этот сервер не был в списке получателей.",
      ephemeral: true,
    });
    return;
  }

  if (sub === "set-source") {
    const channel = interaction.options.getChannel("channel", true);
    if (!("guildId" in channel) || channel.guildId !== MAIN_GUILD_ID) {
      await interaction.reply({ content: "Канал-источник должен быть на главном сервере.", ephemeral: true });
      return;
    }
    setSourceChannelId(channel.id);
    await interaction.reply({
      content: `Забивы теперь читаются из <#${channel.id}>.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (sub === "helper-add") {
    const id = interaction.options.getString("id", true).trim();
    if (!ID_PATTERN.test(id)) {
      await interaction.reply({ content: "Это не похоже на корректный Discord ID.", ephemeral: true });
      return;
    }
    const added = addHelper(id);
    await interaction.reply({
      content: added ? `<@${id}> добавлен(а) в помощники.` : `<@${id}> уже в списке помощников.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "helper-remove") {
    const id = interaction.options.getString("id", true).trim();
    const removed = removeHelper(id);
    await interaction.reply({
      content: removed ? `<@${id}> удалён(а) из помощников.` : `<@${id}> не найден(а) в списке помощников.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "helpers") {
    const helpers = getHelpers();
    await interaction.reply({
      content: helpers.length ? `Помощники:\n${helpers.map((id) => `• <@${id}>`).join("\n")}` : "Список помощников пуст.",
      ephemeral: true,
    });
    return;
  }

  if (sub === "reset-day") {
    const dayKey = dayKeyFromDate(new Date());
    resetDay(dayKey);
    await interaction.reply({ content: `Счётчик каптов за ${dayKey} сброшен.`, ephemeral: true });
    return;
  }

  if (sub === "edit-count") {
    const faction = interaction.options.getString("faction", true).trim();
    const attacks = interaction.options.getInteger("attacks");
    const defenses = interaction.options.getInteger("defenses");

    if (attacks === null && defenses === null) {
      await interaction.reply({ content: "Укажите хотя бы одно значение: attacks или defenses.", ephemeral: true });
      return;
    }

    const dayInput = interaction.options.getString("day");
    let dayKey: string;
    if (dayInput) {
      const parsedDay = dayKeyFromDateString(dayInput);
      if (!parsedDay) {
        await interaction.reply({ content: "Некорректная дата. Формат: ДД.ММ.ГГГГ.", ephemeral: true });
        return;
      }
      dayKey = parsedDay;
    } else {
      dayKey = dayKeyFromDate(new Date());
    }

    const updated = setFactionCounts(dayKey, faction, attacks ?? undefined, defenses ?? undefined);
    await interaction.reply({
      content: `Счётчик «${faction}» за ${dayKey} обновлён вручную: ⚔️ ${updated.attacks} / 🛡️ ${updated.defenses}` +
        (updated.attacks > DAILY_ATTACK_DEFENSE_LIMIT || updated.defenses > DAILY_ATTACK_DEFENSE_LIMIT ? " ⚠️" : ""),
      ephemeral: true,
    });
    return;
  }
}
