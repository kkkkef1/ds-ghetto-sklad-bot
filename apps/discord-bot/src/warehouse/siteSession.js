// ===================== ВХОД НА САЙТ ЧЕРЕЗ БРАУЗЕР =====================
//
// Настоящий браузер (Playwright/Chromium) проходит те же шаги, что и человек:
//   логин → код Google Authenticator → «Админ вход» → (подсеть / проверка безопасности) → логи.
//
// Порядок окон на сайте непредсказуем (подсеть и проверка IP появляются не всегда),
// поэтому вместо жёсткого сценария здесь «машина состояний»: на каждом шаге бот
// смотрит, какая страница открыта, делает одно действие и снова смотрит.
//
// Принципы:
//   • Cloudflare и капчи НЕ обходятся: если проверка не проходит сама, бот
//     присылает скриншот владельцу и останавливается.
//   • Каждое действие повторяется не более 2 раз — чтобы бот не долбил форму
//     паролем и не получил блокировку.
//   • Кнопка «Отключить Google Auth» никогда не нажимается: отправка форм идёт
//     только через button[type=submit] с проверкой текста.
//   • Куки хранятся в постоянном профиле браузера, поэтому обычно вход не нужен.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
const MAX_ATTEMPTS = {
    login_form: 2,
    twofa: 2,
    security: 2,
    subnet: 2,
    admin: 2,
    challenge: 3,
};
const SETTLE_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 30_000;
const CHALLENGE_WAIT_MS = 45_000;
export class LoginError extends Error {
    screenshotPath;
    constructor(message, screenshotPath) {
        super(message);
        this.screenshotPath = screenshotPath;
        this.name = "LoginError";
    }
}
export class SiteSession {
    cfg;
    io;
    context;
    page;
    constructor(cfg, io, context, page) {
        this.cfg = cfg;
        this.io = io;
        this.context = context;
        this.page = page;
    }
    static async open(cfg, io) {
        await mkdir(cfg.profileDir, { recursive: true });
        await mkdir(cfg.debugDir, { recursive: true });
        const context = await chromium.launchPersistentContext(cfg.profileDir, {
            headless: cfg.headless,
            viewport: { width: 1280, height: 900 },
            locale: "ru-RU",
            timezoneId: "Europe/Moscow",
            // --no-sandbox нужен, если бот запущен от root (типичный VPS);
            // --disable-dev-shm-usage — чтобы Chromium не падал на малом /dev/shm.
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        });
        if (cfg.blockAssets) {
            await context.route("**/*", (route) => {
                const type = route.request().resourceType();
                return type === "image" || type === "media" || type === "font" ? route.abort() : route.continue();
            });
        }
        context.setDefaultTimeout(ACTION_TIMEOUT_MS);
        const page = context.pages()[0] ?? (await context.newPage());
        return new SiteSession(cfg, io, context, page);
    }
    async close() {
        await this.context.close().catch(() => { });
    }
    // ---------- публичный вход ----------
    /** Доходит до страницы логов фракций, проходя все нужные окна. Возвращает её же. */
    async ensureLogsPage() {
        const logsUrl = `${this.cfg.baseUrl}/logs?act=faction`;
        await this.goto(logsUrl);
        const attempts = {};
        for (let step = 0; step < 20; step++) {
            const state = await this.settle();
            if (state === "logs")
                return this.page;
            const key = state === "site" || state === "admin_dialog" ? "admin" : state;
            attempts[key] = (attempts[key] ?? 0) + 1;
            if (attempts[key] > (MAX_ATTEMPTS[key] ?? 1)) {
                throw await this.fail(`Застрял на шаге «${key}» (повторные попытки не помогли).`);
            }
            switch (state) {
                case "login_form":
                    await this.doLogin();
                    break;
                case "twofa":
                    await this.doTwoFa();
                    break;
                case "security":
                    await this.doSecurityCheck();
                    break;
                case "subnet":
                    await this.doSubnet();
                    break;
                case "challenge":
                    await this.waitChallenge();
                    break;
                case "site":
                case "admin_dialog":
                    await this.doAdminLogin();
                    await this.goto(logsUrl);
                    break;
                default:
                    throw await this.fail("Открылась незнакомая страница, не понимаю, что делать дальше.");
            }
        }
        throw await this.fail("Слишком много шагов входа подряд.");
    }
    // ---------- определение страницы ----------
    async detect() {
        const page = this.page;
        try {
            const url = page.url();
            if (url.includes("act=subnet_blocked"))
                return "subnet";
            if (url.includes("act=security_check"))
                return "security";
            if (await page.locator("#faction_logs_server_id").count())
                return "logs";
            if (await page.locator('input[name="2fa_code"]').count())
                return "twofa";
            if ((await page.locator('input[name="login"]').count()) && (await page.locator('input[name="password"]').count())) {
                return "login_form";
            }
            if (await this.isChallenge())
                return "challenge";
            if (await page.getByText("Админ авторизация").first().isVisible())
                return "admin_dialog";
            if (await page.locator('button[aria-haspopup="menu"]').count())
                return "site";
        }
        catch {
            // Страница в момент перехода — контекст исчез. Это нормально, спросим ещё раз.
        }
        return "unknown";
    }
    async isChallenge() {
        const page = this.page;
        if (await page.locator('iframe[src*="challenges.cloudflare.com"]').count())
            return true;
        const title = await page.title();
        if (/just a moment|один момент|подтвердите действие/i.test(title))
            return true;
        // innerText не включает скрытые элементы, поэтому спрятанное окно reCAPTCHA сюда не попадает.
        const text = await page.locator("body").innerText();
        return /Подтвердите действие|Идет проверка|Идёт проверка|Проверка на робота/i.test(text);
    }
    /** Ждёт, пока страница «устоится» и станет понятно, что это за шаг. */
    async settle() {
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        let state = "unknown";
        while (Date.now() < deadline) {
            await this.page.waitForLoadState("domcontentloaded").catch(() => { });
            state = await this.detect();
            if (state !== "unknown")
                return state;
            await this.page.waitForTimeout(500);
        }
        return state;
    }
    /** Ждёт, пока страница перестанет быть шагом `state`. true — перестала. */
    async waitUntilLeft(state, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await this.page.waitForTimeout(700);
            if ((await this.detect()) !== state)
                return true;
        }
        return false;
    }
    // ---------- шаги ----------
    async doLogin() {
        const page = this.page;
        const passwordField = page.locator('input[name="password"]');
        await page.locator('input[name="login"]').fill(this.cfg.login);
        await passwordField.fill(this.cfg.password);
        // «Запомнить меня» продлевает сессию — входить придётся реже.
        try {
            const remember = page.locator('input[type="checkbox"]').first();
            if ((await remember.count()) && !(await remember.isChecked()))
                await remember.click({ force: true });
        }
        catch {
            /* не критично */
        }
        await this.clickSubmit(passwordField);
        if (await this.waitUntilLeft("login_form", ACTION_TIMEOUT_MS))
            return;
        // Форма не ушла: чаще всего ждёт проверку Cloudflare.
        if (await this.isChallenge().catch(() => false)) {
            if (await this.waitUntilLeft("login_form", CHALLENGE_WAIT_MS))
                return;
            throw await this.fail("Cloudflare не пропускает автоматически. Нужна ручная проверка.");
        }
        throw await this.fail("Форма входа не приняла логин/пароль (или сайт не ответил).");
    }
    async doTwoFa() {
        const page = this.page;
        for (let i = 0; i < 3; i++) {
            const code = await this.io.askCode("Нужен код из Google Authenticator для входа на gta5rp.com. Пришлите 6 цифр в ответ (жду 5 минут).", this.cfg.codeTimeoutMs);
            if (!code)
                throw await this.fail("Не дождался кода 2FA.");
            const codeField = page.locator('input[name="2fa_code"]');
            await codeField.fill(code);
            await this.clickSubmit(codeField);
            if (await this.waitUntilLeft("twofa", 20_000))
                return;
            await this.io.notify("Код не подошёл. Пришлите свежий код.");
        }
        throw await this.fail("Код 2FA не принят три раза подряд.");
    }
    async doSecurityCheck() {
        const page = this.page;
        await page.locator("#security_check_password").fill(this.cfg.password);
        await page.locator("button", { hasText: /Готово/ }).first().click();
        if (await this.waitUntilLeft("security", 20_000))
            return;
        const err = await page.locator("#security_check_alert_block, #security_check_password_alert").first().innerText().catch(() => "");
        throw await this.fail(`«Проверка безопасности» не пройдена.${err.trim() ? ` Сайт пишет: ${err.trim()}` : ""}`);
    }
    async doSubnet() {
        const page = this.page;
        const info = (await page.locator(".card-body").first().innerText().catch(() => "")).replace(/\s+/g, " ");
        const ip = info.match(/IP:\s*([0-9a-f.:]+)/i)?.[1] ?? "?";
        const subnet = info.match(/Подсеть на занесение:\s*(\S+)/i)?.[1] ?? "?";
        await page.locator("button", { hasText: /Запросить/ }).first().click();
        await this.io.notify(`Подсеть ${subnet} (IP ${ip}) не в белом списке админки. Запрос отправлен — попросите главного админа подтвердить. ` +
            `Жду до ${Math.round(this.cfg.subnetWaitMs / 60_000)} мин.`);
        // Сама страница опрашивает сервер и уходит, когда подсеть одобрена.
        if (await this.waitUntilLeft("subnet", this.cfg.subnetWaitMs))
            return;
        throw await this.fail("Подсеть не подтвердили вовремя.");
    }
    async doAdminLogin() {
        const page = this.page;
        if (!(await page.getByText("Админ авторизация").first().isVisible().catch(() => false))) {
            await this.openAdminDialog();
        }
        const dialog = page.locator('[role="dialog"]').filter({ hasText: "Админ авторизация" });
        const scope = (await dialog.count()) ? dialog.first() : page;
        const field = scope.locator('input[type="password"]').first();
        await field.waitFor({ state: "visible" });
        await field.fill(this.cfg.adminPassword);
        const button = scope.locator("button", { hasText: /^\s*вход\s*$/i }).first();
        if (await button.count())
            await button.click();
        else
            await field.press("Enter");
        // Диалог должен закрыться или страница уйти в админку.
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
            await page.waitForTimeout(700);
            const stillOpen = await page.getByText("Админ авторизация").first().isVisible().catch(() => false);
            if (!stillOpen)
                return;
        }
        throw await this.fail("Админ-пароль не принят (окно «Админ авторизация» не закрылось).");
    }
    async openAdminDialog() {
        const page = this.page;
        const trigger = page.locator('button[aria-haspopup="menu"]').first();
        const item = page.locator('[role="menuitem"]', { hasText: "Админ вход" }).first();
        await trigger.click();
        if (!(await item.isVisible().catch(() => false))) {
            await trigger.hover(); // на части страниц меню открывается по наведению
            await item.waitFor({ state: "visible", timeout: 5_000 });
        }
        await item.click();
        await page.getByText("Админ авторизация").first().waitFor({ state: "visible", timeout: 10_000 });
    }
    async waitChallenge() {
        if (await this.waitUntilLeft("challenge", CHALLENGE_WAIT_MS))
            return;
        throw await this.fail("Проверка Cloudflare/капча не прошла сама. Нужна ручная проверка.");
    }
    // ---------- утилиты ----------
    /**
     * Отправка формы: только button[type=submit], и никогда «Отключить Google Auth».
     * Если кнопка так и осталась неактивной (сайт не подхватил ввод), отправляем
     * форму клавишей Enter в заполненном поле — как это сделал бы человек.
     */
    async clickSubmit(field) {
        const submit = this.page.locator('form button[type="submit"]').first();
        const label = (await submit.innerText()).trim();
        if (/отключить/i.test(label)) {
            throw new LoginError(`Отказ: кнопка отправки называется «${label}», такую не нажимаю.`);
        }
        try {
            await submit.click({ timeout: 8_000 });
        }
        catch {
            await field.press("Enter");
        }
    }
    async goto(url) {
        try {
            await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        }
        catch (err) {
            // Редирект может оборвать первичную навигацию — это не ошибка, состояние определим дальше.
            if (!/ERR_ABORTED|interrupted by another navigation/i.test(String(err)))
                throw err;
        }
    }
    /** Скриншот на память, сообщение владельцу, ошибка для вызывающего. */
    async fail(message) {
        let shot;
        try {
            shot = path.join(this.cfg.debugDir, `fail-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
            await this.page.screenshot({ path: shot });
        }
        catch {
            shot = undefined;
        }
        await this.io.notify(`Вход на сайт не удался: ${message}\nСтраница: ${this.page.url()}`, shot);
        return new LoginError(message, shot);
    }
}
