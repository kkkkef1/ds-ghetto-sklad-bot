// ===================== БЕЗОПАСНАЯ ЗАПИСЬ И БЭКАПЫ ФАЙЛОВ НАСТРОЕК =====================
//
// Все JSON-хранилища бота (склад, МП, капты, твинки, проверка логов) пишутся через этот модуль:
//
//   • запись атомарная: данные пишутся во временный файл, сбрасываются на диск (fsync) и только
//     потом переименовываются поверх настоящего. Если бот или сервер упадёт посреди записи,
//     останется целый старый файл, а не наполовину записанный;
//   • перед каждой записью прошлая исправная версия копируется в «<файл>.bak»;
//   • если при запуске основной файл не читается (повреждён), бот берёт «.bak», а если и он плох,
//     последнюю исправную суточную копию. Повреждённый файл не теряется: он сохраняется как
//     «<файл>.corrupt-<время>» для разбора;
//   • раз в 6 часов (и через минуту после старта) исправные файлы копируются в папку суточных
//     бэкапов (BACKUP_DIR, по умолчанию ./data/backups/ГГГГ-ММ-ДД); хранятся последние 14 суток.
//
// Если основного файла просто нет (например, вы удалили его, чтобы начать с чистого листа), бот начинает
// с настроек по умолчанию и ничего сам не восстанавливает.

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const BACKUP_KEEP_DAYS = 14;
const BACKUP_EVERY_MS = 6 * 3_600_000;
const FIRST_BACKUP_DELAY_MS = 60_000;
const CORRUPT_KEEP_MS = 30 * 24 * 3_600_000;

const registered = new Set<string>();

export function backupDir(): string {
  return process.env.BACKUP_DIR?.trim() || path.resolve(process.cwd(), "data", "backups");
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Подключает файл к суточным бэкапам. Вызывается хранилищем один раз при старте. */
export function registerStoreFile(file: string): void {
  registered.add(path.resolve(file));
}

/** Есть ли основной файл настроек. */
export function hasStoreFile(file: string): boolean {
  return existsSync(file);
}

/** Исправные копии файла от новых к старым: «.bak», затем суточные бэкапы. */
function copiesOf(file: string): string[] {
  const list = [`${file}.bak`];
  try {
    const dir = backupDir();
    const days = readdirSync(dir)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
    for (const day of days) list.push(path.join(dir, day, path.basename(file)));
  } catch {
    /* папки бэкапов ещё нет */
  }
  return list;
}

/**
 * Текст JSON-файла. Если основной файл повреждён, подставляет последнюю исправную копию
 * (повреждённый сохраняется рядом как «.corrupt-…»). Если исправной копии нет — бросает ошибку.
 */
export function readStoreFile(file: string): string {
  const main = readFileSync(file, "utf-8");
  if (isValidJson(main)) return main;

  console.error(`[storage] Файл ${file} повреждён и не читается как JSON, ищу исправную копию.`);
  try {
    copyFileSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* не критично */
  }
  for (const candidate of copiesOf(file)) {
    if (!existsSync(candidate)) continue;
    try {
      const text = readFileSync(candidate, "utf-8");
      if (isValidJson(text)) {
        console.error(`[storage] Восстановил ${file} из копии ${candidate}.`);
        return text;
      }
    } catch {
      /* пробуем следующую */
    }
  }
  throw new Error(`файл ${file} повреждён, исправной копии не нашлось`);
}

/** Атомарная запись: временный файл → fsync → переименование. Прошлая исправная версия остаётся в «.bak». */
export function writeStoreFile(file: string, json: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch (err) {
      console.error(`[storage] Не удалось сохранить предыдущую версию ${file}.bak:`, err);
    }
  }
  renameSync(tmp, file);
}

// ---- суточные бэкапы ----

function dayName(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Копирует все исправные файлы настроек в папку сегодняшних суток и удаляет бэкапы старше 14 суток. */
export function runBackup(now: number = Date.now()): { copied: number; dir: string } {
  const root = backupDir();
  const dir = path.join(root, dayName(now));
  let copied = 0;
  for (const file of registered) {
    if (!existsSync(file)) continue;
    try {
      if (!isValidJson(readFileSync(file, "utf-8"))) {
        console.error(`[storage] ${file} повреждён, в бэкап не копирую.`);
        continue;
      }
      mkdirSync(dir, { recursive: true });
      copyFileSync(file, path.join(dir, path.basename(file)));
      copied++;
    } catch (err) {
      console.error(`[storage] Не удалось сделать бэкап ${file}:`, err);
    }
  }

  // Старые сутки и давние «.corrupt-…».
  try {
    const days = readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const old of days.slice(0, Math.max(0, days.length - BACKUP_KEEP_DAYS))) {
      rmSync(path.join(root, old), { recursive: true, force: true });
    }
  } catch {
    /* папки бэкапов ещё нет */
  }
  for (const file of registered) {
    try {
      const folder = path.dirname(file);
      for (const name of readdirSync(folder)) {
        if (!name.startsWith(`${path.basename(file)}.corrupt-`)) continue;
        const full = path.join(folder, name);
        if (now - statSync(full).mtimeMs > CORRUPT_KEEP_MS) rmSync(full, { force: true });
      }
    } catch {
      /* не критично */
    }
  }
  return { copied, dir };
}

/** Запускает суточные бэкапы: через минуту после старта и дальше раз в 6 часов. */
export function startBackups(): void {
  const tick = () => {
    try {
      const { copied, dir } = runBackup();
      if (copied) console.log(`[storage] Бэкап настроек: ${copied} файл(ов) → ${dir}`);
    } catch (err) {
      console.error("[storage] Ошибка бэкапа (не критично):", err);
    }
  };
  setTimeout(tick, FIRST_BACKUP_DELAY_MS).unref();
  setInterval(tick, BACKUP_EVERY_MS).unref();
}
