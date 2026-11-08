// ===================== CAPT MESSAGE RENDERING =====================

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { DAILY_ATTACK_DEFENSE_LIMIT } from "./config.js";
import { CANCEL_BUTTON_PREFIX } from "./constants.js";
import type { FactionDayCounts } from "./store.js";

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
// Placeholder emoji for "attack"/"defense" — swap for whatever the server
// actually uses (a custom emoji works too, e.g. "<:atk:123456789012345678>").
const ATTACK_EMOJI = "⚔️";
const DEFENSE_EMOJI = "🛡️";

type DayCounts = Record<string, FactionDayCounts>;

function pushFactionLines(lines: string[], dayCounts: DayCounts) {
  for (const [faction, counts] of Object.entries(dayCounts)) {
    lines.push(`•  **${faction}**`);
    lines.push(`　${ATTACK_EMOJI} атаки: **${counts.attacks}**　　${DEFENSE_EMOJI} защиты: **${counts.defenses}**`);
    lines.push("");
  }
  // Drop the extra trailing blank line after the last faction.
  if (lines[lines.length - 1] === "") lines.pop();
}

function collectViolations(dayCounts: DayCounts): string[] {
  const violations: string[] = [];
  for (const [faction, counts] of Object.entries(dayCounts)) {
    if (counts.attacks > DAILY_ATTACK_DEFENSE_LIMIT) {
      violations.push(`•  ${faction} атакует ${counts.attacks} раз (макс. ${DAILY_ATTACK_DEFENSE_LIMIT})`);
    }
    if (counts.defenses > DAILY_ATTACK_DEFENSE_LIMIT) {
      violations.push(`•  ${faction} защищается ${counts.defenses} раз (макс. ${DAILY_ATTACK_DEFENSE_LIMIT})`);
    }
  }
  return violations;
}

export interface BuildCaptContentOptions {
  attacker: string;
  defender: string;
  dayCounts: DayCounts;
  /** Роль для пинга при превышении лимита на этом сервере; null — без пинга. */
  pingRoleId: string | null;
  captNumber?: string | null;
  square?: string | null;
  /** True once this capt has been rolled back via the button. */
  canceled?: boolean;
}

/**
 * The warning block is always derived from the *current* counts, so after a
 * cancel it disappears by itself as soon as nobody is over the limit any more
 * (and stays, with the corrected numbers, if someone still is).
 */
export function buildCaptContent(opts: BuildCaptContentOptions): string {
  const { attacker, defender, dayCounts, pingRoleId, canceled, captNumber, square } = opts;

  const lines: string[] = [];
  lines.push(DIVIDER);
  lines.push(
    canceled
      ? `❌ **Капт отменён:**  ${attacker}  ${ATTACK_EMOJI}  vs  ${DEFENSE_EMOJI}  ${defender}`
      : `${attacker}  ${ATTACK_EMOJI}  vs  ${DEFENSE_EMOJI}  ${defender}`
  );
  if (captNumber) lines.push(`**Номер забива:** ${captNumber}`);
  if (square) lines.push(`**Квадрат:** ${square}`);
  lines.push(DIVIDER);
  lines.push("");
  lines.push("**Сводка за день:**");
  lines.push("");
  pushFactionLines(lines, dayCounts);

  const violations = collectViolations(dayCounts);
  if (violations.length) {
    lines.push("");
    lines.push(DIVIDER);
    lines.push(`${pingRoleId ? `<@&${pingRoleId}>  ` : ""}⚠️ **ПРЕВЫШЕНИЕ ЛИМИТОВ!**`);
    lines.push(...violations);
  }
  lines.push(DIVIDER);

  return lines.join("\n");
}

/** Standalone "current capt count" message for the /capt summary command — same look, no ping. */
export function buildSummaryContent(dayKey: string, dayCounts: DayCounts): string {
  const lines: string[] = [];
  lines.push(DIVIDER);
  lines.push(`📊 **Сводка каптов за ${formatDayKey(dayKey)}**`);
  lines.push(DIVIDER);
  lines.push("");

  if (!Object.keys(dayCounts).length) {
    lines.push("Сегодня каптов ещё не было.");
  } else {
    pushFactionLines(lines, dayCounts);
    const violations = collectViolations(dayCounts);
    if (violations.length) {
      lines.push("");
      lines.push(DIVIDER);
      lines.push("⚠️ **ПРЕВЫШЕНИЕ ЛИМИТОВ!**");
      lines.push(...violations);
    }
  }
  lines.push(DIVIDER);

  return lines.join("\n");
}

/** "2026-10-14" -> "14.10.2026" */
function formatDayKey(dayKey: string): string {
  const m = dayKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : dayKey;
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
