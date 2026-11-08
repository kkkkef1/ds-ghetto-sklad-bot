import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from "discord.js";
import { CREATOR_ID, DAILY_ATTACK_DEFENSE_LIMIT, MAIN_GUILD_ID } from "../captTracker/config.js";
import { dayKeyFromDate, dayKeyFromDateString } from "../captTracker/parser.js";
import { buildSummaryContent } from "../captTracker/render.js";
import {
  addModerator,
  getDayCounts,
  getDestinations,
  getModerators,
  getSourceChannelId,
  isCreatorOrModerator,
  removeDestination,
  removeModerator,
  resetDay,
  setDestinationChannel,
  setDestinationRole,
  setFactionCounts,
  setSourceChannelId,
} from "../captTracker/store.js";

const SERVER_OPTION_DESC = "Сервер, где есть бот (выберите из подсказок)";

export const data = new SlashCommandBuilder()
  .setName("capt")
  .setDescription("Учёт каптов")
  .setDMPermission(false)
  .addSubcommand((sc) =>
    sc.setName("summary").setDescription("Сводка каптов за сегодня (доступна всем)")
  )
  .addSubcommand((sc) =>
    sc.setName("settings").setDescription("Текущие настройки: источник, каналы и роли по серверам, модераторы")
  )
  .addSubcommand((sc) =>
    sc
      .setName("server")
      .setDescription("Настроить сервер-получатель: канал, роль для пинга или убрать сервер")
      .addStringOption((o) =>
        o.setName("server").setDescription(SERVER_OPTION_DESC).setRequired(true).setAutocomplete(true)
      )
      .addStringOption((o) => o.setName("channel").setDescription("Канал для сообщений: ID или #упоминание"))
      .addStringOption((o) => o.setName("role").setDescription("Роль для пинга при превышении лимитов: ID, @роль или none"))
      .addBooleanOption((o) => o.setName("remove").setDescription("true — перестать слать сообщения на этот сервер"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("source")
      .setDescription("Канал главного сервера, откуда бот читает забивы")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Канал с забивами")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("counter")
      .setDescription("Поправить счётчик каптов за день или сбросить его целиком")
      .addStringOption((o) => o.setName("faction").setDescription("Фракция (как в отчёте); не нужна при сбросе"))
      .addIntegerOption((o) => o.setName("attacks").setDescription("Новое значение атак").setMinValue(0))
      .addIntegerOption((o) => o.setName("defenses").setDescription("Новое значение защит").setMinValue(0))
      .addStringOption((o) => o.setName("day").setDescription("Дата ДД.ММ.ГГГГ (по умолчанию — сегодня)"))
      .addBooleanOption((o) => o.setName("reset").setDescription("true — сбросить счётчик за день у всех фракций"))
  )
  .addSubcommand((sc) =>
    sc
      .setName("moderator")
      .setDescription("Добавить или убрать модератора (только создатель)")
      .addStringOption((o) =>
        o
          .setName("action")
          .setDescription("Что сделать")
          .setRequired(true)
          .addChoices({ name: "Добавить", value: "add" }, { name: "Убрать", value: "remove" })
      )
      .addStringOption((o) => o.setName("id").setDescription("Discord ID пользователя").setRequired(true))
  );

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
  const reply = (content: string) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  // summary открыта всем, на любом сервере (как и кнопка «Отменить капт»).
  if (sub === "summary") {
    const dayKey = dayKeyFromDate(new Date());
    await interaction.reply({
      content: buildSummaryContent(dayKey, getDayCounts(dayKey)),
      allowedMentions: { parse: [] },
    });
    return;
  }

  // Всё остальное — серьёзные настройки: только с главного сервера и только для своих.
  if (interaction.guildId !== MAIN_GUILD_ID) {
    await reply("Настройки доступны только на главном сервере.");
    return;
  }
  if (sub === "moderator") {
    if (interaction.user.id !== CREATOR_ID) {
      await reply("Список модераторов меняет только создатель бота.");
      return;
    }
  } else if (!isCreatorOrModerator(interaction.user.id)) {
    await reply("Эта команда доступна только создателю и модераторам.");
    return;
  }

  if (sub === "settings") {
    const client = interaction.client;
    const lines: string[] = [`**Канал-источник забивов:** <#${getSourceChannelId()}>`, "", "**Куда шлются сообщения о каптах:**"];
    const destinations = getDestinations();
    if (!destinations.length) lines.push("• пока никуда — задайте через /capt server");
    for (const d of destinations) {
      const name = client.guilds.cache.get(d.guildId)?.name ?? `сервер ${d.guildId} (бота там нет?)`;
      lines.push(`• **${name}** — канал <#${d.channelId}>, роль ${d.pingRoleId ? `<@&${d.pingRoleId}>` : "не задана (без пинга)"}`);
    }
    const moderators = getModerators();
    lines.push("", "**Модераторы:**");
    lines.push(...(moderators.length ? moderators.map((id) => `• <@${id}>`) : ["• список пуст"]));
    await reply(lines.join("\n"));
    return;
  }

  if (sub === "server") {
    const guildId = resolveGuildId(interaction.client, interaction.options.getString("server", true));
    if (!guildId) {
      await reply("Не нашёл такой сервер среди серверов бота. Выберите сервер из подсказок поля server.");
      return;
    }
    const channelInput = interaction.options.getString("channel");
    const roleInput = interaction.options.getString("role")?.trim() ?? null;
    const remove = interaction.options.getBoolean("remove") ?? false;

    if (remove) {
      const removed = removeDestination(guildId);
      await reply(
        removed
          ? "Готово: на этот сервер бот больше не шлёт сообщения о каптах."
          : "Этот сервер не был в списке получателей."
      );
      return;
    }
    if (channelInput === null && roleInput === null) {
      await reply("Укажите channel, role или remove: что именно нужно изменить.");
      return;
    }

    let guild: Guild;
    try {
      guild = await interaction.client.guilds.fetch(guildId);
    } catch (err) {
      console.error("[captTracker] server: не удалось получить сервер:", err);
      await reply("Не удалось получить сервер. Бот точно состоит на нём?");
      return;
    }

    // Сначала проверяем всё, потом применяем — чтобы при ошибке ничего не менялось наполовину.
    let channelId: string | null = null;
    if (channelInput !== null) {
      channelId = parseId(channelInput, "channel");
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
        await reply(`У бота нет прав «Просмотр канала» и «Отправка сообщений» в <#${channel.id}> на сервере «${guild.name}».`);
        return;
      }
    }

    let roleId: string | null | undefined; // undefined — не менять, null — убрать
    if (roleInput !== null) {
      if (/^(none|нет|-)$/i.test(roleInput)) {
        roleId = null;
      } else {
        const parsed = parseId(roleInput, "role");
        if (!parsed) {
          await reply("Это не похоже на ID роли или упоминание роли.");
          return;
        }
        const role = await guild.roles.fetch(parsed).catch(() => null);
        if (!role) {
          await reply(`Роль с ID ${parsed} не найдена на сервере «${guild.name}».`);
          return;
        }
        roleId = role.id;
      }
    }

    if (channelId) setDestinationChannel(guildId, channelId);
    const done: string[] = [];
    if (channelId) done.push(`сообщения о каптах теперь идут в <#${channelId}>`);
    if (roleId !== undefined) {
      if (!setDestinationRole(guildId, roleId)) {
        await reply(`Для сервера «${guild.name}» ещё не задан канал — укажите channel вместе с role.`);
        return;
      }
      done.push(roleId ? `роль для пинга: <@&${roleId}>` : "роль убрана, пинга не будет");
    }
    await reply(`Сервер «${guild.name}»: ${done.join("; ")}.`);
    return;
  }

  if (sub === "source") {
    const channel = interaction.options.getChannel("channel", true);
    if (!("guildId" in channel) || channel.guildId !== MAIN_GUILD_ID) {
      await reply("Канал-источник должен быть на главном сервере.");
      return;
    }
    setSourceChannelId(channel.id);
    await reply(`Забивы теперь читаются из <#${channel.id}>.`);
    return;
  }

  if (sub === "counter") {
    const dayInput = interaction.options.getString("day");
    let dayKey: string;
    if (dayInput) {
      const parsedDay = dayKeyFromDateString(dayInput);
      if (!parsedDay) {
        await reply("Некорректная дата. Формат: ДД.ММ.ГГГГ.");
        return;
      }
      dayKey = parsedDay;
    } else {
      dayKey = dayKeyFromDate(new Date());
    }

    if (interaction.options.getBoolean("reset")) {
      resetDay(dayKey);
      await reply(`Счётчик каптов за ${dayKey} сброшен.`);
      return;
    }

    const faction = interaction.options.getString("faction")?.trim();
    const attacks = interaction.options.getInteger("attacks");
    const defenses = interaction.options.getInteger("defenses");
    if (!faction) {
      await reply("Укажите faction, чтобы поправить счётчик, или reset:true, чтобы сбросить день.");
      return;
    }
    if (attacks === null && defenses === null) {
      await reply("Укажите хотя бы одно значение: attacks или defenses.");
      return;
    }
    const updated = setFactionCounts(dayKey, faction, attacks ?? undefined, defenses ?? undefined);
    await reply(
      `Счётчик «${faction}» за ${dayKey} обновлён вручную: атаки ${updated.attacks} / защиты ${updated.defenses}` +
        (updated.attacks > DAILY_ATTACK_DEFENSE_LIMIT || updated.defenses > DAILY_ATTACK_DEFENSE_LIMIT ? " (превышение лимита)" : "")
    );
    return;
  }

  if (sub === "moderator") {
    const id = interaction.options.getString("id", true).trim();
    if (!ID_PATTERN.test(id)) {
      await reply("Это не похоже на корректный Discord ID.");
      return;
    }
    if (interaction.options.getString("action", true) === "add") {
      await reply(addModerator(id) ? `<@${id}> добавлен(а) в модераторы.` : `<@${id}> уже в списке модераторов.`);
    } else {
      await reply(removeModerator(id) ? `<@${id}> удалён(а) из модераторов.` : `<@${id}> не найден(а) в списке модераторов.`);
    }
    return;
  }
}
