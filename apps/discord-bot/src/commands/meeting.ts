import { SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import { CREATOR_ID } from "../captTracker/config.js";
import { getHelpers } from "../captTracker/store.js";
import { cancelOccurrence, createMeeting, getMember, isAdminMember } from "../activity/service.js";
import { getGuildSettings, getOccurrence, listOccurrences } from "../activity/store.js";
import { formatDateTime, mskToUtcMs, parseDateInput, parseTime } from "../activity/time.js";

export const data = new SlashCommandBuilder()
  .setName("meeting")
  .setDescription("Собрания фракций")
  .setDMPermission(false)
  .addSubcommand((sc) =>
    sc
      .setName("register")
      .setDescription("Зарегистрировать собрание: анонс уйдёт в канал «Активити МП»")
      .addRoleOption((o) => o.setName("faction").setDescription("Роль фракции (будет пингом)").setRequired(true))
      .addStringOption((o) => o.setName("date").setDescription("Дата ДД.ММ или ДД.ММ.ГГГГ").setRequired(true))
      .addStringOption((o) => o.setName("time").setDescription("Время по МСК, например 20:00").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("cancel")
      .setDescription("Отменить зарегистрированное собрание")
      .addStringOption((o) =>
        o.setName("meeting").setDescription("Собрание (выберите из подсказок)").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sc) => sc.setName("list").setDescription("Предстоящие собрания на этом сервере"));

async function canManage(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (interaction.user.id === CREATOR_ID || getHelpers().includes(interaction.user.id)) return true;
  const member = await getMember(interaction);
  return member !== null && isAdminMember(getGuildSettings(interaction.guildId!), member);
}

function upcomingMeetings(guildId: string) {
  const now = Date.now();
  return listOccurrences()
    .filter((o) => o.kind === "meeting" && o.guildId === guildId && !o.canceled && o.startAt > now)
    .sort((a, b) => a.startAt - b.startAt);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const q = interaction.options.getFocused().toLowerCase();
  const choices = upcomingMeetings(interaction.guildId)
    .map((o) => ({ name: `${o.title} — ${formatDateTime(o.startAt)}`.slice(0, 100), value: o.id }))
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 25);
  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.reply({ content: "Команда работает только на сервере.", ephemeral: true });
    return;
  }
  if (!(await canManage(interaction))) {
    await interaction.reply({ content: "Собрания могут регистрировать только админы сервера.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const noPing = { parse: [] as never[] };

  if (sub === "list") {
    const list = upcomingMeetings(guildId);
    await interaction.reply({
      content: list.length
        ? "**Предстоящие собрания:**\n" +
          list.map((o) => `• <@&${o.pingRoleId}> — ${formatDateTime(o.startAt)} (МСК)`).join("\n")
        : "Предстоящих собраний нет.",
      ephemeral: true,
      allowedMentions: noPing,
    });
    return;
  }

  if (sub === "cancel") {
    const occ = getOccurrence(interaction.options.getString("meeting", true));
    if (!occ || occ.kind !== "meeting" || occ.guildId !== guildId || occ.canceled) {
      await interaction.reply({ content: "Такого собрания нет. Выберите его из подсказок.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await cancelOccurrence(occ);
    await interaction.editReply({
      content: `Собрание ${occ.title} (${formatDateTime(occ.startAt)}) отменено, анонс помечен как отменённый.`,
    });
    return;
  }

  // register
  const role = interaction.options.getRole("faction", true);
  if (role.id === guildId) {
    await interaction.reply({ content: "Нужна роль фракции, а не @everyone.", ephemeral: true });
    return;
  }
  const dateKey = parseDateInput(interaction.options.getString("date", true));
  if (!dateKey) {
    await interaction.reply({ content: "Не понял дату. Формат: ДД.ММ или ДД.ММ.ГГГГ.", ephemeral: true });
    return;
  }
  const time = parseTime(interaction.options.getString("time", true));
  if (!time) {
    await interaction.reply({ content: "Не понял время. Формат: 20:00.", ephemeral: true });
    return;
  }
  const startAt = mskToUtcMs(dateKey, time);
  if (startAt <= Date.now()) {
    await interaction.reply({ content: "Эта дата и время уже прошли.", ephemeral: true });
    return;
  }
  const settings = getGuildSettings(guildId);
  if (!settings.announceChannelId) {
    await interaction.reply({
      content: "Для этого сервера не задан канал «Активити МП» (N1). Его настраивают через /mp set-channel на главном сервере.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const occ = await createMeeting(guildId, role.id, role.name, startAt);
    await interaction.editReply({
      content: `Собрание ${role.name} зарегистрировано на ${formatDateTime(occ.startAt)} (МСК). Анонс отправлен в <#${settings.announceChannelId}>.`,
    });
  } catch (err) {
    console.error("[activity] Не удалось зарегистрировать собрание:", err);
    await interaction.editReply({
      content: "Не удалось отправить анонс в канал «Активити МП». Проверьте права бота в этом канале; собрание не зарегистрировано.",
    });
  }
}
