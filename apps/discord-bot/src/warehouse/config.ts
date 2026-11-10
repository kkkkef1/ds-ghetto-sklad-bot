// ===================== НАСТРОЙКИ ДОСТУПА К САЙТУ =====================
//
// Всё из переменных окружения (.env). Пароли в коде и в логах не появляются.

import path from "node:path";

export interface SiteConfig {
  /** Адрес сайта, по умолчанию https://gta5rp.com (переопределяется только для тестов). */
  baseUrl: string;
  /** Логин и пароль аккаунта. Пароль также нужен для окна «Проверка безопасности». */
  login: string;
  password: string;
  /** Отдельный пароль админки («Админ вход»). */
  adminPassword: string;
  /** Папка профиля браузера: тут хранятся куки, чтобы не входить заново при каждом запуске. */
  profileDir: string;
  /** Сюда складываются скриншоты при сбоях входа. */
  debugDir: string;
  headless: boolean;
  /** Не загружать картинки/шрифты/видео — экономит память на слабом VPS. */
  blockAssets: boolean;
  /** Сколько ждать код 2FA от владельца. */
  codeTimeoutMs: number;
  /** Сколько ждать, пока главный админ подтвердит подсеть. */
  subnetWaitMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Не задана переменная окружения ${name} (см. .env.example).`);
  return v;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function minutes(value: string | undefined, fallbackMin: number): number {
  const n = Number(value);
  return (Number.isFinite(n) && n > 0 ? n : fallbackMin) * 60_000;
}

export function loadSiteConfig(env: NodeJS.ProcessEnv = process.env): SiteConfig {
  const dataDir = env.WH_DATA_DIR?.trim() || path.resolve(process.cwd(), "data");
  return {
    baseUrl: (env.GTA_BASE_URL?.trim() || "https://gta5rp.com").replace(/\/+$/, ""),
    login: required(env, "GTA_LOGIN"),
    password: required(env, "GTA_PASSWORD"),
    adminPassword: required(env, "GTA_ADMIN_PASSWORD"),
    profileDir: env.WH_PROFILE_DIR?.trim() || path.join(dataDir, "browser-profile"),
    debugDir: env.WH_DEBUG_DIR?.trim() || path.join(dataDir, "wh-debug"),
    headless: flag(env.WH_HEADLESS, true),
    blockAssets: flag(env.WH_BLOCK_ASSETS, true),
    codeTimeoutMs: minutes(env.WH_CODE_TIMEOUT_MIN, 5),
    subnetWaitMs: minutes(env.WH_SUBNET_WAIT_MIN, 15),
  };
}
