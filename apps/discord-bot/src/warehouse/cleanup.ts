// ===================== ОЧИСТКА ДИСКА =====================
//
// Сырые логи бот на диск не пишет (они живут в памяти на время проверки), но со временем копятся:
//   • скриншоты сбоев (WH_DEBUG_DIR, «fail-….png», «twink-nowindow-….png») — удаляются через 7 дней,
//     и всегда остаются не больше 20 последних;
//   • кэш браузера в профиле (WH_PROFILE_DIR): Cache, Code Cache, GPUCache и т. п. Куки и сессия
//     не трогаются, чтобы не вводить код Google Authenticator заново. Чистится только когда на сайте
//     никто не работает.
// Запускается через 5 минут после старта бота и дальше раз в 6 часов.

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { siteLockInfo } from "./siteLock.js";

const DEBUG_MAX_AGE_MS = 7 * 24 * 3_600_000;
const DEBUG_KEEP_LAST = 20;
const CLEAN_EVERY_MS = 6 * 3_600_000;
const START_DELAY_MS = 5 * 60_000;

/** Папки кэша внутри профиля Chromium (относительно profileDir). Cookies и Local Storage здесь не перечислены намеренно. */
const CACHE_DIRS = [
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "Default/Service Worker/CacheStorage",
  "Default/Service Worker/ScriptCache",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
];

function dirs(): { debugDir: string; profileDir: string } {
  // Те же правила, что в config.ts, но без обязательных переменных логина: очистке пароль не нужен.
  const dataDir = process.env.WH_DATA_DIR?.trim() || path.resolve(process.cwd(), "data");
  return {
    debugDir: process.env.WH_DEBUG_DIR?.trim() || path.join(dataDir, "wh-debug"),
    profileDir: process.env.WH_PROFILE_DIR?.trim() || path.join(dataDir, "browser-profile"),
  };
}

async function cleanDebugFiles(debugDir: string, now: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(debugDir);
  } catch {
    return 0; // папки ещё нет — чистить нечего
  }
  const files: { file: string; mtime: number }[] = [];
  for (const name of names) {
    const file = path.join(debugDir, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) files.push({ file, mtime: info.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime); // новые первыми
  let removed = 0;
  for (const [index, f] of files.entries()) {
    if (index >= DEBUG_KEEP_LAST || now - f.mtime > DEBUG_MAX_AGE_MS) {
      await rm(f.file, { force: true }).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}

async function cleanBrowserCache(profileDir: string): Promise<number> {
  const lock = siteLockInfo();
  if (lock.holder || lock.waiting.length) return 0; // браузер сейчас может быть открыт — не трогаем
  let removed = 0;
  for (const rel of CACHE_DIRS) {
    const target = path.join(profileDir, rel);
    if (await stat(target).then(() => true, () => false)) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      removed++;
    }
  }
  return removed;
}

export async function cleanupDiskOnce(): Promise<void> {
  const { debugDir, profileDir } = dirs();
  try {
    const shots = await cleanDebugFiles(debugDir, Date.now());
    const caches = await cleanBrowserCache(profileDir);
    if (shots || caches) console.log(`[cleanup] Удалено старых скриншотов: ${shots}, папок кэша браузера: ${caches}.`);
  } catch (err) {
    console.error("[cleanup] Ошибка очистки диска (не критично):", err);
  }
}

/** Запускает периодическую очистку. Вызывать один раз. */
export function startDiskCleanup(): void {
  setTimeout(() => void cleanupDiskOnce(), START_DELAY_MS).unref();
  setInterval(() => void cleanupDiskOnce(), CLEAN_EVERY_MS).unref();
}
