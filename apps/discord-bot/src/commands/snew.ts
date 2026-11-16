// /snew — короткая команда регистрации собрания (то же, что /meeting register).

import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { registerMeeting } from "./meeting.js";

export const data = new SlashCommandBuilder()
  .setName("snew")
  .setDescription("Зарегистрировать собрание: анонс уйдёт в канал «Активити МП»")
  .setDMPermission(false)
  .addRoleOption((o) => o.setName("faction").setDescription("Роль фракции (будет пингом)").setRequired(true))
  .addStringOption((o) => o.setName("date").setDescription("Дата ДД.ММ или ДД.ММ.ГГГГ").setRequired(true))
  .addStringOption((o) => o.setName("time").setDescription("Время по МСК, например 20:00").setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await registerMeeting(interaction);
}
