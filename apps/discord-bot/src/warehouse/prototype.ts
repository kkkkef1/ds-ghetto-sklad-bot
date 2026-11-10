// ===================== ПРОТОТИП: ВХОД + ОДНА СТРАНИЦА ЛОГОВ =====================
//
// Запуск:  pnpm --filter @workspace/discord-bot run wh-proto
//
// Что делает: открывает браузер, проходит вход на gta5rp.com (код 2FA запросит
// в личку Discord владельцу либо в консоли), открывает логи фракции, выставляет
// фильтры, читает первую страницу и сохраняет её в data/wh-proto-output.json.
// Ничего никуда не отправляет, кроме сообщений владельцу.

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSiteConfig } from "./config.js";
import { ConsoleIO, type OperatorIO } from "./io.js";
import { CaptchaRequiredError, searchFactionLogs } from "./logsPage.js";
import { LoginError, SiteSession } from "./siteSession.js";

/** Сегодняшняя дата по Москве в формате дд/мм/гггг — так её хочет фильтр сайта. */
function todayMsk(): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

async function createIO(): Promise<OperatorIO> {
  const token = process.env.DISCORD_TOKEN?.trim();
  const ownerId = process.env.WH_OWNER_ID?.trim();
  if (token && ownerId) {
    const { DiscordIO } = await import("./discordIO.js");
    return DiscordIO.create(token, ownerId);
  }
  console.log("[warehouse] WH_OWNER_ID не задан — общаюсь с вами через консоль.");
  return new ConsoleIO();
}

async function main(): Promise<void> {
  const cfg = loadSiteConfig();
  const io = await createIO();
  const session = await SiteSession.open(cfg, io);

  try {
    const page = await session.ensureLogsPage();
    const result = await searchFactionLogs(page, {
      serverId: process.env.WH_SERVER_ID?.trim() || "17", // Redwood
      faction: process.env.WH_FACTION?.trim() || "F_GANG_BLOODS",
      dateFrom: process.env.WH_DATE_FROM?.trim() || todayMsk(),
    });

    const outFile = path.join(path.dirname(cfg.debugDir), "wh-proto-output.json");
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, JSON.stringify(result, null, 2), "utf8");

    const sample = result.rows
      .slice(0, 3)
      .map((r) => `• ${r.id} ${r.character}: ${r.text} (${r.time})`)
      .join("\n");
    await io.notify(
      `✅ Прототип: вход выполнен, логи читаются.\nНайдено на сайте: ${result.total}, прочитано строк: ${result.rows.length}.\n${sample}`
    );
    console.log(`[warehouse] Готово: ${result.rows.length} строк, файл ${outFile}`);
  } catch (err) {
    if (err instanceof LoginError) {
      // fail() уже отправил владельцу сообщение со скриншотом.
      console.error(`[warehouse] Вход не удался: ${err.message}`);
    } else if (err instanceof CaptchaRequiredError) {
      await io.notify(`❌ ${err.message} Автоматически я её не решаю — нужно подтвердить вручную.`);
      console.error(`[warehouse] ${err.message}`);
    } else {
      await io.notify(`❌ Прототип упал с ошибкой: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[warehouse] Ошибка:", err);
    }
    process.exitCode = 1;
  } finally {
    await session.close();
    await io.close?.();
  }
}

void main();
