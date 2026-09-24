// ===================== CAPT MESSAGE RENDERING =====================

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { DAILY_ATTACK_DEFENSE_LIMIT, type CaptDestination } from "./config.js";
import { CANCEL_BUTTON_PREFIX } from "./constants.js";
import type { FactionDayCounts } from "./store.js";

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
// Placeholder emoji for "attack"/"defense" — swap for whatever the server
// actually uses (a custom emoji works too, e.g. "<:atk:123456789012345678>").
const ATTACK_EMOJI = "⚔️";
const DEFENSE_EMOJI = "🛡️";

export interface BuildCaptContentOptions {
  attacker: string;
  defender: string;
  dayCounts: Record<string, FactionDayCounts>;
  destination: CaptDestination;
  /** True once this capt has been rolled back via the button. */
  canceled?: boolean;
}

export function buildCaptContent(opts: BuildCaptContentOptions): string {
  const { attacker, defender, dayCounts, destination, canceled } = opts;

  const lines: string[] = [];
  lines.push(DIVIDER);
  lines.push(canceled ? `Капт отменён: ${attacker} ${defender}` : `Новый капт: ${attacker} ${defender}`);
  lines.push(DIVIDER);
  lines.push("Сводка за день:");
  for (const [faction, counts] of Object.entries(dayCounts)) {
    lines.push(`• ${faction}: ${ATTACK_EMOJI} ${counts.attacks} / ${DEFENSE_EMOJI} ${counts.defenses}`);
  }
  lines.push(DIVIDER);

  if (!canceled) {
    const violations: string[] = [];
    for (const [faction, counts] of Object.entries(dayCounts)) {
      if (counts.attacks > DAILY_ATTACK_DEFENSE_LIMIT) {
        violations.push(`• ${faction} атакует ${counts.attacks} раз (макс. ${DAILY_ATTACK_DEFENSE_LIMIT})`);
      }
      if (counts.defenses > DAILY_ATTACK_DEFENSE_LIMIT) {
        violations.push(`• ${faction} защищается ${counts.defenses} раз (макс. ${DAILY_ATTACK_DEFENSE_LIMIT})`);
      }
    }
    if (violations.length) {
      lines.push(`<@&${destination.pingRoleId}> ПРЕВЫШЕНИЕ ЛИМИТОВ!`);
      lines.push(...violations);
    } else {
      // Drop the trailing divider when there's nothing after it.
      lines.pop();
    }
  } else {
    lines.pop();
  }

  return lines.join("\n");
}

export function buildCancelRow(recordId: string, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CANCEL_BUTTON_PREFIX}${recordId}`)
      .setLabel(disabled ? "Капт отменён" : "Отменить капт")
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}
