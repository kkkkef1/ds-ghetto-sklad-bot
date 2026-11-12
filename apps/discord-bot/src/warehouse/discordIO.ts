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
import { normalizeCode, type OperatorIO } from "./io.js";

const MAX_TEXT = 1900;

export class ClientIO implements OperatorIO {
  constructor(
    private readonly client: Client,
    private readonly ownerId: string,
    private readonly ownsClient = false
  ) {}

  async notify(text: string, attachmentPath?: string): Promise<void> {
    try {
      const owner = await this.client.users.fetch(this.ownerId);
      await owner.send({
        content: text.slice(0, MAX_TEXT),
        files: attachmentPath ? [attachmentPath] : [],
      });
    } catch (err) {
      // Личка может быть закрыта — не роняем вход из-за этого, но оставляем след в логах.
      console.error("[warehouse] Не удалось отправить сообщение владельцу:", err);
    }
  }

  async askCode(prompt: string, timeoutMs: number): Promise<string | null> {
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
      } catch {
        return null; // время вышло
      }
      if (!reply) return null;
      const code = normalizeCode(reply.content);
      if (code) return code;
      await this.notify("Нужен код из 6 цифр. Пришлите только цифры.");
    }
    return null;
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.client.destroy();
  }
}

export class DiscordIO {
  /** Свой клиент: прототип можно запускать отдельно от основного бота. */
  static async create(token: string, ownerId: string): Promise<ClientIO> {
    const client = new Client({
      intents: [GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
    await client.login(token);
    await ready;
    return new ClientIO(client, ownerId, true);
  }
}
