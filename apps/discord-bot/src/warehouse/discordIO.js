// ===================== ОПЕРАТОР ЧЕРЕЗ ЛИЧНЫЕ СООБЩЕНИЯ DISCORD =====================
//
// Бот пишет владельцу в личку и ждёт ответ с кодом. Принимаются сообщения только
// от владельца (WH_OWNER_ID) и только в личке, поэтому посторонний код подсунуть
// не может.
//
// Замечание: в личных сообщениях бот не может удалять чужие сообщения, поэтому
// код остаётся в переписке. Он одноразовый и живёт ~30 секунд, так что риск
// небольшой.
//
// Два режима: ClientIO работает на уже запущенном клиенте основного бота,
// DiscordIO.create() поднимает свой временный клиент (для прототипа и ручных проверок).
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { normalizeCode } from "./io.js";
const MAX_TEXT = 1900;
export class ClientIO {
    client;
    ownerId;
    ownsClient;
    constructor(client, ownerId, ownsClient = false) {
        this.client = client;
        this.ownerId = ownerId;
        this.ownsClient = ownsClient;
    }
    async notify(text, attachmentPath) {
        try {
            const owner = await this.client.users.fetch(this.ownerId);
            await owner.send({
                content: text.slice(0, MAX_TEXT),
                files: attachmentPath ? [attachmentPath] : [],
            });
        }
        catch (err) {
            // Личка может быть закрыта — не роняем вход из-за этого, но оставляем след в логах.
            console.error("[warehouse] Не удалось отправить сообщение владельцу:", err);
        }
    }
    async ask(text) {
        try {
            const owner = await this.client.users.fetch(this.ownerId);
            const sent = await owner.send({ content: text.slice(0, MAX_TEXT), allowedMentions: { parse: [] } });
            return sent.id;
        }
        catch (err) {
            console.error("[warehouse] Не удалось отправить вопрос владельцу:", err);
            return null;
        }
    }
    async askCode(prompt, timeoutMs) {
        const owner = await this.client.users.fetch(this.ownerId);
        const dm = await owner.createDM();
        await this.notify(prompt);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            let reply;
            try {
                const got = await dm.awaitMessages({
                    filter: (m) => m.author.id === this.ownerId,
                    max: 1,
                    time: deadline - Date.now(),
                    errors: ["time"],
                });
                reply = got.first();
            }
            catch {
                return null; // время вышло
            }
            if (!reply)
                return null;
            const code = normalizeCode(reply.content);
            if (code)
                return code;
            await this.notify("Нужен код из 6 цифр. Пришлите только цифры.");
        }
        return null;
    }
    async close() {
        if (this.ownsClient)
            await this.client.destroy();
    }
}
export class DiscordIO {
    /** Свой клиент: прототип можно запускать отдельно от основного бота. */
    static async create(token, ownerId) {
        const client = new Client({
            intents: [GatewayIntentBits.DirectMessages],
            partials: [Partials.Channel],
        });
        const ready = new Promise((resolve) => client.once(Events.ClientReady, () => resolve()));
        await client.login(token);
        await ready;
        return new ClientIO(client, ownerId, true);
    }
}
