// /remind — личные напоминания в ЛС за 15 минут до начала МП и собраний.
// Напоминание получает только тот, кто нажал «Буду». Команда доступна всем и работает в личных сообщениях с ботом.

import { SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction } from "discord.js";
import { isReminderOff, setReminderOff } from "../activity/store.js";

export const data = new SlashCommandBuilder()
  .setName("remind")
  .setDescription("Личные напоминания в ЛС за 15 минут до МП и собрания, где вы нажали «Буду»")
  .setDMPermission(true)
  .addSubcommand((sc) => sc.setName("off").setDescription("Больше не присылать мне напоминания в ЛС"))
  .addSubcommand((sc) => sc.setName("on").setDescription("Снова присылать мне напоминания в ЛС"))
  .addSubcommand((sc) => sc.setName("status").setDescription("Включены ли напоминания для меня"));

const OFF_TEXT = "🔕 Напоминания отключены. Вернуть их можно командой `/remind on`.";
const ON_TEXT = "🔔 Напоминания включены: за 15 минут до начала бот напишет вам в ЛС, если вы нажали «Буду».";

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;
  if (sub === "off") {
    setReminderOff(userId, true);
    await interaction.reply({ content: OFF_TEXT, ephemeral: true });
  } else if (sub === "on") {
    setReminderOff(userId, false);
    await interaction.reply({ content: ON_TEXT, ephemeral: true });
  } else {
    await interaction.reply({
      content: isReminderOff(userId)
        ? "Напоминания для вас **отключены**. Включить: `/remind on`."
        : "Напоминания для вас **включены**: за 15 минут до начала бот пишет в ЛС тем, кто нажал «Буду». Отключить: `/remind off`.",
      ephemeral: true,
    });
  }
}

/** Кнопка «Не напоминать больше» под личным напоминанием. */
export async function handleRemindButton(interaction: ButtonInteraction): Promise<void> {
  setReminderOff(interaction.user.id, true);
  await interaction.update({ content: `${interaction.message.content}\n\n${OFF_TEXT}`.slice(0, 2000), components: [] });
}
