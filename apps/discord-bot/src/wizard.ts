import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  StringSelectMenuBuilder,
  type Message,
  type TextChannel,
} from "discord.js";
import { FACTIONS, getFaction, runAnalysis } from "@workspace/log-analyzer";
import type { AnalysisProgress, AnalysisStage } from "@workspace/log-analyzer";
import type { Session } from "./session.js";
import { runExclusive } from "./analysisQueue.js";

const STEP_TIMEOUT_MS = 15 * 60_000; // 15 min per step — a stalled session doesn't hang forever
const FACTION_SELECT_TIMEOUT_MS = 10 * 60_000; // 10 min to pick a faction, otherwise the session is closed
const TIME_WINDOW_MINUTES = 3;

// Hard cap on the size of the placement logs fed into one analysis run.
// This isn't about correctness — it's a resource guardrail: a single
// pathologically large paste (the kind that pinned the server's CPU and
// dropped the bot's connection) is rejected up front instead of being
// throttled through for minutes on end. Only placement logs count towards
// it — that's normally where the volume is (multiple houses/vehicles/
// family logs stacked together), while the faction warehouse log is a
// single, naturally bounded log. 50 MB is generous for normal placement
// logs; if it's ever hit for real, splitting the period into smaller
// chunks is the right fix, not raising the cap.
const MAX_PLACEMENT_LOG_CHARS = 50_000_000;

const STAGE_LABELS: Record<AnalysisStage, string> = {
  faction_log: "лог склада",
  placement_logs: "логи размещений",
  matching_ammo: "сопоставление патронов",
  matching_medkits: "сопоставление аптечек",
  players: "разбор нарушителей",
  report: "сборка отчёта",
};

// ===================== SMALL HELPERS =====================

async function readAttachmentOrContent(message: Message): Promise<string[]> {
  const parts: string[] = [];
  if (message.attachments.size) {
    for (const att of message.attachments.values()) {
      try {
        const res = await fetch(att.url);
        parts.push(await res.text());
      } catch {
        await message.reply(`Не удалось прочитать файл \`${att.name}\` — пришлите его ещё раз.`);
      }
    }
  }
  if (message.content.trim()) parts.push(message.content);
  return parts;
}

/**
 * Collects one or more text/file messages from `ownerId` in `channel` until
 * they press "Готово" (or "Пропустить", if enabled). Returns the collected
 * blocks in the order they arrived. On timeout, returns whatever was
 * collected so far (best effort) rather than losing the session.
 */
function collectMultiText(
  channel: TextChannel,
  ownerId: string,
  opts: { prompt: string; doneLabel?: string; allowSkip?: boolean; skipLabel?: string }
): Promise<string[]> {
  const collected: string[] = [];
  const pendingReads: Promise<void>[] = [];

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("wizard_done").setLabel(opts.doneLabel ?? "Готово").setStyle(ButtonStyle.Success),
    ...(opts.allowSkip
      ? [new ButtonBuilder().setCustomId("wizard_skip").setLabel(opts.skipLabel ?? "Пропустить").setStyle(ButtonStyle.Secondary)]
      : [])
  );

  return new Promise<string[]>((resolve) => {
    void (async () => {
      const promptMsg = await channel.send({ content: opts.prompt, components: [row] });

      const msgCollector = channel.createMessageCollector({
        filter: m => m.author.id === ownerId,
        time: STEP_TIMEOUT_MS,
      });
      msgCollector.on("collect", m => {
        const read = (async () => {
          const parts = await readAttachmentOrContent(m);
          if (parts.length) {
            collected.push(...parts);
            await m.react("✅").catch(() => {});
          }
        })();
        pendingReads.push(read);
      });

      const btnCollector = promptMsg.createMessageComponentCollector({
        filter: i => i.user.id === ownerId,
        componentType: ComponentType.Button,
        time: STEP_TIMEOUT_MS,
      });

      let settled = false;
      const finish = async (skip: boolean) => {
        if (settled) return;
        settled = true;
        msgCollector.stop("done");
        btnCollector.stop("done");
        resolve(skip ? [] : collected);
      };

      btnCollector.on("collect", async interaction => {
        const skip = interaction.customId === "wizard_skip";
        await interaction.deferUpdate();
        if (!skip) await Promise.all(pendingReads);
        await promptMsg.edit({
          content: skip ? "Пропущено." : `Принято: ${collected.length} сообщение(й)/файл(ов).`,
          components: [],
        });
        await finish(skip);
      });

      btnCollector.on("end", async (_c, reason) => {
        if (reason !== "done") {
          await Promise.all(pendingReads).catch(() => {});
          await promptMsg.edit({ content: `${opts.prompt}\n\n⏱️ Время вышло, продолжаю с тем, что получено.`, components: [] }).catch(() => {});
          await finish(false);
        }
      });
    })();
  });
}

