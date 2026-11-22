// /help — справка по командам. Показывает только то, что доступно именно вам:
//   все — общие команды; админы сервера — плюс повседневные команды собраний;
//   модераторы — плюс настройки, проверки склада, твинков и логов; создатель — плюс управление модераторами.
// Список написан вручную (описания короче и понятнее, чем в подсказках Discord); при добавлении новой команды
// её нужно внести сюда.

import { EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { isServerAdmin } from "../access.js";
import { isCreatorOrModerator } from "../captTracker/store.js";
import { CREATOR_ID } from "../captTracker/config.js";

type Level = "all" | "admin" | "mod" | "creator";

interface HelpEntry {
  level: Level;
  command: string;
  text: string;
}

export const HELP_ENTRIES: HelpEntry[] = [
  // --- все ---
  { level: "all", command: "/help", text: "эта справка (показывает только то, что доступно вам)" },
  { level: "all", command: "/remind on | off | status", text: "личные напоминания в ЛС за 15 минут до МП и собрания, если вы нажали «Буду»" },
  { level: "all", command: "/meeting list", text: "предстоящие собрания на сервере" },
  { level: "all", command: "/capt summary", text: "сводка каптов за сегодня" },
  { level: "all", command: "/sliv", text: "начать сессию анализа слива склада фракции" },
  { level: "all", command: "/stopsliv", text: "закрыть свою сессию слива" },

  // --- админы сервера (право «Управление сервером» или админ-роли из /mp setup), на своём сервере ---
  { level: "admin", command: "/snew  (или /meeting register)", text: "зарегистрировать собрание: фракция, дата, время МСК; анонс уйдёт в канал «Активити МП»" },
  { level: "admin", command: "/sedit", text: "поправить дату и/или время собрания, не удаляя его (анонс и отметки сохраняются)" },
  { level: "admin", command: "/meeting cancel", text: "отменить собрание (спросит подтверждение)" },

  // --- модераторы и создатель ---
  { level: "mod", command: "/mp settings | setup | add | edit | skip | move | remove", text: "МП: расписание, каналы, роли админов и старшего, пропуск и перенос на дату, удаление (спросит подтверждение)" },
  { level: "mod", command: "/capt settings | server | source | counter", text: "учёт каптов: источник, получатели, правка счётчика (сброс спросит подтверждение)" },
  { level: "mod", command: "/announce", text: "опубликовать сообщение от бота в канал на любом сервере" },
  { level: "mod", command: "/stopsliv user:", text: "закрыть чужую сессию слива" },
  { level: "mod", command: "/sklad …", text: "автопроверка склада (главный сервер): status, channel, enable | disable, force, run, date, schedule, returns, detail, cooldown, faction, rule, exclude" },
  { level: "mod", command: "/twink …", text: "автопроверка твинков (главный сервер): status, channel, enable | disable, schedule, force, stop, resume, delay, nick, options, link, map" },
  { level: "mod", command: "/lcheck …", text: "сводка по логам за сутки и за неделю (главный сервер): status, channel, time, enable | disable, weekly, run, week, words" },

  { level: "creator", command: "/capt moderator", text: "добавить или убрать модератора (только создатель)" },
];

const LEVEL_TITLES: Record<Level, string> = {
  all: "Для всех",
  admin: "Для админов сервера",
  mod: "Для модераторов",
  creator: "Только для создателя",
};

export const data = new SlashCommandBuilder().setName("help").setDescription("Справка: какие команды вам доступны").setDMPermission(true);

/** Уровни, доступные пользователю. */
export function levelsFor(opts: { creator: boolean; moderator: boolean; serverAdmin: boolean }): Level[] {
  const levels: Level[] = ["all"];
  if (opts.serverAdmin || opts.moderator) levels.push("admin");
  if (opts.moderator) levels.push("mod");
  if (opts.creator) levels.push("creator");
  return levels;
}

/** Блоки справки по уровням; каждый блок помещается в поле embed (до 1024 знаков), длинные делятся на несколько. */
export function helpFields(levels: Level[]): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  for (const level of levels) {
    const lines = HELP_ENTRIES.filter((e) => e.level === level).map((e) => `\`${e.command}\`: ${e.text}`);
    let chunk: string[] = [];
    let size = 0;
    let part = 0;
    const flush = () => {
      if (!chunk.length) return;
      fields.push({ name: part === 0 ? LEVEL_TITLES[level] : `${LEVEL_TITLES[level]} (продолжение)`, value: chunk.join("\n") });
      chunk = [];
      size = 0;
      part++;
    };
    for (const line of lines) {
      if (size + line.length + 1 > 1000) flush();
      chunk.push(line);
      size += line.length + 1;
    }
    flush();
  }
  return fields;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const creator = interaction.user.id === CREATOR_ID;
  const moderator = isCreatorOrModerator(interaction.user.id);
  const serverAdmin = moderator || (await isServerAdmin(interaction));
  const levels = levelsFor({ creator, moderator, serverAdmin });

  const hidden = levels.length < 4 ? "Команды для других ролей здесь не показаны." : "Вам доступны все команды.";
  const embed = new EmbedBuilder()
    .setTitle("Справка по командам")
    .setDescription(`Показаны команды, доступные вам. ${hidden}`)
    .addFields(helpFields(levels));
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
