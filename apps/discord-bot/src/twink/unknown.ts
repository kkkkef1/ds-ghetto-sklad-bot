// ===================== НЕИЗВЕСТНЫЕ ФРАКЦИИ =====================
//
// Если у твинка встретилась фракция, которой нет в списках (новая или переименованная),
// группа не проверяется, а владельцу в личку уходит вопрос — по одному сообщению на фракцию.
// Ответить нужно именно на него (Ответить / Reply): «crime КОД», «state КОД» или «special КОД»
// (например, `crime TRD`). Код — короткое имя в выводе. Меняется потом командой /twink map.

import { Events, type Client, type Message } from "discord.js";
import type { OperatorIO } from "../warehouse/io.js";
import { CATEGORY_LABEL, type Category } from "./rules.js";
import { addCustomFaction, addPendingFaction, getSettings, isFactionPending, removePendingFaction } from "./store.js";

const MAX_QUESTIONS_PER_RUN = 10;
const REPLY_RE = /^\s*(crime|state|special|крайм|гос|особая|особ)\s+([^\s|]{1,12})\s*$/i;

const CATEGORY_ALIASES: Record<string, Category> = {
  crime: "crime",
  крайм: "crime",
  state: "state",
  гос: "state",
  special: "special",
  особая: "special",
  особ: "special",
};

export async function askAboutUnknownFactions(io: OperatorIO, names: Iterable<string>): Promise<number> {
  if (!io.ask) return 0;
  let asked = 0;
  for (const name of names) {
    if (asked >= MAX_QUESTIONS_PER_RUN) break;
    if (isFactionPending(name) || getSettings().customFactions[name]) continue;
    const text = [
      `**Неизвестная фракция у твинка: «${name}»**`,
      "Игроки с такой фракцией пока не проверяются (их группа пропускается).",
      "",
      "**Ответьте на это сообщение** (Ответить / Reply): категория и короткий код для вывода.",
      "Категории: `crime` — криминальная, `state` — государственная, `special` — особая.",
      "Пример: `crime TRD`",
    ].join("\n");
    const id = await io.ask(text);
    if (!id) continue;
    addPendingFaction(id, name);
    asked++;
  }
  return asked;
}

/** true — сообщение было ответом на вопрос про фракцию. */
export async function handleFactionReply(message: Message, ownerId: string): Promise<boolean> {
  if (message.author.id !== ownerId || message.guildId) return false;
  const refId = message.reference?.messageId;
  const name = refId ? getSettings().pendingFactions[refId] : undefined;
  if (!refId || !name) return false;

  const m = message.content.match(REPLY_RE);
  if (!m) {
    await message.reply("Нужно: категория и код, например `crime TRD` (категории: crime, state, special). Ответьте ещё раз на это же сообщение.").catch(() => {});
    return true;
  }
  const category = CATEGORY_ALIASES[m[1].toLowerCase()];
  const code = m[2].toUpperCase();
  addCustomFaction(name, category, code);
  removePendingFaction(refId);
  await message.reply(`Принято: «${name}» — ${CATEGORY_LABEL[category]}, код ${code}. Со следующей проверки учитывается. Изменить: /twink map.`).catch(() => {});
  return true;
}

export function listenForFactionReplies(client: Client, getOwnerId: () => string | null): void {
  client.on(Events.MessageCreate, (message) => {
    const owner = getOwnerId();
    if (!owner) return;
    void handleFactionReply(message, owner).catch((err) => console.error("[twink] Ответ про фракцию:", err));
  });
}
