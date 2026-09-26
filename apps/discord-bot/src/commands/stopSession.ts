import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { forceCloseSession, getActiveSessionChannel, getSession } from "../session.js";

export const data = new SlashCommandBuilder()
  .setName("stopsliv")
  .setDescription("Принудительно закрыть сессию слива склада")
  .setDMPermission(false)
  .addUserOption((o) =>
    o
      .setName("user")
      .setDescription("Чья сессия закрывается (только для администратора; по умолчанию — ваша)")
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const targetUser = interaction.options.getUser("user");
  const isSelf = !targetUser || targetUser.id === interaction.user.id;

  if (!isSelf) {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
    if (!isAdmin) {
      await interaction.reply({
        content: "Закрывать чужие сессии может только администратор сервера.",
        ephemeral: true,
      });
      return;
    }
  }

  const ownerId = targetUser?.id ?? interaction.user.id;
  const channelId = getActiveSessionChannel(ownerId);
  if (!channelId) {
    await interaction.reply({
      content: isSelf ? "У вас нет активной сессии." : `<@${ownerId}> — нет активной сессии.`,
      ephemeral: true,
    });
    return;
  }

  const session = getSession(channelId);
  if (session?.step === "processing") {
    // Analysis is CPU-bound and runs to completion — there's nothing left to
    // interrupt mid-flight. The slot frees itself as soon as it's done.
    await interaction.reply({
      content: `Сессия <#${channelId}> уже обрабатывает логи — дождитесь завершения анализа, прервать его нельзя.`,
      ephemeral: true,
    });
    return;
  }

  const stopped = forceCloseSession(channelId);
  if (!stopped) {
    await interaction.reply({
      content: `Сессия <#${channelId}> уже завершается сама — закрывать принудительно нечего.`,
      ephemeral: true,
    });
    return;
  }

  // Ack immediately — the interaction token is only valid for 3 seconds, and
  // channels.fetch() below is a real network call that can occasionally take
  // longer than that (this used to cause DiscordAPIError[10062] "Unknown
  // interaction" when the fetch delayed the reply past the window).
  await interaction.reply({
    content: `Сессия <#${channelId}> закрыта.`,
    ephemeral: true,
  });

  interaction.guild?.channels.fetch(channelId)
    .then(async (noticeChannel) => {
      if (noticeChannel?.isTextBased()) {
        await noticeChannel.send(
          isSelf
            ? `🛑 Сессия принудительно закрыта пользователем ${interaction.user}.`
            : `🛑 Сессия принудительно закрыта администратором ${interaction.user}.`
        );
      }
    })
    .catch(() => {});
}
