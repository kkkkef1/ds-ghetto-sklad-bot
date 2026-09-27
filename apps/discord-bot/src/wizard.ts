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

/**
 * Wires `stop()` to fire the moment `signal` aborts (immediately, if it's
 * already aborted). Returns a detach function to call once the step
 * settles normally, so the listener doesn't leak or fire after the fact.
 */
function stopOnAbort(signal: AbortSignal, stop: () => void): () => void {
  if (signal.aborted) {
    stop();
    return () => {};
  }
  const onAbort = () => stop();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

// Per-file cap, checked from the attachment's reported size *before*
// downloading it — this used to only be enforced afterwards, on the sum of
// everything collected across the whole step (session.placementLogs.reduce),
// which meant a user could finish uploading several huge files (each fully
// fetched and buffered in memory) before the size check ever fired. Rejecting
// per-file, up front, means an oversized file is never downloaded at all.
const MAX_ATTACHMENT_BYTES = 50_000_000;

async function readAttachmentOrContent(message: Message): Promise<string[]> {
  const parts: string[] = [];
  if (message.attachments.size) {
    for (const att of message.attachments.values()) {
      if (att.size > MAX_ATTACHMENT_BYTES) {
        await message.reply(
          `⚠️ Файл \`${att.name}\` слишком большой (≈${(att.size / 1_000_000).toFixed(1)} МБ, лимит ${MAX_ATTACHMENT_BYTES / 1_000_000} МБ) — пропущен. Разбейте его на части поменьше.`
        );
        continue;
      }
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
  signal: AbortSignal,
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
        detachAbort();
        msgCollector.stop("done");
        btnCollector.stop("done");
        resolve(skip ? [] : collected);
      };

      const detachAbort = stopOnAbort(signal, () => {
        if (settled) return;
        msgCollector.stop("force-closed");
        btnCollector.stop("force-closed");
      });

      btnCollector.on("collect", async interaction => {
        // Guards against a stray second click landing here after the first
        // one already resolved the step, and — more importantly — makes
        // sure a rejected deferUpdate()/edit() (e.g. DiscordAPIError 10062
        // "Unknown interaction" when the 3s ack window was missed) is
        // logged instead of crashing the whole bot process.
        if (settled) return;
        try {
          const skip = interaction.customId === "wizard_skip";
          await interaction.deferUpdate();
          if (!skip && pendingReads.length) {
            // Give immediate visible feedback: without this, the button
            // shows Discord's own few-second "thinking" spinner and then
            // goes quiet again while large files are still downloading —
            // indistinguishable from the click not registering, which is
            // what led people to mash the button several times. Editing the
            // message right away (before awaiting the reads) makes it clear
            // the click landed and a second click isn't needed.
            await promptMsg.edit({
              content: "⏳ Обрабатываю присланные файлы, подождите — повторно нажимать кнопку не нужно.",
              components: [],
            }).catch(() => {});
          }
          if (!skip) await Promise.all(pendingReads);
          await promptMsg.edit({
            content: skip ? "Пропущено." : `Принято: ${collected.length} сообщение(й)/файл(ов).`,
            components: [],
          });
          await finish(skip);
        } catch (err) {
          console.error("[wizard] Не удалось обработать нажатие кнопки на шаге сбора логов:", err);
        }
      });

      btnCollector.on("end", async (_c, reason) => {
        if (reason === "done") return;
        await Promise.all(pendingReads).catch(() => {});
        if (reason === "force-closed") {
          // /stopsliv already posts its own message explaining the closure —
          // just clear the buttons here, no need for a second explanation.
          await promptMsg.edit({ content: opts.prompt, components: [] }).catch(() => {});
        } else {
          await promptMsg.edit({ content: `${opts.prompt}\n\n⏱️ Время вышло, продолжаю с тем, что получено.`, components: [] }).catch(() => {});
        }
        await finish(false);
      });
    })();
  });
}

