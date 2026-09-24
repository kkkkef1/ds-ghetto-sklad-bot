// ===================== SOURCE CHANNEL LISTENER =====================
//
// Only Events.MessageCreate is handled here — the later edit that adds
// "Результат:"/"Статистика:" once a capture finishes is deliberately
// ignored (per the spec: "нас интересует только забив" — we only care
// about the seizure itself, not its outcome), so counts are based purely
// on the capture being attempted, not on who won.

import { Events, type Client, type Message } from "discord.js";
import { SOURCE } from "./config.js";
import { dayKeyFromDateTime, extractFullText, parseCaptMessage } from "./parser.js";
import { publishCapt } from "./mirror.js";
import { recordCapt } from "./store.js";

export function registerCaptListener(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.guildId !== SOURCE.guildId || message.channelId !== SOURCE.channelId) return;

    const text = extractFullText(message);
    const parsed = parseCaptMessage(text);
    // Anything in this channel that doesn't have Атака/Защита fields isn't
    // a capt report (or is the follow-up "Результат" state — same fields
    // are still present there, so this also catches genuinely unrelated
    // messages, not the result edit, which arrives as an edit, not a new
    // message).
    if (!parsed) return;

    const dayKey = dayKeyFromDateTime(parsed.dateTime, message.createdAt);

    try {
      const record = recordCapt(message.id, dayKey, parsed.attacker, parsed.defender);
      await publishCapt(client, record.id, parsed.attacker, parsed.defender, dayKey);
    } catch (err) {
      console.error("[captTracker] Не удалось обработать новый забив:", err);
    }
  });
}