async function collectSingleMessage(channel: TextChannel, ownerId: string, prompt: string): Promise<string | null> {
  await channel.send(prompt);
  const collected = await channel.awaitMessages({
    filter: m => m.author.id === ownerId && m.content.trim().length > 0,
    max: 1,
    time: STEP_TIMEOUT_MS,
  });
  return collected.first()?.content.trim() ?? null;
}

/**
 * First message of the session: faction picker + "Закончить сессию" button.
 * Resolves with the chosen faction id, or `null` if the session should be
 * closed (the owner pressed the button, or nothing was chosen within
 * FACTION_SELECT_TIMEOUT_MS).
 */
async function selectFaction(channel: TextChannel, ownerId: string): Promise<string | null> {
  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("wizard_faction")
      .setPlaceholder("Выберите фракцию")
      .addOptions(FACTIONS.map(f => ({ label: f.displayName, value: f.id })))
  );
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("wizard_cancel").setLabel("Закончить сессию").setStyle(ButtonStyle.Danger)
  );
  const prompt = "Выберите фракцию для анализа. Если фракция не будет выбрана в течение 10 минут, сессия закроется автоматически.";
  const msg = await channel.send({ content: prompt, components: [selectRow, buttonRow] });

  return new Promise<string | null>((resolve) => {
    const collector = msg.createMessageComponentCollector({
      filter: i => i.user.id === ownerId,
      time: FACTION_SELECT_TIMEOUT_MS,
    });

    let result: string | null = null;

    collector.on("collect", async interaction => {
      if (interaction.isStringSelectMenu()) {
        result = interaction.values[0];
        await interaction.update({ content: `Фракция: **${getFaction(result).displayName}**`, components: [] });
        collector.stop("selected");
      } else if (interaction.isButton() && interaction.customId === "wizard_cancel") {
        result = null;
        await interaction.update({ content: "Сессия закрыта по вашему запросу.", components: [] });
        collector.stop("cancelled");
      }
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "time") {
        await msg
          .edit({ content: "⏱️ Фракция не выбрана в течение 10 минут — сессия закрыта.", components: [] })
          .catch(() => {});
      }
      resolve(result);
    });
  });
}

// ===================== MAIN WIZARD =====================

