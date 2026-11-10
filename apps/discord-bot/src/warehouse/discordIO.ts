// ===================== ОПЕРАТОР ЧЕРЕЗ ЛИЧНЫЕ СООБЩЕНИЯ DISCORD =====================
//
// Бот пишет владельцу в личку и ждёт ответ с кодом. Принимаются сообщения только
// от владельца (WH_OWNER_ID) и только в личке, поэтому посторонний код подсунуть
// не может.
//
// Замечание: в личных сообщениях бот не может удалять чужие сообщения, поэтому
// код остаётся в переписке. Он одноразовый и живёт ~30 секунд, так что риск
// небольшой; позже код можно принимать через эфемерную слэш-команду, после
// которой в чате ничего не остаётся.

import { Client, Events, GatewayIntentBits, Partials, type User } from "discord.js";
import { normalizeCode, type OperatorIO } from "./io.js";

const MAX_TEXT = 1900;

export class DiscordIO implements OperatorIO {
  private constructor(
    private readonly client: Client,
    private readonly owner: User
  ) {}

  /** Свой клиент: прототип можно запускать отдельно от основного бота. */
  static async create(token: string, ownerId: string): Promise<DiscordIO> {
    const client = new Client({
      intents: [GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
    await client.login(token);
    await ready;
    const owner = await client.users.fetch(ownerId);
    return new DiscordIO(client, owner);
  }

  async notify(text: string, attachmentPath?: string): Promise<void> {
    try {
      await this.owner.send({
        content: text.slice(0, MAX_TEXT),
        files: attachmentPath ? [attachmentPath] : [],
      });
    } catch (err) {
      // Личка может быть закрыта — не роняем вход из-за этого, но оставляем след в логах.
      console.error("[warehouse] Не удалось отправить сообщение владельцу:", err);
    }
  }

  async askCode(prompt: string, timeoutMs: number): Promise<string | null> {
    const dm = await this.owner.createDM();
    await this.notify(prompt);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let reply;
      try {
        const got = await dm.awaitMessages({
          filter: (m) => m.author.id === this.owner.id,
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
    await this.client.destroy();
  }
}
