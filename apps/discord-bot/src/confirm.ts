// ===================== ПОДТВЕРЖДЕНИЕ ОПАСНЫХ ДЕЙСТВИЙ КНОПКАМИ =====================
//
// Вместо флагов вида confirm:true: команда показывает сообщение (видно только вызвавшему) с кнопками
// «Подтвердить» и «Отмена» и ждёт нажатия 60 секунд. Нажать может только тот, кто вызвал команду.
//
// Использование в команде:
//   if (!(await confirmAction(interaction, "Удалить МП «BLACKOUT»?"))) return;
//   ...выполняем действие...
//   await respond(interaction, "Готово.");
//
// После подтверждения сообщение уже существует, поэтому итог нужно выводить через respond()
// (он сам выбирает reply или editReply).

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from "discord.js";

export interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  /** Красная кнопка (по умолчанию) или зелёная. */
  danger?: boolean;
  timeoutMs?: number;
}

/** true — подтверждено; false — нажали «Отмена» или время вышло (сообщение уже обновлено, ничего писать не нужно). */
export async function confirmAction(interaction: ChatInputCommandInteraction, text: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const id = `confirm:${interaction.id}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${id}:yes`)
      .setLabel(opts.confirmLabel ?? "Подтвердить")
      .setStyle(opts.danger === false ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${id}:no`).setLabel(opts.cancelLabel ?? "Отмена").setStyle(ButtonStyle.Secondary)
  );
  const content = text.slice(0, 1900);

  if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [row] });
  else await interaction.reply({ content, components: [row], ephemeral: true, allowedMentions: { parse: [] } });
  const message = await interaction.fetchReply();

  try {
    const click = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(id),
      time: opts.timeoutMs ?? 60_000,
    });
    if (click.customId === `${id}:yes`) {
      await click.update({ content: "Выполняю…", components: [] });
      return true;
    }
    await click.update({ content: "Отменено, ничего не изменено.", components: [] });
    return false;
  } catch {
    await interaction.editReply({ content: "Время на подтверждение вышло, ничего не изменено.", components: [] }).catch(() => undefined);
    return false;
  }
}

/** Ответ на команду: если ответ уже есть (после подтверждения или deferReply), правит его, иначе отвечает. */
export async function respond(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const text = content.slice(0, 1990);
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content: text, components: [], allowedMentions: { parse: [] } });
  else await interaction.reply({ content: text, ephemeral: true, allowedMentions: { parse: [] } });
}
