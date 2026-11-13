// ===================== КАНАЛ СВЯЗИ С ОПЕРАТОРОМ =====================
//
// Вход на сайт иногда требует человека: код Google Authenticator, подтверждение
// подсети главным админом, ручная проверка Cloudflare. Модуль входа (siteSession.ts)
// ничего не знает про Discord — он общается с оператором только через этот
// интерфейс. В боте это личные сообщения (discordIO.ts), при отладке — консоль.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface OperatorIO {
  /** Сообщение оператору; необязательно со скриншотом (путь к файлу). */
  notify(text: string, attachmentPath?: string): Promise<void>;
  /** Спросить одноразовый код (6 цифр). null — не дождались ответа. */
  askCode(prompt: string, timeoutMs: number): Promise<string | null>;
  /**
   * Отправить оператору вопрос и вернуть id отправленного сообщения (ответ придёт позже:
   * оператор отвечает именно на это сообщение). null — отправить не удалось или канал не умеет.
   */
  ask?(text: string): Promise<string | null>;
  /** Освободить ресурсы (отключить Discord-клиент и т.п.). */
  close?(): Promise<void>;
}

/** «123 456», « 123456 » → "123456"; всё остальное → null. */
export function normalizeCode(raw: string): string | null {
  const m = raw.replace(/\s+/g, "").match(/^\d{6}$/);
  return m ? m[0] : null;
}

/** Для запуска прототипа без Discord: всё пишется в консоль, код вводится с клавиатуры. */
export class ConsoleIO implements OperatorIO {
  async notify(text: string, attachmentPath?: string): Promise<void> {
    console.log(`[warehouse] ${text}${attachmentPath ? ` (скриншот: ${attachmentPath})` : ""}`);
  }

  async askCode(prompt: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      while (Date.now() < deadline) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), deadline - Date.now());
        try {
          const answer = await rl.question(`${prompt}\n> `, { signal: ac.signal });
          const code = normalizeCode(answer);
          if (code) return code;
          console.log("[warehouse] Нужны ровно 6 цифр.");
        } catch {
          return null; // таймаут
        } finally {
          clearTimeout(timer);
        }
      }
      return null;
    } finally {
      rl.close();
    }
  }
}