async function collectSingleMessage(
  channel: TextChannel,
  ownerId: string,
  signal: AbortSignal,
  prompt: string
): Promise<string | null> {
  await channel.send(prompt);
  return new Promise<string | null>((resolve) => {
    const collector = channel.createMessageCollector({
      filter: m => m.author.id === ownerId && m.content.trim().length > 0,
      max: 1,
      time: STEP_TIMEOUT_MS,
    });

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      detachAbort();
      collector.stop("done");
      resolve(value);
    };

    const detachAbort = stopOnAbort(signal, () => collector.stop("force-closed"));

    collector.on("collect", m => finish(m.content.trim()));
    collector.on("end", (collected, reason) => {
      if (reason === "done") return;
      finish(collected.first()?.content.trim() ?? null);
    });
  });
}

/**
 * First message of the session: faction picker + "Закончить сессию" button.
 * Resolves with the chosen faction id, or `null` if the session should be
 * closed (the owner pressed the button, or nothing was chosen within
 * FACTION_SELECT_TIMEOUT_MS).
 */
async function selectFaction(channel: TextChannel, ownerId: string, signal: AbortSignal): Promise<string | null> {
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

    const detachAbort = stopOnAbort(signal, () => collector.stop("force-closed"));

    collector.on("collect", async interaction => {
      try {
        if (interaction.isStringSelectMenu()) {
          result = interaction.values[0];
          await interaction.update({ content: `Фракция: **${getFaction(result).displayName}**`, components: [] });
          collector.stop("selected");
        } else if (interaction.isButton() && interaction.customId === "wizard_cancel") {
          result = null;
          await interaction.update({ content: "Сессия закрыта по вашему запросу.", components: [] });
          collector.stop("cancelled");
        }
      } catch (err) {
        console.error("[wizard] Не удалось обработать выбор фракции/отмену сессии:", err);
      }
    });

    collector.on("end", async (_collected, reason) => {
      detachAbort();
      if (reason === "time") {
        await msg
          .edit({ content: "⏱️ Фракция не выбрана в течение 10 минут — сессия закрыта.", components: [] })
          .catch(() => {});
      } else if (reason === "force-closed") {
        // /stopsliv posts its own explanation — just clear the components.
        await msg.edit({ content: prompt, components: [] }).catch(() => {});
      }
      resolve(result);
    });
  });
}

// ===================== MAIN WIZARD =====================

export async function runWizard(channel: TextChannel, session: Session, signal: AbortSignal): Promise<void> {
  const faction = await selectFaction(channel, session.ownerId, signal);
  if (!faction) {
    // Cancelled via the button, timed out, or /stopsliv force-closed it —
    // the channel stays as a record, the caller frees the active-session slot.
    session.step = "done";
    return;
  }
  session.faction = faction;
  session.step = "await_warehouse";
  if (signal.aborted) { session.step = "done"; return; }

  const warehouseParts = await collectMultiText(channel, session.ownerId, signal, {
    prompt: "**Шаг 1/4.** Отправьте лог склада фракции — текстом или файлом (можно несколько сообщений). Нажмите «Готово», когда закончите.",
  });
  session.warehouseLog = warehouseParts.join("\n");
  session.step = "await_placements";
  if (signal.aborted) { session.step = "done"; return; }

  const placementParts = await collectMultiText(channel, session.ownerId, signal, {
    prompt: "**Шаг 2/4.** Отправьте логи размещений (дом / квартира / машины / семья) — можно несколько сообщений и файлов подряд.",
  });
  session.placementLogs = placementParts;
  session.step = "await_roster";
  if (signal.aborted) { session.step = "done"; return; }

  const rosterParts = await collectMultiText(channel, session.ownerId, signal, {
    prompt: "**Шаг 3/4.** Отправьте состав фракции (для отметки «в списке / уволен»). Необязательно.",
    allowSkip: true,
  });
  session.rosterLog = rosterParts.length ? rosterParts.join("\n") : null;
  session.step = "await_admin_name";
  if (signal.aborted) { session.step = "done"; return; }

  const adminName = await collectSingleMessage(channel, session.ownerId, signal, "**Шаг 4/4.** Введите вашу фамилию/ник для команд наказания:");
  session.adminName = adminName || "Admin";
  session.step = "processing";
  if (signal.aborted) { session.step = "done"; return; }

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
