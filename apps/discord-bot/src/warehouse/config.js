// ===================== НАСТРОЙКИ ДОСТУПА К САЙТУ =====================
//
// Всё из переменных окружения (.env). Пароли в коде и в логах не появляются.
import path from "node:path";
function required(env, name) {
    const v = env[name]?.trim();
    if (!v)
        throw new Error(`Не задана переменная окружения ${name} (см. .env.example).`);
    return v;
}
function flag(value, fallback) {
    if (value === undefined || value.trim() === "")
        return fallback;
    return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
function minutes(value, fallbackMin) {
    const n = Number(value);
    return (Number.isFinite(n) && n > 0 ? n : fallbackMin) * 60_000;
}
export function loadSiteConfig(env = process.env) {
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
