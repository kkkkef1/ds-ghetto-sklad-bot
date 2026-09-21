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
import type { Session } from "./session.js";

const STEP_TIMEOUT_MS = 15 * 60_000; // 15 min per step — a stalled session doesn't hang forever
const TIME_WINDOW_MINUTES = 3;

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
      msgCollector.on("collect", async m => {
        const parts = await readAttachmentOrContent(m);
        if (parts.length) {
          collected.push(...parts);
          await m.react("✅").catch(() => {});
        }
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
        await interaction.update({
          content: skip ? "Пропущено." : `Принято: ${collected.length} сообщение(й)/файл(ов).`,
          components: [],
        });
        await finish(skip);
      });

      btnCollector.on("end", async (_c, reason) => {
        if (reason !== "done") {
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

async function selectFaction(channel: TextChannel, ownerId: string): Promise<string> {
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("wizard_faction")
      .setPlaceholder("Выберите фракцию")
      .addOptions(FACTIONS.map(f => ({ label: f.displayName, value: f.id })))
  );
  const msg = await channel.send({ content: "Выберите фракцию для анализа:", components: [row] });

  return new Promise<string>((resolve) => {
    const collector = msg.createMessageComponentCollector({
      filter: i => i.user.id === ownerId,
      componentType: ComponentType.StringSelect,
      time: STEP_TIMEOUT_MS,
      max: 1,
    });
    collector.on("collect", async interaction => {
      const value = interaction.values[0];
      await interaction.update({ content: `Фракция: **${getFaction(value).displayName}**`, components: [] });
      resolve(value);
    });
  });
}

// ===================== MAIN WIZARD =====================

export async function runWizard(channel: TextChannel, session: Session): Promise<void> {
  session.faction = await selectFaction(channel, session.ownerId);
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

  const processingMsg = await channel.send("🔎 Анализирую логи...");

  const result = runAnalysis({
    factionLogContent: session.warehouseLog,
    placementLogContents: session.placementLogs,
    factionListContent: session.rosterLog ?? undefined,
    selectedFaction: session.faction,
    adminName: session.adminName,
    timeWindowMinutes: TIME_WINDOW_MINUTES,
  });

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
