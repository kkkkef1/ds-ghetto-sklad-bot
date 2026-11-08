// ===================== MIRRORING TO BOTH SERVERS =====================

import type { ButtonInteraction, Client, TextChannel } from "discord.js";
import { buildCancelRow, buildCaptContent } from "./render.js";
import { attachMirror, cancelCapt, getDayCounts, getDestination, getDestinations, getRecord, type CaptRecord } from "./store.js";

/** Sends the new-capt summary to both destination channels and remembers the resulting message ids. */
export async function publishCapt(
  client: Client,
  recordId: string,
  attacker: string,
  defender: string,
  dayKey: string,
  captNumber: string | null = null,
  square: string | null = null
): Promise<void> {
  const dayCounts = getDayCounts(dayKey);

  for (const destination of getDestinations()) {
    try {
      const channel = await client.channels.fetch(destination.channelId);
      if (!channel || !channel.isTextBased()) {
        console.error(`[captTracker] Канал ${destination.channelId} не найден или не текстовый.`);
        continue;
      }

      const content = buildCaptContent({ attacker, defender, dayCounts, pingRoleId: destination.pingRoleId, captNumber, square });
      const message = await (channel as TextChannel).send({
        content,
        components: [buildCancelRow(recordId)],
        allowedMentions: { roles: destination.pingRoleId ? [destination.pingRoleId] : [] },
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Discord API error codes that mean retrying is pointless. */
const UNKNOWN_INTERACTION = 10062; // the 3-second window is gone
const ALREADY_ACKNOWLEDGED = 40060; // an earlier attempt actually got through
const UNKNOWN_MESSAGE = 10008; // message was deleted
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

function errorCode(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "code" in err ? Number((err as { code: unknown }).code) : undefined;
}

/**
 * Acknowledges the button press as fast as possible. This has to be the very
 * first thing the handler does: Discord shows "приложение не ответило вовремя"
 * if the ack doesn't arrive within 3 seconds, and nothing else (permission
 * checks, store lookups, message edits) is allowed to delay it.
 *
 * If the connection to Discord is slow, a hung attempt is not awaited to
 * the end — after ~0.9s a new attempt is fired in parallel, so a stuck
 * request can't use up the whole window. Returns false if the ack could not
 * be delivered in time; the caller must then carry on anyway (the message is
 * edited through the channel API, which doesn't depend on the interaction token).
 */
async function ackQuickly(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.deferred || interaction.replied) return true;

  const deadline = Date.now() + 2700;
  while (Date.now() < deadline) {
    const attempt = interaction
      .deferUpdate()
      .then(() => "ok" as const)
      .catch((err: unknown) => {
        const code = errorCode(err);
        if (code === ALREADY_ACKNOWLEDGED) return "ok" as const;
        if (code === UNKNOWN_INTERACTION) return "expired" as const;
        return "error" as const;
      });
    const result = await Promise.race([attempt, sleep(900).then(() => "slow" as const)]);
    if (result === "ok") return true;
    if (result === "expired") return false;
    if (result === "error") await sleep(150);
  }
  return false;
}

/** Ephemeral note to the presser; never throws (the interaction may already be dead). */
async function notify(interaction: ButtonInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch {
    /* interaction expired — nothing more to do */
  }
}

// Retry schedule when Discord is slow/unreachable: tries for roughly two
// minutes in total before giving up, so a short outage doesn't leave a
// message showing a stale state.
const EDIT_RETRY_DELAYS_MS = [0, 500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 20000, 30000];

/** Records whose message refresh is currently running, so repeated clicks don't pile up parallel retry loops. */
const refreshing = new Set<string>();

async function editWithRetry(
  client: Client,
  channelId: string,
  messageId: string,
  payload: { content: string; components: ReturnType<typeof buildCancelRow>[] }
): Promise<boolean> {
  for (let i = 0; i < EDIT_RETRY_DELAYS_MS.length; i++) {
    if (EDIT_RETRY_DELAYS_MS[i] > 0) await sleep(EDIT_RETRY_DELAYS_MS[i]);
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return true; // nothing to edit, don't loop forever
      await (channel as TextChannel).messages.edit(messageId, payload);
      return true; // the message now shows the new state
    } catch (err) {
      const code = errorCode(err);
      if (code === UNKNOWN_MESSAGE || code === MISSING_ACCESS || code === MISSING_PERMISSIONS) {
        console.error(`[captTracker] Сообщение ${messageId} не обновить (код ${code}), повторы бессмысленны.`);
        return true;
      }
      console.error(`[captTracker] Попытка ${i + 1}/${EDIT_RETRY_DELAYS_MS.length} обновить сообщение ${messageId} не удалась:`, err);
    }
  }
  return false;
}

/**
 * Re-renders every mirror of a capt with the *current* day counters and
 * keeps retrying each one until Discord accepts the edit.
 */
export async function refreshCaptMessages(
  client: Client,
  record: CaptRecord,
  extraMessage?: { guildId: string | null; channelId: string; messageId: string }
): Promise<void> {
  const dayCounts = getDayCounts(record.dayKey);
  const targets: { guildId: string | null; channelId: string; messageId: string }[] = record.mirrors.map((m) => ({
    guildId: m.guildId,
    channelId: m.channelId,
    messageId: m.messageId,
  }));
  // The message that was actually clicked might not be in record.mirrors (e.g. a
  // mirror that failed to register) — make sure it is refreshed too.
  if (extraMessage && !targets.some((t) => t.messageId === extraMessage.messageId)) targets.push(extraMessage);

  await Promise.all(
    targets.map(async (target) => {
      // Роль берём из ТЕКУЩИХ настроек сервера — если её сменили или убрали, сообщение перерисуется уже с новой.
      const pingRoleId = (target.guildId ? getDestination(target.guildId)?.pingRoleId : null) ?? null;

      const content = buildCaptContent({
        attacker: record.attacker,
        defender: record.defender,
        dayCounts,
        pingRoleId,
        canceled: record.canceled,
        captNumber: record.captNumber,
        square: record.square ?? null,
      });
      const ok = await editWithRetry(client, target.channelId, target.messageId, {
        content,
        components: [buildCancelRow(record.id, record.canceled)],
      });
      if (!ok) console.error(`[captTracker] Не удалось обновить сообщение ${target.messageId} после всех попыток.`);
    })
  );
}

/**
 * "Отменить капт" button. Open to everyone on the server.
 *
 * Idempotent on purpose: pressing the button on an already-canceled capt
 * doesn't just say "already canceled" — it re-runs the message refresh. So if
 * Discord was lagging and the message still shows the old state, pressing
 * the button again fixes it instead of leaving it stuck.
 */
export async function handleCancelButton(interaction: ButtonInteraction, recordId: string): Promise<void> {
  // 1. Ack first, before anything else (see ackQuickly).
  await ackQuickly(interaction);

  const existing = getRecord(recordId);
  if (!existing) {
    await notify(interaction, "Запись об этом капте не найдена (возможно, она уже устарела и была удалена).");
    return;
  }

  // 2. Cancel in the store (synchronous + idempotent), then 3. refresh the messages with retries.
  const record = existing.canceled ? existing : cancelCapt(recordId);
  if (!record) {
    await notify(interaction, "Не удалось отменить капт.");
    return;
  }

  if (refreshing.has(recordId)) return; // a retry loop for this capt is already running
  refreshing.add(recordId);
  try {
    await refreshCaptMessages(interaction.client, record, {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    });
  } finally {
    refreshing.delete(recordId);
  }
}
