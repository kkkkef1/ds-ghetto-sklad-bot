import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { CREATOR_ID } from "../captTracker/config.js";

// Channel ids are unique across all of Discord, so a plain string option is
// enough to address a channel on *any* server the bot is in — a native
// Discord "channel" option can only ever list channels from the guild the
// command is being run in, which would defeat the point of this command.
export const data = new SlashCommandBuilder()
  .setName("announce")
  .setDescription("Опубликовать сообщение от имени бота в любом канале на любом сервере, где есть бот (только создатель)")
  .setDMPermission(true)
  .addStringOption((o) =>
    o.setName("channel_id").setDescription("ID канала назначения (ПКМ по каналу → Копировать ID)").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("message").setDescription("Текст сообщения").setRequired(true)
  )
  .addAttachmentOption((o) =>
    o.setName("attachment").setDescription("Необязательное вложение к сообщению").setRequired(false)
  );

const ID_PATTERN = /^\d{17,20}$/;

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Deliberately creator-only, not creator-or-helper: this posts as the bot
  // to any server it's in, with no further scoping — broader than any other
  // admin command in the bot, so it gets the narrowest permission check.
  if (interaction.user.id !== CREATOR_ID) {
    await interaction.reply({ content: "Эта команда доступна только создателю бота.", ephemeral: true });
    return;
  }

  const channelId = interaction.options.getString("channel_id", true).trim();
  if (!ID_PATTERN.test(channelId)) {
    await interaction.reply({ content: "Это не похоже на корректный ID канала.", ephemeral: true });
    return;
  }

  const message = interaction.options.getString("message", true);
  const attachment = interaction.options.getAttachment("attachment");

  await interaction.deferReply({ ephemeral: true });

  let channel;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch (err) {
    console.error("[announce] Не удалось получить канал:", err);
    await interaction.editReply(`Не удалось найти канал \`${channelId}\` — бот не приглашён на этот сервер, канал удалён, или ID указан неверно.`);
    return;
  }

  if (!channel || channel.isDMBased() || !channel.isTextBased()) {
    await interaction.editReply(`Канал \`${channelId}\` не найден или не поддерживает отправку сообщений.`);
    return;
  }
  if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
    await interaction.editReply("В голосовые/сцен-каналы отправка сообщений не поддерживается этой командой.");
    return;
  }

  // Guild channels expose `.guild` and `.permissionsFor`; DM-based ones were
  // already excluded above. Typed loosely on purpose — this runs across a
  // very wide discord.js channel union and the runtime checks below are
  // what actually matter, not the exact static type.
  const guildChannel = channel as unknown as {
    guild?: { name: string; members: { me: { id: string } | null } };
    permissionsFor?: (member: unknown) => { has: (flag: bigint) => boolean } | null;
  };
  const guild = guildChannel.guild ?? null;
  const me = guild?.members.me;
  if (guild && me && guildChannel.permissionsFor) {
    const perms = guildChannel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.ViewChannel)) {
      await interaction.editReply(`У бота нет прав на отправку сообщений в канал \`${channelId}\` (сервер: ${guild.name}).`);
      return;
    }
  }

  try {
    await channel.send({
      content: message,
      files: attachment ? [attachment.url] : undefined,
    });
  } catch (err) {
    console.error("[announce] Не удалось отправить сообщение:", err);
    await interaction.editReply(`Не удалось отправить сообщение в канал \`${channelId}\` — см. логи бота.`);
    return;
  }

  await interaction.editReply(
    guild
      ? `✅ Сообщение опубликовано в ${channel} на сервере **${guild.name}**.`
      : `✅ Сообщение опубликовано в канал \`${channelId}\`.`
  );
}
