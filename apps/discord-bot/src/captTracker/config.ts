// ===================== CAPT TRACKER CONFIG =====================
//
// Здесь остаётся только то, что зафиксировано жёстко: создатель, главный
// (настроечный) сервер и лимит. Всё остальное — куда слать сообщения о каптах,
// какая роль пингуется, какой канал слушаем — меняется командами /capt ...
// и хранится в capt-store.json (см. store.ts).

/** The one Discord user who can manage the bot (settings, moderators, counters). */
export const CREATOR_ID = "437954847015436288";

/**
 * Главный сервер по настройке: команды управления (/capt set-channel,
 * server, source, counter, moderator ...) работают только
 * здесь. Бот при этом слушает забивы именно на этом сервере.
 */
export const MAIN_GUILD_ID = "1370865432776413315";

/** Канал-источник забивов по умолчанию (меняется через /capt set-source). */
export const DEFAULT_SOURCE_CHANNEL_ID = "1521965930526281889";

export interface CaptDestination {
  guildId: string;
  channelId: string;
  /** Роль, которую пингуем при превышении лимита; null — без пинга. */
  pingRoleId: string | null;
}

/**
 * Начальные настройки — используются ОДИН раз: при первом запуске новой
 * версии, когда в capt-store.json ещё нет раздела destinations. Дальше
 * источник правды — файл данных, а не этот список.
 */
export const INITIAL_DESTINATIONS: CaptDestination[] = [
  { guildId: "1546926301699514411", channelId: "1552702266602033292", pingRoleId: "1552715526671704096" },
  { guildId: "1509657083010613299", channelId: "1536028810582040666", pingRoleId: "1548752262938103899" },
];

/** Rule 1.2: a faction may run at most 3 attacks and 3 defenses per day. */
export const DAILY_ATTACK_DEFENSE_LIMIT = 3;
