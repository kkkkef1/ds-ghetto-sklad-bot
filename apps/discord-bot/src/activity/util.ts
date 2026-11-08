import type { AutocompleteInteraction, Client } from "discord.js";

/** Все ID (17–20 цифр) из строки: подходят и «голые» ID, и упоминания <@&id> / <#id>. */
export function parseIds(input: string): string[] {
  return [...new Set(input.match(/\d{17,20}/g) ?? [])];
}

/** `server` приходит как id из подсказок; если ввели название руками — ищем по имени среди серверов бота. */
export function resolveGuildId(client: Client, input: string): string | undefined {
  const value = input.trim();
  const byId = client.guilds.cache.get(value);
  if (byId) return byId.id;
  const lower = value.toLowerCase();
  return [...client.guilds.cache.values()].find((g) => g.name.toLowerCase() === lower)?.id;
}

/** Подсказки для поля `server`: все серверы, где сейчас есть бот. */
export async function respondWithGuilds(interaction: AutocompleteInteraction, query: string): Promise<void> {
  const q = query.toLowerCase();
  const choices = [...interaction.client.guilds.cache.values()]
    .map((g) => ({ name: g.name.slice(0, 100), value: g.id }))
    .filter((c) => c.name.toLowerCase().includes(q) || c.value.includes(q))
    .slice(0, 25);
  await interaction.respond(choices);
}
