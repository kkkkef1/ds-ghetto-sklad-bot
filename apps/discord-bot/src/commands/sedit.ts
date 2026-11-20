// /sedit — поправить дату и/или время уже зарегистрированного собрания, не удаляя и не создавая его заново.
// Анонс редактируется на месте (то же сообщение), отметки «Буду / Не буду» сохраняются.

import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { canManageServer } from "../access.js";
import { rescheduleOccurrence } from "../activity/service.js";
import { getOccurrence } from "../activity/store.js";
import { formatDateTime, mskDateKey, mskToUtcMs, parseDateInput, parseTime } from "../activity/time.js";

// Подсказки со списком предстоящих собраний — те же, что у /meeting cancel.
export { autocomplete } from "./meeting.js";

export const data = new SlashCommandBuilder()
  .setName("sedit")
  .setDescription("Изменить дату и/или время собрания (укажите только то, что меняется)")
  .setDMPermission(false)
  .addStringOption((o) =>
    o.setName("meeting").setDescription("Собрание (выберите из подсказок)").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((o) => o.setName("date").setDescription("Новая дата ДД.ММ или ДД.ММ.ГГГГ"))
  .addStringOption((o) => o.setName("time").setDescription("Новое время по МСК, например 20:00"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.reply({ content: "Команда работает только на сервере.", ephemeral: true });
    return;
  }
  if (!(await canManageServer(interaction))) {
    await interaction.reply({
      content: "Собрания могут менять только админы сервера, модераторы и создатель.",
      ephemeral: true,
    });
    return;
  }

  const dateInput = interaction.options.getString("date");
  const timeInput = interaction.options.getString("time");
  if (!dateInput && !timeInput) {
    await interaction.reply({ content: "Укажите новую дату, новое время или и то и другое.", ephemeral: true });
    return;
  }

  const occ = getOccurrence(interaction.options.getString("meeting", true));
  if (!occ || occ.kind !== "meeting" || occ.guildId !== guildId || occ.canceled) {
    await interaction.reply({ content: "Такого собрания нет. Выберите его из подсказок.", ephemeral: true });
    return;
  }

  // Что не указано — остаётся прежним.
  let dateKey = mskDateKey(occ.startAt);
  let time = formatDateTime(occ.startAt).slice(11);
  if (dateInput) {
    const parsed = parseDateInput(dateInput);
    if (!parsed) {
      await interaction.reply({ content: "Не понял дату. Формат: ДД.ММ или ДД.ММ.ГГГГ.", ephemeral: true });
      return;
    }
    dateKey = parsed;
  }
  if (timeInput) {
    const parsed = parseTime(timeInput);
    if (!parsed) {
      await interaction.reply({ content: "Не понял время. Формат: 20:00.", ephemeral: true });
      return;
    }
    time = parsed;
  }

  const startAt = mskToUtcMs(dateKey, time);
  if (startAt === occ.startAt) {
    await interaction.reply({ content: "Это уже текущие дата и время собрания, менять нечего.", ephemeral: true });
    return;
  }
  if (startAt <= Date.now()) {
    await interaction.reply({ content: "Эта дата и время уже прошли.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await rescheduleOccurrence(occ, startAt);
  if (!result.ok) {
    const text = {
      notMeeting: "Переносить можно только собрания.",
      canceled: "Это собрание уже отменено.",
      closed: "Собрание уже началось, отметка закрыта: перенести его нельзя.",
      past: "Эта дата и время уже прошли.",
    }[result.reason];
    await interaction.editReply({ content: text });
    return;
  }

  const lines = [
    `Собрание ${occ.title} перенесено: ${formatDateTime(result.oldStartAt)} → ${formatDateTime(occ.startAt)} (МСК).`,
    result.announceUpdated
      ? `Анонс обновлён на месте, отметки сохранены (${result.marksCount}).`
      : "Время изменено, но анонс обновить не удалось (проверьте права бота в канале). Он обновится при следующей отметке.",
  ];
  await interaction.editReply({ content: lines.join("\n") });
}
