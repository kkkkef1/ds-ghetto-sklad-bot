import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import { createSession, endSession, getActiveSessionChannel } from "../session.js";
import { runWizard } from "../wizard.js";

export const data = new SlashCommandBuilder()
  .setName("sliv")
  .setDescription("Начать новую сессию анализа слива склада фракции")
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const existingChannelId = getActiveSessionChannel(interaction.user.id);
  if (existingChannelId) {
    await interaction.reply({
      content: `У вас уже есть активная сессия: <#${existingChannelId}>. Дождитесь её завершения перед запуском новой.`,
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Команда работает только на сервере.", ephemeral: true });
    return;
  }

  const categoryId = process.env.LOGS_CATEGORY_ID;
  if (!categoryId) {
    await interaction.reply({ content: "Бот не настроен: не задан LOGS_CATEGORY_ID в конфигурации.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const channel = (await guild.channels.create({
    name: `слив-${interaction.user.username}-${Date.now().toString(36)}`,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: `Сессия слива склада · создана ${interaction.user.tag} · ${new Date().toISOString()}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      ...(guild.members.me
        ? [{
            id: guild.members.me.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageMessages,
            ],
          }]
        : []),
    ],
  })) as TextChannel;

  const session = createSession(channel.id, interaction.user.id, guild.id);

  await interaction.editReply({ content: `Сессия создана: ${channel}` });
  await channel.send(`${interaction.user} сессия начата. Один запуск команды = одна сессия — данные из других сессий сюда не попадут.`);

  runWizard(channel, session)
    .catch(async (err) => {
      console.error(`[sliv] Ошибка в сессии ${channel.id}:`, err);
      await channel.send("❌ Произошла ошибка при обработке. Сессия прервана — можно запустить новую командой `/sliv`.").catch(() => {});
    })
    .finally(() => {
      // Frees the user's "one active session" slot. The channel itself stays
      // (per requirements, no deletion/archival) as a permanent record.
      endSession(channel.id);
    });
}