export async function runWizard(channel: TextChannel, session: Session): Promise<void> {
  const faction = await selectFaction(channel, session.ownerId);
  if (!faction) {
    // Cancelled via the button or timed out — the channel stays as a record,
    // the caller frees the user's active-session slot.
    session.step = "done";
    return;
  }
  session.faction = faction;
  session.step = "await_warehouse";

  const warehouseParts = await collectMultiText(channel, session.ownerId, {
    prompt: "**Шаг 1/4.** Отправьте лог склада фракции — текстом или файлом (можно несколько сообщений). Нажмите «Готово», когда закончите.",
  });
  session.warehouseLog = warehouseParts.join("\n");
  session.step = "await_placements";

  const placementParts = await collectMultiText(channel, session.ownerId, {
    prompt: "**Шаг 2/4.** Отправьте логи размещений (дом / квартира / машины / семья) — можно несколько сообщений и файлов подряд.",
  });
  session.placementLogs = placementParts;
  session.step = "await_roster";

  const rosterParts = await collectMultiText(channel, session.ownerId, {
    prompt: "**Шаг 3/4.** Отправьте состав фракции (для отметки «в списке / уволен»). Необязательно.",
    allowSkip: true,
  });
  session.rosterLog = rosterParts.length ? rosterParts.join("\n") : null;
  session.step = "await_admin_name";

  const adminName = await collectSingleMessage(channel, session.ownerId, "**Шаг 4/4.** Введите вашу фамилию/ник для команд наказания:");
  session.adminName = adminName || "Admin";
  session.step = "processing";

  if (!session.warehouseLog) {
    await channel.send("⚠️ Лог склада пуст — анализ невозможен. Сессия завершена без результата.");
    session.step = "done";
    return;
  }
  if (!session.placementLogs.length) {
    await channel.send("⚠️ Не получено ни одного лога размещений — анализ невозможен. Сессия завершена без результата.");
    session.step = "done";
    return;
  }

  const placementChars = session.placementLogs.reduce((a, s) => a + s.length, 0);
  if (placementChars > MAX_PLACEMENT_LOG_CHARS) {
    await channel.send(
      `⚠️ Логи размещений слишком большие для одного анализа (≈${(placementChars / 1_000_000).toFixed(1)} МБ, лимит ${MAX_PLACEMENT_LOG_CHARS / 1_000_000} МБ) — обработка такого объёма перегружает сервер. ` +
      "Разбейте период на несколько частей поменьше и запустите `/sliv` заново для каждой. Сессия завершена без результата."
    );
    session.step = "done";
    return;
  }

  const processingMsg = await channel.send("🔎 Анализирую логи... (0 сек)");

  let progress: AnalysisProgress = { stage: "faction_log", done: 0, total: 1 };
  const startedAt = Date.now();
  const renderStatus = (prefix: string) => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const pct = progress.total > 1 ? ` ${Math.round((progress.done / progress.total) * 100)}%` : "";
    return `${prefix} (${STAGE_LABELS[progress.stage]}${pct}, ${elapsed} сек)`;
  };
  // Analysis is throttled and can take a while on large logs — this proves
  // to the admin the bot is still alive and working, not stuck or dead.
  const progressTimer = setInterval(() => {
    processingMsg.edit(renderStatus("🔎 Анализирую логи...")).catch(() => {});
  }, 4000);

  let result: Awaited<ReturnType<typeof runAnalysis>>;
  try {
    result = await runExclusive(async hadToWait => {
      if (hadToWait) {
        await processingMsg.edit("⏳ Сейчас выполняется другой анализ — этот начнётся сразу после него...").catch(() => {});
      }
      return runAnalysis(
        {
          factionLogContent: session.warehouseLog!,
          placementLogContents: session.placementLogs,
          factionListContent: session.rosterLog ?? undefined,
          selectedFaction: session.faction!,
          adminName: session.adminName!,
          timeWindowMinutes: TIME_WINDOW_MINUTES,
        },
        info => { progress = info; }
      );
    });
  } catch (err) {
    clearInterval(progressTimer);
    await processingMsg.edit("❌ Ошибка при анализе логов. Сессия завершена без результата.").catch(() => {});
    console.error("[wizard] analysis failed:", err);
    session.step = "done";
    return;
  }
  clearInterval(progressTimer);

  const buffer = Buffer.from(result.txtReport, "utf-8");
  const fileName = `report_${session.faction}_${Date.now()}.txt`;

  await processingMsg.edit(
    result.players.length
      ? `✅ Готово. Нарушителей: **${result.players.length}**, предметов: **${result.totalItems}**` +
        (result.totalAmmo ? `, патронов: **${result.totalAmmo}**` : "") +
        (result.totalMedkits ? `, аптечек: **${result.totalMedkits}**` : "") + "."
      : "✅ Готово. Сливов не обнаружено."
  );
  await channel.send({ files: [{ attachment: buffer, name: fileName }] });

  session.step = "done";
}
