import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { CREATOR_ID, DAILY_ATTACK_DEFENSE_LIMIT } from "../captTracker/config.js";
import { dayKeyFromDate } from "../captTracker/parser.js";
import { addHelper, getDayCounts, getHelpers, removeHelper, resetDay } from "../captTracker/store.js";

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
  .addSubcommand((sc) => sc.setName("reset-day").setDescription("Сбросить счётчик каптов за сегодня (только создатель)"));

function isCreator(userId: string): boolean {
  return userId === CREATOR_ID;
}

function isCreatorOrHelper(userId: string): boolean {
  return userId === CREATOR_ID || getHelpers().includes(userId);
}

const ID_PATTERN = /^\d{17,20}$/;

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  // helper-add / helper-remove / reset-day are creator-only management
  // actions; status/helpers are readable by the creator and any helper.
  if (sub === "helper-add" || sub === "helper-remove" || sub === "reset-day") {
    if (!isCreator(interaction.user.id)) {
      await interaction.reply({ content: "Эта команда доступна только создателю бота.", ephemeral: true });
      return;
    }
  } else if (!isCreatorOrHelper(interaction.user.id)) {
    await interaction.reply({ content: "Эта команда доступна только создателю и помощникам.", ephemeral: true });
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
}
