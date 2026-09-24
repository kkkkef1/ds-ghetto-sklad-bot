// ===================== MIRRORING TO BOTH SERVERS =====================

import type { ButtonInteraction, Client, TextChannel } from "discord.js";
import { CREATOR_ID, DESTINATIONS } from "./config.js";
import { buildCancelRow, buildCaptContent } from "./render.js";
import { attachMirror, cancelCapt, getDayCounts, getHelpers, getRecord } from "./store.js";

/** Sends the new-capt summary to both destination channels and remembers the resulting message ids. */
export async function publishCapt(
  client: Client,
  recordId: string,
  attacker: string,
  defender: string,
  dayKey: string
): Promise<void> {
  const dayCounts = getDayCounts(dayKey);

  for (const destination of DESTINATIONS) {
    try {
      const channel = await client.channels.fetch(destination.channelId);
      if (!channel || !channel.isTextBased()) {
        console.error(`[captTracker] Канал ${destination.channelId} не найден или не текстовый.`);
        continue;
      }

      const content = buildCaptContent({ attacker, defender, dayCounts, destination });
      const message = await (channel as TextChannel).send({
        content,
        components: [buildCancelRow(recordId)],
        allowedMentions: { roles: [destination.pingRoleId] },
      });

      attachMirror(recordId, {
        guildId: destination.guildId,
        channelId: destination.channelId,
        messageId: message.id,
      });
    } catch (err) {
      console.error(`[captTracker] Не удалось отправить сообщение в канал ${destination.channelId}:`, err);
    }
  }
}

/** Creator, any added helper, or a holder of the destination's ping role on the guild the button was pressed in. */
export function userCanCancel(interaction: ButtonInteraction): boolean {
  if (interaction.user.id === CREATOR_ID) return true;
  if (getHelpers().includes(interaction.user.id)) return true;

  const destination = DESTINATIONS.find((d) => d.guildId === interaction.guildId);
  if (destination && interaction.inCachedGuild()) {
    return interaction.member.roles.cache.has(destination.pingRoleId);
  }
  return false;
}

export async function handleCancelButton(interaction: ButtonInteraction, recordId: string): Promise<void> {
  if (!userCanCancel(interaction)) {
    await interaction.reply({ content: "У вас нет прав для отмены капта.", ephemeral: true });
    return;
  }

  const existing = getRecord(recordId);
  if (!existing) {
    await interaction.reply({ content: "Запись об этом капте не найдена (возможно, она уже устарела и была удалена).", ephemeral: true });
    return;
  }
  if (existing.canceled) {
    await interaction.reply({ content: "Этот капт уже был отменён.", ephemeral: true });
    return;
  }

  const record = cancelCapt(recordId);
  if (!record) {
    await interaction.reply({ content: "Не удалось отменить капт.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const dayCounts = getDayCounts(record.dayKey);
  for (const mirror of record.mirrors) {
    const destination = DESTINATIONS.find((d) => d.channelId === mirror.channelId);
    if (!destination) continue;

    try {
      const channel = await interaction.client.channels.fetch(mirror.channelId);
      if (!channel || !channel.isTextBased()) continue;
      const message = await (channel as TextChannel).messages.fetch(mirror.messageId);

      const content = buildCaptContent({
        attacker: record.attacker,
        defender: record.defender,
        dayCounts,
        destination,
        canceled: true,
      });
      await message.edit({ content, components: [buildCancelRow(recordId, true)] });
    } catch (err) {
      console.error(`[captTracker] Не удалось обновить сообщение ${mirror.messageId} после отмены:`, err);
    }
  }
}
