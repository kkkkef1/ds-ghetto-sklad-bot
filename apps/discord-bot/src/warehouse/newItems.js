// ===================== НОВЫЕ ПРЕДМЕТЫ: ВОПРОС ПРО ЛИМИТ =====================
//
// Если в логах появился предмет без собственного правила (он попадает в универсальное «Прочее»),
// бот пишет владельцу в личку и просит указать лимит. На каждый предмет — отдельное сообщение,
// и владелец отвечает именно на него (Ответить / Reply): так лимиты разных предметов не путаются,
// даже если новых предметов появилось сразу несколько.
import { Events } from "discord.js";
import { addItemRule, addPendingItem, findRule, getPendingItems, getRules, isItemPending, removePendingItem } from "./store.js";
/** За один прогон спрашиваем не больше стольких предметов; остальные — при следующей проверке. */
const MAX_QUESTIONS_PER_RUN = 15;
const LIMIT_RE = /^\s*(\d{1,6})\s*$/;
function otherLimit() {
    const other = getRules().find((r) => r.kind === "item" && r.match.includes("*"));
    return other && other.limit > 0 ? other.limit : null;
}
export async function askAboutNewItems(io, items) {
    if (!io.ask)
        return 0;
    const fresh = items.filter((it) => !isItemPending(it.name)).slice(0, MAX_QUESTIONS_PER_RUN);
    const fallback = otherLimit();
    let asked = 0;
    for (const item of fresh) {
        const places = [...item.places].join(", ");
        const text = [
            `**Новый предмет в логах склада: ${item.name}**`,
            `Замечено за проверку: ${item.quantity} шт. (${places}).`,
            fallback ? `Пока считается как «Прочее» с лимитом ${fallback} за период.` : "Пока считается как «Прочее».",
            "",
            "**Ответьте на это сообщение** (Ответить / Reply) числом — лимит за период (склад + наборы). `0` — не проверять этот предмет.",
        ].join("\n");
        const messageId = await io.ask(text);
        if (!messageId)
            continue;
        addPendingItem(messageId, item.name);
        asked++;
    }
    return asked;
}
/** Обработка ответа владельца в личке. Возвращает true, если сообщение было ответом на вопрос про предмет. */
export async function handleLimitReply(message, ownerId) {
    if (message.author.id !== ownerId || message.guildId)
        return false;
    const refId = message.reference?.messageId;
    const pending = refId ? getPendingItems()[refId] : undefined;
    if (!pending) {
        // Число без «Ответить», пока ждут ответы на вопросы про предметы: подсказываем, как правильно (код 2FA — 6 цифр — не трогаем).
        const text = message.content.trim();
        if (!refId && LIMIT_RE.test(text) && !/^\d{6}$/.test(text) && Object.keys(getPendingItems()).length > 0) {
            await message.reply("Чтобы лимит попал к нужному предмету, ответьте числом именно на сообщение с этим предметом (Ответить / Reply).").catch(() => { });
            return true;
        }
        return false;
    }
    const m = message.content.match(LIMIT_RE);
    if (!m) {
        await message.reply(`Нужно целое число — лимит для «${pending.name}» за период (0 — не проверять). Ответьте ещё раз на это же сообщение.`).catch(() => { });
        return true;
    }
    const limit = Number(m[1]);
    const existing = getRules().find((r) => r.kind === "item" && !r.match.includes("*") && r.match.some((p) => pending.name.toLowerCase().includes(p.toLowerCase())));
    if (existing) {
        removePendingItem(refId);
        await message.reply(`Для «${pending.name}» уже есть правило «${existing.label}» (\`${existing.id}\`, лимит ${existing.limit}). Менять: /sklad rule set.`).catch(() => { });
        return true;
    }
    const rule = addItemRule(pending.name, limit);
    removePendingItem(refId);
    const saved = findRule(rule.id);
    await message
        .reply(`Принято: «${rule.label}» — ${limit === 0 ? "не проверяется" : `лимит ${limit} за период`}. ` +
        `Правило \`${saved?.id ?? rule.id}\`, изменить можно в /sklad rule set.`)
        .catch(() => { });
    return true;
}
export function listenForLimitReplies(client, getOwnerId) {
    client.on(Events.MessageCreate, (message) => {
        const owner = getOwnerId();
        if (!owner)
            return;
        void handleLimitReply(message, owner).catch((err) => console.error("[warehouse] Ответ про лимит предмета:", err));
    });
}
