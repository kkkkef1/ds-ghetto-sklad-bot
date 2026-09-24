// ===================== CAPT TRACKER CONFIG =====================
//
// All ids below are fixed per the spec. If any of these ever need to change
// (roles renamed, bot moved to a different channel, etc.) this is the only
// file that should need editing — nothing else in captTracker/ hardcodes an
// id directly.

/** The one Discord user who can manage the bot (add/remove helpers, reset counters). */
export const CREATOR_ID = "437954847015436288";

/**
 * The channel where seizure ("забив") reports land. These are relayed from
 * the official Discord (which this bot cannot join directly) into a channel
 * on our own server that the bot *can* read.
 */
export const SOURCE = {
  guildId: "1546926301699514411",
  channelId: "1552702236117696593",
} as const;

export interface CaptDestination {
  /** Short label used only in logs, not shown to users. */
  key: "server1" | "server2";
  guildId: string;
  channelId: string;
  /** Role pinged when a faction goes over the daily limit, and allowed to press "Отменить капт". */
  pingRoleId: string;
}

/** The two servers/channels every capt summary is mirrored to. */
export const DESTINATIONS: CaptDestination[] = [
  {
    key: "server1",
    guildId: "1546926301699514411",
    channelId: "1552702266602033292",
    pingRoleId: "1552715526671704096",
  },
  {
    key: "server2",
    guildId: "1509657083010613299",
    channelId: "1536028810582040666",
    pingRoleId: "1548752262938103899",
  },
];

/** Rule 1.2: a faction may run at most 3 attacks and 3 defenses per day. */
export const DAILY_ATTACK_DEFENSE_LIMIT = 3;
