// ===================== ДОСТУП К КОМАНДАМ =====================
//
// Три уровня:
//   • создатель — всё, включая управление списком модераторов;
//   • модераторы — все серьёзные настройки (каналы, роли, счётчики, /announce)
//     и работа с любыми серверами бота;
//   • админы сервера (Manage Server либо роли админов из /mp setup) — повседневные
//     команды МП и собраний, но только на своём сервере.
// Остальное (/capt summary, /meeting list, /sliv) открыто всем.

import { PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import { getMember, isAdminMember } from "./activity/service.js";
import { getGuildSettings } from "./activity/store.js";
import { isCreatorOrModerator } from "./captTracker/store.js";

export { isCreatorOrModerator };

/** Админ сервера, на котором вызвана команда. */
export async function isServerAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guildId) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const member = await getMember(interaction);
  return member !== null && isAdminMember(getGuildSettings(interaction.guildId), member);
}

/** Может ли пользователь пользоваться повседневными командами на текущем сервере. */
export async function canManageServer(interaction: ChatInputCommandInteraction): Promise<boolean> {
  return isCreatorOrModerator(interaction.user.id) || (await isServerAdmin(interaction));
}
