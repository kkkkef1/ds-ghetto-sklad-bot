import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import { CREATOR_ID, DAILY_ATTACK_DEFENSE_LIMIT, DESTINATIONS } from "../captTracker/config.js";
import { dayKeyFromDate, dayKeyFromDateString } from "../captTracker/parser.js";
import { buildSummaryContent } from "../captTracker/render.js";
import {
  addHelper,
  getDayCounts,
  getHelpers,
  removeHelper,
  resetDay,
  setFactionCounts,
  setPingRoleOverride,
} from "../captTracker/store.js";

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
  .addSubcommand((sc) => sc.setName("status").setDescription("Сводка каптов за сегодня по всем фракциям"))
  .addSubcommand((sc) =>
    sc.setName("summary").setDescription("Отправить в чат сообщение с актуальным количеством каптов за сегодня")
  )
  .addSubcommand((sc) =>
    sc
      .setName("set-role")
      .setDescription("Сменить роль, которую бот пингует при превышении лимитов (только создатель)")
      .addStringOption((o) =>
        o.setName("server").setDescription("Сервер, для которого меняем роль").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("role")
          .setDescription("ID роли (ПКМ по роли → Копировать ID) или упоминание @роли")
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

function isCreator(userId: string): boolean {
  return userId === CREATOR_ID;
}

function isCreatorOrHelper(userId: string): boolean {
  return userId === CREATOR_ID || getHelpers().includes(userId);
}

const ID_PATTERN = /^\d{17,20}$/;

/** Autocomplete for the `server` option of /capt set-role: the servers capts are mirrored to, by their real names. */
export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "server") {
    await interaction.respond([]);
    return;
  }
  const query = focused.value.toLowerCase();
  const choices = DESTINATIONS.map((d) => ({
    name: (interaction.client.guilds.cache.get(d.guildId)?.name ?? `Сервер ${d.guildId}`).slice(0, 100),
    value: d.guildId,
  })).filter((c) => c.name.toLowerCase().includes(query) || c.value.includes(query));
  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  // helper-add / helper-remove / reset-day / edit-count / set-role are creator-only
  // management actions; summary is open to everyone (same as the cancel button);
  // status/helpers are readable by the creator and any helper.
  if (sub === "summary") {
    const dayKey = dayKeyFromDate(new Date());
    await interaction.reply({
      content: buildSummaryContent(dayKey, getDayCounts(dayKey)),
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (
    sub === "helper-add" ||
    sub === "helper-remove" ||
    sub === "reset-day" ||
    sub === "edit-count" ||
    sub === "set-role"
  ) {
    if (!isCreator(interaction.user.id)) {
      await interaction.reply({ content: "Эта команда доступна только создателю бота.", ephemeral: true });
      return;
    }
  } else if (!isCreatorOrHelper(interaction.user.id)) {
    await interaction.reply({ content: "Эта команда доступна только создателю и помощникам.", ephemeral: true });
    return;
  }

  if (sub === "set-role") {
    const serverInput = interaction.options.getString("server", true).trim();
    const roleInput = interaction.options.getString("role", true).trim();

    // `server` normally arrives as a guild id from autocomplete, but if the
    // creator typed a name by hand, match on the server's name as a fallback.
    const destination = DESTINATIONS.find(
      (d) =>
        d.guildId === serverInput ||
        interaction.client.guilds.cache.get(d.guildId)?.name.toLowerCase() === serverInput.toLowerCase()
    );
    if (!destination) {
      await interaction.reply({
        content: "Такого сервера нет в списке. Выберите сервер из подсказок поля server.",
        ephemeral: true,
      });
      return;
    }

    const roleId = (roleInput.match(/^<@&(\d{17,20})>$/)?.[1] ?? roleInput).trim();
    if (!ID_PATTERN.test(roleId)) {
      await interaction.reply({ content: "Это не похоже на ID роли или упоминание роли.", ephemeral: true });
      return;
    }

    // Make sure the role really exists on that server — a wrong id is exactly
    // what produced "@неизвестная роль" in the first place.
    try {
      const guild = await interaction.client.guilds.fetch(destination.guildId);
      const role = await guild.roles.fetch(roleId);
      if (!role) {
        await interaction.reply({ content: `Роль с ID ${roleId} не найдена на сервере «${guild.name}».`, ephemeral: true });
        return;
      }
      setPingRoleOverride(destination.guildId, role.id);
      await interaction.reply({
        content: `Для сервера «${guild.name}» роль для пинга при превышении лимитов теперь: <@&${role.id}> (${role.name}).`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error("[captTracker] set-role: не удалось проверить роль:", err);
      await interaction.reply({
        content: "Не удалось проверить роль на этом сервере. Бот точно состоит на нём?",
        ephemeral: true,
      });
    }
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

  if (sub === "status") {
    const dayKey = dayKeyFromDate(new Date());
    const counts = getDayCounts(dayKey);
    const entries = Object.entries(counts);
    if (!entries.length) {
      await interaction.reply({ content: `Сегодня (${dayKey}) каптов ещё не было.`, ephemeral: true });
      return;
    }
    const lines = entries.map(
      ([faction, c]) =>
        `• ${faction}: ⚔️ ${c.attacks} / 🛡️ ${c.defenses}` +
        (c.attacks > DAILY_ATTACK_DEFENSE_LIMIT || c.defenses > DAILY_ATTACK_DEFENSE_LIMIT ? " ⚠️" : "")
    );
    await interaction.reply({ content: `Сводка за ${dayKey}:\n${lines.join("\n")}`, ephemeral: true });
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
      content: `Счётчик «${faction}» за ${dayKey} обновлён вручную: ⚔️ ${updated.attacks} / 🛡️ ${updated.defenses}`,
      ephemeral: true,
    });
    return;
  }
}
